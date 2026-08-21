/**
 * model-engine-vm.js — load DingerWatch's grading engine in Node, without a
 * browser, so predictions can be logged deterministically at build time.
 *
 * The entire inline <script> block in index.html is eval'd inside a vm context
 * whose `document` / `window` / `fetch` / `location` are no-op stubs. Because the
 * app's real init (fetch slate, run sims, wire UI) is gated behind a
 * DOMContentLoaded that never fires under the stub, top-level execution only
 * DEFINES the pure data/grading functions. We then call those functions directly
 * against slate.json via a `__dw` helper appended to the same script (it closes
 * over the lexical `MODEL` / `allBatters` / `games` bindings, the same trick
 * verify-model.js uses to re-export `const`s that are not context properties).
 *
 * Dependency-free: only node:vm, node:fs, node:crypto.
 */
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';

/** Slice the inline <script> body out of index.html. */
export function extractScript(htmlPath) {
  const src = fs.readFileSync(htmlPath, 'utf8');
  const a = src.indexOf('<script>', 2400);
  // NOTE: this file grew a trailing `<script type="module" src="..."></script>`
  // tag after the NFL router work, so a naive lastIndexOf('</script>') grabs
  // that self-closing tag instead of the inline block's real close. Find the
  // FIRST </script> after `a` instead — the inline block is the first script.
  const b = src.indexOf('</script>', a);
  if (a < 0 || b < 0 || b <= a) throw new Error('could not locate inline <script> block');
  return src.slice(a + '<script>'.length, b);
}

/**
 * A chainable no-op. Any property access returns another callable no-op, any
 * call returns another. This lets top-level UI wiring
 * (`document.getElementById('x').classList.add(...)`) run as a no-op instead of
 * throwing, so the pure functions after it still get defined.
 */
function chain() {
  const f = function () { return chain(); };
  return new Proxy(f, {
    get: (t, p) => {
      if (p === Symbol.toPrimitive) return () => '';
      if (p === 'then') return undefined;          // don't be mistaken for a Promise
      if (p === 'length') return 0;
      if (p === 'toString') return () => '';
      if (p in t) return t[p];
      t[p] = chain();
      return t[p];
    },
    set: (t, p, v) => { t[p] = v; return true; },
    apply: () => chain(),
    construct: () => chain(),
  });
}

function buildSandbox() {
  const fakeDoc = chain();
  const location = { search: '', href: 'http://localhost/', pathname: '/index.html', hash: '', hostname: 'localhost' };
  const navigator = { userAgent: 'node', platform: 'node', language: 'en', onLine: true };
  const localStorage = {
    store: {},
    getItem(k){ return k in this.store ? this.store[k] : null; },
    setItem(k,v){ this.store[k] = String(v); },
    removeItem(k){ delete this.store[k]; },
  };
  // `window` is a chain proxy so any `window.X` (addEventListener, innerWidth,
  // matchMedia, …) resolves to a no-op instead of throwing. Bare globals like
  // `addEventListener` and `location` are pinned on the sandbox below.
  const win = chain();
  const sandbox = {
    Math: Object.create(Math),
    Date, JSON, parseInt, parseFloat, isNaN, isFinite,
    Number, String, Boolean, Array, Object, Map, Set, RegExp,
    Error, TypeError, RangeError, SyntaxError, ReferenceError,
    encodeURIComponent, decodeURIComponent, escape, unescape,
    console,
    crypto: { getRandomValues: (b) => crypto.webcrypto.getRandomValues(b) },
    document: fakeDoc,
    window: win,
    addEventListener: () => {}, removeEventListener: () => {}, dispatchEvent: () => true,
    matchMedia: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
    location, navigator, localStorage, sessionStorage: localStorage,
    fetch: () => Promise.reject(new Error('no network in engine vm')),
    setTimeout: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    requestAnimationFrame: (fn) => { if (typeof fn === 'function') fn(); return 0; },
    cancelAnimationFrame: () => {},
    queueMicrotask: (fn) => Promise.resolve().then(fn),
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    URL, URLSearchParams,
  };
  sandbox.globalThis = sandbox;
  sandbox.self = sandbox;
  return sandbox;
}

/** Mulberry32 — small, fast, deterministic PRNG. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Derive a stable 32-bit seed from an arbitrary string. */
function seedFromString(s) {
  const h = crypto.createHash('sha256').update(String(s)).digest();
  return h.readUInt32BE(0);
}

// Appended to the inline script in the same vm run. It closes over the lexical
// bindings (MODEL, allBatters, games, and every grading function) and exposes a
// tiny API the logger can call from outside. `globalThis` works under both
// strict and non-strict top-level code.
const TAIL = `
; globalThis.__dw = (function(){
  function applyConfig(cfg){
    if(typeof snapshotModelDefaults==='function') snapshotModelDefaults();
    if(cfg && typeof deepMerge==='function') deepMerge(MODEL, cfg);
    if(typeof validateModel==='function') validateModel(cfg||{});
  }
  function loadSlate(slate){
    games = (slate && slate.games || []).map(adaptGame);
    if(typeof rebuildPools==='function') rebuildPools();
    return allBatters;
  }
  function predict(props){
    var players = allBatters.filter(isPlayable);
    players.forEach(simulatePlayer);
    return players.map(function(p){
      var gm = p.game || {};
      var opp = p.side === 'away' ? gm.home : gm.away;
      var oppP = p.oppPitcher || {};
      var out = {
        gamePk: gm.gamePk || null,
        startTimeUTC: gm.startTimeUTC || null,
        playerId: p.id, name: p.name, team: p.team,
        opponent: opp || null, side: p.side || null,
        pitcherId: oppP.id || null, battingOrder: p.battingOrder ?? null, pos: p.pos,
        props: {}
      };
      for(var i=0;i<props.length;i++){
        var prop = props[i];
        var exact = scoreExactFor(prop, p);
        var g = gradeFor(prop, exact);
        var ctx = contextFor(prop, p);
        out.props[prop] = {
          p: +(exact/100).toFixed(4),
          pct: Math.round(exact*10)/10,
          grade: g ? g.letter : null,
          percentile: (g && g.pctl!=null) ? g.pctl : null,
          contextMult: ctx ? ctx.mult : null,
          saturated: !!(ctx && ctx.saturated)
        };
      }
      return out;
    });
  }
  return { applyConfig:applyConfig, loadSlate:loadSlate, predict:predict };
})();
`;

export class EngineVM {
  constructor(htmlPath) {
    this.htmlPath = htmlPath;
    this.sandbox = buildSandbox();
    this.context = vm.createContext(this.sandbox);
    this._loaded = false;
  }

  /** Seed the RNG so one slate reproduces identical predictions. */
  setSeed(seedStr) {
    this.sandbox.Math.random = mulberry32(seedFromString(seedStr));
    return this;
  }

  load() {
    if (this._loaded) return this;
    const code = extractScript(this.htmlPath) + TAIL;
    try {
      vm.runInContext(code, this.context, { filename: 'index.html-script' });
    } catch (err) {
      this._topLevelError = err;
    }
    this._loaded = true;
    const api = this.context.__dw || this.sandbox.__dw;
    if (!api || typeof api !== 'object') {
      throw new Error('engine vm failed to expose __dw' + (this._topLevelError ? ': ' + this._topLevelError.message : ''));
    }
    return this;
  }

  get api() { return this.context.__dw || this.sandbox.__dw; }
}
