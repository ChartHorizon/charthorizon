
// ff_data/config.js is GENERATED data, and a refresh killed mid-write could leave it
// empty or truncated (fixed at the source in 1.2.3: the generator writes atomically and
// start.py regenerates an incomplete one on the next launch). This dereference is the
// first line of the first module, so a broken file threw here — before INDEX, before
// every module below, before boot.js. Nothing was left to lift the cold-start splash,
// so it hung on the 60s inline net in index.html and then uncovered a blank, dead page:
// the "it won't start any more" a user reports. Files written by older versions are
// still out there, so keep the page alive long enough to say what to do about it.
if (!window.__CONFIG__ || !window.__CONFIG__.index) {
  window.__CONFIG_BROKEN = true;   // boot.js reads this and holds the splash on the message
  window.__CONFIG__ = { index: {}, dataDir: 'ff_data', dataVersion: '', firstKey: null };
  var _brokenPhase = document.getElementById('bootSplashPhase');
  if (_brokenPhase) _brokenPhase.textContent = 'Market data is incomplete — restart ChartHorizon to rebuild it';
  var _brokenDots = document.querySelector('.boot-splash-dots');
  if (_brokenDots) _brokenDots.style.display = 'none';   // .boot-splash-dots is display:flex; [hidden] would not win
}

const INDEX = window.__CONFIG__.index;          // lightweight: metadata only per market
const DATA_DIR = window.__CONFIG__.dataDir;  // folder with the category JSON files
const DATA_VERSION = window.__CONFIG__.dataVersion;
const WATCHLIST_KEY = "charthorizon.watchlist.v1";
const ACTIVE_PAGE_KEY = "charthorizon.activePage.v1"; // remembers active top tab across reloads
const LAST_MARKET_KEY = "charthorizon.lastMarket.v1"; // restore the viewed market across reloads
let currentKey = window.__CONFIG__.firstKey;
let seasonalState = { key: window.__CONFIG__.firstKey };

// Cache for already loaded category data
const catCache = {};   // slug -> { key -> payload }

// Cache-buster bumped on an in-place data reload (see refresh.js). DATA_VERSION is a
// const from config.js, so this nonce is the mutable part appended to data fetches.
let _dataReloadNonce = 0;
function bumpDataReloadNonce() { _dataReloadNonce++; }

const CAT_ICONS = { Energy:'⚡', Metals:'🥇', Agriculture:'🌾', 'Livestock/Dairy':'🐄', Softs:'☕', Indices:'📈', Currencies:'💱', Bonds:'🏦', Crypto:'🪙' };
// Sidebar category order: most broadly-followed / popular first. Keep in sync with
// CATEGORY_POPULARITY in generate_html() (Python), which sets the same INDEX order.
const CATEGORY_POPULARITY = ['Indices','Crypto','Metals','Energy','Currencies','Agriculture','Bonds','Softs','Livestock/Dairy'];
// Chart palette — theme-aware. The values mirror the CSS theme tokens (--chart-*)
// so light/dark live in ONE source of truth (styles.css). applyChartTheme() pulls
// the active theme's values on load and on every switch; the literals below are
// the light fallback. Charts are SVG strings built from CHART_THEME.* at render
// time, so repopulating + re-rendering is enough to recolor them.
const CHART_THEME = {
  bg:'#f4f6fa',
  grid:'#c5cdd7',
  gridSoft:'#d9dee5',
  axis:'#aeb8c4',
  text:'#000000',
  bull:'#6b89f0',         // LIGHT fallback (lightened blue/red; DARK theme overrides to TradingView green/red)
  bullWick:'#91a6f1',
  bear:'#f3795f',
  bearWick:'#f3a08f',
  volume:'#8b98aa',
  volumeBull:'#0ea679',
  volumeBear:'#e53e3e',
  oi:'#52657f',
  oiCftc:'#52657f',       // CFTC weekly history (baseline)
  oiCme:'#0ea679',        // (unused, kept for theme stability)
  oiYf:'#e8853a',         // yfinance fallback (estimated / lower quality)
  spread:'#7c3aed',       // calendar spread (front - next)
  trend:'#000000'         // Macro-Shift user trend lines (black light / white dark)
};
const _CHART_THEME_VARS = {
  bg:'--chart-bg', grid:'--chart-grid', gridSoft:'--chart-grid-soft', axis:'--chart-axis', text:'--chart-text',
  bull:'--chart-bull', bullWick:'--chart-bull-wick', bear:'--chart-bear', bearWick:'--chart-bear-wick',
  volume:'--chart-volume', volumeBull:'--chart-volume-bull', volumeBear:'--chart-volume-bear',
  oi:'--chart-oi', oiCftc:'--chart-oi-cftc', oiCme:'--chart-oi-cme', oiYf:'--chart-oi-yf', spread:'--chart-spread',
  trend:'--chart-trend'
};
// Pull the active theme's --chart-* tokens into CHART_THEME (mutates in place).
function applyChartTheme() {
  const s = getComputedStyle(document.documentElement);
  for (const k in _CHART_THEME_VARS) {
    const v = s.getPropertyValue(_CHART_THEME_VARS[k]).trim();
    if (v) CHART_THEME[k] = v;
  }
}


// ── Chart style options (companion to CHART_THEME; read by every candle surface) ──
// `border`: candle-body outline. null = none (stroke == fill); a hex string = that colour;
// 'darken' = a darker shade of the fill colour (candlePaint() resolves it per candle).
const CHART_STYLE_DEFAULT = { candle: 'filled', wick: 'thin', width: 'normal', grid: 'normal', border: null };
let CHART_STYLE = { ...CHART_STYLE_DEFAULT };

// ── Candle painting: ONE definition, used by every surface that draws candles ──
// Up and down are NOT always separated by colour. The built-in "Black on White"
// preset paints bull and bear the same black and tells them apart purely by the
// hollow up-body, so a renderer that reads CHART_THEME.bull/bear and ignores
// CHART_STYLE collapses into a single black mass — which is exactly what the
// Macro-Shift and Weekly-Outlook charts did until 2026-09-01, and what the
// TradingView widget did with its candleStyle-only overrides. Never pick candle
// colours at the call site; ask candlePaint().
function chartDarkenHex(hex) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return hex || '#000000';
  const n = parseInt(m[1], 16), d = v => Math.max(0, Math.round(v * 0.66));
  return '#' + ((1 << 24) | (d((n >> 16) & 255) << 16) | (d((n >> 8) & 255) << 8) | d(n & 255)).toString(16).slice(1);
}
// Body fill / outline / wick for one candle, resolved from CHART_STYLE + CHART_THEME.
// A hollow body is `fill:'none'`, so callers MUST draw the wick as two guarded
// segments (above and below the body) — a single high→low line shows straight
// through a hollow body.
function candlePaint(up) {
  const hollow = CHART_STYLE.candle === 'hollow';
  const border = CHART_STYLE.border;      // null | hex | 'darken'
  const col = up ? CHART_THEME.bull : CHART_THEME.bear;
  const stroke = !border ? col : (border === 'darken' ? chartDarkenHex(col) : border);
  return {
    hollow, border,
    fill: (hollow && up) ? 'none' : col,
    stroke,
    strokeW: border ? 1 : (hollow ? 1 : 0.5),
    // Wicks follow the body outline whenever one is set, else their own wick colour.
    wick: border ? stroke : (up ? CHART_THEME.bullWick : CHART_THEME.bearWick),
    wickW: CHART_STYLE.wick === 'thick' ? 2 : CHART_STYLE.wick === 'medium' ? 1.5 : 1,
  };
}
// Body width as a fraction of one x-slot.
function candleWidthFactor() {
  return CHART_STYLE.width === 'narrow' ? 0.55 : CHART_STYLE.width === 'wide' ? 0.85 : 0.7;
}
// Close-only polyline for the 'line' candle style — the one style that replaces the
// bodies entirely. `pts` = [{x, y}]; returns '' when there is nothing to draw.
function candleLinePath(pts) {
  let d = '';
  for (const p of pts) {
    if (!Number.isFinite(p.y)) continue;
    d += `${d ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }
  return d ? `<path d="${d}" fill="none" stroke="${CHART_THEME.bull}" stroke-width="1.5"/>` : '';
}

// ── COT bar layout: ONE definition, used by every surface that draws the COT pane ──
// Weekly CFTC reports do not land on a regular candle grid. A normal week is 5 trading
// days, a holiday week 4, a delayed release 6 — so bars placed straight on xForDate sit
// at 4/5/6-slot centres and the whitespace between them varies by a factor of ~2.6. Under
// an otherwise even chart that reads as a ragged comb, which is what it is.
//
// The fix regularises the middle while keeping the ENDS honest: first and last bar keep
// their true x, everything between is spread evenly across that span. The pane therefore
// still starts and ends exactly under the OI point of the same date — which is the whole
// reason the bars were put back on the time axis in the first place. Do NOT "simplify"
// this into an even division of the pane width: that is the old bug, where a COT series
// that ends a week behind price (and only starts 2021-06-08) was stretched to fill the
// pane and the first bar landed ~485px from its own date on a 20y chart.
//
// The drift this costs an interior bar is bounded by the irregularity it removes: measured
// on lean hogs, at most ~8px at 6M and 12M, under 2px at 5Y and 20Y — 1 to 3 candle slots.
//
// `xs` = true x per report, ascending. Returns the positions to draw at plus the constant
// centre-to-centre step, which is what the bar width is derived from (so the gap between
// two bars is now the same everywhere by construction).
function cotBarLayout(xs, fallbackStep) {
  const n = xs.length;
  if (n < 2) return { xs: xs.slice(), step: fallbackStep };
  const step = (xs[n - 1] - xs[0]) / (n - 1);
  // Every report snapped to the same candle (a range too coarse to separate them): there
  // is no spacing to even out, so leave the positions alone.
  if (!(step > 0)) return { xs: xs.slice(), step: fallbackStep };
  return { xs: xs.map((_, i) => xs[0] + step * i), step };
}

// The editable color tokens (order is only for robustness; UI groups live in settings.js).
const CHART_COLOR_TOKENS = [
  '--chart-bg', '--chart-grid', '--chart-grid-soft', '--chart-axis', '--chart-text',
  '--chart-bull', '--chart-bull-wick', '--chart-bear', '--chart-bear-wick',
  '--chart-volume', '--chart-volume-bull', '--chart-volume-bear',
  '--chart-oi', '--chart-oi-cftc', '--chart-oi-cme', '--chart-oi-yf',
  '--chart-spread', '--chart-trend'
];

const CHART_PRESETS_KEY = 'ch_chart_presets.v1';
const CHART_TZ_KEY = 'ch_timezone.v1';

// Content-bot card mode: presets and styles are NOT applied, so the bot's PNG exports
// stay stable no matter what the user has picked on screen.
function _isCardMode() {
  try { return !!new URLSearchParams(location.search).get('card'); } catch (e) { return false; }
}

// Read-only colored built-in presets shipped per theme, IN ADDITION to "Standard".
// "Standard" is the only built-in with colors:null (= CSS defaults); these carry explicit colors.
const THEME_BUILTIN_PRESETS = {
  light: [
    {
      id: 'black_on_white', name: 'Black on White', builtin: true,
      style: { candle: 'hollow', wick: 'thin', width: 'normal', grid: 'normal' },
      colors: {
        '--chart-bg': '#ffffff', '--chart-grid': '#d9d9d9', '--chart-grid-soft': '#ececec',
        '--chart-axis': '#a8a8a8', '--chart-text': '#000000',
        '--chart-bull': '#000000', '--chart-bull-wick': '#000000', '--chart-bear': '#000000', '--chart-bear-wick': '#000000',
        '--chart-volume': '#9a9a9a', '--chart-volume-bull': '#6b6b6b', '--chart-volume-bear': '#000000',
        '--chart-oi': '#555555', '--chart-oi-cftc': '#555555', '--chart-oi-cme': '#777777', '--chart-oi-yf': '#999999',
        '--chart-spread': '#444444', '--chart-trend': '#000000',
      },
    },
    {
      id: 'green_black_light', name: 'Green/Black', builtin: true,
      style: { candle: 'filled', wick: 'thin', width: 'normal', grid: 'normal', border: '#000000' },
      colors: {
        '--chart-bg': '#e8e8e8', '--chart-grid': '#cfcfcf', '--chart-grid-soft': '#dcdcdc',
        '--chart-axis': '#b0b0b0', '--chart-text': '#111111',
        '--chart-bull': '#43a047', '--chart-bull-wick': '#000000', '--chart-bear': '#000000', '--chart-bear-wick': '#000000',
        '--chart-volume': '#9a9a9a', '--chart-volume-bull': '#43a047', '--chart-volume-bear': '#000000',
        '--chart-oi': '#555555', '--chart-oi-cftc': '#555555', '--chart-oi-cme': '#43a047', '--chart-oi-yf': '#b06a1f',
        '--chart-spread': '#5a3fb0', '--chart-trend': '#000000',
      },
    },
  ],
  dark: [
    {
      id: 'green_white_on_black', name: 'Green on Black', builtin: true,
      style: { candle: 'hollow', wick: 'thin', width: 'normal', grid: 'normal' },
      colors: {
        '--chart-bg': '#000000', '--chart-grid': '#1a1a1a', '--chart-grid-soft': '#121212',
        '--chart-axis': '#333333', '--chart-text': '#cccccc',
        '--chart-bull': '#2ecc40', '--chart-bull-wick': '#2ecc40', '--chart-bear': '#ffffff', '--chart-bear-wick': '#ffffff',
        '--chart-volume': '#444444', '--chart-volume-bull': '#2ecc40', '--chart-volume-bear': '#cfcfcf',
        '--chart-oi': '#8a8a8a', '--chart-oi-cftc': '#8a8a8a', '--chart-oi-cme': '#2ecc40', '--chart-oi-yf': '#e8853a',
        '--chart-spread': '#b388ff', '--chart-trend': '#ffffff',
      },
    },
  ],
};
const STANDARD_PRESET = { id: 'standard', name: 'Standard', builtin: true, colors: null, style: null };
// Deep clone so the canonical constants are never aliased into the mutable store.
function _clonePreset(p) { return JSON.parse(JSON.stringify(p)); }
function _builtinPresetsFor(theme) { return (THEME_BUILTIN_PRESETS[theme] || []).map(_clonePreset); }
// Standard keeps CSS-default colours; the light variant draws candle outlines a shade darker than
// the fill (border:'darken') for definition on the light background. Dark Standard stays plain.
function _standardFor(theme) {
  const std = _clonePreset(STANDARD_PRESET);
  if (theme === 'light') std.style = { border: 'darken' };
  return std;
}

function _defaultPresetStore() {
  const mk = (theme) => ({ activeId: 'standard', presets: [_standardFor(theme), ..._builtinPresetsFor(theme)] });
  return { light: mk('light'), dark: mk('dark') };
}

// Read the preset store defensively (broken/missing JSON -> defaults; Standard enforced).
function loadPresetStore() {
  try {
    const raw = JSON.parse(localStorage.getItem(CHART_PRESETS_KEY) || 'null');
    if (!raw || !raw.light || !raw.dark) return _defaultPresetStore();
    for (const th of ['light', 'dark']) {
      const t = raw[th];
      if (!t || !Array.isArray(t.presets) || !t.presets.length) { raw[th] = _defaultPresetStore()[th]; continue; }
      // Keep only the user's own presets (ids are always 'p_…', see newPreset); regenerate built-ins
      // canonically so new/renamed/removed built-ins propagate and a retired built-in id is NOT kept
      // around as a stray "custom".
      const customs = t.presets.filter(p => p && typeof p.id === 'string' && p.id.startsWith('p_'));
      t.presets = [_standardFor(th), ..._builtinPresetsFor(th), ...customs];
      if (!t.presets.some(p => p && p.id === t.activeId)) t.activeId = 'standard';
    }
    return raw;
  } catch (e) { return _defaultPresetStore(); }
}

function savePresetStore(store) {
  try { localStorage.setItem(CHART_PRESETS_KEY, JSON.stringify(store)); } catch (e) {}
}

function getActivePreset(theme = currentTheme()) {
  const store = loadPresetStore();
  const t = store[theme] || store.light;
  return t.presets.find(p => p.id === t.activeId) || t.presets[0];
}

// Apply the active preset's inline vars + CHART_STYLE WITHOUT redrawing (for the
// initial load, before the other modules / the DOM are ready).
function applyActivePresetVars() {
  const root = document.documentElement;
  if (_isCardMode()) {
    CHART_COLOR_TOKENS.forEach(tok => root.style.removeProperty(tok));
    CHART_STYLE = { ...CHART_STYLE_DEFAULT };
    applyChartTheme();
    return;
  }
  const preset = getActivePreset();
  if (!preset || !preset.colors) {
    CHART_COLOR_TOKENS.forEach(tok => root.style.removeProperty(tok));
    CHART_STYLE = { ...CHART_STYLE_DEFAULT, ...((preset && preset.style) || {}) };   // colours=CSS defaults, but honour style (e.g. Standard's border)
  } else {
    CHART_COLOR_TOKENS.forEach(tok => {
      const v = preset.colors[tok];
      if (v) root.style.setProperty(tok, v); else root.style.removeProperty(tok);
    });
    CHART_STYLE = { ...CHART_STYLE_DEFAULT, ...(preset.style || {}) };
  }
  applyChartTheme();
}

// As above + redraw the visible charts (after a theme switch / settings change).
function applyActivePreset() { applyActivePresetVars(); rerenderThemedCharts(); }

// ── Timezone (header clock only) ──
function getTimezone() {
  try { return localStorage.getItem(CHART_TZ_KEY) || 'auto'; } catch (e) { return 'auto'; }
}
function setTimezone(tz) {
  try { localStorage.setItem(CHART_TZ_KEY, tz || 'auto'); } catch (e) {}
}
function resolveTimezone() {
  const tz = getTimezone();
  if (tz && tz !== 'auto') return tz;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/New_York'; }
  catch (e) { return 'America/New_York'; }
}

// ── Theme mode: Light / Dark / System (persisted; the visible charts repaint) ──
const THEME_MODE_KEY = 'ch_theme_mode';
function currentTheme() {   // the RESOLVED theme (data-theme); unchanged contract
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
// Stored mode; falls back to the legacy explicit ch_theme, else 'system'.
function getThemeMode() {
  try {
    const m = localStorage.getItem(THEME_MODE_KEY);
    if (m === 'light' || m === 'dark' || m === 'system') return m;
    const legacy = localStorage.getItem('ch_theme');
    if (legacy === 'light' || legacy === 'dark') return legacy;
  } catch (e) {}
  return 'system';
}
function _systemPrefersDark() {
  try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  catch (e) { return false; }
}
function resolveTheme(mode) {
  if (mode === 'dark') return 'dark';
  if (mode === 'light') return 'light';
  return _systemPrefersDark() ? 'dark' : 'light';   // 'system'
}
// Runtime: resolve the current mode, set data-theme, repaint everything.
function applyThemeMode() {
  document.documentElement.setAttribute('data-theme', resolveTheme(getThemeMode()));
  applyActivePreset();
}
// Persist a mode and apply it. Never called in card-mode.
function setThemeMode(mode) {
  const m = (mode === 'light' || mode === 'dark') ? mode : 'system';
  try { localStorage.setItem(THEME_MODE_KEY, m); localStorage.removeItem('ch_theme'); } catch (e) {}
  applyThemeMode();
  if (typeof refreshSettingsThemeUI === 'function') refreshSettingsThemeUI();
}
// Explicit light/dark (header toggle, key 't') — leaves 'system'.
function setTheme(theme) { setThemeMode(theme === 'dark' ? 'dark' : 'light'); }
function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
// Repaint the Futures (overview) chart + heatmap from the current CHART_THEME.
// SVG colors are baked in at render time, so a repaint is what actually recolors them.
function repaintOverviewThemed() {
  if (typeof chartState !== 'undefined' && chartState.key) {
    const meta = INDEX[chartState.key];
    const cat = meta && catCache[meta.slug];
    if (cat && cat[chartState.key] && typeof loadChart === 'function') loadChart(cat[chartState.key]);
  }
  if (typeof renderFuturesHeat === 'function') renderFuturesHeat();
}
// Set when the theme changes while the Futures tab is hidden. Every other tab
// self-heals via its PAGES `load`, but overview has `load: null`, so switchPage()
// consumes this flag to repaint the chart when the Futures tab is shown again.
let _overviewThemeDirty = false;
// Set when a board refresh lands while the Futures tab is hidden. That reload replaces every
// contract object — including the lazily-fetched chart_history hanging off them — so the
// chart left standing on the hidden tab is drawn from data the cache no longer holds, and it
// kept showing pre-refresh bars until the user clicked a market. switchPage() consumes this
// on the way back and re-establishes the chart from the refreshed category.
let _overviewDataDirty = false;
// Same idea for a market picked on Seasonals or Charts while the Futures tab was hidden:
// the three tabs share one selection (see setActiveMarket), but switchCommodity() measures
// the container it draws into, and a hidden page is 0px wide — so the Futures tab redraws
// on the way back in, not at the moment of the click.
let _overviewMarketDirty = false;
// Same idea for the Forex tab's TradingView pair chart: its theme is baked in at
// creation, so a theme switch while Forex is hidden must re-mount it on return.
let _fxThemeDirty = false;
// Repaint the chart surface that is currently visible so its SVG colors follow the
// new theme (CSS-styled surfaces recolor on their own via the tokens).
function rerenderThemedCharts() {
  try {
    if (!document.getElementById('overviewPage')?.hidden) repaintOverviewThemed();
    else _overviewThemeDirty = true;
    if (!document.getElementById('seasonalsPage')?.hidden && typeof renderSeasonalsPage === 'function') renderSeasonalsPage();
    if (!document.getElementById('smtPage')?.hidden && typeof renderSmtCharts === 'function') renderSmtCharts();
    if (!document.getElementById('screenerWeekly')?.hidden && typeof renderWeeklyOutlook === 'function') renderWeeklyOutlook();
    if (!document.getElementById('forexPage')?.hidden) {
      if (typeof repaintFxThemed === 'function') repaintFxThemed();
    } else if (typeof fxPairState !== 'undefined' && fxPairState) _fxThemeDirty = true;
    if (!document.getElementById('toolsPage')?.hidden && typeof reloadToolsCalendar === 'function') reloadToolsCalendar();
    if (!document.getElementById('bigchartPage')?.hidden && typeof repaintBigChartThemed === 'function') repaintBigChartThemed();
  } catch (e) { console.warn('theme rerender failed', e); }
}
// Initial theme: head script already set data-theme; re-assert from the stored mode
// (skip in card-mode, which is locked to dark), then populate CHART_THEME/CHART_STYLE
// WITHOUT a full repaint (DOM/other modules not ready; boot.js does the first render).
if (!_isCardMode()) document.documentElement.setAttribute('data-theme', resolveTheme(getThemeMode()));
applyActivePresetVars();
// Live-follow the OS when in 'system' mode (never in card-mode).
try {
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (_isCardMode() || getThemeMode() !== 'system') return;
    document.documentElement.setAttribute('data-theme', resolveTheme('system'));
    applyActivePreset();
    if (typeof refreshSettingsThemeUI === 'function') refreshSettingsThemeUI();
  });
} catch (e) {}

function readWatchlist() {
  try {
    const raw = JSON.parse(localStorage.getItem(WATCHLIST_KEY) || '[]');
    const unique = [];
    for (const key of raw) {
      const valid = isFxPairKey(key) ? fxPairLegsValid(key) : !!INDEX[key];
      if (valid && !unique.includes(key)) unique.push(key);
    }
    return unique;
  } catch (e) {
    return [];
  }
}

let watchlist = readWatchlist();

function saveWatchlist() {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(watchlist));
}

// Single source of truth for top-level pages. To add a page: add an entry here,
// a <section id="<id>Page"> below, and a nav button — switchPage / activePage /
// saved-page restore all derive from this list (no more parallel lists to miss).
const PAGES = [
  { id: 'overview',  load: null },
  { id: 'forex',     load: () => openForex() },
  { id: 'screener',  load: () => openScreener() },
  { id: 'seasonals', load: () => renderSeasonalsPage() },
  { id: 'smt',       load: () => openSmt() },
  { id: 'tools',     load: () => openTools() },
  { id: 'bigchart',  load: () => openBigChart() },
  { id: 'settings',  load: () => openSettings() },
];
const PAGE_IDS = new Set(PAGES.map(p => p.id));

function switchPage(page) {
  const target = PAGE_IDS.has(page) ? page : 'overview';
  try { localStorage.setItem(ACTIVE_PAGE_KEY, target); } catch (e) {}
  // The Charts tab is a fixed-to-viewport, no-scroll surface: lock page scroll and hide the
  // risk-notice footer (which otherwise pushes the page past one screen). CSS does the rest.
  document.body.classList.toggle('bigchart-tab', target === 'bigchart');
  if (typeof startLiveLayer === 'function') {
    // Screener too: startLiveLayer self-gates to the Weekly Outlook via _liveLayerPage().
    // Charts (bigchart) starts here for the tab-return case and restarts again from
    // selectBigChartMarket(), which is where its cfg first exists (openBigChart is async).
    if (target === 'overview' || target === 'smt' || target === 'screener' || target === 'bigchart') startLiveLayer();
    else stopLiveLayer();
  }
  // Carry the shared market selection into the tab being opened (see setActiveMarket).
  if (currentKey && INDEX[currentKey]) {
    if (target === 'seasonals') seasonalState.key = currentKey;
    // Set before openBigChart() runs from the PAGES load hook below — it reads this first.
    if (target === 'bigchart' && typeof bigChartState !== 'undefined') bigChartState.key = currentKey;
  }
  document.querySelectorAll('[data-page-tab]').forEach(tab => {
    const active = tab.dataset.pageTab === target;
    tab.classList.toggle('active', active);
    if (active) tab.setAttribute('aria-current', 'page');
    else tab.removeAttribute('aria-current');
  });
  for (const p of PAGES) {
    const el = document.getElementById(p.id + 'Page');
    if (el) el.hidden = p.id !== target;
  }
  const activeP = PAGES.find(p => p.id === target);
  if (activeP && activeP.load) activeP.load();
  if (target === 'overview' && _overviewMarketDirty) {
    // A market picked on Seasonals or Charts while this tab was hidden. This supersedes the
    // other two flags: switchCommodity() re-establishes the chart from the category and
    // draws it in the current theme anyway.
    _overviewMarketDirty = false;
    _overviewDataDirty = false;
    _overviewThemeDirty = false;
    switchCommodity(currentKey);
  } else if (target === 'overview' && (_overviewDataDirty || _overviewThemeDirty)) {
    // Data wins over theme: refreshOverviewChart() repaints in the new theme either way,
    // and unlike a bare repaint it re-fetches a contract history the refresh threw away.
    const _needsData = _overviewDataDirty;
    _overviewDataDirty = false;
    _overviewThemeDirty = false;
    if (_needsData && typeof refreshOverviewChart === 'function') refreshOverviewChart();
    else repaintOverviewThemed();
  }
  // openForex() already rebuilt the heatmap with the current theme; just re-mount the
  // open TradingView pair chart so it follows the theme switched while Forex was hidden.
  if (target === 'forex' && _fxThemeDirty) { _fxThemeDirty = false; if (typeof remountFxPairChart === 'function') remountFxPairChart(); }
  renderWatchlist();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function activePage() {
  for (const p of PAGES) {
    if (p.id !== 'overview' && document.getElementById(p.id + 'Page')?.hidden === false) return p.id;
  }
  return 'overview';
}

// ── Keyboard accelerators (power users) ──
// 1–7 jump to the seven top tabs (in nav order), t toggles theme, / focuses the
// Screener search. Suppressed while typing in a field (Esc blurs it) and in the
// content-bot card-mode export. Invisible to novices; the nav tab titles hint them.
function _isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || el.isContentEditable;
}
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (document.body.classList.contains('card-mode') || document.body.classList.contains('fx-card-mode')) return;
  const typing = _isTypingTarget(e.target);
  if (e.key === 'Escape' && typing) { e.target.blur(); return; }
  if (typing) return;
  if (e.key >= '1' && e.key <= '8') {
    const p = PAGES[+e.key - 1];
    if (p) { e.preventDefault(); switchPage(p.id); }
  } else if (e.key === 't' || e.key === 'T') {
    e.preventDefault(); toggleTheme();
  } else if (e.key === '/') {
    e.preventDefault();
    switchPage('screener');
    const s = document.getElementById('screenerSearch');
    if (s) { s.focus(); s.select(); }
  }
});

// ── One market across Futures, Seasonals and Charts ──
// Switching tabs must never switch market. Each of the three keeps its own *view* state
// (timeframe, contract mode, indicators, drawings), but they all read and write ONE
// selection, currentKey: a tab syncs from it on the way in (switchPage above) and calls
// this on the way out, whenever its own sidebar picks a market. switchCommodity() is the
// Futures half of it — that tab has no PAGES `load` hook, so it consumes the dirty flag
// instead of re-rendering while hidden.
function setActiveMarket(key) {
  if (!INDEX[key] || key === currentKey) return;
  currentKey = key;
  try { localStorage.setItem(LAST_MARKET_KEY, key); } catch (e) {}
  _overviewMarketDirty = true;
}

function activeMarketKey(context = activePage()) {
  return context === 'seasonals' ? seasonalState.key : currentKey;
}

// ── Screener (lean per-market signals from screener.json) ──

function watchlistQuote(key) {
  if (isFxPairKey(key)) return fxPairQuote(key);
  const meta = INDEX[key];
  const cfg = meta && catCache[meta.slug] && catCache[meta.slug][key];
  if (!cfg) return null;
  const hist = (getContinuousContract(cfg).history || []);
  if (!hist.length) return null;
  const last = hist[hist.length - 1];
  const prev = hist.length > 1 ? hist[hist.length - 2] : last;
  const close = Number(last.close);
  const prevClose = Number(prev.close);
  if (!Number.isFinite(close)) return null;
  const pct = prevClose ? ((close - prevClose) / prevClose * 100) : 0;
  return { close, pct, decimals: cfg.tick_decimals ?? 2, unit: cfg.unit || '' };
}

function renderWatchlist() {
  watchlist = watchlist.filter(key => isFxPairKey(key) ? fxPairLegsValid(key) : INDEX[key]);
  document.querySelectorAll('.watchlist-sidebar').forEach(panel => {
    const context = panel.dataset.watchlistContext || activePage();
    const activeKey = activeMarketKey(context);
    const body = panel.querySelector('[data-watchlist-body]');
    const count = panel.querySelector('[data-watchlist-count]');
    const addBtn = panel.querySelector('[data-watchlist-add]');
    if (count) count.textContent = watchlist.length === 1 ? '1 market' : `${watchlist.length} markets`;
    if (addBtn) {
      const exists = watchlist.includes(activeKey);
      addBtn.disabled = exists;
      addBtn.textContent = exists ? 'Saved' : '+ Market';
    }
    if (!body) return;
    if (!watchlist.length) {
      body.innerHTML = '<div class="watchlist-empty">No markets yet. Tap ★ on a Screener row, or use + Market above, to track one here.</div>';
      return;
    }
    body.innerHTML = watchlist.map(key => {
      const pair = isFxPairKey(key);
      const meta = pair ? null : INDEX[key];
      const name = pair ? fxPairLabel(key) : meta.display_name;
      const cat = pair ? 'FX Pair' : meta.category;
      const quote = watchlistQuote(key);
      const active = key === activeKey;
      const quoteHtml = quote
        ? `<span class="watchlist-quote"><span>${fmtNum(quote.close, quote.decimals)}</span><span class="${quote.pct >= 0 ? 'pos' : 'neg'}">${quote.pct >= 0 ? '+' : ''}${quote.pct.toFixed(2)}%</span></span>`
        : '';
      return `<div class="watchlist-item ${active ? 'active' : ''}" data-watchlist-item="${key}">
        <button class="watchlist-open" type="button" onclick="openWatchlistMarket('${key}', '${context}')">
          <span class="watchlist-name">${esc(name)}</span>
          <span class="watchlist-meta">${esc(cat)}</span>
          ${quoteHtml}
        </button>
        <button class="watchlist-remove" type="button" onclick="removeFromWatchlist('${key}', event)" title="Remove">×</button>
      </div>`;
    }).join('');
  });
}

async function openWatchlistMarket(key, context = activePage()) {
  if (isFxPairKey(key)) {
    const p = parseFxPairKey(key);
    if (!p) return;
    switchPage('forex');
    openFxPairChart(p.baseKey, p.quoteKey, FX_CUR_BY_KEY[p.baseKey] || p.baseKey, FX_CUR_BY_KEY[p.quoteKey] || p.quoteKey);
    return;
  }
  if (!INDEX[key]) return;
  if (context === 'seasonals') {
    await selectSeasonalsMarket(key);
    return;
  }
  await switchCommodity(key);
}

function addCurrentToWatchlist(context = activePage()) {
  const key = activeMarketKey(context);
  if (!key || !INDEX[key] || watchlist.includes(key)) return;
  watchlist.push(key);
  saveWatchlist();
  renderWatchlist();
}

function removeFromWatchlist(key, event) {
  if (event) event.stopPropagation();
  watchlist = watchlist.filter(item => item !== key);
  saveWatchlist();
  renderWatchlist();
}

// ── Lazily load category data (fetch on first access) ──
// An in-flight map beside the cache: catCache[slug] is only set once the response has
// landed, so two callers in the same tick each fired a full category fetch (6-14 MB). The
// cold-start warm-up and switchCommodity() ask for the SAME slug at the same moment on
// every launch, so that duplicate was not hypothetical.
// Keyed by _dataReloadNonce too: applyRefreshedData() clears catCache and bumps the nonce
// when a board refresh lands, and a fetch still in flight from before that carries
// pre-refresh data — it must neither be handed to the reload nor written into the cache.
const _catInFlight = {};   // slug -> { nonce, promise }

async function loadCategory(slug) {
  if (catCache[slug]) return catCache[slug];
  const pending = _catInFlight[slug];
  if (pending && pending.nonce === _dataReloadNonce) return pending.promise;
  const nonce = _dataReloadNonce;
  const promise = (async () => {
    try {
      const res = await fetch(`${DATA_DIR}/data_${slug}.json?v=${DATA_VERSION}&r=${nonce}`, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      if (nonce === _dataReloadNonce) catCache[slug] = data;   // stale generation: don't poison the cache
      return data;
    } catch (e) {
      console.error('Category load failed:', slug, e);
      return null;
    } finally {
      if (_catInFlight[slug] && _catInFlight[slug].nonce === nonce) delete _catInFlight[slug];
    }
  })();
  _catInFlight[slug] = { nonce, promise };
  return promise;
}

// ── Seasonals page ──

function buildCommoditySidebarHtml(idPrefix, clickHandler) {
  const cats = {};
  for (const [k, v] of Object.entries(INDEX)) {
    (cats[v.category] ||= []).push([k, v]);
  }
  const rank = c => { const i = CATEGORY_POPULARITY.indexOf(c); return i === -1 ? 99 : i; };
  const orderedCats = Object.keys(cats).sort((a, b) => rank(a) - rank(b));
  let html = '';
  for (const cat of orderedCats) {
    html += `<div class="aside-section">
      <div class="aside-label">${CAT_ICONS[cat]||''} ${cat}</div>`;
    for (const [k, v] of cats[cat]) {
      html += `<button class="commodity-item" id="${idPrefix}-${k}" type="button" onclick="${clickHandler}('${k}')">${esc(v.display_name)}</button>`;
    }
    html += `</div>`;
  }
  return html;
}

function initSidebar() {
  const sb = document.getElementById('sidebar');
  if (sb) sb.innerHTML = buildCommoditySidebarHtml('nav', 'switchCommodity');

  const mobile = document.getElementById('mobileSelect');
  if (mobile) mobile.innerHTML =
    Object.entries(INDEX).map(([k,v]) => `<option value="${k}">${v.display_name}</option>`).join('');
}

function initSeasonalsSidebar() {
  const sb = document.getElementById('seasonalsSidebar');
  if (sb) sb.innerHTML = buildCommoditySidebarHtml('seasonal-nav', 'selectSeasonalsMarket');
  updateSeasonalsSidebarActive();
}

function updateSeasonalsSidebarActive() {
  document.querySelectorAll('#seasonalsSidebar .commodity-item').forEach(btn => btn.classList.remove('active'));
  document.getElementById('seasonal-nav-' + seasonalState.key)?.classList.add('active');
}

// ── Interactive chart state ──

function fmtNum(n, dec) {
  if (n === null || n === undefined) return null;
  return Number(n).toLocaleString('en-US',{minimumFractionDigits:dec,maximumFractionDigits:dec});
}
function fmtInt(n) {
  if (n === null || n === undefined) return null;
  return Number(n).toLocaleString('en-US');
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
}

function fmtExpiry(iso) {
  if (!iso) return '<span class="na">–</span>';
  const d = new Date(iso + 'T00:00:00');
  if (isNaN(d)) return '<span class="na">–</span>';
  const wd = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()];
  const dd = String(d.getDate()).padStart(2,'0');
  const mm = String(d.getMonth()+1).padStart(2,'0');
  const today = new Date(); today.setHours(0,0,0,0);
  const days = Math.round((d - today) / 86400000);
  const daysTxt = days > 0 ? `in ${days} days` : days === 0 ? 'today' : 'expired';
  const cls = (days >= 0 && days <= 14) ? 'expiry-soon' : '';
  return `<span class="${cls}">${wd} ${mm}/${dd}/${d.getFullYear()}</span><div class="expiry-sub">${daysTxt}</div>`;
}

function getCurrentCfg() {
  const meta = INDEX[currentKey];
  return meta && catCache[meta.slug] ? catCache[meta.slug][currentKey] : null;
}

