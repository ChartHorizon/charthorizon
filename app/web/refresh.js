// ── Background EoD refresh: poll the server, show a progress bar in the watchlist
// sidebar, and reload data in place when a refresh finishes. Backend:
// start.py (/api/refresh-status, POST /api/refresh) + commodity_dashboard.py
// (ff_data/refresh_progress.json). Plain shared-scope script (not a module).

let _refreshPollTimer = null;
let _refreshDoneFade = null;
let _refreshWasRunning = false;   // only reload after a running -> done transition we saw

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
      if (label) label.textContent = status.current ? `Aktualisiere ${status.current}…` : 'Aktualisiere…';
      if (fill) fill.style.width = pct + '%';
      if (sub) sub.textContent = total > 0 ? `${done}/${total} · ${pct}%` : 'läuft…';
    } else if (state === 'done') {
      if (label) label.textContent = 'Aktualisiert ✓';
      if (fill) fill.style.width = '100%';
      if (sub) sub.textContent = '';
    } else if (state === 'error') {
      if (label) label.textContent = 'Aktualisierung fehlgeschlagen';
      if (fill) fill.style.width = '0%';
      if (sub) sub.textContent = 'Erneut versuchen';
    } else {
      if (label) label.textContent = 'Aktualisieren';
      if (fill) fill.style.width = '0%';
      if (sub) sub.textContent = '';
    }
  });
}

function startRefreshPolling() {
  if (_refreshPollTimer) return;
  if (_refreshDoneFade) { clearTimeout(_refreshDoneFade); _refreshDoneFade = null; }
  _refreshPollTimer = setTimeout(pollRefreshStatus, 0);
}

async function pollRefreshStatus() {
  _refreshPollTimer = null;
  let status;
  try {
    const res = await fetch('/api/refresh-status', { cache: 'no-store' });
    status = await res.json();
  } catch (e) {
    status = { state: 'idle' };
  }
  renderRefreshProgress(status);
  if (status.state === 'running') {
    _refreshWasRunning = true;
    _refreshPollTimer = setTimeout(pollRefreshStatus, 1000);
    return;
  }
  if (status.state === 'done' && _refreshWasRunning) {
    _refreshWasRunning = false;
    await applyRefreshedData(status);
    _refreshDoneFade = setTimeout(() => renderRefreshProgress({ state: 'idle' }), 2500);
    return;   // stop polling; bar shows "Aktualisiert ✓" then fades
  }
  if (status.state === 'error' && _refreshWasRunning) {
    _refreshWasRunning = false;
    return;   // stop polling; bar stays in error state with a retry affordance
  }
  // idle, or a stale 'done'/'error' on the first poll (we never saw it running) -> do nothing
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
    if (typeof resetScreenerData === 'function') resetScreenerData();
    if (typeof bumpDataReloadNonce === 'function') bumpDataReloadNonce();
    if (status && status.latest_eod && window.__CONFIG__) window.__CONFIG__.genDate = status.latest_eod;
    if (typeof ensureScreenerData === 'function') { try { await ensureScreenerData(); } catch (e) {} }
    if (typeof loadCategory === 'function') {
      for (const slug of loadedSlugs) { try { await loadCategory(slug); } catch (e) {} }
    }

    const page = (typeof activePage === 'function') ? activePage() : 'overview';
    if (page === 'overview') {
      if (typeof repaintOverviewThemed === 'function') repaintOverviewThemed();
      // repaintOverviewThemed keeps chartState (the chart view is preserved), but the
      // forward-curve table + spec card are rendered from cfg — refresh them from the
      // freshly-reloaded category so they don't keep showing stale contract prices.
      const _cfg = (typeof currentKey !== 'undefined' && typeof INDEX === 'object' &&
                    INDEX[currentKey] && catCache[INDEX[currentKey].slug])
                   ? catCache[INDEX[currentKey].slug][currentKey] : null;
      if (_cfg) {
        if (typeof renderTable === 'function') renderTable(_cfg);
        if (typeof renderSpecs === 'function') renderSpecs(_cfg);
      }
    } else if (typeof PAGES !== 'undefined') {
      const p = PAGES.find(x => x.id === page);
      if (p && p.load) await p.load();
    }
    if (typeof renderWatchlist === 'function') renderWatchlist();
  } catch (e) {
    console.warn('in-place reload after refresh failed', e);
  }
}
