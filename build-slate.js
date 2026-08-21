#!/usr/bin/env node
/**
 * build-slate.js — thin sport-aware driver.
 *
 * Dispatches to sports/<sport>/adapter.js, defaulting to 'mlb'. The adapter owns
 * all league-specific fetching + the build() orchestration; this file just selects
 * one and runs it. Existing workflows call `node build-slate.js --out slate.json`
 * with no --sport, which defaults to mlb — byte-for-byte the same path as before
 * the refactor, so daily-slate.yml / push.yml need no changes.
 *
 * Usage:
 *   node build-slate.js                          # today, mlb
 *   node build-slate.js --date 2026-08-19        # a past/future date, mlb
 *   node build-slate.js --sport mlb --out slate.json
 */
const i = process.argv.indexOf('--sport');
const SPORT = i > -1 && process.argv[i + 1] ? process.argv[i + 1] : 'mlb';
const { build } = await import(`./sports/${SPORT}/adapter.js`);
build().catch(err => {
  console.error('✗ build failed:', err.message);
  // Non-zero exit so CI surfaces it — but the previously committed slate.json
  // stays in place, so the site degrades to yesterday's data rather than nothing.
  process.exit(1);
});
