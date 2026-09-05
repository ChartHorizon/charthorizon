initSidebar();
initSeasonalsSidebar();
renderWatchlist();

// Header-clock interval id — declared before initHeaderClock() is first called (boot.js ~l.92)
// so its `= null` init can never clobber the running interval's id. Keep idempotent.
var _headerClockTimer = null;

// Cold-start warm-up state. `var`, and declared HERE, because bootWarmup() is invoked from
// the branch a few lines below while the definitions live at the bottom of this file — a
// `let`/`const` down there is in the temporal dead zone at that moment and throws
// "Cannot access '_bootProgressTick' before initialization", which silently kills the boot.
var BOOT_STALL_MS = 15000;            // no progress for this long -> offer "Open anyway"
var BOOT_HISTORY_CONCURRENCY = 6;     // parallel contract-history fetches during phase 2
var BOOT_REFRESH_POLL_MS = 1000;      // /api/refresh-status cadence while a refresh runs
var _bootProgressTick = 0;            // bumped by _bootPhase; the stall watchdog watches it
var _bootWatchdogTimer = null;
var _bootRevealed = false;            // set on reveal; the background pass must not write to a splash that is gone

// Card-mode: ONLY the content bot calls `?card=<key>`. It configures the futures chart
// (front month · daily · 12M or `range=6m` · spread + COT hedging program) for the PNG
// export and draws the 3/3 markers — both happen exclusively here, the normal dashboard
// is untouched.
const _cardKey = (() => {
  try { return new URLSearchParams(location.search).get('card'); } catch (e) { return null; }
})();
if (_cardKey === 'fx') {
  // FX heatmap card (second signal source): branded heatmap as a DOM screenshot.
  document.body.classList.add('card-mode', 'fx-card-mode');
  openForexCard();
} else if (_cardKey && _cardKey.indexOf('fxpair-') === 0) {
  // Native FX pair chart (price-only + marker): ?card=fxpair-<baseKey>-<quoteKey>.
  document.body.classList.add('card-mode');
  const _p = _cardKey.split('-');   // ['fxpair', baseKey, quoteKey] (keys only ever use '_')
  openFxPairCard(_p[1], _p[2]);
} else if (_cardKey && INDEX[_cardKey]) {
  document.body.classList.add('card-mode');
  const _q = new URLSearchParams(location.search);
  // hedge=0 -> COT pane WITHOUT the hedging-program overlay; band=0 -> NO 3/3 band /
  // marker / runway footer (e.g. COT-extreme posts: chart + raw COT net + risk disclaimer
  // only). Without the flags both stay ON (3/3 posts, unchanged).
  chartState.cotHedging = _q.get('hedge') !== '0';
  // range=6m -> put the card on the 6-month window. The overlay is RANGE-relative
  // (chart.js: trailingCotWindow(cot, chartState.range), RANGE_DAYS['6m'] === 182), and
  // 182 days is exactly the window screener.py draws its cot_hedge verdict from. So the
  // default 12M card draws a DIFFERENT midpoint than the one the verdict means — and
  // labels itself "12M HEDGING PROGRAM". For a post about the 6-month program that is a
  // visible contradiction, hence the flag. Only '6m'/'12m' are allowed: on any other
  // range chart.js does not draw the overlay at all, so a card with hedge=1&range=5y
  // would silently be a card without a program.
  const _range = _q.get('range');
  if (_range === '6m' || _range === '12m') chartState.range = _range;
  chartState.showSpread = true;
  if (_q.get('band') === '0') {
    window.__threeThreeLog = {};                 // skip the log entirely -> no band/marker/runway
    switchCommodity(_cardKey);
  } else {
    // Load the 3/3 log (written by the bot), THEN render the chart so the markers are there.
    fetch(`${DATA_DIR}/three_three_log.json?v=${DATA_VERSION}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : {}))
      .then(log => { window.__threeThreeLog = log; })
      .catch(() => {})
      .finally(() => switchCommodity(_cardKey));
  }
} else {
  // Cold start: the splash lifts as soon as the market on screen is drawable; the rest of
  // the board loads behind it. Fire-and-forget (self-dismissing); runs only here, so bot
  // PNGs are unaffected. bootWarmup() MUST come after the currentKey restore below — its
  // first phase is about exactly that market, and reading currentKey any earlier would warm
  // the default one and reveal on a chart the user is not looking at.
  try {
    const _lastMarket = localStorage.getItem(LAST_MARKET_KEY);
    if (_lastMarket && INDEX[_lastMarket]) currentKey = _lastMarket;
  } catch (e) {}
  bootWarmup();
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


  /* Live clock in the top-right header — timezone comes from Settings (resolveTimezone). */
  initHeaderClock();

// ── Cold-start boot splash ───────────────────────────────────────────────────
// Hold the splash (html.booting, set in <head> before first paint — normal dashboard only)
// until the market that is about to BE on screen is drawable — its category file, the
// screener, its front month's live price and history — then fade it out. The other markets
// follow after the reveal (_bootLoadRest).
// It used to hold for the whole board: nine category files (~63 MB), then a wait on any
// running refresh, then 39 contract histories. Nothing popped in afterwards, but the open
// cost up to ~90 s — and start.py kicks a refresh on every warm start, so that wait was the
// normal case, not the exception. The trade is deliberate: click a market the background
// pass has not reached yet and its front-month candles arrive a beat late (the continuous
// series is already in the category JSON and paints at once).
// There is no timed reveal: a stalled warm-up surfaces an "Open anyway" button instead
// (see the stall watchdog below).
function _revealBootSplash() {
  // Every exit from the splash runs through here — including the "Open anyway" button and
  // a warm-up hung on a fetch that never resolves — so this is where the watchdog is
  // stopped. Otherwise its 15s interval kept firing for the life of the page.
  _bootStopWatchdog();
  _bootRevealed = true;   // from here on the background pass reports into nothing (see _bootPhase)
  // Draw the prefetched live quote onto the on-screen chart(s) FIRST, so today's candle is
  // actually standing the moment the splash lifts (not "pops in" a tick later).
  try { if (typeof liveActiveTargets === 'function') liveActiveTargets().repaint(); } catch (e) {}
  const s = document.getElementById('bootSplash');
  if (s) s.classList.add('boot-splash-done');                                       // CSS fades opacity -> 0
  setTimeout(() => { document.documentElement.classList.remove('booting'); }, 450); // then display:none
}

// ── Stall watchdog ───────────────────────────────────────────────────────────
// The splash no longer reveals itself on a timer — it waits for real progress. But it must
// never TRAP the user either (Yahoo down, a 429 cooldown, an illiquid symbol that never
// quotes). So: 15s with the phase counter frozen reveals an "Open anyway" button, and the
// user decides. There is no silent auto-reveal any more.
function _bootStartWatchdog() {
  let seen = _bootProgressTick;          // compare against the value at ARM time, so a
  _bootWatchdogTimer = setInterval(() => {   // warm-up frozen from the start is caught at 15s
    if (_bootProgressTick !== seen) { seen = _bootProgressTick; return; }   // still moving
    _bootOfferSkip();                                                       // stalled: offer the exit
  }, BOOT_STALL_MS);
}

// Idempotent by construction (null timer -> no-op): bootWarmup() and _revealBootSplash()
// both call it, and on the normal path both run.
function _bootStopWatchdog() {
  if (_bootWatchdogTimer) { clearInterval(_bootWatchdogTimer); _bootWatchdogTimer = null; }
}

function _bootOfferSkip() {
  if (_bootRevealed) return;          // the user is already in; there is no exit left to offer
  const btn = document.getElementById('bootSplashSkip');
  if (btn) btn.hidden = false;
}

// ── Cold-start warm-up ───────────────────────────────────────────────────────
// Two passes: _bootOpeningMarket() holds the splash, _bootLoadRest() runs behind the open
// dashboard. The total Yahoo cost is unchanged — ONE batch quote request for the board plus
// up to 39 contract histories (zero once ff_data/contract_history/ is warm) — it simply no
// longer stands in front of the reveal.
//
// Priority is the one thing that differs between the passes. The opening market asks as
// `interactive`: it IS the chart on screen, and interactive is the only class the server
// still serves while ff_data/refresh.lock is held. Everything after the reveal asks as
// `preload`, so a board refresh outranks it.
function _bootPhase(label, done, total) {
  if (_bootRevealed) return;            // splash is gone: nowhere to report, nothing waiting on it
  const p = document.getElementById('bootSplashPhase');
  const c = document.getElementById('bootSplashProgress');
  if (p) p.textContent = label;
  if (c) c.textContent = (total > 0) ? ` · ${done}/${total}` : '';
  _bootProgressTick += 1;                 // feeds the stall watchdog above
}

// Every category + the screener. Local files, no Yahoo requests; whatever the opening
// market already pulled in comes straight back out of catCache. Re-renders the watchlist
// as it goes: watchlistQuote() reads the category payload, so a watched market from a
// category this pass has not reached yet shows its name without a price until it lands.
async function _bootLoadBoard() {
  const slugs = [...new Set(Object.keys(INDEX || {})
    .map(k => INDEX[k] && INDEX[k].slug).filter(Boolean))];
  let done = 0;
  _bootPhase('Loading market data', 0, slugs.length);
  for (const slug of slugs) {
    try { await loadCategory(slug); } catch (e) {}
    try { if (typeof renderWatchlist === 'function') renderWatchlist(); } catch (e) {}
    _bootPhase('Loading market data', ++done, slugs.length);
  }
  if (typeof ensureScreenerData === 'function') {
    try { await ensureScreenerData(); } catch (e) {}
  }
}

// A market's LEAD (highest-volume) contract — what switchCommodity actually opens on, and
// what the Weekly Outlook and Macro Shift both draw. Pure read of a loaded category; costs
// nothing, so the quote request can go before the histories.
function _bootFrontContract(cfg) {
  const contracts = (cfg && cfg.contracts) || [];
  const idx = (typeof frontContractIndex === 'function') ? frontContractIndex(contracts) : -1;
  return (idx >= 0 ? contracts[idx] : null)
    || contracts.find(c => c && c.available && c.yf_symbol) || null;
}

function _bootFrontContracts() {
  const out = [];
  for (const key of Object.keys(INDEX || {})) {
    const meta = INDEX[key];
    const front = _bootFrontContract(meta && catCache[meta.slug] && catCache[meta.slug][key]);
    if (front && front.yf_symbol) out.push(front);
  }
  return out;
}

// The cold contract histories, with BOUNDED concurrency. Strictly sequential took ~4s per
// contract against real Yahoo — nearly three minutes for a full board — and the gateway
// rate-caps the outbound requests regardless, so serialising bought nothing. Warm contracts cost nothing: fetchContractHistory returns
// immediately when the history is already on the contract.
async function _bootWarmHistories(fronts) {
  let done = 0;
  _bootPhase('Contract histories', 0, fronts.length);
  const queue = fronts.slice();
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift();
      if (!(c.chart_history || []).length && typeof fetchContractHistory === 'function') {
        try { await fetchContractHistory(c, { priority: 'preload' }); } catch (e) {}
      }
      _bootPhase('Contract histories', ++done, fronts.length);
    }
  };
  await Promise.all(Array.from({ length: BOOT_HISTORY_CONCURRENCY }, worker));
}

// A board refresh that is ALREADY running. start.py kicks one on every warm start (the
// double-click path), before it serves — and the server gateway refuses anything
// non-interactive while ff_data/refresh.lock exists. The Yahoo phases after this would be
// declined before they left the process and would count 39/39 against no-ops, so wait it
// out first. Any failure (endpoint missing, bad JSON) just returns and lets them run.
//
// This no longer holds the splash — it runs after the reveal, and the user watches the very
// same refresh in the watchlist progress bar, which is also what reloads every loaded
// category in place when it reports 'done' (refresh.js). The categories read before it
// finishes are the pre-refresh ones; replacing them is that reload's job, not ours.
async function _bootWaitForRefresh() {
  for (;;) {
    let status = null;
    try {
      const res = await fetch('/api/refresh-status', { cache: 'no-store' });
      if (!res.ok) return;
      status = await res.json();
    } catch (e) { return; }
    if (!status || status.state !== 'running') return;
    _bootPhase('Updating market data', Number(status.done) || 0, Number(status.total) || 0);
    await new Promise(r => setTimeout(r, BOOT_REFRESH_POLL_MS));
  }
}

// The splash pass: the opening market's category file and the screener (both local), then
// its front month's live price and its history (both Yahoo, both interactive). Nothing else
// — every other market waits for _bootLoadRest().
// switchCommodity() is issuing the same two requests for the same contract in the same
// tick; the in-flight maps in core.js and futures.js collapse each pair into ONE request,
// which is what lets this await them without paying for them twice.
async function _bootOpeningMarket() {
  const meta = INDEX[currentKey];
  if (!meta) return;
  _bootPhase('Loading ' + (meta.display_name || 'market'), 0, 0);
  await loadCategory(meta.slug);
  if (typeof ensureScreenerData === 'function') {
    try { await ensureScreenerData(); } catch (e) {}   // 15 KB, local: the Screener tab and both heatmaps
  }
  const front = _bootFrontContract((catCache[meta.slug] || {})[currentKey]);
  if (!front || !front.yf_symbol) return;              // no contract chain: the continuous series is enough
  if (typeof livePrefetch === 'function') {
    _bootPhase('Live price', 0, 0);
    try { await livePrefetch([front.yf_symbol]); } catch (e) {}
  }
  if (typeof fetchContractHistory === 'function') {
    _bootPhase('Front month · ' + (front.contract_symbol || front.yf_symbol), 0, 0);
    try { await fetchContractHistory(front); } catch (e) {}
  }
}

// The background pass: everything the splash no longer waits for. Order is unchanged from
// when this ran in front of the reveal — quotes BEFORE histories, deliberately. The quote
// phase is ONE request for the whole board; the history phase is up to 39. Warming
// histories first drained the preload budget below its floor and the single most valuable
// request of the whole warm-up was the one that got refused — the board came up with 1 of
// 39 live prices.
//
// When a refresh finishes mid-pass, refresh.js clears catCache and rebuilds every contract
// object, so rows warmed a moment earlier are discarded with the objects that held them —
// measured: 44 histories fetched, 1 still attached afterwards. That is not the loss it
// looks like. What this pass is really for is the SERVER-side cache in
// ff_data/contract_history/, which the refresh had just emptied (clear_contract_history_cache)
// and which survives any in-memory swap; refilling it turns the first click on a market from
// a ~4s Yahoo fetch into a ~10ms local read. Choreographing the two passes around each other
// would buy back only that 10ms.
async function _bootLoadRest() {
  // Let the reveal's fade finish first (CSS, 450ms). The category files below are ~57 MB of
  // JSON and every parse blocks the main thread, which would otherwise land as a stutter
  // across the one animation the user actually watches.
  await new Promise(r => setTimeout(r, 500));
  try {
    await _bootLoadBoard();
    await _bootWaitForRefresh();
    const fronts = _bootFrontContracts();
    const symbols = [...new Set(fronts.map(c => c.yf_symbol))];
    if (symbols.length && typeof livePrefetch === 'function') {
      await livePrefetch(symbols, { priority: 'preload' });   // ONE batch request for all
    }
    await _bootWarmHistories(fronts);
  } catch (e) { /* background: a failure costs freshness here, never the open dashboard */ }
}

async function bootWarmup() {
  if (!document.documentElement.classList.contains('booting')) return;  // card-mode / already revealed
  window.__bootWarmupStarted = true;      // tells the inline net in index.html to stand down
  // A config.js that could not be parsed (core.js). There is no board behind the splash
  // to reveal — only an empty one — so hold it on the message core.js wrote instead. The
  // line above is what keeps the 60s inline net from uncovering that empty board anyway.
  if (window.__CONFIG_BROKEN) return;
  _bootStartWatchdog();
  try {
    await _bootOpeningMarket();
  } catch (e) { /* fall through and reveal — a broken warm-up must never trap the user */ }
  _bootStopWatchdog();
  _revealBootSplash();
  _bootLoadRest();                        // not awaited: the dashboard is open, this runs behind it
}

// Header clock (#clock + .hdr-date). Re-initialisable: the Settings tab calls it again
// after a timezone change. Rebuilds the formatters from resolveTimezone() and replaces
// the running interval (idempotent).
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
