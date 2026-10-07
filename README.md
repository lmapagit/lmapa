# Mapa de Infraestrutura

Mapa interativo (Leaflet) de locais com grande circulação de pessoas, a partir de bases públicas. Cobre o Brasil inteiro (os 26 estados e o Distrito Federal) com bases nacionais; na cidade de São Paulo usa as bases da prefeitura (GeoSampa), mais detalhadas. Bases locais de outras cidades podem ser acrescentadas em `camadas.json`.

- Filtra por tema (saúde, educação, transporte, serviços essenciais, cultura e lazer, religião) e por base, com um botão para marcar ou desmarcar todas. O mapa abre com todos os temas desligados; ligue os que quiser ver.
- Mostra os locais mais próximos de você (GPS ou ponto marcado no mapa).
- Monta uma rota passando pelos pontos escolhidos, traçada pelas ruas (a pé) quando o serviço de rotas responde.
- Botão "Sugerir boas rotas para mim" (aba Rota): monta opções de caminhada de 10, 30 ou 60 minutos a partir da sua localização (ou do centro do mapa), com três critérios: mais locais de interesse, equilibrada e mais votos em disputa. Cada opção mostra número de locais, tempo, distância, eleitores em disputa e temas; dá para ver no mapa e usar a que preferir. Pontos de ônibus não entram nas sugestões; o tempo não inclui as paradas.
- Escreve os nomes das ruas por onde a rota passa (no mapa, com zoom a partir do nível 15, e na imagem), sem sobrepor as paradas.
- Salva a rota como imagem PNG (paradas numeradas no mapa e nomes na legenda) e gera um link para compartilhar a mesma rota.
- Destaque eleitoral (liga e desliga no painel): realça os locais que ficam perto de locais de votação com muitos eleitores que não votaram em nenhum dos dois principais candidatos à Presidência (abstenções, brancos, nulos e votos nos demais candidatos). Dá para medir por número ou percentual, escolher o corte (10%, 20% ou 30% mais altos), comparar com o próprio estado ou com o próprio município e definir a distância (300 m, 500 m ou 1 km).
- No celular, a área de toque de cada ponto é maior, para não precisar acertar o ponto exato.

## Bases

| Tema | Base | Cidade de São Paulo | Demais municípios do Brasil |
|---|---|---|---|
| Saúde | Hospitais | GeoSampa | CNES (tipos 5, 7 e 62) |
| Saúde | UBS e postos de saúde | GeoSampa | CNES (tipos 1 e 2) |
| Saúde | Pronto-socorros, UPAs e pronto-atendimentos | GeoSampa | CNES (tipos 20, 21 e 73) |
| Saúde | Ambulatórios e policlínicas públicos | GeoSampa | CNES (tipos 4 e 36, só públicos) |
| Educação | Escolas públicas, educação infantil, técnicas, CEUs, particulares | GeoSampa | — |
| Educação | Escolas, todas as redes | — | Overture Maps |
| Transporte | Estações de metrô | GeoSampa | — |
| Transporte | Estações de trem, metrô e VLT | GeoSampa | OpenStreetMap (só com operador de passageiros) |
| Transporte | Terminais e rodoviárias | OpenStreetMap | OpenStreetMap |
| Transporte | Pontos de ônibus (aparecem com o mapa aproximado) | GeoSampa | OpenStreetMap |
| Serviços essenciais | Bom Prato, Descomplica | GeoSampa | — |
| Serviços essenciais | Feiras livres | GeoSampa | Overture Maps (nome com "feira") |
| Cultura e lazer | Bibliotecas, centros culturais | GeoSampa | Overture Maps |
| Cultura e lazer | Centros esportivos | GeoSampa | — |
| Religião | Católica, Evangélica, Espírita, Matriz africana, Outras confissões, Cristã sem confissão identificada | Overture Maps | Overture Maps |

Fontes:
- **GeoSampa** (Prefeitura de São Paulo), serviço WFS `https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows`.
- **CNES** (Ministério da Saúde, OpenDataSUS): arquivo `cnes_estabelecimentos.zip`, com coordenadas. A data do arquivo publicado pelo ministério pode ser antiga.
- **Overture Maps** (licença CDLA Permissive 2.0) e **OpenStreetMap** (© colaboradores do OpenStreetMap, ODbL), lidos do Overture Maps. São bases colaborativas: podem faltar locais ou haver locais fechados.
- **TSE** (dados abertos): boletins de urna do 1º turno de 2026 (um arquivo por estado) e cadastro de locais de votação (com coordenadas).

Os estados cobertos estão em `"regioes"` (sigla, nome e código IBGE). Os limites municipais ficam em `data/municipios/<UF>.geojson`; se faltar o arquivo de um estado, "Baixar dados" o baixa sozinho. Os locais de votação ficam em `data/eleitoral/<UF>.json`, e o site só baixa os estados que aparecem na tela.

A confissão dos templos é deduzida pelo nome e pela categoria do Overture, com as regras de `"confissoes"` em `camadas.json` (ex.: "Paróquia", "Capela" → Católica; "Assembleia de Deus", "Batista" → Evangélica). Templos sem pista no nome ficam em "Cristã, sem confissão identificada".

Os limites municipais (usados para saber o município de cada ponto e como fundo quando o mapa de ruas não carrega) vêm do IBGE, via [tbrugz/geodata-br](https://github.com/tbrugz/geodata-br).

## Estrutura

```
index.html            página
estilo.css            visual
app.js                lógica do mapa
camadas.json          lista de temas e bases  <- é aqui que se adiciona uma base nova
data/<base>/          dados de cada base: indice.json + todos.json (ou blocos, nas bases grandes)
data/eleitoral/       locais de votação com os votos somados, um arquivo por estado
data/municipios/      limites municipais, um arquivo por estado
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
     "pasta": "data/ceu",
     "cobertura": "Cidade de São Paulo",
     "campos_popup": [{ "campo": "endereco", "rotulo": "Endereço" }],
     "creditos": [{ "nome": "GeoSampa (Prefeitura de São Paulo)", "url": "https://geosampa.prefeitura.sp.gov.br/" }],
     "fontes": [{
       "tipo": "wfs",
       "rotulo": "GeoSampa",
       "url": "https://wfs.geosampa.prefeitura.sp.gov.br/geoserver/ows",
       "typeName": "geoportal:equipamento_educacao_ceu",
       "campos": { "nome": "nm_equipamento", "endereco": "tx_endereco_equipamento" }
     }]
   }
   ```

   Uma base pode juntar várias fontes (ex.: GeoSampa na cidade de São Paulo e CNES no resto). Os tipos de fonte e suas opções estão descritos no começo de `scripts/atualizar_dados.py`.
   Para uma base muito grande, acrescente `"zoom_minimo": 15` para os pontos só aparecerem com o mapa aproximado.

2. Gere os dados: na aba **Actions** do GitHub, rode "Baixar dados" (ou, no seu computador, `python3 scripts/atualizar_dados.py ceu`).

3. Para um tema novo, acrescente-o em `"temas"` com `id`, `nome` e `cor` (todos começam desligados; use `"ligado": true` para um tema já abrir ligado).

## Testar no seu computador

```
cd prototipo
python3 -m http.server 8000
```

Depois abra http://localhost:8000. Abrir o `index.html` direto (duplo clique) não funciona, porque o navegador bloqueia a leitura dos arquivos de dados.

## Publicar no GitHub Pages

1. Crie um repositório público no GitHub chamado `lmapa`.
2. Envie todo o conteúdo desta pasta para a raiz do repositório, incluindo a pasta oculta `.github`.
3. No repositório: **Settings → Pages → Build and deployment → Source: Deploy from a branch**, escolha a branch `main` e a pasta `/ (root)`, e salve.
4. Em um ou dois minutos o site fica em `https://SEU-USUARIO.github.io/lmapa/`.
5. Baixe os dados uma vez: **Settings → Actions → General → Workflow permissions → Read and write permissions** e salve. Depois, na aba **Actions**, abra "Baixar dados" e clique em **Run workflow**. Com o Brasil inteiro leva de 1 a 3 horas (os boletins de urna dos 27 estados são grandes). Depois os arquivos de `data/` são criados e o site passa a mostrar todas as bases. Para atualizar os dados no futuro, basta rodar de novo.

## Limitações conhecidas

- A localização por GPS só funciona em HTTPS (o GitHub Pages já usa) e depende da permissão do navegador.
- O traçado pelas ruas usa o servidor público de rotas do projeto FOSSGIS (routing.openstreetmap.de), que é gratuito e sem garantia de disponibilidade. Quando não responde, a rota aparece em linha reta e o tempo é estimado a 4,8 km/h.
- O GeoSampa não tem os CRAS como pontos (só as áreas de abrangência), por isso eles ficaram de fora.
- A busca pelo nome procura nos locais já carregados (a área que você já viu no mapa). Para achar algo em outra cidade, aproxime o mapa dela antes.
- Locais de votação sem coordenadas no cadastro do TSE ficam de fora do destaque eleitoral.
- Links de rota criados antes desta versão podem não abrir todas as paradas, porque os blocos das bases grandes mudaram de tamanho.
- Bases grandes (divididas em blocos) só aparecem a partir do zoom 9, para o site não baixar o país inteiro de uma vez.
- Os nomes das ruas da rota vêm do serviço de rotas; quando ele não responde, a rota sai em linha reta e sem nomes.
