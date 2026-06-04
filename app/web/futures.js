async function fetchContractHistory(contract) {
  if ((contract.chart_history || []).length) return contract.chart_history;
  if (!contract.yf_symbol) throw new Error('No Yahoo symbol is available for this contract.');

  const url = `/api/contract-history?symbol=${encodeURIComponent(contract.yf_symbol)}&period=${CONTRACT_HISTORY_PERIOD}`;
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

async function activateSelectedContract(cfg) {
  const idx = (cfg.contracts || []).findIndex(c => c.yf_symbol === chartState.contractSymbol);
  if (idx < 0) {
    chartState.chartMode = 'continuous';
    loadChart(cfg);
    renderTable(cfg);
    return;
  }
  await selectCurveContract(idx);
}

async function selectCurveContract(index, fallbackToContinuous = false) {
  const cfg = getCurrentCfg();
  if (!cfg || !cfg.contracts || !cfg.contracts[index]) return;

  const contract = cfg.contracts[index];
  chartState.chartMode = 'contract';
  chartState.contractSymbol = contract.yf_symbol;
  chartState.contractLabel = contract.contract_symbol || contract.delivery_month_label || contract.label || contract.yf_symbol;
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
}

function renderTable(cfg) {
  const dec = cfg.tick_decimals;
  document.getElementById('curveBody').innerHTML = cfg.contracts.map((c,i) => {
    const price = fmtNum(c.last, dec);
    const chg = fmtNum(c.change, dec);
    const pct = c.change_pct;
    const up = (pct ?? 0) >= 0;
    const vol = fmtInt(c.volume);
    const oi = fmtInt(c.open_interest);
    const fb = i === 0 ? '<span class="front-badge">FRONT</span>' : '';
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
  // Default chart = the front-month single contract (row 0 = FRONT). Falls back to
  // the continuous series if its history can't be fetched (e.g. no local API server).
  const frontIdx = (cfg.contracts || []).findIndex(c => c && c.yf_symbol);
  if (frontIdx >= 0) {
    await selectCurveContract(frontIdx, true);
  } else {
    loadChart(cfg);
    renderTable(cfg);
  }
}

