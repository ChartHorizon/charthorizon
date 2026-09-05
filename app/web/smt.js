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

// Per-market ACTUAL contract mode after loading. Front-Month silently falls back to the
// native continuous when a leg has no tradable front contract (e.g. the USDX proxy) or the
// fetch fails; the label must reflect what was actually drawn, not just the toggle, so the
// on-screen chart and the PNG export are not mislabeled. Set during smtLoadBars, which is
// awaited before the slot/label renders.
let smtActualMode = {};   // marketKey -> 'frontMonth' | 'continuous'
function smtModeLabel(key) {
  if (smtState.contractMode !== 'frontMonth') return 'Continuous';
  if (smtActualMode[key] === 'continuous') return 'Continuous (no front month)';
  const front = smtFrontContract(smtCfg(key));
  const code = front && (front.contract_symbol || front.yf_symbol);
  return code ? `Front Month · ${code}` : 'Front Month';
}

// The market's config as already loaded (pure read, never fetches).
function smtCfg(key) {
  const meta = INDEX[key];
  if (!meta) return null;
  const cat = (typeof catCache === 'object') ? catCache[meta.slug] : null;
  return (cat && cat[key]) || null;
}

// The front month is the LEAD contract by volume — the same definition the Futures tab
// badges (frontContractIndex) and the calendar-spread pane uses. Taking contracts[0]
// (nearest expiry) instead put Macro Shift on the dying month whenever liquidity had
// already rolled forward: corn in August traded Dec (409k lots) while Sep (193k) was
// drawn; gold was worse (GCZ26 186k vs GCQ26 478).
function smtFrontContract(cfg) {
  const cs = (cfg && cfg.contracts) || [];
  const idx = frontContractIndex(cs);
  return (idx >= 0 ? cs[idx] : null) || cs.find(c => c && c.available && c.yf_symbol) || cs[0] || null;
}

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

function setSmtPreset(a, b, c) { if (!INDEX[a] || !INDEX[b] || !INDEX[c]) return; smtState.a = a; smtState.b = b; smtState.c = c; saveSmtState(); renderSmtControls(); renderSmtCharts(); if (typeof restartLiveLayer === 'function') restartLiveLayer(); }
function setSmtMarket(slot, val) { if (!INDEX[val] || !['a', 'b', 'c'].includes(slot)) return; smtState[slot] = val; saveSmtState(); renderSmtControls(); renderSmtCharts(); if (typeof restartLiveLayer === 'function') restartLiveLayer(); }
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
  if (typeof restartLiveLayer === 'function') restartLiveLayer();
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
  if (typeof restartLiveLayer === 'function') restartLiveLayer();
}

async function smtLoadBars(key) {
  const meta = INDEX[key];
  if (!meta) return [];
  const catData = await loadCategory(meta.slug);
  const cfg = catData && catData[key];
  if (!cfg) return [];
  if (smtState.contractMode === 'frontMonth') return smtLoadFrontContractBars(cfg, key);
  smtActualMode[key] = 'continuous';
  return getContinuousContract(cfg).history || [];
}

// Front-month mode: load the current front contract's own daily history (lazy
// /api/contract-history fetch, cached on the contract). Falls back to the native
// continuous when there is no tradable front contract (e.g. the USDX proxy).
async function smtLoadFrontContractBars(cfg, key) {
  const markFront = () => { if (key) smtActualMode[key] = 'frontMonth'; };
  const markFallback = () => { if (key) smtActualMode[key] = 'continuous'; };
  const front = smtFrontContract(cfg);
  if (!front || !front.yf_symbol) { markFallback(); return getContinuousContract(cfg).history || []; }
  if (front.chart_history && front.chart_history.length) { markFront(); return front.chart_history; }
  try {
    const url = `/api/contract-history?symbol=${encodeURIComponent(front.yf_symbol)}&period=${CONTRACT_HISTORY_PERIOD}`;
    const res = await fetch(url);
    const payload = await res.json();
    if (res.ok && Array.isArray(payload.history) && payload.history.length) {
      front.chart_history = payload.history;
      markFront();
      return payload.history;
    }
  } catch (e) {}
  markFallback();
  return getContinuousContract(cfg).history || [];
}

// The yfinance symbol currently shown for `key` in Macro Shift: the front contract in
// front-month mode (mirrors smtLoadFrontContractBars), else the native continuous.
function smtActiveSymbol(key) {
  const cfg = smtCfg(key);
  if (!cfg) return null;
  if (smtState.contractMode === 'frontMonth' && smtActualMode[key] !== 'continuous') {
    const front = smtFrontContract(cfg);
    if (front && front.yf_symbol) return front.yf_symbol;
  }
  const cont = getContinuousContract(cfg);
  return cont.yf_symbol || cont.tv_symbol || null;
}

// Display-only live overlay for one SMT chart's bars (copy; never the persisted series;
// never in card-mode or weekly mode). `liveQuotes` is owned by live.js.
function smtInjectLivePoint(bars, key) {
  if (!bars || !bars.length) return bars;
  if (document.body.classList.contains('card-mode')) return bars;
  if (smtState.interval === 'weekly') return bars;
  if (typeof liveQuotes !== 'object' || !liveQuotes) return bars;
  const sym = smtActiveSymbol(key);
  const lp = sym && liveQuotes[sym];
  if (!lp || !Number.isFinite(lp.price) || !lp.day) return bars;
  const out = bars.slice();
  // Real live candle from the still-forming bar's intraday OHLC (shared with chart.js);
  // falls back to a flat point when Yahoo omits open/high/low.
  const pt = { date: lp.day, ...liveBarOHLC(lp), volume: null, __live: true };
  const last = out[out.length - 1];
  if (last && String(last.date).slice(0, 10) === String(lp.day).slice(0, 10)) out[out.length - 1] = pt;
  else out.push(pt);
  return out;
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
// gridlines, and YY-MM-DD date labels in Geist. Shared calendar-time domain keeps
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

// Shared ORDINAL x-axis: candles are packed one-per-trading-day (like the Futures
// tab) instead of placed by raw calendar time, so weekends/holidays don't punch
// empty bands into the series. The axis is the sorted UNION of all bar dates across
// the 3 charts, so a given slot still maps to the same calendar date in every chart
// — the synced crosshair and the (date, price)-anchored trend lines keep working.
const SMT_PADL = 12, SMT_PADR = 58, SMT_PADT = 12, SMT_PADB = 24;
let smtAxis = null;   // { times:[ms…], idx:Map<ms,i>, n, padL, plotW, slot }

function smtBuildAxis(barsList, plotW) {
  const set = new Set();
  for (const bars of barsList) for (const b of bars) {
    const t = new Date(b.date).getTime();
    if (!isNaN(t)) set.add(t);
  }
  const times = Array.from(set).sort((a, b) => a - b);
  const idx = new Map();
  times.forEach((t, i) => idx.set(t, i));
  const n = Math.max(1, times.length);
  return { times, idx, n, padL: SMT_PADL, plotW, slot: plotW / n };
}
function smtXAtFrac(ax, frac) { return ax.padL + ax.slot * (frac + 0.5); }
// Continuous ordinal position of a timestamp within the union — interpolated between
// neighbours for dates that fall between/outside bars (e.g. a weekend trend anchor).
function smtFracAtTime(ax, t) {
  const ts = ax.times;
  if (!ts.length) return 0;
  if (t <= ts[0]) return 0;
  if (t >= ts[ts.length - 1]) return ts.length - 1;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
  return lo + (t - ts[lo]) / ((ts[hi] - ts[lo]) || 1);
}
function smtXAtTime(ax, t) { return smtXAtFrac(ax, smtFracAtTime(ax, t)); }
// Inverse maps for crosshair date readout + draw-mode anchoring.
function smtTimeAtFrac(ax, frac) {
  const ts = ax.times;
  if (!ts.length) return NaN;
  const f = Math.max(0, Math.min(ts.length - 1, frac));
  const lo = Math.floor(f), hi = Math.min(ts.length - 1, lo + 1);
  return ts[lo] + (ts[hi] - ts[lo]) * (f - lo);
}
function smtTimeAtX(ax, x) { return smtTimeAtFrac(ax, (x - ax.padL) / ax.slot - 0.5); }

function renderSmtChart(bars, opts) {
  const W = Math.max(360, Math.round(opts.width || 900));
  const H = Math.max(200, Math.round(opts.height || 260));
  const padL = SMT_PADL, padR = SMT_PADR, padT = SMT_PADT, padB = SMT_PADB;
  const plotW = W - padL - padR, priceH = H - padT - padB;
  const ax = opts.axis || smtAxis || smtBuildAxis([bars], plotW);
  const lows = bars.map(b => Number(b.low));
  const highs = bars.map(b => Number(b.high));
  const pMin = Math.min(...lows), pMax = Math.max(...highs);
  const pRng = (pMax - pMin) || 1;
  const padP = pRng * 0.05;
  const pLo = pMin - padP, pHi = pMax + padP, pSpan = (pHi - pLo) || 1;
  const yAt = p => padT + (1 - (p - pLo) / pSpan) * priceH;
  // Ordinal placement: candle bodies fill one slot per the chart layout's width
  // setting (Futures-tab parity), max 12px.
  const candleW = Math.max(1, Math.min(12, ax.slot * candleWidthFactor()));

  // Bodies go through candlePaint() (core.js) like the Futures tab: a preset may
  // separate up from down by the hollow body alone rather than by colour
  // ("Black on White" paints both black), so reading CHART_THEME.bull/bear here
  // and filling unconditionally rendered every candle as one solid mass.
  const plotted = [];
  for (const b of bars) {
    const t = new Date(b.date).getTime();
    if (isNaN(t)) continue;
    const i = ax.idx.get(t);
    if (i === undefined) continue;
    plotted.push({ x: smtXAtFrac(ax, i), o: Number(b.open), c: Number(b.close), h: Number(b.high), l: Number(b.low) });
  }
  // 'line' replaces the bodies with a close-only polyline — drawn outside the
  // crispEdges group below (see candlesCrisp), which would alias its diagonals.
  const candleLine = CHART_STYLE.candle === 'line'
    ? candleLinePath(plotted.map(d => ({ x: d.x, y: yAt(d.c) }))) : '';
  let candles = '';
  if (!candleLine) {
    for (const d of plotted) {
      const up = d.c >= d.o;
      const { fill, stroke, strokeW, wick, wickW } = candlePaint(up);
      const yH = yAt(d.h), yL = yAt(d.l);
      const bodyTop = Math.min(yAt(d.o), yAt(d.c)), bodyBot = Math.max(yAt(d.o), yAt(d.c));
      const bodyH = Math.max(1, bodyBot - bodyTop);
      // Two guarded wick segments, never one high→low line: a hollow body is
      // transparent and a full-length wick would run straight through it.
      if (yH < bodyTop) candles += `<line x1="${d.x.toFixed(1)}" y1="${yH.toFixed(1)}" x2="${d.x.toFixed(1)}" y2="${bodyTop.toFixed(1)}" stroke="${wick}" stroke-width="${wickW}"/>`;
      if (bodyBot < yL) candles += `<line x1="${d.x.toFixed(1)}" y1="${bodyBot.toFixed(1)}" x2="${d.x.toFixed(1)}" y2="${yL.toFixed(1)}" stroke="${wick}" stroke-width="${wickW}"/>`;
      candles += `<rect x="${(d.x - candleW / 2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeW}"/>`;
    }
  }

  // Live tick marker (display-only): pulsing hollow dot on the provisional last point.
  let liveDot = '';
  const _lb = bars[bars.length - 1];
  if (_lb && _lb.__live) {
    const _t = new Date(_lb.date).getTime();
    const _i = ax.idx.get(_t);
    if (_i !== undefined) {
      const _x = smtXAtFrac(ax, _i).toFixed(1);
      const _y = yAt(Number(_lb.close)).toFixed(1);
      liveDot =
        `<circle class="smt-live-dot" cx="${_x}" cy="${_y}" r="3" fill="none" stroke="${CHART_THEME.bull}" stroke-width="1.5">` +
        `<animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite"/>` +
        `<animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite"/></circle>`;
    }
  }

  // Current-price line + price tag RIGHT-ALIGNED to the axis (parity with the Futures tab):
  // right edge fixed at the border, the tag grows leftwards -> long numbers are never
  // clipped. Subtle, theme-aware; price = the last bar (live tick when present, otherwise
  // the last close). `curY` is used below to drop a colliding round-level label.
  let priceLine = '';
  let curY = null;
  if (_lb && Number.isFinite(Number(_lb.close))) {
    const cp = Number(_lb.close);
    const cy = yAt(cp);
    if (Number.isFinite(cy)) {
      curY = cy;
      const tagY = Math.max(padT + 8, Math.min(padT + priceH - 8, cy));
      const txt = smtFmtPrice(cp);
      const tagW = Math.max(34, String(txt).length * 6.2 + 10);
      const tagX = W - 2 - tagW;
      priceLine =
        `<line class="smt-price-line" x1="${padL}" y1="${cy.toFixed(1)}" x2="${tagX.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="5,4"/>` +
        `<g class="smt-price-line">` +
        `<rect x="${tagX.toFixed(1)}" y="${(tagY - 8).toFixed(1)}" width="${tagW.toFixed(1)}" height="16" rx="2.5" fill="${CHART_THEME.bg}" stroke="${CHART_THEME.axis}" stroke-width="1"/>` +
        `<text x="${(tagX + tagW / 2).toFixed(1)}" y="${(tagY + 3.5).toFixed(1)}" font-size="10" font-weight="600" text-anchor="middle" fill="${CHART_THEME.text}" font-family="Geist">${txt}</text>` +
        `</g>`;
    }
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
    // Drop the label when it collides with the current-price tag at the same height.
    // Right-aligned (text-anchor=end) so long numbers are not clipped at the border.
    if (!(curY != null && Math.abs(+y - curY) < 9))
      grid += `<text x="${(W - 4)}" y="${(+y + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="${CHART_THEME.text}" font-family="Geist">${smtFmtPrice(lv)}</text>`;
  }

  let dlabels = '';
  for (let g = 0; g <= 5; g++) {
    const frac = (ax.n - 1) * (g / 5);
    const x = smtXAtFrac(ax, frac);
    const t = smtTimeAtFrac(ax, frac);
    const iso = isNaN(t) ? '' : new Date(t).toISOString().slice(2, 10);
    dlabels += `<text x="${x.toFixed(1)}" y="${H - 6}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist" text-anchor="middle">${iso}</text>`;
  }

  // Quarter boundaries (Jan/Apr/Jul/Oct 1, UTC) as subtle vertical separators + labels,
  // snapped onto the ordinal axis (interpolated to the nearest trading-day slot).
  let qLines = '', qLabels = '';
  if (ax.times.length) {
    const d0 = ax.times[0], d1 = ax.times[ax.times.length - 1];
    const sd = new Date(d0);
    let qy = sd.getUTCFullYear(), qm = Math.floor(sd.getUTCMonth() / 3) * 3;
    let qt = Date.UTC(qy, qm, 1);
    while (qt < d0) { qm += 3; if (qm > 9) { qm -= 12; qy++; } qt = Date.UTC(qy, qm, 1); }
    while (qt <= d1) {
      const x = smtXAtTime(ax, qt), qn = Math.floor(qm / 3) + 1;
      qLines += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + priceH).toFixed(1)}" stroke="${CHART_THEME.grid}" stroke-width="1" opacity="0.85"/>`;
      qLabels += `<text x="${(x + 3).toFixed(1)}" y="${(padT + 11)}" font-size="9" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" opacity="0.55">Q${qn} '${String(qy).slice(2)}</text>`;
      qm += 3; if (qm > 9) { qm -= 12; qy++; } qt = Date.UTC(qy, qm, 1);
    }
  }

  // User trend-line annotations for this market, projected from (date, price).
  let trend = '';
  const tlines = smtLinesFor(opts.key);
  for (let li = 0; li < tlines.length; li++) {
    const ln = tlines[li];
    trend += `<line class="smt-trend" data-i="${li}" x1="${smtXAtTime(ax, ln.a.t).toFixed(1)}" y1="${yAt(ln.a.p).toFixed(1)}" x2="${smtXAtTime(ax, ln.b.t).toFixed(1)}" y2="${yAt(ln.b.p).toFixed(1)}" stroke="${CHART_THEME.trend}" stroke-width="1.6" stroke-linecap="round"/>`;
  }

  return `<svg class="smt-svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet" data-key="${opts.key || ''}" data-plo="${pLo}" data-phi="${pHi}" data-padt="${padT}" data-ploth="${priceH}">`
    + `<rect x="0" y="0" width="${W}" height="${H}" fill="${CHART_THEME.bg}" rx="7"/>`
    + grid + qLines
    + `<g shape-rendering="crispEdges">${candles}</g>` + candleLine + priceLine + liveDot
    + qLabels + dlabels + trend
    + `<line class="smt-cross-v" x1="0" y1="${padT}" x2="0" y2="${(padT + priceH).toFixed(1)}" stroke="#334155" stroke-width="1" stroke-dasharray="2,4" opacity="0" pointer-events="none"/>`
    + `<line class="smt-cross-h" x1="${padL}" y1="0" x2="${(W - padR).toFixed(1)}" y2="0" stroke="#64748b" stroke-width="1" stroke-dasharray="2,4" opacity="0" pointer-events="none"/>`
    + `<g class="smt-cross-date" opacity="0" pointer-events="none">`
    + `<rect class="smt-cross-date-bg" x="0" y="${(H - 15).toFixed(1)}" width="66" height="13" rx="3" fill="#0f172a"/>`
    + `<text class="smt-cross-date-tx" x="0" y="${(H - 5).toFixed(1)}" font-size="9.5" font-family="Geist" fill="#ffffff" text-anchor="middle"></text>`
    + `</g>`
    + `</svg>`;
}

function smtChartSlot(key, bars, domain, width, height, axis) {
  const m = INDEX[key] || {};
  const title = esc(m.display_name || key);
  const intervalLabel = smtState.interval === 'weekly' ? 'Weekly' : 'Daily';
  const rangeLabel = (SMT_RANGES.find(r => r[0] === smtState.range) || [0, ''])[1];
  const modeLabel = smtModeLabel(key);
  const head = `<div class="smt-chart-title">${title} <span class="smt-chart-meta">${smtInstrumentType(key)} · ${modeLabel} · ${intervalLabel} · ${rangeLabel}</span></div>`;
  if (!bars.length || !domain) {
    return `<div class="smt-chart-slot">${head}<div class="smt-empty">No history for this market and window.</div></div>`;
  }
  return `<div class="smt-chart-slot">${head}${renderSmtChart(bars, { width, height, key, axis })}</div>`;
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
      // Date readout at the crosshair x (same calendar date on both charts, via the
      // shared ordinal axis — the vertical guide is the same x-fraction everywhere).
      const lbl = s.querySelector('.smt-cross-date');
      if (lbl && smtAxis) {
        const xv = fracX * w;
        let iso = '';
        try { iso = new Date(smtTimeAtX(smtAxis, xv)).toISOString().slice(0, 10); } catch (e) {}
        const tx = lbl.querySelector('.smt-cross-date-tx');
        const bg = lbl.querySelector('.smt-cross-date-bg');
        const lw = 66;
        const cx = Math.min(w - 6 - lw / 2, Math.max(SMT_PADL + lw / 2, xv));
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
  barsList = barsList.map((b, i) => smtInjectLivePoint(b, keys[i]));
  const times = barsList.flat().map(b => new Date(b.date).getTime()).filter(t => !isNaN(t));
  const domain = times.length ? [Math.min(...times), Math.max(...times)] : null;
  const chartW = Math.max(360, Math.round((host.clientWidth || 900) - 30));   // slot content box: -28 padding -2 border (border-box) => 1:1 px
  const chartH = Math.max(200, Math.min(320, Math.round(chartW * 0.24)));
  smtAxis = smtBuildAxis(barsList, chartW - SMT_PADL - SMT_PADR);   // one shared ordinal axis for all 3 charts
  host.innerHTML = keys.map((k, i) => smtChartSlot(k, barsList[i], domain, chartW, chartH, smtAxis)).join('');
  host.classList.toggle('smt-drawing', smtDraw);
  bindSmtCrosshair();
  bindSmtDraw();
}

// ── Trend-line drawing + paired PNG export (Macro Shift) ──
// Convert a mouse point to this SVG's viewBox px and to (date, price) via the
// scale data-attributes that renderSmtChart stamps on the SVG.
function smtSvgPoint(svg, clientX, clientY) {
  const rect = svg.getBoundingClientRect();
  if (!rect.width || !rect.height || !smtAxis) return null;
  const vb = svg.viewBox && svg.viewBox.baseVal;
  const W = (vb && vb.width) || rect.width, H = (vb && vb.height) || rect.height;
  const vbx = (clientX - rect.left) / rect.width * W;
  const vby = (clientY - rect.top) / rect.height * H;
  const d = svg.dataset;
  const plo = +d.plo, phi = +d.phi, padT = +d.padt, ploth = +d.ploth;
  if (![plo, phi, padT, ploth].every(Number.isFinite) || ploth <= 0) return null;
  // x maps through the shared ordinal axis; y is this chart's own price scale.
  const t = smtTimeAtX(smtAxis, vbx);
  const p = plo + (1 - (vby - padT) / ploth) * (phi - plo);
  return { vbx, vby, t, p, padT, ploth, plo, phi };
}

function smtProjLine(pt, ln) {
  return {
    x1: smtXAtTime(smtAxis, ln.a.t),
    x2: smtXAtTime(smtAxis, ln.b.t),
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
      preview.setAttribute('stroke', CHART_THEME.trend); preview.setAttribute('stroke-width', '1.6');
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
  // Canvas ground + per-chart labels come from the shared export palette, not literals:
  // the SVG panes are painted with CHART_THEME.bg, so a hardcoded white left the header
  // band, the label strips and the gaps light in dark mode (title unreadable on white).
  const pal = exportPalette();
  cx.fillStyle = pal.bg;
  cx.fillRect(0, 0, w, totalH);
  drawExportHeader(cx, w, smtExportContext());
  // Hide the interactive crosshair/date overlays for the export, then restore.
  const stashed = [];
  for (const s of svgs) {
    s.querySelectorAll('.smt-cross-v, .smt-cross-h, .smt-cross-date, .smt-trend-preview, .smt-live-dot').forEach(el => {
      stashed.push([el, el.style.display]); el.style.display = 'none';
    });
  }
  try {
    let y = titleH;
    for (let i = 0; i < svgs.length; i++) {
      const key = svgs[i].dataset.key;
      const name = (INDEX[key] && INDEX[key].display_name) || key || '';
      const meta = `${smtInstrumentType(key)} · ${smtModeLabel(key)} · ${smtState.interval === 'weekly' ? 'Weekly' : 'Daily'} · ${(SMT_RANGES.find(r => r[0] === smtState.range) || [0, ''])[1]}`;
      cx.save();
      cx.fillStyle = pal.name;
      cx.font = '600 13px Geist, system-ui, sans-serif';
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

// X attaches no image via URL, so copy the PNG to the clipboard and the user pastes it
// into the post with Cmd/Ctrl+V. Open the FULL composer (`/compose/post`), NOT the web
// intent (`/intent/post`): the intent dialog accepts no media at all, so it silently
// swallowed the paste and posted text only. Same `?text=` prefill on both routes.
// The write must be ISSUED inside the click gesture — Safari/WebKit rejects a write made
// after `await` — so hand ClipboardItem a Promise<Blob> instead of awaiting the blob
// first (Chrome/Firefox accept this too).
async function shareSmtToX() {
  const text = `${smtExportContext().name} · ChartHorizon`;
  const composeUrl = `https://x.com/compose/post?text=${encodeURIComponent(text)}`;
  let copied = false;
  if (navigator.clipboard && window.ClipboardItem) {
    try { await navigator.clipboard.write([new ClipboardItem({ 'image/png': smtPngBlob() })]); copied = true; }
    catch (e) {}
  }
  const win = window.open(composeUrl, '_blank');
  if (!win) { setSmtBtnStatus('smtXBtn', 'Allow popups', 'X'); return; }
  setSmtBtnStatus('smtXBtn', copied ? 'Copied · paste in X' : 'Opened X', 'X');
}

// ── Cross-asset correlation calculator (Tools tab): Pearson correlation of daily
// returns; contract-roll jumps are excluded so they are not read as real moves. ──
