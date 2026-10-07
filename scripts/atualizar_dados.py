#!/usr/bin/env python3
"""Baixa as bases listadas em camadas.json e grava os pontos em data/.

Uso:
    python3 scripts/atualizar_dados.py               # todas as camadas e o destaque eleitoral
    python3 scripts/atualizar_dados.py metro ubs     # só essas camadas
    python3 scripts/atualizar_dados.py eleitoral     # só os dados eleitorais

Cada camada pode juntar várias fontes ("fontes" em camadas.json):
    wfs                servidor WFS (ex.: GeoSampa), já em latitude/longitude
    cnes               Cadastro Nacional de Estabelecimentos de Saúde (Ministério da Saúde)
    overture_lugares   lugares do Overture Maps (escolas, bibliotecas, museus…)
    overture_infra     infraestrutura do OpenStreetMap distribuída pelo Overture Maps
                       (pontos de ônibus, estações, terminais)

Cada camada vira uma pasta data/<camada>/ com um índice (indice.json) e os
pontos. Camadas grandes (ex.: pontos de ônibus do estado) são divididas em
blocos de um grau; o site só baixa os blocos da área que está na tela, o que
mantém o mapa leve no celular. As demais ficam num arquivo só (todos.json).

Opções de uma fonte "wfs":
    campos          coluna da fonte -> informação do mapa ("nome" é obrigatório)
    prefixo_nome    texto colocado antes do nome (ex.: "Feira ")
    filtro_nome     só mantém pontos cujo nome começa por um destes textos
    ordenar_por     coluna usada para paginar (necessária em camadas sem chave primária)
    campo_id        coluna que identifica cada ponto (quando a fonte não traz um id estável)
    agrupar_por     junta pontos com o mesmo valor (ex.: estação em duas linhas)
    lista           campos que viram lista ao agrupar
    tipo_por_prefixo  deduz o tipo pelo começo do nome
    municipio       nome do município, quando a fonte cobre uma cidade só
Opções das fontes nacionais:
    fora_da_capital  descarta pontos da capital (que já vêm de uma fonte municipal)
    tipos_unidade    (cnes) códigos TP_UNIDADE do CNES; so_publicos: códigos em que só entram os públicos
    categorias       (overture_lugares) categorias do Overture; confianca_minima; nome_contem (expressão);
                     confissao (id de uma regra em "confissoes", para templos)
    classes          (overture_infra) classes do Overture; operador (expressão); nome_padrao

As fontes "overture_*" precisam de: pip install pyarrow fsspec aiohttp
"""
import csv
import io
import json
import math
import re
import shutil
import sys
import tempfile
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
CONFIG = RAIZ / "camadas.json"
BLOCO = 1.0  # tamanho do bloco, em graus
UM_ARQUIVO_ATE = 8000  # camadas até este tamanho ficam num arquivo só (data/<camada>/todos.json)
AGENTE = {"User-Agent": "Mozilla/5.0 (compatible; mapa-dados/1.0)"}

csv.field_size_limit(10**8)


def abrir(url, timeout=300):
    return urllib.request.urlopen(urllib.request.Request(url, headers=AGENTE), timeout=timeout)


def baixar_para_arquivo(url):
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".zip")
    with abrir(url, timeout=900) as resp, tmp:
        shutil.copyfileobj(resp, tmp, 2**20)
    return tmp.name


# ---------- Textos ----------

def limpar(valor):
    if valor is None:
        return ""
    return " ".join(str(valor).split()).replace(" ,", ",")


SIGLAS = {"AMA", "AME", "CEO", "CER", "URSI", "PICS", "CR", "CCO", "USP", "SP", "TT", "POP",
          "CRATOD", "CEREST", "IPGG", "CS", "I", "II", "III", "IV", "12H", "24H", "AACD", "MASP",
          "UBS", "PS", "CRAS", "CREAS", "CEU", "CEI", "EMEI", "EMEF", "EMEFM", "EE", "ETEC", "FATEC",
          "CIEJA", "CEMEI", "CMCT", "SESC", "SENAI", "CPTM", "EMEBS", "CCA", "CDC", "UPA", "CAPS",
          "USF", "ESF", "PA", "PSF", "UBSF", "SUS", "AD", "IJ", "UNESP", "UNICAMP", "HC", "FMUSP",
          "APAE", "LTDA", "ME", "EPP", "SA", "S/A", "UNIFESP", "NGA", "CAISM", "CRT", "DST", "AIDS"}
MINUSCULAS = {"de", "da", "do", "das", "dos", "e"}


def titulo(texto):
    """'AMA 12H JARDIM SÃO LUIZ' -> 'AMA 12H Jardim São Luiz'."""
    palavras = []
    for i, p in enumerate(texto.split(" ")):
        if p.upper() in SIGLAS or p.upper().rstrip(".").replace(".", "") in SIGLAS | {"CCE", "EMEB", "EEPG", "EEPSG", "CEMEF"}:
            palavras.append(p.upper())
        elif i > 0 and p.lower() in MINUSCULAS:
            palavras.append(p.lower())
        else:
            palavras.append("-".join(s.upper() if s.upper() in SIGLAS else s.capitalize() for s in p.split("-")))
    return " ".join(palavras)


def ajustar(props):
    # textos todos em maiúsculas viram "Título" (ex.: VILA MARIANA -> Vila Mariana)
    return {k: titulo(v) if isinstance(v, str) and v.isupper() else v for k, v in props.items()}


def tipo_por_prefixo(nome, regras):
    curinga = regras.get("*", "")
    # prefixos mais longos primeiro (ex.: "CR PICS" antes de "CR")
    for prefixo in sorted((p for p in regras if p != "*"), key=len, reverse=True):
        if nome.upper().startswith(prefixo):
            return regras[prefixo]
    return curinga


# ---------- Municípios (para saber em que cidade cai cada ponto) ----------

def preparar_municipios(config):
    """Garante um arquivo de limites municipais por estado em data/municipios/<UF>.geojson
    (baixa do IBGE, via tbrugz/geodata-br, os que faltarem) e grava o índice com a área de cada estado."""
    cfg = config["municipios"]
    pasta = RAIZ / cfg["pasta"]
    pasta.mkdir(parents=True, exist_ok=True)
    indice = {}
    for r in config["regioes"]:
        arq = pasta / f"{r['uf']}.geojson"
        if not arq.exists():
            geo = json.load(abrir(cfg["url"].format(uf_ibge=r["uf_ibge"])))
            arredondar = lambda c: [arredondar(x) for x in c] if isinstance(c[0], list) else [round(c[0], 4), round(c[1], 4)]
            feicoes = [{"type": "Feature",
                        "properties": {"nome": f["properties"]["name"], "cod": str(f["properties"]["id"]), "uf": r["uf"]},
                        "geometry": {"type": f["geometry"]["type"], "coordinates": arredondar(f["geometry"]["coordinates"])}}
                       for f in geo["features"]]
            arq.write_text(json.dumps({"type": "FeatureCollection", "metadata": {"fonte": "IBGE, via github.com/tbrugz/geodata-br"},
                                       "features": feicoes}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
            print(f"  limites municipais de {r['uf']}: {len(feicoes)} municípios")
        geo = json.loads(arq.read_text(encoding="utf-8"))
        pts = [pt for f in geo["features"] for pol in ([f["geometry"]["coordinates"]] if f["geometry"]["type"] == "Polygon" else f["geometry"]["coordinates"]) for a in pol for pt in a]
        indice[r["uf"]] = {"nome": r["nome"], "caixa": [min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts)]}
    (pasta / "indice.json").write_text(json.dumps(indice, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return [pasta / f"{r['uf']}.geojson" for r in config["regioes"]]


class Municipios:
    TOLERANCIA = 0.005  # graus (~500 m): aceita pontos logo além do limite simplificado (praias, margens de rio)

    def __init__(self, arquivos):
        self.itens, self.grade, self.uf_de = [], defaultdict(list), {}
        for arq in arquivos:
            for f in json.loads(Path(arq).read_text(encoding="utf-8"))["features"]:
                g = f["geometry"]
                poligonos = [g["coordinates"]] if g["type"] == "Polygon" else g["coordinates"]
                aneis = [anel for pol in poligonos for anel in pol]
                xs = [x for a in aneis for x, _ in a]
                ys = [y for a in aneis for _, y in a]
                i = len(self.itens)
                self.itens.append((f["properties"]["cod"], f["properties"]["nome"], aneis))
                self.uf_de[f["properties"]["cod"]] = f["properties"].get("uf", "")
                for gx in range(math.floor(min(xs) * 10), math.floor(max(xs) * 10) + 1):
                    for gy in range(math.floor(min(ys) * 10), math.floor(max(ys) * 10) + 1):
                        self.grade[(gx, gy)].append(i)

    @staticmethod
    def _dentro(x, y, aneis):
        dentro = False
        for anel in aneis:
            j = len(anel) - 1
            for i in range(len(anel)):
                xi, yi = anel[i]
                xj, yj = anel[j]
                if (yi > y) != (yj > y) and x < (xj - xi) * (y - yi) / (yj - yi) + xi:
                    dentro = not dentro
                j = i
        return dentro

    @staticmethod
    def _distancia(x, y, aneis):
        menor = math.inf
        for anel in aneis:
            for (xi, yi), (xj, yj) in zip(anel, anel[1:]):
                dx, dy = xj - xi, yj - yi
                t = max(0, min(1, ((x - xi) * dx + (y - yi) * dy) / (dx * dx + dy * dy))) if dx or dy else 0
                menor = min(menor, math.hypot(x - xi - t * dx, y - yi - t * dy))
        return menor

    def caixa(self, uf):
        """Retângulo (x0, y0, x1, y1) que envolve os municípios da UF."""
        pts = [pt for cod, _, aneis in self.itens if self.uf_de[cod] == uf for a in aneis for pt in a]
        return (min(x for x, _ in pts), min(y for _, y in pts), max(x for x, _ in pts), max(y for _, y in pts))

    def achar(self, lon, lat):
        """(código IBGE, nome) do município que contém o ponto, ou None fora dos estados cobertos."""
        candidatos = self.grade.get((math.floor(lon * 10), math.floor(lat * 10)), [])
        for i in candidatos:
            cod, nome, aneis = self.itens[i]
            if self._dentro(lon, lat, aneis):
                return cod, nome
        perto, menor = None, self.TOLERANCIA
        for i in candidatos:
            d = self._distancia(lon, lat, self.itens[i][2])
            if d < menor:
                perto, menor = self.itens[i][:2], d
        return perto


# ---------- Fonte: WFS (GeoSampa) ----------

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
        # Camadas sem chave primária só aceitam paginação com uma ordem definida
        if cfg.get("ordenar_por"):
            params["sortBy"] = cfg["ordenar_por"]
        with abrir(cfg["url"] + "?" + urllib.parse.urlencode(params), timeout=180) as resp:
            pagina = json.load(resp)["features"]
        for f in pagina:
            valor_id = f["properties"].get(cfg["campo_id"]) if cfg.get("campo_id") else None
            if valor_id is not None:
                f["id"] = f"{cfg['typeName'].split(':')[-1]}.{valor_id}"
            chave = f.get("id") or json.dumps(f.get("geometry"))
            if chave not in vistos:
                vistos.add(chave)
                feicoes.append(f)
        if len(pagina) < POR_PAGINA:
            return feicoes
        inicio += POR_PAGINA


def fonte_wfs(cfg, ctx):
    saida = []
    for f in baixar_wfs(cfg):
        geom = f.get("geometry")
        if not geom or geom.get("type") != "Point":
            continue
        lon, lat = geom["coordinates"][:2]
        prefixos = cfg.get("filtro_nome")
        if prefixos:
            nome_fonte = limpar(f["properties"].get(cfg["campos"]["nome"])).upper()
            if not any(nome_fonte.startswith(x) for x in prefixos):
                continue
        props = ajustar({novo: limpar(f["properties"].get(orig)) for novo, orig in cfg["campos"].items()})
        props["nome"] = cfg.get("prefixo_nome", "") + props.get("nome", "")
        if "tipo_por_prefixo" in cfg:
            props["tipo"] = tipo_por_prefixo(f["properties"].get(cfg["campos"]["nome"], ""), cfg["tipo_por_prefixo"])
        if cfg.get("municipio"):
            props["municipio"] = cfg["municipio"]
        saida.append((lon, lat, str(f.get("id", "")).rsplit(".", 1)[-1], props))

    # Junta pontos com o mesmo nome (ex.: estação Sé nas linhas Azul e Vermelha)
    chave = cfg.get("agrupar_por")
    if chave:
        grupos = {}
        for item in saida:
            props = item[3]
            k = props[chave]
            if k not in grupos:
                grupos[k] = item
                for campo in cfg.get("lista", []):
                    props[campo] = [props[campo]]
            else:
                for campo in cfg.get("lista", []):
                    if props[campo] not in grupos[k][3][campo]:
                        grupos[k][3][campo].append(props[campo])
        saida = list(grupos.values())
        for item in saida:
            for campo in cfg.get("lista", []):
                item[3][campo] = ", ".join(item[3][campo])
    return saida


# ---------- Fonte: CNES ----------

CNES_URL = "https://s3.sa-east-1.amazonaws.com/ckan.saude.gov.br/CNES/cnes_estabelecimentos.zip"
CNES_COLUNAS = {"CO_CNES", "TP_UNIDADE", "CO_NATUREZA_JUR", "NU_LATITUDE", "NU_LONGITUDE", "NO_FANTASIA", "NO_RAZAO_SOCIAL",
                "NO_LOGRADOURO", "NU_ENDERECO", "NO_BAIRRO", "NU_TELEFONE"}
NATUREZA = {"1": "Pública", "2": "Privada", "3": "Filantrópica / sem fins lucrativos", "4": "Privada"}


def carregar_cnes(ctx):
    if "cnes" not in ctx:
        arquivo = baixar_para_arquivo(ctx["config"].get("cnes_url") or CNES_URL)
        ufs = {r["uf_ibge"] for r in ctx["regioes"]}
        linhas = []
        with zipfile.ZipFile(arquivo) as z:
            nome = next(n for n in z.namelist() if n.lower().endswith(".csv"))
            with z.open(nome) as bruto:
                leitor = csv.reader(io.TextIOWrapper(bruto, encoding="latin-1"), delimiter=";")
                cab = next(leitor)
                usadas = [i for i, c in enumerate(cab) if c in CNES_COLUNAS]
                i_uf = cab.index("CO_UF")
                for linha in leitor:
                    if len(linha) > i_uf and linha[i_uf] in ufs:
                        linhas.append({cab[i]: linha[i] for i in usadas if i < len(linha)})
        Path(arquivo).unlink()
        ctx["cnes"] = linhas
        print(f"  CNES: {len(linhas)} estabelecimentos nos estados cobertos")
    return ctx["cnes"]


def fonte_cnes(cfg, ctx):
    tipos = {str(t) for t in cfg["tipos_unidade"]}
    so_publicos = {str(t) for t in cfg.get("so_publicos", [])}
    saida = []
    for r in carregar_cnes(ctx):
        t = r["TP_UNIDADE"]
        if t not in tipos:
            continue
        natureza = NATUREZA.get((r.get("CO_NATUREZA_JUR") or " ")[0], "")
        if t in so_publicos and natureza != "Pública":
            continue
        try:
            lat, lon = float(r["NU_LATITUDE"]), float(r["NU_LONGITUDE"])
        except ValueError:
            continue
        if not lat or not lon:
            continue
        numero = limpar(r["NU_ENDERECO"])
        endereco = limpar(r["NO_LOGRADOURO"]) + (f", {numero}" if numero and numero.upper() != "S/N" else "")
        props = ajustar({
            "nome": limpar(r["NO_FANTASIA"]) or limpar(r["NO_RAZAO_SOCIAL"]),
            "endereco": endereco,
            "bairro": limpar(r["NO_BAIRRO"]),
            "telefone": limpar(r["NU_TELEFONE"]),
        })
        props["tipo"] = natureza
        saida.append((lon, lat, r["CO_CNES"], props))
    return saida


# ---------- Fonte: Overture Maps (inclui dados do OpenStreetMap) ----------

OVERTURE = "https://overturemaps-us-west-2.s3.amazonaws.com"


def overture_release():
    xml = abrir(f"{OVERTURE}/?list-type=2&prefix=release/&delimiter=/").read().decode()
    return sorted(re.findall(r"<Prefix>release/([^<]+)/</Prefix>", xml))[-1]


def overture_ler(ctx, tema, tipo, colunas, coluna_filtro, valores):
    """Lê do Overture só os grupos de linhas que cruzam os estados cobertos e só as categorias pedidas."""
    import fsspec
    import pyarrow as pa
    import pyarrow.compute as pc
    import pyarrow.parquet as pq

    if "overture_release" not in ctx:
        ctx["overture_release"] = overture_release()
        print(f"  Overture: versão {ctx['overture_release']}")
    prefixo = urllib.parse.quote(f"release/{ctx['overture_release']}/theme={tema}/type={tipo}/")
    chaves, token = [], None
    while True:
        url = f"{OVERTURE}/?list-type=2&prefix={prefixo}" + (f"&continuation-token={urllib.parse.quote(token)}" if token else "")
        xml = abrir(url).read().decode()
        chaves += re.findall(r"<Key>([^<]*\.parquet)</Key>", xml)
        m = re.search(r"<NextContinuationToken>([^<]*)<", xml)
        if not m:
            break
        token = m.group(1)
    fs = fsspec.filesystem("https", client_kwargs={"trust_env": True})
    tabelas = []
    for chave in chaves:
        arq = pq.ParquetFile(fs.open(f"{OVERTURE}/{chave}", block_size=2**22))
        md = arq.metadata
        nomes = [md.row_group(0).column(i).path_in_schema for i in range(md.num_columns)]
        ix = {n: nomes.index(n) for n in ("bbox.xmin", "bbox.xmax", "bbox.ymin", "bbox.ymax")}
        grupos = []
        for g in range(md.num_row_groups):
            st = {n: md.row_group(g).column(i).statistics for n, i in ix.items()}
            if any(not (st["bbox.xmax"].min > x1 or st["bbox.xmin"].max < x0 or st["bbox.ymax"].min > y1 or st["bbox.ymin"].max < y0)
                   for x0, y0, x1, y1 in ctx["caixas"]):
                grupos.append(g)
        for i in range(0, len(grupos), 8):
            t = arq.read_row_groups(grupos[i:i + 8], columns=colunas)
            bx = t.column("bbox")
            xm, ym = pc.struct_field(bx, "xmin"), pc.struct_field(bx, "ymin")
            dentro = None
            for x0, y0, x1, y1 in ctx["caixas"]:
                d = pc.and_(pc.and_(pc.greater_equal(xm, x0), pc.less_equal(xm, x1)),
                            pc.and_(pc.greater_equal(ym, y0), pc.less_equal(ym, y1)))
                dentro = d if dentro is None else pc.or_(dentro, d)
            t = t.filter(pc.and_(dentro, pc.is_in(t.column(coluna_filtro), value_set=pa.array(sorted(valores)))))
            if t.num_rows:
                tabelas.append(t)
    linhas = [r for t in tabelas for r in t.to_pylist()]
    print(f"  Overture {tema}/{tipo}: {len(linhas)} registros")
    return linhas


def categorias_pedidas(config, tipo_fonte, chave):
    return {v for c in config["camadas"] for f in c.get("fontes", []) if f["tipo"] == tipo_fonte for v in f[chave]}


def centro(bbox):
    return (bbox["xmin"] + bbox["xmax"]) / 2, (bbox["ymin"] + bbox["ymax"]) / 2


def confissao(nome, r, ctx):
    """Classifica um templo pela confissão, usando as regras de "confissoes" em camadas.json
    (primeiro pelo nome, depois pela categoria do Overture). None = não é templo."""
    taxonomia = (r.get("taxonomy") or {}).get("primary") or ""
    for regra in ctx["config"]["confissoes"]:
        if regra.get("nome") and re.search(regra["nome"], nome, re.I):
            return regra["id"]
        if taxonomia in regra.get("categorias", []):
            return regra["id"]
    return None


def fonte_overture_lugares(cfg, ctx):
    if "overture_lugares" not in ctx:
        ctx["overture_lugares"] = overture_ler(
            ctx, "places", "place", ["id", "names", "basic_category", "taxonomy", "confidence", "addresses", "bbox"],
            "basic_category", categorias_pedidas(ctx["config"], "overture_lugares", "categorias"))
    cats, minimo = set(cfg["categorias"]), cfg.get("confianca_minima", 0.6)
    rotulos = cfg.get("rotulos", {})
    saida = []
    for r in ctx["overture_lugares"]:
        if r["basic_category"] not in cats or (r["confidence"] or 0) < minimo:
            continue
        nome = limpar((r["names"] or {}).get("primary"))
        if not nome:
            continue
        if cfg.get("nome_contem") and not re.search(cfg["nome_contem"], nome, re.I):
            continue
        if cfg.get("confissao") and confissao(nome, r, ctx) != cfg["confissao"]:
            continue
        lon, lat = centro(r["bbox"])
        end = (r["addresses"] or [{}])[0] or {}
        props = {"nome": nome, "endereco": limpar(end.get("freeform"))}
        if rotulos:
            props["tipo"] = rotulos.get(r["basic_category"], "")
        saida.append((lon, lat, r["id"].replace("-", "")[:12], props))
    return saida


def fonte_overture_infra(cfg, ctx):
    if "overture_infra" not in ctx:
        ctx["overture_infra"] = overture_ler(
            ctx, "base", "infrastructure", ["id", "names", "class", "source_tags", "bbox"],
            "class", categorias_pedidas(ctx["config"], "overture_infra", "classes"))
    classes = set(cfg["classes"])
    saida = []
    for r in ctx["overture_infra"]:
        if r["class"] not in classes:
            continue
        tags = dict(r["source_tags"] or [])
        if tags.get("disused") == "yes" or tags.get("abandoned") == "yes" or "disused:railway" in tags or "historic" in tags:
            continue
        # ex.: só estações com operador de trens de passageiros conhecido
        if cfg.get("operador") and not re.search(cfg["operador"], f"{tags.get('operator', '')};{tags.get('network', '')}", re.I):
            continue
        nome = limpar((r["names"] or {}).get("primary")) or cfg.get("nome_padrao", "")
        if not nome:
            continue
        lon, lat = centro(r["bbox"])
        props = {"nome": cfg.get("prefixo_nome", "") + nome}
        saida.append((lon, lat, r["id"].replace("-", "")[:12], props))
    return saida


FONTES = {"wfs": fonte_wfs, "cnes": fonte_cnes, "overture_lugares": fonte_overture_lugares, "overture_infra": fonte_overture_infra}


# ---------- Montagem da camada ----------

def bloco_de(lon, lat):
    return f"{math.floor(lon / BLOCO)}_{math.floor(lat / BLOCO)}"


def montar(camada, ctx):
    muni = ctx["municipios"]
    # capitais que já têm fonte municipal própria (ex.: GeoSampa em São Paulo)
    capitais = {r["capital_ibge"] for r in ctx["regioes"] if r.get("capital_com_fonte_municipal")}
    pontos, fontes_usadas = [], []
    for n, cfg in enumerate(camada["fontes"]):
        brutos = FONTES[cfg["tipo"]](cfg, ctx)
        rotulo = cfg.get("rotulo", cfg["tipo"])
        mantidos = 0
        for lon, lat, id_fonte, props in brutos:
            if cfg["tipo"] != "wfs":
                achado = muni.achar(lon, lat)
                if not achado or (cfg.get("fora_da_capital") and achado[0] in capitais):
                    continue
                props["municipio"] = achado[1]
            props["fonte"] = rotulo
            props = {k: v for k, v in props.items() if v not in ("", None)}
            pontos.append((lon, lat, f"{n}{id_fonte}", props))
            mantidos += 1
        fontes_usadas.append({"rotulo": rotulo, "total": mantidos})
        print(f"  {camada['id']} · {rotulo}: {mantidos} pontos")

    pontos.sort(key=lambda p: p[3]["nome"])
    dividir = len(pontos) > UM_ARQUIVO_ATE
    blocos, vistos = defaultdict(list), set()
    for lon, lat, id_fonte, props in pontos:
        b = bloco_de(lon, lat) if dividir else "todos"
        # o id leva o bloco, para que uma rota compartilhada saiba qual bloco baixar
        meio = f"{b}." if dividir else ""
        pid = f"{camada['id']}.{meio}{re.sub(r'[^0-9A-Za-z]', '', id_fonte)}"
        if pid in vistos:
            continue
        vistos.add(pid)
        props = {"id": pid, **props}
        blocos[b].append({"type": "Feature", "geometry": {"type": "Point", "coordinates": [round(lon, 6), round(lat, 6)]}, "properties": props})
    return blocos, fontes_usadas


def gravar(camada, blocos, fontes_usadas):
    pasta = RAIZ / camada["pasta"]
    if pasta.exists():
        shutil.rmtree(pasta)
    pasta.mkdir(parents=True)
    for b, feicoes in blocos.items():
        (pasta / f"{b}.json").write_text(json.dumps({"type": "FeatureCollection", "features": feicoes}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    total = sum(len(f) for f in blocos.values())
    dividido = "todos" not in blocos
    indice = {
        "camada": camada["id"],
        "atualizado_em": date.today().isoformat(),
        "total": total,
        "bloco_graus": BLOCO if dividido else None,
        "fontes": fontes_usadas,
        "blocos": {b: len(f) for b, f in sorted(blocos.items())},
    }
    (pasta / "indice.json").write_text(json.dumps(indice, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"{camada['id']}: {total} pontos em {len(blocos)} blocos -> {camada['pasta']}")


# ---------- Dados eleitorais (TSE) ----------

def ler_csv_zip(caminho, filtro=None, padrao=r"\.csv$"):
    with zipfile.ZipFile(caminho) as z:
        for nome in [n for n in z.namelist() if re.search(padrao, n, re.I)]:
            with z.open(nome) as bruto:
                leitor = csv.reader(io.TextIOWrapper(bruto, encoding="latin-1"), delimiter=";", quotechar='"')
                cab = next(leitor)
                for linha in leitor:
                    r = dict(zip(cab, linha))
                    if filtro is None or filtro(r):
                        yield r


def url_boletins(cfg, uf):
    """Acha no portal de dados abertos do TSE o arquivo mais recente de boletins de urna da UF."""
    padrao = re.compile(rf"bweb_{cfg['turno']}t_{uf}_\d+\.zip$", re.I)
    try:
        api = f"https://dadosabertos.tse.jus.br/api/3/action/package_show?id={cfg['pacote_boletins']}"
        urls = sorted(r["url"] for r in json.load(abrir(api))["result"]["resources"] if padrao.search(r.get("url") or ""))
        if urls:
            return urls[-1]
    except Exception as erro:
        print(f"  aviso: portal do TSE não respondeu ({erro!r}); usando o endereço da configuração")
    return cfg["boletins_url"].replace("_UF_", f"_{uf}_")


def numero(v):
    try:
        return int(float(str(v).replace(",", ".")))
    except ValueError:
        return 0


def coordenada(v):
    try:
        x = float(str(v).replace(",", "."))
    except ValueError:
        return None
    return None if x in (0, -1) else x


def ler_boletins(arq, cargo, turno, aptos, nomes, total_cand, votos, por_tipo):
    # Arquivos grandes (todas as seções e cargos do estado): lê por posição de coluna, que é bem mais rápido
    with zipfile.ZipFile(arq) as z:
        for nome in [n for n in z.namelist() if n.lower().endswith(".csv")]:
            with z.open(nome) as bruto:
                leitor = csv.reader(io.TextIOWrapper(bruto, encoding="latin-1"), delimiter=";", quotechar='"')
                cab = next(leitor)
                c = {n: cab.index(n) for n in ("CD_CARGO_PERGUNTA", "CD_MUNICIPIO", "NR_ZONA", "NR_SECAO", "QT_APTOS",
                                               "DS_TIPO_VOTAVEL", "QT_VOTOS", "NR_VOTAVEL", "NM_VOTAVEL")}
                i_turno = cab.index("NR_TURNO") if "NR_TURNO" in cab else None
                i_cargo = c["CD_CARGO_PERGUNTA"]
                for r in leitor:
                    if len(r) < len(cab) or r[i_cargo] != cargo or (i_turno is not None and r[i_turno] != turno):
                        continue
                    sec = (r[c["CD_MUNICIPIO"]], r[c["NR_ZONA"]], r[c["NR_SECAO"]])
                    aptos[sec] = numero(r[c["QT_APTOS"]])
                    tipo = r[c["DS_TIPO_VOTAVEL"]].strip().lower()
                    qt = numero(r[c["QT_VOTOS"]])
                    if tipo == "nominal":
                        nr = r[c["NR_VOTAVEL"]]
                        votos[sec][nr] += qt
                        total_cand[nr] += qt
                        if nr not in nomes:
                            nomes[nr] = titulo(limpar(r[c["NM_VOTAVEL"]]))
                    elif tipo in ("branco", "nulo"):
                        por_tipo[sec][tipo] += qt


def atualizar_eleitoral(config, ctx):
    cfg = config["eleitoral"]
    ufs, turno, cargo = [r["uf"] for r in ctx["regioes"]], str(cfg["turno"]), str(cfg["cargo"])

    # 1. Seções e locais de votação, com coordenadas
    arq = baixar_para_arquivo(cfg["locais_url"])
    secoes, locais = {}, {}
    for r in ler_csv_zip(arq, lambda r: r.get("SG_UF") in ufs and r.get("NR_TURNO", turno) in (turno, "")):
        chave_local = (r["CD_MUNICIPIO"], r["NR_ZONA"], r["NR_LOCAL_VOTACAO"])
        secoes[(r["CD_MUNICIPIO"], r["NR_ZONA"], r["NR_SECAO"])] = chave_local
        if chave_local not in locais:
            locais[chave_local] = {
                "lat": coordenada(r.get("NR_LATITUDE")), "lon": coordenada(r.get("NR_LONGITUDE")),
                "nome": titulo(limpar(r.get("NM_LOCAL_VOTACAO"))),
                "endereco": titulo(limpar(r.get("DS_ENDERECO"))),
                "municipio": titulo(limpar(r.get("NM_MUNICIPIO"))),
                "uf": r.get("SG_UF"),
            }
    Path(arq).unlink()
    print(f"  TSE: {len(secoes)} seções em {len(locais)} locais de votação")
    if not secoes:
        raise RuntimeError("nenhuma seção encontrada no arquivo de locais de votação")

    # 2. Boletins de urna (um arquivo por UF): votos por seção
    aptos, nomes, total_cand = {}, {}, defaultdict(int)
    votos = defaultdict(lambda: defaultdict(int))
    por_tipo = defaultdict(lambda: defaultdict(int))
    for uf in ufs:
        arq = baixar_para_arquivo(url_boletins(cfg, uf))
        ler_boletins(arq, cargo, turno, aptos, nomes, total_cand, votos, por_tipo)
        Path(arq).unlink()
    if not aptos:
        raise RuntimeError("nenhum voto para o cargo escolhido nos boletins de urna")

    # 3. Os dois principais candidatos (os mais votados, salvo se a configuração disser outros)
    principais = [str(n) for n in cfg.get("candidatos") or []] or [n for n, _ in sorted(total_cand.items(), key=lambda x: -x[1])[:2]]
    print(f"  TSE: principais candidatos {[(n, nomes.get(n)) for n in principais]}")

    # 4. Soma por local de votação
    soma = defaultdict(lambda: defaultdict(int))
    sem_local = 0
    for sec, qt_aptos in aptos.items():
        chave_local = secoes.get(sec)
        if not chave_local:
            sem_local += 1
            continue
        s, v = soma[chave_local], votos[sec]
        compareceram = sum(v.values()) + por_tipo[sec]["branco"] + por_tipo[sec]["nulo"]
        s["aptos"] += qt_aptos
        s["abstencoes"] += max(qt_aptos - compareceram, 0)
        s["brancos"] += por_tipo[sec]["branco"]
        s["nulos"] += por_tipo[sec]["nulo"]
        s["outros"] += sum(q for nr, q in v.items() if nr not in principais)
        s["c1"] += v.get(principais[0], 0)
        s["c2"] += v.get(principais[1], 0)
    if sem_local:
        print(f"  aviso: {sem_local} seções sem local de votação correspondente")

    campos = ["lat", "lng", "nome", "endereco", "municipio", "aptos", "abstencoes", "brancos", "nulos", "outros", "c1", "c2"]
    por_uf, sem_coord = defaultdict(list), 0
    for chave_local, s in soma.items():
        loc = locais[chave_local]
        if loc["lat"] is None or loc["lon"] is None:
            sem_coord += 1
            continue
        por_uf[loc["uf"]].append([round(loc["lat"], 6), round(loc["lon"], 6), loc["nome"], loc["endereco"], loc["municipio"],
                                  s["aptos"], s["abstencoes"], s["brancos"], s["nulos"], s["outros"], s["c1"], s["c2"]])
    if sem_coord:
        print(f"  aviso: {sem_coord} locais de votação sem coordenadas ficaram de fora")

    # Um arquivo por estado (o site só baixa os estados que aparecem na tela) e um índice
    pasta = RAIZ / cfg["pasta"]
    if pasta.exists():
        shutil.rmtree(pasta)
    pasta.mkdir(parents=True)
    estados = {}
    for uf, linhas in sorted(por_uf.items()):
        (pasta / f"{uf}.json").write_text(json.dumps({"locais": linhas}, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        lats, lngs = [l[0] for l in linhas], [l[1] for l in linhas]
        estados[uf] = {"total": len(linhas), "caixa": [min(lngs), min(lats), max(lngs), max(lats)]}
    indice = {
        "metadata": {
            "fonte": "Tribunal Superior Eleitoral (dados abertos)",
            "eleicao": cfg["descricao"],
            "atualizado_em": date.today().isoformat(),
            "candidatos": [{"numero": n, "nome": nomes.get(n, n)} for n in principais],
            "total": sum(e["total"] for e in estados.values()),
        },
        "campos": campos,
        "estados": estados,
    }
    (pasta / "indice.json").write_text(json.dumps(indice, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"eleitoral: {indice['metadata']['total']} locais de votação em {len(estados)} estados -> {cfg['pasta']}")


# ---------- Principal ----------

def main(filtro):
    config = json.loads(CONFIG.read_text(encoding="utf-8"))
    municipios = Municipios(preparar_municipios(config))
    regioes = config["regioes"]
    ctx = {"config": config, "municipios": municipios, "regioes": regioes,
           "caixas": [municipios.caixa(r["uf"]) for r in regioes]}
    falhas = 0
    for camada in config["camadas"]:
        if filtro and camada["id"] not in filtro:
            continue
        if not camada.get("fontes"):
            print(f"{camada['id']}: sem fontes para baixar, mantido como está")
            continue
        try:
            gravar(camada, *montar(camada, ctx))
        except Exception as erro:  # mantém os arquivos antigos se uma fonte falhar
            falhas += 1
            print(f"{camada['id']}: falhou ({erro!r}); arquivos anteriores mantidos", file=sys.stderr)
    if config.get("eleitoral") and (not filtro or "eleitoral" in filtro):
        try:
            atualizar_eleitoral(config, ctx)
        except Exception as erro:
            falhas += 1
            print(f"eleitoral: falhou ({erro!r}); arquivo anterior mantido", file=sys.stderr)
    return 1 if falhas else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
