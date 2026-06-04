const FX_CORR_WINDOWS = [[21, '1M'], [63, '3M'], [126, '6M'], [252, '1Y']];
let fxCorrWindow = 63;
let fxCalcA = 'fx:EUR|USD';
let fxCalcB = 'mkt:gold';
let fxCalcSeq = 0;   // guards against out-of-order async renders

function fxPearson(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  let sa = 0, sb = 0;
  for (let i = 0; i < n; i++) { sa += a[i]; sb += b[i]; }
  const ma = sa / n, mb = sb / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) { const x = a[i] - ma, y = b[i] - mb; num += x * y; da += x * x; db += y * y; }
  const den = Math.sqrt(da * db);
  return den ? Math.max(-1, Math.min(1, num / den)) : null;
}

function fxCorrWinButtons() {
  return FX_CORR_WINDOWS.map(([d, label]) =>
    `<button class="fx-timeframe-btn${fxCorrWindow === d ? ' active' : ''}" type="button" onclick="setFxCorrWindow(${d})">${label}</button>`
  ).join('');
}
function setFxCorrWindow(d) { fxCorrWindow = d; renderFxCalc(); }
function setFxCalcPair(slot, val) { if (slot === 'a') fxCalcA = val; else fxCalcB = val; renderFxCalc(); }

// Instrument tokens are 'fx:BASE|QUOTE' or 'mkt:<marketKey>'. Parse them in one place.
function fxParseToken(token) {
  if (token.startsWith('fx:')) { const [base, quote] = token.slice(3).split('|'); return { kind: 'fx', base, quote }; }
  if (token.startsWith('mkt:')) return { kind: 'mkt', key: token.slice(4) };
  return { kind: 'other' };
}
function fxInstrumentLabel(token) {
  const t = fxParseToken(token);
  if (t.kind === 'fx') return `${t.base}/${t.quote}`;
  if (t.kind === 'mkt') { const m = INDEX[t.key]; return m ? m.display_name : t.key; }
  return token;
}
function fxInstrumentOptions(selected) {
  const opt = (v, label) => `<option value="${esc(v)}"${v === selected ? ' selected' : ''}>${esc(label)}</option>`;
  let html = '<optgroup label="Forex">';
  html += FX_PAIR_ORDER.map(([b, q]) => opt(`fx:${b}|${q}`, `${b}/${q}`)).join('');
  html += opt('mkt:usdx', 'US Dollar Index');
  html += '</optgroup>';
  const byCat = {};
  for (const key in INDEX) {
    const m = INDEX[key];
    if (m.category === 'Currencies') continue;   // covered by the Forex pairs + US Dollar Index above
    (byCat[m.category] = byCat[m.category] || []).push([key, m.display_name]);
  }
  const rank = c => { const i = CATEGORY_POPULARITY.indexOf(c); return i === -1 ? 99 : i; };   // same order as sidebar/screener
  for (const cat of Object.keys(byCat).sort((a, b) => rank(a) - rank(b))) {
    html += `<optgroup label="${esc(cat)}">`;
    html += byCat[cat].sort((a, b) => a[1].localeCompare(b[1])).map(([key, name]) => opt(`mkt:${key}`, name)).join('');
    html += '</optgroup>';
  }
  return html;
}

// Daily price series for an instrument token ('fx:BASE|QUOTE' or 'mkt:<marketKey>').
// Correlations run directly on the native continuous close's daily returns.
const FX_NO_DATA = { series: [] };
async function fxInstrumentSeries(token) {
  const t = fxParseToken(token);
  if (t.kind === 'fx') {
    const cat = await loadCategory('currencies');
    if (!cat) return FX_NO_DATA;
    return { series: fxPairSeries(t.base, t.quote, cat) };
  }
  if (t.kind === 'mkt') {
    const meta = INDEX[t.key];
    if (!meta) return FX_NO_DATA;
    const cat = await loadCategory(meta.slug);
    const m = cat && cat[t.key];
    if (!m) return FX_NO_DATA;
    const cc = getContinuousContract(m);
    const series = (cc.history || [])
      .filter(r => r && r.date != null && Number(r.close) > 0)
      .map(r => ({ date: r.date, value: Number(r.close) }));
    return { series };
  }
  return FX_NO_DATA;
}

// A currency's value in USD per unit (e.g. EUR -> ~1.08). USD itself is constant 1.
function fxCurInUsd(cur, cat) {
  if (cur === 'USD') return null;   // sentinel → treat as constant 1
  const m = cat && cat[FX_CURRENCIES[cur]];
  if (!m) return {};
  const out = {};
  for (const r of (getContinuousContract(m).history || [])) {
    if (r && r.date != null && Number(r.close) > 0) out[r.date] = Number(r.close);
  }
  return out;
}

// Synthetic daily price series for BASE/QUOTE = (base in USD) / (quote in USD).
function fxPairSeries(base, quote, cat) {
  const bm = fxCurInUsd(base, cat), qm = fxCurInUsd(quote, cat);
  let dates;
  if (bm && qm) dates = Object.keys(bm).filter(d => d in qm);
  else if (bm) dates = Object.keys(bm);
  else if (qm) dates = Object.keys(qm);
  else return [];
  dates.sort();
  return dates.map(d => ({ date: d, value: (bm ? bm[d] : 1) / (qm ? qm[d] : 1) }));
}

function fxRetsFromSeries(series) {
  const out = {};
  for (let i = 1; i < series.length; i++) {
    const d = series[i].date;
    const p = series[i - 1].value, c = series[i].value;
    if (p > 0 && c > 0) out[d] = (c - p) / p;
  }
  return out;
}

function fxCorrVerdict(v) {
  if (v == null) return { word: 'No data', color: 'var(--muted)' };
  const a = Math.abs(v);
  if (a < 0.2) return { word: 'No meaningful correlation', color: 'var(--muted)' };
  const strength = a >= 0.7 ? 'Strong' : a >= 0.4 ? 'Moderate' : 'Weak';
  const dir = v >= 0 ? 'positive' : 'inverse';
  return { word: `${strength} ${dir} correlation`, color: v >= 0 ? 'var(--up)' : 'var(--down)' };
}

function fxMiniCard(pairKey, series, fromDate, toDate) {
  const name = fxInstrumentLabel(pairKey);
  const pts = (fromDate && toDate)
    ? series.filter(p => p.date >= fromDate && p.date <= toDate)
    : series.slice(-fxCorrWindow);
  if (pts.length < 2) {
    return `<div class="fx-mini"><div class="fx-mini-head"><span class="fx-mini-title">${esc(name)}</span></div><div class="fx-mini-empty">No data</div></div>`;
  }
  const vals = pts.map(p => p.value);
  const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
  const first = vals[0], last = vals[vals.length - 1], up = last >= first;
  const chg = first ? (last - first) / first * 100 : 0;
  const W = 340, H = 96, pad = 6;
  let d = '';
  pts.forEach((p, i) => {
    const x = pad + i * (W - 2 * pad) / (pts.length - 1);
    const y = pad + (1 - (p.value - min) / rng) * (H - 2 * pad);
    d += (i ? 'L' : 'M') + x.toFixed(1) + ' ' + y.toFixed(1) + ' ';
  });
  const area = `${d}L ${(W - pad).toFixed(1)} ${(H - pad).toFixed(1)} L ${pad} ${(H - pad).toFixed(1)} Z`;
  const stroke = up ? 'var(--up)' : 'var(--down)';
  const fill = up ? 'rgba(14,166,121,0.12)' : 'rgba(229,62,62,0.12)';
  const dec = last >= 100 ? 2 : last >= 1 ? 4 : 5;
  return `<div class="fx-mini">
    <div class="fx-mini-head"><span class="fx-mini-title">${esc(name)}</span><span class="fx-mini-last" style="color:${stroke}">${last.toFixed(dec)} <small>(${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%)</small></span></div>
    <svg viewBox="0 0 ${W} ${H}"><path d="${area}" fill="${fill}" stroke="none"/><path d="${d.trim()}" fill="none" stroke="${stroke}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>
  </div>`;
}

async function renderFxCalc() {
  const block = document.getElementById('fxCorrBlock');
  const winBar = document.getElementById('fxCorrWin');
  const selA = document.getElementById('fxCalcA'), selB = document.getElementById('fxCalcB');
  const resEl = document.getElementById('fxCalcResult'), chartsEl = document.getElementById('fxCalcCharts');
  if (!block) return;
  block.hidden = false;
  const myseq = ++fxCalcSeq;
  if (winBar) winBar.innerHTML = fxCorrWinButtons();
  // Option lists are static; build once, then just reflect the current selection.
  if (selA && !selA.options.length) selA.innerHTML = fxInstrumentOptions();
  if (selB && !selB.options.length) selB.innerHTML = fxInstrumentOptions();
  if (selA) selA.value = fxCalcA;
  if (selB) selB.value = fxCalcB;
  const [dataA, dataB] = await Promise.all([fxInstrumentSeries(fxCalcA), fxInstrumentSeries(fxCalcB)]);
  if (myseq !== fxCalcSeq) return;   // a newer render superseded this one
  const sA = dataA.series, sB = dataB.series;
  if (!sA.length || !sB.length) {
    if (resEl) resEl.innerHTML = '<div class="screener-empty">Price history unavailable for one of the selected assets.</div>';
    if (chartsEl) chartsEl.innerHTML = '';
    return;
  }
  const rA = fxRetsFromSeries(sA), rB = fxRetsFromSeries(sB);
  let dates = Object.keys(rA).filter(d => d in rB);
  dates.sort();
  const win = dates.slice(-fxCorrWindow);
  const raw = fxPearson(win.map(d => rA[d]), win.map(d => rB[d]));
  const corr = raw == null ? null : Math.round(raw * 100) / 100;   // verdict matches the shown 2-dp value
  const verdict = fxCorrVerdict(corr);
  const coefTxt = corr == null ? '–' : (corr >= 0 ? '+' : '') + corr.toFixed(2);
  const meta = corr == null
    ? 'Not enough overlapping price history to compute a correlation'
    : `${esc(fxInstrumentLabel(fxCalcA))} vs ${esc(fxInstrumentLabel(fxCalcB))} · ${win.length} common daily returns`;
  if (resEl) resEl.innerHTML = `<div class="fx-calc-coef" style="color:${verdict.color}">${coefTxt}</div>
    <div class="fx-calc-label" style="color:${verdict.color}">${verdict.word}</div>
    <div class="fx-calc-meta">${meta}</div>`;
  const from = win.length ? win[0] : null, to = win.length ? win[win.length - 1] : null;
  if (chartsEl) chartsEl.innerHTML = fxMiniCard(fxCalcA, sA, from, to) + fxMiniCard(fxCalcB, sB, from, to);
}

async function openForex() {
  renderPositionSize();
  const fx = document.getElementById('fxSection');
  if (fx) {
    fx.hidden = false;
    if (!screenerData) fx.innerHTML = '<div class="screener-empty">Loading forex heatmap…</div>';
  }
  if (!(await ensureScreenerData(fx))) return;
  renderFxSection();
}

// ── FX position size calculator (Forex tab) + Tools-tab economic-calendar loader ──

const FX_CURRENCIES = { USD: 'usdx', EUR: 'eur_fx', GBP: 'gbp_fx', CAD: 'cad_fx', JPY: 'jpy_fx', CHF: 'chf_fx', AUD: 'aud_fx', NZD: 'nzd_fx' };
const FX_INTEREST_RATE_SCORE_RANGE = 2;
const FX_INTEREST_RATES = {
  AUD: { rate:4.35, display:'4.35%', centralBank:'Reserve Bank of Australia', label:'Cash Rate Target', asOf:'2026-05-06' },
  GBP: { rate:3.75, display:'3.75%', centralBank:'Bank of England', label:'Bank Rate', asOf:'2026-05-26' },
  USD: { rate:3.625, display:'3.50-3.75%', centralBank:'Federal Reserve', label:'Fed Funds Target Midpoint', asOf:'2026-04-29' },
  CAD: { rate:2.25, display:'2.25%', centralBank:'Bank of Canada', label:'Overnight Target', asOf:'2026-04-29' },
  NZD: { rate:2.25, display:'2.25%', centralBank:'Reserve Bank of New Zealand', label:'Official Cash Rate', asOf:'2026-05-27' },
  EUR: { rate:2.15, display:'2.15%', centralBank:'European Central Bank', label:'Main Refinancing Rate', asOf:'2025-06-11' },
  JPY: { rate:0.75, display:'0.75%', centralBank:'Bank of Japan', label:'Overnight Call Rate', asOf:'2026-04-28' },
  CHF: { rate:0.00, display:'0.00%', centralBank:'Swiss National Bank', label:'Policy Rate', asOf:'2026-06-01' },
};

// ── Synthetic FX-pair watchlist entries (key form: fxpair:<baseFutureKey>|<quoteFutureKey>) ──
const FX_CUR_BY_KEY = Object.fromEntries(Object.entries(FX_CURRENCIES).map(([cur, key]) => [key, cur]));
function isFxPairKey(k) { return typeof k === 'string' && k.startsWith('fxpair:'); }
function parseFxPairKey(k) {
  const m = /^fxpair:([^|]+)\|(.+)$/.exec(k || '');
  return m ? { baseKey: m[1], quoteKey: m[2] } : null;
}
function fxPairLegsValid(k) { const p = parseFxPairKey(k); return !!(p && INDEX[p.baseKey] && INDEX[p.quoteKey]); }
function fxPairLabel(k) {
  const p = parseFxPairKey(k); if (!p) return k;
  return `${FX_CUR_BY_KEY[p.baseKey] || p.baseKey}/${FX_CUR_BY_KEY[p.quoteKey] || p.quoteKey}`;
}
function fxPairQuote(k) {
  const p = parseFxPairKey(k); if (!p) return null;
  const cat = catCache['currencies'];
  const a = cat && cat[p.baseKey], b = cat && cat[p.quoteKey];
  if (!a || !b) return null;
  const ah = getContinuousContract(a).history || [], bh = getContinuousContract(b).history || [];
  if (!ah.length || !bh.length) return null;
  const aC = Number(ah[ah.length - 1].close), aP = Number((ah[ah.length - 2] || ah[ah.length - 1]).close);
  const bC = Number(bh[bh.length - 1].close), bP = Number((bh[bh.length - 2] || bh[bh.length - 1]).close);
  if (!aC || !bC || !aP || !bP) return null;
  const close = aC / bC, prev = aP / bP;
  const pct = prev ? (close - prev) / prev * 100 : 0;
  return { close, pct, decimals: close >= 100 ? 2 : close >= 1 ? 3 : 5, unit: '' };
}

const FX_PAIR_ORDER = [
  ['EUR','USD'], ['GBP','USD'], ['AUD','USD'], ['NZD','USD'], ['USD','CAD'], ['USD','CHF'], ['USD','JPY'],
  ['EUR','GBP'], ['EUR','AUD'], ['EUR','NZD'], ['EUR','CAD'], ['EUR','CHF'], ['EUR','JPY'],
  ['GBP','AUD'], ['GBP','NZD'], ['GBP','CAD'], ['GBP','CHF'], ['GBP','JPY'],
  ['AUD','NZD'], ['AUD','CAD'], ['AUD','CHF'], ['AUD','JPY'],
  ['NZD','CAD'], ['NZD','CHF'], ['NZD','JPY'],
  ['CAD','CHF'], ['CAD','JPY'],
  ['CHF','JPY'],
];

// TELEGRAM-SIGNAL threshold: the content bot only posts an FX pair as a signal when its
// base-minus-quote score spread is at least this strong (out of fxMaxPairSpread() = 12).
// Quality over quantity. NOTE: the on-screen Forex-tab heatmap ignores this and always
// shows the strongest pairs; this gate is for the Telegram signal (bot + ?card=fx) only.
const FX_PAIR_MIN_SPREAD = 7;

function screenerScore(r) {
  if (!r) return 0;
  let s = 0;
  for (const k of ['seasonal', 'cot', 'cot_hedge']) {
    if (r[k] === 'bullish') s++; else if (r[k] === 'bearish') s--;
  }
  if (r.structure === 'premium') s++; else if (r.structure === 'discount') s--;
  return s;
}

function roundScore(v) {
  return Math.round((Number(v) || 0) * 10) / 10;
}

function fxInterestRateStats() {
  const vals = Object.values(FX_INTEREST_RATES).map(r => r.rate).filter(v => Number.isFinite(v));
  return { min: Math.min(...vals), max: Math.max(...vals) };
}

function fxInterestRateScore(cur) {
  const meta = FX_INTEREST_RATES[cur];
  if (!meta || !Number.isFinite(meta.rate)) return 0;
  const { min, max } = fxInterestRateStats();
  if (!Number.isFinite(min) || !Number.isFinite(max) || max === min) return 0;
  const normalized = (meta.rate - min) / (max - min);
  return roundScore((normalized - 0.5) * FX_INTEREST_RATE_SCORE_RANGE * 2);
}

function fxMaxScore() {
  return 4 + FX_INTEREST_RATE_SCORE_RANGE;
}

function fxMaxPairSpread() {
  return fxMaxScore() * 2;
}

function fxStrengthRanking() {
  if (!screenerData) return [];
  const byKey = {};
  screenerData.forEach(r => { byKey[r.key] = r; });
  const out = [];
  for (const [cur, key] of Object.entries(FX_CURRENCIES)) {
    if (byKey[key]) {
      const signalScore = screenerScore(byKey[key]);
      const rateScore = fxInterestRateScore(cur);
      out.push({
        cur,
        key,
        score: roundScore(signalScore + rateScore),
        signalScore,
        rateScore,
        rate: FX_INTEREST_RATES[cur] || null,
      });
    }
  }
  out.sort((a, b) => b.score - a.score || a.cur.localeCompare(b.cur));
  return out;
}

function clamp01(v) {
  return Math.max(0, Math.min(1, Number.isFinite(v) ? v : 0));
}

function mixRgb(a, b, f) {
  const t = clamp01(f);
  return a.map((v, i) => Math.round(v + (b[i] - v) * t));
}

function rgb(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function _fxDark() { return typeof currentTheme === 'function' && currentTheme() === 'dark'; }

function fxCurrencyHeat(score) {
  const maxScore = fxMaxScore();
  const t = clamp01((score + maxScore) / (maxScore * 2));
  if (_fxDark()) {
    // Dark: subtle navy-tinted chips toward green/red, light text.
    const neutral = [27, 39, 52], green = [30, 150, 120], red = [205, 86, 74];
    const [target, f] = t >= 0.5 ? [green, (t - 0.5) * 2] : [red, (0.5 - t) * 2];
    const bg = mixRgb(neutral, target, f * 0.55);
    const border = t >= 0.5
      ? mixRgb([48, 64, 79], [30, 201, 160], f * 0.7)
      : mixRgb([48, 64, 79], [240, 102, 79], f * 0.65);
    const color = t > 0.62 ? '#7cf0cf' : t < 0.38 ? '#ffb1a3' : '#aeb9c7';
    return `--fx-chip-bg:${rgb(bg)};--fx-chip-border:${rgb(border)};--fx-chip-color:${color};`;
  }
  const neutral = [238, 241, 245], green = [172, 229, 203], red = [250, 204, 204];
  const [target, f] = t >= 0.5 ? [green, (t - 0.5) * 2] : [red, (0.5 - t) * 2];
  const bg = mixRgb(neutral, target, f);
  const border = t >= 0.5
    ? mixRgb([212, 219, 231], [14, 166, 121], f * 0.75)
    : mixRgb([212, 219, 231], [229, 62, 62], f * 0.65);
  const color = t > 0.62 ? '#07543f' : t < 0.38 ? '#8f2424' : '#647084';
  return `--fx-chip-bg:${rgb(bg)};--fx-chip-border:${rgb(border)};--fx-chip-color:${color};`;
}

function fxPairHeat(spread, tone = 'bullish', intensity = null) {
  const absolute = clamp01(spread / fxMaxPairSpread());
  const t = clamp01(intensity == null ? absolute : Math.max(absolute, intensity));
  if (_fxDark()) {
    // Dark: dark green/red tinted cards (text stays light via --text).
    const base = [22, 33, 45];
    const target = tone === 'bearish' ? [150, 58, 50] : [26, 132, 107];
    const borderTarget = tone === 'bearish' ? [212, 90, 80] : [34, 176, 142];
    const bg = mixRgb(base, target, 0.22 + t * 0.5);
    const border = mixRgb([40, 54, 68], borderTarget, 0.2 + t * 0.65);
    return `--fx-pair-bg:${rgb(bg)};--fx-pair-border:${rgb(border)};`;
  }
  const target = tone === 'bearish' ? [239, 102, 102] : [64, 190, 136];
  const borderTarget = tone === 'bearish' ? [199, 46, 46] : [8, 139, 101];
  const bg = mixRgb([248, 250, 252], target, 0.18 + t * 0.82);
  const border = mixRgb([214, 222, 234], borderTarget, 0.16 + t * 0.82);
  return `--fx-pair-bg:${rgb(bg)};--fx-pair-border:${rgb(border)};`;
}

function fxScoreLabel(score) {
  const n = roundScore(score);
  const txt = Number.isInteger(n) ? String(n) : n.toFixed(1);
  return `${n > 0 ? '+' : ''}${txt}`;
}

function fxAbsScoreLabel(score) {
  return fxScoreLabel(Math.abs(score)).replace('+', '');
}

function fxBiasChip(r) {
  const title = `${r.cur}: signals ${fxScoreLabel(r.signalScore)}, rates ${fxScoreLabel(r.rateScore)} (${r.rate?.display || 'n/a'})`;
  return `<button type="button" class="fx-chip" style="${fxCurrencyHeat(r.score)}" onclick="openScreenerMarket('${r.key}')" title="${esc(title)}">${esc(r.cur)} <b>${fxScoreLabel(r.score)}</b></button>`;
}

function fxBiasColumn(kind, title, rows) {
  const tone = kind === 'long' ? 'bull' : 'bear';
  return `<div class="fx-bias-col ${tone}">
    <div class="fx-bias-head">
      <div class="fx-bias-title ${kind}">${title}</div>
      <div class="fx-bias-count">${rows.length || 0}</div>
    </div>
    <div class="fx-bias-list">
      ${rows.length ? rows.map(fxBiasChip).join('') : '<span class="fx-bias-empty">No clear bias</span>'}
    </div>
  </div>`;
}

function fxPairTile(p, tone) {
  const inWatch = watchlist.includes(`fxpair:${p.base.key}|${p.quote.key}`);
  const isBear = tone === 'bearish';
  const label = isBear ? `Bear -${fxAbsScoreLabel(p.spread)}/${fxMaxPairSpread()}` : `Bull +${fxAbsScoreLabel(p.spread)}/${fxMaxPairSpread()}`;
  return `<div class="fx-pair ${tone}" style="${fxPairHeat(p.spread, tone, p.heat)}" onclick="openFxPairChart('${p.base.key}','${p.quote.key}','${p.base.cur}','${p.quote.cur}')" title="Open ${p.base.cur}/${p.quote.cur} chart">
    <span class="fx-pair-name">${p.base.cur}/${p.quote.cur}</span>
    <span class="fx-pair-spread">${label}</span>
    <button type="button" class="fx-pair-add${inWatch ? ' on' : ''}" onclick="fxAddPair('${p.base.key}','${p.quote.key}', event)" title="Add pair to watchlist">${inWatch ? '★ saved' : '+ Watchlist'}</button>
  </div>`;
}

function fxPairShelf(title, tone, rows) {
  const note = tone === 'bearish'
    ? 'Pairs to short · weakest base versus strongest quote'
    : 'Pairs to buy · strongest base versus weakest quote';
  return `<div class="fx-pair-side ${tone}">
    <div class="fx-pair-side-head">
      <div class="fx-pair-side-title ${tone}">${title}</div>
      <div class="fx-pair-side-note">${note} · canonical FX notation</div>
    </div>
    <div class="fx-pair-grid">
      ${rows.length ? rows.map(p => fxPairTile(p, tone)).join('') : `<div class="fx-pair-empty">No pair reaches ${FX_PAIR_MIN_SPREAD}/${fxMaxPairSpread()} today — no high-conviction divergence.</div>`}
    </div>
  </div>`;
}

function fxPairIntensity(spread, rows) {
  const values = rows.map(p => Number(p.spread)).filter(v => Number.isFinite(v));
  if (!values.length) return clamp01(spread / fxMaxPairSpread());
  const min = Math.min(...values), max = Math.max(...values);
  if (max === min) return clamp01(spread / fxMaxPairSpread());
  return clamp01(0.22 + ((spread - min) / (max - min)) * 0.78);
}

function withFxPairHeat(rows) {
  return rows.map(p => ({ ...p, heat: fxPairIntensity(p.spread, rows) }));
}

function fxCanonicalPairs(ranking) {
  const byCur = {};
  ranking.forEach(r => { byCur[r.cur] = r; });
  return FX_PAIR_ORDER.map(([baseCur, quoteCur], order) => {
    const base = byCur[baseCur], quote = byCur[quoteCur];
    if (!base || !quote) return null;
    const signed = roundScore(base.score - quote.score);
    if (signed === 0) return null;
    return { base, quote, signed, spread: roundScore(Math.abs(signed)), order };
  }).filter(Boolean);
}

function fxRateScoreTone(score) {
  return score > 0 ? 'bull' : score < 0 ? 'bear' : 'flat';
}

function fxFilterLegend() {
  return `<div class="fx-detail-panel">
    <div class="fx-detail-title">Heatmap Filter Logic</div>
    <div class="fx-detail-copy">Final currency score = Seasonals + COT + COT Hedging + Term Structure + Interest Rate Bias. Pair score = base currency score minus quote currency score, using fixed canonical FX notation.</div>
    <div class="fx-filter-line"><strong>Seasonals, COT, COT Hedging:</strong> +1 bullish / -1 bearish · <strong>Term Structure:</strong> +1 premium / -1 discount · <strong>Interest Rates:</strong> +${FX_INTEREST_RATE_SCORE_RANGE} highest / -${FX_INTEREST_RATE_SCORE_RANGE} lowest, scaled across the FX basket.</div>
    <div class="fx-filter-line"><strong>Pairs shown:</strong> the strongest divergences, ranked by score spread. A Telegram signal requires a spread of at least ${FX_PAIR_MIN_SPREAD}/${fxMaxPairSpread()} — quality over quantity.</div>
  </div>`;
}

function fxInterestRateTable(rateRanking) {
  return `<div class="fx-detail-panel fx-rate-panel">
    <div class="fx-detail-title">Interest Rates</div>
    <div class="fx-rate-table-wrap">
      <table class="fx-rate-table">
        <thead>
          <tr>
            <th>Currency</th>
            <th>Policy Rate</th>
            <th>Central Bank</th>
            <th>Instrument</th>
            <th>Rate Bias</th>
            <th>As Of</th>
          </tr>
        </thead>
        <tbody>
          ${rateRanking.map(r => {
            const meta = r.rate || {};
            const tone = fxRateScoreTone(r.rateScore);
            return `<tr>
              <td class="fx-rate-cur">${esc(r.cur)}</td>
              <td class="fx-rate-value">${esc(meta.display || 'n/a')}</td>
              <td>${esc(meta.centralBank || 'n/a')}</td>
              <td>${esc(meta.label || 'Policy rate')}</td>
              <td class="fx-rate-score ${tone}">${fxScoreLabel(r.rateScore)}</td>
              <td>${esc(meta.asOf || 'n/a')}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

function renderFxSection() {
  const el = document.getElementById('fxSection');
  if (!el) return;
  const rateBlock = document.getElementById('fxRateBlock');
  const ranking = fxStrengthRanking();
  if (ranking.length < 2) {
    el.hidden = true;
    if (rateBlock) { rateBlock.hidden = true; rateBlock.innerHTML = ''; }
    closeFxPairChart();
    return;
  }
  el.hidden = false;

  const longBias = ranking.filter(r => r.score > 0);
  const shortBias = ranking.filter(r => r.score < 0).sort((a, b) => a.score - b.score || a.cur.localeCompare(b.cur));
  const neutralBias = ranking.filter(r => r.score === 0).sort((a, b) => a.cur.localeCompare(b.cur));
  const neutralRow = neutralBias.length
    ? `<div class="fx-neutral-row"><span>Neutral</span>${neutralBias.map(fxBiasChip).join('')}</div>`
    : '';
  const rateRanking = [...ranking].sort((a, b) => (b.rate?.rate ?? -Infinity) - (a.rate?.rate ?? -Infinity) || a.cur.localeCompare(b.cur));
  const biasBoard = `<div class="fx-bias-board">
    ${fxBiasColumn('long', 'Bullish / Long Bias', longBias)}
    ${fxBiasColumn('short', 'Bearish / Short Bias', shortBias)}
  </div>`;

  const canonicalPairs = fxCanonicalPairs(ranking);
  // On-screen heatmap surfaces the strongest pairs generally (no hard cutoff). The
  // >= FX_PAIR_MIN_SPREAD gate is a TELEGRAM-SIGNAL threshold only (content bot + the
  // ?card=fx export), so the Forex tab stays informative even when nothing is signal-grade.
  const bullishPairs = canonicalPairs.filter(p => p.signed > 0);
  const bearishPairs = canonicalPairs.filter(p => p.signed < 0);
  const bullPairSort = (x, y) =>
    y.spread - x.spread
    || x.order - y.order;
  const bearPairSort = (x, y) =>
    y.spread - x.spread
    || x.order - y.order;
  bullishPairs.sort(bullPairSort);
  bearishPairs.sort(bearPairSort);

  const topBullish = withFxPairHeat(bullishPairs.slice(0, 6));
  const topBearish = withFxPairHeat(bearishPairs.slice(0, 6));
  const pairBoard = `<div class="fx-pair-board">
    ${fxPairShelf('Bullish Pairs', 'bullish', topBullish)}
    ${fxPairShelf('Bearish Pairs', 'bearish', topBearish)}
  </div>`;

  el.innerHTML = `
    <div class="fx-head">
      <div class="fx-title">FX Strength &amp; Pairs</div>
      <div class="fx-note">Signals (-4…+4) + rates (+/-${FX_INTEREST_RATE_SCORE_RANGE}) · total max +/-${fxMaxScore()}</div>
    </div>
    ${biasBoard}
    ${neutralRow}
    ${pairBoard}
    ${fxFilterLegend()}`;
  if (rateBlock) {
    rateBlock.hidden = false;
    rateBlock.innerHTML = fxInterestRateTable(rateRanking);
  }
}

// ── Card-Mode: gebrandete FX-Heatmap-Karte für den Content-Bot (?card=fx) ──
// Nutzt die ECHTEN Heatmap-Fragmente (Währungsstärke-Spalten + gefilterte Paar-Regale),
// nur in einen Export-Rahmen mit Header (ChartHorizon · Data-as-of · Export-Zeit) und
// Risk-Disclaimer verpackt. Wird headless als DOM-Element gescreenshottet (kein SVG-Export,
// weil die Heatmap reines HTML/CSS ist). Das normale Forex-Tab bleibt unberührt.
async function openForexCard() {
  if (!(await ensureScreenerData(document.body))) return;
  renderFxCard();
}

function renderFxCard() {
  let host = document.getElementById('fxCardExport');
  if (!host) {
    host = document.createElement('div');
    host.id = 'fxCardExport';
    document.body.appendChild(host);
  }
  const ranking = fxStrengthRanking();
  if (ranking.length < 2) {
    host.innerHTML = '<div class="screener-empty">FX heatmap unavailable.</div>';
    return;
  }
  const longBias = ranking.filter(r => r.score > 0);
  const shortBias = ranking.filter(r => r.score < 0).sort((a, b) => a.score - b.score || a.cur.localeCompare(b.cur));
  const canonicalPairs = fxCanonicalPairs(ranking);
  const sortPairs = (x, y) => y.spread - x.spread || x.order - y.order;
  const bullishPairs = canonicalPairs.filter(p => p.signed >= FX_PAIR_MIN_SPREAD).sort(sortPairs);
  const bearishPairs = canonicalPairs.filter(p => p.signed <= -FX_PAIR_MIN_SPREAD).sort(sortPairs);
  const topBullish = withFxPairHeat(bullishPairs.slice(0, 6));
  const topBearish = withFxPairHeat(bearishPairs.slice(0, 6));
  const asOf = (window.__CONFIG__ && window.__CONFIG__.genDate) || '';
  host.innerHTML = `
    <div class="fxcard-head">
      <div>
        <div class="fxcard-cat">FOREX</div>
        <div class="fxcard-name">FX Strength &amp; Pairs</div>
        ${asOf ? `<div class="fxcard-meta">Data as of ${esc(asOf)}</div>` : ''}
      </div>
      <div class="fxcard-head-r">
        <div class="fxcard-brand">ChartHorizon</div>
        <div class="fxcard-meta">Exported ${esc(exportNowStamp())}</div>
      </div>
    </div>
    <div class="fxcard-sub">Currency score = Seasonals + COT + COT-Hedging + Term Structure + Interest-Rate Bias (−${fxMaxScore()}…+${fxMaxScore()}) · pairs filtered to spread ≥ ${FX_PAIR_MIN_SPREAD}/${fxMaxPairSpread()}</div>
    <div class="fx-bias-board">
      ${fxBiasColumn('long', 'Bullish / Long Bias', longBias)}
      ${fxBiasColumn('short', 'Bearish / Short Bias', shortBias)}
    </div>
    <div class="fx-pair-board fxcard-pairboard">
      ${fxPairShelf('Bullish Pairs', 'bullish', topBullish)}
      ${fxPairShelf('Bearish Pairs', 'bearish', topBearish)}
    </div>
    <div class="fxcard-disclaimer">${esc(CARD_RISK_DISCLAIMER)}</div>`;
}

// ── Card-Mode: natives synthetisches Paar-Chart (Preis-only) mit Signal-Marker ──
// Der Kurs des Paares = Basis-Future ÷ Quote-Future (beide yfinance) als UNSER eigener
// gebrandeter Chart — kein TradingView (kein Annotations-API + Lizenzproblem). Preis-only,
// weil ein Ratio kein eigenes COT/OI/Spread hat. Wird headless gescreenshottet; die
// bestehende Export-Pipeline (Header + Disclaimer) brandet das SVG aus #chartBody.
async function openFxPairCard(baseKey, quoteKey) {
  const body = document.getElementById('chartBody');
  if (!(await ensureScreenerData(body))) return;
  const baseCur = FX_CUR_BY_KEY[baseKey] || baseKey;
  const quoteCur = FX_CUR_BY_KEY[quoteKey] || quoteKey;
  const ranking = fxStrengthRanking();
  const byKey = {};
  ranking.forEach(r => { byKey[r.key] = r; });
  const signed = ((byKey[baseKey] || {}).score || 0) - ((byKey[quoteKey] || {}).score || 0);
  const direction = signed >= 0 ? 'bullish' : 'bearish';
  // Synthetisch aus den zwei Währungs-Futures (echte OHLC -> saubere Kerzenkörper; das
  // yfinance-Spot-Paar =X liefert oft Open≈Close/Doji und damit keine echten Kerzen).
  const cur = await loadCategory('currencies');
  if (!cur || !cur[baseKey] || !cur[quoteKey]) {
    if (body) body.innerHTML = `<div class="chart-empty">FX-Paardaten nicht verfügbar.</div>`;
    return;
  }
  renderFxPairChart(baseCur, quoteCur, fxRatioBars(cur[baseKey], cur[quoteKey]), direction);
}

// Synthetische Ratio-Kerzen aus zwei Währungs-Futures, ~letzte 12 Monate, nach Datum
// gepaart. High/Low sind die echten Ratio-Extrema (base_high/quote_low bzw. base_low/quote_high).
function fxRatioBars(baseCfg, quoteCfg, days = 372) {
  const bh = (getContinuousContract(baseCfg).history) || [];
  const qh = (getContinuousContract(quoteCfg).history) || [];
  const qByDate = {};
  qh.forEach(r => { if (r && r.date) qByDate[String(r.date).slice(0, 10)] = r; });
  const cutoff = Date.now() - days * 86400000;
  const out = [];
  bh.forEach(b => {
    if (!b || !b.date) return;
    const d = String(b.date).slice(0, 10);
    if (new Date(d).getTime() < cutoff) return;
    const q = qByDate[d];
    if (!q) return;
    const bO = +b.open, bH = +b.high, bL = +b.low, bC = +b.close;
    const qO = +q.open, qH = +q.high, qL = +q.low, qC = +q.close;
    if (!(bC > 0 && qC > 0 && qO > 0 && qH > 0 && qL > 0 && bO > 0 && bH > 0 && bL > 0)) return;
    const open = bO / qO, close = bC / qC;
    out.push({ date: d, open, close, high: Math.max(bH / qL, open, close), low: Math.min(bL / qH, open, close) });
  });
  return out;
}

function renderFxPairChart(baseCur, quoteCur, bars, direction) {
  const body = document.getElementById('chartBody');
  if (!body) return;
  if (!bars || bars.length < 5) {
    body.innerHTML = `<div class="chart-empty">Zu wenig gemeinsame Historie für ${esc(baseCur)}/${esc(quoteCur)}.</div>`;
    return;
  }
  const W = 1000, padL = 56, padR = 66, padT = 16, priceH = 470;
  const innerW = W - padL - padR;
  const edgePad = Math.max(24, Math.round(innerW * 0.04));
  const plotW = innerW - edgePad * 2;
  const n = bars.length;
  const slot = plotW / n;
  const candleW = Math.max(1, Math.min(10, slot * 0.7));
  const xAt = i => padL + edgePad + slot * (i + 0.5);
  const barXs = bars.map((_, i) => xAt(i));
  const pMin = Math.min(...bars.map(d => d.low));
  const pMax = Math.max(...bars.map(d => d.high));
  const pSpan = ((pMax - pMin) || 1) * 1.12;
  const pLo = pMin - ((pMax - pMin) || 1) * 0.06;
  const pY = v => padT + (1 - (v - pLo) / pSpan) * priceH;
  const lastClose = bars[n - 1].close;
  const dec = lastClose >= 100 ? 2 : lastClose >= 1 ? 3 : 5;
  const bull = direction === 'bullish';

  // Gerundete / psychologische Level wie im Futures-Chart (Vielfache von 1/2/2.5/5/10,
  // ca. 3–7 sichtbare Level) statt gleichmäßiger Linien.
  const pHi = pLo + pSpan;
  function roundLevelStep(span) {
    const rawStep = span / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const candidates = [1, 2, 2.5, 5, 10].map(m => m * mag);
    let step = candidates[0];
    for (const c of candidates) {
      if (span / c <= 7) { step = c; break; }
    }
    return step;
  }
  const levelStep = roundLevelStep(pSpan);
  let grid = '';
  for (let lv = Math.ceil(pLo / levelStep) * levelStep; lv <= pHi; lv += levelStep) {
    const v = Math.round(lv / levelStep) * levelStep;   // FP-Rauschen glätten
    if (v < pLo || v > pHi) continue;
    const y = pY(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="2,4" opacity="0.78"/>`;
    grid += `<text x="${W - padR + 6}" y="${(+y + 3.5).toFixed(1)}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora">${v.toFixed(dec)}</text>`;
  }

  let candles = '';
  bars.forEach((d, i) => {
    const x = xAt(i);
    const up = d.close >= d.open;
    const col = up ? CHART_THEME.bull : CHART_THEME.bear;
    const wickCol = up ? CHART_THEME.bullWick : CHART_THEME.bearWick;
    const yO = pY(d.open), yC = pY(d.close);
    candles += `<line x1="${x.toFixed(1)}" y1="${pY(d.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${pY(d.low).toFixed(1)}" stroke="${wickCol}" stroke-width="1"/>`;
    candles += `<rect x="${(x - candleW / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${candleW.toFixed(1)}" height="${Math.max(1, Math.abs(yC - yO)).toFixed(1)}" fill="${col}" stroke="${col}" stroke-width="0.5"/>`;
  });

  // Marker an der AUSLÖSE-Kerze (since aus der Card-URL) + Schattierung von dort bis heute —
  // analog zur 4/4-Perioden-Schattierung der Futures (nicht erst ab der heutigen Kerze).
  const _q = new URLSearchParams(location.search);
  const _sinceIso = _q.get('since');
  let markIdx = n - 1;
  if (_sinceIso) {
    const t = new Date(_sinceIso).getTime();
    let best = n - 1, dist = Infinity;
    bars.forEach((b, i) => { const dd = Math.abs(new Date(b.date).getTime() - t); if (dd < dist) { dist = dd; best = i; } });
    markIdx = best;
  }
  // Identische Logik wie die 4/4-Schattierung der Futures: Rechteck von Bar-Mitte (Start)
  // bis Bar-Mitte (heute), opacity 0.2; Marker-Dreieck am Start-Bar (gleiche Offsets).
  const x1 = barXs[markIdx], x2 = barXs[n - 1];
  const band = x2 > x1
    ? `<rect x="${x1.toFixed(1)}" y="${padT}" width="${(x2 - x1).toFixed(1)}" height="${priceH}" fill="${bull ? '#16a34a' : '#dc2626'}" opacity="0.2"/>`
    : '';
  const lb = bars[markIdx], mx = barXs[markIdx];
  let mark = '';
  if (bull) {
    const y = pY(lb.low) + 6;
    mark = `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y + 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y + 11).toFixed(1)} Z" fill="${CHART_THEME.bull}" stroke="#fff" stroke-width="0.8"/>`;
  } else {
    const y = pY(lb.high) - 6;
    mark = `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y - 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y - 11).toFixed(1)} Z" fill="${CHART_THEME.bear}" stroke="#fff" stroke-width="0.8"/>`;
  }

  const axisY = padT + priceH;
  const totalH = axisY + 26;
  let xLabels = '';
  for (let g = 0; g <= 5; g++) {
    const i = Math.round((n - 1) * g / 5);
    xLabels += `<text x="${xAt(i).toFixed(1)}" y="${(totalH - 6).toFixed(1)}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora" text-anchor="middle">${bars[i].date.slice(2)}</text>`;
  }
  const chartBg = `<rect x="0" y="0" width="${W}" height="${totalH}" fill="${CHART_THEME.bg}" rx="7"/>`;

  // Export-Header-Kontext (von getChartExportContext gelesen) + optionale Runway aus der
  // Card-URL (?rw=<Tage>&until=<iso>), die der Bot aus fx_backfill berechnet hat.
  let runway = null;
  const _rw = parseInt(_q.get('rw') || '', 10);
  if (_rw > 0) runway = { days: _rw, until: _q.get('until') || '', note: `before the FX score-spread falls below ${FX_PAIR_MIN_SPREAD}/${fxMaxPairSpread()}` };
  window.__fxPairCard = {
    label: `${baseCur}/${quoteCur}`,
    symbol: `Synthetic pair · ${baseCur} ÷ ${quoteCur} · yfinance futures`,
    runway,
  };
  const symEl = document.getElementById('chartSym');
  if (symEl) symEl.textContent = `${baseCur}/${quoteCur} · Synthetic pair`;

  body.innerHTML = `
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" preserveAspectRatio="xMinYMin meet">
        ${chartBg}
        ${band}
        ${grid}
        ${candles}
        ${mark}
        ${xLabels}
      </svg>
    </div>`;
}

function fxAddPair(baseKey, quoteKey, event) {
  if (event) event.stopPropagation();
  const key = `fxpair:${baseKey}|${quoteKey}`;
  if (watchlist.includes(key)) watchlist = watchlist.filter(k => k !== key);
  else if (INDEX[baseKey] && INDEX[quoteKey]) watchlist.push(key);
  saveWatchlist();
  renderWatchlist();
  renderFxSection();
}

// ── TradingView FX chart widget (opens under the heatmap when a pair is clicked) ──
let fxPairState = null;
let fxTradingViewWidgetSeq = 0;
const FX_TV_INTERVALS = [
  ['1', 'm1'],
  ['5', 'm5'],
  ['15', 'm15'],
  ['60', 'h1'],
  ['240', 'h4'],
  ['D', 'daily'],
  ['W', 'weekly'],
  ['M', 'monthly'],
];

function fxTradingViewSymbol(baseCur, quoteCur) {
  return `FX:${String(baseCur || '').toUpperCase()}${String(quoteCur || '').toUpperCase()}`;
}

function fxTradingViewOverrides() {
  // Grid is intentionally left at the TradingView default (no vert/horz grid
  // color overrides) so the widget keeps its original grid look. Background,
  // axis text, and candle colors stay aligned with the main Futures chart.
  return {
    'paneProperties.background': CHART_THEME.bg,
    'paneProperties.backgroundType': 'solid',
    'scalesProperties.textColor': CHART_THEME.text,
    'scalesProperties.lineColor': CHART_THEME.axis,
    'mainSeriesProperties.candleStyle.upColor': CHART_THEME.bull,
    'mainSeriesProperties.candleStyle.downColor': CHART_THEME.bear,
    'mainSeriesProperties.candleStyle.borderUpColor': CHART_THEME.bull,
    'mainSeriesProperties.candleStyle.borderDownColor': CHART_THEME.bear,
    'mainSeriesProperties.candleStyle.wickUpColor': CHART_THEME.bullWick,
    'mainSeriesProperties.candleStyle.wickDownColor': CHART_THEME.bearWick,
  };
}

function fxTimeframeButtons(activeInterval) {
  return `<div class="fx-timeframe-bar" aria-label="Timeframes">${FX_TV_INTERVALS.map(([value, label]) =>
    `<button class="fx-timeframe-btn${activeInterval === value ? ' active' : ''}" type="button" onclick="setFxTradingViewInterval('${value}')">${label}</button>`
  ).join('')}</div>`;
}

function loadTradingViewScript() {
  if (window.TradingView && typeof window.TradingView.widget === 'function') return Promise.resolve();
  const existing = document.getElementById('tradingview-widget-script');
  if (existing) {
    return new Promise((resolve, reject) => {
      existing.addEventListener('load', resolve, { once: true });
      existing.addEventListener('error', reject, { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.id = 'tradingview-widget-script';
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

async function openFxPairChart(baseKey, quoteKey, baseCur, quoteCur, interval = (fxPairState && fxPairState.interval) || 'D') {
  const wrap = document.getElementById('fxPairChart');
  if (!wrap) return;
  const symbol = fxTradingViewSymbol(baseCur, quoteCur);
  const pair = `${baseCur}/${quoteCur}`;
  const containerId = `fxTradingViewWidget_${++fxTradingViewWidgetSeq}`;
  fxPairState = { baseKey, quoteKey, baseCur, quoteCur, symbol, containerId, interval };
  wrap.hidden = false;
  wrap.innerHTML = `<div class="fx-chart-head">
      <div class="fx-chart-title">${esc(pair)} <span class="fx-chart-sub">· TradingView free widget · ${esc(symbol)}</span></div>
      <div class="fx-chart-ctrls">${fxTimeframeButtons(interval)}<button class="fx-chart-close" type="button" onclick="closeFxPairChart()" title="Close">✕</button></div>
    </div>
    <div class="fx-tv-wrap"><div id="${containerId}"></div></div>`;
  try {
    await loadTradingViewScript();
    if (!fxPairState || fxPairState.containerId !== containerId) return;
    new TradingView.widget({
      autosize: true,
      symbol,
      interval,
      timezone: 'Etc/UTC',
      theme: (typeof currentTheme === 'function' && currentTheme() === 'dark') ? 'dark' : 'light',
      style: '1',
      locale: 'en',
      toolbar_bg: CHART_THEME.bg,
      enable_publishing: false,
      hide_side_toolbar: false,
      allow_symbol_change: false,
      save_image: false,
      hide_volume: true,
      studies: [],
      overrides: fxTradingViewOverrides(),
      container_id: containerId,
    });
  } catch (e) {
    wrap.innerHTML = `<div class="fx-chart-head">
        <div class="fx-chart-title">${esc(pair)} <span class="fx-chart-sub">· ${esc(symbol)}</span></div>
        <div class="fx-chart-ctrls"><button class="fx-chart-close" type="button" onclick="closeFxPairChart()" title="Close">✕</button></div>
      </div>
      <div class="screener-empty">TradingView widget could not be loaded. Open ${esc(symbol)} directly on tradingview.com.</div>`;
  }
  wrap.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function setFxTradingViewInterval(interval) {
  if (!fxPairState) return;
  openFxPairChart(fxPairState.baseKey, fxPairState.quoteKey, fxPairState.baseCur, fxPairState.quoteCur, interval);
}

function closeFxPairChart() {
  fxPairState = null;
  const wrap = document.getElementById('fxPairChart');
  if (wrap) { wrap.hidden = true; wrap.innerHTML = ''; }
}

