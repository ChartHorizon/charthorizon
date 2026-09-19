// ── Background EoD refresh: poll the server, show a progress bar in the watchlist
// sidebar, and reload data in place when a refresh finishes. Backend:
// start.py (/api/refresh-status, POST /api/refresh) + commodity_dashboard.py
// (ff_data/refresh_progress.json). Plain shared-scope script (not a module).

let _refreshPollTimer = null;
let _refreshDoneFade = null;
let _refreshWasRunning = false;   // we saw this run go 'running' (manual button / caught it live)
let liveRefreshRunning = false;   // read by live.js to pause live polling during a board refresh
// One status read at a time. Boot, the manual button and a tab coming back into view all ask
// for one, and any of them can arrive while a read is still out — the in-place reload below
// alone takes seconds. Each read used to schedule its own successor, so every overlap left one
// more polling chain running for the life of the page.
let _refreshPollBusy = false;
let _refreshPollAgain = false;    // asked for while busy: poll again the moment the busy read ends

// Identity of the data this page is currently showing. Lets an open tab pick up a
// completed refresh — the warm-start one or the once-a-day auto-update — even when it
// never witnessed the run go 'running' (the fetch can finish before our first poll, and
// a tab left open across the daily job may miss the brief 'running' window entirely).
// dataVersion is the generator's per-run stamp (config.js carries the same value), so it
// tells two runs over the SAME data apart. genDate cannot: it names the settled session the
// data reaches (until 2026-09-12 it was the local calendar day of the run), and a tab that had
// not seen a second run go 'running' — a relaunch, the evening job after a morning start, the
// ⟳ button in another tab — never applied it and showed the old data until a browser reload.
// genDate remains the fallback for a progress file written before data_version existed.
// finished_at is the exact per-run stamp of the 'done' itself.
let _appliedGenDate = (window.__CONFIG__ && window.__CONFIG__.genDate) || '';
let _appliedDataVersion = (window.__CONFIG__ && window.__CONFIG__.dataVersion) || '';
let _appliedFinishedAt = '';
const REFRESH_POLL_RUNNING_MS = 1000;       // tight cadence while a refresh runs (progress bar)
const REFRESH_POLL_IDLE_MS = 60 * 1000;     // cheap heartbeat to notice the next daily refresh
                                            // (reads the small status JSON only — never POSTs a fetch)

function _wlRefreshNodes() { return document.querySelectorAll('[data-watchlist-refresh]'); }

function renderRefreshProgress(status) {
  const state = (status && status.state) || 'idle';
  const running = state === 'running';
  const total = Number(status && status.total) || 0;
  const done = Number(status && status.done) || 0;
  const pct = total > 0 ? Math.min(100, Math.round(done / total * 100)) : (running ? 0 : 100);
  _wlRefreshNodes().forEach(node => {
    const label = node.querySelector('[data-wlr-label]');
    const fill = node.querySelector('[data-wlr-fill]');
    const sub = node.querySelector('[data-wlr-sub]');
    const btn = node.querySelector('[data-wlr-trigger]');
    node.classList.toggle('is-running', running);
    node.classList.toggle('is-done', state === 'done');
    node.classList.toggle('is-error', state === 'error');
    node.classList.toggle('indeterminate', running && total === 0);
    if (btn) btn.disabled = running;
    if (running) {
      if (label) label.textContent = status.current ? `Updating ${status.current}…` : 'Updating…';
      if (fill) fill.style.width = pct + '%';
      if (sub) sub.textContent = total > 0 ? `${done}/${total} · ${pct}%` : 'running…';
    } else if (state === 'done') {
      if (label) label.textContent = 'Updated ✓';
      if (fill) fill.style.width = '100%';
      if (sub) sub.textContent = '';
    } else if (state === 'error') {
      if (label) label.textContent = 'Update failed';
      if (fill) fill.style.width = '0%';
      if (sub) sub.textContent = 'Try again';
    } else {
      if (label) label.textContent = 'Refresh';
      if (fill) fill.style.width = '0%';
      if (sub) sub.textContent = '';
    }
  });
}

function startRefreshPolling() {
  // Poll now, cancelling any pending slow heartbeat — boot and the manual Refresh
  // button both want an immediate status read, not a wait of up to a minute.
  if (_refreshPollTimer) { clearTimeout(_refreshPollTimer); _refreshPollTimer = null; }
  if (_refreshDoneFade) { clearTimeout(_refreshDoneFade); _refreshDoneFade = null; }
  if (_refreshPollBusy) { _refreshPollAgain = true; return; }
  _refreshPollTimer = setTimeout(pollRefreshStatus, 0);
}

async function pollRefreshStatus() {
  _refreshPollTimer = null;
  if (_refreshPollBusy) { _refreshPollAgain = true; return; }
  _refreshPollBusy = true;
  let nextPollMs = REFRESH_POLL_IDLE_MS;
  try {
    let status;
    try {
      const res = await fetch('/api/refresh-status', { cache: 'no-store' });
      status = await res.json();
    } catch (e) {
      status = { state: 'idle' };
    }
    liveRefreshRunning = (status && status.state === 'running');

    if (status.state === 'running') {
      renderRefreshProgress(status);
      _refreshWasRunning = true;
      nextPollMs = REFRESH_POLL_RUNNING_MS;
      return;
    }

    // A refresh has finished. Reload the open page when its freshly generated data is
    // newer than what we're showing — whether or not THIS tab saw the run go 'running'.
    // That is what makes an open tab pick up the once-a-day auto-update. We act on each
    // 'done' at most once, keyed by finished_at, so the slow heartbeat below can't
    // re-trigger a reload (or re-flash "Updated ✓") on a 'done' we already consumed.
    const consumed = status.finished_at && status.finished_at === _appliedFinishedAt;
    const newerData = status.data_version
      ? status.data_version !== _appliedDataVersion
      : !!(status.latest_eod && status.latest_eod !== _appliedGenDate);
    if (status.state === 'done' && !consumed && (_refreshWasRunning || newerData)) {
      _refreshWasRunning = false;
      _appliedFinishedAt = status.finished_at || _appliedFinishedAt;
      renderRefreshProgress(status);                       // "Updated ✓"
      await applyRefreshedData(status);                    // refetch JSON + re-render heatmaps
      if (_refreshDoneFade) clearTimeout(_refreshDoneFade);
      _refreshDoneFade = setTimeout(() => renderRefreshProgress({ state: 'idle' }), 2500);
    } else if (status.state === 'error' && _refreshWasRunning) {
      _refreshWasRunning = false;
      renderRefreshProgress(status);                        // error affordance (retry button)
    } else if (!_refreshDoneFade) {
      // Nothing new for us — keep the bar idle (don't surface a stale/old 'done').
      renderRefreshProgress({ state: 'idle' });
    }

    // Keep a cheap heartbeat alive so the NEXT daily refresh is noticed. This only reads
    // the small status JSON; it never POSTs /api/refresh, so the page never triggers a
    // fetch on its own — data moves once a day via warm-start + the auto-update job.
  } finally {
    // The one place the next read is scheduled, however this one ended.
    _refreshPollBusy = false;
    if (_refreshPollAgain) { _refreshPollAgain = false; nextPollMs = 0; }
    if (_refreshPollTimer) clearTimeout(_refreshPollTimer);
    _refreshPollTimer = setTimeout(pollRefreshStatus, nextPollMs);
  }
}

async function triggerManualRefresh() {
  // Only arm the running->done watcher if the server actually started (or already has)
  // a refresh — otherwise a failed POST + a stale 'done' on disk would fire a spurious
  // in-place reload.
  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    const body = await res.json();
    if (body && body.running) _refreshWasRunning = true;
  } catch (e) {}
  startRefreshPolling();
}

// A tab coming back into view asks at once instead of on its next heartbeat. A hidden tab's
// timers are throttled (Chrome: about once a minute), so a refresh that finished while the
// dashboard sat in the background could stay unapplied for a minute or more after the user
// was looking at it again — long enough to reach for the browser's reload button.
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !document.body.classList.contains('card-mode')) startRefreshPolling();
});

async function applyRefreshedData(status) {
  // Invalidate in-memory caches so the loaders refetch fresh JSON (files already use
  // cache:'no-store'; the nonce is belt-and-suspenders).
  try {
    // Snapshot which categories were loaded, then clear so the loaders refetch fresh
    // JSON. Refetch EVERY previously-loaded category, not just the current one: the
    // chart renders chartState.key (which can differ from currentKey) and the watchlist
    // quotes span multiple categories — reloading only one slug would blank the chart or
    // drop watchlist quotes. (Files already use cache:'no-store'; the nonce is belt-and-
    // suspenders against any intermediate cache.)
    let loadedSlugs = [];
    if (typeof catCache === 'object' && catCache) {
      loadedSlugs = Object.keys(catCache);
      loadedSlugs.forEach(k => { delete catCache[k]; });
    }
    if (typeof resetScreenerData === 'function') resetScreenerData();   // screener.json + the 3/3 log
    if (typeof bumpDataReloadNonce === 'function') bumpDataReloadNonce();
    await reloadRefreshedConfig();
    if (status && status.latest_eod && window.__CONFIG__) window.__CONFIG__.genDate = status.latest_eod;
    if (typeof ensureScreenerData === 'function') { try { await ensureScreenerData(); } catch (e) {} }
    // Before any view repaints below: the Weekly Outlook draws its 3/3 band, entry marker and
    // "Active since" line from this log, and would otherwise paint without it first.
    if (typeof ensureThreeThreeLog === 'function') { try { await ensureThreeThreeLog(); } catch (e) {} }
    if (typeof loadCategory === 'function') {
      for (const slug of loadedSlugs) { try { await loadCategory(slug); } catch (e) {} }
    }

    const page = (typeof activePage === 'function') ? activePage() : 'overview';
    if (page === 'overview') {
      if (typeof refreshOverviewChart === 'function') await refreshOverviewChart();
    } else if (typeof PAGES !== 'undefined') {
      const p = PAGES.find(x => x.id === page);
      if (p && p.load) await p.load();
      // Nothing above touched the hidden Futures tab, whose chart is now drawn from contract
      // objects this reload discarded. Flag it so switchPage() re-establishes it on return
      // instead of silently showing pre-refresh bars.
      _overviewDataDirty = true;
    }
    // The two strength heatmaps live on different tabs (Futures Strength at the bottom
    // of the overview tab, FX Strength on the forex tab), but both read the freshly
    // reloaded screenerData. The page branch above only repaints the ACTIVE tab, so the
    // hidden tab's heatmap would keep showing pre-refresh signals. Re-render BOTH here
    // (idempotent pure DOM writes; each self-bails if its section/data is missing) so
    // neither goes stale after a refresh that completed while the other tab was open.
    if (typeof renderFuturesHeat === 'function') { try { renderFuturesHeat(); } catch (e) {} }
    if (typeof renderFxSection === 'function' && screenerData) { try { renderFxSection(); } catch (e) {} }
    if (typeof renderWatchlist === 'function') renderWatchlist();
    // Remember what the page now shows so the heartbeat won't reload the same data again.
    // The status's own stamp, not the reloaded config's: if yet another run landed while this
    // reload was in progress, the next poll then still sees it as newer.
    _appliedGenDate = (window.__CONFIG__ && window.__CONFIG__.genDate) || _appliedGenDate;
    _appliedDataVersion = (status && status.data_version)
      || (window.__CONFIG__ && window.__CONFIG__.dataVersion) || _appliedDataVersion;
  } catch (e) {
    console.warn('in-place reload after refresh failed', e);
  }
}

// config.js is a single `window.__CONFIG__ = {…};` statement, so running the new file again
// IS the update. Nothing re-read it after page load, which kept the FX policy rates (forex.js
// fxInterestRates) on the values the page opened with until a browser reload. A file that
// will not parse throws inside its own script and leaves the current config standing. INDEX
// and DATA_DIR (core.js) stay as loaded: the market list is static metadata.
function reloadRefreshedConfig() {
  return new Promise(resolve => {
    const script = document.createElement('script');
    script.src = `${DATA_DIR}/config.js?r=${_dataReloadNonce}`;
    script.onload = script.onerror = () => { script.remove(); resolve(); };
    document.head.appendChild(script);
  });
}

// The page no longer re-triggers data refreshes on a timer. EoD data only moves once a
// day, so a self-driven 15-min refetch was needless yfinance load (and fed the live-quote
// rate-limit pressure). The only fetch triggers now are: the warm-start refresh on launch,
// the daily auto-update job, and the manual ⟳ button. The slow heartbeat in
// pollRefreshStatus still NOTICES the daily refresh and reloads the open page in place —
// it just reads the tiny status JSON and never POSTs /api/refresh itself.
