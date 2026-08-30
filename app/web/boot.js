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
  // Cold start: keep the splash up until the whole board is loaded, then reveal.
  // Fire-and-forget (self-dismissing); runs only here, so bot PNGs are unaffected.
  bootWarmup();
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


  /* Live clock in the top-right header — timezone comes from Settings (resolveTimezone). */
  initHeaderClock();

// ── Cold-start boot splash ───────────────────────────────────────────────────
// Hold the splash (html.booting, set in <head> before first paint — normal dashboard only)
// until the whole board is in hand, then fade it out. Every category, the screener and every
// market's front-month history are loaded up front, so on reveal each tab opens populated and
// no candle "pops in" afterwards. There is no timed reveal: a stalled warm-up surfaces an
// "Open anyway" button instead (see the stall watchdog below).
function _hasLiveQuote(sym) {
  const q = (sym && typeof liveQuotes === 'object' && liveQuotes) ? liveQuotes[sym] : null;
  return !!(q && Number.isFinite(q.price) && q.day);
}

function _revealBootSplash() {
  // Every exit from the splash runs through here — including the "Open anyway" button and
  // a warm-up hung on a fetch that never resolves — so this is where the watchdog is
  // stopped. Otherwise its 15s interval kept firing for the life of the page.
  _bootStopWatchdog();
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
  const btn = document.getElementById('bootSplashSkip');
  if (btn) btn.hidden = false;
}

// ── Cold-start warm-up ───────────────────────────────────────────────────────
// The splash stays up until every tab's data is in hand, then reveals. Page-aware
// prefetching is gone: the dashboard used to open on a 12s deadline whether or not it was
// ready, and everything else loaded while the user was already clicking.
//
// Yahoo cost: phase 2 is up to 39 contract-history requests on a cold start (zero once
// ff_data/contract_history/ is warm), phase 3 is ONE batch request for all the front-month
// quotes. Both run at `preload` priority so a board refresh still outranks them.
function _bootPhase(label, done, total) {
  const p = document.getElementById('bootSplashPhase');
  const c = document.getElementById('bootSplashProgress');
  if (p) p.textContent = label;
  if (c) c.textContent = (total > 0) ? ` · ${done}/${total}` : '';
  _bootProgressTick += 1;                 // feeds the stall watchdog above
}

// Phase 1: every category + the screener. Local files, no Yahoo requests.
async function _bootLoadBoard() {
  const slugs = [...new Set(Object.keys(INDEX || {})
    .map(k => INDEX[k] && INDEX[k].slug).filter(Boolean))];
  let done = 0;
  _bootPhase('Loading market data', 0, slugs.length);
  for (const slug of slugs) {
    try { await loadCategory(slug); } catch (e) {}
    _bootPhase('Loading market data', ++done, slugs.length);
  }
  if (typeof ensureScreenerData === 'function') {
    try { await ensureScreenerData(); } catch (e) {}
  }
}

// Each market's LEAD (highest-volume) contract — what switchCommodity actually opens on, and
// what the Weekly Outlook and Macro Shift both draw. Pure read of what phase 1 loaded; costs
// nothing, so the quote request can go before the histories.
function _bootFrontContracts() {
  const out = [];
  for (const key of Object.keys(INDEX || {})) {
    const meta = INDEX[key];
    const cfg = meta && catCache[meta.slug] && catCache[meta.slug][key];
    if (!cfg) continue;
    const contracts = cfg.contracts || [];
    const idx = (typeof frontContractIndex === 'function') ? frontContractIndex(contracts) : -1;
    const front = (idx >= 0 ? contracts[idx] : null)
      || contracts.find(c => c && c.available && c.yf_symbol) || null;
    if (front && front.yf_symbol) out.push(front);
  }
  return out;
}

// Phase 3: the cold contract histories, with BOUNDED concurrency. Strictly sequential took
// ~4s per contract against real Yahoo — nearly three minutes for a full board, all of it
// behind the splash — and the gateway rate-caps the outbound requests regardless, so
// serialising bought nothing. Warm contracts cost nothing: fetchContractHistory returns
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

// Phase 0: a board refresh that is ALREADY running. start.py kicks one on every warm start
// (the double-click path), before it serves — and the server gateway refuses anything
// non-interactive while ff_data/refresh.lock exists. Phases 2 and 3 would then be declined
// before they left the process, and the splash would count 39/39 against no-ops and reveal
// an empty board. So we wait the refresh out and show ITS progress, which is what the user
// is actually waiting for. Returns true if we waited at all.
//
// That wait is legitimately minutes long, so "Open anyway" is offered IMMEDIATELY here
// rather than after the 15s stall: the user must always be able to enter. Any failure
// (endpoint missing, bad JSON) just returns and lets the phases run.
//
// The categories phase 1 already read are the pre-refresh ones; refreshing them here
// would be a no-op (loadCategory serves catCache), and it is not this function's job —
// startRefreshPolling() is watching the same refresh and reloads every loaded category
// in place when it reports 'done'.
async function _bootWaitForRefresh() {
  let offeredSkip = false;
  for (;;) {
    let status = null;
    try {
      const res = await fetch('/api/refresh-status', { cache: 'no-store' });
      if (!res.ok) return;
      status = await res.json();
    } catch (e) { return; }
    if (!status || status.state !== 'running') return;
    if (!offeredSkip) { offeredSkip = true; _bootOfferSkip(); }
    _bootPhase('Updating market data', Number(status.done) || 0, Number(status.total) || 0);
    await new Promise(r => setTimeout(r, BOOT_REFRESH_POLL_MS));
  }
}

async function bootWarmup() {
  if (!document.documentElement.classList.contains('booting')) return;  // card-mode / already revealed
  window.__bootWarmupStarted = true;      // tells the inline net in index.html to stand down
  _bootStartWatchdog();
  try {
    await _bootLoadBoard();
    // A refresh in flight declines every preload request below; wait it out first (and
    // render its progress meanwhile) instead of counting phases that did nothing.
    await _bootWaitForRefresh();
    const fronts = _bootFrontContracts();
    const symbols = [...new Set(fronts.map(c => c.yf_symbol))];

    // Quotes BEFORE histories, deliberately. The quote phase is ONE request for the whole
    // board; the history phase is up to 39. Warming histories first drained the preload
    // budget below its floor and the single most valuable request of the whole warm-up was
    // the one that got refused — the board came up with 1 of 39 live prices.
    if (symbols.length && typeof livePrefetch === 'function') {
      _bootPhase('Live prices', 0, symbols.length);
      await livePrefetch(symbols, { priority: 'preload' });   // ONE batch request for all
      _bootPhase('Live prices', symbols.filter(_hasLiveQuote).length, symbols.length);
    }
    await _bootWarmHistories(fronts);
  } catch (e) { /* fall through and reveal — a broken warm-up must never trap the user */ }
  _bootStopWatchdog();
  _revealBootSplash();
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
