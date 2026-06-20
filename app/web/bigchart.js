// bigchart.js — the maximized "Charts" tab.
//
// Renders ONE market's price-only candlesticks across four timeframes — D1 / W1 / 1M / 3M
// — all aggregated client-side from the same settled daily EoD history (now ~20Y deep,
// see fetch_yfinance.py). There is no intraday: the free yfinance feed is daily-only by
// design, so M1–H4 are deliberately absent.
//
// It reuses the Futures chart engine (loadChart) but keeps its OWN state object
// (bigChartState) instead of the global chartState the Futures tab mutates — monthly /
// quarterly intervals would otherwise break the Futures control bar, which only knows
// daily / weekly. renderBigChart swaps the global chartState for bigChartState
// synchronously around the (synchronous) loadChart call and restores it in a finally, so
// the engine reads the right state without threading a param through 500 lines.

let bigChartState = { key: null, tf: 'd1', interval: 'daily', range: '5y',
  showVolume: false, showOi: true, showCot: true, cotHedging: false, showSpread: false, showDividers: false, zoomAnchorRight: true,
  // Active technical indicators (global, persisted): [{ id, type, params, color, visible }].
  // Loaded from localStorage in openBigChart so it survives reload and applies to every market.
  indicators: [],
  // _tfBeforeHedge remembers the timeframe a COT Hedge toggle jumped away from, so deactivating it
  // restores that timeframe (otherwise you'd be stranded on 6M/12M, unable to zoom back out).
  _tfBeforeHedge: null,
  // Default to the front-month (lead) contract; selectBigChartMarket resolves it per market and
  // falls back to continuous for markets with no tradable contract (USDX proxy, crypto, indices).
  chartMode: 'contract', contractSymbol: null, contractLabel: null };
let _bigChartInited = false;
const BIGCHART_LAST_KEY = 'charthorizon.bigchartMarket.v1';

// [id, interval, label, range, hidden]. The id is the button identity (6M/12M/D1 are all 'daily',
// so interval alone can't distinguish them). 6M/12M are NOT shown as timeframe buttons (hidden:true)
// — they're reachable only via the COT Hedge 6M/12M toggles, which set those ranges internally (the
// Hedging Program is gated to 6m/12m, like the Futures tab). D1 over 20Y would be ~5000 candles in a
// single SVG (heavy and unreadable), so daily caps at 5Y; the higher timeframes get the full history
// (quarterly over 20Y ≈ 80 candles, monthly ≈ 240 — both comfortable).
const BIGCHART_TFS = [
  ['6m', 'daily', '6M', '6m', true],
  ['12m', 'daily', '12M', '12m', true],
  ['d1', 'daily', 'D1', '5y'],
  ['w1', 'weekly', 'W1', 'max'],
  ['1m', 'monthly', '1M', 'max'],
  ['3m', 'quarterly', '3M', 'max'],
];

function initBigChartSidebar() {
  const sb = document.getElementById('bigchartSidebar');
  if (sb) sb.innerHTML = buildCommoditySidebarHtml('bigchart-nav', 'selectBigChartMarket');
  // Mobile picker (the sidebar is hidden below 900px, like every other tab's aside).
  const mobile = document.getElementById('bigchartMobileSelect');
  if (mobile) mobile.innerHTML = Object.entries(INDEX)
    .map(([k, v]) => `<option value="${k}">${esc(v.display_name)}</option>`).join('');
}

// Collapsible market sidebar (Charts tab only — it has no watchlist). Collapsing widens
// the chart; the state is persisted and re-applied on tab open.
const BIGCHART_SIDEBAR_KEY = 'charthorizon.bigchartSidebar.v1';   // 'collapsed' | 'expanded'

function _setBigChartSidebar(collapsed, persist) {
  const layout = document.querySelector('.bigchart-layout');
  if (layout) layout.classList.toggle('sidebar-collapsed', collapsed);
  const btn = document.getElementById('bigchartSidebarToggle');
  if (btn) {
    btn.textContent = collapsed ? '»' : '«';
    btn.title = collapsed ? 'Show markets' : 'Hide markets';
    btn.setAttribute('aria-expanded', String(!collapsed));
  }
  if (persist) { try { localStorage.setItem(BIGCHART_SIDEBAR_KEY, collapsed ? 'collapsed' : 'expanded'); } catch (e) {} }
}

function applyBigChartSidebar() {
  let collapsed = false;
  try { collapsed = localStorage.getItem(BIGCHART_SIDEBAR_KEY) === 'collapsed'; } catch (e) {}
  _setBigChartSidebar(collapsed, false);
}

function toggleBigChartSidebar() {
  const layout = document.querySelector('.bigchart-layout');
  const collapsed = !(layout && layout.classList.contains('sidebar-collapsed'));
  _setBigChartSidebar(collapsed, true);
  // Re-render so the chart fills (or yields) the reclaimed width; rAF lets the grid reflow first.
  const cfg = currentBigChartCfg();
  if (cfg) requestAnimationFrame(() => renderBigChart(cfg));
}

function renderBigChartTfBar() {
  const bar = document.getElementById('bigchartTfBar');
  if (!bar) return;
  bar.innerHTML = BIGCHART_TFS.filter(t => !t[4]).map(([id, interval, label]) =>
    `<button class="fx-timeframe-btn${bigChartState.tf === id ? ' active' : ''}" type="button" onclick="setBigChartTf('${id}')">${label}</button>`
  ).join('');
}

// Volume / OI / COT / COT Hedge 6M / COT Hedge 12M / Spread indicator toggles (Charts tab). OI and
// COT are CFTC weekly data, so those two are disabled (greyed) outside Daily/Weekly. The two COT
// Hedge toggles re-scale the COT pane to a trailing hedging window — one per window length. The
// active window IS the current range, so no extra state: each toggle just shows COT and sets its
// timeframe (6M/12M), which makes them mutually exclusive and always clickable. Leaving 6M/12M
// clears hedging (see setBigChartTf), so neither box is ever "checked but inert". Handlers mutate
// bigChartState and re-render through renderBigChart — the maximize/state-swap path — NOT loadChart
// directly like the Futures bindChartControls does, which would render into the global chartState.
function renderBigChartIndicatorBar() {
  const bar = document.getElementById('bigchartIndicatorBar');
  if (!bar) return;
  const oiCotAvail = paneShowsOiCot(bigChartState.interval);
  const box = (key, label, checked, title, disabled = false) =>
    `<label class="cot-filter-box${disabled ? ' disabled' : ''}" title="${title}">`
    + `<input type="checkbox" ${checked ? 'checked' : ''} ${disabled ? 'disabled' : ''} onchange="toggleBigChartIndicator('${key}', this.checked)">`
    + `<span>${label}</span></label>`;
  const cftcTitle = oiCotAvail ? null : 'Needs the Daily or Weekly timeframe (CFTC data is weekly)';
  bar.innerHTML =
    box('showVolume', 'Volume', bigChartState.showVolume, 'Show or hide the volume pane') +
    box('showOi', 'OI', bigChartState.showOi && oiCotAvail,
        cftcTitle || 'Show or hide the Open Interest pane (CFTC weekly)', !oiCotAvail) +
    box('showCot', 'COT', bigChartState.showCot && oiCotAvail,
        cftcTitle || 'Show or hide the COT net-position pane (CFTC weekly)', !oiCotAvail) +
    box('hedge6m', 'COT Hedge 6M', bigChartState.cotHedging && bigChartState.range === '6m',
        'COT Hedging Program over the trailing 6-month window (switches to 6M; green above midpoint, red below)') +
    box('hedge12m', 'COT Hedge 12M', bigChartState.cotHedging && bigChartState.range === '12m',
        'COT Hedging Program over the trailing 12-month window (switches to 12M; green above midpoint, red below)') +
    box('showSpread', 'Spread', bigChartState.showSpread, 'Show or hide the calendar-spread pane (front minus next contract; below 0 = contango)') +
    box('showDividers', 'Dividers', bigChartState.showDividers, 'Vertical period dividers — one per month on Daily, one per year on Weekly/Monthly/Quarterly');
}

function toggleBigChartIndicator(key, on) {
  // Virtual hedging toggles: each picks its trailing window and turns the COT Hedging Program on.
  // The active window IS the current range (no extra state) — so turning one on just shows COT and
  // sets the timeframe; selecting the other moves off this one's range, making them exclusive.
  if (key === 'hedge6m' || key === 'hedge12m') {
    if (on) {
      // Remember where we came from (only on the first activation) so turning hedging off can
      // restore it — 6M/12M cap the chart at ~6/12 months, so without this you can't zoom back out.
      if (!bigChartState.cotHedging) bigChartState._tfBeforeHedge = bigChartState.tf;
      bigChartState.showCot = true;
      bigChartState.cotHedging = true;
      setBigChartTf(key === 'hedge6m' ? '6m' : '12m');   // re-renders bar + chart (keeps cotHedging on 6m/12m)
    } else {
      bigChartState.cotHedging = false;
      const back = bigChartState._tfBeforeHedge;
      bigChartState._tfBeforeHedge = null;
      if (back && back !== bigChartState.tf) { setBigChartTf(back); return; }   // restore the prior timeframe
      renderBigChartIndicatorBar();
      renderBigChart(currentBigChartCfg());
    }
    return;
  }
  bigChartState[key] = !!on;
  renderBigChartIndicatorBar();   // re-sync dependent toggles
  renderBigChart(currentBigChartCfg());
}

// ══ Technical indicators (SMA/EMA/Bollinger overlays + RSI/Stoch/MACD/ATR panes) ══
// Global + persisted: one list in bigChartState.indicators, saved to localStorage and applied
// to every market. The math lives in indicators.js (computeIndicator); chart.js draws them. This
// block owns only the UI: the +Indicators add-menu, the chips, and the per-instance settings popover.
const BIGCHART_INDICATORS_KEY = 'charthorizon.indicators.v1';

function _loadBigChartIndicators() {
  let raw = [];
  try { raw = JSON.parse(localStorage.getItem(BIGCHART_INDICATORS_KEY) || '[]'); } catch (e) { raw = []; }
  if (!Array.isArray(raw) || typeof INDICATOR_DEFS === 'undefined') return [];
  // Keep only known types; normalize shape so a hand-edited / stale entry can't crash a render.
  return raw.filter(i => i && INDICATOR_DEFS[i.type]).map(i => ({
    id: i.id || _newIndicatorId(),
    type: i.type,
    params: (i.params && typeof i.params === 'object') ? i.params : {},
    color: i.color || INDICATOR_DEFS[i.type].color,
    visible: i.visible !== false,
  }));
}
function _saveBigChartIndicators() {
  try { localStorage.setItem(BIGCHART_INDICATORS_KEY, JSON.stringify(bigChartState.indicators || [])); } catch (e) {}
}
let _indicatorIdSeq = 0;
function _newIndicatorId() { _indicatorIdSeq += 1; return 'ind' + Date.now().toString(36) + (_indicatorIdSeq).toString(36); }

// Re-render the chips + re-draw the chart after any change.
function _refreshBigChartIndicators() {
  _saveBigChartIndicators();
  renderBigChartTaBar();
  renderBigChart(currentBigChartCfg());
}

// The control-row bar: chips for each active indicator + the +Indicators add button.
function renderBigChartTaBar() {
  const bar = document.getElementById('bigchartTaBar');
  if (!bar || typeof INDICATOR_DEFS === 'undefined') return;
  const dim = (typeof indicatorsHidden === 'function' && indicatorsHidden()) ? ' ta-hidden' : '';
  const chips = (bigChartState.indicators || []).map(ind => {
    const col = indicatorColor(ind);
    return `<span class="ta-chip${dim}" title="Click to edit · ✕ to remove" onclick="openBigChartIndicatorSettings('${ind.id}', this)">`
      + `<span class="ta-chip-dot" style="background:${col}"></span>`
      + `<span class="ta-chip-label">${esc(indicatorChipLabel(ind))}</span>`
      + `<button class="ta-chip-x" type="button" title="Remove" onclick="event.stopPropagation();removeBigChartIndicator('${ind.id}')" aria-label="Remove indicator">✕</button>`
      + `</span>`;
  }).join('');
  bar.innerHTML = chips
    + `<button class="ta-add-btn" type="button" onclick="toggleBigChartIndicatorMenu(this)" title="Add a technical indicator" aria-label="Add indicator">+ Indicators ▾</button>`;
}

// ── add-menu flyout ──
function closeBigChartIndicatorMenu() { const m = document.getElementById('bigchartTaMenu'); if (m) m.remove(); }
function toggleBigChartIndicatorMenu(btn) {
  if (document.getElementById('bigchartTaMenu')) { closeBigChartIndicatorMenu(); return; }
  closeBigChartIndicatorSettings();
  const fly = document.createElement('div');
  fly.id = 'bigchartTaMenu'; fly.className = 'ta-flyout ta-menu';
  fly.innerHTML = (typeof INDICATOR_MENU !== 'undefined' ? INDICATOR_MENU : []).map(grp =>
    `<div class="ta-menu-group">${esc(grp.group)}</div>`
    + grp.items.filter(t => INDICATOR_DEFS[t]).map(t =>
      `<button class="ta-menu-item" type="button" onclick="addBigChartIndicator('${t}')">`
      + `<span class="ta-chip-dot" style="background:${INDICATOR_DEFS[t].color}"></span>${esc(INDICATOR_DEFS[t].label)}</button>`).join('')
  ).join('');
  document.body.appendChild(fly);
  _positionFlyout(fly, btn);
}
function addBigChartIndicator(type) {
  if (typeof INDICATOR_DEFS === 'undefined' || !INDICATOR_DEFS[type]) return;
  bigChartState.indicators = bigChartState.indicators || [];
  bigChartState.indicators.push({ id: _newIndicatorId(), type, params: {}, color: INDICATOR_DEFS[type].color, visible: true });
  closeBigChartIndicatorMenu();
  _refreshBigChartIndicators();
}
function removeBigChartIndicator(id) {
  bigChartState.indicators = (bigChartState.indicators || []).filter(i => i.id !== id);
  closeBigChartIndicatorSettings();
  _refreshBigChartIndicators();
}

// ── per-instance settings popover (period/source/colour/delete) ──
function closeBigChartIndicatorSettings() { const p = document.getElementById('bigchartTaPop'); if (p) p.remove(); }
function openBigChartIndicatorSettings(id, chipEl) {
  if (document.getElementById('bigchartTaPop')) { closeBigChartIndicatorSettings(); return; }
  closeBigChartIndicatorMenu();
  const ind = (bigChartState.indicators || []).find(i => i.id === id);
  if (!ind || typeof INDICATOR_FIELDS === 'undefined') return;
  const p = indicatorParams(ind);
  const fields = INDICATOR_FIELDS[ind.type] || [];
  const fieldHtml = fields.map(f => {
    if (f.kind === 'source') {
      const opts = INDICATOR_SOURCES.map(s => `<option value="${s}"${p[f.key] === s ? ' selected' : ''}>${s}</option>`).join('');
      return `<label class="ta-pop-row"><span>${esc(f.label)}</span><select onchange="updateBigChartIndicatorParam('${id}','${f.key}',this.value,'source')">${opts}</select></label>`;
    }
    const step = f.kind === 'num' ? '0.1' : '1';
    return `<label class="ta-pop-row"><span>${esc(f.label)}</span><input type="number" min="1" step="${step}" value="${esc(String(p[f.key]))}" onchange="updateBigChartIndicatorParam('${id}','${f.key}',this.value,'${f.kind}')"></label>`;
  }).join('');
  const pop = document.createElement('div');
  pop.id = 'bigchartTaPop'; pop.className = 'ta-flyout ta-pop';
  pop.innerHTML = `<div class="ta-pop-head">${esc(indicatorChipLabel(ind))}</div>`
    + fieldHtml
    + `<label class="ta-pop-row"><span>Colour</span><input type="color" value="${esc(indicatorColor(ind))}" onchange="updateBigChartIndicatorColor('${id}',this.value)"></label>`
    + `<button class="ta-pop-del" type="button" onclick="removeBigChartIndicator('${id}')">Remove</button>`;
  document.body.appendChild(pop);
  _positionFlyout(pop, chipEl);
}
function updateBigChartIndicatorParam(id, key, value, kind) {
  const ind = (bigChartState.indicators || []).find(i => i.id === id);
  if (!ind) return;
  ind.params = ind.params || {};
  if (kind === 'source') { ind.params[key] = value; }
  else {
    let v = kind === 'num' ? parseFloat(value) : parseInt(value, 10);
    if (!Number.isFinite(v) || v < 1) v = indicatorDefaults(ind.type)[key];   // reject junk → default
    ind.params[key] = v;
  }
  _refreshBigChartIndicators();
  // Refresh the popover heading (label may have changed, e.g. period edit).
  const pop = document.getElementById('bigchartTaPop');
  if (pop) { const h = pop.querySelector('.ta-pop-head'); if (h) h.textContent = indicatorChipLabel(ind); }
}
function updateBigChartIndicatorColor(id, color) {
  const ind = (bigChartState.indicators || []).find(i => i.id === id);
  if (!ind) return;
  ind.color = color;
  _refreshBigChartIndicators();
}

// Position a flyout under (or above, if it would overflow) its trigger, clamped to the viewport.
function _positionFlyout(fly, ref) {
  if (!ref) { fly.style.left = '20px'; fly.style.top = '80px'; return; }
  const r = ref.getBoundingClientRect();
  const fw = fly.offsetWidth, fh = fly.offsetHeight;
  let left = Math.min(r.left, window.innerWidth - fw - 8);
  let top = r.bottom + 6;
  if (top + fh > window.innerHeight - 8) top = Math.max(8, r.top - fh - 6);
  fly.style.left = Math.max(8, left) + 'px';
  fly.style.top = top + 'px';
}

// Close TA flyouts on an outside click / Escape (registered once).
document.addEventListener('mousedown', (e) => {
  const menu = document.getElementById('bigchartTaMenu');
  const pop = document.getElementById('bigchartTaPop');
  if (menu && !menu.contains(e.target) && !e.target.closest('.ta-add-btn')) closeBigChartIndicatorMenu();
  if (pop && !pop.contains(e.target) && !e.target.closest('.ta-chip')) closeBigChartIndicatorSettings();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeBigChartIndicatorMenu(); closeBigChartIndicatorSettings(); }
});

// "Anchor right": when on (default), the mouse-wheel zoom keeps the right edge (newest bar)
// fixed so the chart doesn't shift — only the left side grows/shrinks. Off = zoom anchors at the
// cursor. Only affects the next wheel event, so no repaint is needed here.
function setBigChartZoomAnchor(on) {
  bigChartState.zoomAnchorRight = !!on;
}

// Continuous / Front-Month toggle. "Front Month" = the highest-volume LEAD contract
// (frontContractIndex — the actively-traded month, not the nearest by calendar). Disabled for
// markets with no tradable contract (USDX proxy, crypto, indices).
function renderBigChartContractBar() {
  const bar = document.getElementById('bigchartContractBar');
  if (!bar) return;
  const cfg = currentBigChartCfg();
  const idx = cfg ? frontContractIndex(cfg.contracts || []) : -1;
  const hasFront = idx >= 0 && cfg && cfg.contracts && cfg.contracts[idx] && !!cfg.contracts[idx].yf_symbol;
  const mode = bigChartState.chartMode === 'contract' ? 'frontMonth' : 'continuous';
  const btn = (val, label, disabled, title) =>
    `<button class="fx-timeframe-btn${mode === val ? ' active' : ''}${disabled ? ' disabled' : ''}" type="button" ${disabled ? 'disabled' : ''} onclick="setBigChartContractMode('${val}')" title="${title}">${label}</button>`;
  bar.innerHTML =
    btn('continuous', 'Continuous', false, 'Native front-month continuous series') +
    btn('frontMonth', 'Front Month', !hasFront,
        hasFront ? 'Switch to the highest-volume front-month contract' : 'No tradable front-month contract for this market');
}

// Switch the visible source. Front-month lazy-loads the lead contract's own daily history via
// /api/contract-history (cached on the contract), then drives the engine's contract mode. Falls
// back to continuous when there is no tradable contract or the fetch yields nothing.
async function setBigChartContractMode(mode) {
  const cfg = currentBigChartCfg();
  if (!cfg) return;
  const toContinuous = () => {
    bigChartState.chartMode = 'continuous';
    bigChartState.contractSymbol = null;
    bigChartState.contractLabel = null;
    renderBigChartContractBar();
    renderBigChart(cfg);
  };
  if (mode !== 'frontMonth') { toContinuous(); return; }

  const contracts = cfg.contracts || [];
  const idx = frontContractIndex(contracts);
  const lead = idx >= 0 ? contracts[idx] : null;
  if (!lead || !lead.yf_symbol) { toContinuous(); return; }     // no tradable contract → continuous

  if (!(lead.chart_history && lead.chart_history.length)) {     // lazy fetch (mirrors smt.js), cached on the contract
    try {
      const url = `/api/contract-history?symbol=${encodeURIComponent(lead.yf_symbol)}&period=${CONTRACT_HISTORY_PERIOD}`;
      const res = await fetch(url);
      const payload = await res.json();
      if (res.ok && Array.isArray(payload.history) && payload.history.length) lead.chart_history = payload.history;
    } catch (e) {}
  }
  if (currentBigChartCfg() !== cfg) return;                     // market changed while awaiting
  if (!(lead.chart_history && lead.chart_history.length)) { toContinuous(); return; }   // fetch failed → continuous

  bigChartState.chartMode = 'contract';
  bigChartState.contractSymbol = lead.yf_symbol;
  bigChartState.contractLabel = lead.delivery_month_label || lead.label || lead.contract_symbol || lead.yf_symbol;
  renderBigChartContractBar();
  renderBigChart(cfg);
}

function currentBigChartCfg() {
  const meta = INDEX[bigChartState.key];
  const cat = meta && catCache[meta.slug];
  return cat ? cat[bigChartState.key] : null;
}

// Swap the global chartState for ours, render through the shared engine, restore.
// loadChart is fully synchronous, so nothing observes the swapped value mid-flight.
function renderBigChart(cfg) {
  if (!cfg) return;
  // Maximize so the WHOLE chart fits the viewport with no page scroll. Size the price pane
  // from the real geometry: measure the non-svg overhead (section-row label + legend + the
  // body's own padding) off the previous render, subtract the surrounding main padding, and
  // the section-row + svg + legend land exactly inside the window.
  const body = document.getElementById('bigchartBody');
  const main = body && body.closest('.bigchart-main');
  let priceH = 480;
  if (body) {
    const bodyTop = body.getBoundingClientRect().top;
    // Overhead = the body's non-svg chrome (section row above the chart + legend below + padding).
    // Measure it from the svg's own position — NOT body.height - svg.height: when the object-tree
    // panel is open the flex row stretches the body to the full .bigchart-main height, so body.height
    // over-reports the overhead and collapses priceH to its floor (and every later re-render, e.g. a
    // continuous↔front-month toggle, would read that same stretched height). The svg's top offset and
    // the legend's bottom are content positions, immune to that stretch.
    const prevSvg = body.querySelector('.chart-svg-wrap svg');
    const wrap = body.querySelector('.chart-svg-wrap');
    const legend = wrap ? wrap.nextElementSibling : null;
    const padBottom = parseFloat(getComputedStyle(body).paddingBottom) || 0;
    let overhead = 96;                          // first paint (no svg yet): close estimate, self-corrects
    if (prevSvg) {
      const svgR = prevSvg.getBoundingClientRect();
      const below = legend ? (legend.getBoundingClientRect().bottom - svgR.bottom) : 0;
      overhead = (svgR.top - bodyTop) + below + padBottom;
    }
    const mainPadBottom = main ? (parseFloat(getComputedStyle(main).paddingBottom) || 0) : 0;
    const avail = window.innerHeight - bodyTop - mainPadBottom - 6;
    // Leave room for any active indicator panes (Volume/Spread, plus OI+COT in D1/W1) so the
    // whole stack still fits the viewport with no page scroll. 30 = the svg's own axis/x-label band.
    priceH = Math.max(280, Math.round(avail - overhead - 30 - panesHeight(bigChartState)));
  }
  const saved = chartState;
  chartState = bigChartState;
  try {
    loadChart(cfg, { bodyId: 'bigchartBody', symId: 'bigchartSym', controls: false, panes: true, rollMarkers: false, priceH, wheelZoom: true, drawings: true, rerender: () => renderBigChart(cfg) });
  } finally {
    chartState = saved;
  }
  updateBigChartLatestBtn();
}

// "→| Aktuell": slide the visible window to the right edge (newest bars) at the CURRENT zoom
// level, so you can return to the present after zooming into older data without losing the zoom.
// loadChart stashes the full bar count on bigChartState._zoomN.
function jumpBigChartToLatest() {
  const N = bigChartState._zoomN;
  if (!Number.isFinite(N) || N < 2) return;
  if (!Number.isFinite(bigChartState.zoomStart) || !Number.isFinite(bigChartState.zoomEnd)) return;  // full view already shows latest
  const span = bigChartState.zoomEnd - bigChartState.zoomStart;
  const newStart = Math.max(0, N - 1 - span);
  if (newStart === bigChartState.zoomStart) return;   // already at the right edge
  bigChartState.zoomStart = newStart;
  bigChartState.zoomEnd = N - 1;
  renderBigChart(currentBigChartCfg());
}

// Enable the button only when zoomed in AND not already showing the newest bar.
function updateBigChartLatestBtn() {
  const btn = document.getElementById('bigchartLatestBtn');
  if (!btn) return;
  const N = bigChartState._zoomN;
  const zoomed = Number.isFinite(bigChartState.zoomStart) && Number.isFinite(bigChartState.zoomEnd);
  const atLatest = zoomed && Number.isFinite(N) && bigChartState.zoomEnd >= N - 1;
  const canJump = zoomed && !atLatest;
  btn.disabled = !canJump;
  btn.classList.toggle('disabled', !canJump);
}

// SVG colors are baked in at render time, so a theme switch needs a repaint (wired into
// core.js rerenderThemedCharts).
function repaintBigChartThemed() {
  const cfg = currentBigChartCfg();
  if (cfg) renderBigChart(cfg);
}

function setBigChartTf(id) {
  const tf = BIGCHART_TFS.find(t => t[0] === id);
  if (!tf) return;
  bigChartState.tf = tf[0];
  bigChartState.interval = tf[1];
  bigChartState.range = tf[3];
  // COT Hedging Program only applies to the 6M/12M trailing window — clear it elsewhere so the box
  // never shows checked-but-inert (mirrors the Futures tab clearing hedging on the 5Y range).
  if (bigChartState.range !== '6m' && bigChartState.range !== '12m') bigChartState.cotHedging = false;
  renderBigChartTfBar();
  renderBigChartIndicatorBar();   // refresh OI/COT/Hedging state for this timeframe
  renderBigChart(currentBigChartCfg());
}

async function selectBigChartMarket(key) {
  if (!INDEX[key]) return;
  bigChartState.key = key;
  if (typeof drawState !== 'undefined') drawState.selectedId = null;   // drawings are per-market
  if (typeof closeDrawContextMenu === 'function') closeDrawContextMenu();
  try { localStorage.setItem(BIGCHART_LAST_KEY, key); } catch (e) {}
  const meta = INDEX[key];
  document.querySelectorAll('#bigchartSidebar .commodity-item').forEach(b => b.classList.remove('active'));
  document.getElementById('bigchart-nav-' + key)?.classList.add('active');
  const mobile = document.getElementById('bigchartMobileSelect');
  if (mobile && mobile.value !== key) mobile.value = key;
  const catEl = document.getElementById('bigchartCat');
  const nameEl = document.getElementById('bigchartName');
  if (catEl) catEl.textContent = meta.category || '';
  if (nameEl) nameEl.textContent = meta.display_name || key;
  const bodyEl = document.getElementById('bigchartBody');
  if (bodyEl) bodyEl.innerHTML = '<div class="chart-empty">Loading…</div>';
  const cat = await loadCategory(meta.slug);
  const cfg = cat && cat[key];
  if (!cfg) {
    if (bodyEl) bodyEl.innerHTML = '<div class="chart-empty">Data could not be loaded.</div>';
    return;
  }
  // A fast re-click may have moved on to a different market while we awaited the fetch.
  if (bigChartState.key !== key) return;
  renderBigChartContractBar();                 // reflect this market's front-month availability
  if (bigChartState.chartMode === 'contract') {
    setBigChartContractMode('frontMonth');     // preserve the mode: re-resolve & load this market's lead
  } else {
    renderBigChart(cfg);
  }
}

// Live, full-resolution resize. While the window is being dragged the browser fires a
// burst of resize events; requestAnimationFrame coalesces them into at most one render per
// frame, and each render rebuilds the SVG at the exact current container width and viewport
// height. So the chart tracks the drag in real time — no max-width down-scaling, no
// right-hand gap, pixel-perfect (full-resolution) at every step instead of snapping only
// after a debounce. Inert unless the Charts tab is the visible one.
let _bigChartResizeRaf = null;
window.addEventListener('resize', () => {
  if (document.getElementById('bigchartPage')?.hidden) return;
  if (_bigChartResizeRaf) return;
  _bigChartResizeRaf = requestAnimationFrame(() => {
    _bigChartResizeRaf = null;
    const cfg = currentBigChartCfg();
    if (cfg) renderBigChart(cfg);
  });
});

async function openBigChart() {
  if (!_bigChartInited) {
    initBigChartSidebar();
    bigChartState.indicators = _loadBigChartIndicators();   // global, persisted; ready before first render
    _bigChartInited = true;
  }
  applyBigChartSidebar();
  renderBigChartTfBar();
  renderBigChartContractBar();
  renderBigChartIndicatorBar();
  renderBigChartTaBar();
  if (typeof renderDrawToolbar === 'function') renderDrawToolbar();
  // Restore the last market, else fall back to the current Futures market, else the first.
  let key = bigChartState.key;
  if (!key) {
    try { key = localStorage.getItem(BIGCHART_LAST_KEY); } catch (e) {}
  }
  if (!key || !INDEX[key]) {
    key = (typeof currentKey !== 'undefined' && INDEX[currentKey]) ? currentKey : Object.keys(INDEX)[0];
  }
  if (key) await selectBigChartMarket(key);
}
