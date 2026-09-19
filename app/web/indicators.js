// indicators.js — client-side technical-indicator math for the Charts tab.
//
// Pure functions: NO DOM, NO data mutation. Every compute returns arrays aligned
// 1:1 to `bars` (null for warm-up bars, which simply aren't drawn). Loaded BEFORE
// chart.js (it calls computeIndicator/INDICATOR_DEFS) and before bigchart.js (the
// add-menu UI). Indicators are a pure presentation layer — they are derived from the
// OHLCV already in the browser and are never written back to JSON / SQLite.
//
// Two kinds: `overlay` (drawn in the price pane: SMA/EMA/Bollinger) and `pane`
// (own stacked oscillator sub-pane: RSI/Stochastic/MACD/ATR).

const INDICATOR_DEFS = {
  sma:   { kind: 'overlay', label: 'SMA',   color: '#2962ff', defaults: { period: 20, source: 'close' } },
  ema:   { kind: 'overlay', label: 'EMA',   color: '#ff6d00', defaults: { period: 21, source: 'close' } },
  bb:    { kind: 'overlay', label: 'BB',    color: '#7e57c2', defaults: { period: 20, mult: 2, source: 'close' } },
  rsi:   { kind: 'pane',    label: 'RSI',   color: '#7e57c2', defaults: { period: 14 } },
  stoch: { kind: 'pane',    label: 'Stoch', color: '#2962ff', defaults: { k: 14, d: 3, smooth: 3 } },
  macd:  { kind: 'pane',    label: 'MACD',  color: '#2962ff', defaults: { fast: 12, slow: 26, signal: 9 } },
  atr:   { kind: 'pane',    label: 'ATR',   color: '#26a69a', defaults: { period: 14 } },
};

// The +Indicators add-menu groups (bigchart.js renders this).
const INDICATOR_MENU = [
  { group: 'Overlays', items: ['sma', 'ema', 'bb'] },
  { group: 'Oscillators', items: ['rsi', 'stoch', 'macd', 'atr'] },
];

// Editable fields per type for the settings popover (bigchart.js renders these).
// kind: 'int' (positive integer), 'num' (float), 'source' (price-source dropdown).
const INDICATOR_FIELDS = {
  sma:   [{ key: 'period', label: 'Period', kind: 'int' }, { key: 'source', label: 'Source', kind: 'source' }],
  ema:   [{ key: 'period', label: 'Period', kind: 'int' }, { key: 'source', label: 'Source', kind: 'source' }],
  bb:    [{ key: 'period', label: 'Period', kind: 'int' }, { key: 'mult', label: 'StdDev', kind: 'num' }, { key: 'source', label: 'Source', kind: 'source' }],
  rsi:   [{ key: 'period', label: 'Period', kind: 'int' }],
  stoch: [{ key: 'k', label: '%K', kind: 'int' }, { key: 'smooth', label: 'Smooth', kind: 'int' }, { key: 'd', label: '%D', kind: 'int' }],
  macd:  [{ key: 'fast', label: 'Fast', kind: 'int' }, { key: 'slow', label: 'Slow', kind: 'int' }, { key: 'signal', label: 'Signal', kind: 'int' }],
  atr:   [{ key: 'period', label: 'Period', kind: 'int' }],
};

const INDICATOR_SOURCES = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4'];

function indicatorDefaults(type) {
  const d = INDICATOR_DEFS[type];
  return d ? Object.assign({}, d.defaults) : {};
}
// Merge an instance's saved params over the type defaults (so older saved configs
// missing a newer field still get a sane value).
function indicatorParams(ind) {
  return Object.assign(indicatorDefaults(ind.type), ind.params || {});
}
function indicatorColor(ind) {
  return ind.color || (INDICATOR_DEFS[ind.type] && INDICATOR_DEFS[ind.type].color) || '#888888';
}
// Compact chip / heading label, e.g. "SMA 20", "BB 20,2", "MACD 12,26,9".
function indicatorChipLabel(ind) {
  const def = INDICATOR_DEFS[ind.type];
  if (!def) return ind.type;
  const p = indicatorParams(ind);
  switch (ind.type) {
    case 'sma': case 'ema': case 'rsi': case 'atr': return `${def.label} ${p.period}`;
    case 'bb': return `BB ${p.period},${p.mult}`;
    case 'stoch': return `Stoch ${p.k},${p.d}`;
    case 'macd': return `MACD ${p.fast},${p.slow},${p.signal}`;
  }
  return def.label;
}

// ── source price selector ──
function _indSrcVal(b, source) {
  switch (source) {
    case 'open': return b.open;
    case 'high': return b.high;
    case 'low': return b.low;
    case 'hl2': return (b.high + b.low) / 2;
    case 'hlc3': return (b.high + b.low + b.close) / 3;
    case 'ohlc4': return (b.open + b.high + b.low + b.close) / 4;
    default: return b.close;
  }
}
function _indSrcSeries(bars, source) {
  return bars.map(b => { const v = _indSrcVal(b, source); return Number.isFinite(v) ? v : null; });
}

// ── primitive series math (input: (number|null)[], output aligned, null for warm-up
// or any window that contains a non-finite value) ──
function _indSMA(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (period < 1) return out;
  for (let i = period - 1; i < vals.length; i++) {
    let sum = 0, ok = true;
    for (let j = i - period + 1; j <= i; j++) { const v = vals[j]; if (!Number.isFinite(v)) { ok = false; break; } sum += v; }
    if (ok) out[i] = sum / period;
  }
  return out;
}
// EMA seeded with the SMA of the first `period` finite values; resets across gaps.
function _indEMA(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (period < 1) return out;
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!Number.isFinite(v)) { prev = null; continue; }
    if (prev === null) {
      if (i >= period - 1) {
        let sum = 0, ok = true;
        for (let j = i - period + 1; j <= i; j++) { if (!Number.isFinite(vals[j])) { ok = false; break; } sum += vals[j]; }
        if (ok) { prev = sum / period; out[i] = prev; }
      }
    } else {
      prev = v * k + prev * (1 - k);
      out[i] = prev;
    }
  }
  return out;
}
// Wilder's smoothing (RMA) — RSI / ATR.
function _indRMA(vals, period) {
  const out = new Array(vals.length).fill(null);
  if (period < 1) return out;
  let prev = null;
  for (let i = 0; i < vals.length; i++) {
    const v = vals[i];
    if (!Number.isFinite(v)) { continue; }
    if (prev === null) {
      if (i >= period - 1) {
        let sum = 0, ok = true;
        for (let j = i - period + 1; j <= i; j++) { if (!Number.isFinite(vals[j])) { ok = false; break; } sum += vals[j]; }
        if (ok) { prev = sum / period; out[i] = prev; }
      }
    } else {
      prev = (prev * (period - 1) + v) / period;
      out[i] = prev;
    }
  }
  return out;
}

// computeIndicator(ind, bars) → normalized draw spec.
//   overlay: { kind:'overlay', lines:[{values,color,width,dash?,opacity?}], band?:{upper,lower,color},
//             legend:[{label,color,values}] }
//   pane:    { kind:'pane', domain?:[lo,hi], zero?:bool, refs:[{value,label}],
//             series:[{values,color?,width?,kind:'line'|'hist',up?,down?}],
//             legend:[{label,color,values}], dec?:int }
function computeIndicator(ind, bars) {
  const p = indicatorParams(ind);
  const color = indicatorColor(ind);
  const label = indicatorChipLabel(ind);
  switch (ind.type) {
    case 'sma': {
      const vals = _indSMA(_indSrcSeries(bars, p.source), p.period);
      return { kind: 'overlay', lines: [{ values: vals, color, width: 1.4 }], legend: [{ label, color, values: vals }] };
    }
    case 'ema': {
      const vals = _indEMA(_indSrcSeries(bars, p.source), p.period);
      return { kind: 'overlay', lines: [{ values: vals, color, width: 1.4 }], legend: [{ label, color, values: vals }] };
    }
    case 'bb': {
      const src = _indSrcSeries(bars, p.source);
      const mid = _indSMA(src, p.period);
      const upper = new Array(bars.length).fill(null), lower = new Array(bars.length).fill(null);
      for (let i = p.period - 1; i < bars.length; i++) {
        if (!Number.isFinite(mid[i])) continue;
        let sq = 0, ok = true;
        for (let j = i - p.period + 1; j <= i; j++) { const v = src[j]; if (!Number.isFinite(v)) { ok = false; break; } const d = v - mid[i]; sq += d * d; }
        if (!ok) continue;
        const sd = Math.sqrt(sq / p.period);
        upper[i] = mid[i] + p.mult * sd;
        lower[i] = mid[i] - p.mult * sd;
      }
      return {
        kind: 'overlay',
        lines: [
          { values: upper, color, width: 1 },
          { values: lower, color, width: 1 },
          { values: mid, color, width: 1, dash: '4,3', opacity: 0.85 },
        ],
        band: { upper, lower, color },
        legend: [{ label, color, values: mid }],
      };
    }
    case 'rsi': {
      const closes = bars.map(b => b.close);
      const gains = new Array(bars.length).fill(null), losses = new Array(bars.length).fill(null);
      for (let i = 1; i < bars.length; i++) {
        const ch = closes[i] - closes[i - 1];
        if (!Number.isFinite(ch)) continue;
        gains[i] = Math.max(0, ch);
        losses[i] = Math.max(0, -ch);
      }
      const ag = _indRMA(gains, p.period), al = _indRMA(losses, p.period);
      const rsi = bars.map((_, i) => {
        if (!Number.isFinite(ag[i]) || !Number.isFinite(al[i])) return null;
        if (al[i] === 0) return 100;
        const rs = ag[i] / al[i];
        return 100 - 100 / (1 + rs);
      });
      return {
        kind: 'pane', domain: [0, 100], refs: [{ value: 70, label: '70' }, { value: 30, label: '30' }],
        series: [{ values: rsi, color, width: 1.4, kind: 'line' }],
        legend: [{ label, color, values: rsi }], dec: 1,
      };
    }
    case 'stoch': {
      const k = new Array(bars.length).fill(null);
      for (let i = p.k - 1; i < bars.length; i++) {
        let hh = -Infinity, ll = Infinity, ok = true;
        for (let j = i - p.k + 1; j <= i; j++) {
          const h = bars[j].high, l = bars[j].low;
          if (!Number.isFinite(h) || !Number.isFinite(l)) { ok = false; break; }
          if (h > hh) hh = h; if (l < ll) ll = l;
        }
        if (!ok) continue;
        const c = bars[i].close;
        if (!Number.isFinite(c)) continue;
        const rng = hh - ll;
        k[i] = rng === 0 ? 50 : ((c - ll) / rng) * 100;
      }
      const ksm = _indSMA(k, p.smooth);   // smoothed %K
      const d = _indSMA(ksm, p.d);        // %D
      const cK = '#2962ff', cD = '#ff6d00';
      return {
        kind: 'pane', domain: [0, 100], refs: [{ value: 80, label: '80' }, { value: 20, label: '20' }],
        series: [{ values: ksm, color: cK, width: 1.4, kind: 'line' }, { values: d, color: cD, width: 1.2, kind: 'line' }],
        legend: [{ label: '%K', color: cK, values: ksm }, { label: '%D', color: cD, values: d }], dec: 1,
      };
    }
    case 'macd': {
      const closes = _indSrcSeries(bars, 'close');
      const fast = _indEMA(closes, p.fast), slow = _indEMA(closes, p.slow);
      const macd = bars.map((_, i) => (Number.isFinite(fast[i]) && Number.isFinite(slow[i])) ? fast[i] - slow[i] : null);
      const signal = _indEMA(macd, p.signal);
      const hist = bars.map((_, i) => (Number.isFinite(macd[i]) && Number.isFinite(signal[i])) ? macd[i] - signal[i] : null);
      const cM = '#2962ff', cS = '#ff6d00';
      return {
        kind: 'pane', zero: true, refs: [],
        series: [
          { values: hist, kind: 'hist', up: '#26a69a', down: '#ef5350' },
          { values: macd, color: cM, width: 1.4, kind: 'line' },
          { values: signal, color: cS, width: 1.2, kind: 'line' },
        ],
        legend: [{ label: 'MACD', color: cM, values: macd }, { label: 'signal', color: cS, values: signal }],
      };
    }
    case 'atr': {
      const tr = new Array(bars.length).fill(null);
      for (let i = 0; i < bars.length; i++) {
        const h = bars[i].high, l = bars[i].low;
        if (!Number.isFinite(h) || !Number.isFinite(l)) continue;
        if (i === 0) { tr[i] = h - l; continue; }
        const pc = bars[i - 1].close;
        tr[i] = Number.isFinite(pc) ? Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)) : (h - l);
      }
      const atr = _indRMA(tr, p.period);
      return {
        kind: 'pane', refs: [],
        series: [{ values: atr, color, width: 1.4, kind: 'line' }],
        legend: [{ label, color, values: atr }],
      };
    }
  }
  return null;
}

// ══ Open-Interest seasonal tendency (OI-pane overlay, opt-in per tab) ══
//
// Not a bar indicator — it reads the market's CFTC weekly Open Interest, the very series the OI
// pane draws, and answers "where does OI usually stand at this point of the year". ONE line, the
// 5-year average (operator decision 2026-09-18) — not the Seasonals tab's 5/10/15/Max fan.
//
// A SEASONAL FACTOR, not an indexed path: every report is divided by the market's own level
// AROUND that report — a centered one-year mean — which leaves a ratio near 1.0 carrying only the
// within-year shape, and those ratios are averaged per day of the year. Two things fall out of
// that choice, and both were bugs in the first cut (2026-09-18):
//
//   · The line is continuous across Dec 31. Indexed to each January instead, every year needs its
//     own anchor, and the line has to BREAK at each turn of the year or the re-anchoring draws a
//     step that is not a move in OI. Gold, silver and cotton were reported for exactly that hole.
//   · Nothing about a calendar year leaks into the shape. Dividing by the YEAR's mean — the
//     obvious repair, and the one tried first — moves the artefact rather than removing it: late
//     December is then measured against one year's mean and early January against the next, so
//     the average year-over-year growth in OI lands as a step at New Year. Measured on the
//     2026-09-18 data that step reached 75% of the curve's whole yearly swing (feeder cattle,
//     2Y notes, cocoa). A centered window knows nothing about Januaries, so there is no step.
//
// The factor is put back on the pane's scale with ONE number for the whole line (`oiSeasonalLevel`
// below), so there is nothing per-year left to anchor, and the line means the same thing at every
// range — a 6M window and a 12M window draw the same curve.
//
// Scaled rather than averaged in contracts because a market's OI level drifts across the years
// (gold reported 492k in 2021 and 411k now), so a raw multi-year mean sits at a level no single
// year traded. The factor keeps the SHAPE, which is what a seasonal tendency is.
//
// The partial current year is excluded — it is the line the overlay is drawn against, and
// averaging it into its own benchmark flattens exactly the deviation the indicator is for.
//
// Depth is whatever the archive holds: fetch_cftc.py keeps the last 260 weekly reports, so there
// are ~5 years on file and at most 4 of them complete. The curve reports `yearsUsed` and every
// label names it, rather than printing "5Y" over four years.

const OI_SEASONAL_MAX_GAP_DAYS = 21;    // two missed weekly reports; mirrors SEASONAL_MAX_GAP_DAYS
const OI_SEASONAL_MIN_REPORTS = 40;     // of ~52 a year — a year missing three months is not a season
const OI_SEASONAL_YEARS = 5;            // the one drawn window (yearsUsed says what was really there)
const OI_SEASONAL_LEVEL_REPORTS = 52;   // the trailing year the curve is scaled onto
const OI_SEASONAL_TREND_HALF_DAYS = 182;  // half of the centered window the seasonal ratio is taken against

// Normalise, sort and drop what cannot carry a ratio. Shared by the builder and the level.
function _oiSeasonalRows(oiRows) {
  return (oiRows || [])
    .filter(r => r && r.date && Number.isFinite(Number(r.oi)) && Number(r.oi) > 0)
    .map(r => ({ date: String(r.date).slice(0, 10), oi: Number(r.oi) }))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

// The market's own level around each report: the mean over a centered window of one year, so a
// full season sits on either side of the middle and the seasonality cancels out of the level
// itself. Returns null for a report whose window is not covered on BOTH sides — a one-sided mean
// is not a level, it is half a season, and at the ends of the archive that is all there is.
function _oiSeasonalTrend(rows) {
  const t = rows.map(r => Date.parse(r.date));
  const half = OI_SEASONAL_TREND_HALF_DAYS * 86400000;
  const slack = 7 * 86400000;              // the reports are weekly; do not demand one to the day
  const first = t[0], last = t[t.length - 1];
  return rows.map((r, i) => {
    if (t[i] - half < first - slack || t[i] + half > last + slack) return null;
    let sum = 0, n = 0;
    for (let j = 0; j < rows.length; j++) {
      if (Math.abs(t[j] - t[i]) <= half) { sum += rows[j].oi; n++; }
    }
    return n >= OI_SEASONAL_MIN_REPORTS ? sum / n : null;
  });
}

// -> { yearsRequested, yearsUsed, startYear, endYear, points[365] } | null
// `points` are seasonal FACTORS around 1.0 on the shared 365-day grid from core.js — 1.08 means
// "OI on this day of the year usually runs 8% above that year's own average".
function buildOiSeasonalCurve(oiRows, yearsRequested) {
  const rows = _oiSeasonalRows(oiRows);
  if (!rows.length) return null;

  // A year counts as complete once it is reported into mid-December — the same cutoff the price
  // curves use, so a January run does not throw away the year that just ended.
  const last = rows[rows.length - 1].date;
  const lastMonthDay = Number(last.slice(5, 7)) * 100 + Number(last.slice(8, 10));
  const latestFullYear = seasonalYear(last) - (lastMonthDay >= 1215 ? 0 : 1);
  const wantedStart = latestFullYear - yearsRequested + 1;

  const trend = _oiSeasonalTrend(rows);
  const byYear = new Map();
  rows.forEach((r, i) => {
    const y = seasonalYear(r.date);
    if (y < wantedStart || y > latestFullYear) return;
    const lvl = trend[i];
    if (!Number.isFinite(lvl) || lvl <= 0) return;          // no covered window -> no ratio
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push({ date: r.date, factor: r.oi / lvl });
  });

  const paths = [];
  const usedYears = [];
  Array.from(byYear.keys()).sort((a, b) => a - b).forEach(year => {
    const yr = byYear.get(year);
    if (yr.length < OI_SEASONAL_MIN_REPORTS) return;
    if (Number(yr[0].date.slice(5, 7)) > 2) return;          // a year first reported in June is not a year
    for (let i = 1; i < yr.length; i++) {
      if ((Date.parse(yr[i].date) - Date.parse(yr[i - 1].date)) / 86400000 > OI_SEASONAL_MAX_GAP_DAYS) return;
    }
    // The year's own reports as (day of year -> factor), then held forward across the weeks
    // between them and back over the days before the first report.
    const reported = [];
    yr.forEach(r => {
      const idx = dayOfYearNoLeap(r.date);                   // Feb 29: no slot, that week is skipped
      if (idx === null || idx < 0 || idx > 364) return;
      reported.push({ idx, factor: r.factor });
    });
    if (!reported.length) return;
    const values = new Array(365).fill(null);
    let cursor = 0, held = reported[0].factor;               // back-fill: January before the first report
    reported.forEach(({ idx, factor }) => {
      while (cursor <= idx && cursor < 365) values[cursor++] = held;
      held = factor;
      values[idx] = held;
      cursor = Math.max(cursor, idx + 1);
    });
    while (cursor < 365) values[cursor++] = held;            // hold the last report to year end
    paths.push(values);
    usedYears.push(year);
  });
  if (!paths.length) return null;

  const points = new Array(365).fill(null).map((_, i) => {
    const vals = paths.map(path => path[i]).filter(v => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  return {
    yearsRequested,
    yearsUsed: paths.length,
    startYear: usedYears[0],
    endYear: usedYears[usedYears.length - 1],
    points
  };
}

// The ONE number that puts the factor back on the pane's contract scale: the level at which the
// average season is drawn. Taken from the trailing year of actual reports, matched day for day
// against the curve, so a partial year at the edge cannot tilt it — over a full year the factors
// average out and this is simply "the market's current annual OI level".
//
// One number for the whole line, and it comes from the WHOLE series: that is what makes the curve
// continuous and range-independent. Re-levelling per visible year is what forced the January
// break, and re-levelling per window would make the same line mean "since March" at 6M and
// "since January" at 12M.
function oiSeasonalLevel(oiRows, curve) {
  if (!curve) return null;
  const rows = _oiSeasonalRows(oiRows).slice(-OI_SEASONAL_LEVEL_REPORTS);
  let sumActual = 0, sumFactor = 0, n = 0;
  rows.forEach(r => {
    const idx = dayOfYearNoLeap(r.date);
    if (idx === null) return;
    const f = curve.points[idx];
    if (!Number.isFinite(f) || f <= 0) return;
    sumActual += r.oi; sumFactor += f; n++;
  });
  if (!n || !(sumFactor > 0)) return null;
  return (sumActual / n) / (sumFactor / n);
}

// The drawn line: one value per drawn OI point, or null where the curve has nothing to say (a
// leap-day report, a slot no year reached). Aligned 1:1 to `points`; the caller breaks the path
// at a null — there is no other break left.
function oiSeasonalOverlay(points, curve, level) {
  if (!curve || !Number.isFinite(level) || level <= 0 || !Array.isArray(points)) return [];
  return points.map(p => {
    if (!p || !p.date) return null;
    const idx = dayOfYearNoLeap(p.date);
    if (idx === null) return null;
    const f = curve.points[idx];
    if (!Number.isFinite(f) || f <= 0) return null;
    return { date: p.date, value: f * level };
  });
}
