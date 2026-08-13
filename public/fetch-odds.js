#!/usr/bin/env node
/**
 * fetch-odds.js — attaches real odds and one-tap betslip links to slate.json.
 *
 * WHY THIS EXISTS
 * The app could previously only hand a user text to paste into a betting
 * assistant, which then had to reply with a link. This removes that round trip
 * entirely: The Odds API returns a deep link per outcome that opens the bet
 * already loaded in the sportsbook.
 *
 *   https://sportsbook.fanduel.com/addToBetslip?marketId=...&selectionId=...
 *
 * SETUP
 *   1. Get a key at https://the-odds-api.com  (free tier available)
 *   2. Add repo secret ODDS_API_KEY
 *   3. Run after build-slate.js:
 *        node fetch-odds.js --slate public/slate.json
 *
 * COST CONTROL
 * Player-prop markets are billed per event, so this only requests the markets
 * the app actually grades, and only for today's games. Use --markets to trim
 * further, or --books to limit to the sportsbooks you care about.
 */

import fs from 'node:fs/promises';

const API = 'https://api.the-odds-api.com/v4';
const KEY = process.env.ODDS_API_KEY;

const arg = (f, d = null) => {
  const i = process.argv.indexOf(f);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const SLATE = arg('--slate', 'public/slate.json');
const BOOKS = arg('--books', 'fanduel,draftkings,betmgm');
const DRY = process.argv.includes('--dry-run');

/**
 * App prop -> Odds API market key. These are the MLB batter prop markets;
 * each costs one credit per event, so the list is deliberately short.
 */
const MARKETS = {
  hr:   'batter_home_runs',
  hits: 'batter_hits',
  tb:   'batter_total_bases',
  rbi:  'batter_rbis',
  runs: 'batter_runs_scored',
  sb:   'batter_stolen_bases',
};
const MARKET_KEYS = (arg('--markets') || Object.values(MARKETS).join(',')).split(',');

// The 1st-inning market is a game total, priced separately from batter props.
const FIRST_INNING_MARKET = 'totals_1st_1_innings';

async function getJSON(url) {
  const res = await fetch(url);
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return { data: await res.json(), remaining, used };
}

/**
 * Names must match between MLB Stats API and the sportsbooks, and they often
 * differ on accents, suffixes and punctuation. Normalising both sides is the
 * difference between ~60% and ~95% of props linking up.
 */
function normName(n) {
  return String(n)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')   // strip accents
    .toLowerCase()
    .replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, '')           // drop generational suffixes
    .replace(/[^a-z ]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Last name plus first initial — survives "Mike" vs "Michael". */
function nameKey(n) {
  const parts = normName(n).split(' ').filter(Boolean);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[parts.length - 1]}|${parts[0][0]}`;
}

async function main() {
  if (!KEY) {
    console.error('✗ ODDS_API_KEY not set. Get a key at https://the-odds-api.com');
    process.exit(1);
  }

  const slate = JSON.parse(await fs.readFile(SLATE, 'utf8'));
  console.log(`▸ attaching odds to ${slate.games.length} game(s) for ${slate.date}`);

  // Match our games to the odds provider's events by team names + date.
  const { data: events, remaining } = await getJSON(
    `${API}/sports/baseball_mlb/events?apiKey=${KEY}`);
  console.log(`  ${events.length} MLB events available · ${remaining} API credits left`);

  const teamKey = t => normName(t).split(' ').pop();   // "Los Angeles Dodgers" -> "dodgers"
  const eventFor = g => events.find(e =>
    teamKey(e.home_team) === teamKey(g.home.name) &&
    teamKey(e.away_team) === teamKey(g.away.name));

  let linked = 0, missing = 0, gamesPriced = 0;

  for (const game of slate.games) {
    const ev = eventFor(game);
    if (!ev) {
      console.warn(`  ! no odds event for ${game.away.abbr} @ ${game.home.abbr}`);
      continue;
    }

    let payload;
    try {
      const url = `${API}/sports/baseball_mlb/events/${ev.id}/odds`
        + `?apiKey=${KEY}&regions=us&oddsFormat=american`
        + `&bookmakers=${BOOKS}`
        + `&markets=${[...MARKET_KEYS, FIRST_INNING_MARKET].join(',')}`
        + `&includeLinks=true&includeSids=true`;
      ({ data: payload } = await getJSON(url));
    } catch (e) {
      console.warn(`  ! odds fetch failed for ${game.away.abbr}@${game.home.abbr}: ${e.message}`);
      continue;
    }
    gamesPriced++;

    // Index every priced outcome by player + market + line + side.
    const priced = new Map();
    const firstInning = [];

    for (const book of payload.bookmakers || []) {
      for (const mkt of book.markets || []) {
        for (const o of mkt.outcomes || []) {
          // Deepest available link wins; fall back to market, then event.
          const link = o.link || mkt.link || book.link || null;

          if (mkt.key === FIRST_INNING_MARKET) {
            firstInning.push({
              book: book.key, bookTitle: book.title,
              side: String(o.name).toLowerCase(),   // 'over' | 'under'
              line: o.point, price: o.price, link,
            });
            continue;
          }

          // Batter props put the player in `description` and Over/Under in `name`.
          if (!o.description) continue;
          const k = `${nameKey(o.description)}|${mkt.key}|${o.point}|${String(o.name).toLowerCase()}`;
          if (!priced.has(k)) priced.set(k, []);
          priced.get(k).push({
            book: book.key, bookTitle: book.title, price: o.price, link,
          });
        }
      }
    }

    if (firstInning.length) {
      // Best price per side, preferring an outcome that actually has a link.
      const best = side => firstInning
        .filter(x => x.side === side)
        .sort((a, b) => (b.link ? 1 : 0) - (a.link ? 1 : 0) || b.price - a.price)[0] || null;
      game.firstInningOdds = { over: best('over'), under: best('under') };
    }

    // Attach to each hitter the app already knows about.
    for (const side of ['away', 'home']) {
      for (const h of game[side].lineup || []) {
        const key = nameKey(h.name);
        const odds = {};
        for (const [prop, mktKey] of Object.entries(MARKETS)) {
          // Try the standard line for each prop, then any line the book offers.
          const candidates = [...priced.keys()].filter(k =>
            k.startsWith(`${key}|${mktKey}|`) && k.endsWith('|over'));
          if (!candidates.length) continue;
          // Prefer the lowest line (0.5 for HR, 1.5 for TB, etc.) — that's what
          // the app grades against.
          candidates.sort((a, b) => parseFloat(a.split('|')[2]) - parseFloat(b.split('|')[2]));
          const chosen = candidates[0];
          const line = parseFloat(chosen.split('|')[2]);
          const offers = priced.get(chosen)
            .sort((a, b) => (b.link ? 1 : 0) - (a.link ? 1 : 0) || b.price - a.price);
          odds[prop] = { line, best: offers[0], all: offers };
        }
        if (Object.keys(odds).length) { h.odds = odds; linked++; }
        else missing++;
      }
    }
  }

  slate.oddsAttachedAt = new Date().toISOString();
  slate.oddsSource = 'The Odds API';
  slate.oddsBooks = BOOKS.split(',');
  if (missing) {
    slate.warnings = slate.warnings || [];
    slate.warnings.push(`${missing} hitter(s) had no priced props — bench players and unlisted names`);
  }

  console.log(`  priced ${gamesPriced} game(s) · ${linked} hitters linked · ${missing} without odds`);

  if (DRY) { console.log('  (dry run — slate not written)'); return; }
  await fs.writeFile(SLATE, JSON.stringify(slate, null, 2));
  console.log(`✓ wrote ${SLATE}`);
}

main().catch(e => { console.error('✗ ' + e.message); process.exit(1); });
