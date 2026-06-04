const PSIZE_ACCT_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'AUD', 'CAD', 'NZD'];
let psizeAcct = 'USD';
let psizePair = 'EUR|USD';
let toolsCalendarLoaded = false;

function psizeFmt(n, dec) {
  return Number.isFinite(n) ? fmtNum(n, dec) : '–';   // reuse the shared en-US formatter
}

// Latest date on which every supplied currency-in-USD map has a positive close, so
// the account/base/quote rates are read from one consistent day (not mixed dates).
// maps: array of (date->close map), or null for the USD sentinel (constant 1).
function fxCommonLatestDate(maps) {
  const real = maps.filter(Boolean);
  if (!real.length) return null;
  let smallest = real[0];
  for (const m of real) if (Object.keys(m).length < Object.keys(smallest).length) smallest = m;
  let best = null;
  for (const d in smallest) {
    if (real.every(m => m[d] > 0) && (!best || d > best)) best = d;
  }
  return best;
}

async function renderPositionSize() {
  const resEl = document.getElementById('psizeResult');
  if (!resEl) return;
  const acctSel = document.getElementById('psizeAcct'), pairSel = document.getElementById('psizePair');
  if (acctSel && !acctSel.options.length) acctSel.innerHTML = PSIZE_ACCT_CURRENCIES.map(c => `<option value="${c}"${c === psizeAcct ? ' selected' : ''}>${c}</option>`).join('');
  if (pairSel && !pairSel.options.length) pairSel.innerHTML = FX_PAIR_ORDER.map(([b, q]) => { const v = `${b}|${q}`; return `<option value="${v}"${v === psizePair ? ' selected' : ''}>${b}/${q}</option>`; }).join('');
  if (acctSel) psizeAcct = acctSel.value;
  if (pairSel) psizePair = pairSel.value;
  const balance = parseFloat((document.getElementById('psizeBalance') || {}).value);
  const riskPct = parseFloat((document.getElementById('psizeRisk') || {}).value);
  const stopPips = parseFloat((document.getElementById('psizeStop') || {}).value);
  if (!(balance > 0) || !(riskPct > 0) || !(stopPips > 0)) {
    resEl.innerHTML = '<div class="screener-empty">Enter a positive balance, risk %, and stop-loss to calculate.</div>';
    return;
  }
  if (riskPct > 100) {
    resEl.innerHTML = '<div class="screener-empty">Risk % must be between 0 and 100 - you cannot risk more than the whole account.</div>';
    return;
  }
  const cat = await loadCategory('currencies');
  if (!cat) { resEl.innerHTML = '<div class="screener-empty">Currency data unavailable.</div>'; return; }
  const [base, quote] = psizePair.split('|');
  // Resolve all three currencies on one common date so the displayed rate is internally consistent.
  const acctMap = fxCurInUsd(psizeAcct, cat), quoteMap = fxCurInUsd(quote, cat), baseMap = fxCurInUsd(base, cat);
  const day = fxCommonLatestDate([acctMap, quoteMap, baseMap]);
  const rateAt = map => map ? (day ? map[day] : 0) : 1;   // null map = USD sentinel (= 1)
  const acctUsd = rateAt(acctMap), quoteUsd = rateAt(quoteMap), baseUsd = rateAt(baseMap);
  if (!(acctUsd > 0) || !(quoteUsd > 0) || !(baseUsd > 0)) { resEl.innerHTML = '<div class="screener-empty">Conversion rate unavailable for this pair.</div>'; return; }
  const pipSize = quote === 'JPY' ? 0.01 : 0.0001;
  const quoteToAcct = quoteUsd / acctUsd;    // 1 unit of quote currency in account currency
  const baseToAcct = baseUsd / acctUsd;
  const riskAmount = balance * riskPct / 100;
  const units = riskAmount / (stopPips * pipSize * quoteToAcct);
  const lots = units / 100000;
  const pipValuePerLot = pipSize * 100000 * quoteToAcct;
  const notional = units * baseToAcct;
  const cells = [
    ['Position size', `${psizeFmt(lots, 2)} lots`, `${psizeFmt(units, 0)} units · ${psizeFmt(units / 10000, 2)} mini · ${psizeFmt(units / 1000, 2)} micro`, true],
    ['Risk amount', `${psizeFmt(riskAmount, 2)} ${psizeAcct}`, `${psizeFmt(riskPct, 2)}% of ${psizeFmt(balance, 2)} ${psizeAcct}`, false],
    ['Pip value / lot', `${psizeFmt(pipValuePerLot, 2)} ${psizeAcct}`, 'per standard lot (100k units)', false],
    ['Notional value', `${psizeFmt(notional, 0)} ${psizeAcct}`, `${base}/${quote} at end-of-day rate`, false],
  ];
  resEl.innerHTML = cells.map(([k, v, sub, primary]) => `<div class="psize-cell${primary ? ' primary' : ''}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="sub">${esc(sub)}</div></div>`).join('');
}

function loadToolsCalendar() {
  const host = document.getElementById('toolsCalendar');
  if (!host || toolsCalendarLoaded) return;
  toolsCalendarLoaded = true;
  const container = document.createElement('div');
  container.className = 'tradingview-widget-container';
  const slot = document.createElement('div');
  slot.className = 'tradingview-widget-container__widget';
  container.appendChild(slot);
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.async = true;
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-events.js';
  // The TradingView events embed reads its config from the script's own text.
  script.textContent = JSON.stringify({
    colorTheme: (typeof currentTheme === 'function' && currentTheme() === 'dark') ? 'dark' : 'light',
    isTransparent: false,
    width: '100%',
    height: 600,
    locale: 'en',
    importanceFilter: '0,1',
    countryFilter: 'us,eu,gb,jp,ch,au,ca,nz',
  });
  container.appendChild(script);
  host.appendChild(container);
}

// The embed bakes colorTheme at load, so a theme switch needs a full rebuild.
function reloadToolsCalendar() {
  const host = document.getElementById('toolsCalendar');
  if (!host) return;
  host.innerHTML = '';
  toolsCalendarLoaded = false;
  loadToolsCalendar();
}

function openTools() {
  loadToolsCalendar();
  renderFxCalc();
}

