#!/usr/bin/env python3
"""Gera um único arquivo HTML com o site e os dados embutidos, para abrir
com duplo clique, sem servidor e sem GitHub.

Uso: python3 scripts/gerar_html_offline.py   ->  cria lmapa-offline.html
"""
import json
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def ler(caminho):
    return (RAIZ / caminho).read_text(encoding="utf-8")


def main():
    config = json.loads(ler("camadas.json"))
    arquivos = {"camadas.json": config}
    for c in config["camadas"]:
        if (RAIZ / c["arquivo"]).exists():
            arquivos[c["arquivo"]] = json.loads(ler(c["arquivo"]))
    if (RAIZ / "data/municipios.geojson").exists():
        arquivos["data/municipios.geojson"] = json.loads(ler("data/municipios.geojson"))

    # Serve os arquivos embutidos no lugar do fetch, que não funciona em páginas abertas do disco
    ponte = (
        "<script>\n(() => {\n"
        f"  const ARQUIVOS = {json.dumps(arquivos, ensure_ascii=False, separators=(',', ':'))};\n"
        "  const original = window.fetch ? window.fetch.bind(window) : null;\n"
        "  window.fetch = (url, opcoes) => {\n"
        "    const chave = String(url).replace(/^\\.\\//, '');\n"
        "    if (chave in ARQUIVOS) return Promise.resolve(new Response(JSON.stringify(ARQUIVOS[chave]), { headers: { 'Content-Type': 'application/json' } }));\n"
        "    if (!/^https?:/.test(chave)) return Promise.resolve(new Response('', { status: 404 }));\n"
        "    return original(url, opcoes);\n"
        "  };\n})();\n</script>"
    )

    html = ler("index.html")
    html = html.replace('<link rel="stylesheet" href="vendor/leaflet.css">', f"<style>\n{ler('vendor/leaflet.css')}\n</style>")
    html = html.replace('<link rel="stylesheet" href="estilo.css">', f"<style>\n{ler('estilo.css')}\n</style>")
    html = html.replace('<script src="vendor/leaflet.js"></script>', f"<script>\n{ler('vendor/leaflet.js')}\n</script>\n{ponte}")
    html = html.replace('<script src="app.js"></script>', f"<script>\n{ler('app.js')}\n</script>")
    destino = RAIZ / "lmapa-offline.html"
    destino.write_text(html, encoding="utf-8")
    print(f"{destino.name}: {destino.stat().st_size / 1e6:.1f} MB, {len(arquivos) - 1} arquivos de dados embutidos")


if __name__ == "__main__":
    main()
