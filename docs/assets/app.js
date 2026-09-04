/* ============================================================================
   AMIT Investors — klientlogik
   Ingen byggkedja, inga beroenden. Ren ES-modul + SVG som ritas för hand.
   ========================================================================= */

const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
const PREVIEW = new URLSearchParams(location.search).has('preview');

const $  = (sel, root = document) => root.querySelector(sel);
const el = (tag, cls, txt) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (txt != null) n.textContent = txt;
  return n;
};

const nf = (dp) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
/* Hardmellanslag (U+00A0) fore procenttecknet: annars bryter "+89,29 %" rad
   i smala kolumner och talet hamnar pa tva rader. */
const pctFmt = (v) => (v == null ? '–' : (v >= 0 ? '+' : '−') + nf(2).format(Math.abs(v)) + '\u00A0%');
/* Tre decimaler under en krona: en penny stock på 0,753 ska inte visas som
   0,75 — tredje siffran är en meningsfull del av kursen där. */
const kr = (v) => (v == null ? '–' : nf(Math.abs(v) < 1 ? 3 : 2).format(v));
const bigNum = (v) => (v == null ? '–' : new Intl.NumberFormat('sv-SE', { notation: 'compact', maximumFractionDigits: 1 }).format(v));
const dirClass = (v) => (v == null ? 'flat' : v > 0.005 ? 'up' : v < -0.005 ? 'down' : 'flat');

/* Skillnad mot referensen mäts i procentenheter (pp), inte procent — att säga
   att någon gick "10 % bättre" när båda mäts i procent är tvetydigt. */
const ppFmt = (v) => (v == null ? '–' : (v >= 0 ? '+' : '−') + nf(1).format(Math.abs(v)) + '\u00A0pp');

const state = { data: null, news: {}, range: 'all', sort: 'total', focus: null, hidden: new Set() };

/* Referensdeltagaren tävlar inte: den rankas inte, kan inte leda och får
   ingen medalj. Den finns för att besvara "slog jag moderbolaget?". */
const competitors = () => state.data.participants.filter((p) => !p.benchmark);
const benchmarkOf = () => state.data.participants.find((p) => p.benchmark) || null;

/* --------------------------------------------------------- glasbelysning
   Ett enda dokumentlyssnare i stället för ett per panel, och koordinaterna
   skrivs i en rAF-tick. Utan strypning körs handleraren en gång per
   musrörelse och tvingar fram layout varje gång. */
function specular() {
  let pending = null, frame = 0;
  addEventListener('pointermove', (ev) => {
    pending = ev;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const panel = pending.target.closest?.('.glass, .row');
      if (!panel) return;
      const r = panel.getBoundingClientRect();
      panel.style.setProperty('--mx', `${pending.clientX - r.left}px`);
      panel.style.setProperty('--my', `${pending.clientY - r.top}px`);
    });
  }, { passive: true });
}

/* Ledarkapseln lutar mot pekaren. Utslaget är medvetet litet (max 7°) —
   mer än så och texten börjar läsa som snedställd i stället för som djup. */
function tilt() {
  const card = $('#leader-capsule');
  if (!card || REDUCED) return;
  const MAX = 7;
  let frame = 0, ev = null;

  addEventListener('pointermove', (e) => {
    ev = e;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const r = card.getBoundingClientRect();
      // Lut bara när pekaren är i närheten, annars rör sig kortet av rörelser
      // långt bort på sidan och effekten känns lösryckt.
      const near = ev.clientX > r.left - 160 && ev.clientX < r.right + 160 &&
                   ev.clientY > r.top - 160 && ev.clientY < r.bottom + 160;
      if (!near) {
        card.classList.remove('is-tilting');
        card.style.setProperty('--tilt-x', '0deg');
        card.style.setProperty('--tilt-y', '0deg');
        return;
      }
      card.classList.add('is-tilting');
      const dx = (ev.clientX - (r.left + r.width / 2)) / (r.width / 2);
      const dy = (ev.clientY - (r.top + r.height / 2)) / (r.height / 2);
      card.style.setProperty('--tilt-y', `${(dx * MAX).toFixed(2)}deg`);
      card.style.setProperty('--tilt-x', `${(-dy * MAX).toFixed(2)}deg`);
    });
  }, { passive: true });
}

/* Räknar upp ett tal till sitt slutvärde. easeOutExpo bromsar hårt på slutet,
   vilket gör att siffran känns som att den landar i stället för att stanna. */
function countUp(node, target, format, ms = 1100) {
  if (REDUCED || target == null) { node.textContent = format(target); return; }
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const e = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
    node.textContent = format(target * e);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/* ---------------------------------------------------------------- stjärnfält
   Tre parallaxlager. Bakre lagret är tätt och svagt, främre glest och ljust —
   det är djupkänslan, inte antalet stjärnor, som gör bilden. */
function starfield() {
  const cv = $('#starfield');
  const ctx = cv.getContext('2d', { alpha: true });
  let w, h, dpr, layers, shooting = null, raf;

  const LAYERS = [
    { n: 0.00022, r: [0.3, 0.8], a: [0.18, 0.45], speed: 0.004 },
    { n: 0.00011, r: [0.5, 1.2], a: [0.30, 0.70], speed: 0.011 },
    { n: 0.00004, r: [0.8, 1.9], a: [0.45, 0.95], speed: 0.024 },
  ];

  function build() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    layers = LAYERS.map((L) => {
      const count = Math.round(w * h * L.n);
      return Array.from({ length: count }, () => ({
        x: Math.random() * w, y: Math.random() * h,
        r: L.r[0] + Math.random() * (L.r[1] - L.r[0]),
        a: L.a[0] + Math.random() * (L.a[1] - L.a[0]),
        tw: Math.random() * Math.PI * 2,
        sp: L.speed,
      }));
    });
  }

  function draw(t) {
    ctx.clearRect(0, 0, w, h);
    for (const stars of layers) {
      for (const s of stars) {
        // Blink: liten sinusmodulering, olika fas per stjärna
        const a = REDUCED ? s.a : s.a * (0.72 + 0.28 * Math.sin(t * 0.0011 + s.tw));
        ctx.beginPath();
        ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(206,226,255,${a.toFixed(3)})`;
        ctx.fill();
        if (!REDUCED) {
          s.y += s.sp;
          if (s.y > h + 2) { s.y = -2; s.x = Math.random() * w; }
        }
      }
    }

    if (!REDUCED) {
      if (!shooting && Math.random() < 0.0018) {
        shooting = { x: Math.random() * w * 0.8, y: Math.random() * h * 0.4, life: 0, len: 90 + Math.random() * 80 };
      }
      if (shooting) {
        const p = shooting.life / 48;
        const dx = shooting.len * p, dy = dx * 0.42;
        const g = ctx.createLinearGradient(shooting.x + dx, shooting.y + dy, shooting.x + dx - 62, shooting.y + dy - 26);
        g.addColorStop(0, `rgba(255,205,150,${(1 - p) * 0.85})`);
        g.addColorStop(1, 'rgba(255,205,150,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 1.4; ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(shooting.x + dx, shooting.y + dy);
        ctx.lineTo(shooting.x + dx - 62, shooting.y + dy - 26);
        ctx.stroke();
        if (++shooting.life > 48) shooting = null;
      }
      raf = requestAnimationFrame(draw);
    }
  }

  build();
  if (REDUCED) draw(0); else raf = requestAnimationFrame(draw);

  let rt;
  addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { cancelAnimationFrame(raf); build(); if (REDUCED) draw(0); else raf = requestAnimationFrame(draw); }, 180);
  });
}

/* ------------------------------------------------------------------- data */

async function loadJson(path, optional = false) {
  const res = await fetch(path + '?v=' + Date.now(), { cache: 'no-store' });
  if (!res.ok) { if (optional) return null; throw new Error(`${path}: HTTP ${res.status}`); }
  return res.json();
}

/* Deltagare med giltig data, sorterade enligt aktuellt sorteringsval. */
function ranked() {
  const key = state.sort === 'day' ? 'dayChangePct' : 'pct';
  return competitors().sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av == null && bv == null) return a.name.localeCompare(b.name, 'sv');
    if (av == null) return 1;
    if (bv == null) return -1;
    return bv - av;
  });
}

/* Placeringen vid föregående handelsdags stängning. Vi behöver ingen sparad
   historik för detta — hela serien finns redan, så gårdagens ordning räknas
   fram ur samma data som dagens. */
function previousRanks() {
  const dates = state.data.dates;
  if (dates.length < 2) return null;
  const prev = dates[dates.length - 2];
  const order = competitors()
    .map((p) => ({ id: p.id, v: p.series.find((s) => s.d === prev)?.p }))
    .filter((r) => r.v != null)
    .sort((a, b) => b.v - a.v);
  return order.length ? new Map(order.map((r, i) => [r.id, i])) : null;
}

/* -------------------------------------------------------------- telemetri */

const MARKET_LABEL = {
  REGULAR: ['Öppen', 'is-open'], PRE: ['Förhandel', 'is-open'], POST: ['Efterhandel', 'is-open'],
  CLOSED: ['Stängd', 'is-shut'], PREPRE: ['Stängd', 'is-shut'], POSTPOST: ['Stängd', 'is-shut'],
};

/* Ar borsen oppen just nu? JSON-filen kan vara timmar gammal, sa vi jamfor
   aktuell tid mot dagens handelssession i stallet for att lita pa filen. */
function liveMarketState(d) {
  if (!d.session) return d.marketState || null;
  const now = Date.now() / 1000;
  return now >= d.session.start && now <= d.session.end ? 'REGULAR' : 'CLOSED';
}

function renderTelemetry() {
  const d = state.data;
  const [label, cls] = MARKET_LABEL[liveMarketState(d)] || ['Stängd', 'is-shut'];
  const market = $('#ro-market');
  market.textContent = label; market.className = cls;

  $('#ro-synced').textContent = new Date(d.generatedAt).toLocaleTimeString('sv-SE', {
    hour: '2-digit', minute: '2-digit', timeZone: d.competition.timezone,
  });

  const end = new Date(d.competition.endDate + 'T17:30:00+01:00');
  const days = Math.ceil((end - Date.now()) / 86400000);
  $('#ro-remaining').textContent = d.state === 'ended' ? 'Avgjort' : days > 0 ? `${days} d` : 'Sista dagen';
  $('#ro-count').textContent = competitors().length;
}

/* ------------------------------------------------------------------- hero */

function renderHero() {
  const d = state.data;
  const c = d.competition;
  $('#hero-tagline').textContent = c.tagline || '';

  const fmtD = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('sv-SE', { day: 'numeric', month: 'long' });
  $('#hero-window').textContent =
    `${fmtD(c.startDate)} → ${fmtD(c.endDate)} · ${c.subtitle || ''}`.trim();

  const eyebrow = $('#hero-eyebrow');
  const body = $('#capsule-body');
  body.innerHTML = '';

  // Iriserande ram (conic-gradient som roterar) — läggs till en gång.
  const capsule = $('#leader-capsule');
  if (!capsule.querySelector('.iris')) capsule.prepend(el('span', 'iris'));

  if (d.state === 'pre') {
    eyebrow.textContent = 'T–minus';
    $('#capsule-label').textContent = 'Startskott';
    const target = new Date(c.startDate + 'T09:00:00+02:00');
    const cd = el('div', 'countdown');
    const units = [['dagar', 86400000], ['tim', 3600000], ['min', 60000]];
    let left = Math.max(0, target - Date.now());
    for (const [lab, ms] of units) {
      const v = Math.floor(left / ms); left -= v * ms;
      const u = el('div', 'cd-unit');
      u.append(el('div', 'cd-num', String(v).padStart(2, '0')), el('div', 'cd-lab', lab));
      cd.append(u);
    }
    body.append(cd, el('p', 'capsule-foot', 'Baslinjen sätts vid öppningskursen.'));
    return;
  }

  const top = ranked()[0];
  if (!top) return;
  eyebrow.textContent = d.state === 'ended' ? 'Uppdrag slutfört' : 'Uppdrag pågår';
  $('#capsule-label').textContent = d.state === 'ended' ? 'Segrare' : 'I ledning';

  const name = el('div', 'capsule-name');
  name.append(el('span', 'capsule-avatar', top.avatar), el('span', 'capsule-who', top.name));
  const pct = el('div', `capsule-pct ${dirClass(top.pct)}`);
  pct.style.color = `var(--${dirClass(top.pct) === 'up' ? 'up' : dirClass(top.pct) === 'down' ? 'down' : 'ink-2'})`;
  countUp(pct, top.pct, pctFmt);

  body.append(name, el('div', 'capsule-co', `${top.company} · ${top.ticker}`), pct);
  if (top.motto) body.append(el('p', 'capsule-foot', `”${top.motto}”`));
}

/* ---------------------------------------------------------------- diagram */

function visibleDates() {
  const all = state.data.dates;
  if (state.range === 'all') return all;
  return all.slice(-Number(state.range));
}

function seriesFor(p, dates) {
  const map = new Map(p.series.map((s) => [s.d, s.p]));
  return dates.map((d) => (map.has(d) ? map.get(d) : null));
}

let chartDrawn = false;

function renderChart() {
  let drawIndex = 0;
  const svg = $('#chart');
  const panel = $('#chart-panel');
  svg.innerHTML = '';

  const wrap = panel.querySelector('.chart-wrap');
  let empty = wrap.querySelector('.chart-empty');

  if (state.data.state === 'pre' || !state.data.dates.length) {
    // SVG-text kan inte radbrytas och skärs av på smal skärm. Tomma läget
    // renderas därför som vanlig HTML, som bryter rad av sig själv.
    svg.style.display = 'none';
    if (!empty) { empty = el('p', 'chart-empty'); wrap.append(empty); }
    empty.textContent = 'Inga handelsdagar ännu — grafen tänds vid startskottet.';
    empty.hidden = false;
    $('#legend').innerHTML = '';
    return;
  }
  svg.style.display = '';
  if (empty) empty.hidden = true;

  const rect = svg.getBoundingClientRect();
  const W = Math.max(320, rect.width), H = Math.max(220, rect.height);
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.setAttribute('preserveAspectRatio', 'none');

  const PAD = { t: 14, r: 14, b: 26, l: 46 };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;

  const dates = visibleDates();
  const active = state.data.participants.filter((p) => p.ok && p.series.length && !state.hidden.has(p.id));

  // Y-skala: alltid inkludera nollinjen, annars tappar diagrammet sin referens.
  let lo = 0, hi = 0;
  for (const p of active) for (const v of seriesFor(p, dates)) if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  const span = Math.max(hi - lo, 1);
  lo -= span * 0.10; hi += span * 0.10;

  const x = (i) => PAD.l + (dates.length === 1 ? iw / 2 : (i / (dates.length - 1)) * iw);
  const y = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    return n;
  };

  // Rutnät + y-etiketter
  const ticks = 5;
  for (let i = 0; i <= ticks; i++) {
    const v = lo + ((hi - lo) * i) / ticks;
    const yy = y(v);
    svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: yy, y2: yy, class: 'grid-line' }));
    const lbl = mk('text', { x: PAD.l - 9, y: yy + 3.5, class: 'axis-text', 'text-anchor': 'end' });
    lbl.textContent = (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(0) + '%';
    svg.append(lbl);
  }
  if (lo < 0 && hi > 0) svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0), class: 'zero-line' }));

  // X-etiketter
  const step = Math.max(1, Math.ceil(dates.length / 6));
  for (let i = 0; i < dates.length; i += step) {
    const t = mk('text', { x: x(i), y: H - 8, class: 'axis-text', 'text-anchor': i === 0 ? 'start' : 'middle' });
    t.textContent = new Date(dates[i] + 'T12:00:00Z').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
    svg.append(t);
  }

  // Serier
  for (const p of active) {
    const vals = seriesFor(p, dates);
    let dPath = '', started = false, last = null;
    vals.forEach((v, i) => {
      if (v == null) return;
      dPath += (started ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
      started = true; last = { i, v };
    });
    if (!started) continue;

    const isActive = state.focus === p.id;
    const cls = isActive ? 'is-active' : '';

    // Yta ritas bara för fokuserad serie — sex överlappande ytor blir gyttja.
    const gid = `grad-${p.id}`;
    const defs = mk('defs', {});
    const lg = mk('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 });
    lg.append(mk('stop', { offset: '0%', 'stop-color': p.color, 'stop-opacity': '.30' }));
    lg.append(mk('stop', { offset: '100%', 'stop-color': p.color, 'stop-opacity': '0' }));
    defs.append(lg); svg.append(defs);

    const baseY = y(Math.max(lo, Math.min(0, hi)));
    svg.append(mk('path', {
      d: dPath + `L${x(last.i).toFixed(1)} ${baseY.toFixed(1)} L${x(vals.findIndex((v) => v != null)).toFixed(1)} ${baseY.toFixed(1)} Z`,
      fill: `url(#${gid})`, class: `series-area ${cls}`, opacity: isActive ? 1 : 0,
    }));
    const line = mk('path', { d: dPath.trim(), stroke: p.color, class: `series-path ${cls}` });
    // Glöd via drop-shadow i stället för ett SVG-filter: körs på GPU:n och
    // suddar inte ut linjen som en feGaussianBlur-merge gör.
    line.style.filter = `drop-shadow(0 0 ${p.benchmark ? 3 : 5}px ${p.color}${p.benchmark ? '40' : '66'})`;
    if (p.benchmark) {
      // Streckad och tunnare: referensen ska läsas som en måttstock bakom
      // fältet, inte som ännu en tävlande.
      line.classList.add('series-benchmark');
      line.style.strokeDasharray = '6 6';
    }
    svg.append(line);

    // Linjerna ritas in en gång, förskjutna i tid så att de läser som separata
    // banor. Referensen hoppas över — dess streckmönster använder samma
    // stroke-dasharray som inritningen skulle ha skrivit över.
    if (!chartDrawn && !REDUCED && !p.benchmark) {
      const len = line.getTotalLength();
      line.style.strokeDasharray = len;
      line.style.strokeDashoffset = len;
      line.style.animationDelay = `${drawIndex++ * 110}ms`;
      line.classList.add('is-drawing');
    }
    const cap = mk('circle', {
      cx: x(last.i), cy: y(last.v), r: 3.4, fill: p.color,
      stroke: 'var(--void)', 'stroke-width': 1.5, class: `series-cap ${cls}`,
    });
    cap.style.filter = `drop-shadow(0 0 7px ${p.color})`;
    svg.append(cap);
  }

  chartDrawn = true;
  svg.setAttribute('class', state.focus ? 'chart is-focused' : 'chart');
  attachHover(svg, { dates, active, x, y, PAD, iw, W, H, mk });
  renderLegend();
}

function attachHover(svg, ctx) {
  const tip = $('#chart-tip');
  const NS = 'http://www.w3.org/2000/svg';
  const cursor = ctx.mk('line', { class: 'cursor-line', y1: ctx.PAD.t, y2: ctx.H - ctx.PAD.b, opacity: 0 });
  svg.append(cursor);
  const dots = ctx.active.map((p) => {
    const c = ctx.mk('circle', { r: 4, fill: p.color, stroke: 'var(--void)', 'stroke-width': 1.5, opacity: 0 });
    svg.append(c); return { p, node: c };
  });

  const hide = () => {
    tip.hidden = true; cursor.setAttribute('opacity', 0);
    dots.forEach((d) => d.node.setAttribute('opacity', 0));
  };

  svg.addEventListener('pointermove', (ev) => {
    const r = svg.getBoundingClientRect();
    const px = ((ev.clientX - r.left) / r.width) * ctx.W;
    let i = Math.round(((px - ctx.PAD.l) / ctx.iw) * (ctx.dates.length - 1));
    i = Math.max(0, Math.min(ctx.dates.length - 1, i));

    cursor.setAttribute('x1', ctx.x(i)); cursor.setAttribute('x2', ctx.x(i)); cursor.setAttribute('opacity', 1);

    const rows = [];
    for (const d of dots) {
      const v = seriesFor(d.p, ctx.dates)[i];
      if (v == null) { d.node.setAttribute('opacity', 0); continue; }
      d.node.setAttribute('cx', ctx.x(i)); d.node.setAttribute('cy', ctx.y(v)); d.node.setAttribute('opacity', 1);
      rows.push({ p: d.p, v });
    }
    rows.sort((a, b) => b.v - a.v);

    tip.innerHTML = '';
    tip.append(el('div', 'tip-date',
      new Date(ctx.dates[i] + 'T12:00:00Z').toLocaleDateString('sv-SE', { weekday: 'short', day: 'numeric', month: 'short' })));
    for (const r2 of rows) {
      const row = el('div', 'tip-row');
      const sw = el('span', 'tip-swatch'); sw.style.background = r2.p.color;
      const val = el('span', 'tip-val', pctFmt(r2.v));
      val.style.color = r2.v >= 0 ? 'var(--up)' : 'var(--down)';
      row.append(sw, el('span', 'tip-name', r2.p.name), val);
      tip.append(row);
    }
    tip.hidden = false;

    // Håll tooltipen innanför panelen
    const wrapW = svg.parentElement.clientWidth;
    const px2 = (ctx.x(i) / ctx.W) * wrapW;
    const half = tip.offsetWidth / 2;
    tip.style.left = Math.max(half + 4, Math.min(wrapW - half - 4, px2)) + 'px';
    tip.style.top = '18px';
  });

  svg.addEventListener('pointerleave', hide);
}

function renderLegend() {
  const ul = $('#legend');
  ul.innerHTML = '';
  const bench = benchmarkOf();
  for (const p of [...ranked(), ...(bench ? [bench] : [])]) {
    if (!p.ok) continue;
    const li = el('li');
    const btn = el('button', 'legend-item'
      + (state.hidden.has(p.id) ? ' is-muted' : '')
      + (p.benchmark ? ' is-benchmark' : ''));
    btn.type = 'button';
    btn.setAttribute('aria-pressed', String(!state.hidden.has(p.id)));
    const sw = el('span', 'legend-swatch'); sw.style.background = p.color;
    const pctSpan = el('span', 'legend-pct', pctFmt(p.pct));
    pctSpan.style.color = p.pct == null ? 'var(--ink-3)' : p.pct >= 0 ? 'var(--up)' : 'var(--down)';
    btn.append(sw, el('span', null, p.name), pctSpan);

    btn.addEventListener('click', () => {
      if (state.hidden.has(p.id)) state.hidden.delete(p.id); else state.hidden.add(p.id);
      state.focus = null; renderChart();
    });
    btn.addEventListener('pointerenter', () => {
      if (state.hidden.has(p.id)) return;
      state.focus = p.id; $('#chart').setAttribute('class', 'chart is-focused');
      syncFocusClasses();
    });
    btn.addEventListener('pointerleave', () => {
      state.focus = null; $('#chart').setAttribute('class', 'chart'); syncFocusClasses();
    });
    li.append(btn); ul.append(li);
  }
}

/* Växlar .is-active utan att rita om hela diagrammet — hover ska kännas direkt. */
function syncFocusClasses() {
  const svg = $('#chart');
  const order = state.data.participants.filter((p) => p.ok && p.series.length && !state.hidden.has(p.id));
  const areas = svg.querySelectorAll('.series-area');
  const paths = svg.querySelectorAll('.series-path');
  const caps  = svg.querySelectorAll('.series-cap');
  order.forEach((p, i) => {
    const on = state.focus === p.id;
    [areas[i], paths[i], caps[i]].forEach((n) => n && n.classList.toggle('is-active', on));
    if (areas[i]) areas[i].setAttribute('opacity', on ? 1 : 0);
  });
}

/* ------------------------------------------------------------ sparkline */

function sparkline(p) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', '0 0 72 26');
  svg.setAttribute('aria-hidden', 'true');
  const vals = p.series.map((s) => s.p).filter((v) => v != null);
  if (vals.length < 2) return svg;

  const lo = Math.min(...vals, 0), hi = Math.max(...vals, 0), rng = hi - lo || 1;
  const pt = (v, i) => [
    (i / (vals.length - 1)) * 70 + 1,
    24 - ((v - lo) / rng) * 22,
  ];
  const d = vals.map((v, i) => (i ? 'L' : 'M') + pt(v, i).map((n) => n.toFixed(1)).join(' ')).join(' ');

  if (lo < 0 && hi > 0) {
    const zy = 24 - ((0 - lo) / rng) * 22;
    const z = document.createElementNS(NS, 'line');
    z.setAttribute('x1', 1); z.setAttribute('x2', 71);
    z.setAttribute('y1', zy); z.setAttribute('y2', zy);
    z.setAttribute('stroke', 'rgba(150,190,230,.20)'); z.setAttribute('stroke-width', 1);
    svg.append(z);
  }
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', d);
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', p.color);
  path.setAttribute('stroke-width', 1.6);
  path.setAttribute('stroke-linejoin', 'round');
  path.setAttribute('stroke-linecap', 'round');
  svg.append(path);
  return svg;
}

/* ----------------------------------------------------------- ställningen */

let boardAnimated = false;

function renderBoard() {
  const board = $('#board');
  board.innerHTML = '';
  const list = ranked();
  const bench = benchmarkOf();
  const prevRanks = previousRanks();
  // Referensen räknas in i skalan så att staplarna är jämförbara med den.
  const scaled = bench ? [...list, bench] : list;
  const maxAbs = Math.max(1, ...scaled.map((p) => Math.abs(p.pct ?? 0)));

  scaled.forEach((p, i) => {
    const isBench = p.benchmark;
    const idx = isBench ? -1 : i;   // -1 = utanför tävlan
    const li = el('li', 'row'
      + (idx === 0 && p.pct != null ? ' is-leader' : '')
      + (isBench ? ' is-benchmark' : ''));
    li.dataset.id = p.id;
    li.style.setProperty('--row-color', p.color);

    const head = el('button', 'row-head');
    head.type = 'button';
    head.setAttribute('aria-expanded', 'false');

    const rank = el('span', 'rank',
      isBench ? 'REF' : p.pct == null ? '–' : String(idx + 1).padStart(2, '0'));
    if (isBench) rank.classList.add('rank-ref');
    else if (p.pct != null && idx < 3) rank.classList.add('rank-medal', `rank-${idx + 1}`);
    head.append(rank);

    // Förändring sedan föregående stängning. Bara meningsfull i totalsortering.
    if (!isBench && prevRanks && state.sort === 'total' && prevRanks.has(p.id)) {
      const delta = prevRanks.get(p.id) - idx;
      const move = el('span', 'rank-move ' + (delta > 0 ? 'up' : delta < 0 ? 'down' : 'same'));
      move.textContent = delta > 0 ? `▲${delta}` : delta < 0 ? `▼${-delta}` : '·';
      move.title = delta === 0 ? 'Oförändrad placering' : `${Math.abs(delta)} placering(ar) sedan i går`;
      rank.append(move);
    }
    head.append(el('span', 'avatar', p.avatar));

    const who = el('div', 'who');
    who.append(el('div', 'who-name', p.name), el('div', 'who-co', `${p.company} · ${p.ticker}`));
    head.append(who);

    // Divergerande stapel kring nollan
    const bar = el('div', 'bar');
    bar.append(el('div', 'bar-axis'));
    const fill = el('div', 'bar-fill');
    const v = p.pct ?? 0;
    const frac = Math.min(1, Math.abs(v) / maxAbs) * 50;
    fill.style.background = p.color;
    fill.style.boxShadow = `0 0 14px -2px ${p.color}`;
    fill.style.left = v >= 0 ? '50%' : `${50 - frac}%`;
    fill.style.width = REDUCED ? `${frac}%` : '0%';
    bar.append(fill);
    head.append(bar);

    const pctEl = el('span', `pct ${dirClass(p.pct)}`);
    if (boardAnimated) pctEl.textContent = pctFmt(p.pct);
    else countUp(pctEl, p.pct, pctFmt, 900 + idx * 60);
    head.append(pctEl);
    head.append(sparkline(p));
    head.append(el('span', 'caret', '▾'));

    li.append(head);
    li.append(dossier(p));
    board.append(li);

    if (isBench) fill.style.opacity = '.55';
    if (!REDUCED) requestAnimationFrame(() => { fill.style.width = `${frac}%`; });

    head.addEventListener('click', () => {
      const open = li.classList.toggle('is-open');
      head.setAttribute('aria-expanded', String(open));
    });
  });
  boardAnimated = true;  // räkna bara upp vid första renderingen, inte vid sortering
}

function dossier(p) {
  const wrap = el('div', 'dossier');
  const inner = el('div', 'dossier-inner');
  const pad = el('div', 'dossier-pad');

  if (!p.ok) {
    const err = el('div', 'row-error', `Kunde inte hämta kursdata: ${p.error || 'okänt fel'}. Kontrollera tickern i config/competition.json.`);
    inner.append(err); wrap.append(inner); return wrap;
  }

  /* Vänsterspalt: bolaget */
  const left = el('div');
  left.append(el('h3', null, 'Bolaget'));
  if (p.about) left.append(el('p', 'about', p.about));
  if (p.motto) left.append(el('p', 'motto', `”${p.motto}” — ${p.name}`));

  const s = p.stats || {};
  const stats = el('dl', 'stats');
  const addStat = (label, value) => {
    const d = el('div', 'stat');
    d.append(el('dt', null, label), el('dd', null, value));
    stats.append(d);
  };
  // Valutan i etiketten, inte i värdet — annars radbryter "23,86 SEK" i cellen.
  addStat(`Kurs (${p.currency || 'SEK'})`, kr(p.price));
  addStat('Baslinje', kr(p.baseline));
  addStat('Idag', pctFmt(p.dayChangePct));
  addStat('Volym', bigNum(s.volume));

  // Tävlingens egentliga fråga: slog du moderbolaget?
  const bench = benchmarkOf();
  if (bench && !p.benchmark && bench.pct != null && p.pct != null) {
    addStat(`Mot ${bench.name}`, ppFmt(p.pct - bench.pct));
  }
  left.append(stats);

  /* 52-veckorsmätare: var i årsintervallet ligger kursen just nu? */
  if (s.low52 != null && s.high52 != null && p.price != null && s.high52 > s.low52) {
    const meter = el('div', 'meter');
    meter.append(el('h3', null, '52 veckor'));
    const track = el('div', 'meter-track');
    const pin = el('div', 'meter-pin');
    pin.style.left = `${Math.max(0, Math.min(100, ((p.price - s.low52) / (s.high52 - s.low52)) * 100))}%`;
    track.append(pin);
    const ends = el('div', 'meter-ends');
    ends.append(el('span', null, kr(s.low52)), el('span', null, kr(s.high52)));
    meter.append(track, ends);
    left.append(meter);
  }

  /* Högerspalt: nyheter */
  const right = el('div');
  right.append(el('h3', null, 'I nyhetsflödet'));
  const feed = state.news[p.id];
  if (feed?.items?.length) {
    const ul = el('ul', 'news');
    for (const it of feed.items.slice(0, 5)) {
      const li = el('li');
      const a = el('a');
      a.href = it.link; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.append(document.createTextNode(it.title));
      const when = it.published
        ? new Date(it.published).toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' })
        : '';
      a.append(el('span', 'news-meta', [it.source, when].filter(Boolean).join(' · ')));
      li.append(a); ul.append(li);
    }
    right.append(ul);
  } else {
    right.append(el('p', 'news-empty', 'Inga färska rubriker just nu.'));
  }

  pad.append(left, right);
  inner.append(pad); wrap.append(inner);
  return wrap;
}

/* ------------------------------------------------------------------- init */

function wireControls() {
  for (const btn of document.querySelectorAll('[data-range]')) {
    btn.addEventListener('click', () => {
      state.range = btn.dataset.range;
      document.querySelectorAll('[data-range]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderChart();
    });
  }
  for (const btn of document.querySelectorAll('[data-sort]')) {
    btn.addEventListener('click', () => {
      state.sort = btn.dataset.sort;
      document.querySelectorAll('[data-sort]').forEach((b) => b.setAttribute('aria-pressed', String(b === btn)));
      renderBoard(); renderLegend();
    });
  }
  let rt;
  addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(renderChart, 200); });
}

async function init() {
  starfield();
  specular();
  tilt();
  try {
    const file = PREVIEW ? 'data/standings.preview.json' : 'data/standings.json';
    const [standings, news] = await Promise.all([loadJson(file), loadJson('data/news.json', true)]);
    state.data = standings;
    state.news = news?.byParticipant || {};
  } catch (err) {
    $('#boot').innerHTML =
      `<div class="boot-inner"><p>Kunde inte läsa kursdata.<br><br>${String(err.message)}</p></div>`;
    return;
  }

  document.title = `${state.data.competition.title} — ställning`;
  renderTelemetry(); renderHero(); renderBoard(); wireControls();

  $('#app').hidden = false;
  requestAnimationFrame(() => {
    renderChart();
    if (!REDUCED) {
      document.querySelectorAll('.hero, #chart-panel, #board-panel, .foot').forEach((n, i) => {
        n.classList.add('reveal');
        n.style.animationDelay = `${i * 90}ms`;
      });
    }
    $('#boot').classList.add('is-done');
  });
}

init();
