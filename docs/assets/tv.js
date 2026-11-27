/* ============================================================================
   AMIT Investors — TV-läge
   Allt på en yta, ingen scroll, ingen pekare. Berättelseradens mening styrs av
   klockan, så att visningar i ett roterande signage-flöde visar olika delar
   även om sidan laddas om varje gång.
   ========================================================================= */

'use strict';

const PREVIEW = new URLSearchParams(location.search).has('preview');
const STORY_MS = 5500;               // tid per mening i berättelseraden
const PRESS_MAX_DAYS = 7;            // så gamla pressmeddelanden räknas som aktuella
const REFRESH_MS = 5 * 60 * 1000;    // hämta ny data
const FETCH_TIMEOUT_MS = 20 * 1000;
const STALE_MIN = 90;                // normalt högst ca 55 min mellan körningar
const LOADED_AT = Date.now();

const $ = (s, r = document) => r.querySelector(s);
const el = (tag, cls, txt) => { const n = document.createElement(tag); if (cls) n.className = cls; if (txt != null) n.textContent = txt; return n; };
const NS = 'http://www.w3.org/2000/svg';
const mk = (tag, attrs = {}) => { const n = document.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };

const nf = (dp) => new Intl.NumberFormat('sv-SE', { minimumFractionDigits: dp, maximumFractionDigits: dp });
const pctFmt = (v) => (v == null ? '–' : (v >= 0 ? '+' : '−') + nf(2).format(Math.abs(v)) + ' %');
const kr = (v) => (v == null ? '–' : nf(Math.abs(v) < 1 ? 3 : 2).format(v));
const upDown = (v) => (v == null ? 'var(--ink-2)' : v >= 0 ? 'var(--up)' : 'var(--down)');

/* Avatarerna ritas som egna SVG-filer. Många TV-apparater saknar en emojifont
   som täcker tecknen och visar då fyrkanter. Filnamnet är kodpunkterna i hex. */
const emojiSrc = (emoji) => `assets/emoji/${Array.from(emoji).filter((c) => c !== '\uFE0F').map((c) => c.codePointAt(0).toString(16)).join('-')}.svg`;
function avatarImg(emoji) {
  const img = el('img', 'emoji'); img.alt = ''; img.src = emojiSrc(emoji);
  img.onerror = () => img.remove();
  return img;
}

const state = { data: null, news: {}, frames: [], storyIndex: -1, fetchFails: 0, theme: null };

/* ------------------------------------------------------------------ teman
   Jul från första advent till annandagen, och Nobeldagen den 10 december.
   Temat följer kalendern i tävlingens tidszon. Förhandsvisning:
   ?datum=ÅÅÅÅ-MM-DD visar en annan dags tema, ?ruta=N låser berättelseraden
   på mening N och ?tema=av stänger av. */
const QS = new URLSearchParams(location.search);
function themeOf(iso) {
  const y = Number(iso.slice(0, 4)), md = iso.slice(5), t = Date.parse(iso + 'T00:00:00Z');
  // Fjärde advent är söndagen närmast före juldagen.
  const xmas = Date.UTC(y, 11, 25), fourth = xmas - (new Date(xmas).getUTCDay() || 7) * 864e5;
  let advent = 0;
  for (let k = 1; k <= 4; k++) if (t >= fourth - (4 - k) * 7 * 864e5) advent = k;
  if (md > '12-26') advent = 0;
  return { advent, nobel: md === '12-10', lucka: md >= '12-01' && md <= '12-24' ? Number(md.slice(3)) : 0 };
}
function currentTheme() {
  const q = QS.get('datum') || '';
  const timeZone = (state.data && state.data.competition.timezone) || 'Europe/Stockholm';
  const iso = /^\d{4}-\d\d-\d\d$/.test(q) ? q : new Date().toLocaleDateString('sv-SE', { timeZone });
  const t = QS.get('tema') === 'av' ? { advent: 0, nobel: false, lucka: 0 } : themeOf(iso);
  t.key = [t.advent, t.nobel, t.lucka].join('|');
  return t;
}
const ordinal = (n) => `${n}:${n < 3 ? 'a' : 'e'}`;

function applyTheme() {
  const t = currentTheme();
  if (state.theme && state.theme.key === t.key) return false;
  state.theme = t;
  const b = document.body.classList;
  b.toggle('t-advent', t.advent > 0); b.toggle('t-nobel', t.nobel);
  renderCandles(); renderLights(); renderCaps(); drawSky();
  return true;
}

/* Adventsljusstaken: ett ljus till för varje advent, och de som brunnit längst är kortast. */
function renderCandles() {
  let box = $('#tv-candles');
  if (!box) { box = el('span', 'tv-candles'); box.id = 'tv-candles'; const brand = $('.tv-brand'); brand.insertBefore(box, brand.firstChild); }
  const n = state.theme.advent; box.hidden = !n; box.innerHTML = '';
  if (!n) return;
  const svg = mk('svg', { viewBox: '0 0 52 46', 'aria-hidden': 'true' });
  for (let i = 0; i < 4; i++) {
    const lit = i < n, h = lit ? 25 - (n - 1 - i) * 3.6 : 25, cx = 8 + i * 12, top = 39 - h;
    if (lit) svg.append(mk('circle', { cx, cy: top - 6, r: 8, class: 'halo' }));
    svg.append(mk('rect', { x: cx - 3.4, y: top, width: 6.8, height: h, rx: 1.2, class: 'candle' + (lit ? ' lit' : '') }));
    svg.append(mk('line', { x1: cx, x2: cx, y1: top, y2: top - 2.4, class: 'wick' }));
    if (lit) {
      svg.append(mk('path', { d: `M${cx} ${top - 12} C${cx + 4} ${top - 7} ${cx + 3.2} ${top - 1.8} ${cx} ${top - 1.8} C${cx - 3.2} ${top - 1.8} ${cx - 4} ${top - 7} ${cx} ${top - 12}Z`, class: 'flame' }));
      svg.append(mk('ellipse', { cx, cy: top - 4.4, rx: 1.3, ry: 2.4, class: 'flame-core' }));
    }
  }
  svg.append(mk('rect', { x: 1, y: 39, width: 50, height: 5, rx: 2.5, class: 'holder' }));
  box.append(svg);
}

const unitPx = () => parseFloat(getComputedStyle(document.body).fontSize) / 1.15;   // --u i px

/* Ljusslingan längs överkanten: tråden hänger i bågar med lampor i fyra färger. */
function renderLights() {
  let box = $('#tv-lights');
  if (!box) { box = el('div', 'tv-lights'); box.id = 'tv-lights'; document.body.append(box); }
  box.hidden = !state.theme.advent; box.innerHTML = '';
  if (box.hidden) return;
  const u = unitPx(), W = innerWidth, H = u * 2.6, colors = ['#ff5a4f', '#ffc861', '#4ee39b', '#6fb7ff'];
  const svg = mk('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
  const spans = Math.max(4, Math.round(W / (u * 13))), span = W / spans, sag = u * 0.75, per = 5;
  let d = 'M0 0', k = 0;
  for (let i = 0; i < spans; i++) d += ` Q${(i + 0.5) * span} ${sag * 2} ${(i + 1) * span} 0`;
  svg.append(mk('path', { d, class: 'wire' }));
  for (let i = 0; i < spans; i++) for (let j = 0; j < per; j++, k++) {
    const t = (j + 0.5) / per, x = (i + t) * span, y = 4 * t * (1 - t) * sag, c = colors[k % colors.length];
    svg.append(mk('rect', { x: x - u * 0.13, y, width: u * 0.26, height: u * 0.3, class: 'socket' }));
    const bulb = mk('ellipse', { cx: x, cy: y + u * 0.68, rx: u * 0.27, ry: u * 0.42, fill: c });
    bulb.style.filter = `drop-shadow(0 0 ${(u * 0.45).toFixed(1)}px ${c})`;
    svg.append(bulb);
  }
  box.append(svg);
}

/* Snö på panelernas överkant. Formen är densamma varje gång. */
function renderCaps() {
  Array.from(document.querySelectorAll('.snowcap')).forEach((n) => n.remove());
  if (!state.theme.advent) return;
  Array.from(document.querySelectorAll('.tv-panel')).forEach((panel, pi) => {
    const u = unitPx(), W = panel.clientWidth - u * 2.4, H = u * 1.3;
    if (W < u * 6) return;
    let seed = 7 + pi * 13; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const n = Math.round(W / (u * 2.6)), step = W / n;
    let d = `M0 ${u * 0.5} Q${u * 0.1} ${u * 0.12} ${u * 0.7} ${u * 0.1} L${W - u * 0.7} ${u * 0.1} Q${W - u * 0.1} ${u * 0.12} ${W} ${u * 0.5}`;
    for (let i = n; i > 0; i--) {
      const drop = u * (0.5 + rnd() * 0.55), x1 = i * step, x0 = (i - 1) * step;
      d += ` Q${x1 - step * 0.25} ${drop + u * 0.25} ${x1 - step * 0.5} ${drop} Q${x0 + step * 0.25} ${drop - u * 0.2} ${x0} ${u * 0.5}`;
    }
    const svg = mk('svg', { class: 'snowcap', viewBox: `0 0 ${W} ${H}`, width: W, height: H, 'aria-hidden': 'true' });
    svg.append(mk('path', { d: d + 'Z' }));
    panel.append(svg);
  });
}

function hatSvg() {
  const svg = mk('svg', { class: 'hat', viewBox: '0 0 40 30', 'aria-hidden': 'true' });
  svg.append(mk('path', { d: 'M5 23 C5 10 14 2 23 3 C30 4 35 11 36 19 C33 15 29 13 27 14 L28 23 Z', fill: '#e2382e' }));
  svg.append(mk('path', { d: 'M23 3 C30 4 35 11 36 19 C33 15 29 13 27 14 C27 9 26 6 23 3 Z', fill: '#b9261f' }));
  svg.append(mk('rect', { x: 2, y: 20, width: 29, height: 8, rx: 4, fill: '#fff' }));
  svg.append(mk('circle', { cx: 36, cy: 20, r: 3.8, fill: '#fff' }));
  return svg;
}

function laurelSvg() {
  const svg = mk('svg', { class: 'laurel', viewBox: '0 0 44 44', 'aria-hidden': 'true' });
  [1, -1].forEach((side) => {
    const g = mk('g', side < 0 ? { transform: 'translate(44 0) scale(-1 1)' } : {});
    g.append(mk('path', { d: 'M20 41 C8 38 3 28 5 17 C6 12 8 8 11 5', class: 'stem' }));
    for (let k = 0; k < 7; k++) {
      const a = (104 + k * 21) * Math.PI / 180, x = 22 + 18 * Math.cos(a), y = 22 + 18 * Math.sin(a), rot = 104 + k * 21 + 62;
      g.append(mk('ellipse', { cx: x, cy: y, rx: 4.6, ry: 2, transform: `rotate(${rot} ${x.toFixed(1)} ${y.toFixed(1)})`, class: 'leaf' }));
    }
    svg.append(g);
  });
  return svg;
}

/* Pynt på ledarens avatar: lagerkrans på Nobeldagen, annars tomteluva under advent. */
function decorate(holder) {
  const t = state.theme, kind = t.nobel ? 'laurel' : t.advent ? 'hat' : '';
  if (!kind) return holder;
  holder.classList.add('deco', 'deco-' + kind);
  holder.append(kind === 'hat' ? hatSvg() : laurelSvg());
  return holder;
}
const competitors = () => state.data.participants.filter((p) => !p.benchmark);
const benchmarkOf = () => state.data.participants.find((p) => p.benchmark) || null;
const ranked = () => competitors().sort((a, b) => {
  if (a.pct == null && b.pct == null) return a.name.localeCompare(b.name, 'sv');
  if (a.pct == null) return 1; if (b.pct == null) return -1; return b.pct - a.pct;
});

/* ------------------------------------------------------------ himlen
   Glesa, stillastående stjärnor: rörelse stör i ett kontorslandskap och
   signage-hårdvara är ofta svag. I julläget byts de mot långsamt fallande snö. */
let drawSky = () => {};
function starfield() {
  const cv = $('#starfield'), ctx = cv.getContext('2d');
  let w = 0, h = 0, flakes = [], zones = [], raf = 0, last = 0, frame = 0, slow = 0;
  const size = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5); w = innerWidth; h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
  };
  const stars = () => {
    for (let i = Math.round(w * h * 0.00012); i > 0; i--) {
      ctx.beginPath(); ctx.arc(Math.random() * w, Math.random() * h, 0.4 + Math.random() * 1.2, 0, 6.28);
      ctx.fillStyle = `rgba(206,226,255,${(0.25 + Math.random() * 0.6).toFixed(3)})`; ctx.fill();
    }
  };
  const paint = (t) => {
    const u = unitPx();
    ctx.clearRect(0, 0, w, h);
    // Snön faller över grafen och i marginalerna, inte över text som ska läsas.
    if (frame++ % 60 === 0) zones = ['.tv-head', '.tv-main .tv-panel:last-child', '.tv-foot'].map((q) => $(q)).filter(Boolean).map((n) => n.getBoundingClientRect());
    for (const f of flakes) {
      const x = f.x + Math.sin(t * 0.0005 + f.ph) * u * 0.7;
      if (zones.some((z) => x > z.left && x < z.right && f.y > z.top && f.y < z.bottom)) continue;
      ctx.beginPath(); ctx.arc(x, f.y, f.r, 0, 6.28);
      ctx.fillStyle = `rgba(255,255,255,${f.a})`; ctx.fill();
    }
  };
  const fall = (t) => {
    raf = requestAnimationFrame(fall);
    if (t - last < 45) return;   // drygt 20 bilder per sekund räcker
    // Svag hårdvara: om bilderna kommer för glest får snön ligga still.
    if (last && t - last > 160 && document.visibilityState !== 'hidden') slow++;
    if (slow > 25) { cancelAnimationFrame(raf); return; }
    const dt = Math.min(t - last, 200) / 1000; last = t;
    for (const f of flakes) { f.y += f.v * dt; if (f.y > h + 4) { f.y = -4; f.x = Math.random() * w; } }
    paint(t);
  };
  drawSky = () => {
    cancelAnimationFrame(raf); size();
    const theme = state.theme || {};
    if (!theme.advent) { stars(); return; }
    const u = unitPx();
    flakes = Array.from({ length: Math.round(w * h * 0.00006) }, () => ({
      x: Math.random() * w, y: Math.random() * h, ph: Math.random() * 6.28,
      r: u * (0.05 + Math.random() * 0.11), v: u * (0.7 + Math.random() * 1.5), a: (0.3 + Math.random() * 0.5).toFixed(2),
    }));
    frame = 0; last = 0; slow = 0; paint(0); raf = requestAnimationFrame(fall);
  };
  drawSky();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { drawSky(); renderLights(); renderCaps(); }, 200); });
}

/* ------------------------------------------------------------------- data */
async function loadJson(path, optional = false) {
  // Timeouten är en egen timer: AbortController saknas före Chromium 66, och
  // en hämtning som hänger skulle annars aldrig nå återförsöken.
  const ctl = window.AbortController ? new AbortController() : null;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => { if (ctl) ctl.abort(); reject(new Error(`${path}: timeout`)); }, FETCH_TIMEOUT_MS);
  });
  const load = async () => {
    const res = await fetch(`${path}?v=${Date.now()}`, ctl ? { cache: 'no-store', signal: ctl.signal } : { cache: 'no-store' });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
  try {
    return await Promise.race([load(), timeout]);
  } catch (err) {
    if (optional) return null;
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/* Börsens klocka i tävlingens tidszon, oberoende av TV:ns egen tidszon. */
function marketClock(c) {
  const now = new Date(), timeZone = c.timezone;
  const weekday = now.toLocaleDateString('en-GB', { timeZone, weekday: 'short' });
  const [hour, minute] = now.toLocaleTimeString('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hour12: false }).split(':').map(Number);
  return { weekend: weekday === 'Sat' || weekday === 'Sun', minutes: hour * 60 + minute };
}

/* ------------------------------------------------------------------ huvud */
function renderHead() {
  const d = state.data, c = d.competition;
  // Säsongen tar undertitelns plats: en längre rad tränger ihop ledarpillen.
  const th = state.theme;
  $('#tv-sub').textContent = th.nobel ? 'Nobeldagen' : th.advent ? `${ordinal(th.advent)} advent` : c.subtitle || '';

  const fmtD = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' });
  // Bara dagnumret: datumet står redan på grafens x-axel, och huvudet är trångt.
  $('#tv-day').textContent = d.dates.length ? String(d.dates.length) : 'Före start';
  $('#tv-count').textContent = `${competitors().length} tävlande${d.state === 'live' && d.dates.length >= 6 ? ' · pilar: veckan' : ''}`;

  const lead = $('#tv-lead'); lead.innerHTML = '';
  const top = ranked()[0];
  if (!top || top.pct == null) {
    lead.append(el('span', 'lab', d.state === 'pre' ? 'Startskott' : 'Väntar på öppning'), el('span', 'co', `${fmtD(c.startDate)} → ${fmtD(c.endDate)}`));
    return;
  }
  const pct = el('span', 'pct', pctFmt(top.pct)); pct.style.color = upDown(top.pct);
  lead.append(el('span', 'lab', d.state === 'ended' ? (d.provisional ? 'Preliminär segrare' : 'Segrare') : 'I ledning'),
    nameWithAvatar('who', top, true), el('span', 'co', leadNote(top)), pct);
  fitLead();
}

/* Avståndet till tvåan skrivs kortare när hela meningen inte får plats. */
function fitLead() {
  const co = $('#tv-lead .co'), r = ranked();
  if (!co || !state.data || state.data.state === 'ended' || !r[1] || r[1].pct == null) return;
  co.textContent = leadNote(r[0]);
  if (co.clientWidth && co.scrollWidth > co.clientWidth + 1) co.textContent = `+${nf(1).format(r[0].pct - r[1].pct)} pe`;
}

/* Pillen ska säga något tabellens första rad inte redan säger: avståndet. */
function leadNote(top) {
  const next = ranked()[1];
  return state.data.state === 'ended' || !next || next.pct == null
    ? top.company : `${nf(1).format(top.pct - next.pct)} pe före ${next.name}`;
}

function nameWithAvatar(cls, p, leader) {
  const n = el('span', cls), a = el('span', 'av'); a.append(avatarImg(p.avatar));
  n.append(leader ? decorate(a) : a, ` ${p.name}`);
  return n;
}

const isTradingHours = (clock) => !clock.weekend && clock.minutes >= 9 * 60 && clock.minutes <= 17 * 60 + 30;

/* Dagens vinnare: störst kursrörelse senaste handelsdagen bland de tävlande.
   Visas bara vid uppgång, och döljs efter finalen när dagsrörelsen saknas. */
function renderDayWinner() {
  const d = state.data, box = $('#tv-daywin'), sub = $('.tv-h-row .tv-h span');
  box.innerHTML = '';
  const c = competitors().filter((p) => !p.pending && !p.stale && p.dayChangePct != null);
  const w = c.length ? c.reduce((a, b) => (b.dayChangePct > a.dayChangePct ? b : a)) : null;
  box.hidden = !w || w.dayChangePct <= 0 || d.state === 'ended';
  sub.hidden = !box.hidden;   // undertiteln får sällan plats bredvid rutan
  if (box.hidden) return;
  // Efter midnatt och på helgen gäller siffran en tidigare dag: säg vilken.
  const tz = { timeZone: d.competition.timezone };
  const last = w.lastTrade ? new Date(w.lastTrade * 1000) : null;
  const today = !last || last.toLocaleDateString('sv-SE', tz) === new Date().toLocaleDateString('sv-SE', tz);
  const label = today ? (state.theme.nobel ? 'Dagens pristagare' : 'Dagens vinnare')
    : `Vinnare ${last.toLocaleDateString('sv-SE', Object.assign({ day: 'numeric', month: 'short' }, tz))}`;
  box.append(el('span', 'lab', label), nameWithAvatar('who', w), el('span', 'pct', pctFmt(w.dayChangePct)));
}

/* Allt som ändras med klockan, inte med datan. Körs på en egen timer så att
   en skärm utan nät inte står kvar på "Öppen" över en helg. */
function renderStatus() {
  const d = state.data, c = d.competition, now = new Date(), gen = new Date(d.generatedAt);
  const nowSec = now.getTime() / 1000;
  const open = d.session && nowSec >= d.session.start && nowSec <= d.session.end;
  const m = $('#tv-market'); m.textContent = open ? 'Öppen' : 'Stängd'; m.className = open ? 'is-open' : 'is-shut';

  const tz = (o) => Object.assign({ timeZone: c.timezone }, o);
  const time = gen.toLocaleTimeString('sv-SE', tz({ hour: '2-digit', minute: '2-digit' }));
  const today = gen.toLocaleDateString('sv-SE', tz()) === now.toLocaleDateString('sv-SE', tz());
  const synced = today ? time : `${gen.toLocaleDateString('sv-SE', tz({ day: 'numeric', month: 'short' }))} ${time}`;

  const clock = marketClock(c);
  const stale = !PREVIEW && d.state === 'live' && isTradingHours(clock) && (now - gen) / 60000 > STALE_MIN;
  const warning = state.fetchFails >= 2 ? `Ingen kontakt med servern. Visar data från ${synced}.`
    : stale ? `Datan har inte uppdaterats sedan ${synced}.` : '';

  const s = $('#tv-synced'); s.textContent = synced; s.classList.toggle('is-stale', Boolean(warning));
  const banner = $('#tv-stale'); banner.textContent = warning; banner.hidden = !warning;

  // Sista dagen räknas ned till stängning i stället för i dagar.
  const msLeft = new Date(c.endDate + 'T17:30:00+01:00') - now;
  const finalDay = d.state === 'live' && now.toLocaleDateString('sv-SE', tz()) === c.endDate;
  const min = Math.ceil(msLeft / 60000);
  $('#tv-left-label').textContent = finalDay && msLeft > 0 ? 'Stänger om' : 'Kvar';
  $('#tv-left').textContent = d.state === 'ended' ? (d.provisional ? 'Preliminärt' : 'Avgjort')
    : finalDay && msLeft > 0 ? `${Math.floor(min / 60)} h ${min % 60} min`
      : msLeft > 0 ? `${Math.ceil(msLeft / 86400000)} d` : 'Sista dagen';
}

/* En TV står på i veckor och får annars aldrig ny kod. Ladda bara om när sidan
   går att nå, annars byts en fungerande vy mot webbläsarens felsida. */
let lastReloadCheck = 0;
async function reloadIfReachable() {
  // Tidsspärr, inte flagga: ett anrop som aldrig avslutas får inte stoppa senare kontroller.
  if (Date.now() - lastReloadCheck < 10 * 60 * 1000) return;
  lastReloadCheck = Date.now();
  try {
    const res = await fetch(location.href, { method: 'HEAD', cache: 'no-store' });
    if (res.ok) location.reload();
  } catch (err) { /* försöker igen vid nästa kontroll */ }
}

/* Helst på natten, men en TV som sover 03–04 ska också få ny kod: efter ett
   dygn räcker det att börsen är stängd, och efter två dygn laddas sidan om ändå. */
function nightlyReload() {
  const clock = marketClock(state.data.competition), ageH = (Date.now() - LOADED_AT) / 3600000;
  const night = clock.minutes >= 3 * 60 && clock.minutes < 4 * 60;
  if ((night && ageH > 2) || (ageH > 26 && !isTradingHours(clock)) || ageH > 48) reloadIfReachable();
}

/* ---------------------------------------------------------------- diagram
   Etiketter vid linjeslutet i stället för legend: på en TV ska namnet stå
   där ögat redan är. En enkel "dodge" skjuter isär etiketter som krockar. */
/* När resultatet är avgjort ersätts grafen av en pall. */
function renderPodium(panel) {
  const pod = el('div', 'podium'), h = el('h3', null, 'Slutresultat'), steps = el('div', 'steps');
  h.append(el('span', null, state.data.competition.subtitle || ''));
  const top = ranked().slice(0, 3);
  [[1, 'p2'], [0, 'p1'], [2, 'p3']].forEach(([i, cls]) => {
    const p = top[i], step = el('div', 'step ' + cls), who = el('div', 'who');
    const av = el('span', 'av'); av.append(avatarImg(p.avatar));
    who.append(i === 0 ? decorate(av) : av, el('div', 'name', p.name), el('div', 'co', p.company), el('div', 'pct', pctFmt(p.pct)));
    step.append(who, el('div', 'block', String(i + 1))); steps.append(step);
  });
  pod.append(h, steps); panel.append(pod);
}

function renderChart() {
  const svg = $('#tv-chart'); svg.innerHTML = '';
  const panel = svg.parentElement, head = $('.tv-h-row'), oldPodium = $('.podium');
  if (oldPodium) oldPodium.remove();
  const decided = state.data.state === 'ended' && !state.data.provisional && ranked().filter((p) => p.pct != null).length >= 3;
  svg.style.display = head.style.display = decided ? 'none' : '';
  if (decided) { renderPodium(panel); return; }
  // Startpunkt: baslinjen på 0 % före dag 1, så alla linjer utgår från samma origo.
  const START = '__start';
  const dates = state.data.dates.length ? [START, ...state.data.dates] : [];
  const active = state.data.participants.filter((p) => p.ok && p.series.length && p.baseline != null);
  const r = svg.getBoundingClientRect(); const W = Math.max(400, r.width), H = Math.max(240, r.height);
  const u = parseFloat(getComputedStyle(svg).fontSize);   // layoutens enhet --u i px
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('preserveAspectRatio', 'none');

  if (!dates.length || !active.length) {
    const t = mk('text', { x: W / 2, y: H / 2, 'text-anchor': 'middle', class: 'axis-text' });
    t.textContent = 'Grafen tänds efter första handelsdagens öppning.'; svg.append(t); return;
  }

  const PAD = { t: Math.round(u * 0.94), r: Math.round(u * 11), b: Math.round(u * 1.9), l: Math.round(u * 3.8) };
  const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
  let lo = 0, hi = 0;
  for (const p of active) for (const s of p.series) { lo = Math.min(lo, s.p); hi = Math.max(hi, s.p); }
  const span = Math.max(hi - lo, 1); lo -= span * 0.12; hi += span * 0.12;
  const x = (i) => PAD.l + (dates.length === 1 ? iw : (i / (dates.length - 1)) * iw);
  const y = (v) => PAD.t + ih - ((v - lo) / (hi - lo)) * ih;

  // Jämna steg, och noll märkt som start: värdena ska gå att läsa på håll.
  const stepV = [10, 20, 25, 50, 100].find((s) => (hi - lo) / s <= 6) || 200;
  for (let v = Math.ceil(lo / stepV) * stepV; v <= hi; v += stepV) {
    const yy = y(v);
    svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: yy, y2: yy, class: 'grid-line' }));
    const l = mk('text', { x: PAD.l - u * 0.5, y: yy + u * 0.2, class: 'axis-text', 'text-anchor': 'end' });
    l.textContent = v === 0 ? 'Start' : (v > 0 ? '+' : '−') + Math.abs(v) + '%'; svg.append(l);
  }
  if (lo < 0 && hi > 0) svg.append(mk('line', { x1: PAD.l, x2: W - PAD.r, y1: y(0), y2: y(0), class: 'zero-line' }));
  const step = Math.max(1, Math.ceil(dates.length / Math.min(8, Math.max(2, Math.floor(iw / (u * 5.4))))));
  for (let i = 0; i < dates.length; i += step) {
    const t = mk('text', { x: x(i), y: H - u * 0.42, class: 'axis-text', 'text-anchor': 'middle' });
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
  const MIN = Math.max(u * 1.45, H * 0.052), minY = PAD.t + 8, maxY = H - PAD.b - 6;
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
    g.append(mk('path', { d: `M${l.x + 6} ${l.capY} L${kx} ${l.capY} L${W - PAD.r + u * 0.625} ${l.y}`,
      fill: 'none', stroke: l.p.color, 'stroke-width': 1, opacity: .5 }));
    const size = Math.round(u * 1.25), labelX = W - PAD.r + u * 1.04;
    const icon = mk('image', { x: labelX, y: l.y - size / 2, width: size, height: size, href: emojiSrc(l.p.avatar) });
    const name = mk('text', { x: labelX + size + u * 0.31, y: l.y + u * 0.2, fill: l.p.color, class: 'end-label' });
    name.textContent = l.p.name;
    g.append(icon, name); svg.append(g);
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

/* Placering per deltagare en given dag, för pilar och statistik. */
const raced = () => competitors().filter((p) => !p.pending && p.series.length);
const valueOn = (p, date) => { const s = p.series.find((x) => x.d === date); return s ? s.p : null; };
function ranksOn(date) {
  const out = {};
  raced().map((p) => [p.id, valueOn(p, date)]).filter((x) => x[1] != null)
    .sort((a, b) => b[1] - a[1]).forEach((x, i) => { out[x[0]] = i + 1; });
  return out;
}

/* Placeringar skiftar sällan på en dag, så pilarna jämför med för en vecka sedan. */
function weekMoves() {
  const dates = state.data.dates, out = {};
  if (state.data.state !== 'live' || dates.length < 6) return out;
  const then = ranksOn(dates[dates.length - 6]);
  ranked().forEach((p, i) => { if (p.pct != null && then[p.id]) out[p.id] = then[p.id] - (i + 1); });
  return out;
}

function renderBoard() {
  const board = $('#tv-board'); board.innerHTML = '';
  const moves = weekMoves();
  const list = ranked(), bench = benchmarkOf();
  const rows = bench ? [...list, bench] : list;
  rows.forEach((p, i) => {
    const isBench = p.benchmark, idx = isBench ? -1 : i;
    const li = el('li', 'tv-row' + (idx === 0 && p.pct != null ? ' is-leader' : '') + (isBench ? ' is-benchmark' : '') + (p.pending ? ' is-pending' : ''));
    const rank = el('span', 'rank', isBench ? 'REF' : p.pct == null ? '–' : String(idx + 1).padStart(2, '0'));
    if (isBench) rank.classList.add('rank-ref'); else if (p.pct != null && idx < 3) rank.classList.add('rank-medal', `rank-${idx + 1}`);
    const who = el('div', 'who');
    who.append(el('div', 'who-name', p.name), el('div', 'who-co' + (p.pending ? ' is-pending' : ''), p.pending ? 'Aktie ej vald ännu' : p.company));
    if (moves[p.id]) rank.append(el('span', 'mv ' + (moves[p.id] > 0 ? 'up' : 'down'), String(Math.abs(moves[p.id]))));
    const right = el('div');
    const pct = el('div', 'pct'); pct.textContent = pctFmt(p.pct); pct.style.color = upDown(p.pct);
    const dayClass = !p.stale && p.dayChangePct ? (p.dayChangePct > 0 ? ' up' : ' down') : '';
    const day = el('div', 'day' + dayClass, p.stale ? 'senast kända kurs' : p.dayChangePct == null ? '' : `idag ${pctFmt(p.dayChangePct)}`);
    right.append(pct, day);
    const avatar = el('span', 'avatar'); avatar.append(avatarImg(p.avatar));
    if (idx === 0 && p.pct != null) decorate(avatar);
    li.append(rank, avatar, who, right, sparkline(p));
    board.append(li);
  });
}

/* -------------------------------------------------------- berättelseraden
   Stillastående meningar som går att läsa i förbigående: börshändelser varvas
   med tävlingens berättelser. Meningar om enskilda personer är positiva eller
   neutrala; ingen lyfts fram för att ligga sist. */
const shortName = (p) => p.company.split(' ')[0];
const signed = (v) => ({ cls: v >= 0 ? 'pos' : 'neg', text: pctFmt(v) });
const mondayOf = (iso) => { const t = new Date(iso + 'T12:00:00Z'); return new Date(t - ((t.getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10); };

/* Veckornas utveckling, räknad mot föregående veckas sista stängning. */
function weekResults() {
  const groups = [];
  state.data.dates.forEach((d) => {
    const m = mondayOf(d);
    if (!groups.length || groups[groups.length - 1].m !== m) groups.push({ m, days: [] });
    groups[groups.length - 1].days.push(d);
  });
  return groups.map((g, i) => {
    const ref = i ? groups[i - 1].days[groups[i - 1].days.length - 1] : null, end = g.days[g.days.length - 1];
    const res = raced().map((p) => {
      const a = ref ? valueOn(p, ref) : 0, b = valueOn(p, end);
      return a == null || b == null ? null : { p, r: ((1 + b / 100) / (1 + a / 100) - 1) * 100 };
    }).filter(Boolean).sort((x, y) => y.r - x.r);
    res.monday = g.m;
    return res;
  });
}

function contestFrames(L) {
  const frames = [], byId = (id) => state.data.participants.find((p) => p.id === id);
  const leaders = state.data.dates.map((d) => { const r = ranksOn(d); return Object.keys(r).find((k) => r[k] === 1); });
  const days = {}; let changes = 0, streak = 0;
  leaders.forEach((id, i) => { if (i && id !== leaders[i - 1]) changes++; days[id] = (days[id] || 0) + 1; });
  for (let i = leaders.length - 1; i >= 0 && leaders[i] === leaders[leaders.length - 1]; i--) streak++;
  const most = Object.keys(days).sort((a, b) => days[b] - days[a])[0];
  const ended = state.data.state === 'ended';
  if (most) frames.push({ chip: 'Ledningen', cls: '', parts: ended
    ? [`${changes} ledarbyten under tävlingen · flest dagar som etta: `, { b: byId(most).name }, ` (${days[most]})`]
    : [`${L.name} leder `, { b: `${streak}:e dagen i rad` }, ` · ${changes} ledarbyten hittills · flest dagar som etta: ${byId(most).name} (${days[most]})`] });

  let rec = null;
  if (!ended) raced().forEach((p) => {
    const s = p.series, last = s[s.length - 1].p, high = last > Math.max(...s.slice(0, -1).map((x) => x.p));
    let up = 0; for (let i = s.length - 1; i > 0 && s[i].c > s[i - 1].c; i--) up++;
    const score = (high ? 10 : 0) + up;
    if (s.length > 10 && score >= 3 && (!rec || score > rec.score)) rec = { p, last, high, up, score };
  });
  if (rec) frames.push({ chip: 'Rekord', cls: 'c-rec', parts: [{ b: rec.p.name }, rec.high ? ` på ny toppnivå, ${pctFmt(rec.last)}` : '', rec.up >= 2 ? `${rec.high ? ' · ' : ' '}${rec.up} plusdagar i rad` : ''] });

  const weeks = weekResults(), wins = {};
  (ended ? weeks : weeks.slice(0, -1)).forEach((w) => { if (w[0]) wins[w[0].p.id] = (wins[w[0].p.id] || 0) + 1; });
  const tally = Object.keys(wins).sort((a, b) => wins[b] - wins[a]).slice(0, 3).map((id) => `${byId(id).name} ${wins[id]}`).join(', ');
  const cur = weeks[weeks.length - 1];
  if (!ended && cur && cur[0] && cur[0].r > 0) frames.push({ chip: 'Veckans etapp', cls: 'c-week', parts: [{ b: cur[0].p.name }, ` leder veckan med ${pctFmt(cur[0].r)}`, tally ? ` · etappsegrar: ${tally}` : ''] });
  else if (tally) frames.push({ chip: 'Etappsegrar', cls: 'c-week', parts: [tally] });
  return frames;
}

function pressFrames(tz, dayIso) {
  const cutoff = Date.now() - PRESS_MAX_DAYS * 86400000, newest = [];
  raced().forEach((p) => {
    const n = ((state.news[p.id] || {}).items || []).filter((x) => x.published && Date.parse(x.published) > cutoff)[0];
    if (n) newest.push({ p, n });
  });
  newest.sort((a, b) => b.n.published.localeCompare(a.n.published));
  return newest.slice(0, 3).map(({ p, n }) => {
    const t = new Date(n.published), sameDay = t.toLocaleDateString('sv-SE', tz()) === dayIso;
    const when = sameDay ? `kl. ${t.toLocaleTimeString('sv-SE', tz({ hour: '2-digit', minute: '2-digit' }))}`
      : t.toLocaleDateString('sv-SE', tz({ day: 'numeric', month: 'short' })).replace('.', '');
    const parts = [{ b: shortName(p) }];
    // Bara om aktien handlats i dag: före öppning är dagsrörelsen gårdagens.
    const tradedToday = p.lastTrade && new Date(p.lastTrade * 1000).toLocaleDateString('sv-SE', tz()) === dayIso;
    if (sameDay && tradedToday && p.dayChangePct != null) parts.push(' ', signed(p.dayChangePct), ' i dag');
    parts.push(' · ', { cls: 'when', text: `${when}:` }, ` ${n.title}`);
    return { chip: n.source, cls: n.source === 'Kurspåverkande' ? 'c-mar' : n.source === 'Rapport' ? 'c-rep' : 'c-pm', parts };
  });
}

function marketFrame(tz, dayIso) {
  const m = state.data.market;
  const movers = raced().filter((p) => p.dayChangePct != null && !p.stale)
    .sort((a, b) => Math.abs(b.dayChangePct) - Math.abs(a.dayChangePct)).slice(0, 3);
  if (!m || !movers.length) return null;
  const label = m.date === dayIso ? 'Börsen i dag'
    : `Börsen ${new Date(m.date + 'T12:00:00Z').toLocaleDateString('sv-SE', tz({ day: 'numeric', month: 'short' })).replace('.', '')}`;
  const parts = [`${m.name} `, signed(m.pct), ' · störst rörelse bland våra aktier: '];
  movers.forEach((p, i) => parts.push(`${i ? ', ' : ''}${shortName(p)} `, signed(p.dayChangePct)));
  return { chip: label, cls: 'c-mkt', parts };
}

const dayMonth = (iso) => new Date(iso + 'T12:00:00Z').toLocaleDateString('sv-SE', { day: 'numeric', month: 'short' }).replace('.', '');
const isoWeek = (iso) => {
  const t = new Date(iso + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - y0) / 864e5 - 3 + ((y0.getUTCDay() + 6) % 7)) / 7);
};
const dayMoves = (p) => p.series.slice(1).map((s, i) => ({ d: s.d, r: (s.c / p.series[i].c - 1) * 100 }));

/* Julkalendern: en lucka per dag 1–24 december med ett nedslag i tävlingen. */
function luckaFrame(n) {
  const R = raced().filter((p) => p.pct != null && p.series.length > 1);
  if (!n || !R.length || state.data.state !== 'live') return null;
  const facts = [
    () => {
      let best = null;
      R.forEach((p) => dayMoves(p).forEach((m) => { if (!best || m.r > best.r) best = { p, r: m.r, d: m.d }; }));
      return best && best.r > 0 ? ['Tävlingens bästa dag hittills: ', { b: best.p.name }, ' med ', signed(best.r), ` den ${dayMonth(best.d)}`] : null;
    },
    () => {
      const avg = R.reduce((a, p) => a + p.pct, 0) / R.length, plus = R.filter((p) => p.pct > 0).length;
      return avg > 0 ? [`De ${R.length} aktierna har i snitt gått `, signed(avg), ` sedan start · ${plus} av ${R.length} ligger på plus`] : null;
    },
    () => {
      let best = null;
      weekResults().forEach((w) => { if (w[0] && (!best || w[0].r > best.r)) best = { p: w[0].p, r: w[0].r, m: w.monday }; });
      return best && best.r > 0 ? ['Bästa veckan hittills: ', { b: best.p.name }, ' med ', signed(best.r), ` vecka ${isoWeek(best.m)}`] : null;
    },
    () => {
      let best = null;
      R.forEach((p) => { let run = 0; dayMoves(p).forEach((m) => { run = m.r > 0 ? run + 1 : 0; if (!best || run > best.n) best = { p, n: run }; }); });
      return best && best.n >= 3 ? ['Längsta plussviten hittills: ', { b: best.p.name }, ` med ${best.n} börsdagar i rad`] : null;
    },
    () => {
      let best = null;
      R.forEach((p) => p.series.forEach((s) => { if (!best || s.p > best.v) best = { p, v: s.p, d: s.d }; }));
      return best && best.v > 0 ? ['Högsta noteringen under tävlingen: ', { b: best.p.name }, ' på ', signed(best.v), ` den ${dayMonth(best.d)}`] : null;
    },
    () => {
      const bench = benchmarkOf(), beat = bench && bench.pct != null ? R.filter((p) => p.pct > bench.pct).length : 0;
      return beat ? [{ b: `${beat} av ${R.length}` }, ` slår ${bench.name} just nu`] : null;
    },
  ];
  for (let k = 0; k < facts.length; k++) {
    const parts = facts[(n - 1 + k) % facts.length]();
    if (parts) return { chip: `Lucka ${n}`, cls: 'c-xmas', parts };
  }
  return null;
}

/* Nobeldagen: sex priser till sex olika deltagare. */
function nobelFrames(L, tz, dayIso) {
  const R = raced().filter((p) => p.pct != null && p.series.length > 1), taken = {}, out = [];
  const award = (title, list, why) => {
    const w = list.filter((x) => !taken[x.p.id]).sort((a, b) => b.v - a.v)[0];
    if (!w) return;
    taken[w.p.id] = true;
    out.push({ chip: 'Nobeldagen', cls: 'c-nobel', parts: [{ b: title }, ' till ', { b: w.p.name }, ' · '].concat(why(w)) });
  };
  award('Ekonomipriset', [{ p: L, v: L.pct }], (w) => ['för störst avkastning sedan start, ', signed(w.v)]);
  award('Fysikpriset', R.filter((p) => !p.stale && p.dayChangePct > 0).map((p) => ({ p, v: p.dayChangePct })),
    (w) => [`för ${w.p.lastTrade && new Date(w.p.lastTrade * 1000).toLocaleDateString('sv-SE', tz()) === dayIso ? 'dagens' : 'senaste börsdagens'} kraftigaste acceleration, `, signed(w.v)]);
  const weeks = weekResults(), cur = weeks[weeks.length - 1] || [];
  award('Kemipriset', cur.filter((x) => x.r > 0).map((x) => ({ p: x.p, v: x.r })), (w) => ['för veckans bästa reaktion, ', signed(w.v)]);
  award('Medicinpriset', R.map((p) => ({ p, v: p.series[p.series.length - 1].p - Math.min.apply(null, p.series.map((s) => s.p)) })).filter((x) => x.v > 0),
    (w) => [`för bästa återhämtningen, ${nf(0).format(w.v)} procentenheter upp från botten`]);
  award('Litteraturpriset', R.map((p) => ({ p, v: Math.max.apply(null, [0].concat(((state.news[p.id] || {}).items || []).map((x) => (x.title || '').length))) })).filter((x) => x.v > 0),
    (w) => [`för ${shortName(w.p)}${/s$/i.test(shortName(w.p)) ? '' : 's'} längsta rubrik, ${w.v} tecken`]);
  award('Fredspriset', R.filter((p) => p.series.length > 10).map((p) => {
    const m = dayMoves(p).map((x) => x.r), mean = m.reduce((a, b) => a + b, 0) / m.length;
    return { p, v: -Math.sqrt(m.reduce((a, b) => a + (b - mean) * (b - mean), 0) / m.length) };
  }), () => ['för tävlingens lugnaste kurs']);
  return out;
}

function tradingDaysLeft(dayIso, endIso) {
  let n = 0;
  for (let t = Date.parse(dayIso + 'T12:00:00Z'), end = Date.parse(endIso + 'T12:00:00Z'); t <= end; t += 864e5) {
    const wd = new Date(t).getUTCDay(); if (wd !== 0 && wd !== 6) n++;
  }
  return n;
}

function buildFrames() {
  const d = state.data, c = d.competition, r = ranked().filter((p) => p.pct != null);
  if (r.length < 2 || !d.dates.length) return [];
  const L = r[0], R = r[1];
  const tz = (o) => Object.assign({ timeZone: c.timezone }, o), now = new Date(), dayIso = now.toLocaleDateString('sv-SE', tz());
  const contest = contestFrames(L);
  if (d.state === 'ended') {
    return [{ chip: d.provisional ? 'Preliminärt' : 'Final', cls: 'c-final', parts: d.provisional
      ? [{ b: L.name }, ` leder preliminärt med ${pctFmt(L.pct)}, slutkurserna bekräftas`]
      : [{ b: L.name }, ` vinner ${c.subtitle || 'tävlingen'} med ${pctFmt(L.pct)}`] }].concat(contest);
  }
  const need = ((1 + L.pct / 100) / (1 + R.pct / 100) - 1) * 100;
  const chase = [{ b: R.name }, ` tar ledningen om ${shortName(R)} går `, { b: `${nf(1).format(need)} %` }, ` bättre än ${shortName(L)}`];
  const left = tradingDaysLeft(dayIso, c.endDate), closed = now > new Date(c.endDate + 'T17:30:00+01:00');
  const duel = left === 1
    ? { chip: 'Sista dagen', cls: 'c-final', parts: [closed ? 'Börsen har stängt · ' : 'Börsen stänger 17:30 · '].concat(chase) }
    : left <= 10
      ? { chip: 'Slutspurt', cls: 'c-final', parts: [`${left} handelsdagar kvar · `].concat(chase) }
      : { chip: 'Duellen', cls: 'c-duel', parts: chase };
  const press = pressFrames(tz, dayIso);
  const base = [marketFrame(tz, dayIso), luckaFrame(state.theme.lucka), press[0], duel, press[1], contest[0], press[2]].concat(contest.slice(1)).filter(Boolean);
  if (!state.theme.nobel) return base;
  // Nobeldagen: vartannat pris, varannan vanlig mening.
  const prizes = nobelFrames(L, tz, dayIso), out = [];
  for (let i = 0; i < Math.max(prizes.length, base.length); i++) { if (prizes[i]) out.push(prizes[i]); if (base[i]) out.push(base[i]); }
  return out;
}

function drawStory(i) {
  const box = $('#tv-story'), frames = state.frames, f = frames[i];
  box.innerHTML = ''; state.storyIndex = i;
  const text = el('span', 'text');
  f.parts.forEach((part) => text.append(typeof part === 'string' ? document.createTextNode(part)
    : part.b ? el('b', null, part.b) : el('span', part.cls, part.text)));
  const dots = el('span', 'dots'); frames.forEach((_, k) => dots.append(el('i', k === i ? 'on' : null)));
  box.append(el('span', 'chip ' + f.cls, f.chip), text, dots);
}
const storyIndexNow = () => (QS.has('ruta') ? Number(QS.get('ruta')) || 0 : Math.floor(Date.now() / STORY_MS)) % state.frames.length;

function renderStory() {
  state.frames = buildFrames();
  const box = $('#tv-story'); box.hidden = !state.frames.length;
  if (state.frames.length) drawStory(storyIndexNow());
}

/* Byter mening med en kort övertoning. Klockan styr, inte när sidan laddades. */
function tickStory() {
  if (state.frames.length < 2) return;
  const i = storyIndexNow(), box = $('#tv-story');
  if (i === state.storyIndex || box.classList.contains('is-fading')) return;
  box.classList.add('is-fading');
  setTimeout(() => { drawStory(storyIndexNow()); box.classList.remove('is-fading'); }, 400);
}

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
  let standings, news;
  try {
    [standings, news] = await Promise.all([loadJson(file), loadJson('data/news.json', true)]);
  } catch (err) {
    state.fetchFails++;
    if (state.data) renderAll([renderStatus]);
    throw err;
  }
  state.fetchFails = 0;
  state.data = standings;
  if (news) state.news = news.byParticipant || {};
  renderAll([renderStatus, renderHead, renderDayWinner, renderBoard, renderChart, renderStory]);
}

/* En TV kan starta före nätet och har inget tangentbord: försök tills det går. */
async function boot(attempt = 0) {
  try { await refresh(); }
  catch (err) {
    window.__tvStarted = true;   // koden fungerar, felet gäller datan och försöks igen här
    const delay = Math.min(15 * 2 ** attempt, 300);
    $('#boot p').textContent = `Kunde inte läsa kursdata. Försöker igen om ${delay} s.\n\n${err.message}`;
    setTimeout(() => boot(attempt + 1), delay * 1000);
    return;
  }
  start();
}

function start() {
  $('#tv').hidden = false;
  const afterLayout = () => { renderAll([renderChart, renderStory, renderLights, renderCaps, fitLead]); $('#boot').classList.add('is-done'); };
  let done = false;
  requestAnimationFrame(() => { if (!done) { done = true; afterLayout(); } });
  setTimeout(() => { if (!done) { done = true; afterLayout(); } }, 300);   // rAF-strypt miljö
  setInterval(tickStory, 500);
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  setInterval(() => {
    // Vid midnatt kan temat byta: tänd nästa ljus, öppna nästa lucka.
    if (applyTheme()) renderAll([renderHead, renderBoard, renderChart, renderStory]);
    renderAll([renderStatus, renderDayWinner, fitLead, nightlyReload]);
  }, 60 * 1000);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderAll([renderChart, fitLead]), 200); });
  window.__tvStarted = true;
}

starfield();
applyTheme();
boot();
