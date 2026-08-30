let screenerData = null;
function resetScreenerData() { screenerData = null; }
let screenerSort = { col: 'category', dir: 1 };
const screenerFilters = { seasonal: new Set(), cot_hedge: new Set(), structure: new Set() };
let screenerView = 'daily';   // 'daily' (live screener) | 'weekly' (3/3 + 2/3 outlook)
let screenerWeekSel = 0;      // Weekly Outlook: 0 = this week, 1 = next week

// Weekly Outlook inline charts: the bot's 3/3 period log (start = "when first
// triggered") is reused to shade the 3/3 band + entry/drop markers. Charts render
// lazily (IntersectionObserver) and redraw on resize so they stay crisp/dynamic.
let _wkThreeThreeLog = null;     // cached ff_data/three_three_log.json ({} if absent)
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
  if (st.sort && st.sort.col && ['category', 'display_name', 'seasonal', 'cot_hedge', 'structure'].includes(st.sort.col)) screenerSort = { col: st.sort.col, dir: st.sort.dir === -1 ? -1 : 1 };
  if (st.filters) {
    for (const sig of ['seasonal', 'cot_hedge', 'structure']) {
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
    const res = await fetch(`${DATA_DIR}/screener.json?v=${DATA_VERSION}&r=${_dataReloadNonce}`, { cache: 'no-store' });
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

// Switch between Daily Outlook (live screener) and Weekly Outlook (3/3 + 2/3 report).
function setScreenerView(view) {
  screenerView = (view === 'weekly') ? 'weekly' : 'daily';
  saveScreenerState();
  applyScreenerView();
}

// Weekly Outlook: switch the shown week (this / next).
function setScreenerWeek(sel) {
  screenerWeekSel = sel ? 1 : 0;
  renderWeeklyOutlook();
  if (typeof restartLiveLayer === 'function') restartLiveLayer();   // re-resolve live 3/3 charts
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
  // Live 3/3 charts only in the Weekly Outlook; restart re-reads the active page mode.
  if (typeof restartLiveLayer === 'function') restartLiveLayer();
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
    for (const sig of ['seasonal', 'cot_hedge', 'structure']) {
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
    if (col === 'seasonal' || col === 'cot_hedge' || col === 'structure') {
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
    const head = `<tr class="screener-cat-head"><td colspan="5">${CAT_ICONS[cat] || ''} ${esc(cat)}</td></tr>`;
    const items = groups[cat].slice().sort(withinSort).map(r => `<tr class="screener-row" onclick="openScreenerMarket('${r.key}')">
        ${starCell(r)}
        <td><span class="screener-name">${esc(r.display_name || r.key)}</span></td>
        <td>${sigBadge(r.seasonal)}</td>
        <td>${sigBadge(r.cot_hedge)}</td>
        <td class="sig-structure">${sigBadge(r.structure)}</td>
      </tr>`).join('');
    return head + items;
  }).join('');

  body.innerHTML = `<table>
    <thead><tr>
      <th></th>
      ${th('display_name', 'Market')}
      ${th('seasonal', 'Seasonals')}
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

// ── Weekly Outlook: all 3/3 + all 2/3 setups, each annotated with its next seasonal
// event. The 3/3 / 2/3 derivation mirrors chartbot/filter.py's aligned(): |score| == 3;
// the seasonal dates come from screener.json's per-market seasonal_event (generator).

const SIG_KEYS = ['seasonal', 'cot_hedge', 'structure'];
const SIG_LABEL = { seasonal: 'Seasonals', cot_hedge: 'COT Hedging', structure: 'Term Structure' };
// Compact labels for the Weekly block's signal strip (the band is tighter than the table).
const WK_SIG_SHORT = { seasonal: 'Seasonals', cot_hedge: 'Hedging', structure: 'Structure' };

// Does a signal value match a direction? structure speaks premium/discount.
function sigMatches(key, val, dir) {
  if (key === 'structure') return dir === 'bullish' ? val === 'premium' : val === 'discount';
  return val === dir;
}
function screenerAlignedCount(r, dir) {
  return SIG_KEYS.reduce((n, k) => n + (sigMatches(k, r[k], dir) ? 1 : 0), 0);
}
// Best-aligned direction with >=2 of 3 signals: { dir, count, missing:[keys] } or null.
// This is the ONE place the frontend still derives the alignment itself instead of
// reading the generator's `score`: the Weekly Outlook feeds it rows whose seasonal has
// been projected to a future week (projectSeasonal), which the generator never scored.
// It also needs `missing` to decide whether a seasonal onset completes the setup.
// Everywhere the row is unprojected (forex.js), read r.score instead.
function screenerSetup(r) {
  for (const dir of ['bullish', 'bearish']) {
    const count = screenerAlignedCount(r, dir);
    if (count >= 2) return { dir, count, missing: SIG_KEYS.filter(k => !sigMatches(k, r[k], dir)) };
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
    const completes = setup && setup.count === 2 && setup.missing.includes('seasonal') && ev.direction === setup.dir;
    return `📅 <span class="wk-seasonal">Seasonal onset ${fmtDay(ev.date)} <span class="wk-away">(${fmtDaysAway(n)})</span> → <span class="${dirCls}">${ev.direction}</span>${completes ? ' <span class="wk-complete">→ 3/3</span>' : ''}</span>`;
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
// The selected Weekly-Outlook week (this or next) as calendar bounds (Mon–Sun).
function selectedWeekRange() {
  const mon = startOfThisWeek(), sun = endOfThisWeek();
  if (screenerWeekSel === 1) {
    const nMon = new Date(mon); nMon.setDate(nMon.getDate() + 7);
    const nSun = new Date(sun); nSun.setDate(nSun.getDate() + 7);
    return { calStart: nMon, calEnd: nSun };
  }
  return { calStart: mon, calEnd: sun };
}
// Project a market's seasonal signal forward to the START of the selected week, using its
// seasonal_event, so the 3/3 vote reflects that week rather than the generation day:
//   • offset on/before the week's Monday → the seasonal run has ended  → seasonal = neutral
//   • onset  on/before the week's Monday → the seasonal run has begun   → seasonal = its dir
// Events inside or after the week leave the seasonal unchanged (handled as a live 3/3 with a
// runway note, or — for an onset within the week — as a 2/3→3/3 transition below). This makes
// the weekly 3/3 set symmetric: setups whose seasonal expires by the week drop out, and 2/3
// setups whose seasonal has turned on by the week join in. Each seasonal run is >= 14 days, so
// a market has at most one event per week — the per-market next-event data is enough.
function projectSeasonal(r, weekStart) {
  const ev = r.seasonal_event;
  if (!ev || !ev.date) return r;
  const d = new Date(ev.date + 'T00:00:00');
  if (isNaN(d) || _midnight(d) > _midnight(weekStart)) return r;
  // r.score is the generator's signed score over the row's UNPROJECTED seasonal —
  // once seasonal is overridden below it would contradict the projected row's own
  // signals, so drop it rather than recompute (recomputing would duplicate the
  // scoring rule that now lives solely in screener_score() generator-side).
  const { score, ...rest } = r;
  if (ev.type === 'offset') return { ...rest, seasonal: 'neutral' };
  if (ev.type === 'onset') return { ...rest, seasonal: ev.direction };
  return r;
}

// 2/3 market whose seasonal switches on within [start,end] in the matching direction
// -> it becomes a fresh 3/3 in that week.
function onsetInWindow(r, setup, start, end) {
  const ev = r.seasonal_event;
  if (!ev || ev.type !== 'onset' || !setup) return false;
  if (!(setup.count === 2 && setup.missing.includes('seasonal'))) return false;
  if (ev.direction !== setup.dir) return false;      // onset must match the other 2 -> a real 3/3
  const d = new Date(ev.date + 'T00:00:00');
  if (isNaN(d)) return false;
  return _midnight(d) >= start && _midnight(d) <= end;
}

// One result as an editorial block: a header band — prominent serif name, a conviction
// emblem (direction-tinted dots + N/3) beside the contract basis, a direction badge, the
// three labelled signal tags, and ONE consolidated stat line — above the full-width chart.
// The stat line replaces the old separate seasonal-note + chart-caption (which duplicated
// each other); see wkStatLine. The basis + live-state spans are filled by wkDrawChart.
function wkBlock(r, setup, withChart) {
  const dirCls = setup.dir === 'bullish' ? 'bull' : 'bear';
  const dirArrow = setup.dir === 'bullish' ? '▲' : '▼';
  const dirWord = setup.dir === 'bullish' ? 'Bullish' : 'Bearish';
  const dots = [0, 1, 2].map(i => `<span class="wk-dot${i < setup.count ? ' on' : ''}"></span>`).join('');
  // Three labelled tags sharing the Daily tab's language: ▲/▼ for bull/bear, a quiet dash
  // for neutral; the missing signal of a 2/3 onset is dimmed. Term structure speaks
  // premium/discount and renders as an outline tag (a different axis from the others).
  const strip = SIG_KEYS.map(k => {
    const v = r[k];
    const tone = (k === 'structure')
      ? (v === 'premium' ? 'up' : v === 'discount' ? 'down' : 'na')
      : (v === 'bullish' ? 'up' : v === 'bearish' ? 'down' : 'na');
    const glyph = tone === 'up' ? '▲' : tone === 'down' ? '▼' : '–';
    const cls = `wk-sig2 ${tone}${k === 'structure' ? ' struct' : ''}${setup.missing.includes(k) ? ' miss' : ''}`;
    return `<span class="${cls}"><span class="wk-sig2-lbl">${WK_SIG_SHORT[k]}</span><span class="wk-sig2-mark">${glyph}</span></span>`;
  }).join('');
  const meta = `<span class="wk-conv"><span class="wk-dots">${dots}</span><span class="wk-conv-label">${setup.count}/3</span></span>`
    + (withChart ? '<span class="wk-basis"></span><span class="wk-live-state" hidden></span>' : '');
  const chart = withChart ? wkChartHtml(r, setup) : '';
  return `<div class="wk-block wk-dir-${dirCls}">
      <div class="wk-band">
        <div class="wk-band-top">
          <div class="wk-block-id" onclick="openScreenerMarket('${r.key}')">
            <span class="wk-block-name">${esc(r.display_name || r.key)}</span>
          </div>
          <div class="wk-band-meta">${meta}</div>
        </div>
        <div class="wk-band-dir"><span class="wk-dir-badge ${dirCls}">${dirArrow} ${dirWord}</span></div>
        <div class="wk-band-sigs">${strip}</div>
        <div class="wk-band-stat">${wkStatLine(r, setup)}</div>
      </div>
      ${chart}
    </div>`;
}

// The consolidated header stat line. For a 2/3 onset it reuses the seasonal "→ 3/3" note.
// For a live 3/3 it reads the bot's period log (when the setup first triggered + the
// seasonal runway). Before the log has loaded — or when no period is recorded yet — it
// falls back to the seasonal note; renderWeeklyOutlook re-renders once the log lands.
function wkStatLine(r, setup) {
  if (setup.count < 3) return seasonalNote(r, setup);
  const logEntry = (_wkThreeThreeLog || {})[r.key] || {};
  const periods = Array.isArray(logEntry.periods) ? logEntry.periods : [];
  const lead = periods.find(p => !p.end && p.direction === setup.dir)
            || periods.filter(p => p.direction === setup.dir).slice(-1)[0]
            || periods.slice(-1)[0] || null;
  if (lead && lead.start) {
    const age = -daysUntil(lead.start);
    let s = `<span class="wk-stat-strong">Active ${age >= 0 ? age : 0}d</span>`
          + `<span class="wk-stat-sep">·</span>since ${fmtDay(lead.start)}`;
    const rw = logEntry.runway;
    if (rw && rw.days && rw.until) {
      s += `<span class="wk-stat-sep">·</span><span class="wk-stat-run">⏳ Seasonal ~${rw.days}d</span> <span class="wk-stat-dim">(until ${fmtDay(rw.until)})</span>`;
    } else if (r.seasonal_event && r.seasonal_event.date) {
      s += `<span class="wk-stat-sep">·</span>${seasonalNote(r, setup)}`;
    }
    return s;
  }
  return (r.seasonal_event && r.seasonal_event.date)
    ? seasonalNote(r, setup)
    : `<span class="wk-muted">3/3 active · details follow on the next bot run</span>`;
}

// The lazy inline 3/3 chart container for one block (3/3 section only).
function wkChartHtml(r, setup) {
  const meta = INDEX[r.key];
  const slug = meta ? meta.slug : '';
  return `<div class="wk-chart" data-key="${esc(r.key)}" data-slug="${esc(slug)}" data-dir="${esc(setup.dir)}"></div>`;
}

// Render one Weekly-Outlook section: a heading + a flat list of result blocks (no
// category headers — the blocks just sit one under another with breathing room between
// them), ordered by category popularity then market name so related markets still cluster.
function wkCategorySection(title, items, emptyMsg, withChart) {
  const header = title ? `<div class="wk-section-title">${title} <span class="wk-count">(${items.length})</span></div>` : '';
  if (!items.length) return header + `<div class="screener-empty">${emptyMsg}</div>`;
  const catRank = c => { const i = CATEGORY_POPULARITY.indexOf(c); return i === -1 ? 99 : i; };
  const body = items.slice()
    .sort((a, b) => (catRank(a.r.category) - catRank(b.r.category))
      || (a.r.display_name || '').localeCompare(b.r.display_name || ''))
    .map(x => wkBlock(x.r, x.setup, withChart)).join('');
  return header + `<div class="wk-blocks">${body}</div>`;
}

// The Weekly-Outlook result sets for the selected week: 3/3 setups (`full`) and the 2/3s that
// turn 3/3 via seasonal onset (`onsets`). Each entry is { r: projectedRow, setup }. Pure read of
// screenerData — shared by renderWeeklyOutlook and the cold-start boot splash (which prefetches
// every 3/3 result's live price before revealing the dashboard).
function weeklyOutlookSetups() {
  const full = [], onsets = [];
  if (!screenerData) return { full, onsets };
  const wk = selectedWeekRange();
  for (const r of screenerData) {
    // Seasonal projected to the selected week's start: 3/3s whose seasonal has expired by
    // then drop out, and 2/3s whose seasonal has turned on by then join in (symmetric).
    const pr = projectSeasonal(r, wk.calStart);
    const setup = screenerSetup(pr);
    if (!setup) continue;
    if (setup.count === 3) full.push({ r: pr, setup });
    else if (onsetInWindow(pr, setup, wk.calStart, wk.calEnd)) onsets.push({ r: pr, setup });
  }
  return { full, onsets };
}

function renderWeeklyOutlook() {
  const body = document.getElementById('screenerWeeklyBody');
  if (!body || !screenerData) return;

  // The header stat line reads the bot's 3/3 period log (also used by the charts). If it
  // hasn't loaded yet, fetch it and re-render once it lands so "Active / since / runway"
  // fill in — the first paint shows the seasonal note as a graceful fallback.
  if (_wkThreeThreeLog === null) {
    ensureThreeThreeLog().then(() => {
      if (!document.getElementById('screenerWeekly')?.hidden) renderWeeklyOutlook();
    });
  }

  const wk = selectedWeekRange();
  const weekWord = screenerWeekSel === 1 ? 'next week' : 'this week';

  const { full, onsets } = weeklyOutlookSetups();

  document.querySelectorAll('#screenerWeekly .wk-week-btn').forEach(btn =>
    btn.classList.toggle('on', Number(btn.dataset.week) === screenerWeekSel));
  const wkEl = document.getElementById('screenerWeekLabel');
  if (wkEl) {
    const f = d => d.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    wkEl.textContent = `📅 Week ${isoWeekNumber(wk.calStart)} · ${f(wk.calStart)} – ${wk.calEnd.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' })}`;
  }
  const countEl = document.getElementById('screenerWeeklyCount');
  if (countEl) countEl.textContent = `${full.length} × 3/3 · ${onsets.length} ${onsets.length === 1 ? 'onset' : 'onsets'} ${weekWord}`;

  body.innerHTML =
    wkCategorySection('', full, 'No 3/3 setup right now.', true)
    + wkCategorySection(`2/3 → turns 3/3 ${weekWord} via seasonal`, onsets,
        `No seasonal lifts a 2/3 setup to 3/3 ${weekWord}.`, false);

  wkObserveCharts();   // lazy-render the 3/3 charts as they scroll into view
}

// ── Weekly Outlook inline 3/3 charts (native, dynamic, lazy) ──────────────────

// The bot's 3/3 period log, fetched once. Holds {key: {periods:[{direction,start,
// end}], runway:{days,until}}} — `start` is the day the 3/3 first triggered.
async function ensureThreeThreeLog() {
  if (_wkThreeThreeLog) return _wkThreeThreeLog;
  try {
    const res = await fetch(`${DATA_DIR}/three_three_log.json?v=${DATA_VERSION}`, { cache: 'no-store' });
    _wkThreeThreeLog = res.ok ? (await res.json()) : {};
  } catch (e) { _wkThreeThreeLog = {}; }
  return _wkThreeThreeLog;
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

// ── Front-month series for the Weekly-Outlook 3/3 charts ──────────────────────
// These charts plot the current FRONT-MONTH contract (e.g. CLN26), not the native
// continuous: the LEAD (highest-volume) contract's own daily history, lazily fetched
// via /api/contract-history (reusing the Futures-tab loader, cached on the contract).
// Markets without a tradable front contract (e.g. the USDX proxy) fall back to the
// native continuous.
// The lead is `frontContractIndex` — the same definition switchCommodity opens the
// Futures chart on and the FRONT badge marks. Taking the nearest *expiry* instead drew
// the dying month once liquidity had rolled forward (corn in August: Sep 193k lots on
// screen while Dec traded 409k; gold GCQ26 478 vs GCZ26 186k).
function wkFrontContract(cfg) {
  const cs = (cfg && cfg.contracts) || [];
  const idx = (typeof frontContractIndex === 'function') ? frontContractIndex(cs) : -1;
  return (idx >= 0 ? cs[idx] : null) || cs.find(c => c && c.available && c.yf_symbol) || cs[0] || null;
}

// Synchronously resolve which bars a weekly chart draws: the front contract's own
// history once it has been loaded (front-month mode), else the native continuous
// (fallback, or while the front fetch is still in flight). Pure read — never fetches.
function wkResolveSeries(cfg) {
  const front = wkFrontContract(cfg);
  const fh = front && front.chart_history;
  if (front && front.yf_symbol && fh && fh.length) return { bars: fh, mode: 'front', front };
  const cont = (typeof getContinuousContract === 'function') ? (getContinuousContract(cfg) || {}) : (cfg.continuous_contract || {});
  return { bars: cont.history || [], mode: 'continuous', front: null, cont };
}

// Lazily load the front contract's daily history (cached on the contract). No-op when
// the market has no tradable front contract (-> continuous) or it's already loaded.
async function wkEnsureFrontHistory(cfg) {
  const front = wkFrontContract(cfg);
  if (!front || !front.yf_symbol) return;
  if (front.chart_history && front.chart_history.length) return;
  try {
    if (typeof fetchContractHistory === 'function') { await fetchContractHistory(front); return; }
    const period = (typeof CONTRACT_HISTORY_PERIOD !== 'undefined') ? CONTRACT_HISTORY_PERIOD : '5y';
    const res = await fetch(`/api/contract-history?symbol=${encodeURIComponent(front.yf_symbol)}&period=${period}`);
    const payload = await res.json().catch(() => ({}));
    if (res.ok && Array.isArray(payload.history)) front.chart_history = payload.history;
  } catch (e) { /* fall back to continuous */ }
}

// ── Live overlay for the Weekly-Outlook 3/3 charts ───────────────────────────
// The yfinance symbol a given .wk-chart plots: its market's front-month contract
// (front-month mode), else the native continuous (fallback).
// The live-quote symbol for a market's weekly chart: its front-month contract once that
// contract's history is loaded (front mode), else the native continuous (fallback). Pure read.
// Shared by wkChartLiveSymbol (per element) and the cold-start boot splash (per cfg).
function wkLiveSymbol(cfg) {
  if (!cfg) return null;
  const { mode, front, cont } = wkResolveSeries(cfg);
  if (mode === 'front' && front && front.yf_symbol) return front.yf_symbol;
  const c = cont || (typeof getContinuousContract === 'function' ? (getContinuousContract(cfg) || {}) : {});
  return c.yf_symbol || c.tv_symbol || null;
}
function wkChartLiveSymbol(el) {
  const key = el && el.dataset && el.dataset.key;
  const meta = key && INDEX[key];
  const cfg = meta && catCache[meta.slug] && catCache[meta.slug][key];
  return wkLiveSymbol(cfg);
}
// Redraw every already-rendered 3/3 chart so a fresh live tick lands on its price line.
// (live.js calls this as the repaint for the screener page.)
function wkRepaintLiveCharts() {
  if (document.getElementById('screenerWeekly')?.hidden) return;
  document.querySelectorAll('#screenerWeeklyBody .wk-chart[data-rendered]').forEach(wkDrawChart);
}

// Lazy entry point: load the 3/3 log + the market's category data, then draw.
async function wkRenderChart(el) {
  const key = el.dataset.key, meta = INDEX[key];
  if (!meta) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="wk-chart-loading">Loading chart …</div>';
  await ensureThreeThreeLog();
  const cat = await loadCategory(meta.slug);
  const cfg = cat && cat[key];
  if (!cfg) { el.innerHTML = '<div class="wk-chart-empty">No chart history available.</div>'; return; }
  // Front-month: lazily load the front contract's own history (falls back to continuous).
  await wkEnsureFrontHistory(cfg);
  const { bars } = wkResolveSeries(cfg);
  if (!bars.length) { el.innerHTML = '<div class="wk-chart-empty">No chart history available.</div>'; return; }
  el.dataset.rendered = '1';
  wkDrawChart(el);
}

// Draw (or redraw) the chart in the Futures-tab layout — rounded background, round-
// level price grid, themed candles, bottom date axis — plus the 3/3 band + entry/
// drop markers from the bot log. Synchronous + sized to the live container width,
// so resize just re-runs this. Mirrors the native chart in chart.js / forex.js.
function wkDrawChart(el) {
  const key = el.dataset.key, dir = el.dataset.dir, meta = INDEX[key];
  const cfg = meta && catCache[meta.slug] && catCache[meta.slug][key];
  if (!cfg) return;
  // Front-month series (continuous fallback). `mode`/`front` also drive the volume
  // pane source, the live-tick symbol, and the basis label in the block head.
  const { bars: all, mode, front } = wkResolveSeries(cfg);
  if (!all.length) return;
  const basisEl = el.closest && el.closest('.wk-block') && el.closest('.wk-block').querySelector('.wk-basis');
  if (basisEl) basisEl.textContent = (mode === 'front' && front)
    ? (front.contract_symbol || front.label || front.delivery_month_label || 'Front month')
    : 'Continuous';
  const logEntry = (_wkThreeThreeLog || {})[key] || {};
  const periods = Array.isArray(logEntry.periods) ? logEntry.periods : [];
  // The period that drives the caption + view window: prefer the open one in `dir`.
  const lead = periods.find(p => !p.end && p.direction === dir)
            || periods.filter(p => p.direction === dir).slice(-1)[0]
            || periods.slice(-1)[0] || null;

  // Window: ~12 months (Futures default range), extended to include the 3/3 start.
  const ms = iso => new Date(iso + 'T00:00:00').getTime();
  let from = Math.max(0, all.length - 252);
  if (lead && lead.start) {
    const si = all.findIndex(b => ms(b.date) >= ms(lead.start));
    if (si >= 0) from = Math.min(from, Math.max(0, si - 12));
  }
  let bars = all.slice(from);
  // Splice the continuous symbol's live tick onto the bars (display-only) — like chart.js
  // injectLivePoint. Never persisted; a reload / the board refresh replaces it.
  const cont = (typeof getContinuousContract === 'function') ? (getContinuousContract(cfg) || {}) : (cfg.continuous_contract || {});
  const liveSym = (mode === 'front' && front && front.yf_symbol)
    ? front.yf_symbol
    : (cont.yf_symbol || cont.tv_symbol || null);
  const lq = (liveSym && typeof liveQuotes === 'object' && liveQuotes) ? liveQuotes[liveSym] : null;
  const liveReady = !!(lq && Number.isFinite(lq.price) && lq.day);
  // Whether THIS live-layer session has confirmed a tick for liveSym (live.js owns the set,
  // reset on every (re)start). Drives the hint + dot so they survive a persisted `liveQuotes`:
  // unconfirmed -> show "Loading live…", confirmed -> hide hint and light the pulsing dot.
  const liveSeen = (typeof liveConfirmed === 'function') ? liveConfirmed(liveSym) : liveReady;
  if (liveReady) {
    // Real live candle from the still-forming bar's intraday OHLC (shared with chart.js);
    // falls back to a flat point when Yahoo omits open/high/low.
    const pt = { date: lq.day, ...liveBarOHLC(lq), __live: true };
    const lb = bars[bars.length - 1];
    bars = (lb && String(lb.date).slice(0, 10) === String(lq.day).slice(0, 10))
      ? bars.slice(0, -1).concat(pt) : bars.concat(pt);
  }
  // "Loading live…" hint in the block head until the first tick lands; once it has, the badge
  // is cleared and the provisional candle carries the pulsing live dot (built below) instead.
  const liveStateEl = el.closest && el.closest('.wk-block') && el.closest('.wk-block').querySelector('.wk-live-state');
  if (liveStateEl) {
    if (liveSym && !liveSeen) {
      liveStateEl.innerHTML = '<span class="wk-live-pending-dot"></span>Loading live…';
      liveStateEl.hidden = false;
    } else {
      liveStateEl.textContent = '';
      liveStateEl.hidden = true;
    }
  }
  const n = bars.length;

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

  // Current-price line (live tick when present, otherwise the last close) + a right-aligned
  // price tag — like the main charts (chart.js/smt.js). `curY` suppresses a colliding
  // round-level label below.
  const curY = pY(last);
  let priceLine = '';
  if (Number.isFinite(curY)) {
    const tagYc = Math.max(padT + 8, Math.min(padT + priceH - 8, curY));
    const txt = last.toFixed(dec);
    const tagW = Math.max(34, txt.length * 6.2 + 10);
    const tagX = W - 2 - tagW;
    priceLine =
      `<line x1="${padL}" y1="${curY.toFixed(1)}" x2="${tagX.toFixed(1)}" y2="${curY.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="5,4"/>` +
      `<rect x="${tagX.toFixed(1)}" y="${(tagYc - 8).toFixed(1)}" width="${tagW.toFixed(1)}" height="16" rx="2.5" fill="${CHART_THEME.bg}" stroke="${CHART_THEME.axis}" stroke-width="1"/>` +
      `<text x="${(tagX + tagW / 2).toFixed(1)}" y="${(tagYc + 3.5).toFixed(1)}" font-size="10" font-weight="600" text-anchor="middle" fill="${CHART_THEME.text}" font-family="Geist">${txt}</text>`;
  }

  // Pulsing hollow dot on the provisional (live) last bar — same marker as the Futures tab.
  let liveDot = '';
  const liveBar = bars[n - 1];
  if (liveBar && liveBar.__live && Number.isFinite(liveBar.close) && liveSeen) {
    const lx = barXs[n - 1].toFixed(1), ly = pY(liveBar.close).toFixed(1);
    liveDot =
      `<circle class="chart-live-dot" cx="${lx}" cy="${ly}" r="3" fill="none" stroke="${CHART_THEME.bull}" stroke-width="1.5">` +
      `<animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite"/></circle>`;
  }

  // Round-level price grid (Futures look: 1/2/2.5/5/10 multiples, ~3–7 lines).
  const rawStep = pSpan / 5, mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
  let levelStep = mag;
  for (const c of [1, 2, 2.5, 5, 10].map(m => m * mag)) { if (pSpan / c <= 7) { levelStep = c; break; } }
  let grid = '';
  for (let lv = Math.ceil(pLo / levelStep) * levelStep; lv <= pHi; lv += levelStep) {
    const v = Math.round(lv / levelStep) * levelStep;          // smooth FP noise
    if (v < pLo || v > pHi) continue;
    const y = pY(v).toFixed(1);
    grid += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="2,4" opacity="0.78"/>`;
    // Right-aligned (no clipping); drop the label when it collides with the price tag.
    if (!(Number.isFinite(curY) && Math.abs(+y - curY) < 9))
      grid += `<text x="${W - 4}" y="${(+y + 3).toFixed(1)}" font-size="10" text-anchor="end" fill="${CHART_THEME.text}" font-family="Geist">${v.toFixed(dec)}</text>`;
  }

  // 3/3 band + entry/drop markers (all periods in view), behind candles — same as card-mode.
  const t0 = tms[0], t1 = tms[n - 1];
  let bands = '', marks = '';
  periods.forEach(p => {
    const ps = ms(p.start), pe = p.end ? ms(p.end) : t1;
    if (pe < t0 || ps > t1) return;
    const i1 = nearestIdx(ps), i2 = p.end ? nearestIdx(pe) : n - 1;
    const x1 = barXs[i1], x2 = barXs[i2], col = p.direction === 'bullish' ? '#16a34a' : '#dc2626';
    if (x2 > x1) bands += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${(x2 - x1).toFixed(1)}" height="${priceH}" fill="${col}" opacity="0.18"/>`;
    const b = bars[i1], mx = x1;
    // Entry/drop markers only when their day is actually in view: ps/pe outside the
    // window get clamped by nearestIdx to bar 0 / n-1, drawing a phantom marker at the edge.
    if (b && ps >= t0) {
      if (p.direction === 'bullish') { const y = pY(b.low) + 6; marks += `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y + 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y + 11).toFixed(1)} Z" fill="${CHART_THEME.bull}" stroke="#fff" stroke-width="0.8"/>`; }
      else { const y = pY(b.high) - 6; marks += `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y - 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y - 11).toFixed(1)} Z" fill="${CHART_THEME.bear}" stroke="#fff" stroke-width="0.8"/>`; }
    }
    if (p.end && pe <= t1) {
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

  // ── Lower panes (volume / OI / COT / calendar spread) — like the Futures tab
  // (chart.js loadChart), only static and always continuous. Uses the same global
  // normalize* helpers + CHART_THEME so both charts stay visually identical.
  const volumeH = 62, oiH = 68, cotH = 84, spreadH = 64, gap = 22;
  const firstDate = new Date(bars[0].date), lastDate = new Date(bars[n - 1].date);
  const inVisibleRange = d => { const dt = new Date(d.date); return dt >= firstDate && dt <= lastDate; };
  const xForDate = date => barXs[nearestIdx(new Date(date).getTime())];
  const evenPaneX = (index, count, inset = 0) => {
    if (count <= 1) return padL + edgePad + plotW / 2;
    const usableW = Math.max(0, plotW - inset * 2);
    return padL + edgePad + inset + usableW * index / (count - 1);
  };

  // Volume pane (continuous: summed contract volumes; fallback: bar volume).
  const volumeTop = padT + priceH + gap;
  let volumeSvg = '';
  {
    // Continuous mode draws the summed contract volume; front-month mode draws the
    // displayed front contract's own bar volume (its chart_history carries volume).
    const rawTotalVolumeRows = (mode === 'continuous' && typeof normalizeVolumeSeries === 'function')
      ? normalizeVolumeSeries((cont && (cont.total_volume_series || cont.totalVolumeSeries)) || []) : [];
    const rawVolumeRows = rawTotalVolumeRows.length
      ? rawTotalVolumeRows
      : bars.map(b => ({ date: b.date, volume: Number(b.volume) || 0, source: 'yfinance_front_volume' }));
    const volumeRows = rawVolumeRows.filter(row => {
      const dt = new Date(row.date);
      return dt >= firstDate && dt <= lastDate && Number(row.volume) > 0
        && !row.suspect && row.source !== 'yfinance_volume_suspect_low';
    });
    if (volumeRows.length) {
      const byBar = new Map();
      volumeRows.forEach(row => {
        const idx = nearestIdx(new Date(row.date).getTime());
        if (idx < 0 || idx >= n) return;
        const prev = byBar.get(idx);
        if (prev) prev.volume += Number(row.volume) || 0;
        else byBar.set(idx, { barIndex: idx, volume: Number(row.volume) || 0 });
      });
      const rows = Array.from(byBar.values()).filter(r => r.volume > 0).sort((a, b) => a.barIndex - b.barIndex);
      const volMax = rows.length ? Math.max(...rows.map(r => r.volume)) : 0;
      const volBase = volumeTop + volumeH;
      const volY = v => volBase - (volMax ? (v / volMax) * volumeH : 0);
      const vBarW = Math.max(1, Math.min(12, slot * 0.7));
      let vbars = '';
      rows.forEach(r => {
        const x = barXs[r.barIndex], y = volY(r.volume), h = Math.max(1, volBase - y);
        const pb = bars[r.barIndex] || {}, up = (pb.close ?? 0) >= (pb.open ?? 0);
        vbars += `<rect x="${(x - vBarW / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${vBarW.toFixed(1)}" height="${h.toFixed(1)}" fill="${up ? CHART_THEME.volumeBull : CHART_THEME.volumeBear}" opacity="0.48" rx="1"/>`;
      });
      volumeSvg = `<line x1="${padL}" y1="${volumeTop}" x2="${W - padR}" y2="${volumeTop}" stroke="${CHART_THEME.grid}"/>`
        + `<line x1="${padL}" y1="${volBase}" x2="${W - padR}" y2="${volBase}" stroke="${CHART_THEME.grid}"/>${vbars}`
        + `<text x="${W - padR + 5}" y="${(volumeTop + 8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(volMax / 1000).toFixed(0)}K</text>`;
    } else {
      volumeSvg = `<text x="${padL}" y="${volumeTop + volumeH / 2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No volume data in this range</text>`;
    }
  }

  // OI pane (daily OI when present, otherwise the weekly CFTC OI from the COT series).
  const cotSeries = (typeof normalizeCotSeries === 'function') ? normalizeCotSeries(cfg.cot_series || []) : [];
  const visCot = cotSeries.filter(inVisibleRange);
  const oiTop = volumeTop + volumeH + gap;
  let oiSvg = '';
  {
    const dailyOi = (typeof normalizeOiSeries === 'function') ? normalizeOiSeries(cfg.daily_oi_series || []) : [];
    const visDailyOi = dailyOi.filter(inVisibleRange);
    const useDailyOi = visDailyOi.length > 0;
    const oiPoints = useDailyOi ? visDailyOi : visCot.filter(d => d.oi != null);
    if (oiPoints.length) {
      const oiVals = oiPoints.map(d => d.oi);
      const oiMin = Math.min(...oiVals), oiMax = Math.max(...oiVals), oiRng = oiMax - oiMin;
      const oiY = v => oiTop + (oiRng ? (1 - (v - oiMin) / oiRng) * oiH : oiH / 2);
      const pts = oiPoints.map(d => ({ x: xForDate(d.date), y: oiY(d.oi) })).sort((a, b) => a.x - b.x);
      let oiPath = '', oiDots = '';
      pts.forEach((p, i) => {
        oiPath += (i === 0 ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ' ';
        oiDots += `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${useDailyOi ? 2.3 : 1.8}" fill="${CHART_THEME.oiCftc}" opacity="${useDailyOi ? 0.6 : 0.42}"/>`;
      });
      oiSvg = `<line x1="${padL}" y1="${oiTop}" x2="${W - padR}" y2="${oiTop}" stroke="${CHART_THEME.grid}"/>`
        + `<line x1="${padL}" y1="${oiTop + oiH}" x2="${W - padR}" y2="${oiTop + oiH}" stroke="${CHART_THEME.grid}"/>`
        + (pts.length > 1 ? `<path d="${oiPath}" fill="none" stroke="${CHART_THEME.oi}" stroke-width="1.5" opacity="0.8"/>` : '') + oiDots
        + `<text x="${W - padR + 5}" y="${(oiTop + 5).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(oiMax / 1000).toFixed(0)}K</text>`
        + `<text x="${W - padR + 5}" y="${(oiTop + oiH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(oiMin / 1000).toFixed(0)}K</text>`;
    } else {
      oiSvg = `<text x="${padL}" y="${oiTop + oiH / 2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No Open Interest data in this range</text>`;
    }
  }

  // COT pane (commercial net; no hedging-window variant in the Outlook).
  const cotValue = d => (d.cot_net !== undefined && d.cot_net !== null) ? d.cot_net : d.comm_net;
  const cotTop = oiTop + oiH + gap;
  let cotSvg = '';
  {
    const cotBars = visCot;
    if (cotBars.length) {
      const cotVals = cotBars.map(cotValue).filter(v => v !== null && v !== undefined);
      const cotAbs = cotVals.length ? (Math.max(...cotVals.map(Math.abs)) || 1) : 1;
      const cotLo = -cotAbs, cotHi = cotAbs, cotSpan = (cotHi - cotLo) || 1;
      const cotY = v => cotTop + (1 - (v - cotLo) / cotSpan) * cotH;
      const cotMid = cotY(0);
      const cotStep = cotBars.length > 1 ? plotW / (cotBars.length - 1) : plotW;
      const barW = Math.max(1, Math.min(14, cotStep * 0.55));
      let cbars = '';
      cotBars.forEach((d, i) => {
        const net = cotValue(d);
        if (net === null || net === undefined) return;
        const x = evenPaneX(i, cotBars.length, barW / 2), y = cotY(net), h = Math.abs(y - cotMid);
        cbars += `<rect x="${(x - barW / 2).toFixed(1)}" y="${Math.min(y, cotMid).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1, h).toFixed(1)}" fill="${net >= 0 ? '#0ea679' : '#e53e3e'}" opacity="0.7" rx="1"/>`;
      });
      cotSvg = `<line x1="${padL}" y1="${cotMid.toFixed(1)}" x2="${W - padR}" y2="${cotMid.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-dasharray="4,3"/>${cbars}`
        + `<text x="${W - padR + 5}" y="${(cotTop + 8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(cotAbs / 1000).toFixed(0)}K</text>`
        + `<text x="${W - padR + 5}" y="${(cotTop + cotH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(-cotAbs / 1000).toFixed(0)}K</text>`;
    } else {
      cotSvg = `<text x="${padL}" y="${cotTop + cotH / 2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No CFTC COT data in this range</text>`;
    }
  }

  // Calendar-spread pane (front − next; negative = contango). Only when data is there.
  let spreadSeries = (typeof normalizeSpreadSeries === 'function') ? normalizeSpreadSeries(cfg.calendar_spread_series || []) : [];
  spreadSeries = spreadSeries.filter(inVisibleRange);
  const spreadShown = spreadSeries.length > 0;
  const spreadTop = cotTop + cotH + gap;
  let spreadSvg = '';
  if (spreadShown) {
    const spVals = spreadSeries.map(d => d.spread);
    const dataLo = Math.min(...spVals), dataHi = Math.max(...spVals);
    const spPad = ((dataHi - dataLo) || Math.abs(dataHi) || 1) * 0.12;
    const spLo = dataLo - spPad, spHi = dataHi + spPad, spRng = (spHi - spLo) || 1;
    const spreadY = v => spreadTop + (1 - (v - spLo) / spRng) * spreadH;
    const zeroYraw = spreadY(0);
    const zeroY = Math.max(spreadTop, Math.min(spreadTop + spreadH, zeroYraw));
    const zeroPinned = zeroYraw !== zeroY;
    const pts = spreadSeries.map(d => ({
      date: d.date, x: xForDate(d.date), y: spreadY(d.spread),
      pair: `${d.front_contract || ''}-${d.next_contract || ''}`
    })).sort((a, b) => a.x - b.x);
    // Same two breaks as the Futures pane (chart.js): a >7-day gap, and a change of
    // contract pair — the step across a roll is not a move in the spread.
    let spPath = '', prevTime = null, prevPair = null;
    pts.forEach((p, i) => {
      const t = new Date(p.date).getTime();
      const brk = prevTime !== null && ((t - prevTime) > 7 * 864e5 || p.pair !== prevPair);
      spPath += (i === 0 || brk ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ' ';
      prevTime = t; prevPair = p.pair;
    });
    const spDots = pts.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.6" fill="${CHART_THEME.spread}" opacity="0.5"/>`).join('');
    spreadSvg = `<line x1="${padL}" y1="${spreadTop}" x2="${W - padR}" y2="${spreadTop}" stroke="${CHART_THEME.grid}"/>`
      + `<line x1="${padL}" y1="${spreadTop + spreadH}" x2="${W - padR}" y2="${spreadTop + spreadH}" stroke="${CHART_THEME.grid}"/>`
      + `<line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W - padR}" y2="${zeroY.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-dasharray="4,3"${zeroPinned ? ' opacity="0.65"' : ''}/>`
      + `<text x="${W - padR + 5}" y="${(zeroY + 3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">0</text>`
      + (pts.length > 1 ? `<path d="${spPath}" fill="none" stroke="${CHART_THEME.spread}" stroke-width="1.5" opacity="0.85"/>` : '') + spDots
      + `<text x="${W - padR + 5}" y="${(spreadY(dataHi) + 3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${dataHi.toFixed(dec)}</text>`
      + `<text x="${W - padR + 5}" y="${(spreadY(dataLo) + 3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${dataLo.toFixed(dec)}</text>`;
  }

  // Pane headings on the left (no toggle control in the Outlook, hence the labels).
  const paneLabel = (top, txt) => `<text x="${padL}" y="${(top - 6).toFixed(1)}" font-size="9" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" letter-spacing="0.05em" opacity="0.72">${txt}</text>`;
  const paneHeads = paneLabel(volumeTop, 'VOLUME') + paneLabel(oiTop, 'OPEN INTEREST') + paneLabel(cotTop, 'COT · COMMERCIAL NET')
    + (spreadShown ? paneLabel(spreadTop, 'CALENDAR SPREAD') : '');

  // Bottom date axis below the last pane.
  const panesH = (volumeH + gap) + (oiH + gap) + (cotH + gap) + (spreadShown ? spreadH + gap : 0);
  const axisY = padT + priceH + panesH, totalH = axisY + 22;
  let xLabels = '';
  for (let g = 0; g <= 5; g++) {
    const i = Math.round((n - 1) * g / 5);
    xLabels += `<text x="${xAt(i).toFixed(1)}" y="${(totalH - 6).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist" text-anchor="middle">${bars[i].date.slice(2)}</text>`;
  }
  const chartBg = `<rect x="0" y="0" width="${W}" height="${totalH}" fill="${CHART_THEME.bg}" rx="7"/>`;

  const svg = `<svg class="wk-chart-svg" viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" preserveAspectRatio="xMinYMin meet">`
    + `${chartBg}${bands}${grid}${candles}${marks}${priceLine}${liveDot}${volumeSvg}${oiSvg}${cotSvg}${spreadSvg}${paneHeads}${xLabels}</svg>`;

  // The 3/3-since + seasonal-runway readout now lives in the block's header stat line
  // (wkStatLine), so the chart renders on its own — no duplicated caption above it.
  el.innerHTML = svg;
}

// ── FX strength & pairing (built from the same screener signals) ──
// Each USD-quoted future bullish = that currency strong vs USD; USDX = USD strength.
// For a cross pair the USD denominator cancels, so bias = score(long) - score(short).
