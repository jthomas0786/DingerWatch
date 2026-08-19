/**
 * model-logger.js — captures model predictions, resolves actual outcomes, and
 * scores calibration, so the DingerWatch model can finally be backtested.
 *
 * Pipeline (run once per daily build, inside build-slate.js):
 *   1. writePredictions()  — run the grading engine on today's slate.json, write
 *                           model-logs/predictions/<date>.json BEFORE first pitch.
 *   2. scorePending()     — for any prior predictions not yet scored, fetch MLB
 *                           box scores and resolve each prop outcome, write
 *                           model-logs/scored/<date>.json.
 *   3. recomputeCalibration() — rebuild model-logs/calibration-history.json from
 *                           every scored file, segmented by model version.
 *
 * Design rules:
 *   - Predictions are seeded (mulberry32) so a given slate + model reproduces
 *     identical probabilities. Reproducibility is the whole point of a backtest.
 *   - A prediction is INVALID for calibration if it was generated at or after
 *     the game's scheduled start (look-ahead guard).
 *   - A player who did not bat (0 PA) is VOID for batting props — sportsbooks
 *     grade that "no action". A pinch-runner with 0 PA still had a steal chance.
 *   - Calibration is recomputed from scratch each run, never appended, so a
 *     re-scored date fixes itself.
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';
import { EngineVM } from './model-engine-vm.js';

const MLB = 'https://statsapi.mlb.com/api/v1';
const MLB11 = 'https://statsapi.mlb.com/api/v1.1';
export const PROPS = ['hr', 'hits', 'tb', 'rbi', 'hrr', 'sb'];
export const PROP_LINES = {
  hr: { over: 0.5, kind: 'count', stat: 'homeRuns' },
  hits: { over: 0.5, kind: 'count', stat: 'hits' },
  tb: { over: 1.5, kind: 'totalBases' },
  rbi: { over: 0.5, kind: 'count', stat: 'rbi' },
  hrr: { over: 1.5, kind: 'hitsPlusRunsPlusRbi' },
  sb: { over: 0.5, kind: 'count', stat: 'stolenBases' },
};

// ---------------------------------------------------------------------------
//  Small fetch helper (mirrors build-slate.js's getJSON, kept local so this
//  file stays standalone-runnable).
// ---------------------------------------------------------------------------
async function getJSON(url, { retries = 3, timeoutMs = 15000 } = {}) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { 'User-Agent': 'dinger-watch-model-logger/1.0' } });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      clearTimeout(timer);
      if (attempt === retries) throw new Error(`${url} failed: ${err.message}`);
      await new Promise(r => setTimeout(r, 400 * 2 ** attempt));
    }
  }
}

export function stripComments(t) {
  return t.replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/\/\/[^\n]*/g, '')
          .replace(/,(\s*[}\]])/g, '$1');
}

function sha(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }
function shortHash(s) { return sha(s).slice(0, 12); }

// ---------------------------------------------------------------------------
//  1. PREDICTIONS
// ---------------------------------------------------------------------------
/**
 * Run the grading engine on slate.json and write a prediction snapshot.
 * Never overwrites an existing file for the same date — re-writing after games
 * have started would create look-ahead bias.
 */
export async function writePredictions({ slatePath, htmlPath = 'index.html', configPath = 'model-config.json', logsDir, gitSha = null, simRuns = 10000 }) {
  const slate = JSON.parse(await fsp.readFile(slatePath, 'utf8'));
  const date = slate.date;
  const predDir = path.join(logsDir, 'predictions');
  const predFile = path.join(predDir, `${date}.json`);
  await fsp.mkdir(predDir, { recursive: true });
  if (await fs.existsSync(predFile)) {
    return { skipped: 'exists', file: predFile, date };
  }

  // Reproducible seed: date + slate generatedAt + model version. The
  // generatedAt ties the seed to the exact slate build, so a rebuild of the
  // same date (with refreshed lineups) makes a fresh, still-reproducible draw.
  const cfgText = fs.existsSync(configPath) ? await fsp.readFile(configPath, 'utf8') : '';
  const indexHash = shortHash(fs.readFileSync(htmlPath, 'utf8'));
  const configHash = shortHash(cfgText);
  const modelHash = shortHash(indexHash + ':' + configHash);

  const vm = new EngineVM(htmlPath);
  vm.setSeed(`${date}:${slate.generatedAt}:${modelHash}`);
  vm.load();
  if (cfgText.trim()) {
    const cfg = JSON.parse(stripComments(cfgText));
    vm.api.applyConfig(cfg);
  }
  const batters = vm.api.loadSlate(slate);
  const players = vm.api.predict(PROPS);

  const payload = {
    date,
    generatedAt: slate.generatedAt ?? new Date().toISOString(),
    slateGeneratedAt: slate.generatedAt ?? null,
    model: {
      gitSha: gitSha || null,
      indexHash, configHash, modelHash,
      simRuns,
      rngSeed: `${date}:${slate.generatedAt ?? ''}:${modelHash}`,
    },
    props: Object.fromEntries(PROPS.map(p => [p, PROP_LINES[p]])),
    players,
  };
  await fsp.writeFile(predFile, JSON.stringify(payload, null, 2));
  return { written: true, file: predFile, date, players: players.length };
}

// ---------------------------------------------------------------------------
//  2. OUTCOMES + SCORING
// ---------------------------------------------------------------------------
/** Fetch the schedule (gamePks + statuses) for a date. */
async function fetchSchedule(date) {
  const data = await getJSON(`${MLB}/schedule?sportId=1&date=${date}&hydrate=probablePitcher,linescore,team`);
  const games = (data.dates || []).flatMap(d => d.games || []);
  return games.map(g => ({ gamePk: g.gamePk, status: g.status?.abstractGameState || 'Preview', detailed: g.status?.detailedState || null, doubleHeader: g.doubleHeader, gameNumber: g.gameNumber || 1 }));
}

/** Fetch one game's boxscore and resolve per-player prop outcomes.
 *  The v1 boxscore nests batting stats under stats.batting; the player key is
 *  ID{personId} and the name lives at person.fullName. */
async function resolveGameOutcomes(gamePk) {
  const data = await getJSON(`${MLB}/game/${gamePk}/boxscore`).catch(() => null);
  if (!data) return null;
  const out = { gamePk, status: data.status?.abstractGameState || null, players: [] };
  for (const side of ['away', 'home']) {
    const players = data.teams?.[side]?.players || {};
    for (const [key, pl] of Object.entries(players)) {
      const id = pl.person?.id ?? Number(String(key).replace(/^ID/, ''));
      if (!Number.isFinite(id)) continue;
      const bat = pl.stats?.batting || {};
      const pa = Number(bat.plateAppearances) || 0;
      const h = Number(bat.hits) || 0;
      const hr = Number(bat.homeRuns) || 0;
      const rbi = Number(bat.rbi) || 0;
      const r = Number(bat.runs) || 0;
      const dbl = Number(bat.doubles) || 0;
      const trp = Number(bat.triples) || 0;
      const sb = Number(bat.stolenBases) || 0;
      const tb = Number(bat.totalBases) || (h + dbl + 2 * trp + 3 * hr);
      const batOutcome = (fn) => {
        // Void batting props if the player never came to the plate (no action),
        // the same way sportsbooks grade a non-batter.
        if (pa === 0) return { void: true, voidReason: 'no-PA' };
        return { void: false, outcome: fn() };
      };
      out.players.push({
        playerId: id, name: pl.person?.fullName ?? null, team: side,
        plateAppearances: pa,
        props: {
          hr:   batOutcome(() => hr >= 1),
          hits: batOutcome(() => h >= 1),
          tb:   batOutcome(() => tb >= 2),
          rbi:  batOutcome(() => rbi >= 1),
          hrr:  batOutcome(() => h + r + rbi >= 2),
          sb:   { void: false, outcome: sb >= 1 },   // a PR with 0 PA still had a steal chance
        },
      });
    }
  }
  return out;
}

/**
 * Score every prediction file in the last `windowDays` that hasn't been scored
 * yet. Re-attempts dates whose games weren't final last time. Writes
 * model-logs/scored/<date>.json and model-logs/outcomes/<date>.json.
 */
export async function scorePending({ logsDir, windowDays = 14 }) {
  const predDir = path.join(logsDir, 'predictions');
  const scoredDir = path.join(logsDir, 'scored');
  const outDir = path.join(logsDir, 'outcomes');
  await fsp.mkdir(scoredDir, { recursive: true });
  await fsp.mkdir(outDir, { recursive: true });
  if (!await fs.existsSync(predDir)) return { scored: [] };

  const today = new Date();
  const dates = (await fsp.readdir(predDir))
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''))
    .filter(d => { const diff = (today - new Date(d + 'T12:00:00Z')) / 86400000; return diff >= 0 && diff <= windowDays + 1; })
    .sort();

  const scored = [];
  for (const date of dates) {
    const scoredFile = path.join(scoredDir, `${date}.json`);
    if (await fs.existsSync(scoredFile)) continue;   // already scored
    const pred = JSON.parse(await fsp.readFile(path.join(predDir, `${date}.json`), 'utf8'));
    const schedule = await fetchSchedule(date).catch(() => []);
    const allFinal = schedule.length > 0 && schedule.every(g => g.status === 'Final');
    if (!allFinal) {
      // Not every game is final yet — skip and retry on a later build.
      continue;
    }
    const gameOutcomes = [];
    for (const g of schedule) {
      const o = await resolveGameOutcomes(g.gamePk).catch(e => ({ gamePk: g.gamePk, error: e.message }));
      if (o) gameOutcomes.push(o);
    }
    await fsp.writeFile(path.join(outDir, `${date}.json`), JSON.stringify({ date, resolvedAt: new Date().toISOString(), games: gameOutcomes }, null, 2));
    const scoredPayload = joinAndScore(pred, gameOutcomes);
    // Join-health guard: if the boxscore fetch or shape was wrong, every row
    // voids as a DNP and n===0 for every batting prop. That produces a useless
    // "scored" day and corrupts the calibration history, so refuse to write it —
    // a later run (with the endpoint fixed) will score the day properly.
    const battingProps = ['hr', 'hits', 'tb', 'rbi'];
    const resolvedPlayers = scoredPayload.rows.filter(r => !r.void).length;
    const joinRate = scoredPayload.summary.totalRows
      ? resolvedPlayers / scoredPayload.summary.totalRows : 0;
    if (battingProps.every(p => (scoredPayload.summary.perProp[p] || {}).n === 0)) {
      console.warn(`  ⚠ [score] ${date}: 0 real outcomes (all voided) — boxscore fetch likely failed; not writing scored file`);
      continue;
    }
    if (joinRate < 0.5) {
      console.warn(`  ⚠ [score] ${date}: low join rate ${(joinRate * 100).toFixed(0)}% — outcomes may be incomplete`);
    }
    await fsp.writeFile(scoredFile, JSON.stringify(scoredPayload, null, 2));
    scored.push({ date, n: scoredPayload.summary.totalRows });
  }
  return { scored };
}

/**
 * Join predictions to outcomes and compute per-prop metrics.
 * A prediction row is INVALID if generatedAt >= the game's scheduled start.
 */
function joinAndScore(pred, gameOutcomes) {
  const byGame = new Map();
  for (const g of gameOutcomes) byGame.set(g.gamePk, g);
  const byPlayer = new Map();   // playerId -> {props}
  for (const g of gameOutcomes) for (const pl of g.players || []) byPlayer.set(pl.playerId, pl);

  const rows = [];   // per player per prop
  for (const p of pred.players || []) {
    const go = byGame.get(p.gamePk);
    const startedAfter = pred.generatedAt && p.startTimeUTC && new Date(pred.generatedAt) >= new Date(p.startTimeUTC);
    const outcome = byPlayer.get(p.playerId);
    for (const prop of PROPS) {
      const pr = p.props?.[prop];
      if (!pr || typeof pr.p !== 'number') continue;
      const cell = { date: pred.date, playerId: p.playerId, name: p.name, team: p.team, prop,
        p: pr.p, grade: pr.grade, modelHash: pred.model?.modelHash,
        valid: !startedAfter, void: false, outcome: null };
      if (startedAfter) { cell.void = true; cell.voidReason = 'look-ahead'; }
      else if (!outcome) { cell.void = true; cell.voidReason = 'DNP'; }
      else {
        const o = outcome.props?.[prop];
        if (!o) { cell.void = true; cell.voidReason = 'no-outcome'; }
        else if (o.void) { cell.void = true; cell.voidReason = o.voidReason || 'void'; }
        else { cell.outcome = !!o.outcome; }
      }
      rows.push(cell);
    }
  }

  const summary = computeMetrics(rows);
  return { date: pred.date, model: pred.model, summary, rows };
}

// ---------------------------------------------------------------------------
//  3. CALIBRATION
// ---------------------------------------------------------------------------
const GRADE_ORDER = ['A+', 'A', 'B+', 'B', 'C+', 'C', 'D'];
const PROB_BINS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1.0];

function clip(p) { return Math.max(0.001, Math.min(0.999, p)); }

function computeMetrics(rows) {
  const perProp = {};
  for (const prop of PROPS) {
    const r = rows.filter(x => x.prop === prop && !x.void);
    const n = r.length;
    const hits = r.filter(x => x.outcome).length;
    const meanProb = n ? r.reduce((t, x) => t + x.p, 0) / n : null;
    const brier = n ? r.reduce((t, x) => t + (x.p - (x.outcome ? 1 : 0)) ** 2, 0) / n : null;
    const logLoss = n ? -r.reduce((t, x) => t + ((x.outcome ? 1 : 0) * Math.log(clip(x.p)) + ((x.outcome ? 0 : 1) * Math.log(clip(1 - x.p)))), 0) / n : null;
    const byGrade = {};
    for (const g of GRADE_ORDER) {
      const gr = r.filter(x => x.grade === g);
      byGrade[g] = { n: gr.length, hits: gr.filter(x => x.outcome).length, hitRate: gr.length ? gr.filter(x => x.outcome).length / gr.length : null, meanProb: gr.length ? gr.reduce((t, x) => t + x.p, 0) / gr.length : null };
    }
    const byBin = PROB_BINS.slice(0, -1).map((lo, i) => {
      const hi = PROB_BINS[i + 1];
      const br = r.filter(x => x.p >= lo && x.p < hi);
      return { range: `${Math.round(lo * 100)}-${Math.round(hi * 100)}%`, n: br.length, hitRate: br.length ? br.filter(x => x.outcome).length / br.length : null, meanProb: br.length ? br.reduce((t, x) => t + x.p, 0) / br.length : null };
    });
    perProp[prop] = { n, voids: rows.filter(x => x.prop === prop && x.void).length, hits, hitRate: n ? hits / n : null, meanProb, brier, logLoss, byGrade, byBin };
  }
  return { totalRows: rows.length, voids: rows.filter(x => x.void).length, perProp };
}

/** Recompute calibration-history.json from every scored file. */
export async function recomputeCalibration({ logsDir }) {
  const scoredDir = path.join(logsDir, 'scored');
  const out = path.join(logsDir, 'calibration-history.json');
  await fsp.mkdir(logsDir, { recursive: true });
  await fsp.mkdir(scoredDir, { recursive: true });
  const files = (await fsp.readdir(scoredDir)).filter(f => f.endsWith('.json')).sort();
  if (!files.length) {
    await fsp.writeFile(out, JSON.stringify({ generatedAt: new Date().toISOString(), daysScored: 0, totalRows: 0, perProp: {}, byModel: {} }, null, 2));
    return { daysScored: 0 };
  }
  const allRows = [];
  const days = [];
  for (const f of files) {
    const s = JSON.parse(await fsp.readFile(path.join(scoredDir, f), 'utf8'));
    days.push({ date: s.date, modelHash: s.model?.modelHash, n: s.summary?.totalRows, voids: s.summary?.voids, perProp: s.summary?.perProp });
    (s.rows || []).forEach(r => allRows.push(r));
  }
  const summary = computeMetrics(allRows);
  const byModel = {};
  for (const r of allRows) {
    const mh = r.modelHash || 'unknown';
    (byModel[mh] ??= []).push(r);
  }
  const byModelSummary = {};
  for (const [mh, rs] of Object.entries(byModel)) byModelSummary[mh] = computeMetrics(rs);
  const payload = { generatedAt: new Date().toISOString(), daysScored: days.length, totalRows: allRows.length, perProp: summary.perProp, byModel: byModelSummary, days };
  await fsp.writeFile(out, JSON.stringify(payload, null, 2));
  return { daysScored: days.length, totalRows: allRows.length };
}

// ---------------------------------------------------------------------------
//  Orchestrator (called from build-slate.js)
// ---------------------------------------------------------------------------
export async function runLogging({ slatePath, htmlPath, configPath, logsDir, gitSha = null }) {
  const results = { predictions: null, scored: null, calibration: null };
  try {
    results.predictions = await writePredictions({ slatePath, htmlPath, configPath, logsDir, gitSha });
  } catch (e) { console.warn('  ⚠ prediction logging failed:', e.message); }
  try {
    results.scored = await scorePending({ logsDir });
  } catch (e) { console.warn('  ⚠ outcome scoring failed:', e.message); }
  try {
    results.calibration = await recomputeCalibration({ logsDir });
  } catch (e) { console.warn('  ⚠ calibration recompute failed:', e.message); }
  return results;
}

// ---------------------------------------------------------------------------
//  CLI — node model-logger.js [--slate slate.json] [--date YYYY-MM-DD]
//  --date scores + recomputes only (used to backfill a completed date).
// ---------------------------------------------------------------------------
if (process.argv[1] && process.argv[1].endsWith('model-logger.js')) {
  const arg = (f, fb) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fb; };
  const slatePath = arg('--slate', 'slate.json');
  const htmlPath = arg('--html', 'index.html');
  const configPath = arg('--config', 'model-config.json');
  const logsDir = arg('--logs', 'model-logs');
  const onlyDate = arg('--date', null);
  if (onlyDate) {
    // Backfill: score a single completed date and recompute calibration.
    console.log(`▸ scoring outcomes for ${onlyDate}`);
    const pred = path.join(logsDir, 'predictions', `${onlyDate}.json`);
    if (!fs.existsSync(pred)) { console.error(`no predictions for ${onlyDate} — run writePredictions first`); process.exit(1); }
    const predObj = JSON.parse(await fsp.readFile(pred, 'utf8'));
    const schedule = await fetchSchedule(onlyDate);
    const allFinal = schedule.length > 0 && schedule.every(g => g.status === 'Final');
    if (!allFinal) { console.error(`not all games final for ${onlyDate}`); process.exit(1); }
    const games = [];
    for (const g of schedule) { const o = await resolveGameOutcomes(g.gamePk).catch(e => ({ gamePk: g.gamePk, error: e.message })); if (o) games.push(o); }
    await fsp.mkdir(path.join(logsDir, 'outcomes'), { recursive: true });
    await fsp.writeFile(path.join(logsDir, 'outcomes', `${onlyDate}.json`), JSON.stringify({ date: onlyDate, resolvedAt: new Date().toISOString(), games }, null, 2));
    const scored = joinAndScore(predObj, games);
    await fsp.mkdir(path.join(logsDir, 'scored'), { recursive: true });
    await fsp.writeFile(path.join(logsDir, 'scored', `${onlyDate}.json`), JSON.stringify(scored, null, 2));
    const cal = await recomputeCalibration({ logsDir });
    console.log(`✓ scored ${scored.summary.totalRows} rows for ${onlyDate}; ${cal.daysScored} days in history`);
  } else {
    (async () => {
      const gitSha = (() => { try { return execSync('git rev-parse --short HEAD').toString().trim(); } catch { return null; } })();
      const r = await runLogging({ slatePath, htmlPath, configPath, logsDir, gitSha });
      console.log('▸ model logging:', JSON.stringify(r));
    })();
  }
}
