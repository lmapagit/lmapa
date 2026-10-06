# Mapa de Infraestrutura

Mapa interativo (Leaflet) de locais com grande circulação de pessoas, a partir de bases públicas. Começa pelo município de São Paulo; outras cidades entram como novas bases em `camadas.json`.

- Filtra por tema (saúde, educação, transporte, serviços essenciais, cultura e lazer) e por base, com um botão para marcar ou desmarcar todas.
- Mostra os locais mais próximos de você (GPS ou ponto marcado no mapa).
- Monta uma rota passando pelos pontos escolhidos, traçada pelas ruas (a pé) quando o serviço de rotas responde.
- Salva a rota como imagem PNG e gera um link para compartilhar a mesma rota.

## Bases

Todas vêm do GeoSampa (Prefeitura de São Paulo), pelo serviço WFS `https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows`.

| Tema | Base | Camada no GeoSampa |
|---|---|---|
| Saúde | Hospitais | `geoportal:equipamento_saude_hospital` |
| Saúde | UBS e postos de saúde | `geoportal:equipamento_saude_ubs_posto_centro` |
| Saúde | Pronto-socorros e AMA 24h | `geoportal:equipamento_saude_urgencia_emergencia` |
| Saúde | AMAs e ambulatórios especializados | `geoportal:equipamento_saude_ambulatorios_especializados` |
| Educação | Escolas públicas (fundamental e médio) | `geoportal:equipamento_educacao_rede_publica` |
| Educação | Educação infantil | `geoportal:equipamento_educacao_infantil_rede_publica` |
| Educação | Escolas técnicas públicas | `geoportal:equipamento_educacao_ensino_tecnico_rede_publica` |
| Educação | CEUs | `geoportal:equipamento_educacao_ceu` |
| Educação | Escolas particulares | `geoportal:equipamento_educacao_rede_privada` |
| Transporte | Estações de metrô | `geoportal:estacao_metro` |
| Transporte | Estações de trem | `geoportal:estacao_trem` |
| Transporte | Pontos de ônibus (aparecem só com o mapa aproximado) | `geoportal:ponto_onibus` |
| Serviços essenciais | Restaurantes Bom Prato | `geoportal:equipamento_bom_prato` |
| Serviços essenciais | Descomplica SP | `geoportal:descomplica` |
| Serviços essenciais | Feiras livres | `geoportal:equipamento_feira_livre` |
| Cultura e lazer | Bibliotecas públicas | `geoportal:equipamento_cultura_bibliotecas` |
| Cultura e lazer | Centros culturais | `geoportal:equipamento_cultura_espacos_culturais` |
| Cultura e lazer | Centros esportivos | `geoportal:equipamento_esporte_centro_esportivo` |

Os limites municipais (fundo usado quando o mapa de ruas não carrega) vêm do IBGE, via [tbrugz/geodata-br](https://github.com/tbrugz/geodata-br).

## Estrutura

```
index.html            página
estilo.css            visual
app.js                lógica do mapa
camadas.json          lista de temas e bases  <- é aqui que se adiciona uma base nova
data/*.geojson        dados de cada base
scripts/atualizar_dados.py   baixa as bases a partir das fontes
.github/workflows/atualizar-dados.yml   roda o script no GitHub quando você pedir
vendor/               Leaflet 1.9.4
```

## Como adicionar uma base nova

1. Inclua uma entrada em `camadas.json`, dentro de `"camadas"`:

   ```json
   {
     "id": "ceu",
     "nome": "CEUs",
     "tema": "educacao",
     "arquivo": "data/ceu.geojson",
     "campos_popup": [{ "campo": "endereco", "rotulo": "Endereço" }],
     "fonte": { "nome": "GeoSampa (Prefeitura de São Paulo)", "url": "https://geosampa.prefeitura.sp.gov.br/" },
     "atualizacao": {
       "tipo": "wfs",
       "url": "https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows",
       "typeName": "geoportal:equipamento_educacao_ceu",
       "campos": { "nome": "nm_equipamento", "endereco": "tx_endereco_equipamento" }
     }
   }
   ```

   `campos` diz qual coluna da fonte vira cada informação do mapa. `nome` é obrigatório.
   Para uma base muito grande, acrescente `"zoom_minimo": 15` para os pontos só aparecerem com o mapa aproximado.

2. Gere `data/ceu.geojson`: na aba **Actions** do GitHub, rode "Baixar dados" (ou, no seu computador, `python3 scripts/atualizar_dados.py ceu`).
   Se a base não vier de um servidor WFS (ex.: uma planilha CSV), basta salvar um GeoJSON de pontos em `data/` com a propriedade `nome` em cada ponto e omitir o bloco `atualizacao`.

3. Para um tema novo, acrescente-o em `"temas"` com `id`, `nome` e `cor`.

## Testar no seu computador

```
cd prototipo
python3 -m http.server 8000
```

Depois abra http://localhost:8000. Abrir o `index.html` direto (duplo clique) não funciona, porque o navegador bloqueia a leitura dos arquivos de dados.

## Testar sem servidor (um único arquivo)

`python3 scripts/gerar_html_offline.py` cria `lmapa-offline.html`, com o site e os dados embutidos. Ele abre com duplo clique e não precisa ir para o GitHub. O mapa de ruas e o traçado da rota pelas ruas precisam de internet; sem ela, o fundo vira o contorno dos municípios e a rota sai em linha reta.

## Publicar no GitHub Pages

1. Crie um repositório público no GitHub chamado `lmapa`.
2. Envie todo o conteúdo desta pasta para a raiz do repositório, incluindo a pasta oculta `.github`.
3. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, escolha a branch `main` e a pasta `/ (root)`, e salve.
4. Em um ou dois minutos o site fica em `https://SEU-USUARIO.github.io/lmapa/`.
5. Baixe os dados uma vez: **Settings → Actions → General → Workflow permissions → Read and write permissions** e salve. Depois, na aba **Actions**, abra "Baixar dados" e clique em **Run workflow**. Em poucos minutos os arquivos de `data/` são criados e o site passa a mostrar todas as bases. Para atualizar os dados no futuro, basta rodar de novo.

## Limitações conhecidas

- A localização por GPS só funciona em HTTPS (o GitHub Pages já usa) e depende da permissão do navegador.
- O traçado pelas ruas usa o servidor público de rotas do projeto FOSSGIS (routing.openstreetmap.de), que é gratuito e sem garantia de disponibilidade. Quando não responde, a rota aparece em linha reta e o tempo é estimado a 4,8 km/h.
- O GeoSampa não tem os CRAS como pontos (só as áreas de abrangência), por isso eles ficaram de fora.
