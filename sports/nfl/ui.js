/**
 * sports/nfl/ui.js — Touchdown Watch view.
 *
 * Renders the NFL slate into #nflView: a week header, a football-field gamecast
 * per game, and an Anytime-TD pick list. This is a SELF-CONTAINED view that runs
 * beside the MLB app rather than through it — the MLB code path (slate.json ->
 * batters/pitchers/parks/weather) is deeply shaped around baseball, and forcing
 * football through it would risk every existing feature for no benefit. Every
 * class here is `nfl-` prefixed, so nothing collides with existing CSS/JS.
 *
 * Data contract: ./slates/nfl.json, written by sports/nfl/adapter.js.
 */
import { SPORTS, isPreview } from '../registry.js';
import { startLivePolling, stopLivePolling } from './live.js';
import { liveWinProb } from './winprob.js';

const CFG = SPORTS.nfl;
let slate = null;
let oddsDoc = null;
let activeGameId = null;
let posFilter = 'ALL';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const pct = (p) => `${(p * 100).toFixed(1)}%`;

/** Kickoff time in the viewer's local zone. */
function kickoff(utc) {
  if (!utc) return '';
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return 'unknown';
  const mins = Math.round((Date.now() - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const h = Math.floor(mins / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

/** Red-zone defense descriptor: index <1 means the defense is stingy. */
function rzDefLabel(rz) {
  if (!rz || rz.rzDefIndex == null) return { text: 'No RZ data', tone: 'neu', detail: '' };
  const i = rz.rzDefIndex;
  const allowed = `${(rz.rzTdRateAllowed * 100).toFixed(1)}%`;
  const detail = `Allowed a touchdown on ${allowed} of red-zone plays faced` +
    (rz.rzPlaysFaced ? ` (${rz.rzPlaysFaced} plays, 2025)` : '');
  if (i <= 0.9) return { text: `Tough RZ D · ${allowed}`, tone: 'neg', detail };
  if (i >= 1.1) return { text: `Soft RZ D · ${allowed}`, tone: 'pos', detail };
  return { text: `Average RZ D · ${allowed}`, tone: 'neu', detail };
}

const AVAIL_LABEL = {
  active: 'Active', questionable: 'Questionable', doubtful: 'Doubtful',
  out: 'Out', unconfirmed: 'Unconfirmed',
};

const CONF_LABEL = {
  full: null,                                    // normal case, no badge
  rookie: { text: 'Rookie', title: 'No NFL production history — projection is prior-based, scaled by draft position' },
  'no-history': { text: 'No 2025 sample', title: 'On a 2026 roster but recorded no 2025 production — projection is prior-based and discounted' },
};

// ---------------------------------------------------------------------------
// player-prop odds (OpticOdds sample) — fail-soft, mirrors the MLB odds model
// ---------------------------------------------------------------------------
const ODDS_URL = './slates/nfl-odds.json';

/** American-odds display: +140 / -120. */
function priceFmt(p) {
  if (p == null || !Number.isFinite(p)) return '';
  return p > 0 ? `+${Math.round(p)}` : `${Math.round(p)}`;
}

/** Normalized name for join: lowercase, strip dots/suffixes, collapse spaces. */
function normName(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/\./g, '')
    .replace(/\s+(jr|sr|ii|iii|iv|v)\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Attach odds (slates/nfl-odds.json) to slate players by matchup + name. Fail-soft. */
function mergeNflOdds(slate, odds) {
  if (!slate?.games?.length || !odds?.games?.length) return;
  const byKey = {};
  for (const g of odds.games) byKey[g.matchKey] = g;
  for (const game of slate.games) {
    const og = byKey[`${game.away?.abbr}-${game.home?.abbr}`];
    if (!og) continue;
    const byName = {};
    for (const p of og.players) byName[normName(p.name)] = p;
    for (const p of game.players) {
      const m = byName[normName(p.name)];
      if (m) p.odds = m.odds;
    }
  }
}

/** Week-1 odds preview card — shown during preseason (no slate props posted yet). */
function previewOddsHTML(odds) {
  if (!odds?.games?.length) return '';
  const game = odds.games.find(g => g.markets?.includes('atd'));
  if (!game) return '';
  const books = [...new Set(game.players.flatMap(p => p.odds?.atd?.all?.map(e => e.book) || []))].slice(0, 3);
  const atd = game.players
    .filter(p => p.odds?.atd?.best)
    .sort((a, b) => a.odds.atd.best.price - b.odds.atd.best.price)
    .slice(0, 6);
  const yards = game.players.filter(p => p.odds?.rushYds || p.odds?.recYds || p.odds?.receptions).slice(0, 4);
  const row = (p) => `<a class="nfl-prev-row" href="${esc(p.odds.atd.best.link)}" target="_blank" rel="noopener" title="${esc(p.odds.atd.best.book)} · Anytime TD — tap to bet"><span class="nfl-prev-name">${esc(p.name)}</span><span class="nfl-prev-amt">${priceFmt(p.odds.atd.best.price)}</span></a>`;
  const yrow = (p) => {
    const m = p.odds.rushYds || p.odds.recYds || p.odds.receptions; if (!m?.over?.best) return '';
    const label = p.odds.rushYds ? 'Rush yds' : p.odds.recYds ? 'Rec yds' : 'Receptions';
    return `<a class="nfl-prev-row" href="${esc(m.over.best.link)}" target="_blank" rel="noopener" title="${esc(m.over.best.book)} · ${label} Over ${esc(m.line)}"><span class="nfl-prev-name">${esc(p.name)} <em>${label} ${esc(m.line)}</em></span><span class="nfl-prev-amt">${priceFmt(m.over.best.price)}</span></a>`;
  };
  return `<section class="nfl-preview-odds" aria-label="Week 1 odds preview">
    <div class="nfl-preview-odds-head"><h3>Week 1 odds preview</h3>
      <span class="nfl-preview-odds-sub">Real ${esc(game.away)} @ ${esc(game.home)} props — regular season opens Sept 9. Tap to bet at ${esc(books.join(' / '))}.</span></div>
    <div class="nfl-preview-odds-cols">
      <div class="nfl-prev-col"><div class="nfl-prev-col-h">Anytime TD</div>${atd.map(row).join('')}</div>
      <div class="nfl-prev-col"><div class="nfl-prev-col-h">Player lines</div>${yards.map(yrow).join('')}</div>
    </div>
  </section>`;
}

// ---------------------------------------------------------------------------
// football field gamecast
// ---------------------------------------------------------------------------
/**
 * The signature visual: a 100-yard field drawn as SVG. The two end zones carry
 * the teams' colors and abbreviations, and the yard lines/numbers give it real
 * football geometry rather than a generic progress bar.
 *
 * `mode: 'compact'` is the card header; `mode: 'full'` is the expanded gamecast.
 */
function fieldSVG(game, mode = 'compact') {
  const h = mode === 'full' ? 132 : 92;
  const ez = 26;                    // end-zone depth in user units
  const W = 300;
  const fieldW = W - ez * 2;
  const lines = [];
  // yard lines every 10 yards (10 interior lines across 100 yards)
  for (let y = 10; y <= 90; y += 10) {
    const x = ez + (fieldW * y) / 100;
    lines.push(`<line x1="${x.toFixed(1)}" y1="0" x2="${x.toFixed(1)}" y2="${h}" stroke="rgba(255,255,255,.22)" stroke-width="0.8"/>`);
  }
  // yard numbers (10..50..10)
  const nums = [];
  for (let y = 10; y <= 90; y += 10) {
    const label = y <= 50 ? y : 100 - y;
    const x = ez + (fieldW * y) / 100;
    nums.push(`<text x="${x.toFixed(1)}" y="${(h / 2 + 4).toFixed(1)}" text-anchor="middle" font-size="9" fill="rgba(255,255,255,.34)" font-family="'JetBrains Mono',monospace">${label}</text>`);
  }
  // hash marks every 5 yards, top and bottom
  const hashes = [];
  for (let y = 5; y <= 95; y += 5) {
    if (y % 10 === 0) continue;
    const x = ez + (fieldW * y) / 100;
    hashes.push(`<line x1="${x.toFixed(1)}" y1="${h * 0.28}" x2="${x.toFixed(1)}" y2="${h * 0.34}" stroke="rgba(255,255,255,.16)" stroke-width="0.7"/>`);
    hashes.push(`<line x1="${x.toFixed(1)}" y1="${h * 0.66}" x2="${x.toFixed(1)}" y2="${h * 0.72}" stroke="rgba(255,255,255,.16)" stroke-width="0.7"/>`);
  }
  const uid = `f${game.gameId}${mode}`;
  return `
<svg class="nfl-field ${mode === 'full' ? 'is-full' : ''}" viewBox="0 0 ${W} ${h}" role="img"
     aria-label="${esc(game.away.abbr)} at ${esc(game.home.abbr)}" preserveAspectRatio="none">
  <defs>
    <linearGradient id="${uid}turf" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#1c5233"/><stop offset="0.5" stop-color="#174a2c"/><stop offset="1" stop-color="#123d26"/>
    </linearGradient>
    <pattern id="${uid}mow" width="${(fieldW / 10).toFixed(2)}" height="${h}" patternUnits="userSpaceOnUse">
      <rect width="${(fieldW / 20).toFixed(2)}" height="${h}" fill="rgba(255,255,255,.028)"/>
    </pattern>
  </defs>
  <rect x="0" y="0" width="${W}" height="${h}" fill="url(#${uid}turf)"/>
  <rect x="${ez}" y="0" width="${fieldW}" height="${h}" fill="url(#${uid}mow)"/>
  <rect x="0" y="0" width="${ez}" height="${h}" fill="rgba(0,0,0,.34)"/>
  <rect x="${W - ez}" y="0" width="${ez}" height="${h}" fill="rgba(0,0,0,.34)"/>
  ${lines.join('')}${hashes.join('')}${nums.join('')}
  <line x1="${ez}" y1="0" x2="${ez}" y2="${h}" stroke="rgba(255,255,255,.5)" stroke-width="1.2"/>
  <line x1="${W - ez}" y1="0" x2="${W - ez}" y2="${h}" stroke="rgba(255,255,255,.5)" stroke-width="1.2"/>
  <text x="${ez / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle"
        transform="rotate(-90 ${ez / 2} ${h / 2})" font-size="11" font-weight="700"
        fill="rgba(255,255,255,.72)" font-family="'JetBrains Mono',monospace"
        letter-spacing="1.5">${esc(game.away.abbr)}</text>
  <text x="${W - ez / 2}" y="${h / 2}" text-anchor="middle" dominant-baseline="middle"
        transform="rotate(90 ${W - ez / 2} ${h / 2})" font-size="11" font-weight="700"
        fill="rgba(255,255,255,.72)" font-family="'JetBrains Mono',monospace"
        letter-spacing="1.5">${esc(game.home.abbr)}</text>
  <rect x="0" y="0" width="${W}" height="${h}" fill="none" stroke="rgba(255,255,255,.14)" stroke-width="1"/>
</svg>`;
}

// ---------------------------------------------------------------------------
// live win-probability strip (moneyline tiles)
// ---------------------------------------------------------------------------
/**
 * Modeled in-game win probability for the expanded gamecast — NOT a live
 * sportsbook moneyline. The team more likely to win turns green, the other red;
 * the O/U tile shows a projected final total (the NFL slate carries no total
 * line). A small LIVE label makes the modeled nature explicit.
 */
function oddsHTML(game) {
  const wp = liveWinProb(game);
  const aPct = Math.round(wp.awayPct * 100);
  const hPct = Math.round(wp.homePct * 100);
  const aWin = wp.awayPct >= wp.homePct;
  const awayCls = aWin ? 'wp-win' : 'wp-lose';
  const homeCls = aWin ? 'wp-lose' : 'wp-win';
  const ouVal = wp.projTotal != null ? `Proj ${wp.projTotal.toFixed(1)}` : '—';
  return `<div class="nfl-gc-live"><span class="nfl-gc-live-dot"></span>LIVE<span class="nfl-gc-live-sub"> · modeled win probability</span></div>
<div class="nfl-gc-odds">
  <div class="nfl-gc-ot"><div class="nfl-gc-ot-label">${esc(game.away.abbr)} ML</div><div class="nfl-gc-ot-val ${awayCls}">${aPct}%</div></div>
  <div class="nfl-gc-ot"><div class="nfl-gc-ot-label">${esc(game.home.abbr)} ML</div><div class="nfl-gc-ot-val ${homeCls}">${hPct}%</div></div>
  <div class="nfl-gc-ot"><div class="nfl-gc-ot-label">O/U</div><div class="nfl-gc-ot-val wp-proj">${ouVal}</div></div>
</div>`;
}

// ---------------------------------------------------------------------------
// game card
// ---------------------------------------------------------------------------
function gameCard(game) {
  const isFinal = game.status === 'post';
  const isLive = game.status === 'in';
  const awayRz = rzDefLabel(game.away.rzDefense);
  const homeRz = rzDefLabel(game.home.rzDefense);
  const rec = (t) => (t.records || []).find(r => r.type === 'total')?.summary || '';
  const natl = (game.broadcast || []).find(b => b.market === 'national');
  const tv = natl?.names?.[0] || (game.broadcast || [])[0]?.names?.[0] || '';
  // top TD candidate per side, for the "most likely to score" strip
  const top = (abbr) => game.players
    .filter(p => p.team === abbr && p.props.atd.availability.status !== 'out')
    .sort((a, b) => b.props.atd.probability - a.props.atd.probability)[0];
  const ta = top(game.away.abbr), th = top(game.home.abbr);
  const scorer = (p) => p
    ? `<span class="nfl-scorer"><b>${esc(p.name)}</b> <span class="nfl-scorer-pct">${pct(p.props.atd.probability)}</span></span>`
    : '<span class="nfl-scorer nfl-scorer-none">No candidate</span>';

  return `
<article class="nfl-game" data-game="${esc(game.gameId)}" tabindex="0" role="button"
         aria-expanded="${activeGameId === game.gameId}" aria-label="Open gamecast for ${esc(game.away.abbr)} at ${esc(game.home.abbr)}">
  <div class="nfl-game-field">
    ${fieldSVG(game, 'compact')}
    <div class="nfl-game-overlay">
      <div class="nfl-team nfl-team-away">
        <img class="nfl-logo" src="${esc(game.away.logo)}" alt="" loading="lazy"/>
        <div class="nfl-team-meta">
          <span class="nfl-team-abbr">${esc(game.away.abbr)}</span>
          <span class="nfl-team-rec">${esc(rec(game.away))}</span>
        </div>
      </div>
      <div class="nfl-game-center">
        ${isFinal || isLive
          ? `<div class="nfl-score"><span>${esc(game.away.score)}</span><span class="nfl-score-dash">–</span><span>${esc(game.home.score)}</span></div>
             <div class="nfl-status ${isLive ? 'is-live' : ''}">${isLive ? 'LIVE' : 'FINAL'}</div>`
          : `<div class="nfl-kick">${esc(kickoff(game.startTimeUTC))}</div>
             <div class="nfl-at">@</div>`}
      </div>
      <div class="nfl-team nfl-team-home">
        <div class="nfl-team-meta nfl-ta-right">
          <span class="nfl-team-abbr">${esc(game.home.abbr)}</span>
          <span class="nfl-team-rec">${esc(rec(game.home))}</span>
        </div>
        <img class="nfl-logo" src="${esc(game.home.logo)}" alt="" loading="lazy"/>
      </div>
    </div>
  </div>
  <div class="nfl-game-body">
    <div class="nfl-game-info">
      <span>${esc(game.venue?.name || '')}</span>
      ${game.venue?.indoor ? '<span class="nfl-chip">Indoor</span>' : ''}
      ${tv ? `<span class="nfl-chip">${esc(tv)}</span>` : ''}
    </div>
    <div class="nfl-rz-row">
      <div class="nfl-rz nfl-rz-${awayRz.tone}" title="${esc(game.away.name)} defense — ${esc(awayRz.detail)}">
        <span class="nfl-rz-team">vs ${esc(game.away.abbr)} D</span>
        <span class="nfl-rz-text">${esc(awayRz.text)}</span>
      </div>
      <div class="nfl-rz nfl-rz-${homeRz.tone}" title="${esc(game.home.name)} defense — ${esc(homeRz.detail)}">
        <span class="nfl-rz-team">vs ${esc(game.home.abbr)} D</span>
        <span class="nfl-rz-text">${esc(homeRz.text)}</span>
      </div>
    </div>
    <div class="nfl-top-scorers">
      <div class="nfl-ts"><span class="nfl-ts-label">${esc(game.away.abbr)} top TD</span>${scorer(ta)}</div>
      <div class="nfl-ts"><span class="nfl-ts-label">${esc(game.home.abbr)} top TD</span>${scorer(th)}</div>
    </div>
  </div>
</article>`;
}

// ---------------------------------------------------------------------------
// player row
// ---------------------------------------------------------------------------
function playerRow(p, opts = {}) {
  const a = p.props.atd;
  const conf = CONF_LABEL[a.dataConfidence];
  const isOut = a.availability.status === 'out';
  const barW = Math.max(2, Math.min(100, a.probability * 100));
  const depth = p.depthRank != null
    ? `<span class="nfl-chip nfl-chip-depth" title="2026 depth-chart rank at ${esc(p.position)}">${esc(p.position)}${p.depthRank}</span>`
    : '';
  const moved = p.teamChanged
    ? `<span class="nfl-chip nfl-chip-moved" title="Changed teams for 2026 — 2025 production was with ${esc(p.prevTeam)}">${esc(p.prevTeam)}→${esc(p.team)}</span>`
    : '';
  const confChip = conf
    ? `<span class="nfl-chip nfl-chip-warn" title="${esc(conf.title)}">${esc(conf.text)}</span>`
    : '';
  const availChip = a.availability.status !== 'active' && a.availability.status !== 'unconfirmed'
    ? `<span class="nfl-chip nfl-chip-avail nfl-avail-${esc(a.availability.status)}" title="${esc(a.availability.note || '')}">${esc(AVAIL_LABEL[a.availability.status] || a.availability.status)}</span>`
    : '';
  const atdOdds = p.odds?.atd?.best;
  const oddsChip = atdOdds ? `<a class="nfl-chip nfl-odds-chip" href="${esc(atdOdds.link)}" target="_blank" rel="noopener" title="${esc(atdOdds.book)} · Anytime TD — tap to bet">Bet ${priceFmt(atdOdds.price)}</a>` : '';
  return `
<div class="nfl-player ${isOut ? 'is-out' : ''}" data-gsis="${esc(p.gsisId)}">
  <div class="nfl-p-rank">${opts.rank != null ? opts.rank : ''}</div>
  <img class="nfl-p-head" src="${esc(p.headshot || '')}" alt="" loading="lazy"
       onerror="this.style.visibility='hidden'"/>
  <div class="nfl-p-main">
    <div class="nfl-p-name">${esc(p.name)}
      <span class="nfl-p-pos">${esc(p.position)}${p.jersey ? ` · #${esc(p.jersey)}` : ''}</span>
    </div>
    <div class="nfl-p-sub">
      <span class="nfl-p-team">${esc(p.team)}</span>
      <span class="nfl-p-vs">vs ${esc(p.opponent)}</span>
      ${depth}${moved}${confChip}${availChip}${oddsChip}
    </div>
  </div>
  <div class="nfl-p-prob">
    <div class="nfl-p-pct">${pct(a.probability)}</div>
    <div class="nfl-p-bar"><span style="width:${barW.toFixed(1)}%"></span></div>
  </div>
  <div class="nfl-p-grade nfl-grade-${esc(a.grade)}" title="${esc(a.gradeLabel)}">${esc(a.grade)}</div>
</div>`;
}

// ---------------------------------------------------------------------------
// render
// ---------------------------------------------------------------------------
function allPlayers() {
  return slate.games.flatMap(g => g.players);
}

function renderPicks(host) {
  let list = activeGameId
    ? (slate.games.find(g => g.gameId === activeGameId)?.players || [])
    : allPlayers();
  if (posFilter !== 'ALL') list = list.filter(p => p.position === posFilter);
  list = [...list].sort((a, b) => b.props.atd.probability - a.props.atd.probability);
  const limit = activeGameId ? list.length : 40;
  const shown = list.slice(0, limit);
  host.innerHTML = shown.length
    ? shown.map((p, i) => playerRow(p, { rank: i + 1 })).join('')
    : '<div class="nfl-empty">No players match this filter.</div>';
}

function renderGames(host) {
  host.innerHTML = slate.games.map(gameCard).join('');
  host.querySelectorAll('.nfl-game').forEach(el => {
    const open = () => {
      const id = el.dataset.game;
      activeGameId = activeGameId === id ? null : id;
      render();
    };
    el.addEventListener('click', open);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });
  });
}

export function render() {
  const root = document.getElementById('nflView');
  if (!root || !slate) return;
  const g = activeGameId ? slate.games.find(x => x.gameId === activeGameId) : null;
  const conf = slate.rosters?.dataConfidence || {};
  const weekLabel = slate.seasonType === 'pre' ? `Preseason Week ${slate.week}`
    : slate.seasonType === 'post' ? `Postseason Week ${slate.week}`
    : `Week ${slate.week}`;

  root.innerHTML = `
${isPreview('nfl') ? `<div class="nfl-preview-banner" role="status">
  <b>Preview build</b> — Touchdown Watch is not live yet. The model runs on 2025 production
  blended with 2026 rosters and depth charts; numbers are directional and unvalidated against results.
</div>` : ''}

<header class="nfl-head">
  <div class="nfl-head-left">
    <h2 class="nfl-title">Anytime Touchdown</h2>
    <p class="nfl-sub">${esc(weekLabel)} · ${slate.gameCount} games · ${allPlayers().length} players graded.
      Ranked by modeled probability of scoring a rushing or receiving touchdown.</p>
  </div>
  <div class="nfl-head-meta">
    <div class="nfl-freshness">Built ${esc(relTime(slate.generatedAt))}</div>
    <div class="nfl-datamix">
      <span title="Players with real 2025 production">${conf.full || 0} with history</span>
      <span title="2026 rookies — prior-based projections">${conf.rookie || 0} rookies</span>
      <span title="On a 2026 roster but no 2025 production">${conf['no-history'] || 0} no sample</span>
    </div>
  </div>
</header>

<div class="nfl-toolbar">
  <div class="nfl-filters" role="group" aria-label="Position filter">
    ${['ALL', 'RB', 'WR', 'TE', 'QB'].map(k => `<button type="button" class="nfl-filter ${posFilter === k ? 'active' : ''}" data-pos="${k}">${k}</button>`).join('')}
  </div>
  ${activeGameId ? `<button type="button" class="nfl-clear" id="nflClearGame">← All ${slate.gameCount} games</button>` : ''}
</div>

${slate.seasonType === 'pre' ? `<div class="nfl-preseason-banner" role="status">
  <span class="nfl-preseason-icon" aria-hidden="true">!</span>
  <p><b>Preseason mode.</b> Starters rarely play the full game — and many don't play at all —
  so ATD probabilities here are projections of the regular-season role, not live reps.
  Expect sizable misses; treat the numbers as a directional preview, not a prediction.</p>
</div>` : ''}

${slate.seasonType === 'pre' ? previewOddsHTML(oddsDoc) : ''}

${g ? `
<section class="nfl-gamecast">
  <div class="nfl-gc-field">
    ${fieldSVG(g, 'full')}
    <div class="nfl-gc-overlay">
      <div class="nfl-gc-team">
        <img class="nfl-logo lg" src="${esc(g.away.logo)}" alt=""/>
        <div><div class="nfl-gc-abbr"><span class="nfl-gc-full">${esc(g.away.name)}</span><span class="nfl-gc-short">${esc(g.away.abbr)}</span></div>
        <div class="nfl-gc-rz">${esc(rzDefLabel(g.away.rzDefense).text)}</div></div>
      </div>
      <div class="nfl-gc-center">
        <div class="nfl-gc-kick">${g.status === 'pre' ? esc(kickoff(g.startTimeUTC)) : `${esc(g.away.score)}–${esc(g.home.score)}`}</div>
        <div class="nfl-gc-detail">${esc(g.statusDetail || '')}</div>
      </div>
      <div class="nfl-gc-team nfl-gc-team-home">
        <div class="nfl-ta-right"><div class="nfl-gc-abbr"><span class="nfl-gc-full">${esc(g.home.name)}</span><span class="nfl-gc-short">${esc(g.home.abbr)}</span></div>
        <div class="nfl-gc-rz">${esc(rzDefLabel(g.home.rzDefense).text)}</div></div>
        <img class="nfl-logo lg" src="${esc(g.home.logo)}" alt=""/>
      </div>
    </div>
  </div>
  <div class="nfl-gc-info">
    <span>${esc(g.venue?.name || '')}${g.venue?.city ? ` · ${esc(g.venue.city)}` : ''}</span>
    ${(g.broadcast || []).map(b => `<span class="nfl-chip">${esc(b.names?.join('/') || '')}</span>`).join('')}
  </div>
  ${oddsHTML(g)}
</section>` : `<div class="nfl-games" id="nflGames"></div>`}

<div class="nfl-picklist-head">
  <h3>${g ? `${esc(g.away.abbr)} @ ${esc(g.home.abbr)} — every graded player` : `Top 40 across the slate`}</h3>
</div>
<div class="nfl-picklist" id="nflPickList"></div>

<footer class="nfl-foot">
  Model: ${esc(slate.sources?.model || '')}<br/>
  Rosters &amp; depth charts: ${esc(slate.rosters?.source || '')}${slate.rosters?.depthSnapshot ? ` (snapshot ${esc(slate.rosters.depthSnapshot)})` : ''}.
  Schedule and injuries: ESPN. Player data: nflverse (CC-BY 4.0).<br/>
  First season for Touchdown Watch: probabilities are built from 2025 production blended with 2026
  rosters and depth charts, and have not yet been validated against 2026 results.<br/>
  Modeled projections for entertainment only — not betting advice.
</footer>`;

  if (!g) renderGames(root.querySelector('#nflGames'));
  renderPicks(root.querySelector('#nflPickList'));
  root.querySelectorAll('.nfl-filter').forEach(b => b.addEventListener('click', () => {
    posFilter = b.dataset.pos; render();
  }));
  const clear = root.querySelector('#nflClearGame');
  if (clear) clear.addEventListener('click', () => { activeGameId = null; render(); });
}

let loading = false;
export async function mount() {
  const root = document.getElementById('nflView');
  if (!root) return;
  if (slate) { render(); return; }
  if (loading) return;
  loading = true;
  root.innerHTML = `<div class="nfl-loading">
    ${Array.from({ length: 4 }, () => '<div class="nfl-skel"></div>').join('')}
  </div>`;
  try {
    const r = await fetch(CFG.slateUrl, { cache: 'no-cache' });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    slate = await r.json();
    if (!slate.games?.length) throw new Error('slate contains no games');
    // Player-prop odds sample (OpticOdds). Fail-soft: a missing file or no name
    // matches just means no odds chips render — the view still works.
    try {
      const or = await fetch(ODDS_URL, { cache: 'no-cache' });
      if (or.ok) oddsDoc = await or.json();
      mergeNflOdds(slate, oddsDoc);
    } catch { oddsDoc = null; }
    render();
    // Live score polling (ESPN scoreboard, CORS-enabled) keeps score/period/
    // clock/possession current so the win-probability tiles stay live.
    startLivePolling(slate, () => render());
  } catch (e) {
    root.innerHTML = `<div class="nfl-error">
      <div class="nfl-error-title">Couldn't load the NFL slate</div>
      <div>Expected <code>${esc(CFG.slateUrl)}</code>. ${esc(e.message)}</div>
      <div class="nfl-error-hint">Build it with <code>node build-slate.js --sport nfl</code>.</div>
    </div>`;
  } finally {
    loading = false;
  }
}

window.DW_NFL = { mount, render };
