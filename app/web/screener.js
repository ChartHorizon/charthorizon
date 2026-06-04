let screenerData = null;
let screenerSort = { col: 'category', dir: 1 };
const screenerFilters = { seasonal: new Set(), cot: new Set(), cot_hedge: new Set(), structure: new Set() };
let screenerView = 'daily';   // 'daily' (live screener) | 'weekly' (4/4 + 3/4 outlook)
let screenerWeekSel = 0;      // Weekly Outlook: 0 = this week, 1 = next week

// Weekly Outlook inline charts: the bot's 4/4 period log (start = "when first
// triggered") is reused to shade the 4/4 band + entry/drop markers. Charts render
// lazily (IntersectionObserver) and redraw on resize so they stay crisp/dynamic.
let _wkFourFourLog = null;     // cached ff_data/four_four_log.json ({} if absent)
let _wkChartObserver = null;   // lazy-render observer for the current weekly render
let _wkResizeBound = false;    // window-resize redraw bound once

// ── Daily Outlook persistence: the current screener view (filters, category,
// search, sort, active sub-view) is remembered in localStorage and restored on open.
const SCREENER_STATE_KEY = 'ch_screener_state';

function saveScreenerState() {
  try {
    localStorage.setItem(SCREENER_STATE_KEY, JSON.stringify({
      view: screenerView,
      sort: screenerSort,
      filters: Object.fromEntries(Object.entries(screenerFilters).map(([k, s]) => [k, [...s]])),
      cat: document.getElementById('screenerCat')?.value || '',
      q: document.getElementById('screenerSearch')?.value || '',
    }));
  } catch (e) { /* storage disabled — non-fatal */ }
}

function loadScreenerState() {
  let st;
  try { st = JSON.parse(localStorage.getItem(SCREENER_STATE_KEY) || 'null'); } catch (e) { st = null; }
  if (!st) return;
  if (st.view === 'weekly' || st.view === 'daily') screenerView = st.view;
  if (st.sort && st.sort.col) screenerSort = { col: st.sort.col, dir: st.sort.dir === -1 ? -1 : 1 };
  if (st.filters) {
    for (const sig of ['seasonal', 'cot', 'cot_hedge', 'structure']) {
      screenerFilters[sig].clear();
      (st.filters[sig] || []).forEach(v => screenerFilters[sig].add(v));
    }
  }
  const searchEl = document.getElementById('screenerSearch');
  if (searchEl && typeof st.q === 'string') searchEl.value = st.q;
  const catEl = document.getElementById('screenerCat');
  if (catEl && st.cat) catEl.value = st.cat;   // applied after categories are populated
}

// Search/category edits: persist + re-render the daily table.
function onScreenerInput() {
  saveScreenerState();
  renderScreener();
}

async function ensureScreenerData(statusEl = null) {
  if (screenerData) return true;
  if (statusEl) statusEl.innerHTML = '<div class="screener-empty">Loading screener…</div>';
  try {
    const res = await fetch(`${DATA_DIR}/screener.json?v=${DATA_VERSION}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('not found');
    screenerData = await res.json();
    populateScreenerCategories();
    return true;
  } catch (e) {
    if (statusEl) statusEl.innerHTML = '<div class="screener-empty">Screener data was not found. Please refresh the data once.</div>';
    return false;
  }
}

async function openScreener() {
  const body = document.getElementById('screenerBody');
  if (!(await ensureScreenerData(body))) return;
  loadScreenerState();              // restore filters/sort/category/search/view (categories already populated)
  applyScreenerView();              // show daily or weekly + render the active one
}

// Switch between Daily Outlook (live screener) and Weekly Outlook (4/4 + 3/4 report).
function setScreenerView(view) {
  screenerView = (view === 'weekly') ? 'weekly' : 'daily';
  saveScreenerState();
  applyScreenerView();
}

// Weekly Outlook: switch the shown week (this / next).
function setScreenerWeek(sel) {
  screenerWeekSel = sel ? 1 : 0;
  renderWeeklyOutlook();
}

function applyScreenerView() {
  const isWeekly = screenerView === 'weekly';
  document.getElementById('screenerDaily')?.toggleAttribute('hidden', isWeekly);
  document.getElementById('screenerWeekly')?.toggleAttribute('hidden', !isWeekly);
  // Daily-only controls (search + category) are hidden in the weekly report.
  const dailyCtrls = document.getElementById('screenerDailyControls');
  if (dailyCtrls) dailyCtrls.style.display = isWeekly ? 'none' : '';
  document.querySelectorAll('#screenerViews .screener-view-tab').forEach(b =>
    b.classList.toggle('on', b.dataset.view === screenerView));
  if (isWeekly) renderWeeklyOutlook();
  else renderScreener();
}

// ── SMT (Smart Money Technique) divergence comparison page ──

function populateScreenerCategories() {
  const sel = document.getElementById('screenerCat');
  if (!sel) return;
  const rank = c => { const i = CATEGORY_POPULARITY.indexOf(c); return i === -1 ? 99 : i; };
  const cats = [...new Set((screenerData || []).map(r => r.category))].sort((a, b) => rank(a) - rank(b));
  sel.innerHTML = '<option value="">All categories</option>' +
    cats.map(c => `<option value="${esc(c)}">${esc(c)}</option>`).join('');
}

function sigRank(v) {
  if (v === 'bullish' || v === 'premium') return 2;
  if (v === 'bearish' || v === 'discount') return 0;
  return 1;
}
function sigBadge(v) {
  const labels = { bullish: 'Bullish', bearish: 'Bearish', neutral: 'Neutral', premium: 'Premium', discount: 'Discount' };
  if (v === 'bullish' || v === 'premium') return `<span class="sig sig-bull">${labels[v]}</span>`;
  if (v === 'bearish' || v === 'discount') return `<span class="sig sig-bear">${labels[v]}</span>`;
  if (v === 'neutral') return `<span class="sig sig-na">${labels[v]}</span>`;
  return '<span class="sig sig-na">–</span>';
}

function sortScreener(col) {
  if (screenerSort.col === col) screenerSort.dir *= -1;
  else screenerSort = { col, dir: (col === 'display_name' || col === 'category') ? 1 : -1 };
  saveScreenerState();
  renderScreener();
}

function filteredScreenerRows() {
  if (!screenerData) return [];
  const q = (document.getElementById('screenerSearch')?.value || '').trim().toLowerCase();
  const catF = document.getElementById('screenerCat')?.value || '';
  return screenerData.filter(r => {
    if (catF && r.category !== catF) return false;
    if (q && !(r.display_name || '').toLowerCase().includes(q)) return false;
    for (const sig of ['seasonal', 'cot', 'cot_hedge', 'structure']) {
      const set = screenerFilters[sig];
      if (set.size && !set.has(r[sig])) return false;
    }
    return true;
  });
}

function toggleScreenerFilter(sig, val) {
  // One option per signal: bullish OR bearish (or none). Selecting one clears the other.
  const set = screenerFilters[sig];
  const wasActive = set.has(val);
  set.clear();
  if (!wasActive) set.add(val);
  saveScreenerState();
  renderScreener();
}

function clearScreenerFilters() {
  Object.values(screenerFilters).forEach(s => s.clear());
  const s = document.getElementById('screenerSearch'); if (s) s.value = '';
  const c = document.getElementById('screenerCat'); if (c) c.value = '';
  saveScreenerState();
  renderScreener();
}

function renderScreenerFilters() {
  const bar = document.getElementById('screenerFilterBar');
  if (!bar) return;
  const groups = [
    ['seasonal', 'Seasonals', [['bullish', 'Bullish'], ['bearish', 'Bearish'], ['neutral', 'Neutral']]],
    ['cot', 'COT', [['bullish', 'Bullish'], ['bearish', 'Bearish']]],
    ['cot_hedge', 'COT Hedging', [['bullish', 'Bullish'], ['bearish', 'Bearish']]],
    ['structure', 'Term Structure', [['premium', 'Premium'], ['discount', 'Discount']]],
  ];
  bar.innerHTML = groups.map(([sig, label, opts]) => `<div class="filter-group">
      <span class="filter-group-label">${label}</span>
      ${opts.map(([val, txt]) => {
        const on = screenerFilters[sig].has(val);
        const tone = val === 'neutral' ? 'neu' : (val === 'bullish' || val === 'premium') ? 'bull' : 'bear';
        return `<button type="button" class="filter-chip ${tone}${on ? ' on' : ''}" onclick="toggleScreenerFilter('${sig}','${val}')">${txt}</button>`;
      }).join('')}
    </div>`).join('');
}

function screenerToggleWatch(key, event) {
  if (event) event.stopPropagation();
  if (!INDEX[key]) return;
  if (watchlist.includes(key)) watchlist = watchlist.filter(k => k !== key);
  else watchlist.push(key);
  saveWatchlist();
  renderWatchlist();
  renderScreener();
}

function screenerAddAllVisible() {
  let added = 0;
  filteredScreenerRows().forEach(r => {
    if (INDEX[r.key] && !watchlist.includes(r.key)) { watchlist.push(r.key); added++; }
  });
  if (added) { saveWatchlist(); renderWatchlist(); renderScreener(); }
}

function renderScreener() {
  const body = document.getElementById('screenerBody');
  if (!body || !screenerData) return;
  renderScreenerFilters();

  const rows = filteredScreenerRows();
  const { col, dir } = screenerSort;
  const txt = c => (c || '').toLowerCase();
  const catRank = c => { const i = CATEGORY_POPULARITY.indexOf(c); return i === -1 ? 99 : i; };

  const countEl = document.getElementById('screenerCount');
  if (countEl) countEl.textContent = `${rows.length} ${rows.length === 1 ? 'market' : 'markets'}`;
  const addAll = document.getElementById('screenerAddAll');
  if (addAll) {
    const addable = rows.filter(r => INDEX[r.key] && !watchlist.includes(r.key)).length;
    addAll.disabled = addable === 0;
    addAll.textContent = (rows.length && !addable) ? 'All in watchlist ✓'
      : `+ Add all to watchlist${addable ? ` (${addable})` : ''}`;
  }

  if (!rows.length) {
    body.innerHTML = '<div class="screener-empty">No markets match these filters.</div>';
    return;
  }

  // Group like the sidebar: categories as header rows in popularity order, markets
  // beneath. The active column sorts WITHIN each category (default = natural order).
  const withinSort = (a, b) => {
    if (col === 'display_name') {
      const va = txt(a.display_name), vb = txt(b.display_name);
      return va < vb ? -dir : va > vb ? dir : 0;
    }
    if (col === 'seasonal' || col === 'cot' || col === 'cot_hedge' || col === 'structure') {
      return (sigRank(a[col]) - sigRank(b[col])) * dir;
    }
    return 0;
  };
  const groups = {};
  rows.forEach(r => { (groups[r.category] ||= []).push(r); });
  const cats = Object.keys(groups).sort((a, b) => catRank(a) - catRank(b));

  const arrow = c => col === c ? `<span class="arrow">${dir > 0 ? '▲' : '▼'}</span>` : '';
  const th = (c, label) => `<th onclick="sortScreener('${c}')">${label}${arrow(c)}</th>`;
  const starCell = r => {
    const inWatch = watchlist.includes(r.key);
    return `<td class="screener-star"><button type="button" class="wl-star${inWatch ? ' on' : ''}" onclick="screenerToggleWatch('${r.key}', event)" title="${inWatch ? 'Remove from watchlist' : 'Add to watchlist'}">${inWatch ? '★' : '☆'}</button></td>`;
  };

  const bodyHtml = cats.map(cat => {
    const head = `<tr class="screener-cat-head"><td colspan="6">${CAT_ICONS[cat] || ''} ${esc(cat)}</td></tr>`;
    const items = groups[cat].slice().sort(withinSort).map(r => `<tr class="screener-row" onclick="openScreenerMarket('${r.key}')">
        ${starCell(r)}
        <td><span class="screener-name">${esc(r.display_name || r.key)}</span></td>
        <td>${sigBadge(r.seasonal)}</td>
        <td>${sigBadge(r.cot)}</td>
        <td>${sigBadge(r.cot_hedge)}</td>
        <td>${sigBadge(r.structure)}</td>
      </tr>`).join('');
    return head + items;
  }).join('');

  body.innerHTML = `<table>
    <thead><tr>
      <th></th>
      ${th('display_name', 'Market')}
      ${th('seasonal', 'Seasonals')}
      ${th('cot', 'COT')}
      ${th('cot_hedge', 'COT Hedging')}
      ${th('structure', 'Term Structure')}
    </tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>`;
}

function openScreenerMarket(key) {
  if (!INDEX[key]) return;
  switchPage('overview');
  switchCommodity(key);
}

// ── Weekly Outlook: all 4/4 + all 3/4 setups, each annotated with its next seasonal
// event. The 4/4 / 3/4 derivation mirrors content_bot/filter.py's aligned() exactly;
// the seasonal dates come from screener.json's per-market seasonal_event (generator).

const SIG_KEYS = ['seasonal', 'cot', 'cot_hedge', 'structure'];
const SIG_LABEL = { seasonal: 'Seasonals', cot: 'COT', cot_hedge: 'COT Hedging', structure: 'Term Structure' };

// Does a signal value match a direction? structure speaks premium/discount.
function sigMatches(key, val, dir) {
  if (key === 'structure') return dir === 'bullish' ? val === 'premium' : val === 'discount';
  return val === dir;
}
function screenerAlignedCount(r, dir) {
  return SIG_KEYS.reduce((n, k) => n + (sigMatches(k, r[k], dir) ? 1 : 0), 0);
}
// Best-aligned direction with >=3 of 4 signals: { dir, count, missing:[keys] } or null.
function screenerSetup(r) {
  for (const dir of ['bullish', 'bearish']) {
    const count = screenerAlignedCount(r, dir);
    if (count >= 3) return { dir, count, missing: SIG_KEYS.filter(k => !sigMatches(k, r[k], dir)) };
  }
  return null;
}

// Date helpers (date-only, local midnight) so "in N days / next week" is relative to
// the VIEWER's today, not the generation day.
function _midnight(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
function daysUntil(iso) {
  if (!iso) return null;
  const t = new Date(iso + 'T00:00:00');
  if (isNaN(t)) return null;
  return Math.round((_midnight(t) - _midnight(new Date())) / 86400000);
}
function fmtDay(iso) {
  const t = new Date(iso + 'T00:00:00');
  if (isNaN(t)) return iso || '–';
  const sameYear = t.getFullYear() === new Date().getFullYear();
  return t.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: '2-digit' }
    : { month: 'short', day: '2-digit', year: 'numeric' });
}
function fmtDaysAway(n) { return n == null ? '' : n <= 0 ? 'now' : `in ${n}d`; }

function seasonalNote(r, setup) {
  const ev = r.seasonal_event;
  if (!ev || !ev.date) return '<span class="wk-seasonal wk-muted">no seasonal (insufficient history)</span>';
  const n = daysUntil(ev.date);
  const dirCls = ev.direction === 'bullish' ? 'wk-bull' : 'wk-bear';
  if (ev.type === 'onset') {
    const completes = setup && setup.count === 3 && setup.missing.includes('seasonal') && ev.direction === setup.dir;
    return `📅 <span class="wk-seasonal">Seasonal onset ${fmtDay(ev.date)} <span class="wk-away">(${fmtDaysAway(n)})</span> → <span class="${dirCls}">${ev.direction}</span>${completes ? ' <span class="wk-complete">→ 4/4</span>' : ''}</span>`;
  }
  return `📅 <span class="wk-seasonal">Seasonal <span class="${dirCls}">${ev.direction}</span> until ${fmtDay(ev.date)} <span class="wk-away">(${fmtDaysAway(n)})</span></span>`;
}

// End of the current week — the coming Sunday (ISO week Mon–Sun) at local midnight.
function endOfThisWeek() {
  const t = _midnight(new Date());
  t.setDate(t.getDate() + ((7 - t.getDay()) % 7));   // getDay: 0=Sun -> 0 days, else days to Sunday
  return t;
}
// Monday of the current week at local midnight.
function startOfThisWeek() {
  const t = _midnight(new Date());
  t.setDate(t.getDate() - ((t.getDay() + 6) % 7));   // days since Monday (Sun=6)
  return t;
}
// ISO-8601 week number (the German "KW").
function isoWeekNumber(d) {
  const x = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7) + 3);   // to this week's Thursday
  const firstThu = new Date(Date.UTC(x.getUTCFullYear(), 0, 4));
  firstThu.setUTCDate(firstThu.getUTCDate() - ((firstThu.getUTCDay() + 6) % 7) + 3);
  return 1 + Math.round((x - firstThu) / (7 * 864e5));
}
// The selected Weekly-Outlook week (this or next) as calendar bounds + the onset
// window. For THIS week the onset window starts today (earlier onsets already fired);
// for NEXT week it's the whole Mon–Sun. Each seasonal run is >= 14 days, so a market
// has at most one onset per week — the per-market next-event data is enough.
function selectedWeekRange() {
  const mon = startOfThisWeek(), sun = endOfThisWeek();
  if (screenerWeekSel === 1) {
    const nMon = new Date(mon); nMon.setDate(nMon.getDate() + 7);
    const nSun = new Date(sun); nSun.setDate(nSun.getDate() + 7);
    return { calStart: nMon, calEnd: nSun, onsetStart: nMon, onsetEnd: nSun };
  }
  return { calStart: mon, calEnd: sun, onsetStart: _midnight(new Date()), onsetEnd: sun };
}
// 3/4 market whose seasonal switches on within [start,end] in the matching direction
// -> it becomes a fresh 4/4 in that week.
function onsetInWindow(r, setup, start, end) {
  const ev = r.seasonal_event;
  if (!ev || ev.type !== 'onset' || !setup) return false;
  if (!(setup.count === 3 && setup.missing.includes('seasonal'))) return false;
  if (ev.direction !== setup.dir) return false;      // onset must match the other 3 -> a real 4/4
  const d = new Date(ev.date + 'T00:00:00');
  if (isNaN(d)) return false;
  return _midnight(d) >= start && _midnight(d) <= end;
}

// One result as a self-contained block: prominent market name + price basis,
// the four labelled signal chips, the seasonal note, and (4/4 only) the chart.
function wkBlock(r, setup, withChart) {
  const dot = setup.dir === 'bullish' ? '🟢' : '🔴';
  const miss = setup.missing.length
    ? `<span class="wk-block-miss">missing: ${setup.missing.map(k => SIG_LABEL[k]).join(', ')}</span>` : '';
  // The weekly chart always plots the continuous contract.
  const basis = withChart ? '<span class="wk-basis">Continuous</span>' : '';
  const sigs = SIG_KEYS.map(k =>
    `<span class="wk-sig-chip${setup.missing.includes(k) ? ' wk-badge-miss' : ''}">`
    + `<span class="wk-sig-lbl">${SIG_LABEL[k]}</span>${sigBadge(r[k])}</span>`).join('');
  const chart = withChart ? wkChartHtml(r, setup) : '';
  return `<div class="wk-block">
      <div class="wk-block-head">
        <div class="wk-block-id" onclick="openScreenerMarket('${r.key}')">
          <span class="wk-block-name">${dot} ${esc(r.display_name || r.key)}</span>${basis}
        </div>
        ${miss}
      </div>
      <div class="wk-block-sigs">${sigs}</div>
      <div class="wk-block-note">${seasonalNote(r, setup)}</div>
      ${chart}
    </div>`;
}

// The lazy inline 4/4 chart container for one block (4/4 section only).
function wkChartHtml(r, setup) {
  const meta = INDEX[r.key];
  const slug = meta ? meta.slug : '';
  return `<div class="wk-chart" data-key="${esc(r.key)}" data-slug="${esc(slug)}" data-dir="${esc(setup.dir)}"></div>`;
}

// Render one Weekly-Outlook section grouped by category (same order as the Daily
// Outlook, CATEGORY_POPULARITY), each result as its own block.
function wkCategorySection(title, items, emptyMsg, withChart) {
  const header = `<div class="wk-section-title">${title} <span class="wk-count">(${items.length})</span></div>`;
  if (!items.length) return header + `<div class="screener-empty">${emptyMsg}</div>`;
  const catRank = c => { const i = CATEGORY_POPULARITY.indexOf(c); return i === -1 ? 99 : i; };
  const groups = {};
  items.forEach(x => { (groups[x.r.category] ||= []).push(x); });
  const cats = Object.keys(groups).sort((a, b) => catRank(a) - catRank(b));
  const body = cats.map(cat => {
    const head = `<div class="wk-cat-head">${CAT_ICONS[cat] || ''} ${esc(cat)}</div>`;
    const blocks = groups[cat].slice()
      .sort((a, b) => (a.r.display_name || '').localeCompare(b.r.display_name || ''))
      .map(x => wkBlock(x.r, x.setup, withChart)).join('');
    return head + blocks;
  }).join('');
  return header + `<div class="wk-blocks">${body}</div>`;
}

function renderWeeklyOutlook() {
  const body = document.getElementById('screenerWeeklyBody');
  if (!body || !screenerData) return;

  const wk = selectedWeekRange();
  const weekWord = screenerWeekSel === 1 ? 'next week' : 'this week';

  const full = [], onsets = [];
  for (const r of screenerData) {
    const setup = screenerSetup(r);
    if (!setup) continue;
    if (setup.count === 4) full.push({ r, setup });
    else if (onsetInWindow(r, setup, wk.onsetStart, wk.onsetEnd)) onsets.push({ r, setup });
  }

  document.querySelectorAll('#screenerWeekly .wk-week-btn').forEach(btn =>
    btn.classList.toggle('on', Number(btn.dataset.week) === screenerWeekSel));
  const wkEl = document.getElementById('screenerWeekLabel');
  if (wkEl) {
    const f = d => d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    wkEl.textContent = `📅 Week ${isoWeekNumber(wk.calStart)} · ${f(wk.calStart)} – ${wk.calEnd.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}`;
  }
  const countEl = document.getElementById('screenerWeeklyCount');
  if (countEl) countEl.textContent = `${full.length} × 4/4 · ${onsets.length} ${onsets.length === 1 ? 'onset' : 'onsets'} ${weekWord}`;

  body.innerHTML =
    wkCategorySection('4/4 Setups', full, 'No 4/4 setup right now.', true)
    + wkCategorySection(`3/4 → turns 4/4 ${weekWord} via seasonal`, onsets,
        `No seasonal lifts a 3/4 setup to 4/4 ${weekWord}.`, false);

  wkObserveCharts();   // lazy-render the 4/4 charts as they scroll into view
}

// ── Weekly Outlook inline 4/4 charts (native, dynamic, lazy) ──────────────────

// The bot's 4/4 period log, fetched once. Holds {key: {periods:[{direction,start,
// end}], runway:{days,until}}} — `start` is the day the 4/4 first triggered.
async function ensureFourFourLog() {
  if (_wkFourFourLog) return _wkFourFourLog;
  try {
    const res = await fetch(`${DATA_DIR}/four_four_log.json?v=${DATA_VERSION}`, { cache: 'no-store' });
    _wkFourFourLog = res.ok ? (await res.json()) : {};
  } catch (e) { _wkFourFourLog = {}; }
  return _wkFourFourLog;
}

// (Re)wire lazy rendering for the charts in the current weekly render, and bind a
// one-time debounced resize that redraws already-rendered charts at the new width.
function wkObserveCharts() {
  if (_wkChartObserver) _wkChartObserver.disconnect();
  _wkChartObserver = new IntersectionObserver(entries => {
    entries.forEach(e => {
      if (!e.isIntersecting) return;
      _wkChartObserver.unobserve(e.target);
      wkRenderChart(e.target);
    });
  }, { rootMargin: '140px 0px' });
  document.querySelectorAll('#screenerWeeklyBody .wk-chart').forEach(el => _wkChartObserver.observe(el));

  if (!_wkResizeBound) {
    let t = null;
    window.addEventListener('resize', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        if (document.getElementById('screenerWeekly')?.hidden) return;
        document.querySelectorAll('#screenerWeeklyBody .wk-chart[data-rendered]').forEach(wkDrawChart);
      }, 150);
    });
    _wkResizeBound = true;
  }
}

// Lazy entry point: load the 4/4 log + the market's category data, then draw.
async function wkRenderChart(el) {
  const key = el.dataset.key, meta = INDEX[key];
  if (!meta) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="wk-chart-loading">Loading chart …</div>';
  await ensureFourFourLog();
  const cat = await loadCategory(meta.slug);
  const cfg = cat && cat[key];
  const bars = (cfg && cfg.continuous_contract && cfg.continuous_contract.history) || [];
  if (!bars.length) { el.innerHTML = '<div class="wk-chart-empty">No chart history available.</div>'; return; }
  el.dataset.rendered = '1';
  wkDrawChart(el);
}

// Draw (or redraw) the chart in the Futures-tab layout — rounded background, round-
// level price grid, themed candles, bottom date axis — plus the 4/4 band + entry/
// drop markers from the bot log. Synchronous + sized to the live container width,
// so resize just re-runs this. Mirrors the native chart in chart.js / forex.js.
function wkDrawChart(el) {
  const key = el.dataset.key, dir = el.dataset.dir, meta = INDEX[key];
  const cfg = meta && catCache[meta.slug] && catCache[meta.slug][key];
  const all = (cfg && cfg.continuous_contract && cfg.continuous_contract.history) || [];
  if (!all.length) return;
  const logEntry = (_wkFourFourLog || {})[key] || {};
  const periods = Array.isArray(logEntry.periods) ? logEntry.periods : [];
  // The period that drives the caption + view window: prefer the open one in `dir`.
  const lead = periods.find(p => !p.end && p.direction === dir)
            || periods.filter(p => p.direction === dir).slice(-1)[0]
            || periods.slice(-1)[0] || null;

  // Window: ~12 months (Futures default range), extended to include the 4/4 start.
  const ms = iso => new Date(iso + 'T00:00:00').getTime();
  let from = Math.max(0, all.length - 252);
  if (lead && lead.start) {
    const si = all.findIndex(b => ms(b.date) >= ms(lead.start));
    if (si >= 0) from = Math.min(from, Math.max(0, si - 12));
  }
  const bars = all.slice(from), n = bars.length;

  // Geometry — Futures price-pane proportions, dynamic to the container width.
  const W = Math.max(320, Math.round(el.clientWidth || (el.parentElement && el.parentElement.clientWidth) || 720));
  const padL = 52, padR = 56, padT = 10;
  const priceH = Math.round(W * 0.38);
  const innerW = W - padL - padR;
  const edgePad = Math.max(24, Math.min(56, Math.round(innerW * 0.05)));
  const plotW = Math.max(120, innerW - edgePad * 2);
  const slot = plotW / n;
  const candleW = Math.max(1, Math.min(12, slot * 0.7));
  const xAt = i => padL + edgePad + slot * (i + 0.5);
  const barXs = bars.map((_, i) => xAt(i));
  const tms = bars.map(b => ms(b.date));
  const nearestIdx = t => { let best = 0, d = Math.abs(tms[0] - t); for (let i = 1; i < n; i++) { const e = Math.abs(tms[i] - t); if (e < d) { d = e; best = i; } } return best; };

  // Price scale (Futures: 5% headroom top + bottom).
  const pMin = Math.min(...bars.map(b => b.low)), pMax = Math.max(...bars.map(b => b.high));
  const pRng = (pMax - pMin) || 1, pPad = pRng * 0.05;
  const pLo = pMin - pPad, pHi = pMax + pPad, pSpan = pHi - pLo;
  const pY = v => padT + (1 - (v - pLo) / pSpan) * priceH;
  const last = bars[n - 1].close;
  const dec = (cfg.tick_decimals != null) ? cfg.tick_decimals : (last >= 100 ? 2 : last >= 1 ? 3 : 5);

  // Round-level price grid (Futures look: 1/2/2.5/5/10 multiples, ~3–7 lines).
  const rawStep = pSpan / 5, mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let levelStep = mag;
  for (const c of [1, 2, 2.5, 5, 10].map(m => m * mag)) { if (pSpan / c <= 7) { levelStep = c; break; } }
  let grid = '';
  for (let lv = Math.ceil(pLo / levelStep) * levelStep; lv <= pHi; lv += levelStep) {
    const v = Math.round(lv / levelStep) * levelStep;          // smooth FP noise
    if (v < pLo || v > pHi) continue;
    const y = pY(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="2,4" opacity="0.78"/>`
      + `<text x="${W - padR + 5}" y="${(+y + 3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${v.toFixed(dec)}</text>`;
  }

  // 4/4 band + entry/drop markers (all periods in view), behind candles — same as card-mode.
  const t0 = tms[0], t1 = tms[n - 1];
  let bands = '', marks = '';
  periods.forEach(p => {
    const ps = ms(p.start), pe = p.end ? ms(p.end) : t1;
    if (pe < t0 || ps > t1) return;
    const i1 = nearestIdx(ps), i2 = p.end ? nearestIdx(pe) : n - 1;
    const x1 = barXs[i1], x2 = barXs[i2], col = p.direction === 'bullish' ? '#16a34a' : '#dc2626';
    if (x2 > x1) bands += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${(x2 - x1).toFixed(1)}" height="${priceH}" fill="${col}" opacity="0.18"/>`;
    const b = bars[i1], mx = x1;
    if (b) {
      if (p.direction === 'bullish') { const y = pY(b.low) + 6; marks += `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y + 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y + 11).toFixed(1)} Z" fill="${CHART_THEME.bull}" stroke="#fff" stroke-width="0.8"/>`; }
      else { const y = pY(b.high) - 6; marks += `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y - 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y - 11).toFixed(1)} Z" fill="${CHART_THEME.bear}" stroke="#fff" stroke-width="0.8"/>`; }
    }
    if (p.end) {
      const eb = bars[i2], ex = x2;
      if (eb) { const ey = p.direction === 'bullish' ? pY(eb.high) - 13 : pY(eb.low) + 13;
        marks += `<g fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round">`
          + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6.5" stroke="#fff" stroke-width="3.4"/>`
          + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6.5"/>`
          + `<line x1="${(ex - 3).toFixed(1)}" y1="${(ey - 3).toFixed(1)}" x2="${(ex + 3).toFixed(1)}" y2="${(ey + 3).toFixed(1)}"/>`
          + `<line x1="${(ex - 3).toFixed(1)}" y1="${(ey + 3).toFixed(1)}" x2="${(ex + 3).toFixed(1)}" y2="${(ey - 3).toFixed(1)}"/></g>`;
      }
    }
  });

  // Candles (Futures theme: blue up / red down + lighter wicks).
  let candles = '';
  for (let i = 0; i < n; i++) {
    const b = bars[i], x = xAt(i), up = b.close >= b.open;
    const col = up ? CHART_THEME.bull : CHART_THEME.bear, wickCol = up ? CHART_THEME.bullWick : CHART_THEME.bearWick;
    const yO = pY(b.open), yC = pY(b.close);
    candles += `<line x1="${x.toFixed(1)}" y1="${pY(b.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${pY(b.low).toFixed(1)}" stroke="${wickCol}" stroke-width="1"/>`
      + `<rect x="${(x - candleW / 2).toFixed(1)}" y="${Math.min(yO, yC).toFixed(1)}" width="${candleW.toFixed(1)}" height="${Math.max(1, Math.abs(yC - yO)).toFixed(1)}" fill="${col}" stroke="${col}" stroke-width="0.5"/>`;
  }

  // Bottom date axis (6 ticks, like the Futures chart).
  const axisY = padT + priceH, totalH = axisY + 24;
  let xLabels = '';
  for (let g = 0; g <= 5; g++) {
    const i = Math.round((n - 1) * g / 5);
    xLabels += `<text x="${xAt(i).toFixed(1)}" y="${(totalH - 6).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora" text-anchor="middle">${bars[i].date.slice(2)}</text>`;
  }
  const chartBg = `<rect x="0" y="0" width="${W}" height="${totalH}" fill="${CHART_THEME.bg}" rx="7"/>`;

  const svg = `<svg class="wk-chart-svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" preserveAspectRatio="xMinYMin meet">`
    + `${chartBg}${bands}${grid}${candles}${marks}${xLabels}</svg>`;

  // Caption: when the 4/4 first triggered + seasonal runway.
  let cap;
  if (lead && lead.start) {
    const age = -daysUntil(lead.start), dot = lead.direction === 'bullish' ? '🟢' : '🔴';
    const dcls = lead.direction === 'bullish' ? 'wk-bull' : 'wk-bear';
    cap = `${dot} <span class="${dcls}">${lead.direction}</span> · 4/4 since ${fmtDay(lead.start)}${age >= 0 ? ` <span class="wk-away">(${age}d active)</span>` : ''}`;
    const rw = logEntry.runway;
    if (rw && rw.days && rw.until) cap += ` · 📅 Seasonal supports ~${rw.days}d more (until ${fmtDay(rw.until)})`;
  } else {
    cap = `<span class="wk-muted">4/4 active · start date follows on the next bot run</span>`;
  }

  el.innerHTML = `<div class="wk-chart-caption">${cap}</div>${svg}`;
}

// ── FX strength & pairing (built from the same screener signals) ──
// Each USD-quoted future bullish = that currency strong vs USD; USDX = USD strength.
// For a cross pair the USD denominator cancels, so bias = score(long) - score(short).
