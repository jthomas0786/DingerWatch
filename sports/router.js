/**
 * sports/router.js — sport switcher + #hash routing + view swapping.
 *
 * Reads location.hash to pick the active sport. Two flags govern behavior
 * (see sports/registry.js):
 *   adapterReady — the sport is blessed; its switcher pill is enabled.
 *   uiReady      — a view exists and can be rendered behind a #hash.
 *
 * So an unblessed-but-built sport (NFL right now) is reachable at #nfl for QA
 * and renders a "preview" banner, while its pill stays disabled so nobody is
 * routed there by accident.
 *
 * View swapping is additive: the MLB experience keeps its exact DOM, and we only
 * toggle `hidden` on its containers vs the #nflView container. No existing CSS
 * class or DOM id is renamed or removed.
 */
import { SPORTS, SPORT_ORDER, DEFAULT_SPORT, sportFromHash, isViewable, isPreview } from './registry.js';

/** MLB-owned containers that must hide when another sport's view is showing. */
const MLB_SELECTORS = ['.app-main > main', '.app-main > footer', '.app-main > .status-bar'];

function activeSport() {
  const requested = sportFromHash(location.hash);
  // A sport is routable if it has a view at all — adapterReady only gates the pill.
  return isViewable(requested) ? requested : DEFAULT_SPORT;
}

function comingSoonNote(sport) {
  const s = SPORTS[sport];
  return s.seasonStart ? `Launches ${s.seasonStart}` : 'Coming soon';
}

function renderPills(active) {
  const host = document.getElementById('sportSwitch');
  if (!host) return;
  host.innerHTML = SPORT_ORDER.map(key => {
    const s = SPORTS[key];
    const isActive = key === active;
    const enabled = s.adapterReady;              // only blessed sports are clickable
    const cls = ['sport-pill', isActive ? 'active' : '', enabled ? '' : 'soon']
      .filter(Boolean).join(' ');
    const style = isActive ? ` style="--sport-accent:${s.accent}"` : '';
    const label = enabled ? s.brand : comingSoonNote(key);
    return `<button type="button" class="${cls}" data-sport="${key}"${style}` +
      ` title="${label}"${enabled ? '' : ' disabled'}>` +
      `<span class="sport-pill-name">${s.short}</span>` +
      `<span class="sport-pill-code">${key.toUpperCase()}</span>` +
      `${enabled ? '' : '<span class="sport-pill-soon">soon</span>'}` +
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

function setVisible(el, visible) {
  if (!el) return;
  if (visible) el.removeAttribute('hidden');
  else el.setAttribute('hidden', '');
}

async function swapView(active) {
  const nflView = document.getElementById('nflView');
  const showingMlb = active === 'mlb';

  MLB_SELECTORS.forEach(sel => setVisible(document.querySelector(sel), showingMlb));
  setVisible(nflView, active === 'nfl');
  setVisible(document.getElementById('nflSideNav'), active === 'nfl');

  // Mark the shell so CSS can retint the accent per sport.
  document.documentElement.setAttribute('data-sport', active);
  const accent = SPORTS[active]?.accent;
  if (accent) document.documentElement.style.setProperty('--sport-accent', accent);

  if (active === 'nfl') {
    // Lazy-load the NFL view module only when it's actually needed, so the MLB
    // path pays nothing for it.
    try {
      const mod = await import('./nfl/ui.js');
      await mod.mount();
    } catch (e) {
      if (nflView) {
        nflView.innerHTML = '<div class="nfl-error"><div class="nfl-error-title">' +
          'Couldn\'t load the Touchdown Watch view</div><div>' +
          String(e && e.message ? e.message : e).replace(/[<>&]/g, '') + '</div></div>';
      }
    }
  }
}

function render() {
  const active = activeSport();
  window.DW_SPORT = active;
  window.DW_SPORT_PREVIEW = isPreview(active);
  renderPills(active);
  swapView(active);
}

window.DW_getSport = activeSport;
window.addEventListener('hashchange', render);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', render);
} else {
  render();
}
