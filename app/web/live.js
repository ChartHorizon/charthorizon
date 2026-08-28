// ── live.js ── Live price overlay for the SELECTED market's price chart(s).
// DISPLAY-ONLY: ticks live in `liveQuotes` and are spliced into the chart at render
// time only (chart.js injectLivePoint / smt.js smtInjectLivePoint). They are NEVER
// written to catCache, contract.chart_history, the category JSON, SQLite, or any
// persisted store — reload discards them and the board refresh's settled bar replaces
// them. Tab-aware: drives the Futures (overview) chart and the Macro Shift (smt) charts.
// Plain shared-scope script (not a module). Backend: GET /api/live-quote?symbol=.

const LIVE_QUOTE_INTERVAL_MS = 15000;     // the on-screen chart(s)
const PREWARM_QUOTE_INTERVAL_MS = 60000;  // the Futures priority set minus the on-screen symbol
const DEFERRED_WARM_INTERVAL_MS = 60 * 60 * 1000;  // deferred curve tail — low priority
const DEFERRED_WARM_DELAY_MS = 1500;               // throttle between deferred fetches
const LIVE_KICK_DEBOUNCE_MS = 180;                 // collapse rapid market-hopping into one fetch (the market you land on)
const LIVE_CLOSED_INTERVAL_MS = 5 * 60 * 1000;     // every symbol on screen reports CLOSED —
                                                   // the still-forming bar cannot move, so stop
                                                   // paying 15s for an unchanged number

// symbol -> { day: 'YYYY-MM-DD', price: Number }
const liveQuotes = {};

let _liveActiveTimer = null;
let _livePrewarmTimer = null;
let _liveDeferredTimer = null;
let _liveKickTimer = null;    // debounced first-fetch on (re)start; cancelled by a rapid re-start
let _liveCooldownUntil = 0;   // epoch ms; set from a 429 retry_after, pauses all live polling
let _liveForceRepaint = false;  // force ONE repaint on the first active tick after a (re)start (see _liveTickActive)

// Symbols for which THIS live-layer session has landed at least one quote. Reset on every
// startLiveLayer() (page (re)load, tab return, view re-entry) — so the "Loading live…" hint
// shows until the current session re-confirms a symbol, even when `liveQuotes` still holds a
// quote from a previous session (the cache persists; this gate does not). liveConfirmed() reads it.
let _liveConfirmed = new Set();

// Which top tab (if any) the live layer drives right now.
function _liveLayerPage() {
  const page = (typeof activePage === 'function') ? activePage() : 'overview';
  if (page === 'overview' || page === 'smt') return page;
  // Screener: live only while the Weekly Outlook (with its 4/4 charts) is on screen.
  if (page === 'screener' && typeof screenerView !== 'undefined' && screenerView === 'weekly') return 'screener';
  return null;
}

function _liveEnabled() {
  return !document.body.classList.contains('card-mode')
      && !document.hidden
      && _liveLayerPage() !== null;
}

// True while a 429 cooldown is in effect (the breaker told the page to back off). The on-screen
// ACTIVE tick honours ONLY this — so the chart you're viewing keeps updating even during a board
// refresh (one symbol per 15s is negligible next to the refresh's full fetch, and a real 429
// still trips this cooldown and pauses it).
function _liveCoolingDown() {
  return Date.now() < _liveCooldownUntil;
}

// Pause live polling without tearing down timers: during a board refresh (so the refresh gets
// Yahoo to itself) or while the server is in a 429 cooldown. The bulk prewarm/deferred fetches
// obey this fully; _liveTickActive is exempt from the refresh part (it uses _liveCoolingDown).
function _liveSuspended() {
  if (_liveCoolingDown()) return true;
  if (typeof liveRefreshRunning !== 'undefined' && liveRefreshRunning) return true;
  return false;
}

// Batch fetch: one request for many symbols. Updates `liveQuotes` in place and arms
// the cooldown if the server reports a 429 + retry_after. Returns the raw quotes map.
async function _liveFetchQuotes(symbols, opts) {
  const list = (symbols || []).filter(Boolean);
  if (!list.length) return {};
  try {
    // `preload` marks cold-start warm-up so the server's gateway ranks it below an
    // on-screen chart; absent the flag the request counts as interactive (see start.py).
    const pri = (opts && opts.priority === 'preload') ? '&priority=preload' : '';
    const url = `/api/live-quote?symbols=${encodeURIComponent(list.join(','))}${pri}`;
    const res = await fetch(url, { cache: 'no-store' });
    const body = await res.json().catch(() => ({}));
    if (res.status === 429 && Number(body && body.retry_after) > 0) {
      _liveCooldownUntil = Date.now() + Number(body.retry_after) * 1000;
    }
    const quotes = (body && body.quotes) || {};
    for (const sym of list) {
      const q = quotes[sym];
      if (q && Number.isFinite(q.price) && q.day) {
        // Carry the still-forming bar's intraday OHLC when present so the chart can paint a
        // real live candle; open/high/low stay undefined when Yahoo omits them (JSON null ->
        // undefined, NOT 0), in which case chart.js falls back to a flat single-price point.
        const num = v => (Number.isFinite(v) ? v : undefined);
        liveQuotes[sym] = {
          day: q.day, price: q.price,
          open: num(q.open), high: num(q.high), low: num(q.low),
          state: q.state || null       // Yahoo marketState; null on the chart-path fallback
        };
        _liveConfirmed.add(sym);   // this session now has a live quote for `sym` -> hint can clear
      }
    }
    return quotes;
  } catch (e) { return {}; }
}

// True when every symbol currently on screen reports a closed session. Unknown state (an
// older cached quote, or a continuous symbol served by the chart fallback, which carries no
// marketState) counts as OPEN — the slow pulse must never latch on missing data.
function liveAllClosed(symbols) {
  const list = (symbols || []).filter(Boolean);
  if (!list.length) return false;
  return list.every(s => {
    const q = liveQuotes[s];
    if (!q || !q.state) return false;
    return q.state !== 'REGULAR' && q.state !== 'PRE' && q.state !== 'POST';
  });
}

// Futures-tab: resolve the on-screen symbol + the priority set (continuous, front, next).
function liveResolveVariants(cfg) {
  if (!cfg) return null;
  const contracts = cfg.contracts || [];
  const src = getActiveChartSource(cfg);
  const cont = getContinuousContract(cfg);
  const contSym = cont.yf_symbol || cont.tv_symbol || null;
  // Front = the lead (highest-volume) contract, matching the FRONT badge in the Futures tab.
  const frontIdx = frontContractIndex(contracts);
  const frontContract = frontIdx >= 0 ? contracts[frontIdx] : null;
  const frontSym = frontContract ? frontContract.yf_symbol : null;
  // nextIdx marks where the deferred forward-curve tail begins (see liveDeferredTargets).
  const nextIdx = frontIdx >= 0
    ? contracts.findIndex((c, i) => i > frontIdx && c && c.yf_symbol)
    : -1;
  return {
    activeSym: src.symbol,
    contSym, frontSym, frontContract,
    frontIdx, nextIdx
  };
}

// Symbols to poll at 15s for the on-screen view + how to repaint that view.
function liveActiveTargets() {
  const page = _liveLayerPage();
  if (page === 'overview') {
    const cfg = getCurrentCfg();
    const v = cfg ? liveResolveVariants(cfg) : null;
    return {
      page,
      symbols: v && v.activeSym ? [v.activeSym] : [],
      repaint: () => { const c = getCurrentCfg(); if (c) loadChart(c); }
    };
  }
  if (page === 'smt' && typeof smtActiveSymbol === 'function' && typeof smtState === 'object') {
    const keys = [smtState.a, smtState.b, smtState.c];
    const symbols = keys.map(k => smtActiveSymbol(k)).filter(Boolean);
    return {
      page,
      symbols,
      repaint: () => { if (typeof renderSmtCharts === 'function') renderSmtCharts(); }
    };
  }
  if (page === 'screener') {
    // The continuous symbols of the rendered Weekly-Outlook 4/4 charts (read live each tick,
    // so charts that scroll in later get picked up automatically).
    const symbols = [], seen = new Set();
    document.querySelectorAll('#screenerWeeklyBody .wk-chart[data-rendered]').forEach(el => {
      const s = (typeof wkChartLiveSymbol === 'function') ? wkChartLiveSymbol(el) : null;
      if (s && !seen.has(s)) { seen.add(s); symbols.push(s); }
    });
    return {
      page,
      symbols,
      repaint: () => { if (typeof wkRepaintLiveCharts === 'function') wkRepaintLiveCharts(); }
    };
  }
  return { page: null, symbols: [], repaint: () => {} };
}

// Pre-warm targets (Futures): the FRONT contract only. It carries its contract so its
// chart_history warms too (instant toggle). The continuous symbol is deliberately NOT
// prewarmed any more: it cannot use the batch quote endpoint (yahoo_gateway.is_batchable
// — Yahoo prices `=F` from a different contract there than its own chart series uses), so
// warming it would cost a full chart request per cycle for a chart nobody is looking at.
// It is fetched on toggle instead: one interactive request, effectively instant.
function livePrewarmTargets() {
  if (_liveLayerPage() !== 'overview') return [];
  const cfg = getCurrentCfg();
  const v = cfg ? liveResolveVariants(cfg) : null;
  if (!v) return [];
  const out = [];
  if (v.frontSym && v.frontSym !== v.activeSym) {
    out.push({ symbol: v.frontSym, contract: v.frontContract });
  }
  return out;
}

// Single-symbol convenience kept for the prewarm/deferred callers; routes through the
// batch path so there is one fetch + one 429-handling code path.
async function _liveFetchQuote(symbol) {
  if (!symbol) return null;
  await _liveFetchQuotes([symbol]);
  return liveQuotes[symbol] || null;
}

// Boot-time warm-up: fetch live quotes for many symbols up front, in ONE request. The
// server batches every single-contract symbol into a single Yahoo call (see
// yahoo_gateway.quotes), so splitting the list here would buy nothing and cost one Yahoo
// call per chunk — this used to fire 5-symbol chunks in parallel because the server could
// only ever fetch one symbol per request. Fills `liveQuotes`, which the cold-start warm-up
// polls so every chart is live before the splash lifts. Returns the symbols that now carry
// a usable live price.
async function livePrefetch(symbols, opts) {
  const list = [...new Set((symbols || []).filter(Boolean))];
  if (!list.length) return [];
  // The endpoint caps a batch at 96 symbols; chunk only to respect that limit.
  const CHUNK = 96, chunks = [];
  for (let i = 0; i < list.length; i += CHUNK) chunks.push(list.slice(i, i + CHUNK));
  for (const c of chunks) await _liveFetchQuotes(c, opts);
  return list.filter(s => { const q = liveQuotes[s]; return !!(q && Number.isFinite(q.price) && q.day); });
}

async function _liveTickActive() {
  // Note: _liveCoolingDown (NOT _liveSuspended) — the on-screen symbol keeps polling during a
  // board refresh; only a 429 cooldown pauses it. (Prewarm/deferred below still fully suspend.)
  if (!_liveEnabled() || _liveCoolingDown()) return;
  const target = liveActiveTargets();
  if (!target.symbols.length) return;
  // First tick after a (re)start (market switch, contract select, tab return): the chart on
  // screen was painted before this live session and may not show a quote that is ALREADY cached
  // or that just landed via the prewarm path — in which case the price is UNCHANGED and the
  // `changed` guard below would wrongly skip the repaint, stranding the front without its live
  // candle until the next price move (the bug behind "switch to continuous to make it update").
  // Force exactly one repaint so the on-screen chart catches up with liveQuotes.
  const force = _liveForceRepaint;
  _liveForceRepaint = false;
  const before = target.symbols.map(s => (liveQuotes[s] && liveQuotes[s].price));
  await _liveFetchQuotes(target.symbols);                 // one request for all on-screen symbols
  const changed = target.symbols.some((s, i) => (liveQuotes[s] && liveQuotes[s].price) !== before[i]);
  const haveQuote = target.symbols.some(s => { const q = liveQuotes[s]; return q && Number.isFinite(q.price) && q.day; });
  // Only repaint if still on the same tab and visible (the user may have navigated away).
  if ((changed || (force && haveQuote)) && _liveEnabled() && _liveLayerPage() === target.page) target.repaint();
}

async function _liveTickPrewarm() {
  if (!_liveEnabled() || _liveSuspended()) return;
  for (const t of livePrewarmTargets()) {
    if (t.contract && !(t.contract.chart_history || []).length && typeof fetchContractHistory === 'function') {
      try { await fetchContractHistory(t.contract); } catch (e) {}
    }
    await _liveFetchQuote(t.symbol);   // cache only; off-screen until toggled / feeds the spread
  }
}

function _liveDelay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Deferred contracts = the forward-curve tail AFTER `next` (low priority, no live overlay).
function liveDeferredTargets() {
  if (_liveLayerPage() !== 'overview') return [];
  const cfg = getCurrentCfg();
  const v = cfg ? liveResolveVariants(cfg) : null;
  if (!v) return [];
  const contracts = cfg.contracts || [];
  const afterIdx = v.nextIdx >= 0 ? v.nextIdx : v.frontIdx;
  if (afterIdx < 0) return [];
  return contracts.filter((c, i) => i > afterIdx && c && c.yf_symbol);
}

// Throttled, non-destructive: fills empty deferred chart_history so every forward-curve row
// opens instantly and the term-structure premium is fully populated. Settled-only (reuses
// /api/contract-history, which drops the unsettled tail). The board cycle clears catCache,
// so deferred history is re-filled with fresh settled data each refresh.
async function _liveTickDeferred() {
  if (!_liveEnabled() || _liveSuspended() || _liveLayerPage() !== 'overview') return;
  if (typeof fetchContractHistory !== 'function') return;
  const market = (typeof currentKey !== 'undefined') ? currentKey : null;
  for (const c of liveDeferredTargets()) {
    if (!_liveEnabled() || _liveLayerPage() !== 'overview') return;     // bail if the user left
    if (typeof currentKey !== 'undefined' && currentKey !== market) return;  // market switched
    if ((c.chart_history || []).length) continue;                      // already warm
    try { await fetchContractHistory(c); } catch (e) {}
    await _liveDelay(DEFERRED_WARM_DELAY_MS);
  }
}

// True once the current session has landed a live quote for `sym` (drives the "Loading live…"
// hint: shown while a symbol is still unconfirmed this session, hidden once its tick lands).
function liveConfirmed(sym) { return !!sym && _liveConfirmed.has(sym); }

function startLiveLayer() {
  stopLiveLayer();
  _liveConfirmed = new Set();   // fresh session: re-show "Loading live…" until each symbol re-confirms
  _liveForceRepaint = true;     // the on-screen chart predates this session -> first active tick repaints unconditionally
  if (!_liveEnabled()) return;
  // Debounce the first fetch: rapid market-hopping (A→B→C…) restarts the layer each time, and
  // stopLiveLayer() above cancels the prior pending kick — so only the market you SETTLE on
  // (no further switch within the window) actually fetches. Fly-by markets never hit Yahoo, so
  // they don't burn the shared rate-limit budget.
  _liveKickTimer = setTimeout(() => {
    _liveKickTimer = null;
    if (!_liveEnabled()) return;
    _liveTickActive();
    _liveTickPrewarm();
  }, LIVE_KICK_DEBOUNCE_MS);
  // The active tick re-schedules ITSELF rather than sitting on a fixed interval, so the
  // cadence can drop to LIVE_CLOSED_INTERVAL_MS once every symbol on screen reports a
  // closed session — and pick straight back up when one reopens.
  _armActiveTick();
  _livePrewarmTimer = setInterval(_liveTickPrewarm, PREWARM_QUOTE_INTERVAL_MS);
  _liveDeferredTimer = setInterval(_liveTickDeferred, DEFERRED_WARM_INTERVAL_MS);
  // First deferred warm kicked behind the fast three so they win the request race.
  setTimeout(() => { if (_liveEnabled()) _liveTickDeferred(); }, DEFERRED_WARM_DELAY_MS);
}

// Schedule the next on-screen tick. Closed session -> the slow pulse; otherwise the normal
// 15s. Re-arms after each tick so a reopening market is picked up on the next pass.
function _armActiveTick() {
  if (_liveActiveTimer) { clearTimeout(_liveActiveTimer); _liveActiveTimer = null; }
  const closed = liveAllClosed(liveActiveTargets().symbols);
  const delay = closed ? LIVE_CLOSED_INTERVAL_MS : LIVE_QUOTE_INTERVAL_MS;
  _liveActiveTimer = setTimeout(async () => {
    _liveActiveTimer = null;
    await _liveTickActive();
    if (_liveEnabled()) _armActiveTick();
  }, delay);
}

function stopLiveLayer() {
  if (_liveKickTimer) { clearTimeout(_liveKickTimer); _liveKickTimer = null; }   // cancel a pending debounced kick
  if (_liveActiveTimer) { clearTimeout(_liveActiveTimer); _liveActiveTimer = null; }
  if (_livePrewarmTimer) { clearInterval(_livePrewarmTimer); _livePrewarmTimer = null; }
  if (_liveDeferredTimer) { clearInterval(_liveDeferredTimer); _liveDeferredTimer = null; }
}

function restartLiveLayer() { startLiveLayer(); }

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopLiveLayer(); else startLiveLayer();
});
