/* ============================================================================
   AMIT Investors — TV-läge
   Allt på en yta, ingen scroll, ingen pekare. Tickerns position är en ren
   funktion av klockan, så att sidan kan laddas om hur ofta som helst i ett
   roterande signage-flöde utan att bandet börjar om.
   ========================================================================= */

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PREVIEW = new URLSearchParams(location.search).has('preview');
/* Hastighet uttryckt som sekunder per skärmbredd, inte som cykeltid: bandets
   längd beror på nyhetsrubrikerna och varierar, men läshastigheten ska vara
   densamma oavsett innehåll och skärmstorlek. 14 s ≈ 140 px/s på 1080p. */
const TICKER_SCREEN_S = 18;
const REFRESH_MS = 5 * 60 * 1000;    // hämta ny data

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

const nf = (dp) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pctFmt = (v) => (v == null ? '–' : (v >= 0 ? '+' : '−') + nf(2).format(Math.abs(v)) + ' %');
const kr = (v) => (v == null ? '–' : nf(Math.abs(v) < 1 ? 3 : 2).format(v));
const upDown = (v) => (v == null ? 'var(--ink-2)' : v >= 0 ? 'var(--up)' : 'var(--down)');

const state = { data: null, news: {}, tickerKey: '' };
const competitors = () => state.data.participants.filter((p) => !p.benchmark);
const benchmarkOf = () => state.data.participants.find((p) => p.benchmark) || null;
const ranked = () => competitors().sort((a, b) => {
  if (a.pct == null && b.pct == null) return a.name.localeCompare(b.name, 'sv');
  if (a.pct == null) return 1; if (b.pct == null) return -1; return b.pct - a.pct;
});

/* ------------------------------------------------------------ stjärnfält
   Glesare än huvudsidan: signage-hårdvara är ofta svag. */
function starfield() {
  const cv = $('#starfield'), ctx = cv.getContext('2d');
  let w, h, stars = [], raf;
  const build = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5);
    w = innerWidth; h = innerHeight; cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    stars = Array.from({ length: Math.round(w * h * 0.00012) }, () => ({
      x: Math.random() * w, y: Math.random() * h, r: 0.4 + Math.random() * 1.2,
      a: 0.25 + Math.random() * 0.6, tw: Math.random() * 6.28, sp: 0.004 + Math.random() * 0.012,
    }));
  };
  const draw = (t) => {
    ctx.clearRect(0, 0, w, h);
    for (const s of stars) {
      const a = REDUCED ? s.a : s.a * (0.72 + 0.28 * Math.sin(t * 0.0011 + s.tw));
      ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, 6.28); ctx.fillStyle = `rgba(206,226,255,${a.toFixed(3)})`; ctx.fill();
      if (!REDUCED) { s.y += s.sp; if (s.y > h + 2) { s.y = -2; s.x = Math.random() * w; } }
    }
    if (!REDUCED) raf = requestAnimationFrame(draw);
  };
  build(); if (REDUCED) draw(0); else raf = requestAnimationFrame(draw);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { cancelAnimationFrame(raf); build(); if (REDUCED) draw(0); else raf = requestAnimationFrame(draw); }, 200); });
}

/* ------------------------------------------------------------------- data */
async function loadJson(path, optional = false) {
  const res = await fetch(`${path}?v=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${res.status}`); }
  return res.json();
}

/* ------------------------------------------------------------------ huvud */
function renderHead() {
  const d = state.data, c = d.competition;
  $('#tv-sub').textContent = c.subtitle || '';

  const open = d.session && Date.now() / 1000 >= d.session.start && Date.now() / 1000 <= d.session.end;
  const m = $('#tv-market'); m.textContent = open ? 'Öppen' : 'Stängd'; m.className = open ? 'is-open' : 'is-shut';

  const fmtD = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  // Bara dagnumret: datumet står redan på grafens x-axel, och huvudet är trångt.
  $('#tv-day').textContent = d.dates.length ? String(d.dates.length) : 'Före start';
  const end = new Date(c.endDate + 'T17:30:00+01:00');
  const days = Math.ceil((end - Date.now()) / 86400000);
  $('#tv-left').textContent = d.state === 'ended' ? 'Avgjort' : days > 0 ? `${days} d` : 'Sista dagen';
  $('#tv-synced').textContent = new Date(d.generatedAt).toLocaleTimeString('sv-SE', { hour: '2-digit', minute: '2-digit', timeZone: c.timezone });
  $('#tv-count').textContent = `${competitors().length} tävlande`;

  const lead = $('#tv-lead'); lead.innerHTML = '';
  const top = ranked()[0];
  if (!top || top.pct == null) {
    lead.append(el('span', 'lab', d.state === 'pre' ? 'Startskott' : 'Väntar på öppning'), el('span', 'co', `${fmtD(c.startDate)} → ${fmtD(c.endDate)}`));
    return;
  }
  const pct = el('span', 'pct', pctFmt(top.pct)); pct.style.color = upDown(top.pct);
  lead.append(el('span', 'lab', d.state === 'ended' ? 'Segrare' : 'I ledning'),
    el('span', 'who', `${top.avatar} ${top.name}`), el('span', 'co', top.company), pct);
}

/* ---------------------------------------------------------------- diagram
   Etiketter vid linjeslutet i stället för legend: på en TV ska namnet stå
   där ögat redan är. En enkel "dodge" skjuter isär etiketter som krockar. */
function renderChart() {
  const svg = $('#tv-chart'); svg.innerHTML = '';
  // Startpunkt: baslinjen på 0 % före dag 1, så alla linjer utgår från samma origo.
  const START = '__start';
  const dates = state.data.dates.length ? [START, ...state.data.dates] : [];
  const active = state.data.participants.filter((p) => p.ok && p.series.length && p.baseline != null);
  const r = svg.getBoundingClientRect(); const W = Math.max(400, r.width), H = Math.max(240, r.height);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');

  if (!dates.length || !active.length) {
    const t = mk('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = 'Grafen tänds efter första handelsdagens öppning.'; svg.append(t); return;
  }

  const PAD = { t: 18, r: Math.round(W * 0.265), b: 30, l: 60 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  let lo = 0, hi = 0;
  for (const p of active) for (const s of p.series) { lo = Math.min(lo, s.p); hi = Math.max(hi, s.p); }
  const span = Math.max(hi - lo, 1); lo -= span * 0.12; hi += span * 0.12;
  const x = (i) => PAD.l + (dates.length === 1 ? iw : (i / (dates.length - 1)) * iw);
  const y = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

  for (let i = 0; i <= 5; i++) {
    const v = lo + ((hi - lo) * i) / 5, yy = y(v);
    svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: yy, y2: yy, class: 'grid-line' }));
    const l = mk('text', { x: PAD.l - 10, y: yy + 4, class: 'axis-text', 'text-anchor': 'end' });
    l.textContent = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + '%'; svg.append(l);
  }
  if (lo < 0 && hi > 0) svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0), class: 'zero-line' }));
  const step = Math.max(1, Math.ceil(dates.length / 8));
  for (let i = 0; i < dates.length; i += step) {
    const t = mk('text', { x: x(i), y: H - 8, class: 'axis-text', 'text-anchor': i === 0 ? 'start' : 'middle' });
    t.textContent = dates[i] === START ? 'Start' : new Date(dates[i] + 'T12:00:00Z').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }); svg.append(t);
  }

  const labels = [];
  for (const p of active) {
    const map = new Map(p.series.map((s) => [s.d, s.p]));
    map.set(START, 0);
    let d = '', started = false, last = null;
    dates.forEach((dt, i) => { const v = map.get(dt); if (v == null) return; d += (started ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' '; started = true; last = { i, v }; });
    if (!started) continue;
    const line = mk('path', { d: d.trim(), stroke: p.color, fill: 'none', class: 'series-path' + (p.benchmark ? ' series-benchmark' : '') });
    line.style.filter = `drop-shadow(0 0 6px ${p.color}66)`;
    if (p.benchmark) line.style.strokeDasharray = '7 7';
    svg.append(line);
    const cap = mk('circle', { cx: x(last.i), cy: y(last.v), r: 4.5, fill: p.color, stroke: 'var(--void)', 'stroke-width': 2 });
    cap.style.filter = `drop-shadow(0 0 8px ${p.color})`; svg.append(cap);
    labels.push({ p, y: y(last.v), capY: y(last.v), x: x(last.i) });
  }

  /* Dodge i tre pass: tryck isär uppifrån, klampa mot underkanten och tryck
     isär nerifrån, klampa mot överkanten och tryck isär uppifrån igen. Bara
     det trånga klustret flyttas — en ensam etikett högst upp lämnas i fred. */
  const MIN = Math.max(18, H * 0.052), minY = PAD.t + 8, maxY = H - PAD.b - 6;
  labels.sort((a, b) => a.y - b.y);
  const n = labels.length;
  for (let i = 1; i < n; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + MIN);
  if (n) labels[n - 1].y = Math.min(labels[n - 1].y, maxY);
  for (let i = n - 2; i >= 0; i--) labels[i].y = Math.min(labels[i].y, labels[i + 1].y - MIN);
  if (n) labels[0].y = Math.max(labels[0].y, minY);
  for (let i = 1; i < n; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + MIN);

  for (const l of labels) {
    const g = mk('g', {});
    // Anslutning från punkten till etiketten: kort horisontell bit, sedan snett.
    const kx = Math.min(l.x + 14, W - PAD.r + 4);
    g.append(mk('path', { d: `M${l.x + 6} ${l.capY} L${kx} ${l.capY} L${W - PAD.r + 12} ${l.y}`,
      fill: 'none', stroke: l.p.color, 'stroke-width': 1, opacity: .5 }));
    const name = mk('text', { x: W - PAD.r + 20, y: l.y + 4, fill: l.p.color, class: 'end-label' });
    name.textContent = `${l.p.avatar} ${l.p.name}`;
    const pct = mk('text', { x: W - 4, y: l.y + 4, fill: l.p.benchmark ? 'var(--ink-2)' : upDown(l.p.pct), class: 'end-pct', 'text-anchor': 'end' });
    pct.textContent = pctFmt(l.p.pct);
    g.append(name, pct); svg.append(g);
  }
}

/* ------------------------------------------------------------- ställning */
function sparkline(p) {
  const svg = mk('svg', { class: 'spark', viewBox: '0 0 72 26', 'aria-hidden': 'true' });
  const vals = (p.baseline != null ? [0] : []).concat(p.series.map((s) => s.p)); if (vals.length < 2) return svg;
  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0), rng = hi - lo || 1;
  const d = vals.map((v, i) => (i ? 'L' : 'M') + ((i / (vals.length - 1)) * 70 + 1).toFixed(1) + ' ' + (24 - ((v - lo) / rng) * 22).toFixed(1)).join(' ');
  svg.append(mk('path', { d, fill: 'none', stroke: p.color, 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  return svg;
}

function renderBoard() {
  const board = $('#tv-board'); board.innerHTML = '';
  const list = ranked(), bench = benchmarkOf();
  const rows = bench ? [...list, bench] : list;
  rows.forEach((p, i) => {
    const isBench = p.benchmark, idx = isBench ? -1 : i;
    const li = el('li', 'tv-row' + (idx === 0 && p.pct != null ? ' is-leader' : '') + (isBench ? ' is-benchmark' : '') + (p.pending ? ' is-pending' : ''));
    const rank = el('span', 'rank', isBench ? 'REF' : p.pct == null ? '–' : String(idx + 1).padStart(2, '0'));
    if (isBench) rank.classList.add('rank-ref'); else if (p.pct != null && idx < 3) rank.classList.add('rank-medal', `rank-${idx + 1}`);
    const who = el('div', 'who');
    who.append(el('div', 'who-name', p.name), el('div', 'who-co' + (p.pending ? ' is-pending' : ''), p.pending ? 'Aktie ej vald ännu' : p.company));
    const right = el('div');
    const pct = el('div', 'pct'); pct.textContent = pctFmt(p.pct); pct.style.color = upDown(p.pct);
    const day = el('div', 'day', p.dayChangePct == null ? '' : `idag ${pctFmt(p.dayChangePct)}`);
    right.append(pct, day);
    li.append(rank, el('span', 'avatar', p.avatar), who, right, sparkline(p));
    board.append(li);
  });
}

/* ----------------------------------------------------------------- ticker
   Innehållet: allt som dossiern på huvudsidan visar, per deltagare. Bandet
   byggs bara om när innehållet faktiskt ändrats — annars skulle bredden
   hoppa vid varje datauppdatering och positionen rycka till. */
function buildTickerStrip() {
  const strip = el('div', 'tv-strip');
  const all = [...ranked(), ...(benchmarkOf() ? [benchmarkOf()] : [])];
  for (const p of all) {
    const item = el('span', 'tk-item');
    const sw = el('span', 'tk-sw'); sw.style.background = p.color; sw.style.boxShadow = `0 0 10px ${p.color}`;
    item.append(sw, el('span', 'tk-name', `${p.avatar} ${p.name}`));
    if (p.pending) { item.append(el('span', 'tk-co', 'har inte valt aktie än')); strip.append(item); continue; }
    item.append(el('span', 'tk-co', `${p.company} · ${p.ticker}`));
    const pct = el('span', 'tk-pct', (p.benchmark ? 'referens ' : '') + pctFmt(p.pct)); pct.style.color = upDown(p.pct); item.append(pct);
    const s = p.stats || {};
    const facts = [];
    if (p.price != null) facts.push(`kurs <b>${kr(p.price)}</b>`);
    if (p.baseline != null) facts.push(`bas <b>${kr(p.baseline)}</b>`);
    if (p.dayChangePct != null) facts.push(`idag <b>${pctFmt(p.dayChangePct)}</b>`);
    if (s.low52 != null && s.high52 != null) facts.push(`52v <b>${kr(s.low52)}–${kr(s.high52)}</b>`);
    if (facts.length) { const f = el('span', 'tk-fact'); f.innerHTML = facts.join('<span class="tk-sep">·</span>'); item.append(f); }
    const news = state.news[p.id]?.items?.slice(0, 2) || [];
    for (const n of news) {
      const nn = el('span', 'tk-news'); nn.append(el('i', null, 'Nyhet'), document.createTextNode(n.title));
      if (n.source) nn.append(el('span', 'tk-src', `  — ${n.source}`)); item.append(nn);
    }
    if (p.about) item.append(el('span', 'tk-about', p.about));
    strip.append(item, el('span', 'tk-div', '◆'));
  }
  return strip;
}

let tickerW = 0;
function renderTicker() {
  const key = JSON.stringify(state.data.participants.map((p) => [p.id, p.pct, p.price, p.dayChangePct])) + JSON.stringify(Object.keys(state.news));
  if (key === state.tickerKey && tickerW > 0) return;
  state.tickerKey = key;
  const track = $('#tv-track'); track.innerHTML = '';
  const a = buildTickerStrip(), b = a.cloneNode(true);   // två kopior = sömlös loop
  track.append(a, b);
  tickerW = a.getBoundingClientRect().width;
}

/* Positionen är (tid × hastighet) mod bandbredd. Ingen räknare, inget minne:
   en omladdning landar exakt där bandet skulle ha varit om det rullat
   oavbrutet, och två skärmar med samma bredd visar samma ställe. */
function positionTicker() {
  if (tickerW <= 0) return;
  const speed = innerWidth / TICKER_SCREEN_S;                   // px per sekund
  const x = ((Date.now() / 1000) * speed) % tickerW;
  $('#tv-track').style.transform = `translate3d(${(-x).toFixed(2)}px, 0, 0)`;
}

/* rAF ger mjukast rörelse, men vissa signage-spelare och bakgrundade flikar
   stryper den helt. En vakthund tar över med setInterval om rAF inte tickat
   på en sekund — bandet står aldrig stilla, det blir på sin höjd lite hackigt. */
let lastRaf = 0, fallback = null;
function tickTicker() {
  lastRaf = Date.now();
  if (fallback) { clearInterval(fallback); fallback = null; }
  positionTicker();
  requestAnimationFrame(tickTicker);
}
setInterval(() => {
  if (Date.now() - lastRaf > 1000 && !fallback) fallback = setInterval(positionTicker, 50);
}, 1000);

/* ------------------------------------------------------------------- init */
/* Kör varje renderingssteg för sig. På en TV utan tangentbord är ett
   halvt renderat läge oändligt mycket bättre än ett startskärmslås. */
function renderAll(steps) {
  for (const f of steps) {
    try { f(); } catch (err) { console.error(`[tv] ${f.name} misslyckades:`, err); }
  }
}

async function refresh() {
  const file = PREVIEW ? 'data/standings.preview.json' : 'data/standings.json';
  const [standings, news] = await Promise.all([loadJson(file), loadJson('data/news.json', true)]);
  state.data = standings; state.news = news?.byParticipant || {};
  renderAll([renderHead, renderBoard, renderChart, renderTicker]);
}

async function init() {
  starfield();
  try { await refresh(); }
  catch (err) { $('#boot').innerHTML = `<div class="boot-inner"><p>Kunde inte läsa kursdata.<br><br>${String(err.message)}</p></div>`; return; }
  $('#tv').hidden = false;
  const afterLayout = () => { renderAll([renderChart, renderTicker]); positionTicker(); $('#boot').classList.add('is-done'); };
  let done = false;
  requestAnimationFrame(() => { if (!done) { done = true; afterLayout(); } });
  setTimeout(() => { if (!done) { done = true; afterLayout(); } }, 300);   // rAF-strypt miljö
  tickTicker();
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { state.tickerKey = ''; renderAll([renderChart, renderTicker]); }, 200); });
}
init();
