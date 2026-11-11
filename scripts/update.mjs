#!/usr/bin/env node
/**
 * Hämtar kursdata (Yahoo Finance) och pressmeddelanden (MFN) för alla
 * deltagare och skriver statiska JSON-filer som sidan läser.
 *
 * Designprincip: skriptet är TILLSTÅNDSLÖST. Hela kurshistoriken räknas om
 * från Yahoos dagsstaplar vid varje körning i stället för att ackumuleras.
 * En misslyckad körning kan därför aldrig lämna hål i grafen — nästa
 * lyckade körning återskapar allt. Enda undantaget är nyheter, som är en
 * flyktig källa och därför cachas mellan körningar.
 *
 * Användning:
 *   node scripts/update.mjs             # kurser + nyheter
 *   node scripts/update.mjs --no-news   # bara kurser (snabbare)
 *   node scripts/update.mjs --validate  # kontrollera att alla tickers finns
 *   node scripts/update.mjs --offline   # nodlage: publicera committad data utan Yahoo
 *   node scripts/update.mjs --preview   # forhandsvisning: kor tavlingen som
 *                                       # om den startat for 90 dagar sedan och
 *                                       # skriver standings.preview.json.
 *                                       # Sidan visar den med ?preview=1.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const CONFIG_PATH = path.join(ROOT, 'config', 'competition.json');
const OVERRIDES_PATH = path.join(ROOT, 'config', 'overrides.json');
const OUT_DIR = path.join(ROOT, 'docs', 'data');

/* Ärlig, beskrivande User-Agent. Detta är avsiktligt och inte ett förbiseende:
   Yahoo svarar 429 på förfalskade Chrome-strängar (en "webbläsare" utan cookies
   och crumb ser ut som skrapning), men släpper igenom en tydligt identifierad
   API-klient. Ärligare *och* stabilare. Ändra inte till en webbläsar-UA. */
const UA = 'AMITInvestors/1.0 (intern aktietavling; +https://github.com/)';

/* Kurerad palett i temats anda: bärnsten, cyan, mint, korall, violett, sand.
   Färgen följer deltagaren genom graf, tabell och dossier. */
const PALETTE = [
  '#ffb454', '#5fe9d0', '#ff7a8a', '#8ab4ff',
  '#c9a7ff', '#b5e26b', '#f4a3d0', '#7ee592',
  '#ff9f6e', '#7fd1ff', '#d9c2a0', '#ffe08a',
];

const args = process.argv.slice(2);
const OFFLINE = args.includes('--offline');
const WANT_NEWS = !args.includes('--no-news') && !OFFLINE;
const VALIDATE_ONLY = args.includes('--validate');
const PREVIEW = args.includes('--preview');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Hämtar med enkel exponentiell backoff — Yahoo strypertillfälligt vid burst. */
async function fetchWithRetry(url, { tries = 4, timeout = 20000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeout);
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: '*/*', 'Accept-Language': 'sv-SE,sv;q=0.9,en;q=0.8' },
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (err) {
      lastErr = err;
      // 429 kräver rejält längre paus än ett vanligt nätverksfel.
      const backoff = /HTTP 429/.test(String(err.message)) ? 5000 * 2 ** i : 700 * 2 ** i;
      if (i < tries - 1) await sleep(backoff);
    }
  }
  throw lastErr;
}

/** Epoch-sekunder -> 'YYYY-MM-DD' i angiven tidszon (inte i runnerns UTC). */
function isoDateIn(tz, epochSeconds) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date(epochSeconds * 1000));
  const g = (t) => parts.find((p) => p.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')}`;
}

const dayStartEpoch = (isoDate) => Math.floor(Date.parse(`${isoDate}T00:00:00Z`) / 1000);

async function fetchChart(ticker, startDate, endDate, tz) {
  // Marginal bakåt/framåt så att baslinjedagen garanterat ryms i intervallet.
  const period1 = dayStartEpoch(startDate) - 7 * 86400;
  const period2 = Math.min(dayStartEpoch(endDate) + 4 * 86400, Math.floor(Date.now() / 1000) + 86400);
  const url =
    `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${period1}&period2=${period2}&interval=1d&includePrePost=false`;

  const res = await fetchWithRetry(url);
  const json = await res.json();
  const result = json?.chart?.result?.[0];
  if (!result?.meta) throw new Error(json?.chart?.error?.description || 'Tom svarsstruktur');

  const meta = result.meta;
  const ts = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  /* Yahoo kan leverera dagens/senaste stapel med open men close=null
     (sett morgonen efter startdagen). Baslinjen behöver bara open, så en
     sådan stapel får inte kastas. Saknas close på den SENASTE stapeln
     används meta-kursen; saknas close på en äldre stapel hoppas punkten
     över i serien men stapeln behålls för baslinjen. */
  const lastTradeDate = meta.regularMarketTime ? isoDateIn(tz, meta.regularMarketTime) : null;
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const open = q.open?.[i];
    let close = q.close?.[i];
    const d = isoDateIn(tz, ts[i]);
    if (d < startDate || d > endDate) continue;
    if (open == null && close == null) continue;   // helgdag/halvdag utan handel
    if (close == null && i === ts.length - 1 && d === lastTradeDate) close = meta.regularMarketPrice ?? null;
    candles.push({ d, o: open ?? close, c: close ?? null });
  }
  return { meta, candles };
}

/* Yahoo har nollat en hel handelsdag i dagsserien dagen efter. En deltagare
   som tillkommer efter det skulle då få fel startlinje. 5-minutersdatan
   överlever restateringen: första stapelns open är dagens öppning, sista
   stapelns close är (så när som på stängningscallen) dagens stängning.
   Returnerar null om dagen inte var en handelsdag — då är nästa dagsstapel
   rätt baslinje och fallbacken ska inte användas. */
async function fetchDayIntraday(ticker, isoDate, tz) {
  const p1 = dayStartEpoch(isoDate) - 6 * 3600, p2 = dayStartEpoch(isoDate) + 30 * 3600;
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}` +
    `?period1=${p1}&period2=${p2}&interval=5m&includePrePost=false`;
  try {
    const json = await (await fetchWithRetry(url)).json();
    const r = json?.chart?.result?.[0];
    const ts = r?.timestamp || [], q = r?.indicators?.quote?.[0] || {};
    let open = null, close = null;
    for (let i = 0; i < ts.length; i++) {
      if (isoDateIn(tz, ts[i]) !== isoDate) continue;
      if (open == null && q.open?.[i] != null) open = q.open[i];
      if (q.close?.[i] != null) close = q.close[i];
    }
    return open == null ? null : { open, close };
  } catch { return null; }
}

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

/* Pressmeddelanden från MFN, där bolagen själva publicerar. Rapporter, order,
   studieresultat och emissioner är det som flyttar kurserna, och de hittas inte
   tillförlitligt via nyhetssökningar. Stämmor, återköp och konferenser sorteras
   bort. Märket :regulatory:mar betyder att bolaget klassat meddelandet som
   insiderinformation enligt MAR, alltså kurspåverkande. */
const PRESS_NOISE = /kallelse|valberedning|investerarkonferens|presenterar vid|presenterar på|deltar i|telefonkonferens|webbsändning|webbpresentation|kommuniké från|stämmokommuniké|återköp|rättelse|inbjudan/i;
const pressKind = (tags) => (tags.includes(':regulatory:mar') ? 'Kurspåverkande'
  : tags.some((t) => t.startsWith('sub:report')) ? 'Rapport' : 'Pressmeddelande');

async function fetchPress(p, limit = 8) {
  const res = await fetchWithRetry(`https://mfn.se/all/a/${encodeURIComponent(p.mfn)}.json?lang=sv&limit=30`);
  const { items = [] } = await res.json();
  return items
    .filter((i) => {
      const tags = i.properties?.tags || [];
      return i.properties?.lang === 'sv' && i.content?.title && !PRESS_NOISE.test(i.content.title)
        && !tags.some((t) => t.startsWith('sub:ci:gm') || t.startsWith('sub:ca:shares:repurchase'));
    })
    .slice(0, limit)
    .map((i) => ({
      title: i.content.title.replace(/^[^:]{3,40} AB: /, ''),
      link: i.url,
      source: pressKind(i.properties.tags || []),
      published: new Date(i.content.publish_date).toISOString(),
    }));
}

/* Sen deltagare: valfritt startDate per person ger baslinje från den dagens
   öppning i stället för tävlingens start. Ett datum före tävlingsstarten
   ignoreras — ingen kan gå in tidigare än alla andra. */
const participantStart = (p, competitionStart) =>
  p.startDate && p.startDate > competitionStart ? p.startDate : competitionStart;

/* Baslinjen pinnas när den först fångats. Nyckeln innehåller ticker och
   startdatum, så ett aktiebyte eller ett ändrat startdatum räknar om — men
   en dålig morgon hos Yahoo gör det inte. Detta är den enda avsiktliga
   avvikelsen från "allt räknas om vid varje körning". */
const BASELINES_PATH = path.join(OUT_DIR, 'baselines.json');
/* Observerade dagsstängningar. Yahoo har restaterat en hel handelsdag till
   null dagen efter; utan egen historik försvann dag 1 ur grafen. Yahoo vinner
   när den har ett värde (rättelser ska slå igenom), historiken fyller hålen. */
const HISTORY_PATH = path.join(OUT_DIR, 'history.json');
const pinKey = (p, start) => `${p.id}|${p.ticker}|${start}`;

async function readJsonIfExists(p) {
  try { return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null; } catch { return null; }
}

const SETTLE_DAYS = 5;

/** Senaste kända stängning på eller före cutoff, eller null. */
function lastClose(closes, cutoff) {
  const last = Object.keys(closes).filter((d) => d <= cutoff).sort().at(-1);
  return last ? closes[last] : null;
}

async function main() {
  const cfg = JSON.parse(await readFile(CONFIG_PATH, 'utf8'));
  const tz = cfg.timezone || 'Europe/Stockholm';
  const today = isoDateIn(tz, Math.floor(Date.now() / 1000));

  // Forhandsvisning: latsas att tavlingen startade for 90 dagar sedan sa att
  // graf, placeringar och dossierer kan granskas innan skarpt lage.
  const startDate = PREVIEW
    ? isoDateIn(tz, Math.floor(Date.now() / 1000) - 90 * 86400)
    : cfg.startDate;
  const endDate = PREVIEW ? today : cfg.endDate;
  const OUT_FILE = PREVIEW ? 'standings.preview.json' : 'standings.json';

  if (VALIDATE_ONLY) {
    let bad = 0;
    for (const p of cfg.participants) {
      if (!p.ticker) { console.log(`  VÄNTAR ${p.name.padEnd(12)} ingen aktie vald ännu`); continue; }
      try {
        const { meta } = await fetchChart(p.ticker, participantStart(p, startDate), endDate, tz);
        console.log(`  OK   ${p.ticker.padEnd(12)} ${meta.longName} — ${meta.regularMarketPrice} ${meta.currency}`);
      } catch (e) {
        bad++;
        console.error(`  FEL  ${p.ticker.padEnd(12)} ${e.message}  (${p.name} / ${p.company})`);
      }
      await sleep(250);
    }
    if (bad) {
      console.error(`\n${bad} ticker(s) gick inte att hämta. Kontrollera symbolen på finance.yahoo.com.`);
      process.exit(1);
    }
    console.log('\nAlla tickers OK.');
    return;
  }

  await mkdir(OUT_DIR, { recursive: true });
  const prevNews = (await readJsonIfExists(path.join(OUT_DIR, 'news.json')))?.byParticipant || {};
  const pins = PREVIEW ? {} : (await readJsonIfExists(BASELINES_PATH)) || {};
  let pinsChanged = false;
  const history = PREVIEW ? {} : (await readJsonIfExists(HISTORY_PATH)) || {};
  // Manuella rättningar går före Yahoo. Ett skrivfel ska synas som en röd körning.
  const overrides = existsSync(OVERRIDES_PATH) ? JSON.parse(await readFile(OVERRIDES_PATH, 'utf8')) : {};
  let historyChanged = false;

  // Efter sista dagen är resultatet avgjort: inget får längre följa marknaden.
  const afterEnd = !PREVIEW && today > endDate;
  // Sista körningen kan ha missats och lämnat en intradagskurs som slutkurs.
  // Den får därför rättas fram till nästa börsdag efter julhelgen, sedan låses den.
  const settleUntil = new Date(Date.parse(`${endDate}T12:00:00Z`) + SETTLE_DAYS * 86400000).toISOString().slice(0, 10);
  const locked = afterEnd && today > settleUntil;

  const participants = [];
  const allDates = new Set();
  let failed = 0;

  const toSeries = (source, baseline, from) => (baseline
    ? Object.keys(source).filter((d) => d >= from && d <= endDate).sort().map((d) => {
        allDates.add(d);
        return { d, c: source[d], p: round((source[d] / baseline - 1) * 100, 3) };
      })
    : []);

  for (const [i, p] of cfg.participants.entries()) {
    const color = p.color || PALETTE[i % PALETTE.length];
    const base = {
      id: p.id, name: p.name, company: p.company || null, ticker: p.ticker || null,
      avatar: p.avatar || '🚀', motto: p.motto || '', about: p.about || '', color,
      // Referensdeltagare: hämtas som alla andra, men rankas inte av klienten.
      benchmark: p.benchmark === true,
      startDate: participantStart(p, startDate),
    };

    // Ingen aktie vald: deltagaren står med, men utan kurs, baslinje eller serie.
    if (!p.ticker) {
      participants.push({
        ...base, ok: true, pending: true, baseline: null, baselineDate: null,
        price: null, currency: 'SEK', pct: null, dayChangePct: null,
        series: [], stats: {}, session: null, lastTrade: null,
      });
      process.stdout.write(`  väntar ${p.name.padEnd(12)} ingen aktie vald ännu\n`);
      continue;
    }

    const key = pinKey(p, base.startDate);
    const corrected = overrides[p.ticker] || {};
    if (!PREVIEW && Object.keys(corrected).length) {
      history[key] ||= {};
      for (const [d, v] of Object.entries(corrected)) {
        if (history[key][d] !== v) { history[key][d] = v; historyChanged = true; }
      }
    }

    try {
      if (OFFLINE) throw new Error('offline');
      const { meta, candles } = await fetchChart(p.ticker, base.startDate, endDate, tz);

      // Baslinje: pinnad om den finns, annars öppningskursen första
      // handelsdagen på eller efter startDate — och då pinnas den.
      let baseline = pins[key]?.baseline ?? null;
      let baselineDate = pins[key]?.baselineDate ?? null;
      let first = candles.find((c) => c.o != null);
      // Saknas startdagen i dagsserien (restaterad till null) men var en
      // handelsdag: hämta öppning och stängning från 5-minutersstaplarna.
      if (baseline == null && (!first || first.d > base.startDate) && base.startDate <= today) {
        const intraday = await fetchDayIntraday(p.ticker, base.startDate, tz);
        if (intraday) {
          process.stdout.write(`  intradag ${p.ticker.padEnd(12)} ${base.startDate} open=${intraday.open} close=${intraday.close}\n`);
          candles.unshift({ d: base.startDate, o: intraday.open, c: intraday.close });
          first = candles[0];
        }
      }
      if (baseline == null && first) {
        baseline = first.o; baselineDate = first.d;
        if (!PREVIEW) { pins[key] = { baseline: round(baseline, 4), baselineDate, pinnedAt: new Date().toISOString() }; pinsChanged = true; }
      }
      // Slå ihop Yahoos stängningar med historiken. Dagens värde skrivs över
      // vid varje körning tills dagen är slut, och konvergerar mot stängningen.
      const hist = history[key] || {};
      for (const c of candles) {
        if (c.c == null || corrected[c.d] != null) continue;
        // Efter finalen får Yahoo bara fylla hål, utom sista dagen under rättelsetiden.
        const correctable = c.d === candles.filter((x) => x.c != null).at(-1).d && today <= settleUntil;
        if (afterEnd && hist[c.d] != null && !correctable) continue;
        const v = round(c.c, 4);
        if (hist[c.d] !== v) { hist[c.d] = v; historyChanged = true; }
      }
      if (!PREVIEW) history[key] = hist;
      const source = PREVIEW ? Object.fromEntries(candles.filter((c) => c.c != null).map((c) => [c.d, round(c.c, 4)])) : hist;
      const series = toSeries(source, baseline, base.startDate);

      // regularMarketPrice är alltid dagens kurs, oavsett begärd period.
      const settled = lastClose(source, endDate);
      const latest = Object.keys(source).filter((d) => d <= endDate).sort().at(-1);
      const price = afterEnd || corrected[latest] != null ? settled : meta.regularMarketPrice ?? candles.at(-1)?.c ?? settled;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;

      participants.push({
        ...base,
        ok: true,
        baseline: round(baseline, 4),
        baselineDate,
        price: round(price, 4),
        currency: meta.currency || 'SEK',
        pct: baseline && price ? round((price / baseline - 1) * 100, 3) : null,
        dayChangePct: afterEnd ? null : round(meta.regularMarketChangePercent, 3)
          ?? (prevClose && price ? round((price / prevClose - 1) * 100, 3) : null),
        series,
        stats: {
          longName: meta.longName || meta.shortName || p.company,
          exchange: meta.fullExchangeName || meta.exchangeName || null,
          dayHigh: round(meta.regularMarketDayHigh, 2),
          dayLow: round(meta.regularMarketDayLow, 2),
          high52: round(meta.fiftyTwoWeekHigh, 2),
          low52: round(meta.fiftyTwoWeekLow, 2),
          volume: meta.regularMarketVolume ?? null,
          previousClose: round(prevClose, 2),
        },
        session: meta.currentTradingPeriod?.regular
          ? { start: meta.currentTradingPeriod.regular.start, end: meta.currentTradingPeriod.regular.end }
          : null,
        lastTrade: meta.regularMarketTime ?? null,
      });
      process.stdout.write(`  kurs  ${p.ticker.padEnd(12)} ${series.length} dagar\n`);
    } catch (err) {
      console.error(`  FEL   ${p.ticker.padEnd(12)} ${err.message}`);
      failed++;
      // En tillfällig störning får inte flytta någon i tabellen: använd
      // senast kända värden så länge baslinje och historik finns.
      const baseline = pins[key]?.baseline ?? null;
      const hist = history[key] || {};
      const price = lastClose(hist, endDate);
      if (baseline != null && price != null) {
        participants.push({
          ...base, ok: true, stale: !locked, error: String(err.message),
          baseline, baselineDate: pins[key].baselineDate ?? null,
          price, currency: 'SEK', pct: round((price / baseline - 1) * 100, 3), dayChangePct: null,
          series: toSeries(hist, baseline, base.startDate), stats: {}, session: null, lastTrade: null,
        });
      } else {
        participants.push({ ...base, ok: false, error: String(err.message), series: [], pct: null, price: null });
      }
    }
    await sleep(300); // var snäll mot en gratis, oofficiell endpoint
  }

  const tickers = cfg.participants.filter((p) => p.ticker).length;
  if (tickers && failed === tickers && !OFFLINE) {
    // Hellre en röd körning och kvarvarande sida än en publicerad tom tavla.
    console.error(`\nAlla ${tickers} kurshämtningar misslyckades. Publicerar inget.`);
    process.exit(1);
  }
  if (failed && !OFFLINE) console.log(`::warning::${failed} av ${tickers} kurser kunde inte hämtas, senast kända värden används.`);

  const state = PREVIEW ? 'live' : today < startDate ? 'pre' : today > endDate ? 'ended' : 'live';

  // Vinnaren utropas först när alla tävlande har en färsk slutkurs för samma sista dag.
  const competing = participants.filter((p) => !p.benchmark && !p.pending);
  const lastDay = (p) => p.series.at(-1)?.d;
  const finalDay = competing.map(lastDay).filter(Boolean).sort().at(-1);
  const provisional = afterEnd && (finalDay !== endDate
    || (!locked && competing.some((p) => p.stale || lastDay(p) !== finalDay)));

  // Borsens oppettider harleds ur handelssessionen i stallet for ett
  // marketState-falt (som chart-endpointen inte skickar). Klienten raknar om
  // detta mot aktuell tid, eftersom JSON-filen kan vara flera timmar gammal.
  const session = participants.find((p) => p.session)?.session || null;
  const nowSec = Math.floor(Date.now() / 1000);
  const marketState = session && nowSec >= session.start && nowSec <= session.end ? 'REGULAR' : 'CLOSED';

  // Börsen som helhet. Stängningar i stället för meta: en saknad stapel ska inte ge fel siffra.
  let market = null;
  if (!afterEnd && !OFFLINE) {
    try {
      const closes = (await fetchChart('^OMX', startDate, endDate, tz)).candles.filter((c) => c.c != null);
      if (closes.length >= 2) {
        const [prev, last] = closes.slice(-2);
        market = { name: 'OMXS30', pct: round((last.c / prev.c - 1) * 100, 2), date: last.d };
      }
    } catch (err) {
      console.error(`  FEL   OMXS30 ${err.message}`);
    }
  }

  const standings = {
    generatedAt: new Date().toISOString(),
    state,
    provisional,
    market,
    marketState,
    session,
    today,
    preview: PREVIEW,
    competition: {
      title: cfg.title, subtitle: cfg.subtitle, tagline: cfg.tagline,
      startDate, endDate, timezone: tz,
    },
    dates: [...allDates].sort(),
    participants,
  };
  await writeFile(path.join(OUT_DIR, OUT_FILE), JSON.stringify(standings, null, 1) + '\n');
  if (pinsChanged) {
    await writeFile(BASELINES_PATH, JSON.stringify(pins, null, 1) + '\n');
    console.log(`Pinnade ${Object.keys(pins).length} baslinjer i baselines.json`);
  }
  if (historyChanged && !PREVIEW) {
    // Dagens värde sparas först efter stängning. Avslutade dagar sparas direkt,
    // så att en missad kväll inte kan tappas när Yahoo senare nollar dagen.
    const closed = Number(new Intl.DateTimeFormat('sv-SE', { timeZone: tz, hour: '2-digit', minute: '2-digit' })
      .format(new Date()).replace(/\D/g, '')) >= 1745;
    const toSave = closed ? history : Object.fromEntries(Object.entries(history).map(([k, h]) =>
      [k, Object.fromEntries(Object.entries(h).filter(([d]) => d < today || overrides[k.split('|')[1]]?.[d] != null))]));
    await writeFile(HISTORY_PATH, JSON.stringify(toSave, null, 1) + '\n');
    const days = new Set(Object.values(history).flatMap((h) => Object.keys(h)));
    console.log(`Uppdaterade history.json (${days.size} handelsdagar)`);
  }
  console.log(`\nSkrev ${OUT_FILE} (${state}, ${standings.dates.length} handelsdagar)`);

  if (WANT_NEWS && !PREVIEW) {
    // Behall bara cachade nyheter for deltagare som fortfarande finns. Byts ett
    // id ut i konfigurationen skulle den gamla posten annars ligga kvar for evigt.
    // Bara deltagare MED aktie behåller cache — den som tagit bort sitt val
    // ska inte visa förra bolagets rubriker.
    const ids = new Set(cfg.participants.filter((p) => p.ticker).map((p) => p.id));
    const byParticipant = Object.fromEntries(
      Object.entries(prevNews).filter(([id]) => ids.has(id))
    );
    for (const p of cfg.participants) {
      if (!p.ticker) continue;
      // Bytt bolag: förra bolagets meddelanden är fel oavsett ålder.
      if (byParticipant[p.id]?.query !== p.mfn) delete byParticipant[p.id];
      if (!p.mfn) continue;
      try {
        const items = await fetchPress(p);
        byParticipant[p.id] = { fetchedAt: new Date().toISOString(), query: p.mfn, items };
        process.stdout.write(`  press ${p.company.padEnd(20)} ${items.length} st\n`);
      } catch (err) {
        // Behåll föregående meddelanden hellre än att tömma raden.
        console.error(`  FEL   press ${p.company}: ${err.message} (behåller cachade)`);
      }
      await sleep(300);
    }
    await writeFile(
      path.join(OUT_DIR, 'news.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), byParticipant }, null, 1) + '\n'
    );
    console.log('Skrev news.json');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
