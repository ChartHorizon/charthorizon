// `opts.priority === 'preload'` marks the request as cold-start warm-up rather than a user
// action. The server cannot infer that, and without it the boot preload would compete with
// on-screen charts as interactive — see the gateway's priority floors in yahoo_gateway.py.
async function fetchContractHistory(contract, opts) {
  if ((contract.chart_history || []).length) return contract.chart_history;
  if (!contract.yf_symbol) throw new Error('No Yahoo symbol is available for this contract.');

  const priority = (opts && opts.priority === 'preload') ? '&priority=preload' : '';
  const url = `/api/contract-history?symbol=${encodeURIComponent(contract.yf_symbol)}&period=${CONTRACT_HISTORY_PERIOD}${priority}`;
  const res = await fetch(url);
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(payload.error || 'Contract history could not be loaded.');
  }
  contract.chart_history = payload.history || [];
  return contract.chart_history;
}

function renderContractLoading(cfg, contract) {
  const body = document.getElementById('chartBody');
  const label = esc(contract.contract_symbol || contract.yf_symbol || contract.label || 'Contract');
  body.innerHTML = renderChartControls() +
    `<div class="chart-empty">Loading chart data for single contract ${label}...</div>`;
  bindChartControls(cfg);
}

function renderContractError(cfg, contract, message) {
  const body = document.getElementById('chartBody');
  const label = esc(contract.contract_symbol || contract.yf_symbol || contract.label || 'Contract');
  body.innerHTML = renderChartControls() +
    `<div class="chart-empty">Single contract ${label}: ${esc(message)}</div>`;
  bindChartControls(cfg);
}

// Re-establish chartState's selected contract on `cfg`, fetching its history if the
// contract doesn't carry any (the chart-controls button, and the in-place reload after a
// board refresh, which hands out contract objects with an empty chart_history).
// `fallbackToContinuous` is for the non-interactive caller: after a background refresh a
// failed fetch should degrade to the continuous series (which always has data) rather than
// leave an error box on a chart the user never asked to reload.
async function activateSelectedContract(cfg, fallbackToContinuous = false) {
  const idx = (cfg.contracts || []).findIndex(c => c.yf_symbol === chartState.contractSymbol);
  if (idx < 0) {
    chartState.chartMode = 'continuous';
    loadChart(cfg);
    renderTable(cfg);
    if (typeof restartLiveLayer === 'function') restartLiveLayer();
    return;
  }
  await selectCurveContract(idx, fallbackToContinuous);
}
// Re-establish the Futures tab's chart, forward curve and spec card against the CURRENT
// catCache. This is the after-a-board-refresh path: that reload replaces every contract
// object, and the fresh front month carries no chart_history at all (it lives behind
// /api/contract-history — a cache `--refresh` clears too). repaintOverviewThemed() is a
// THEME repaint and only DRAWS, so it painted "No chart history available for <symbol>"
// over the single-contract view this tab opens in, and the user had to click the market
// again to get a chart back. In contract mode we fetch first — the same path that click
// takes — and degrade to the continuous series if the fetch fails or the contract is gone
// from the refreshed chain.
async function refreshOverviewChart() {
  const cfg = (typeof getCurrentCfg === 'function') ? getCurrentCfg() : null;
  if (cfg && chartState.chartMode === 'contract') {
    await activateSelectedContract(cfg, true);    // fetch-then-draw; re-renders the curve too
  } else if (typeof repaintOverviewThemed === 'function') {
    repaintOverviewThemed();                      // continuous history ships in the category JSON
  }
  // The chart view is preserved, but the forward-curve table + spec card are rendered
  // straight from cfg — refresh them from the reloaded category so they don't keep showing
  // stale contract prices.
  if (cfg) {
    if (typeof renderTable === 'function') renderTable(cfg);
    if (typeof renderSpecs === 'function') renderSpecs(cfg);
  }
}


async function selectCurveContract(index, fallbackToContinuous = false) {
  const cfg = getCurrentCfg();
  if (!cfg || !cfg.contracts || !cfg.contracts[index]) return;

  const contract = cfg.contracts[index];
  chartState.chartMode = 'contract';
  chartState.contractSymbol = contract.yf_symbol;
  chartState.contractLabel = contract.contract_symbol || contract.delivery_month_label || contract.label || contract.yf_symbol;
  // 5Y is a continuous-only range (a single contract spans only months); if it's
  // active when a contract is selected, drop to 12M so the header doesn't claim
  // "5 Years" over a few months of bars.
  if (chartState.range === '5y') chartState.range = '12m';
  renderTable(cfg);

  if (!(contract.chart_history || []).length) {
    renderContractLoading(cfg, contract);
    try {
      await fetchContractHistory(contract);
    } catch (e) {
      // The user may have switched markets while the fetch was in flight; a newer
      // switchCommodity/selectCurveContract now owns the chart, so don't clobber it.
      if (getCurrentCfg() !== cfg) return;
      if (fallbackToContinuous) {
        chartState.chartMode = 'continuous';
        chartState.contractSymbol = null;
        chartState.contractLabel = null;
        loadChart(cfg);
        renderTable(cfg);
        if (typeof restartLiveLayer === 'function') restartLiveLayer();
        return;
      }
      renderContractError(cfg, contract, e.message || String(e));
      return;
    }
  }

  // Same guard for the success path: if a later market selection raced ahead while
  // this contract's history was loading, its render owns the chart now.
  if (getCurrentCfg() !== cfg) return;
  loadChart(cfg);
  renderTable(cfg);
  if (typeof restartLiveLayer === 'function') restartLiveLayer();
}

function renderTable(cfg) {
  const dec = cfg.tick_decimals;
  // FRONT badge marks the lead (highest-volume) contract, not row 0 — see frontContractIndex.
  const frontIdx = frontContractIndex(cfg.contracts);
  document.getElementById('curveBody').innerHTML = cfg.contracts.map((c,i) => {
    const price = fmtNum(c.last, dec);
    const chg = fmtNum(c.change, dec);
    const pct = c.change_pct;
    const up = (pct ?? 0) >= 0;
    const vol = fmtInt(c.volume);
    const oi = fmtInt(c.open_interest);
    const fb = i === frontIdx ? '<span class="front-badge">FRONT</span>' : '';
    const delivery = esc(c.delivery_month_label || c.label || '');
    const contractSymbol = [c.contract_symbol, c.yf_symbol].filter(Boolean).join(' · ');
    const active = chartState.chartMode === 'contract' && chartState.contractSymbol === c.yf_symbol;
    return `<tr class="curve-row ${active ? 'active' : ''}" onclick="selectCurveContract(${i})" title="Show this contract in the main chart">
      <td><span class="contract-label">${delivery}${fb}</span><div class="contract-sym">Single contract · ${esc(contractSymbol)}</div></td>
      <td>${price!==null?price:'<span class="na">n/a</span>'}</td>
      <td class="${up?'pos':'neg'}">${chg!==null?(up?'+':'')+chg:'<span class="na">–</span>'}</td>
      <td class="${up?'pos':'neg'}">${pct!==null&&pct!==undefined?(up?'+':'')+pct.toFixed(2)+'%':'<span class="na">–</span>'}</td>
      <td>${vol!==null?vol:'<span class="na">–</span>'}</td>
      <td>${oi!==null?oi:'<span class="na">–</span>'}</td>
      <td class="expiry-cell">${fmtExpiry(c.expiry)}</td>
    </tr>`;
  }).join('');
}

function renderSpecs(cfg) {
  const specs = cfg.specs || {};
  const card = document.getElementById('specCard');
  if (!specs.tick) {
    card.innerHTML = '<div class="spec-empty">No contract specifications available.</div>';
    return;
  }
  const source = specs.source_url
    ? `<span class="spec-source">Source: <a href="${esc(specs.source_url)}" target="_blank" rel="noopener">${esc(specs.source || 'Exchange')}</a></span>`
    : `<span class="spec-source">${esc(specs.source || '')}</span>`;
  const specText = (value) => esc(String(value || '')).replace(/\n/g, '<br>');
  const item = (label, value) => `<div class="spec-item"><div class="spec-label">${label}</div><div class="spec-value">${specText(value)}</div></div>`;
  const hoursValue = specText(specs.trading_hours || '');
  card.innerHTML = `
    <div class="spec-head">
      <div class="spec-title">Contract Specifications</div>
      <span class="spec-source">${esc(specs.exchange || '')}</span>
      ${source}
    </div>
    <div class="spec-grid">
      ${item('Tick Value', specs.tick)}
      ${item('Contract Size', specs.contract_size)}
      ${item('Expiration Rule', specs.expiration)}
      <div class="spec-item"><div class="spec-label">Trading Hours</div><div class="spec-value">${hoursValue}</div></div>
    </div>`;
}

async function switchCommodity(key) {
  currentKey = key;
  try { localStorage.setItem(LAST_MARKET_KEY, key); } catch (e) {}
  const meta = INDEX[key];
  if (!meta) return;
  renderWatchlist();

  document.querySelectorAll('#sidebar .commodity-item').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-'+key)?.classList.add('active');
  document.getElementById('mobileSelect').value = key;
  document.getElementById('chartCat').textContent = meta.category;
  document.getElementById('chartName').textContent = meta.display_name;

  document.getElementById('chartBody').innerHTML =
    '<div class="chart-empty">Loading ' + meta.category + ' data...</div>';
  document.getElementById('specCard').innerHTML = '';

  const catData = await loadCategory(meta.slug);
  if (!catData || !catData[key]) {
    document.getElementById('chartBody').innerHTML =
      '<div class="chart-empty">Data could not be loaded. Is the page running through a web server instead of file://?</div>';
    document.getElementById('specCard').innerHTML =
      '<div class="spec-empty">Contract specifications could not be loaded.</div>';
    return;
  }

  const cfg = catData[key];
  chartState.chartMode = 'continuous';
  chartState.contractSymbol = null;
  chartState.contractLabel = null;
  const continuous = getContinuousContract(cfg);
  const chartSymbol = continuous.yf_symbol || continuous.tv_symbol || 'Continuous';
  document.getElementById('chartSym').textContent = chartSymbol + ' · ' + chartDisplayMode(continuous) + ' · ' + cfg.unit + ' · ' + cfg.currency;
  document.getElementById('tableTitle').textContent = cfg.display_name + ' – Forward Curve';
  document.getElementById('tableSub').textContent = 'Individual futures by delivery and expiration month · Click a row to show that contract in the main chart';
  chartState.key = key;
  renderSpecs(cfg);
  renderWatchlist();
  // Default chart = the front-month single contract (the lead / highest-volume contract,
  // FRONT-badged). Falls back to the continuous series if its history can't be fetched
  // (e.g. no local API server).
  const frontIdx = frontContractIndex(cfg.contracts);
  if (frontIdx >= 0) {
    const front = cfg.contracts[frontIdx];
    if ((front.chart_history || []).length) {
      // Front history already cached → render the front month immediately.
      await selectCurveContract(frontIdx, true);
    } else if (document.body.classList.contains('card-mode')) {
      // Card-mode (bot PNG export, ?card=): NO instant paint + background swap — the
      // chart SVG must not exist before the front month is in place, or the exporter's
      // screenshot freezes the continuous series (race). On a fetch error the existing
      // continuous fallback kicks in via fallbackToContinuous=true (an honest degrade).
      await selectCurveContract(frontIdx, true);
    } else {
      // Instant first paint from the continuous series (already in the category JSON, no
      // fetch); load the front contract in the background and swap to it when ready.
      loadChart(cfg);            // chartState.chartMode === 'continuous' (set above)
      renderTable(cfg);
      fetchContractHistory(front).then(() => {
        // Swap only if still on this market, the user hasn't changed the view, AND the fetch
        // actually returned history. During a board refresh the single-contract cache is cleared
        // and a re-fetch can come back empty (Yahoo throttled) — swapping then would show an empty
        // "No chart history" pane, so we stay on the continuous (which always has data) instead.
        if (chartState.key === key && chartState.chartMode === 'continuous' && (front.chart_history || []).length) {
          selectCurveContract(frontIdx, true);
        }
      }).catch(() => {});        // on failure, leave the continuous chart shown
    }
  } else {
    loadChart(cfg);
    renderTable(cfg);
  }
  if (typeof restartLiveLayer === 'function') restartLiveLayer();
}

// ── Futures Strength heatmap (bottom of the Futures tab) ────────────────────
// Mirrors the FX strength board (forex.js) but for the futures universe, and shows
// ONLY full setups: markets where all 3 signals (Seasonals · COT-Hedging · Term
// Structure) align in one direction — a full 3/3, using the same setup definition
// the Screener's Weekly Outlook and the content bot use (screenerSetup, from
// screener.js), but filtered down to count === 3 here at the call site.
// screenerSetup itself still returns 2/3 partials — the Weekly Outlook needs those
// (its "completing this week" section lifts a 2/3 to 3/3) — this board just doesn't
// show them: a 2/3 is a two-to-one split among three signals, not a setup one
// signal short, and doesn't belong on a board that reads as "these are aligned."
// Drawn as two bias columns, reusing the FX board's .fx-* styling verbatim. Reads
// the shared screenerData; pure on-screen view, never invoked in card-mode (so
// content-bot PNGs are unchanged). Chip color uses fxCurrencyHeat() with max
// pinned to 3, fed the signed setup count, so a full setup saturates the chip.
const FUTURES_HEAT_MAX = 3;
// FX currencies have their own heatmap on the Forex tab — exclude them here so
// the two boards don't overlap.
const FUTURES_HEAT_EXCLUDE_CATEGORY = 'Currencies';

function futuresHeatTitle(r, setup) {
  const sig = SIG_KEYS.map(k => `${SIG_LABEL[k]} ${k === 'structure' ? (r.structure || 'neutral') : (r[k] || 'neutral')}`).join(' · ');
  return `${r.display_name}: ${setup.count}/3 ${setup.dir} — ${sig}`;
}

function futuresHeatChip(item) {
  const { row: r, setup } = item;
  const signed = setup.dir === 'bullish' ? setup.count : -setup.count;   // +2/+3 or -2/-3
  return `<button type="button" class="fx-chip" style="${fxCurrencyHeat(signed, FUTURES_HEAT_MAX)}" onclick="openScreenerMarket('${r.key}')" title="${esc(futuresHeatTitle(r, setup))}">${esc(r.display_name)} <b>${setup.count}/3</b></button>`;
}

function futuresHeatColumn(kind, title, items) {
  const tone = kind === 'long' ? 'bull' : 'bear';
  return `<div class="fx-bias-col ${tone}">
    <div class="fx-bias-head">
      <div class="fx-bias-title ${kind}">${title}</div>
      <div class="fx-bias-count">${items.length || 0}</div>
    </div>
    <div class="fx-bias-list">
      ${items.length ? items.map(futuresHeatChip).join('') : '<span class="fx-bias-empty">No 3/3 setup today</span>'}
    </div>
  </div>`;
}

function renderFuturesHeat() {
  const el = document.getElementById('futuresHeatSection');
  if (!el) return;
  if (!Array.isArray(screenerData) || !screenerData.length) { el.hidden = true; el.innerHTML = ''; return; }

  // Only full 3/3 aligned setups; 2/3 partials and everything weaker are dropped.
  const setups = screenerData
    .filter(r => r && r.category !== FUTURES_HEAT_EXCLUDE_CATEGORY)
    .map(r => ({ row: r, setup: screenerSetup(r) }))
    .filter(item => item.setup && item.setup.count === 3);

  const byStrength = (a, b) => b.setup.count - a.setup.count || a.row.display_name.localeCompare(b.row.display_name);
  const bullish = setups.filter(s => s.setup.dir === 'bullish').sort(byStrength);
  const bearish = setups.filter(s => s.setup.dir === 'bearish').sort(byStrength);

  el.hidden = false;
  el.innerHTML = `
    <div class="fx-head">
      <div class="fx-title">Futures Strength</div>
      <div class="fx-note">Only full 3/3 setups · Seasonals + COT-Hedging + Term Structure aligned · click a market to load its chart</div>
    </div>
    <div class="fx-bias-board">
      ${futuresHeatColumn('long', 'Bullish / Long Bias', bullish)}
      ${futuresHeatColumn('short', 'Bearish / Short Bias', bearish)}
    </div>`;
}

