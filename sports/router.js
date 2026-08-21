/**
 * sports/router.js — sport switcher + #hash routing.
 *
 * Reads location.hash to pick the active sport (default: mlb). Only
 * adapter-ready sports actually switch; the others render as "coming soon"
 * and won't leave the user on a sport that has no data. The active sport is
 * exposed on window.DW_SPORT for the (currently MLB-only) app to read later.
 *
 * This is additive Phase 0 plumbing: it does not touch any existing feature,
 * CSS class, or DOM id — it only adds the #sportSwitch element and wires it up.
 */
import { SPORTS, SPORT_ORDER, DEFAULT_SPORT, sportFromHash } from './registry.js';

function activeSport() {
  const requested = sportFromHash(location.hash);
  return SPORTS[requested].adapterReady ? requested : DEFAULT_SPORT;
}

function comingSoonNote(sport) {
  const s = SPORTS[sport];
  return s.seasonStart ? `Launches ${s.seasonStart}` : 'Coming soon';
}

function render() {
  const host = document.getElementById('sportSwitch');
  if (!host) return;
  const active = activeSport();
  window.DW_SPORT = active;
  host.innerHTML = SPORT_ORDER.map(key => {
    const s = SPORTS[key];
    const isActive = key === active;
    const ready = s.adapterReady;
    const cls = ['sport-pill', isActive ? 'active' : '', ready ? '' : 'soon']
      .filter(Boolean).join(' ');
    const style = isActive ? ` style="--sport-accent:${s.accent}"` : '';
    return `<button type="button" class="${cls}" data-sport="${key}"${style}` +
      ` title="${ready ? s.brand : comingSoonNote(key)}"${ready ? '' : ' disabled'}>` +
      `<span class="sport-pill-name">${s.short}</span>${ready ? '' : '<span class="sport-pill-soon">soon</span>'}` +
      `</button>`;
  }).join('');
  host.querySelectorAll('.sport-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.sport;
      if (!SPORTS[key] || !SPORTS[key].adapterReady) return; // coming-soon: no-op
      location.hash = key;
    });
  });
}

window.DW_getSport = activeSport;
window.addEventListener('hashchange', render);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
