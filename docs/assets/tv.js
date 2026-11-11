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

const state = { data: null, news: {}, frames: [], storyIndex: -1, fetchFails: 0 };
const competitors = () => state.data.participants.filter((p) => !p.benchmark);
const benchmarkOf = () => state.data.participants.find((p) => p.benchmark) || null;
const ranked = () => competitors().sort((a, b) => {
  if (a.pct == null && b.pct == null) return a.name.localeCompare(b.name, 'sv');
  if (a.pct == null) return 1; if (b.pct == null) return -1; return b.pct - a.pct;
});

/* ------------------------------------------------------------ stjärnfält
   Glesare än huvudsidan och stillastående: rörelse stör i ett kontorslandskap
   och signage-hårdvara är ofta svag. */
function starfield() {
  const cv = $('#starfield'), ctx = cv.getContext('2d');
  const draw = () => {
    const dpr = Math.min(devicePixelRatio || 1, 1.5), w = innerWidth, h = innerHeight;
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.width = w + 'px'; cv.style.height = h + 'px'; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    for (let i = Math.round(w * h * 0.00012); i > 0; i--) {
      ctx.beginPath(); ctx.arc(Math.random() * w, Math.random() * h, 0.4 + Math.random() * 1.2, 0, 6.28);
      ctx.fillStyle = `rgba(206,226,255,${(0.25 + Math.random() * 0.6).toFixed(3)})`; ctx.fill();
    }
  };
  draw();
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(draw, 200); });
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
  $('#tv-sub').textContent = c.subtitle || '';

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
    nameWithAvatar('who', top), el('span', 'co', leadNote(top)), pct);
}

/* Pillen ska säga något tabellens första rad inte redan säger: avståndet. */
function leadNote(top) {
  const next = ranked()[1];
  return state.data.state === 'ended' || !next || next.pct == null
    ? top.company : `${nf(1).format(top.pct - next.pct)} pe före ${next.name}`;
}

function nameWithAvatar(cls, p) {
  const n = el('span', cls); n.append(avatarImg(p.avatar), ` ${p.name}`);
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
  const label = today ? 'Dagens vinnare'
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
    who.append(avatarImg(p.avatar), el('div', 'name', p.name), el('div', 'co', p.company), el('div', 'pct', pctFmt(p.pct)));
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
    return raced().map((p) => {
      const a = ref ? valueOn(p, ref) : 0, b = valueOn(p, end);
      return a == null || b == null ? null : { p, r: ((1 + b / 100) / (1 + a / 100) - 1) * 100 };
    }).filter(Boolean).sort((x, y) => y.r - x.r);
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
  return [marketFrame(tz, dayIso), press[0], duel, press[1], contest[0], press[2]].concat(contest.slice(1)).filter(Boolean);
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
const storyIndexNow = () => Math.floor(Date.now() / STORY_MS) % state.frames.length;

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
  const afterLayout = () => { renderAll([renderChart, renderStory]); $('#boot').classList.add('is-done'); };
  let done = false;
  requestAnimationFrame(() => { if (!done) { done = true; afterLayout(); } });
  setTimeout(() => { if (!done) { done = true; afterLayout(); } }, 300);   // rAF-strypt miljö
  setInterval(tickStory, 500);
  setInterval(() => refresh().catch(() => {}), REFRESH_MS);
  setInterval(() => renderAll([renderStatus, renderDayWinner, nightlyReload]), 60 * 1000);
  let rt; addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => renderAll([renderChart]), 200); });
  window.__tvStarted = true;
}

starfield();
boot();
