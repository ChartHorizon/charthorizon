initSidebar();
initSeasonalsSidebar();
renderWatchlist();

// Header-clock interval id — declared before initHeaderClock() is first called (boot.js ~l.92)
// so its `= null` init can never clobber the running interval's id. Keep idempotent.
var _headerClockTimer = null;

// Card-Mode: NUR der Content-Bot ruft `?card=<key>` auf. Konfiguriert den Future-Chart
// (Front-Month · Daily · 12M · Spread + COT Hedging Program) für den PNG-Export und
// zeichnet die 4/4-Marker — beides passiert ausschließlich hier, das normale
// Dashboard bleibt unberührt.
const _cardKey = (() => {
  try { return new URLSearchParams(location.search).get('card'); } catch (e) { return null; }
})();
if (_cardKey === 'fx') {
  // FX-Heatmap-Karte (zweite Signalquelle): gebrandete Heatmap als DOM-Screenshot.
  document.body.classList.add('card-mode', 'fx-card-mode');
  openForexCard();
} else if (_cardKey && _cardKey.indexOf('fxpair-') === 0) {
  // Natives FX-Paar-Chart (Preis-only + Marker): ?card=fxpair-<baseKey>-<quoteKey>.
  document.body.classList.add('card-mode');
  const _p = _cardKey.split('-');   // ['fxpair', baseKey, quoteKey] (Keys haben nur '_')
  openFxPairCard(_p[1], _p[2]);
} else if (_cardKey && INDEX[_cardKey]) {
  document.body.classList.add('card-mode');
  const _q = new URLSearchParams(location.search);
  // hedge=0 -> COT-Pane OHNE Hedging-Program-Overlay; band=0 -> KEIN 4/4-Band/Marker/
  // Runway-Footer (z.B. COT-Extrem-Posts: nur Chart + rohes COT-Net + Risk-Disclaimer).
  // Ohne Flags bleibt beides AN (4/4-Posts, unveraendert).
  chartState.cotHedging = _q.get('hedge') !== '0';
  chartState.showSpread = true;
  if (_q.get('band') === '0') {
    window.__fourFourLog = {};                 // Log gar nicht laden -> kein Band/Marker/Runway
    switchCommodity(_cardKey);
  } else {
    // 4/4-Log laden (vom Bot erzeugt), DANN den Chart rendern, damit die Marker da sind.
    fetch(`${DATA_DIR}/four_four_log.json?v=${DATA_VERSION}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : {}))
      .then(log => { window.__fourFourLog = log; })
      .catch(() => {})
      .finally(() => switchCommodity(_cardKey));
  }
} else {
  // Cold start: keep the splash up until every Weekly-Outlook 4/4 result has a live price,
  // then reveal. Fire-and-forget (self-dismissing); runs only here, so bot PNGs are unaffected.
  runBootSplash();
  try {
    const _lastMarket = localStorage.getItem(LAST_MARKET_KEY);
    if (_lastMarket && INDEX[_lastMarket]) currentKey = _lastMarket;
  } catch (e) {}
  switchCommodity(currentKey);
  // Futures Strength heatmap at the bottom of the Futures tab — normal dashboard
  // only (the card-mode branches above never reach here, so bot PNGs are unchanged).
  if (typeof ensureScreenerData === 'function') {
    ensureScreenerData().then(() => { try { renderFuturesHeat(); } catch (e) {} });
  }
  // Reopen whichever top tab was active before the last reload.
  try {
    const savedPage = localStorage.getItem(ACTIVE_PAGE_KEY);
    if (savedPage && savedPage !== 'overview' && PAGE_IDS.has(savedPage)) switchPage(savedPage);
  } catch (e) {}
    // Surface any background EoD refresh as the watchlist progress bar (normal
    // dashboard only — card-mode branches above never reach here, so bot PNGs are
    // unchanged).
    if (typeof startRefreshPolling === 'function') startRefreshPolling();
}

// Responsive: redraw chart on resize (debounced)
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    // The Charts (bigchart) tab handles its own resize live via requestAnimationFrame
    // (see bigchart.js) — it must rescale full-resolution during the drag, not on a
    // debounce after it stops.
    if (!document.getElementById('seasonalsPage')?.hidden) {
      renderSeasonalsPage();
      return;
    }
    if (!document.getElementById('smtPage')?.hidden) {
      renderSmtCharts();
      return;
    }
    if (document.getElementById('overviewPage')?.hidden) return;
    const key = chartState.key;
    if (!key) return;
    const meta = INDEX[key];
    const cat = meta && catCache[meta.slug];
    if (cat && cat[key]) loadChart(cat[key]);
  }, 150);
});


  /* Live clock in the top-right header — Zeitzone aus den Settings (resolveTimezone). */
  initHeaderClock();

// ── Cold-start boot splash ───────────────────────────────────────────────────
// Hold the splash (html.booting, set in <head> before first paint — normal dashboard only)
// until every Weekly-Outlook 4/4 result carries a live price, then fade it out. We prefetch
// each 4/4 market's category + front history + live quote up front, so on reveal the whole
// Weekly Outlook is live and no candle "pops in" afterwards. A safety deadline guarantees the
// splash never traps the user (Yahoo down, a 429, or an illiquid symbol that never quotes).
function _hasLiveQuote(sym) {
  const q = (sym && typeof liveQuotes === 'object' && liveQuotes) ? liveQuotes[sym] : null;
  return !!(q && Number.isFinite(q.price) && q.day);
}

function _revealBootSplash() {
  // Draw the prefetched live quote onto the on-screen chart(s) FIRST, so today's candle is
  // actually standing the moment the splash lifts (not "pops in" a tick later).
  try { if (typeof liveActiveTargets === 'function') liveActiveTargets().repaint(); } catch (e) {}
  const s = document.getElementById('bootSplash');
  if (s) s.classList.add('boot-splash-done');                                       // CSS fades opacity -> 0
  setTimeout(() => { document.documentElement.classList.remove('booting'); }, 450); // then display:none
}

// The selected market opens on its FRONT-MONTH contract by default (switchCommodity, row 0).
// Pre-load that contract's history so the cold-start chart opens DIRECTLY on the front month
// (consistent — no continuous flash behind the splash), and return its live symbols in priority
// order: FRONT MONTH first (always), continuous second. Loads the category if needed; the splash
// warms this market even when it is not a 4/4 result.
async function _bootSelectedMarketSymbols() {
  let key = (typeof currentKey !== 'undefined') ? currentKey : null;
  try { const last = localStorage.getItem(LAST_MARKET_KEY); if (last && INDEX[last]) key = last; } catch (e) {}
  const meta = key && INDEX[key];
  if (!meta) return [];
  let cfg = catCache[meta.slug] && catCache[meta.slug][key];
  if (!cfg) { try { const cat = await loadCategory(meta.slug); cfg = cat && cat[key]; } catch (e) {} }
  if (!cfg) return [];
  const front = (cfg.contracts || []).find(c => c && c.yf_symbol) || null;   // row 0 = front month (matches switchCommodity)
  if (front && !(front.chart_history || []).length && typeof fetchContractHistory === 'function') {
    try { await fetchContractHistory(front); } catch (e) {}                  // so the chart opens directly on the front month
  }
  const cont = (typeof getContinuousContract === 'function') ? (getContinuousContract(cfg) || {}) : (cfg.continuous_contract || {});
  const out = [];
  if (front && front.yf_symbol) out.push(front.yf_symbol);                   // prio 1: front month (always)
  const contSym = cont.yf_symbol || cont.tv_symbol;
  if (contSym && !out.includes(contSym)) out.push(contSym);                  // prio 2: continuous
  return out;
}

// The live symbols of every Weekly-Outlook 4/4 result: per market, load its category + front
// history, then map to the exact symbol its chart plots (front-month, or continuous fallback).
async function _bootFourFourSymbols() {
  if (typeof weeklyOutlookSetups !== 'function') return [];
  const full = weeklyOutlookSetups().full || [];
  const syms = [];
  await Promise.all(full.map(async ({ r }) => {
    const meta = r && INDEX[r.key];
    if (!meta) return;
    let cfg = catCache[meta.slug] && catCache[meta.slug][r.key];
    if (!cfg) { try { const cat = await loadCategory(meta.slug); cfg = cat && cat[r.key]; } catch (e) {} }
    if (!cfg) return;
    if (typeof wkEnsureFrontHistory === 'function') { try { await wkEnsureFrontHistory(cfg); } catch (e) {} }
    const sym = (typeof wkLiveSymbol === 'function') ? wkLiveSymbol(cfg) : null;
    if (sym) syms.push(sym);
  }));
  return [...new Set(syms)];
}

// The top tab the cold start opens on (persisted) — drives WHAT the splash prefetches/waits for.
function _bootOpeningPage() {
  try {
    const sp = (typeof ACTIVE_PAGE_KEY !== 'undefined') ? localStorage.getItem(ACTIVE_PAGE_KEY) : null;
    if (sp && typeof PAGE_IDS !== 'undefined' && PAGE_IDS.has(sp)) return sp;
  } catch (e) {}
  return 'overview';
}
// Whether the Screener opens on its Weekly Outlook (persisted) — only then does it have charts.
function _bootScreenerWeekly() {
  try {
    const key = (typeof SCREENER_STATE_KEY !== 'undefined') ? SCREENER_STATE_KEY : 'ch_screener_state';
    const st = JSON.parse(localStorage.getItem(key) || 'null');
    return !!(st && st.view === 'weekly');
  } catch (e) { return false; }
}

async function runBootSplash() {
  if (!document.documentElement.classList.contains('booting')) return;   // card-mode / already revealed
  const progress = document.getElementById('bootSplashProgress');
  const DEADLINE_MS = 12000, MIN_MS = 400, t0 = Date.now();
  let done = false;
  const finish = () => { if (done) return; done = true; _revealBootSplash(); };
  const safety = setTimeout(finish, DEADLINE_MS);                          // never trap the user
  try {
    // Page-aware: only prefetch/wait for the charts the cold start actually OPENS on. Opening on
    // the Futures tab -> just the selected market's daily chart; opening on the Weekly Outlook ->
    // its 4/4 charts. Other pages (and the lazy weekly charts you scroll to / click into later)
    // load on their own — no point blocking the splash on charts you're not looking at yet.
    const openingPage = _bootOpeningPage();
    let syms = [], primary = null;   // primary = the single highest-priority symbol, fired first
    if (openingPage === 'overview') {
      try { syms = await _bootSelectedMarketSymbols(); } catch (e) {}   // [front, continuous]
      primary = syms[0] || null;                                        // front month first
    } else if (openingPage === 'screener' && _bootScreenerWeekly()) {
      if (typeof ensureScreenerData === 'function') { try { await ensureScreenerData(); } catch (e) {} }
      try { syms = await _bootFourFourSymbols(); } catch (e) {}         // every 4/4 result chart
    }
    const setProg = () => { if (progress) progress.textContent = syms.length ? ` · ${syms.filter(_hasLiveQuote).length}/${syms.length}` : ''; };
    if (!done && syms.length && typeof livePrefetch === 'function') {
      if (primary) livePrefetch([primary]);   // highest-priority symbol first, before the rest
      setProg();
      await livePrefetch(syms);
      setProg();
      while (!done && !syms.every(_hasLiveQuote) && Date.now() - t0 < DEADLINE_MS) {
        await new Promise(res => setTimeout(res, 300));
        const pending = syms.filter(s => !_hasLiveQuote(s));
        if (pending.length) livePrefetch(pending);                        // retry stragglers (cap tokens refill)
        setProg();
      }
    }
  } catch (e) { /* fall through and reveal */ }
  if (done) return;
  clearTimeout(safety);
  const elapsed = Date.now() - t0;
  if (elapsed < MIN_MS) await new Promise(res => setTimeout(res, MIN_MS - elapsed));
  finish();
}

// Header-Uhr (#clock + .hdr-date). Re-initialisierbar: der Settings-Tab ruft sie nach
// einer Zeitzonen-Aenderung erneut auf. Baut die Formatter aus resolveTimezone() neu
// und ersetzt das laufende Intervall (idempotent).
function initHeaderClock() {
  var clock = document.getElementById('clock');
  if (!clock) return;
  var dateEl = document.querySelector('.hdr-date');
  var tz = (typeof resolveTimezone === 'function') ? resolveTimezone() : 'America/New_York';
  var timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' });
  var dateFmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: '2-digit', year: 'numeric' });
  function tick() {
    var now = new Date();
    clock.textContent = timeFmt.format(now);
    if (dateEl) dateEl.textContent = dateFmt.format(now);
  }
  tick();
  if (_headerClockTimer) clearInterval(_headerClockTimer);
  _headerClockTimer = setInterval(tick, 1000);
}
