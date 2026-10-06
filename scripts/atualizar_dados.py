#!/usr/bin/env python3
"""Baixa as bases listadas em camadas.json e grava os GeoJSON em data/.

Uso:
    python3 scripts/atualizar_dados.py            # atualiza todas as camadas
    python3 scripts/atualizar_dados.py metro      # só a camada "metro"

Só usa a biblioteca padrão do Python. Cada camada com
"atualizacao": {"tipo": "wfs", ...} é baixada de um servidor WFS
(ex.: GeoSampa) já em latitude/longitude (EPSG:4326).

Opções de "atualizacao" em camadas.json:
    campos          coluna da fonte -> informação do mapa ("nome" é obrigatório)
    prefixo_nome    texto colocado antes do nome (ex.: "Feira ")
    filtro_nome     só mantém pontos cujo nome começa por um destes textos
    agrupar_por     junta pontos com o mesmo valor (ex.: estação em duas linhas)
    lista           campos que viram lista ao agrupar
    tipo_por_prefixo  deduz o tipo pelo começo do nome
"""
import json
import sys
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = RAIZ / "camadas.json"


POR_PAGINA = 5000


def baixar_wfs(cfg):
    """Baixa todas as feições da camada, em páginas (bases grandes como os
    pontos de ônibus passam do limite de uma única resposta do servidor)."""
    feicoes, vistos, inicio = [], set(), 0
    while True:
        params = {
            "service": "WFS",
            "version": "2.0.0",
            "request": "GetFeature",
            "typeNames": cfg["typeName"],
            "outputFormat": "application/json",
            "srsName": "EPSG:4326",
            "count": POR_PAGINA,
            "startIndex": inicio,
        }
        url = cfg["url"] + "?" + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={"User-Agent": "lmapa/1.0"})
        with urllib.request.urlopen(req, timeout=180) as resp:
            pagina = json.load(resp)["features"]
        for f in pagina:
            chave = f.get("id") or json.dumps(f.get("geometry"))
            if chave not in vistos:
                vistos.add(chave)
                feicoes.append(f)
        if len(pagina) < POR_PAGINA:
            return feicoes
        inicio += POR_PAGINA


def limpar(valor):
    if valor is None:
        return ""
    return " ".join(str(valor).split()).replace(" ,", ",")


SIGLAS = {"AMA", "AME", "CEO", "CER", "URSI", "PICS", "CR", "CCO", "USP", "SP", "TT", "POP",
          "CRATOD", "CEREST", "IPGG", "CS", "I", "II", "III", "IV", "12H", "24H", "AACD", "MASP",
          "UBS", "PS", "CRAS", "CREAS", "CEU", "CEI", "EMEI", "EMEF", "EMEFM", "EE", "ETEC", "FATEC",
          "CIEJA", "CEMEI", "CMCT", "SESC", "SENAI", "CPTM", "EMEBS", "CCA", "CDC"}
MINUSCULAS = {"de", "da", "do", "das", "dos", "e"}


def titulo(texto):
    """'AMA 12H JARDIM SÃO LUIZ' -> 'AMA 12H Jardim São Luiz'."""
    palavras = []
    for i, p in enumerate(texto.split(" ")):
        if p.upper() in SIGLAS:
            palavras.append(p.upper())
        elif i > 0 and p.lower() in MINUSCULAS:
            palavras.append(p.lower())
        else:
            palavras.append("-".join(s.upper() if s.upper() in SIGLAS else s.capitalize() for s in p.split("-")))
    return " ".join(palavras)


def tipo_por_prefixo(nome, regras):
    curinga = regras.get("*", "")
    # prefixos mais longos primeiro (ex.: "CR PICS" antes de "CR")
    for prefixo in sorted((p for p in regras if p != "*"), key=len, reverse=True):
        if nome.upper().startswith(prefixo):
            return regras[prefixo]
    return curinga


def processar(camada, brutas):
    """Converte feições cruas da fonte em feições no formato do mapa."""
    cfg = camada["atualizacao"]
    saida = []
    for f in brutas:
        geom = f.get("geometry")
        if not geom or geom.get("type") != "Point":
            continue
        lon, lat = geom["coordinates"][:2]
        prefixos = cfg.get("filtro_nome")
        if prefixos:
            nome_fonte = limpar(f["properties"].get(cfg["campos"]["nome"])).upper()
            if not any(nome_fonte.startswith(x) for x in prefixos):
                continue
        props = {novo: limpar(f["properties"].get(orig)) for novo, orig in cfg["campos"].items()}
        # textos todos em maiúsculas viram "Título" (ex.: VILA MARIANA -> Vila Mariana)
        props = {k: titulo(v) if v.isupper() else v for k, v in props.items()}
        props["nome"] = cfg.get("prefixo_nome", "") + props.get("nome", "")
        if "tipo_por_prefixo" in cfg:
            props["tipo"] = tipo_por_prefixo(f["properties"].get(cfg["campos"]["nome"], ""), cfg["tipo_por_prefixo"])
        props["id_fonte"] = str(f.get("id", ""))
        saida.append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}, "properties": props})

    # Junta pontos com o mesmo nome (ex.: estação Sé nas linhas Azul e Vermelha)
    chave = cfg.get("agrupar_por")
    if chave:
        grupos = {}
        for f in saida:
            k = f["properties"][chave]
            if k not in grupos:
                grupos[k] = f
                for campo in cfg.get("lista", []):
                    f["properties"][campo] = [f["properties"][campo]]
            else:
                for campo in cfg.get("lista", []):
                    v = f["properties"][campo]
                    if v not in grupos[k]["properties"][campo]:
                        grupos[k]["properties"][campo].append(v)
        saida = list(grupos.values())
        for f in saida:
            for campo in cfg.get("lista", []):
                f["properties"][campo] = ", ".join(x for x in f["properties"][campo])

    saida.sort(key=lambda f: f["properties"]["nome"])
    # id estável (vem da fonte), para que links de rota compartilhados continuem valendo
    for i, f in enumerate(saida):
        sufixo = f["properties"]["id_fonte"].rsplit(".", 1)[-1] or str(i + 1)
        f["properties"]["id"] = f"{camada['id']}-{sufixo}"
    return {
        "type": "FeatureCollection",
        "metadata": {
            "camada": camada["id"],
            "fonte": camada["fonte"]["nome"],
            "camada_fonte": camada["fonte"].get("camada", ""),
            "atualizado_em": date.today().isoformat(),
            "total": len(saida),
        },
        "features": saida,
    }


def gravar(camada, colecao):
    destino = RAIZ / camada["arquivo"]
    destino.parent.mkdir(parents=True, exist_ok=True)
    destino.write_text(json.dumps(colecao, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{camada['id']}: {colecao['metadata']['total']} pontos -> {camada['arquivo']}")


def main(filtro):
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    falhas = 0
    for camada in config["camadas"]:
        if filtro and camada["id"] not in filtro:
            continue
        cfg = camada.get("atualizacao", {})
        if cfg.get("tipo") != "wfs":
            print(f"{camada['id']}: sem atualização automática, mantido como está")
            continue
        try:
            gravar(camada, processar(camada, baixar_wfs(cfg)))
        except Exception as erro:  # mantém o arquivo antigo se a fonte falhar
            falhas += 1
            print(f"{camada['id']}: falhou ({erro}); arquivo anterior mantido", file=sys.stderr)
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
