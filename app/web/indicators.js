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
