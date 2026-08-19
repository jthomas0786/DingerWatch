#!/usr/bin/env node
/**
 * verify-model.js — check model-config.json without opening a browser.
 *
 *   node verify-model.js                 # validate ./model-config.json
 *   node verify-model.js path/to.json    # validate a specific file
 *   node verify-model.js --defaults      # dump the resolved defaults and exit
 *
 * Exit code 0 = no errors (warnings are fine), 1 = at least one error.
 * Safe to drop into CI.
 *
 * WHY IT WORKS THE WAY IT DOES
 * ----------------------------
 * The model and its validator live in index.html, which is where they belong —
 * the app has to run standalone from GitHub Pages with no build step. Rather
 * than duplicate a few hundred lines of rules here (and let the copy rot), this
 * script lifts the real declarations straight out of index.html and runs them.
 * One source of truth, two front ends.
 *
 * The declarations it needs are all top-level and brace-balanced at column 0,
 * so they can be sliced out reliably. If any of them goes missing the script
 * says which one rather than failing silently.
 */

// The repo is ESM ("type": "module" in package.json), hence import over require.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HTML = path.join(HERE, 'index.html');

// ---------------------------------------------------------------------------
//  Slice a top-level declaration out of index.html.
// ---------------------------------------------------------------------------
//  Every block we want starts at column 0 and ends at the first line that is
//  exactly `};`, `];` or `}` at column 0. That is a property of this file's
//  formatting, not a general JS fact, so the caller gets a clear error if the
//  shape ever changes.
function slice(src, opener, closers) {
  const start = src.indexOf('\n' + opener);
  if (start === -1) return null;
  const from = start + 1;
  const lines = src.slice(from).split('\n');
  for (let i = 1; i < lines.length; i++) {
    if (closers.includes(lines[i])) {
      return lines.slice(0, i + 1).join('\n');
    }
  }
  return null;
}

function sliceConst(src, name) {
  for (const open of [`const ${name} = {`, `const ${name} = [`]) {
    const got = slice(src, open, ['};', '];']);
    if (got) return got;
  }
  return null;
}

function sliceFn(src, name) {
  return slice(src, `function ${name}(`, ['}']);
}

// ---------------------------------------------------------------------------
//  Build a sandbox containing the real model + validator.
// ---------------------------------------------------------------------------
function loadModelSandbox() {
  if (!fs.existsSync(HTML)) {
    console.error(`[verify] cannot find ${HTML}`);
    process.exit(2);
  }
  const src = fs.readFileSync(HTML, 'utf8');

  const CONSTS = ['MODEL', 'MODEL_FREEFORM', 'FACTOR_VALUES', 'FACTOR_LABELS'];
  const FNS = ['unknownPaths', 'validateModel', 'deepMerge', 'stripJSONComments'];

  const parts = [];
  const missing = [];

  for (const name of CONSTS) {
    const got = sliceConst(src, name);
    if (got) parts.push(got); else missing.push(`const ${name}`);
  }
  for (const name of FNS) {
    const got = sliceFn(src, name);
    if (got) parts.push(got); else missing.push(`function ${name}()`);
  }

  if (missing.length) {
    console.error('[verify] could not extract these from index.html:');
    missing.forEach(m => console.error(`         - ${m}`));
    console.error('[verify] index.html formatting changed; update the slicers in this file.');
    process.exit(2);
  }

  // snapshotModelDefaults in index.html closes over a module-level `let`.
  // Reimplemented here rather than sliced, because the `let` declaration is a
  // separate statement and slicing two coupled fragments is fragile.
  parts.push(`
    let MODEL_DEFAULTS = null;
    function snapshotModelDefaults(){
      if(!MODEL_DEFAULTS) MODEL_DEFAULTS = JSON.parse(JSON.stringify(MODEL));
      return MODEL_DEFAULTS;
    }
  `);

  // `const` inside runInContext creates a lexical binding, not a property on
  // the context object, so the pieces we need are re-exported explicitly.
  parts.push(`
    this.MODEL = MODEL;
    this.MODEL_DEFAULTS_FN = snapshotModelDefaults;
    this.validateModelFn = validateModel;
    this.deepMergeFn = deepMerge;
    this.stripJSONCommentsFn = stripJSONComments;
  `);

  const sandbox = { console, JSON, Object, Math, isFinite, Array, String, Number };
  vm.createContext(sandbox);
  try {
    vm.runInContext(parts.join('\n\n'), sandbox, { filename: 'index.html:model' });
  } catch (e) {
    console.error('[verify] extracted model does not evaluate:', e.message);
    process.exit(2);
  }
  return sandbox;
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------
function main() {
  const args = process.argv.slice(2);
  const sandbox = loadModelSandbox();

  if (args.includes('--defaults')) {
    console.log(JSON.stringify(sandbox.MODEL_DEFAULTS_FN(), null, 2));
    return 0;
  }

  const target = args.find(a => !a.startsWith('--')) || path.join(HERE, 'model-config.json');

  sandbox.MODEL_DEFAULTS_FN();

  let overrides = null;
  if (fs.existsSync(target)) {
    const raw = fs.readFileSync(target, 'utf8');
    let text;
    try {
      text = sandbox.stripJSONCommentsFn(raw);
    } catch (e) {
      console.error(`[verify] comment stripping failed on ${target}: ${e.message}`);
      return 1;
    }
    try {
      overrides = JSON.parse(text);
    } catch (e) {
      console.error(`[verify] ${path.basename(target)} is not valid JSONC — ${e.message}`);
      console.error('[verify] the usual cause is an unclosed brace or a stray comma.');
      return 1;
    }
    sandbox.deepMergeFn(sandbox.MODEL, overrides);
    console.log(`[verify] ${path.basename(target)} loaded — sections: ` +
      Object.keys(overrides).filter(k => !k.startsWith('//')).join(', '));
  } else {
    console.log(`[verify] ${path.basename(target)} not found — validating built-in defaults only.`);
  }

  const { errors, warnings } = sandbox.validateModelFn(overrides);

  // The console.error/warn inside validateModel has already printed the detail.
  console.log('');
  console.log(`[verify] ${errors.length} error(s), ${warnings.length} warning(s).`);

  if (errors.length) {
    console.log('[verify] FAILED — every listed key is being silently ignored by the app.');
    return 1;
  }
  console.log('[verify] PASSED.');
  return 0;
}

process.exit(main());
