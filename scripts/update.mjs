#!/usr/bin/env node
/**
 * Hämtar kursdata (Yahoo Finance) och nyheter (Google News RSS) för alla
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
 *   node scripts/update.mjs --force-news # hamta nyheter aven om cachen ar farsk
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
  '#c9a7ff', '#b5e26b', '#f4a3d0', '#6ee7a8',
  '#ff9f6e', '#7fd1ff', '#d9c2a0', '#ffe08a',
];

const args = process.argv.slice(2);
const WANT_NEWS = !args.includes('--no-news');
const VALIDATE_ONLY = args.includes('--validate');
const PREVIEW = args.includes('--preview');
const FORCE_NEWS = args.includes('--force-news');

/* Kurser hämtas var 30:e minut, men nyheter behöver inte det. Att hämta åtta
   RSS-flöden varje körning blir ~380 anrop per dygn till Google News, vilket
   är precis vad som utlöser strypningen. Med fyra timmars hållbarhet blir det
   ~50 — och rubriker som är några timmar gamla är ändå färska nog. */
const NEWS_MAX_AGE_MS = 4 * 60 * 60 * 1000;

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

  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const close = q.close?.[i];
    const open = q.open?.[i];
    if (close == null) continue; // helgdag/halvdag utan avslut
    const d = isoDateIn(tz, ts[i]);
    if (d < startDate || d > endDate) continue;
    candles.push({ d, o: open ?? close, c: close });
  }
  return { meta, candles };
}

const round = (n, dp = 2) => (n == null || !Number.isFinite(n) ? null : Math.round(n * 10 ** dp) / 10 ** dp);

const decodeEntities = (s) =>
  s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d))
   .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
   .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<')
   .replace(/&gt;/g, '>').replace(/&amp;/g, '&').trim();

/* Söknamn för nyheter. Aktieslaget måste bort: frasen "Truecaller B" ger
   nästan bara skräpträffar, medan "Truecaller" ger relevant finanspress.
   Kan överstyras per deltagare med fältet newsQuery i konfigurationen. */
const newsName = (p) => p.newsQuery || p.company.replace(/\s+[A-C]$/, '').trim();

/** Plockar isär ett RSS-svar till artiklar. */
function parseRss(xml) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const pick = (tag) => {
      const r = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(block);
      return r ? decodeEntities(r[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1')) : null;
    };
    const rawTitle = pick('title');
    if (!rawTitle) continue;
    const source = pick('source') || '';
    // Google formaterar rubriker som "Rubrik - Källa"; kapa dubbletten.
    const title = source && rawTitle.endsWith(` - ${source}`)
      ? rawTitle.slice(0, -(source.length + 3))
      : rawTitle;
    const published = pick('pubDate');
    items.push({
      title,
      link: pick('link'),
      source,
      published: published ? new Date(published).toISOString() : null,
    });
  }
  items.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  return items;
}

/** Google News RSS. Vi lagrar rubrik + länk tillbaka till källan, aldrig artikeltext. */
async function fetchNews(participant, limit = 5) {
  // 90 dagars fönster: småbolag som Vitec bevakas för glest för 45 dagar.
  // Vi sorterar ändå nyast först, så välbevakade bolag tappar inget.
  const q = encodeURIComponent(
    `"${newsName(participant)}" (aktie OR bolaget OR rapport OR analys OR kvartal) when:90d`
  );
  const url = `https://news.google.com/rss/search?q=${q}&hl=sv&gl=SE&ceid=SE:sv`;

  /* Google strypter anrop genom att svara HTTP 200 med ett giltigt men TOMT
     flöde — inte med 429. Ett tomt resultat är därför tvetydigt: det kan
     betyda "inga nyheter" eller "du frågar för ofta". Vi behandlar det som
     det senare och försöker igen med växande paus. Exakt samma fråga kan ge
     60 träffar i ett anrop och 0 i nästa. */
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await sleep(3000 * attempt);
    const items = parseRss(await (await fetchWithRetry(url)).text());
    if (items.length) return items.slice(0, limit);
  }
  return [];
}

async function readJsonIfExists(p) {
  try { return existsSync(p) ? JSON.parse(await readFile(p, 'utf8')) : null; } catch { return null; }
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
      try {
        const { meta } = await fetchChart(p.ticker, startDate, endDate, tz);
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

  const participants = [];
  const allDates = new Set();

  for (const [i, p] of cfg.participants.entries()) {
    const color = p.color || PALETTE[i % PALETTE.length];
    const base = {
      id: p.id, name: p.name, company: p.company, ticker: p.ticker,
      avatar: p.avatar || '🚀', motto: p.motto || '', about: p.about || '', color,
      // Referensdeltagare: hämtas som alla andra, men rankas inte av klienten.
      benchmark: p.benchmark === true,
    };

    try {
      const { meta, candles } = await fetchChart(p.ticker, startDate, endDate, tz);

      // Baslinje = öppningskursen första handelsdagen på eller efter startDate.
      const baseline = candles.length ? candles[0].o : null;
      const series = baseline
        ? candles.map((c) => {
            allDates.add(c.d);
            return { d: c.d, c: round(c.c, 4), p: round((c.c / baseline - 1) * 100, 3) };
          })
        : [];

      const price = meta.regularMarketPrice ?? candles.at(-1)?.c ?? null;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;

      participants.push({
        ...base,
        ok: true,
        baseline: round(baseline, 4),
        baselineDate: candles[0]?.d ?? null,
        price: round(price, 4),
        currency: meta.currency || 'SEK',
        pct: baseline && price ? round((price / baseline - 1) * 100, 3) : null,
        dayChangePct: round(meta.regularMarketChangePercent, 3)
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
      participants.push({ ...base, ok: false, error: String(err.message), series: [], pct: null, price: null });
    }
    await sleep(300); // var snäll mot en gratis, oofficiell endpoint
  }

  const state = PREVIEW ? 'live' : today < startDate ? 'pre' : today > endDate ? 'ended' : 'live';

  // Borsens oppettider harleds ur handelssessionen i stallet for ett
  // marketState-falt (som chart-endpointen inte skickar). Klienten raknar om
  // detta mot aktuell tid, eftersom JSON-filen kan vara flera timmar gammal.
  const session = participants.find((p) => p.session)?.session || null;
  const nowSec = Math.floor(Date.now() / 1000);
  const marketState = session && nowSec >= session.start && nowSec <= session.end ? 'REGULAR' : 'CLOSED';

  const standings = {
    generatedAt: new Date().toISOString(),
    state,
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
  console.log(`\nSkrev ${OUT_FILE} (${state}, ${standings.dates.length} handelsdagar)`);

  if (WANT_NEWS && !PREVIEW) {
    // Behall bara cachade nyheter for deltagare som fortfarande finns. Byts ett
    // id ut i konfigurationen skulle den gamla posten annars ligga kvar for evigt.
    const ids = new Set(cfg.participants.map((p) => p.id));
    const byParticipant = Object.fromEntries(
      Object.entries(prevNews).filter(([id]) => ids.has(id))
    );
    for (const p of cfg.participants) {
      const cached = byParticipant[p.id];
      const age = cached?.fetchedAt ? Date.now() - Date.parse(cached.fetchedAt) : Infinity;
      if (!FORCE_NEWS && age < NEWS_MAX_AGE_MS) {
        process.stdout.write(`  nyhet ${p.company.padEnd(20)} cachad (${Math.round(age / 60000)} min)\n`);
        continue;
      }
      try {
        const items = await fetchNews(p);
        if (items.length) {
          byParticipant[p.id] = { fetchedAt: new Date().toISOString(), items };
          process.stdout.write(`  nyhet ${p.company.padEnd(20)} ${items.length} st\n`);
        } else {
          // Behåll cachade rubriker hellre än att tömma panelen.
          const kept = byParticipant[p.id]?.items?.length ?? 0;
          process.stdout.write(`  nyhet ${p.company.padEnd(20)} tomt svar — behåller ${kept} cachade\n`);
        }
      } catch (err) {
        // Behåll föregående nyheter hellre än att tömma panelen.
        console.error(`  FEL   nyheter ${p.company}: ${err.message} (behåller cachade)`);
      }
      await sleep(1400);
    }
    await writeFile(
      path.join(OUT_DIR, 'news.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), byParticipant }, null, 1) + '\n'
    );
    console.log('Skrev news.json');
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
