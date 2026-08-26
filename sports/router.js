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

let sportDropdownOpen = false;

function comingSoonNote(sport) {
  const s = SPORTS[sport];
  return s.seasonStart ? `Launches ${s.seasonStart}` : 'Coming soon';
}

/**
 * Dropdown, not a bar — same underlying data and the same adapterReady/
 * uiReady gating as before, just presented as a trigger + menu instead of
 * a row of pills, to leave more header room. The trigger shows the
 * CURRENT sport's own brand + accent color, same as the pill it replaces
 * used to look once active.
 */
function renderPills(active) {
  const host = document.getElementById('sportSwitch');
  if (!host) return;
  const activeInfo = SPORTS[active];

  host.innerHTML =
    `<button type="button" class="sport-dd-trigger" id="sportDdTrigger" style="--sport-accent:${activeInfo.accent}">` +
      `<span class="sport-dd-trigger-name">${activeInfo.brand}</span>` +
      `<span class="sport-dd-chevron">▾</span>` +
    `</button>` +
    `<div class="sport-dd-menu" id="sportDdMenu">` +
      SPORT_ORDER.map(key => {
        const s = SPORTS[key];
        const isActive = key === active;
        const enabled = s.adapterReady;
        const cls = ['sport-dd-item', isActive ? 'active' : '', enabled ? '' : 'soon']
          .filter(Boolean).join(' ');
        return `<button type="button" class="${cls}" data-sport="${key}"${enabled ? '' : ' disabled'}>` +
          `<span class="sport-dd-item-name">${s.brand}</span>` +
          `${enabled ? '' : `<span class="sport-pill-soon">${comingSoonNote(key)}</span>`}` +
          `</button>`;
      }).join('') +
    `</div>`;

  const trigger = document.getElementById('sportDdTrigger');
  const menu = document.getElementById('sportDdMenu');
  trigger.addEventListener('click', e => {
    e.stopPropagation();
    sportDropdownOpen ? closeSportDropdown() : openSportDropdown();
  });
  menu.querySelectorAll('.sport-dd-item').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const key = btn.dataset.sport;
      if (!SPORTS[key] || !SPORTS[key].adapterReady) return; // coming-soon: no-op, matches the old pill behavior
      closeSportDropdown();
      location.hash = key;
    });
  });
}

function openSportDropdown() {
  sportDropdownOpen = true;
  document.getElementById('sportDdMenu')?.classList.add('open');
  document.getElementById('sportDdTrigger')?.classList.add('open');
  // Closing on an outside click is the one piece of interaction a dropdown
  // needs that a static bar never did — added once per open, removed on
  // close, rather than a permanent document-level listener running at all
  // times.
  document.addEventListener('click', closeSportDropdown, { once: true });
}

function closeSportDropdown() {
  sportDropdownOpen = false;
  document.getElementById('sportDdMenu')?.classList.remove('open');
  document.getElementById('sportDdTrigger')?.classList.remove('open');
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
