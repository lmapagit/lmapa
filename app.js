/* Mapa de Infraestrutura
 * Lê camadas.json, carrega os pontos de cada base conforme a área visível e monta
 * filtros, "perto de mim", rota com pontos de interesse, exportação da rota como
 * imagem e o destaque opcional de locais perto de seções eleitorais.
 * Para incluir uma nova base: adicione uma entrada em camadas.json e rode "Baixar dados".
 */
(() => {
  'use strict';

  // Mapas de fundo, em ordem de preferência; se um não carregar, o próximo é usado.
  // (O CARTO saiu da lista: ele passou a devolver uma imagem "api key required".)
  const ESRI = 'https://server.arcgisonline.com/ArcGIS/rest/services/';
  const PROVEDORES = [
    {
      nome: 'Esri',
      clara: `${ESRI}World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
      escura: `${ESRI}Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}`,
      imagem: `${ESRI}World_Street_Map/MapServer/tile/{z}/{y}/{x}`,
      opcoes: { maxZoom: 19, maxNativeZoom: 18 },
      credito: 'Mapa base © <a href="https://www.esri.com">Esri</a>, HERE, Garmin, © OpenStreetMap',
      creditoTexto: 'Mapa base © Esri, HERE, Garmin, OpenStreetMap',
    },
    {
      nome: 'OpenStreetMap',
      clara: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      escura: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      imagem: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      opcoes: { maxZoom: 19 },
      credito: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      creditoTexto: 'Mapa base © OpenStreetMap',
    },
  ];
  const ROTEADOR_A_PE = 'https://routing.openstreetmap.de/routed-foot/route/v1/foot/';
  const VELOCIDADE_A_PE_KMH = 4.8;
  const CHAVE_ROTA = 'lmapa:rota';
  // No celular o dedo cobre o ponto: área de toque maior e pontos um pouco maiores
  const TOQUE = matchMedia('(pointer: coarse)').matches;
  const RAIO_PONTO = TOQUE ? 7 : 6;

  const estado = {
    config: null,
    temas: new Map(),        // id -> {id, nome, cor}
    camadas: [],             // configs das camadas (com o índice de cada uma)
    grupos: new Map(),       // id da camada -> L.layerGroup
    pontos: new Map(),       // id do ponto -> ponto
    temasAtivos: new Set(),
    camadasAtivas: new Set(),
    rota: [],                // ids de pontos, em ordem
    tracado: null,           // {coords:[[lat,lng]], distancia, duracao, ruas:boolean}
    voce: null,
    marcando: false,
    semRuas: false,
    provedor: 0,
  };

  const $ = (id) => document.getElementById(id);
  const el = (tag, attrs = {}, ...filhos) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') n.className = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) n.setAttribute(k, v);
    }
    for (const f of filhos) if (f != null) n.append(f);
    return n;
  };
  const normalizar = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const temaEscuro = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  };
  const formatarDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`);
  const formatarTempo = (s) => {
    const min = Math.max(1, Math.round(s / 60));
    return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
  };
  const armazenar = {
    ler(k) { try { return localStorage.getItem(k); } catch { return null; } },
    gravar(k, v) { try { localStorage.setItem(k, v); } catch { /* sem armazenamento */ } },
  };

  // ---------- Mapa ----------
  const mapa = L.map('mapa', {
    preferCanvas: true,
    renderer: L.canvas({ tolerance: TOQUE ? 14 : 4, padding: 0.3 }),
    zoomControl: true,
    attributionControl: true,
  });
  let base = null;
  let municipios = null;

  function criarBase() {
    if (base) mapa.removeLayer(base);
    if (estado.semRuas) return;
    const prov = PROVEDORES[estado.provedor];
    const camada = L.tileLayer(temaEscuro() ? prov.escura : prov.clara, {
      ...prov.opcoes,
      crossOrigin: 'anonymous',
      attribution: prov.credito,
    }).addTo(mapa);
    base = camada;
    let carregados = 0;
    let erros = 0;
    const desistir = () => {
      if (base !== camada || carregados) return;
      if (estado.provedor < PROVEDORES.length - 1) { estado.provedor++; criarBase(); } else usarFundoSemRuas();
    };
    camada.on('tileload', () => { carregados++; });
    camada.on('tileerror', () => { erros++; if (erros >= 4) desistir(); });
    setTimeout(() => { if (erros) desistir(); }, 5000);
  }

  async function carregarMunicipios() {
    if (municipios) return municipios;
    const r = await fetch('data/municipios.geojson');
    municipios = await r.json();
    return municipios;
  }

  // Quando os blocos do mapa de ruas não carregam (sem internet ou ambiente bloqueado),
  // desenha os limites municipais do estado como fundo.
  async function usarFundoSemRuas() {
    estado.semRuas = true;
    if (base) { mapa.removeLayer(base); base = null; }
    mostrarFaixa('O mapa de ruas não carregou aqui. Mostrando os limites dos municípios como fundo.');
    try {
      const geo = await carregarMunicipios();
      const css = getComputedStyle(document.documentElement);
      L.geoJSON(geo, {
        interactive: false,
        style: () => ({ color: css.getPropertyValue('--tinta-suave').trim(), weight: 0.8, opacity: 0.6, fillColor: css.getPropertyValue('--superficie').trim(), fillOpacity: 0.9 }),
      }).addTo(mapa).bringToBack();
      mapa.attributionControl.addAttribution('Limites: IBGE');
    } catch { /* segue só com os pontos */ }
  }

  function mostrarFaixa(texto) {
    const f = $('faixa');
    f.textContent = texto;
    f.hidden = false;
    clearTimeout(mostrarFaixa.t);
    mostrarFaixa.t = setTimeout(() => { f.hidden = true; }, 9000);
  }

  // ---------- Dados ----------
  // Cada base é uma pasta com indice.json e os pontos: num arquivo só (todos.json) ou,
  // nas bases grandes, em blocos de meio grau. Só os blocos da área na tela são baixados.
  async function lerJSON(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
    return r.json();
  }

  async function iniciar() {
    const config = await lerJSON('camadas.json');
    estado.config = config;
    $('titulo').textContent = config.titulo;
    mapa.setView(config.centro_inicial, config.zoom_inicial);
    criarBase();
    // Um tema pode começar desligado ("ligado": false em camadas.json), como Religião, que é muito denso
    config.temas.forEach((t) => { estado.temas.set(t.id, t); if (t.ligado !== false) estado.temasAtivos.add(t.id); });

    // Uma base cujo índice ainda não existe (ex.: antes da primeira atualização) aparece como pendente
    const indices = await Promise.all(config.camadas.map((c) => lerJSON(`${c.pasta}/indice.json`).catch((erro) => {
      console.warn('Base não carregada', erro);
      return null;
    })));
    config.camadas.forEach((c, i) => prepararCamada(c, indices[i]));
    mapa.on('moveend', atualizarVisibilidade);
    desenharTemas();
    desenharCamadas();
    prepararEleitoral();
    await atualizarVisibilidade();
    await restaurarRota();
    const total = estado.camadas.reduce((s, c) => s + c._qtd, 0);
    $('resumo').textContent = `${total.toLocaleString('pt-BR')} locais em ${estado.camadas.length} bases`;
  }

  function prepararCamada(c, indice) {
    c._indice = indice;
    c._qtd = indice?.total || 0;
    c._atualizado = indice?.atualizado_em;
    c._pendente = !indice;
    c._blocos = new Map();   // bloco -> Promise do download
    estado.camadas.push(c);
    estado.grupos.set(c.id, L.layerGroup());
    estado.camadasAtivas.add(c.id);
  }

  // Blocos da camada que cruzam a área (padrão: a tela, com folga)
  function blocosDaArea(c, area) {
    const g = c._indice?.bloco_graus;
    if (!c._indice) return [];
    if (!g) return ['todos'];
    const a = area || mapa.getBounds().pad(0.25);
    const lista = [];
    for (let x = Math.floor(a.getWest() / g); x <= Math.floor(a.getEast() / g); x++) {
      for (let y = Math.floor(a.getSouth() / g); y <= Math.floor(a.getNorth() / g); y++) {
        const chave = `${x}_${y}`;
        if (c._indice.blocos[chave]) lista.push(chave);
      }
    }
    return lista;
  }

  function carregarBloco(c, chave) {
    if (!c._blocos.has(chave)) {
      c._blocos.set(chave, lerJSON(`${c.pasta}/${chave}.json`)
        .then((geo) => adicionarPontos(c, geo))
        .catch((erro) => { console.warn('Bloco não carregado', erro); c._blocos.delete(chave); }));
    }
    return c._blocos.get(chave);
  }

  function adicionarPontos(c, geo) {
    const tema = estado.temas.get(c.tema);
    const cor = c.cor || tema?.cor || '#555';
    const grupo = estado.grupos.get(c.id);
    for (const f of geo?.features || []) {
      if (!f.geometry || f.geometry.type !== 'Point' || estado.pontos.has(f.properties.id)) continue;
      const [lng, lat] = f.geometry.coordinates;
      const p = {
        id: f.properties.id,
        nome: f.properties.nome || 'Sem nome',
        props: f.properties,
        camada: c,
        tema,
        cor,
        latlng: L.latLng(lat, lng),
      };
      p.marcador = L.circleMarker(p.latlng, estiloPonto(p))
        .bindPopup(() => conteudoPopup(p), { maxWidth: 300 });
      // No celular o rótulo flutuante atrapalha o toque; o nome aparece no balão
      if (!TOQUE) p.marcador.bindTooltip(p.nome, { direction: 'top', offset: [0, -6] });
      p.marcador.addTo(grupo);
      estado.pontos.set(p.id, p);
    }
  }

  const estiloBase = (p) => ({ radius: RAIO_PONTO, color: '#ffffff', weight: 1.5, opacity: 1, fillColor: p.cor, fillOpacity: 0.95 });

  // Garante que os pontos de uma lista de ids estejam carregados (ex.: rota vinda de um link)
  async function carregarIds(ids) {
    const pendentes = [];
    for (const id of ids) {
      const [camadaId, meio] = id.split('.');
      const c = estado.camadas.find((x) => x.id === camadaId);
      if (!c?._indice) continue;
      const chave = c._indice.bloco_graus ? meio : 'todos';
      if (c._indice.blocos[chave]) pendentes.push(carregarBloco(c, chave));
    }
    await Promise.all(pendentes);
  }

  function conteudoPopup(p) {
    const campos = el('dl', { class: 'popup-campos' });
    for (const { campo, rotulo } of p.camada.campos_popup || []) {
      const v = p.props[campo];
      if (!v) continue;
      campos.append(el('dt', {}, rotulo), el('dd', {}, String(v)));
    }
    const naRota = estado.rota.includes(p.id);
    const botao = el('button', {
      class: `botao ${naRota ? '' : 'primario'}`, type: 'button',
      onclick: () => { naRota ? removerDaRota(p.id) : adicionarNaRota(p.id); mapa.closePopup(); },
    }, naRota ? 'Remover da rota' : 'Adicionar à rota');
    const data = p.camada._atualizado ? ` · dados de ${p.camada._atualizado.split('-').reverse().join('/')}` : '';
    return el('div', { style: `--cor:${p.cor}` },
      el('span', { class: 'popup-tema' }, p.tema?.nome || p.camada.nome),
      el('p', { class: 'popup-nome' }, p.nome),
      campos.childElementCount ? campos : null,
      blocoEleitoral(p),
      botao,
      el('p', { class: 'popup-fonte' }, `${p.camada.nome} · ${p.props.fonte || ''}${data}`),
    );
  }

  // ---------- Filtros ----------
  function desenharTemas() {
    const caixa = $('temas');
    caixa.replaceChildren();
    for (const t of estado.temas.values()) {
      const camadas = estado.camadas.filter((c) => c.tema === t.id);
      const qtd = camadas.reduce((s, c) => s + c._qtd, 0);
      const ativo = estado.temasAtivos.has(t.id);
      caixa.append(el('button', {
        class: 'tema', type: 'button', style: `--cor:${t.cor}`,
        'aria-pressed': String(ativo && qtd > 0),
        disabled: qtd ? false : 'disabled',
        title: qtd ? `Mostrar ou ocultar ${t.nome}` : 'Nenhuma base deste tema foi adicionada ainda',
        onclick: () => {
          ativo ? estado.temasAtivos.delete(t.id) : estado.temasAtivos.add(t.id);
          desenharTemas();
          desenharCamadas();
          atualizarVisibilidade();
        },
      }, el('span', { class: 'ponto' }), t.nome, el('span', { class: 'qtd' }, qtd ? String(qtd) : 'em breve')));
    }
  }

  // Botão que marca ou desmarca todas as bases de uma vez
  // A lista de bases mostra só as dos temas ligados; o botão age sobre elas
  const camadasListadas = () => estado.camadas.filter((c) => estado.temasAtivos.has(c.tema));

  function desenharBotaoTodas() {
    const listadas = camadasListadas();
    const todas = listadas.every((c) => estado.camadasAtivas.has(c.id));
    const btn = $('btn-todas');
    btn.hidden = !listadas.length;
    btn.textContent = todas ? 'Desmarcar todas' : 'Marcar todas';
    btn.setAttribute('aria-pressed', String(todas));
  }

  $('btn-todas').addEventListener('click', () => {
    const listadas = camadasListadas();
    const todas = listadas.every((c) => estado.camadasAtivas.has(c.id));
    listadas.forEach((c) => (todas ? estado.camadasAtivas.delete(c.id) : estado.camadasAtivas.add(c.id)));
    desenharCamadas();
    atualizarVisibilidade();
  });

  function desenharCamadas() {
    desenharBotaoTodas();
    const lista = $('camadas');
    lista.replaceChildren();
    if (!camadasListadas().length) lista.append(el('li', { class: 'aviso' }, 'Ligue um tema acima para ver as bases dele.'));
    for (const c of camadasListadas()) {
      const id = `camada-${c.id}`;
      const data = c._atualizado ? ` · atualizado em ${c._atualizado.split('-').reverse().join('/')}` : '';
      const qtd = c._pendente ? 'aguardando a primeira atualização' : `${c._qtd.toLocaleString('pt-BR')} locais`;
      const zoom = c.zoom_minimo ? ' · aparece ao aproximar o mapa' : '';
      const cobertura = c.cobertura ? `${c.cobertura} · ` : '';
      const creditos = (c.creditos || []).flatMap((f, i) => [i ? ', ' : '',
        f.url ? el('a', { href: f.url, target: '_blank', rel: 'noopener' }, f.nome) : f.nome]);
      lista.append(el('li', { class: 'camada', style: `--cor:${estado.temas.get(c.tema)?.cor}` },
        el('input', {
          type: 'checkbox', id, checked: estado.camadasAtivas.has(c.id) ? 'checked' : false,
          onchange: (e) => { e.target.checked ? estado.camadasAtivas.add(c.id) : estado.camadasAtivas.delete(c.id); desenharBotaoTodas(); atualizarVisibilidade(); },
        }),
        el('label', { for: id }, c.nome),
        el('span', { class: 'meta' }, `${cobertura}${qtd}${data}${zoom} · `, ...creditos),
      ));
    }
  }

  const visivel = (p) => estado.camadasAtivas.has(p.camada.id) && estado.temasAtivos.has(p.camada.tema);

  async function atualizarVisibilidade() {
    const downloads = [];
    for (const c of estado.camadas) {
      const grupo = estado.grupos.get(c.id);
      const mostrar = estado.camadasAtivas.has(c.id) && estado.temasAtivos.has(c.tema)
        && mapa.getZoom() >= (c.zoom_minimo || 0);
      if (mostrar) for (const chave of blocosDaArea(c)) downloads.push(carregarBloco(c, chave));
      if (mostrar && !mapa.hasLayer(grupo)) grupo.addTo(mapa);
      if (!mostrar && mapa.hasLayer(grupo)) mapa.removeLayer(grupo);
    }
    if (downloads.length) {
      $('carregando').hidden = false;
      await Promise.all(downloads);
      $('carregando').hidden = true;
    }
    aplicarEleitoral();
    desenharPerto();
  }

  // ---------- Destaque eleitoral ----------
  // Destaca os locais do mapa que ficam perto de locais de votação com muitos eleitores
  // que não votaram em nenhum dos dois principais candidatos (abstenções, brancos, nulos
  // e votos nos demais candidatos). Liga e desliga no painel; os dados vêm do TSE.
  const COR_DESTAQUE = '#ff7a1a';
  const COR_ABRIGA = '#111827';
  const eleitoral = {
    ligado: false,
    dados: null,          // {metadata, locais:[...]}
    pedido: null,
    grade: new Map(),     // célula de 0,01° -> locais de votação
    medida: 'abs',
    corte: 20,
    raio: 500,
    comparar: 'estado',
    mostrarLocais: 'destacados',   // destacados | todos | nenhum
    esconder: false,
  };
  mapa.createPane('eleitoral').style.zIndex = 390;   // abaixo dos pontos das bases
  const camadaLocais = L.layerGroup();
  const rendLocais = L.canvas({ pane: 'eleitoral' });
  // Locais de votação são só referência: quadradinhos sem clique, para não se confundirem
  // com os pontos das bases (círculos clicáveis)
  const Quadrado = L.CircleMarker.extend({
    _updatePath() {
      const r = this._renderer;
      if (!r._drawing || this._empty()) return;
      const p = this._point, t = this._radius, ctx = r._ctx;
      ctx.beginPath();
      ctx.rect(p.x - t, p.y - t, t * 2, t * 2);
      r._fillStroke(ctx, this);
    },
  });

  // Palavras comuns em nomes de escolas e prédios, ignoradas ao comparar nomes
  const PALAVRAS_COMUNS = new Set(('escola estadual municipal emef emei emeb ee e.e eeb cemei cei creche prof professor professora '
    + 'profa dr doutor dona de da do das dos e colegio centro educacional educacao infantil fundamental medio ensino unidade '
    + 'basica ubs etec fatec faculdade universidade instituto igreja paroquia').split(' '));
  const palavras = (texto) => new Set(normalizar(texto || '').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !PALAVRAS_COMUNS.has(w)));
  function nomesParecidos(a, b) {
    let comuns = 0;
    for (const w of a) if (b.has(w)) comuns++;
    return comuns >= 2 || (comuns === 1 && Math.min(a.size, b.size) === 1);
  }
  const fmtN = (n) => Math.round(n).toLocaleString('pt-BR');
  const fmtPct = (x) => `${(x * 100).toFixed(0)}%`;
  const celula = (lat, lng) => `${Math.floor(lat * 100)}_${Math.floor(lng * 100)}`;

  function nomesCandidatos() {
    const c = eleitoral.dados?.metadata?.candidatos || [];
    return [c[0]?.nome || 'candidato 1', c[1]?.nome || 'candidato 2'];
  }

  function prepararEleitoral() {
    const cfg = estado.config.eleitoral;
    $('caixa-eleitoral').hidden = !cfg;
    if (!cfg) return;
    const ligar = $('eleitoral-ligar');
    ligar.addEventListener('change', async () => {
      eleitoral.ligado = ligar.checked;
      $('eleitoral-opcoes').hidden = !ligar.checked;
      if (ligar.checked && !eleitoral.dados) {
        $('eleitoral-resumo').textContent = 'Carregando os dados eleitorais…';
        try { await carregarEleitoral(); } catch (erro) {
          console.warn(erro);
          $('eleitoral-resumo').textContent = 'Os dados eleitorais ainda não foram baixados. Rode "Baixar dados" no GitHub.';
          return;
        }
      }
      recalcularEleitoral();
    });
    const ligarSelect = (id, campo, conv = (v) => v) => $(id).addEventListener('change', (e) => { eleitoral[campo] = conv(e.target.value); recalcularEleitoral(); });
    ligarSelect('eleitoral-medida', 'medida');
    ligarSelect('eleitoral-corte', 'corte', Number);
    ligarSelect('eleitoral-raio', 'raio', Number);
    ligarSelect('eleitoral-comparar', 'comparar');
    $('eleitoral-locais').addEventListener('change', (e) => { eleitoral.mostrarLocais = e.target.value; recalcularEleitoral(); });
    $('eleitoral-esconder').addEventListener('change', (e) => { eleitoral.esconder = e.target.checked; recalcularEleitoral(); });
  }

  async function carregarEleitoral() {
    eleitoral.pedido ||= lerJSON(estado.config.eleitoral.arquivo);
    const bruto = await eleitoral.pedido;
    const ix = Object.fromEntries(bruto.campos.map((c, i) => [c, i]));
    const locais = bruto.locais.map((r) => {
      const l = {};
      for (const [c, i] of Object.entries(ix)) l[c] = r[i];
      l.fora = Math.max(l.aptos - l.c1 - l.c2, 0);
      l.pct = l.aptos ? l.fora / l.aptos : 0;
      l.latlng = L.latLng(l.lat, l.lng);
      return l;
    });
    for (const l of locais) {
      const k = celula(l.lat, l.lng);
      if (!eleitoral.grade.has(k)) eleitoral.grade.set(k, []);
      eleitoral.grade.get(k).push(l);
    }
    eleitoral.dados = { metadata: bruto.metadata, locais };
    const [a, b] = nomesCandidatos();
    $('eleitoral-explica').textContent = `Conta, em cada local de votação, quem não votou em ${a} nem em ${b}: abstenções, votos brancos, nulos e votos nos demais candidatos. ${bruto.metadata.eleicao}.`;
  }

  // Marca como "destacados" os locais de votação no topo da medida escolhida
  function marcarDestacados() {
    const valor = (l) => (eleitoral.medida === 'abs' ? l.fora : (l.aptos >= 100 ? l.pct : -1));
    const grupos = new Map();
    for (const l of eleitoral.dados.locais) {
      l.destacado = false;
      const g = eleitoral.comparar === 'municipio' ? l.municipio : '';
      if (!grupos.has(g)) grupos.set(g, []);
      grupos.get(g).push(l);
    }
    let total = 0;
    for (const lista of grupos.values()) {
      const validos = lista.filter((l) => valor(l) >= 0).sort((x, y) => valor(y) - valor(x));
      const n = Math.ceil((validos.length * eleitoral.corte) / 100);
      validos.slice(0, n).forEach((l) => { l.destacado = true; });
      total += n;
    }
    return total;
  }

  // Local de votação mais próximo (até 2 km), destacado mais próximo dentro do raio e
  // o local de votação que funciona no próprio ponto (muito perto, ou perto e com nome parecido)
  function vizinhosEleitorais(p) {
    const latlng = p.latlng;
    p._palavras ||= palavras(p.nome);
    let abriga = null, dAbriga = Infinity;
    const alcance = 2000;
    const passos = Math.ceil(alcance / 1100) + 1;
    const cy = Math.floor(latlng.lat * 100), cx = Math.floor(latlng.lng * 100);
    let perto = null, dPerto = Infinity, quente = null, dQuente = Infinity;
    for (let y = cy - passos; y <= cy + passos; y++) {
      for (let x = cx - passos; x <= cx + passos; x++) {
        for (const l of eleitoral.grade.get(`${y}_${x}`) || []) {
          const d = latlng.distanceTo(l.latlng);
          if (d < dPerto && d <= alcance) { perto = l; dPerto = d; }
          if (l.destacado && d < dQuente && d <= eleitoral.raio) { quente = l; dQuente = d; }
          if (d < dAbriga && (d <= 25 || (d <= 200 && nomesParecidos(p._palavras, l._palavras ||= palavras(l.nome))))) { abriga = l; dAbriga = d; }
        }
      }
    }
    return { perto, dPerto, quente, dQuente, abriga };
  }

  function estiloPonto(p) {
    if (!eleitoral.ligado || !eleitoral.dados || !p._eleitoral) return estiloBase(p);
    const { abriga } = p._eleitoral;
    // Destaque especial: o próprio local abriga seções eleitorais
    if (abriga) return { radius: RAIO_PONTO + 4, color: abriga.destacado ? COR_DESTAQUE : COR_ABRIGA, weight: 5, opacity: 1, fillColor: p.cor, fillOpacity: 1 };
    if (p._eleitoral.quente) return { radius: RAIO_PONTO + 2, color: COR_DESTAQUE, weight: 4, opacity: 1, fillColor: p.cor, fillOpacity: 1 };
    return { radius: RAIO_PONTO - 1, color: '#ffffff', weight: 1, opacity: 0.35, fillColor: p.cor, fillOpacity: 0.25 };
  }

  function recalcularEleitoral() {
    const ativo = eleitoral.ligado && eleitoral.dados;
    if (ativo) eleitoral.destacados = marcarDestacados();
    for (const p of estado.pontos.values()) if (p._eleitoral) p._eleitoral = null;
    camadaLocais.clearLayers();
    if (ativo && eleitoral.mostrarLocais !== 'nenhum') {
      const cinza = getComputedStyle(document.documentElement).getPropertyValue('--tinta-suave').trim();
      for (const l of eleitoral.dados.locais) {
        if (!l.destacado && eleitoral.mostrarLocais === 'destacados') continue;
        new Quadrado(l.latlng, {
          renderer: rendLocais, interactive: false, radius: 3.5, weight: 1.2,
          color: l.destacado ? COR_DESTAQUE : cinza, opacity: 0.75,
          fill: l.destacado, fillColor: COR_DESTAQUE, fillOpacity: 0.3,
        }).addTo(camadaLocais);
      }
      camadaLocais.addTo(mapa);
    } else if (mapa.hasLayer(camadaLocais)) mapa.removeLayer(camadaLocais);
    aplicarEleitoral();
  }

  let eleitoralAplicado = false;
  function aplicarEleitoral() {
    const ativo = eleitoral.ligado && eleitoral.dados;
    if (!ativo && !eleitoralAplicado) return;
    eleitoralAplicado = Boolean(ativo);
    let perto = 0, abrigam = 0;
    for (const p of estado.pontos.values()) {
      const grupo = estado.grupos.get(p.camada.id);
      if (!ativo) {
        if (p._eleitoral !== undefined) { p._eleitoral = undefined; p.marcador.setStyle(estiloBase(p)); }
        if (!grupo.hasLayer(p.marcador)) grupo.addLayer(p.marcador);
        continue;
      }
      if (!p._eleitoral) p._eleitoral = vizinhosEleitorais(p);
      p.marcador.setStyle(estiloPonto(p));
      const mostrar = !eleitoral.esconder || p._eleitoral.quente || p._eleitoral.abriga;
      if (mostrar && !grupo.hasLayer(p.marcador)) grupo.addLayer(p.marcador);
      if (!mostrar && grupo.hasLayer(p.marcador)) grupo.removeLayer(p.marcador);
      if (p._eleitoral.quente || p._eleitoral.abriga) {
        if (visivel(p) && mapa.hasLayer(grupo)) p.marcador.bringToFront();
        if (visivel(p) && p._eleitoral.quente) perto++;
        if (visivel(p) && p._eleitoral.abriga) abrigam++;
      }
    }
    if (!ativo) return;
    const base = eleitoral.comparar === 'municipio' ? 'em cada município' : 'no estado';
    const simulado = eleitoral.dados.metadata.simulado ? ' Atenção: dados simulados, só para testar o funcionamento.' : '';
    $('eleitoral-resumo').textContent = `${fmtN(eleitoral.destacados)} locais de votação destacados (os ${eleitoral.corte}% mais altos ${base}). `
      + `${fmtN(perto)} locais das bases ligadas, já carregados no mapa, ficam a até ${formatarDist(eleitoral.raio)} de um deles, `
      + `e ${fmtN(abrigam)} abrigam seções eleitorais.${simulado}`;
  }

  function linhaFora(l) {
    const [a, b] = nomesCandidatos();
    return `${fmtN(l.fora)} de ${fmtN(l.aptos)} eleitores (${fmtPct(l.pct)}) não votaram em ${a} nem em ${b}`;
  }

  function detalhesLocal(l) {
    const [a, b] = nomesCandidatos();
    const campos = el('dl', { class: 'popup-campos' });
    const linhas = [['Eleitores aptos', fmtN(l.aptos)], ['Abstenções', fmtN(l.abstencoes)], ['Brancos', fmtN(l.brancos)],
      ['Nulos', fmtN(l.nulos)], ['Demais candidatos', fmtN(l.outros)], [a, fmtN(l.c1)], [b, fmtN(l.c2)]];
    for (const [r, v] of linhas) campos.append(el('dt', {}, r), el('dd', {}, String(v)));
    return campos;
  }

  function blocoEleitoral(p) {
    if (!eleitoral.ligado || !eleitoral.dados) return null;
    const v = p._eleitoral || vizinhosEleitorais(p);
    if (v.abriga) {
      const l = v.abriga;
      return el('div', { class: 'popup-eleitoral' },
        el('strong', { class: `selo-destaque ${l.destacado ? '' : 'selo-abriga'}` },
          l.destacado ? 'Abriga um local de votação destacado' : 'Abriga seções eleitorais'),
        el('span', {}, `Local de votação: ${l.nome}. ${linhaFora(l)}.`),
        detalhesLocal(l));
    }
    if (!v.perto) return el('p', { class: 'popup-eleitoral' }, 'Nenhum local de votação a até 2 km.');
    return el('div', { class: 'popup-eleitoral' },
      v.quente ? el('strong', { class: 'selo-destaque' }, `A ${formatarDist(v.dQuente)} de um local de votação destacado`) : null,
      el('span', {}, `Local de votação mais próximo: ${v.perto.nome}, a ${formatarDist(v.dPerto)}. ${linhaFora(v.perto)}.`));
  }


  // ---------- Busca ----------
  $('busca').addEventListener('input', (e) => {
    const termo = normalizar(e.target.value.trim());
    const caixa = $('resultados-busca');
    caixa.replaceChildren();
    if (termo.length < 2) { caixa.hidden = true; return; }
    const achados = [...estado.pontos.values()].filter((p) => normalizar(p.nome).includes(termo)).slice(0, 15);
    caixa.hidden = false;
    if (!achados.length) { caixa.append(el('li', { class: 'aviso', style: 'padding:8px 10px' }, 'Nada encontrado na área já carregada. Aproxime o mapa da região e busque de novo.')); return; }
    for (const p of achados) {
      caixa.append(el('li', {}, el('button', { type: 'button', onclick: () => focar(p) },
        el('span', { class: 'ponto', style: `--cor:${p.cor}` }),
        el('span', {}, p.nome, el('small', { style: 'display:block;color:var(--tinta-suave)' }, p.camada.nome)))));
    }
  });

  async function focar(p) {
    if (!visivel(p)) {
      estado.camadasAtivas.add(p.camada.id);
      estado.temasAtivos.add(p.camada.tema);
      desenharTemas(); desenharCamadas();
    }
    mapa.setView(p.latlng, Math.max(mapa.getZoom(), 15, p.camada.zoom_minimo || 0));
    await atualizarVisibilidade();
    p.marcador.openPopup();
  }

  // ---------- Perto de mim ----------
  let marcadorVoce = null;
  let raioVoce = null;

  function definirVoce(latlng, origem) {
    estado.voce = latlng;
    if (!marcadorVoce) {
      marcadorVoce = L.marker(latlng, { icon: L.divIcon({ className: 'marcador-voce', iconSize: [18, 18] }), keyboard: false, title: 'Você está aqui' }).addTo(mapa);
      raioVoce = L.circle(latlng, { radius: 1000, color: getComputedStyle(document.documentElement).getPropertyValue('--foco').trim(), weight: 1, fillOpacity: 0.06, interactive: false }).addTo(mapa);
    } else {
      marcadorVoce.setLatLng(latlng);
      raioVoce.setLatLng(latlng);
    }
    mapa.setView(latlng, Math.max(mapa.getZoom(), 14));
    $('aviso-local').textContent = origem === 'gps'
      ? 'Sua localização. O círculo marca 1 km.'
      : 'Ponto marcado no mapa. O círculo marca 1 km. Clique em outro lugar para mudar.';
    desenharPerto();
  }

  $('btn-localizar').addEventListener('click', () => {
    if (!('geolocation' in navigator)) { falhaLocal(); return; }
    $('aviso-local').textContent = 'Procurando sua localização…';
    navigator.geolocation.getCurrentPosition(
      (pos) => definirVoce(L.latLng(pos.coords.latitude, pos.coords.longitude), 'gps'),
      falhaLocal,
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 60000 },
    );
  });
  function falhaLocal() {
    $('aviso-local').textContent = 'Não foi possível obter sua localização. Toque em “Marcar no mapa” e depois no lugar onde você está.';
  }

  $('btn-marcar').addEventListener('click', () => alternarMarcacao(!estado.marcando));
  function alternarMarcacao(ligar) {
    estado.marcando = ligar;
    $('btn-marcar').setAttribute('aria-pressed', String(ligar));
    mapa.getContainer().style.cursor = ligar ? 'crosshair' : '';
    if (ligar) mostrarFaixa('Toque no mapa para marcar onde você está.');
  }
  mapa.on('click', (e) => {
    if (!estado.marcando) return;
    alternarMarcacao(false);
    $('faixa').hidden = true;
    definirVoce(e.latlng, 'mapa');
  });

  function desenharPerto() {
    const lista = $('lista-perto');
    lista.replaceChildren();
    if (!estado.voce) return;
    const perto = [...estado.pontos.values()]
      .filter(visivel)
      .map((p) => ({ p, d: estado.voce.distanceTo(p.latlng) }))
      .sort((a, b) => a.d - b.d)
      .slice(0, 12);
    for (const { p, d } of perto) {
      const naRota = estado.rota.includes(p.id);
      lista.append(el('li', {},
        el('span', { class: 'ponto', style: `--cor:${p.cor}` }),
        el('button', { class: 'nome-local', type: 'button', onclick: () => focar(p) }, p.nome, el('small', {}, `${formatarDist(d)} · ${p.camada.nome}`)),
        el('button', {
          class: 'mini', type: 'button', disabled: naRota ? 'disabled' : false,
          title: naRota ? 'Já está na rota' : 'Adicionar à rota', 'aria-label': `Adicionar ${p.nome} à rota`,
          onclick: () => adicionarNaRota(p.id),
        }, naRota ? '✓' : '+'),
      ));
    }
  }

  // ---------- Rota ----------
  const camadaRota = L.layerGroup().addTo(mapa);

  function adicionarNaRota(id) {
    if (estado.rota.includes(id)) return;
    estado.rota.push(id);
    rotaMudou();
    mostrarFaixa(`Adicionado à rota (${estado.rota.length} ${estado.rota.length === 1 ? 'parada' : 'paradas'}).`);
  }
  function removerDaRota(id) {
    estado.rota = estado.rota.filter((x) => x !== id);
    rotaMudou();
  }
  function mover(i, delta) {
    const j = i + delta;
    if (j < 0 || j >= estado.rota.length) return;
    [estado.rota[i], estado.rota[j]] = [estado.rota[j], estado.rota[i]];
    rotaMudou();
  }

  function rotaMudou() {
    estado.tracado = null;
    salvarRota();
    desenharRota();
    desenharPerto();
    tracarRota();
  }

  function pontosDaRota() { return estado.rota.map((id) => estado.pontos.get(id)).filter(Boolean); }

  function desenharRota() {
    const pts = pontosDaRota();
    $('contador-rota').textContent = String(pts.length);
    const lista = $('lista-rota');
    lista.replaceChildren();
    pts.forEach((p, i) => {
      lista.append(el('li', {},
        el('span', { class: 'numero', style: `--cor:${p.cor}` }, String(i + 1)),
        el('button', { class: 'nome-local', type: 'button', onclick: () => focar(p) }, p.nome, el('small', {}, p.camada.nome)),
        el('span', { class: 'botoes-linha' },
          el('button', { class: 'mini', type: 'button', 'aria-label': 'Subir', title: 'Subir', disabled: i === 0 ? 'disabled' : false, onclick: () => mover(i, -1) }, '↑'),
          el('button', { class: 'mini', type: 'button', 'aria-label': 'Descer', title: 'Descer', disabled: i === pts.length - 1 ? 'disabled' : false, onclick: () => mover(i, 1) }, '↓'),
          el('button', { class: 'mini', type: 'button', 'aria-label': `Remover ${p.nome}`, title: 'Remover', onclick: () => removerDaRota(p.id) }, '×')),
      ));
    });
    $('aviso-rota').hidden = pts.length > 0;
    for (const id of ['btn-otimizar', 'btn-imagem', 'btn-compartilhar', 'btn-limpar']) $(id).disabled = pts.length === 0;
    $('btn-otimizar').disabled = pts.length < 3;
    $('previa').hidden = true;

    camadaRota.clearLayers();
    const coords = estado.tracado?.coords || pts.map((p) => p.latlng);
    if (coords.length >= 2) {
      const corRota = getComputedStyle(document.documentElement).getPropertyValue('--rota').trim();
      L.polyline(coords, { color: temaEscuro() ? '#0f141c' : '#ffffff', weight: 9, opacity: 0.9, interactive: false }).addTo(camadaRota);
      L.polyline(coords, { color: corRota, weight: 4.5, dashArray: estado.tracado?.ruas ? null : '2 9', lineCap: 'round', interactive: false }).addTo(camadaRota);
    }
    pts.forEach((p, i) => {
      L.marker(p.latlng, {
        icon: L.divIcon({ className: '', html: `<div class="marcador-numero" style="--cor:${p.cor}">${i + 1}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] }),
        zIndexOffset: 1000, title: p.nome,
      }).on('click', () => p.marcador.openPopup()).addTo(camadaRota);
    });

    const totais = $('totais-rota');
    totais.hidden = pts.length < 2;
    if (pts.length >= 2) {
      const dist = estado.tracado?.distancia ?? distanciaReta(pts);
      const tempo = estado.tracado?.duracao ?? (dist / 1000 / VELOCIDADE_A_PE_KMH) * 3600;
      $('dist-rota').textContent = formatarDist(dist);
      $('modo-rota-texto').textContent = estado.tracado?.ruas ? 'pelas ruas, a pé' : 'em linha reta';
      $('tempo-rota').textContent = `≈ ${formatarTempo(tempo)} a pé`;
    }
  }

  function distanciaReta(pts) {
    let d = 0;
    for (let i = 1; i < pts.length; i++) d += pts[i - 1].latlng.distanceTo(pts[i].latlng);
    return d;
  }

  let controleTracado = null;
  const cacheTracados = new Map();
  async function tracarRota() {
    const pts = pontosDaRota();
    if (controleTracado) controleTracado.abort();
    if (pts.length < 2 || !$('usar-ruas').checked) return;
    const chave = pts.map((p) => p.id).join(',');
    if (cacheTracados.has(chave)) { estado.tracado = cacheTracados.get(chave); desenharRota(); return; }
    const ctrl = new AbortController();
    controleTracado = ctrl;
    const tempoLimite = setTimeout(() => ctrl.abort(), 9000);
    $('status-rota').textContent = 'Calculando o caminho pelas ruas…';
    try {
      const coords = pts.map((p) => `${p.latlng.lng.toFixed(6)},${p.latlng.lat.toFixed(6)}`).join(';');
      const r = await fetch(`${ROTEADOR_A_PE}${coords}?overview=full&geometries=geojson`, { signal: ctrl.signal });
      const json = await r.json();
      if (json.code !== 'Ok') throw new Error(json.code);
      const rota = json.routes[0];
      const tracado = {
        coords: rota.geometry.coordinates.map(([lng, lat]) => [lat, lng]),
        distancia: rota.distance,
        duracao: (rota.distance / 1000 / VELOCIDADE_A_PE_KMH) * 3600,
        ruas: true,
      };
      cacheTracados.set(chave, tracado);
      if (controleTracado === ctrl) { estado.tracado = tracado; desenharRota(); }
      $('status-rota').textContent = '';
    } catch {
      if (controleTracado === ctrl) $('status-rota').textContent = 'O traçado pelas ruas não está disponível agora. A rota aparece em linha reta.';
    } finally {
      clearTimeout(tempoLimite);
    }
  }
  $('usar-ruas').addEventListener('change', () => { estado.tracado = null; $('status-rota').textContent = ''; desenharRota(); tracarRota(); });

  // Ordena pela proximidade: começa no primeiro ponto e vai sempre ao mais próximo.
  $('btn-otimizar').addEventListener('click', () => {
    const pts = pontosDaRota();
    if (pts.length < 3) return;
    const ordem = [pts[0]];
    const resto = pts.slice(1);
    while (resto.length) {
      const ultimo = ordem[ordem.length - 1];
      let melhor = 0;
      resto.forEach((p, i) => { if (ultimo.latlng.distanceTo(p.latlng) < ultimo.latlng.distanceTo(resto[melhor].latlng)) melhor = i; });
      ordem.push(resto.splice(melhor, 1)[0]);
    }
    estado.rota = ordem.map((p) => p.id);
    rotaMudou();
  });

  let limparPendente = null;
  $('btn-limpar').addEventListener('click', (e) => {
    const b = e.currentTarget;
    if (!limparPendente) {
      b.textContent = 'Confirmar: apagar rota';
      limparPendente = setTimeout(() => { b.textContent = 'Limpar'; limparPendente = null; }, 4000);
      return;
    }
    clearTimeout(limparPendente);
    limparPendente = null;
    b.textContent = 'Limpar';
    estado.rota = [];
    rotaMudou();
  });

  function linkDaRota() {
    const url = new URL(location.href);
    url.hash = estado.rota.length ? `rota=${estado.rota.join(',')}` : '';
    return url.toString();
  }
  function salvarRota() {
    armazenar.gravar(CHAVE_ROTA, estado.rota.join(','));
    try { history.replaceState(null, '', linkDaRota()); } catch { /* ambiente sem histórico */ }
  }
  async function restaurarRota() {
    const doLink = decodeURIComponent(location.hash).match(/rota=([^&]+)/);
    const texto = doLink ? doLink[1] : armazenar.ler(CHAVE_ROTA);
    const ids = (texto || '').split(',').filter(Boolean);
    await carregarIds(ids);
    estado.rota = ids.filter((id) => estado.pontos.has(id));
    rotaMudou();
    if (doLink && estado.rota.length) {
      abrirAba('rota');
      mapa.fitBounds(L.latLngBounds(pontosDaRota().map((p) => p.latlng)).pad(0.3));
    }
  }

  $('btn-compartilhar').addEventListener('click', () => {
    const link = linkDaRota();
    const status = $('status-rota');
    const mostrarLink = () => { status.replaceChildren('Copie este link: ', el('input', { type: 'text', value: link, readonly: 'readonly', style: 'width:100%;margin-top:4px', onfocus: (e) => e.target.select() })); };
    if (!navigator.clipboard) { mostrarLink(); return; }
    navigator.clipboard.writeText(link).then(() => { status.textContent = 'Link da rota copiado.'; }, mostrarLink);
  });

  // ---------- Imagem da rota ----------
  $('btn-imagem').addEventListener('click', async () => {
    const status = $('status-rota');
    const pts = pontosDaRota();
    if (!pts.length) return;
    status.textContent = 'Gerando imagem…';
    try {
      const blob = await gerarImagem(pts);
      const nome = `rota-${new Date().toISOString().slice(0, 10)}.png`;
      const url = URL.createObjectURL(blob);
      $('previa-img').src = url;
      $('previa').hidden = false;
      status.textContent = await entregarArquivo(blob, nome, url);
    } catch (erro) {
      console.error(erro);
      status.textContent = 'Não foi possível gerar a imagem. Tente de novo com menos paradas.';
    }
  });

  async function entregarArquivo(blob, nome, url) {
    const arquivo = new File([blob], nome, { type: 'image/png' });
    if (matchMedia('(pointer: coarse)').matches && navigator.canShare && navigator.canShare({ files: [arquivo] })) {
      try { await navigator.share({ files: [arquivo], title: 'Minha rota', text: linkDaRota() }); return 'Imagem compartilhada.'; } catch { /* segue para download */ }
    }
    const a = el('a', { href: url, download: nome });
    document.body.append(a);
    a.click();
    a.remove();
    return 'Imagem salva nos seus downloads.';
  }

  const TAM = 256;
  const projetar = (lat, lng, z) => {
    const s = TAM * 2 ** z;
    const sen = Math.sin((lat * Math.PI) / 180);
    return { x: ((lng + 180) / 360) * s, y: (0.5 - Math.log((1 + sen) / (1 - sen)) / (4 * Math.PI)) * s };
  };
  const carregarImagem = (src) => new Promise((ok, falha) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    const t = setTimeout(() => falha(new Error('tempo')), 6000);
    img.onload = () => { clearTimeout(t); ok(img); };
    img.onerror = () => { clearTimeout(t); falha(new Error('erro')); };
    img.src = src;
  });

  // Separa, por tema, as paradas da rota e os locais "extras" (visíveis, fora da rota)
  // a até RAIO_ROTA metros do trajeto
  const RAIO_ROTA = 200;
  function contarAoLongoDaRota(coords, pts) {
    const contagem = new Map();   // tema -> {rota, extras}
    const extras = [];
    const somar = (tema, campo) => {
      const c = contagem.get(tema) || { rota: 0, extras: 0 };
      c[campo]++;
      contagem.set(tema, c);
    };
    pts.forEach((p) => somar(p.camada.tema, 'rota'));
    if (!coords.length) return { contagem, extras };
    const lat0 = (coords[0].lat * Math.PI) / 180;
    const mx = 111320 * Math.cos(lat0), my = 110540;   // metros por grau (aprox. local)
    const xy = (c) => [c.lng * mx, c.lat * my];
    const seg = coords.map(xy);
    const xs = seg.map((c) => c[0]), ys = seg.map((c) => c[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs) - RAIO_ROTA, Math.max(...xs) + RAIO_ROTA, Math.min(...ys) - RAIO_ROTA, Math.max(...ys) + RAIO_ROTA];
    const dist2 = ([px, py], [ax, ay], [bx, by]) => {
      const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
      const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
      const qx = ax + t * dx - px, qy = ay + t * dy - py;
      return qx * qx + qy * qy;
    };
    const r2 = RAIO_ROTA * RAIO_ROTA;
    for (const p of estado.pontos.values()) {
      if (!visivel(p) || estado.rota.includes(p.id)) continue;
      const q = xy(p.latlng);
      if (q[0] < x0 || q[0] > x1 || q[1] < y0 || q[1] > y1) continue;
      let perto = seg.length === 1 ? dist2(q, seg[0], seg[0]) <= r2 : false;
      for (let i = 1; i < seg.length && !perto; i++) perto = dist2(q, seg[i - 1], seg[i]) <= r2;
      if (perto) { somar(p.camada.tema, 'extras'); extras.push(p); }
    }
    return { contagem, extras };
  }

  async function gerarImagem(pts) {
    const W = 1080, H = 1350, TOPO = 150, MAPA_H = 780;
    const LISTA_Y = TOPO + MAPA_H;
    const cv = el('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    const css = getComputedStyle(document.documentElement);
    const fTitulo = css.getPropertyValue('--fonte-titulo').trim();
    const fTexto = css.getPropertyValue('--fonte-texto').trim();
    try { await Promise.all([document.fonts.load(`800 48px ${fTitulo}`), document.fonts.load(`700 28px ${fTexto}`), document.fonts.load(`400 24px ${fTexto}`)]); } catch { /* usa fonte reserva */ }
    const TINTA = '#152033', SUAVE = '#556074', PAPEL = '#f3f5f8';

    // Enquadramento
    const coords = estado.tracado?.coords?.map(([la, ln]) => ({ lat: la, lng: ln })) || pts.map((p) => p.latlng);
    const todos = [...coords, ...pts.map((p) => p.latlng)];
    let z = 17;
    for (; z > 3; z--) {
      const xs = todos.map((c) => projetar(c.lat, c.lng, z));
      const larg = Math.max(...xs.map((p) => p.x)) - Math.min(...xs.map((p) => p.x));
      const alt = Math.max(...xs.map((p) => p.y)) - Math.min(...xs.map((p) => p.y));
      if (larg <= W - 160 && alt <= MAPA_H - 160) break;
    }
    const pr = todos.map((c) => projetar(c.lat, c.lng, z));
    const cx = (Math.max(...pr.map((p) => p.x)) + Math.min(...pr.map((p) => p.x))) / 2;
    const cy = (Math.max(...pr.map((p) => p.y)) + Math.min(...pr.map((p) => p.y))) / 2;
    const ox = cx - W / 2, oy = cy - MAPA_H / 2;
    const tela = (lat, lng) => { const p = projetar(lat, lng, z); return [p.x - ox, p.y - oy + TOPO]; };

    // Fundo do mapa: blocos de ruas, ou limites municipais se não carregarem
    ctx.fillStyle = PAPEL;
    ctx.fillRect(0, 0, W, H);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, TOPO, W, MAPA_H); ctx.clip();
    let comRuas = false;
    if (!estado.semRuas) {
      const blocos = [];
      for (let tx = Math.floor(ox / TAM); tx <= Math.floor((ox + W) / TAM); tx++) {
        for (let ty = Math.floor(oy / TAM); ty <= Math.floor((oy + MAPA_H) / TAM); ty++) {
          const sub = 'abcd'[(tx + ty) % 4];
          const url = PROVEDORES[estado.provedor].imagem.replace('{s}', sub).replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
          blocos.push(carregarImagem(url).then((img) => ({ img, tx, ty })));
        }
      }
      const res = await Promise.allSettled(blocos);
      if (res.every((r) => r.status === 'fulfilled')) {
        for (const { value: { img, tx, ty } } of res) ctx.drawImage(img, tx * TAM - ox, ty * TAM - oy + TOPO, TAM, TAM);
        comRuas = true;
      }
    }
    if (!comRuas) {
      try {
        const geo = await carregarMunicipios();
        ctx.fillStyle = '#ffffff'; ctx.strokeStyle = '#aab3c2'; ctx.lineWidth = 1.2;
        for (const f of geo.features) {
          const polis = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
          for (const poli of polis) {
            ctx.beginPath();
            for (const anel of poli) anel.forEach(([lng, lat], i) => { const [x, y] = tela(lat, lng); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); });
            ctx.fill('evenodd'); ctx.stroke();
          }
        }
      } catch { /* fundo liso */ }
    }

    // Locais "extras" perto do trajeto, com menos destaque que as paradas
    const { contagem, extras } = contarAoLongoDaRota(coords, pts);
    for (const p of extras) {
      const [x, y] = tela(p.latlng.lat, p.latlng.lng);
      if (x < -10 || x > W + 10 || y < TOPO - 10 || y > TOPO + MAPA_H + 10) continue;
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.globalAlpha = 0.5; ctx.fillStyle = p.cor; ctx.fill();
      ctx.globalAlpha = 0.9; ctx.lineWidth = 1.5; ctx.strokeStyle = '#fff'; ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Linha da rota
    if (coords.length >= 2) {
      const caminho = () => { ctx.beginPath(); coords.forEach((c, i) => { const [x, y] = tela(c.lat, c.lng); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }); };
      ctx.lineJoin = 'round'; ctx.lineCap = 'round';
      caminho(); ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 14; ctx.stroke();
      caminho(); ctx.strokeStyle = TINTA; ctx.lineWidth = 7; ctx.setLineDash(estado.tracado?.ruas ? [] : [2, 16]); ctx.stroke();
      ctx.setLineDash([]);
    }
    // Paradas numeradas (de trás para frente para a nº 1 ficar por cima)
    for (let i = pts.length - 1; i >= 0; i--) {
      const [x, y] = tela(pts[i].latlng.lat, pts[i].latlng.lng);
      ctx.beginPath(); ctx.arc(x, y, 24, 0, Math.PI * 2);
      ctx.fillStyle = TINTA; ctx.fill();
      ctx.lineWidth = 6; ctx.strokeStyle = pts[i].cor; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `800 22px ${fTitulo}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x, y + 1);
    }
    // Etiquetas numeradas com o nome de cada parada, ao lado do marcador
    ctx.font = `700 19px ${fTexto}`; ctx.textBaseline = 'middle';
    pts.forEach((p, i) => {
      const [x, y] = tela(p.latlng.lat, p.latlng.lng);
      const texto = cortar(ctx, `${i + 1}. ${p.nome}`, 260);
      const lw = ctx.measureText(texto).width + 24, lh = 34;
      const direita = x + 32 + lw < W - 12;
      const lx = direita ? x + 32 : x - 32 - lw, ly = y - lh / 2;
      ctx.fillStyle = 'rgba(255,255,255,.95)';
      ctx.beginPath(); ctx.roundRect(lx, ly, lw, lh, 8); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = p.cor; ctx.stroke();
      ctx.fillStyle = TINTA; ctx.textAlign = 'left';
      ctx.fillText(texto, lx + 12, y + 1);
    });
    ctx.textBaseline = 'alphabetic';
    // Escala gráfica
    const metrosPorPx = (40075016.686 * Math.cos((todos[0].lat * Math.PI) / 180)) / (TAM * 2 ** z);
    const alvo = metrosPorPx * 180;
    const passo = [50, 100, 200, 250, 500, 1000, 2000, 2500, 5000, 10000, 20000, 50000].find((v) => v >= alvo / 2) || 50000;
    const larguraEscala = passo / metrosPorPx;
    const ex = 40, ey = TOPO + MAPA_H - 34;
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(ex - 12, ey - 30, larguraEscala + 24, 46);
    ctx.fillStyle = TINTA; ctx.fillRect(ex, ey, larguraEscala, 5);
    ctx.fillRect(ex, ey - 8, 3, 13); ctx.fillRect(ex + larguraEscala - 3, ey - 8, 3, 13);
    ctx.font = `700 18px ${fTitulo}`; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillText(formatarDist(passo), ex, ey - 12);

    // Caixa com a contagem por tema: paradas da rota e extras por perto
    const linhas = [...estado.temas.values()].filter((t) => contagem.get(t.id));
    const cxW = 400, cxPad = 22, cxLinha = 36;
    const cxH = cxPad * 2 + 74 + (linhas.length + 1) * cxLinha;
    const cxX = W - cxW - 28, cxY = TOPO + 28;
    const colRota = cxX + cxW - cxPad - 92, colExtras = cxX + cxW - cxPad;
    ctx.fillStyle = 'rgba(255,255,255,.95)';
    ctx.beginPath(); ctx.roundRect(cxX, cxY, cxW, cxH, 14); ctx.fill();
    ctx.lineWidth = 1.5; ctx.strokeStyle = '#d8dee8'; ctx.stroke();
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = TINTA; ctx.font = `800 24px ${fTitulo}`;
    ctx.fillText('Pontos por tema', cxX + cxPad, cxY + cxPad + 22);
    ctx.fillStyle = SUAVE; ctx.font = `400 16px ${fTexto}`;
    ctx.fillText(`extras: outros locais a até ${RAIO_ROTA} m do trajeto`, cxX + cxPad, cxY + cxPad + 46);
    ctx.font = `700 15px ${fTexto}`; ctx.textAlign = 'right';
    ctx.fillText('NA ROTA', colRota, cxY + cxPad + 74);
    ctx.fillText('EXTRAS', colExtras, cxY + cxPad + 74);
    const linhaY = (i) => cxY + cxPad + 74 + (i + 1) * cxLinha;
    let totRota = 0, totExtras = 0;
    linhas.forEach((t, i) => {
      const { rota, extras: ext } = contagem.get(t.id);
      totRota += rota; totExtras += ext;
      const y = linhaY(i);
      ctx.beginPath(); ctx.arc(cxX + cxPad + 9, y - 7, 9, 0, Math.PI * 2); ctx.fillStyle = t.cor; ctx.fill();
      ctx.fillStyle = TINTA; ctx.font = `700 20px ${fTexto}`; ctx.textAlign = 'left';
      ctx.fillText(cortar(ctx, t.nome, colRota - 90 - (cxX + cxPad + 28)), cxX + cxPad + 28, y);
      ctx.textAlign = 'right'; ctx.font = `800 22px ${fTitulo}`;
      ctx.fillText(String(rota), colRota, y);
      ctx.fillStyle = SUAVE; ctx.font = `700 22px ${fTitulo}`;
      ctx.fillText(ext.toLocaleString('pt-BR'), colExtras, y);
    });
    const yt = linhaY(linhas.length);
    ctx.fillStyle = '#d8dee8'; ctx.fillRect(cxX + cxPad, yt - 28, cxW - cxPad * 2, 1.5);
    ctx.fillStyle = TINTA; ctx.font = `800 20px ${fTexto}`; ctx.textAlign = 'left';
    ctx.fillText('Total', cxX + cxPad, yt);
    ctx.textAlign = 'right'; ctx.font = `800 22px ${fTitulo}`;
    ctx.fillText(String(totRota), colRota, yt);
    ctx.fillStyle = SUAVE; ctx.fillText(totExtras.toLocaleString('pt-BR'), colExtras, yt);
    ctx.restore();

    // Cabeçalho
    ctx.fillStyle = TINTA; ctx.fillRect(0, 0, W, TOPO);
    ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = 'rgba(255,255,255,.7)'; ctx.font = `600 22px ${fTitulo}`;
    ctx.fillText('ROTA POR PONTOS DE INTERESSE', 56, 56);
    ctx.fillStyle = '#fff'; ctx.font = `800 54px ${fTitulo}`;
    ctx.fillText('Minha rota', 56, 116);
    const dist = estado.tracado?.distancia ?? distanciaReta(pts);
    const tempo = estado.tracado?.duracao ?? (dist / 1000 / VELOCIDADE_A_PE_KMH) * 3600;
    const resumo = pts.length > 1
      ? `${pts.length} paradas · ${formatarDist(dist)} ${estado.tracado?.ruas ? 'a pé' : 'em linha reta'} · ≈ ${formatarTempo(tempo)}`
      : '1 parada';
    ctx.textAlign = 'right'; ctx.font = `700 28px ${fTitulo}`; ctx.fillStyle = '#fff';
    ctx.fillText(resumo, W - 56, 116);

    // Lista de paradas
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, LISTA_Y, W, H - LISTA_Y);
    ctx.fillStyle = '#d8dee8'; ctx.fillRect(0, LISTA_Y, W, 2);
    const colunas = pts.length > 5 ? 2 : 1;
    const porColuna = Math.ceil(Math.min(pts.length, 10) / colunas);
    const largCol = (W - 112 - (colunas - 1) * 40) / colunas;
    const alturaLinha = Math.min(62, (H - LISTA_Y - 110) / porColuna);
    pts.slice(0, 10).forEach((p, i) => {
      const col = Math.floor(i / porColuna), lin = i % porColuna;
      const x = 56 + col * (largCol + 40), y = LISTA_Y + 44 + lin * alturaLinha;
      ctx.beginPath(); ctx.arc(x + 18, y + 12, 18, 0, Math.PI * 2); ctx.fillStyle = TINTA; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = p.cor; ctx.stroke();
      ctx.fillStyle = '#fff'; ctx.font = `800 17px ${fTitulo}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), x + 18, y + 13);
      ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
      ctx.fillStyle = TINTA; ctx.font = `700 24px ${fTexto}`;
      ctx.fillText(cortar(ctx, p.nome, largCol - 56), x + 52, y + 12);
      ctx.fillStyle = SUAVE; ctx.font = `400 18px ${fTexto}`;
      ctx.fillText(cortar(ctx, p.camada.nome, largCol - 56), x + 52, y + 36);
    });
    if (pts.length > 10) {
      ctx.fillStyle = SUAVE; ctx.font = `700 20px ${fTexto}`; ctx.textAlign = 'right';
      ctx.fillText(`+ ${pts.length - 10} paradas`, W - 56, H - 72);
    }
    // Rodapé com fontes
    ctx.textAlign = 'left'; ctx.fillStyle = SUAVE; ctx.font = `400 17px ${fTexto}`;
    const fontes = [...new Set(pts.map((p) => p.props.fonte).filter(Boolean))].join(', ');
    const dataHoje = new Date().toLocaleDateString('pt-BR');
    ctx.fillText(cortar(ctx, `${estado.config.titulo} · ${dataHoje} · Dados: ${fontes}${comRuas ? ` · ${PROVEDORES[estado.provedor].creditoTexto}` : ' · Limites: IBGE'}`, W - 112), 56, H - 34);

    return new Promise((ok, falha) => cv.toBlob((b) => (b ? ok(b) : falha(new Error('canvas'))), 'image/png'));
  }

  function cortar(ctx, texto, larg) {
    if (ctx.measureText(texto).width <= larg) return texto;
    let t = texto;
    while (t.length > 1 && ctx.measureText(`${t}…`).width > larg) t = t.slice(0, -1);
    return `${t.trimEnd()}…`;
  }

  // ---------- Abas ----------
  function abrirAba(nome) {
    for (const n of ['filtros', 'perto', 'rota']) {
      $(`aba-${n}`).setAttribute('aria-selected', String(n === nome));
      $(`sec-${n}`).hidden = n !== nome;
    }
  }
  for (const n of ['filtros', 'perto', 'rota']) $(`aba-${n}`).addEventListener('click', () => abrirAba(n));

  // Troca o mapa base quando o tema claro/escuro muda
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { criarBase(); desenharRota(); });
  new MutationObserver(() => { criarBase(); desenharRota(); }).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  iniciar().catch((erro) => {
    console.error(erro);
    $('resumo').textContent = 'Não foi possível carregar as bases. Abra o site por um servidor (GitHub Pages ou "python3 -m http.server"), não direto do arquivo.';
  });
})();
