const SMT_STATE_KEY = "charthorizon.smt.v1";
const SMT_RANGES = [[365, '1Y'], [730, '2Y'], [1825, '5Y']];
// Ordered by category popularity (CATEGORY_POPULARITY): most-followed left.
const SMT_PRESETS = [
  ['es_sp500', 'nq_nasdaq', 'ym_dow'],   // Indices
  ['bitcoin', 'ethereum', 'usdx'],       // Crypto
  ['gold', 'silver', 'usdx'],            // Metals
  ['wti_crude', 'brent_crude', 'usdx'],  // Energy
  ['eur_fx', 'gbp_fx', 'usdx'],          // Currencies (majors)
  ['aud_fx', 'nzd_fx', 'usdx'],          // Currencies (minors)
  ['corn', 'wheat', 'soybeans'],         // Agriculture
  ['zb_tbond', 'zn_10y', 'zt_2y'],       // Bonds
  ['cocoa', 'coffee', 'usdx'],           // Softs
];
const SMT_SHORT = {
  es_sp500: 'ES', nq_nasdaq: 'NQ', ym_dow: 'YM',
  gold: 'Gold', silver: 'Silver', usdx: 'USDX',
  wti_crude: 'Crude', brent_crude: 'Brent',
  eur_fx: 'EUR', gbp_fx: 'GBP', aud_fx: 'AUD', nzd_fx: 'NZD',
  corn: 'Corn', wheat: 'Wheat', soybeans: 'Soybeans',
  bitcoin: 'BTC', ethereum: 'ETH',
  zb_tbond: '30Y', zn_10y: '10Y', zt_2y: '2Y',
  cocoa: 'Cocoa', coffee: 'Coffee',
};
function smtShort(k) { return SMT_SHORT[k] || (INDEX[k] && INDEX[k].display_name) || k; }
function smtInstrumentType(key) {
  const meta = INDEX[key];
  const cfg = meta && (catCache[meta.slug] || {})[key];
  const fmt = cfg && cfg.continuous_contract && cfg.continuous_contract.format;
  return fmt === 'dxy_index_proxy' ? 'Index' : 'Futures';
}
let smtState = { a: 'gold', b: 'silver', c: 'usdx', range: 365, interval: 'daily', contractMode: 'continuous' };
let smtSeq = 0;          // guards against out-of-order async renders

// ── Trend-line annotations: drawn into each chart's SVG (so the PNG export
// captures them for free), anchored to (date, price) so they survive timeframe
// and market switches. Keyed by market so a market keeps its lines in either slot.
const SMT_LINES_KEY = "charthorizon.smtLines.v1";
let smtDraw = false;                  // draw-mode toggle (transient, not persisted)
let smtLines = loadSmtLines();        // { marketKey: [ {a:{t,p}, b:{t,p}}, ... ] }

function loadSmtLines() {
  try {
    const v = JSON.parse(localStorage.getItem(SMT_LINES_KEY) || '{}');
    return (v && typeof v === 'object') ? v : {};
  } catch (e) { return {}; }
}
function saveSmtLines() {
  try { localStorage.setItem(SMT_LINES_KEY, JSON.stringify(smtLines)); } catch (e) {}
}
function smtLinesFor(key) { return (key && smtLines[key]) || []; }

function loadSmtState() {
  try {
    const s = JSON.parse(localStorage.getItem(SMT_STATE_KEY) || 'null');
    if (s && typeof s === 'object') {
      if (INDEX[s.a]) smtState.a = s.a;
      if (INDEX[s.b]) smtState.b = s.b;
      if (INDEX[s.c]) smtState.c = s.c;
      if (SMT_RANGES.some(r => r[0] === s.range)) smtState.range = s.range;
      if (s.interval === 'daily' || s.interval === 'weekly') smtState.interval = s.interval;
      if (s.contractMode === 'continuous' || s.contractMode === 'frontMonth') smtState.contractMode = s.contractMode;
    }
  } catch (e) {}
  // Final guard: if a stored market vanished, fall back to the first preset whose legs both exist.
  if (!INDEX[smtState.a] || !INDEX[smtState.b] || !INDEX[smtState.c]) {
    const ok = SMT_PRESETS.find(([a, b, c]) => INDEX[a] && INDEX[b] && INDEX[c]);
    if (ok) { smtState.a = ok[0]; smtState.b = ok[1]; smtState.c = ok[2]; }
  }
}
function saveSmtState() {
  try { localStorage.setItem(SMT_STATE_KEY, JSON.stringify(smtState)); } catch (e) {}
}

function smtMarketOptions(selected) {
  const byCat = {};
  for (const key in INDEX) {
    const m = INDEX[key];
    (byCat[m.category] = byCat[m.category] || []).push([key, m.display_name]);
  }
  let html = '';
  for (const cat of Object.keys(byCat).sort()) {
    html += `<optgroup label="${esc(cat)}">`;
    for (const [key, name] of byCat[cat].sort((x, y) => x[1].localeCompare(y[1]))) {
      html += `<option value="${esc(key)}"${key === selected ? ' selected' : ''}>${esc(name)}</option>`;
    }
    html += '</optgroup>';
  }
  return html;
}

function renderSmtControls() {
  const presets = document.getElementById('smtPresets');
  if (presets) {
    presets.innerHTML = SMT_PRESETS
      .filter(([a, b, c]) => INDEX[a] && INDEX[b] && INDEX[c])
      .map(([a, b, c]) => {
        const active = (a === smtState.a && b === smtState.b && c === smtState.c) ? ' active' : '';
        const label = `${smtShort(a)} / ${smtShort(b)} / ${smtShort(c)}`;
        return `<button class="smt-chip${active}" type="button" onclick="setSmtPreset('${a}','${b}','${c}')">${esc(label)}</button>`;
      }).join('');
  }
  const selA = document.getElementById('smtSelA');
  const selB = document.getElementById('smtSelB');
  const selC = document.getElementById('smtSelC');
  if (selA) selA.innerHTML = smtMarketOptions(smtState.a);
  if (selB) selB.innerHTML = smtMarketOptions(smtState.b);
  if (selC) selC.innerHTML = smtMarketOptions(smtState.c);
  const bar = document.getElementById('smtRangeBar');
  if (bar) {
    bar.innerHTML = SMT_RANGES.map(([d, label]) =>
      `<button class="fx-timeframe-btn${smtState.range === d ? ' active' : ''}" type="button" onclick="setSmtRange(${d})">${label}</button>`
    ).join('');
  }
  const ibar = document.getElementById('smtIntervalBar');
  if (ibar) {
    ibar.innerHTML = [['daily', 'Daily'], ['weekly', 'Weekly']].map(([v, label]) =>
      `<button class="fx-timeframe-btn${smtState.interval === v ? ' active' : ''}" type="button" onclick="setSmtInterval('${v}')">${label}</button>`
    ).join('');
  }
  const cbar = document.getElementById('smtContractModeBar');
  if (cbar) {
    cbar.innerHTML = [['continuous', 'Continuous'], ['frontMonth', 'Front Month']].map(([v, label]) =>
      `<button class="fx-timeframe-btn${smtState.contractMode === v ? ' active' : ''}" type="button" onclick="setSmtContractMode('${v}')" title="${v === 'frontMonth' ? 'Show the current front-month contract in all 3 charts' : 'Show the native continuous series'}">${label}</button>`
    ).join('');
  }
  const dtog = document.getElementById('smtDrawToggle');
  if (dtog) {
    dtog.classList.toggle('active', smtDraw);
    dtog.textContent = smtDraw ? '✏ Trendline: On' : '✏ Trendline: Off';
  }
}

function setSmtPreset(a, b, c) { if (!INDEX[a] || !INDEX[b] || !INDEX[c]) return; smtState.a = a; smtState.b = b; smtState.c = c; saveSmtState(); renderSmtControls(); renderSmtCharts(); }
function setSmtMarket(slot, val) { if (!INDEX[val] || !['a', 'b', 'c'].includes(slot)) return; smtState[slot] = val; saveSmtState(); renderSmtControls(); renderSmtCharts(); }
function setSmtRange(d) { smtState.range = d; saveSmtState(); renderSmtControls(); renderSmtCharts(); }
function setSmtInterval(v) {
  if (v !== 'daily' && v !== 'weekly') return;
  smtState.interval = v;
  saveSmtState();
  renderSmtControls();
  renderSmtCharts();
}
function setSmtContractMode(v) {
  if (v !== 'continuous' && v !== 'frontMonth') return;
  smtState.contractMode = v;
  saveSmtState();
  renderSmtControls();
  renderSmtCharts();
}
function toggleSmtDraw() {
  smtDraw = !smtDraw;
  renderSmtControls();
  const host = document.getElementById('smtCharts');
  if (host) host.classList.toggle('smt-drawing', smtDraw);
}
function clearSmtLines() {
  delete smtLines[smtState.a];
  delete smtLines[smtState.b];
  delete smtLines[smtState.c];
  saveSmtLines();
  renderSmtCharts();
}

async function openSmt() {
  loadSmtState();
  renderSmtControls();
  await renderSmtCharts();
}

async function smtLoadBars(key) {
  const meta = INDEX[key];
  if (!meta) return [];
  const catData = await loadCategory(meta.slug);
  const cfg = catData && catData[key];
  if (!cfg) return [];
  if (smtState.contractMode === 'frontMonth') return smtLoadFrontContractBars(cfg);
  return getContinuousContract(cfg).history || [];
}

// Front-month mode: load the current front contract's own daily history (lazy
// /api/contract-history fetch, cached on the contract). Falls back to the native
// continuous when there is no tradable front contract (e.g. the USDX proxy).
async function smtLoadFrontContractBars(cfg) {
  const front = (cfg.contracts || []).find(c => c && c.available && c.yf_symbol)
    || (cfg.contracts || [])[0];
  if (!front || !front.yf_symbol) return getContinuousContract(cfg).history || [];
  if (front.chart_history && front.chart_history.length) return front.chart_history;
  try {
    const url = `/api/contract-history?symbol=${encodeURIComponent(front.yf_symbol)}&period=${CONTRACT_HISTORY_PERIOD}`;
    const res = await fetch(url);
    const payload = await res.json();
    if (res.ok && Array.isArray(payload.history) && payload.history.length) {
      front.chart_history = payload.history;
      return payload.history;
    }
  } catch (e) {}
  return getContinuousContract(cfg).history || [];
}

function smtFilterRange(bars, days) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  const cut = cutoff.getTime();
  return bars.filter(b => { const t = new Date(b.date).getTime(); return !isNaN(t) && t >= cut; });
}

// Aggregate daily bars into weekly OHLC (grouped by ISO Monday; dated on the
// last trading day of the week, like the main chart's weekly view).
function smtToWeekly(bars) {
  const byWeek = new Map();
  for (const b of bars) {
    const d = new Date(b.date);
    if (isNaN(d)) continue;
    const dow = (d.getUTCDay() + 6) % 7;   // 0 = Monday
    const mon = new Date(d);
    mon.setUTCDate(d.getUTCDate() - dow);
    const key = mon.toISOString().slice(0, 10);
    const w = byWeek.get(key);
    if (!w) {
      byWeek.set(key, { date: b.date, open: +b.open, high: +b.high, low: +b.low, close: +b.close, volume: +b.volume || 0 });
    } else {
      w.high = Math.max(w.high, +b.high);
      w.low = Math.min(w.low, +b.low);
      w.close = +b.close;
      w.date = b.date;
      w.volume += +b.volume || 0;
    }
  }
  return Array.from(byWeek.values());
}

function smtFmtPrice(p) {
  const a = Math.abs(p);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 1 ? 2 : 4;
  return p.toFixed(dp);
}

// Candlesticks in the same visual style as the Futures-tab chart: CHART_THEME
// bull/bear bodies + softer wicks, the light chart background, round-level price
// gridlines, and YY-MM-DD date labels in Sora. Shared calendar-time domain keeps
// both charts aligned by date for the synced crosshair.
function smtRoundLevelStep(span) {
  const raw = span / 5;
  if (!(raw > 0)) return span || 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const candidates = [1, 2, 2.5, 5, 10].map(m => m * mag);
  let step = candidates[0];
  for (const c of candidates) { if (span / c <= 7) { step = c; break; } }
  return step || raw || 1;
}

function renderSmtChart(bars, opts) {
  const W = Math.max(360, Math.round(opts.width || 900));
  const H = Math.max(200, Math.round(opts.height || 260));
  const padL = 12, padR = 58, padT = 12, padB = 24;
  const plotW = W - padL - padR, priceH = H - padT - padB;
  const [d0, d1] = opts.domain;
  const span = Math.max(1, d1 - d0);
  const xAt = t => padL + plotW * ((t - d0) / span);
  const lows = bars.map(b => Number(b.low));
  const highs = bars.map(b => Number(b.high));
  const pMin = Math.min(...lows), pMax = Math.max(...highs);
  const pRng = (pMax - pMin) || 1;
  const padP = pRng * 0.05;
  const pLo = pMin - padP, pHi = pMax + padP, pSpan = (pHi - pLo) || 1;
  const yAt = p => padT + (1 - (p - pLo) / pSpan) * priceH;
  const slot = plotW / Math.max(1, bars.length);
  // Candles are placed by calendar time (the 3 charts share one date->x domain so the
  // crosshair lines up by date), so weekday runs sit closer than the average slot.
  // Size the body from the SMALLEST real gap between adjacent bars — and never wider
  // than that gap — so dense clusters never overlap; cap at 12px (Futures parity).
  const sortedT = bars.map(b => new Date(b.date).getTime()).filter(t => !isNaN(t)).sort((a, b) => a - b);
  let minGap = Infinity;
  for (let i = 1; i < sortedT.length; i++) {
    const g = xAt(sortedT[i]) - xAt(sortedT[i - 1]);
    if (g > 0.01 && g < minGap) minGap = g;
  }
  if (!isFinite(minGap)) minGap = slot;
  const candleW = Math.min(12, Math.min(minGap * 0.85, Math.max(1, minGap * 0.7)));

  let candles = '';
  for (const b of bars) {
    const t = new Date(b.date).getTime();
    if (isNaN(t)) continue;
    const x = xAt(t);
    const o = Number(b.open), c = Number(b.close), h = Number(b.high), l = Number(b.low);
    const up = c >= o;
    const col = up ? CHART_THEME.bull : CHART_THEME.bear;
    const wickCol = up ? CHART_THEME.bullWick : CHART_THEME.bearWick;
    const yH = yAt(h).toFixed(1), yL = yAt(l).toFixed(1), yO = yAt(o), yC = yAt(c);
    const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yC - yO));
    candles += `<line x1="${x.toFixed(1)}" y1="${yH}" x2="${x.toFixed(1)}" y2="${yL}" stroke="${wickCol}" stroke-width="1"/>`;
    candles += `<rect x="${(x - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${col}" stroke="${col}" stroke-width="0.5"/>`;
  }

  // Round-level price gridlines + right-edge price labels (Futures style)
  const step = smtRoundLevelStep(pSpan);
  const first = Math.ceil(pLo / step) * step;
  let grid = '';
  for (let lv = first; lv <= pHi; lv += step) {
    lv = Math.round(lv / step) * step;
    if (lv < pLo || lv > pHi) continue;
    const y = yAt(lv).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${(W - padR).toFixed(1)}" y2="${y}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="2,4" opacity="0.78"/>`;
    grid += `<text x="${(W - padR + 5)}" y="${(+y + 3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${smtFmtPrice(lv)}</text>`;
  }

  let dlabels = '';
  for (let g = 0; g <= 5; g++) {
    const t = d0 + span * (g / 5);
    const x = xAt(t), dt = new Date(t);
    const iso = isNaN(dt) ? '' : dt.toISOString().slice(2, 10);
    dlabels += `<text x="${x.toFixed(1)}" y="${H - 6}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora" text-anchor="middle">${iso}</text>`;
  }

  // Quarter boundaries (Jan/Apr/Jul/Oct 1, UTC) as subtle vertical separators + labels
  let qLines = '', qLabels = '';
  {
    const sd = new Date(d0);
    let qy = sd.getUTCFullYear(), qm = Math.floor(sd.getUTCMonth() / 3) * 3;
    let qt = Date.UTC(qy, qm, 1);
    while (qt < d0) { qm += 3; if (qm > 9) { qm -= 12; qy++; } qt = Date.UTC(qy, qm, 1); }
    while (qt <= d1) {
      const x = xAt(qt), qn = Math.floor(qm / 3) + 1;
      qLines += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + priceH).toFixed(1)}" stroke="${CHART_THEME.grid}" stroke-width="1" opacity="0.85"/>`;
      qLabels += `<text x="${(x + 3).toFixed(1)}" y="${(padT + 11)}" font-size="9" font-weight="600" fill="${CHART_THEME.text}" font-family="Sora" opacity="0.55">Q${qn} '${String(qy).slice(2)}</text>`;
      qm += 3; if (qm > 9) { qm -= 12; qy++; } qt = Date.UTC(qy, qm, 1);
    }
  }

  // User trend-line annotations for this market, projected from (date, price).
  let trend = '';
  const tlines = smtLinesFor(opts.key);
  for (let li = 0; li < tlines.length; li++) {
    const ln = tlines[li];
    trend += `<line class="smt-trend" data-i="${li}" x1="${xAt(ln.a.t).toFixed(1)}" y1="${yAt(ln.a.p).toFixed(1)}" x2="${xAt(ln.b.t).toFixed(1)}" y2="${yAt(ln.b.p).toFixed(1)}" stroke="#4338ca" stroke-width="1.6" stroke-linecap="round"/>`;
  }

  return `<svg class="smt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet" data-key="${opts.key || ''}" data-d0="${d0}" data-d1="${d1}" data-padl="${padL}" data-plotw="${plotW}" data-plo="${pLo}" data-phi="${pHi}" data-padt="${padT}" data-ploth="${priceH}">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="${CHART_THEME.bg}" rx="7"/>`
    + grid + qLines
    + `<g shape-rendering="crispEdges">${candles}</g>`
    + qLabels + dlabels + trend
    + `<line class="smt-cross-v" x1="0" y1="${padT}" x2="0" y2="${(padT + priceH).toFixed(1)}" stroke="#334155" stroke-width="1" stroke-dasharray="2,4" opacity="0" pointer-events="none"/>`
    + `<line class="smt-cross-h" x1="${padL}" y1="0" x2="${(W - padR).toFixed(1)}" y2="0" stroke="#64748b" stroke-width="1" stroke-dasharray="2,4" opacity="0" pointer-events="none"/>`
    + `<g class="smt-cross-date" opacity="0" pointer-events="none">`
    + `<rect class="smt-cross-date-bg" x="0" y="${(H - 15).toFixed(1)}" width="66" height="13" rx="3" fill="#0f172a"/>`
    + `<text class="smt-cross-date-tx" x="0" y="${(H - 5).toFixed(1)}" font-size="9.5" font-family="Sora" fill="#ffffff" text-anchor="middle"></text>`
    + `</g>`
    + `</svg>`;
}

function smtChartSlot(key, bars, domain, width, height) {
  const m = INDEX[key] || {};
  const title = esc(m.display_name || key);
  const intervalLabel = smtState.interval === 'weekly' ? 'Weekly' : 'Daily';
  const rangeLabel = (SMT_RANGES.find(r => r[0] === smtState.range) || [0, ''])[1];
  const modeLabel = smtState.contractMode === 'frontMonth' ? 'Front Month' : 'Continuous';
  const head = `<div class="smt-chart-title">${title} <span class="smt-chart-meta">${smtInstrumentType(key)} · ${modeLabel} · ${intervalLabel} · ${rangeLabel}</span></div>`;
  if (!bars.length || !domain) {
    return `<div class="smt-chart-slot">${head}<div class="smt-empty">No history for this market and window.</div></div>`;
  }
  return `<div class="smt-chart-slot">${head}${renderSmtChart(bars, { domain, width, height, key })}</div>`;
}

// Crosshair: the vertical guide is synced across BOTH charts (same date); the
// horizontal guide shows only on the chart you're hovering, since the two have
// different price scales. Both SVGs share the date→x domain, so one x-fraction
// maps to the same calendar date in each.
function bindSmtCrosshair() {
  const host = document.getElementById('smtCharts');
  if (!host) return;
  const svgs = Array.from(host.querySelectorAll('.smt-svg'));
  if (!svgs.length) return;
  const clamp = v => Math.max(0, Math.min(1, v));
  const move = (ev) => {
    const svg = ev.currentTarget;
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const fracX = clamp((ev.clientX - rect.left) / rect.width);
    const fracY = clamp((ev.clientY - rect.top) / rect.height);
    for (const s of svgs) {
      const vb = s.viewBox && s.viewBox.baseVal;
      const w = (vb && vb.width) || rect.width;
      const h = (vb && vb.height) || rect.height;
      const vline = s.querySelector('.smt-cross-v');
      if (vline) {
        const x = (fracX * w).toFixed(1);
        vline.setAttribute('x1', x); vline.setAttribute('x2', x); vline.setAttribute('opacity', '0.65');
      }
      const hline = s.querySelector('.smt-cross-h');
      if (hline) {
        if (s === svg) {
          const y = (fracY * h).toFixed(1);
          hline.setAttribute('y1', y); hline.setAttribute('y2', y); hline.setAttribute('opacity', '0.65');
        } else {
          hline.setAttribute('opacity', '0');
        }
      }
      // Date readout at the crosshair x (same calendar date on both charts).
      const lbl = s.querySelector('.smt-cross-date');
      const d0 = parseFloat(s.dataset.d0), d1 = parseFloat(s.dataset.d1);
      const padL = parseFloat(s.dataset.padl), plotw = parseFloat(s.dataset.plotw);
      if (lbl && isFinite(d0) && isFinite(d1) && plotw > 0) {
        const xv = fracX * w;
        const f = clamp((xv - padL) / plotw);
        let iso = '';
        try { iso = new Date(d0 + f * (d1 - d0)).toISOString().slice(0, 10); } catch (e) {}
        const tx = lbl.querySelector('.smt-cross-date-tx');
        const bg = lbl.querySelector('.smt-cross-date-bg');
        const lw = 66;
        const cx = Math.min(w - 6 - lw / 2, Math.max(padL + lw / 2, xv));
        if (tx) { tx.setAttribute('x', cx.toFixed(1)); tx.textContent = iso; }
        if (bg) { bg.setAttribute('x', (cx - lw / 2).toFixed(1)); }
        lbl.setAttribute('opacity', '1');
      }
    }
    // In draw mode, highlight the trend line under the pointer so it is clear
    // which single line a click will delete.
    const hov = ev.currentTarget;
    if (smtDraw && hov) {
      const pt = smtSvgPoint(hov, ev.clientX, ev.clientY);
      let hot = -1;
      if (pt) {
        const lines = smtLinesFor(hov.dataset.key);
        let bestD = 12;
        for (let i = 0; i < lines.length; i++) {
          const pr = smtProjLine(pt, lines[i]);
          const dd = smtPointSegDist(pt.vbx, pt.vby, pr.x1, pr.y1, pr.x2, pr.y2);
          if (dd < bestD) { bestD = dd; hot = i; }
        }
      }
      hov.querySelectorAll('.smt-trend').forEach(el => el.classList.toggle('smt-trend-hot', hot >= 0 && +el.dataset.i === hot));
      hov.style.cursor = hot >= 0 ? 'pointer' : '';
    }
  };
  const leave = () => {
    for (const s of svgs) {
      const v = s.querySelector('.smt-cross-v'); if (v) v.setAttribute('opacity', '0');
      const hh = s.querySelector('.smt-cross-h'); if (hh) hh.setAttribute('opacity', '0');
      const ld = s.querySelector('.smt-cross-date'); if (ld) ld.setAttribute('opacity', '0');
      s.querySelectorAll('.smt-trend-hot').forEach(el => el.classList.remove('smt-trend-hot'));
      s.style.cursor = '';
    }
  };
  for (const s of svgs) {
    s.addEventListener('mousemove', move);
    s.addEventListener('mouseleave', leave);
  }
}

async function renderSmtCharts() {
  const host = document.getElementById('smtCharts');
  if (!host) return;
  const seq = ++smtSeq;
  host.innerHTML = '<div class="smt-empty">Loading charts…</div>';
  const keys = [smtState.a, smtState.b, smtState.c];
  const all = await Promise.all(keys.map(k => smtLoadBars(k)));
  if (seq !== smtSeq) return;   // a newer render started — drop this stale one
  const days = smtState.range;
  let barsList = all.map(a => smtFilterRange(a, days));
  if (smtState.interval === 'weekly') barsList = barsList.map(smtToWeekly);
  const times = barsList.flat().map(b => new Date(b.date).getTime()).filter(t => !isNaN(t));
  const domain = times.length ? [Math.min(...times), Math.max(...times)] : null;
  const chartW = Math.max(360, Math.round((host.clientWidth || 900) - 30));   // slot content box: -28 padding -2 border (border-box) => 1:1 px
  const chartH = Math.max(200, Math.min(320, Math.round(chartW * 0.24)));
  host.innerHTML = keys.map((k, i) => smtChartSlot(k, barsList[i], domain, chartW, chartH)).join('');
  host.classList.toggle('smt-drawing', smtDraw);
  bindSmtCrosshair();
  bindSmtDraw();
}

// ── Trend-line drawing + paired PNG export (Macro Shift) ──
// Convert a mouse point to this SVG's viewBox px and to (date, price) via the
// scale data-attributes that renderSmtChart stamps on the SVG.
function smtSvgPoint(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const W = (vb && vb.width) || rect.width, H = (vb && vb.height) || rect.height;
  const vbx = (clientX - rect.left) / rect.width * W;
  const vby = (clientY - rect.top) / rect.height * H;
  const d = svg.dataset;
  const d0 = +d.d0, d1 = +d.d1, padL = +d.padl, plotw = +d.plotw;
  const plo = +d.plo, phi = +d.phi, padT = +d.padt, ploth = +d.ploth;
  if (![d0, d1, padL, plotw, plo, phi, padT, ploth].every(Number.isFinite) || plotw <= 0 || ploth <= 0) return null;
  const t = d0 + ((vbx - padL) / plotw) * (d1 - d0);
  const p = plo + (1 - (vby - padT) / ploth) * (phi - plo);
  return { vbx, vby, t, p, padL, plotw, padT, ploth, d0, d1, plo, phi };
}

function smtProjLine(pt, ln) {
  return {
    x1: pt.padL + ((ln.a.t - pt.d0) / (pt.d1 - pt.d0)) * pt.plotw,
    x2: pt.padL + ((ln.b.t - pt.d0) / (pt.d1 - pt.d0)) * pt.plotw,
    y1: pt.padT + (1 - (ln.a.p - pt.plo) / (pt.phi - pt.plo)) * pt.ploth,
    y2: pt.padT + (1 - (ln.b.p - pt.plo) / (pt.phi - pt.plo)) * pt.ploth,
  };
}
function smtPointSegDist(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1, len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - x1) * dx + (py - y1) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// Drag to draw a trend line; a near-stationary click deletes the nearest line.
function bindSmtDraw() {
  const host = document.getElementById('smtCharts');
  if (!host) return;
  const NS = 'http://www.w3.org/2000/svg';
  for (const svg of Array.from(host.querySelectorAll('.smt-svg'))) {
    let start = null, preview = null;
    const moveDoc = (ev) => {
      if (!start || !preview) return;
      const pt = smtSvgPoint(svg, ev.clientX, ev.clientY);
      if (!pt) return;
      preview.setAttribute('x2', pt.vbx.toFixed(1));
      preview.setAttribute('y2', pt.vby.toFixed(1));
    };
    const up = (ev) => {
      window.removeEventListener('mousemove', moveDoc);
      window.removeEventListener('mouseup', up);
      const end = smtSvgPoint(svg, ev.clientX, ev.clientY) || start;
      if (preview) { preview.remove(); preview = null; }
      const s = start; start = null;
      const key = svg.dataset.key;
      if (!s || !end || !key) return;
      if (Math.hypot(end.vbx - s.vbx, end.vby - s.vby) >= 6) {
        (smtLines[key] = smtLines[key] || []).push({ a: { t: s.t, p: s.p }, b: { t: end.t, p: end.p } });
        saveSmtLines();
        renderSmtCharts();
      } else {
        const lines = smtLines[key] || [];
        let best = -1, bestD = 12;
        for (let i = 0; i < lines.length; i++) {
          const pr = smtProjLine(s, lines[i]);
          const dd = smtPointSegDist(s.vbx, s.vby, pr.x1, pr.y1, pr.x2, pr.y2);
          if (dd < bestD) { bestD = dd; best = i; }
        }
        if (best >= 0) { lines.splice(best, 1); saveSmtLines(); renderSmtCharts(); }
      }
    };
    svg.addEventListener('mousedown', (ev) => {
      if (!smtDraw) return;
      const pt = smtSvgPoint(svg, ev.clientX, ev.clientY);
      if (!pt) return;
      ev.preventDefault();
      start = pt;
      preview = document.createElementNS(NS, 'line');
      preview.setAttribute('class', 'smt-trend smt-trend-preview');
      preview.setAttribute('x1', pt.vbx.toFixed(1)); preview.setAttribute('y1', pt.vby.toFixed(1));
      preview.setAttribute('x2', pt.vbx.toFixed(1)); preview.setAttribute('y2', pt.vby.toFixed(1));
      preview.setAttribute('stroke', '#4338ca'); preview.setAttribute('stroke-width', '1.6');
      svg.appendChild(preview);
      window.addEventListener('mousemove', moveDoc);
      window.addEventListener('mouseup', up);
    });
  }
}

function smtExportContext() {
  const a = INDEX[smtState.a] || {}, b = INDEX[smtState.b] || {}, c = INDEX[smtState.c] || {};
  return {
    kind: 'smt',
    category: 'MACRO SHIFT',
    name: `${a.display_name || smtState.a} · ${b.display_name || smtState.b} · ${c.display_name || smtState.c}`,
    symbol: 'Cross-asset divergence',
    asOf: null,
  };
}

// Compose both charts (with their trend lines) into one stacked PNG canvas.
function smtSvgToCanvas(targetWidth) {
  const host = document.getElementById('smtCharts');
  const svgs = host ? Array.from(host.querySelectorAll('.smt-svg')) : [];
  if (!svgs.length) throw new Error('No charts to export');
  const titleH = CHART_EXPORT_TITLE_H, labelH = 22, gap = 18;
  const dims = svgs.map(s => {
    const vb = (s.getAttribute('viewBox') || '0 0 1000 280').split(/\s+/).map(Number);
    return { w: vb[2] || 1000, h: vb[3] || 280 };
  });
  const w = Math.max(...dims.map(d => d.w));
  let totalH = titleH;
  for (const d of dims) totalH += labelH + d.h + gap;
  const scale = (targetWidth || CHART_EXPORT_WIDTH) / w;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(w * scale);
  canvas.height = Math.round(totalH * scale);
  const cx = canvas.getContext('2d');
  cx.setTransform(scale, 0, 0, scale, 0, 0);
  cx.fillStyle = '#ffffff';
  cx.fillRect(0, 0, w, totalH);
  drawExportHeader(cx, w, smtExportContext());
  // Hide the interactive crosshair/date overlays for the export, then restore.
  const stashed = [];
  for (const s of svgs) {
    s.querySelectorAll('.smt-cross-v, .smt-cross-h, .smt-cross-date, .smt-trend-preview').forEach(el => {
      stashed.push([el, el.style.display]); el.style.display = 'none';
    });
  }
  try {
    let y = titleH;
    for (let i = 0; i < svgs.length; i++) {
      const key = svgs[i].dataset.key;
      const name = (INDEX[key] && INDEX[key].display_name) || key || '';
      const meta = `${smtInstrumentType(key)} · ${smtState.contractMode === 'frontMonth' ? 'Front Month' : 'Continuous'} · ${smtState.interval === 'weekly' ? 'Weekly' : 'Daily'} · ${(SMT_RANGES.find(r => r[0] === smtState.range) || [0, ''])[1]}`;
      cx.save();
      cx.fillStyle = '#0f172a';
      cx.font = '600 13px Sora, system-ui, sans-serif';
      cx.textAlign = 'left';
      cx.fillText(`${name}  —  ${meta}`, 12, y + 15);
      cx.restore();
      cx.save();
      cx.translate(0, y + labelH);
      drawSvgNode(cx, svgs[i]);
      cx.restore();
      y += labelH + dims[i].h + gap;
    }
  } finally {
    stashed.forEach(([el, d]) => { el.style.display = d; });
  }
  cx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

async function smtPngBlob() {
  const canvas = smtSvgToCanvas(CHART_EXPORT_WIDTH);
  return await new Promise((res, rej) =>
    canvas.toBlob(b => b ? res(b) : rej(new Error('PNG encode failed')), 'image/png'));
}
function smtExportName() {
  const a = INDEX[smtState.a] || {}, b = INDEX[smtState.b] || {}, c = INDEX[smtState.c] || {};
  const nm = `${a.display_name || smtState.a}_${b.display_name || smtState.b}_${c.display_name || smtState.c}`.replace(/[^A-Za-z0-9]+/g, '_');
  return `ChartHorizon_MacroShift_${nm}_${new Date().toISOString().slice(0, 10)}.png`;
}
function setSmtBtnStatus(btnId, text, restore) {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.textContent = text;
  btn.classList.add('copied');
  setTimeout(() => { btn.textContent = restore; btn.classList.remove('copied'); }, 2400);
}

async function downloadSmtCharts() {
  try { triggerDownload(await smtPngBlob(), smtExportName()); }
  catch (e) { console.error('Macro Shift export failed:', e); alert('Export failed: ' + e.message); }
}

async function shareSmtCharts() {
  let blob;
  try { blob = await smtPngBlob(); }
  catch (e) { console.error('Macro Shift share failed:', e); alert('Export failed: ' + e.message); return; }
  const file = new File([blob], smtExportName(), { type: 'image/png' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try { await navigator.share({ files: [file] }); return; }
    catch (e) { if (e && e.name === 'AbortError') return; }
  }
  if (navigator.clipboard && window.ClipboardItem) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); setSmtBtnStatus('smtShareBtn', 'Copied!', 'Share'); return; }
    catch (e) {}
  }
  triggerDownload(blob, smtExportName());
  setSmtBtnStatus('smtShareBtn', 'Downloaded', 'Share');
}

// X's web intent can't attach an image, so copy the PNG to the clipboard first
// and open the compose window — the user pastes it into the post with Cmd/Ctrl+V.
async function shareSmtToX() {
  const text = `${smtExportContext().name} · ChartHorizon`;
  const intentUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;
  let copied = false;
  try {
    const blob = await smtPngBlob();
    if (navigator.clipboard && window.ClipboardItem) { await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]); copied = true; }
  } catch (e) {}
  const win = window.open(intentUrl, '_blank');
  if (!win) { setSmtBtnStatus('smtXBtn', 'Allow popups', 'X'); return; }
  setSmtBtnStatus('smtXBtn', copied ? 'Copied · paste in X' : 'Opened X', 'X');
}

// ── Cross-asset correlation calculator (Tools tab): Pearson correlation of daily
// returns; contract-roll jumps are excluded so they are not read as real moves. ──
