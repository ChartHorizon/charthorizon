
const INDEX = window.__CONFIG__.index;          // lightweight: metadata only per market
const DATA_DIR = window.__CONFIG__.dataDir;  // folder with the category JSON files
const DATA_VERSION = window.__CONFIG__.dataVersion;
const WATCHLIST_KEY = "charthorizon.watchlist.v1";
const ACTIVE_PAGE_KEY = "charthorizon.activePage.v1"; // remembers active top tab across reloads
let currentKey = window.__CONFIG__.firstKey;
let seasonalState = { key: window.__CONFIG__.firstKey };

// Cache for already loaded category data
const catCache = {};   // slug -> { key -> payload }

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
  bull:'#4f72e8',         // LIGHT fallback = original blue/red (DARK theme overrides to TradingView green/red)
  bullWick:'#91a6f1',
  bear:'#ee5b45',
  bearWick:'#f3a08f',
  volume:'#8b98aa',
  volumeBull:'#0ea679',
  volumeBear:'#e53e3e',
  oi:'#52657f',
  oiCftc:'#52657f',       // CFTC weekly history (baseline)
  oiCme:'#0ea679',        // (unused, kept for theme stability)
  oiYf:'#e8853a',         // yfinance fallback (estimated / lower quality)
  spread:'#7c3aed'        // calendar spread (front - next)
};
const _CHART_THEME_VARS = {
  bg:'--chart-bg', grid:'--chart-grid', gridSoft:'--chart-grid-soft', axis:'--chart-axis', text:'--chart-text',
  bull:'--chart-bull', bullWick:'--chart-bull-wick', bear:'--chart-bear', bearWick:'--chart-bear-wick',
  volume:'--chart-volume', volumeBull:'--chart-volume-bull', volumeBear:'--chart-volume-bear',
  oi:'--chart-oi', oiCftc:'--chart-oi-cftc', oiCme:'--chart-oi-cme', oiYf:'--chart-oi-yf', spread:'--chart-spread'
};
// Pull the active theme's --chart-* tokens into CHART_THEME (mutates in place).
function applyChartTheme() {
  const s = getComputedStyle(document.documentElement);
  for (const k in _CHART_THEME_VARS) {
    const v = s.getPropertyValue(_CHART_THEME_VARS[k]).trim();
    if (v) CHART_THEME[k] = v;
  }
}

// ── Light / Dark theme switch (persisted; the visible chart repaints) ──
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}
function setTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  try { localStorage.setItem('ch_theme', t); } catch (e) {}
  applyChartTheme();
  rerenderThemedCharts();
}
function toggleTheme() { setTheme(currentTheme() === 'dark' ? 'light' : 'dark'); }
// Repaint the chart surface that is currently visible so its SVG colors follow the
// new theme (CSS-styled surfaces recolor on their own via the tokens).
function rerenderThemedCharts() {
  try {
    if (!document.getElementById('overviewPage')?.hidden && typeof chartState !== 'undefined' && chartState.key) {
      const meta = INDEX[chartState.key];
      const cat = meta && catCache[meta.slug];
      if (cat && cat[chartState.key] && typeof loadChart === 'function') loadChart(cat[chartState.key]);
    }
    if (!document.getElementById('overviewPage')?.hidden && typeof renderFuturesHeat === 'function') renderFuturesHeat();
    if (!document.getElementById('seasonalsPage')?.hidden && typeof renderSeasonalsPage === 'function') renderSeasonalsPage();
    if (!document.getElementById('smtPage')?.hidden && typeof renderSmtCharts === 'function') renderSmtCharts();
    if (!document.getElementById('screenerWeekly')?.hidden && typeof renderWeeklyOutlook === 'function') renderWeeklyOutlook();
    if (!document.getElementById('forexPage')?.hidden && typeof renderFxSection === 'function') renderFxSection();
    if (!document.getElementById('toolsPage')?.hidden && typeof reloadToolsCalendar === 'function') reloadToolsCalendar();
  } catch (e) { console.warn('theme rerender failed', e); }
}
applyChartTheme();   // populate CHART_THEME from the theme active at load

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
];
const PAGE_IDS = new Set(PAGES.map(p => p.id));

function switchPage(page) {
  const target = PAGE_IDS.has(page) ? page : 'overview';
  try { localStorage.setItem(ACTIVE_PAGE_KEY, target); } catch (e) {}
  if (target === 'seasonals' && currentKey && INDEX[currentKey]) seasonalState.key = currentKey;
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
  renderWatchlist();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function activePage() {
  for (const p of PAGES) {
    if (p.id !== 'overview' && document.getElementById(p.id + 'Page')?.hidden === false) return p.id;
  }
  return 'overview';
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
      body.innerHTML = '<div class="watchlist-empty">No markets saved.</div>';
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
async function loadCategory(slug) {
  if (catCache[slug]) return catCache[slug];
  try {
    const res = await fetch(`${DATA_DIR}/data_${slug}.json?v=${DATA_VERSION}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    catCache[slug] = data;
    return data;
  } catch (e) {
    console.error('Category load failed:', slug, e);
    return null;
  }
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

