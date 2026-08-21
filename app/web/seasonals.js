async function selectSeasonalsMarket(key) {
  if (!INDEX[key]) return;
  seasonalState.key = key;
  updateSeasonalsSidebarActive();
  renderWatchlist();
  await renderSeasonalsPage(key);
}

function seasonalMonthDay(dayIndex) {
  const d = new Date(Date.UTC(2021, 0, 1 + Math.max(0, Math.min(364, dayIndex))));
  return d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' });
}

function dayOfYearNoLeap(dateStr) {
  const [year, month, day] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!year || !month || !day || (month === 2 && day === 29)) return null;
  const t = Date.UTC(2021, month - 1, day);
  const start = Date.UTC(2021, 0, 1);
  return Math.round((t - start) / 86400000);
}

function seasonalYear(dateStr) {
  return Number(String(dateStr).slice(0, 4));
}

function localIsoDate(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function currentSeasonalMarker() {
  const iso = localIsoDate();
  let dayIndex = dayOfYearNoLeap(iso);
  if (dayIndex === null && iso.slice(5) === '02-29') dayIndex = 58;
  if (dayIndex === null) return null;
  return { date: iso, dayIndex, label: seasonalMonthDay(dayIndex) };
}

function buildSeasonalCurve(history, yearsRequested) {
  let rows = (history || [])
    .filter(row => row && row.date && Number.isFinite(Number(row.close)))
    .map(row => ({ date: String(row.date).slice(0, 10), close: Number(row.close) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
  if (!rows.length) return null;

  // Drop isolated bad prints: a single bar that deviates far from BOTH neighbours
  // and snaps back the next day (e.g. yfinance's ~10x-low JPY close on 2001-12-17).
  // Real gaps move and persist; data artifacts spike and revert, so we only filter
  // reverting spikes — one bad bar would otherwise dent the indexed multi-year average.
  rows = rows.filter((row, i) => {
    const prev = rows[i - 1], next = rows[i + 1];
    if (!prev || !next || !prev.close || !next.close) return true;
    const tooLow  = row.close < 0.5 * prev.close && row.close < 0.5 * next.close;
    const tooHigh = row.close > 2 * prev.close && row.close > 2 * next.close;
    return !(tooLow || tooHigh);
  });

  const last = rows[rows.length - 1].date;
  const lastYear = seasonalYear(last);
  const lastMonthDay = Number(last.slice(5, 7)) * 100 + Number(last.slice(8, 10));
  const latestFullYear = lastMonthDay >= 1215 ? lastYear : lastYear - 1;
  const wantedStart = latestFullYear - yearsRequested + 1;
  const byYear = new Map();
  rows.forEach(row => {
    const y = seasonalYear(row.date);
    if (y < wantedStart || y > latestFullYear) return;
    if (!byYear.has(y)) byYear.set(y, []);
    byYear.get(y).push(row);
  });

  const selectedYears = Array.from(byYear.keys())
    .sort((a, b) => a - b)
    .filter(year => {
      const yrRows = byYear.get(year) || [];
      if (yrRows.length < 120) return false;
      const first = yrRows[0]?.date || '';
      return Number(first.slice(5, 7)) <= 3;
    });
  if (!selectedYears.length) return null;

  const yearlyPaths = [];
  selectedYears.forEach(year => {
    const yrRows = (byYear.get(year) || []).sort((a, b) => new Date(a.date) - new Date(b.date));
    const firstClose = yrRows[0]?.close;
    if (!firstClose) return;
    const values = new Array(365).fill(null);
    let cursor = 0;
    let lastValue = 100;
    yrRows.forEach(row => {
      const idx = dayOfYearNoLeap(row.date);
      if (idx === null || idx < 0 || idx > 364) return;
      while (cursor <= idx && cursor < 365) values[cursor++] = lastValue;
      lastValue = row.close / firstClose * 100;
      values[idx] = lastValue;
      cursor = Math.max(cursor, idx + 1);
    });
    while (cursor < 365) values[cursor++] = lastValue;
    yearlyPaths.push(values);
  });
  if (!yearlyPaths.length) return null;

  const points = new Array(365).fill(null).map((_, idx) => {
    const vals = yearlyPaths.map(path => path[idx]).filter(v => Number.isFinite(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });

  return {
    yearsRequested,
    yearsUsed: yearlyPaths.length,
    startYear: selectedYears[0],
    endYear: selectedYears[selectedYears.length - 1],
    points
  };
}

function renderSeasonalChart(cfg, history) {
  const body = document.getElementById('seasonalsBody');
  const title = document.getElementById('seasonalsChartTitle');
  const metaEl = document.getElementById('seasonalsChartMeta');
  if (!body) return;

  const cleanHistory = (history || []).filter(row => row && row.date && Number.isFinite(Number(row.close)));
  if (!cleanHistory.length) {
    body.innerHTML = '<div class="seasonals-empty">No seasonal history available for this market.</div>';
    return;
  }

  // 5/10/15Y + a 'max' curve (full available history). Mirrors the screener seasonal
  // signal's curves (SEASONAL_WINDOWS + SEASONAL_MAX_WINDOW in screener.py) so the chart
  // shows exactly the curves the 3-of-4 vote is computed on. 100 = effectively "max".
  const curves = [
    { key: '5Y', color: '#1a56db', stroke: 2.2, data: buildSeasonalCurve(cleanHistory, 5) },
    { key: '10Y', color: '#9333ea', stroke: 2.0, data: buildSeasonalCurve(cleanHistory, 10) },
    { key: '15Y', color: '#0ea679', stroke: 2.0, data: buildSeasonalCurve(cleanHistory, 15) },
    { key: 'Max', color: '#e8853a', stroke: 2.0, data: buildSeasonalCurve(cleanHistory, 100) },
  ].filter(curve => curve.data && curve.data.points.some(v => Number.isFinite(v)));
  curves.forEach(curve => {
    curve.labelKey = curve.data.yearsUsed < curve.data.yearsRequested
      ? `Max ${curve.data.yearsUsed}Y`
      : curve.key;
  });

  if (!curves.length) {
    body.innerHTML = '<div class="seasonals-empty">Not enough history to calculate seasonal tendencies.</div>';
    return;
  }

  const rect = body.getBoundingClientRect();
  const bodyStyle = window.getComputedStyle(body);
  const padX = (Number.parseFloat(bodyStyle.paddingLeft) || 0) + (Number.parseFloat(bodyStyle.paddingRight) || 0);
  const W = Math.max(640, Math.floor((rect.width || body.clientWidth || 980) - padX));
  const H = 540;
  const padL = 56, padR = 70, padT = 44, padB = 44;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const allVals = curves.flatMap(curve => curve.data.points).filter(v => Number.isFinite(v));
  const rawMin = Math.min(100, ...allVals);
  const rawMax = Math.max(100, ...allVals);
  const span = rawMax - rawMin || 1;
  const yMin = rawMin - span * 0.12;
  const yMax = rawMax + span * 0.12;
  const xAt = idx => padL + (idx / 364) * plotW;
  const yAt = val => padT + (1 - (val - yMin) / (yMax - yMin)) * plotH;

  const months = [
    ['Jan', 0], ['Feb', 31], ['Mar', 59], ['Apr', 90], ['May', 120], ['Jun', 151],
    ['Jul', 181], ['Aug', 212], ['Sep', 243], ['Oct', 273], ['Nov', 304], ['Dec', 334],
  ];
  let grid = '';
  months.forEach(([label, idx]) => {
    const x = xAt(idx);
    grid += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(H-padB).toFixed(1)}" stroke="#9aa6b5" stroke-width="1.1" stroke-dasharray="3,4" opacity="0.88"/>`;
    grid += `<text x="${x.toFixed(1)}" y="${H-16}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" text-anchor="middle">${label}</text>`;
  });
  const yTicks = [yMin, 100, yMax];
  yTicks.forEach(val => {
    const y = yAt(val);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${W-padR}" y2="${y.toFixed(1)}" stroke="${val === 100 ? CHART_THEME.axis : CHART_THEME.grid}" stroke-dasharray="${val === 100 ? '4,3' : ''}"/>`;
    grid += `<text x="${W-padR+8}" y="${(y+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(val-100).toFixed(1)}%</text>`;
  });

  const paths = curves.map(curve => {
    let d = '';
    curve.data.points.forEach((val, idx) => {
      if (!Number.isFinite(val)) return;
      d += `${d ? 'L' : 'M'}${xAt(idx).toFixed(1)},${yAt(val).toFixed(1)} `;
    });
    return `<path d="${d}" fill="none" stroke="${curve.color}" stroke-width="${curve.stroke}" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join('');

  const today = currentSeasonalMarker();
  let currentDateSvg = '';
  if (today) {
    const x = xAt(today.dayIndex);
    // Theme-aware: a near-black hairline vanished on the dark chart ground.
    const markerDark = currentTheme() === 'dark';
    const markerStroke = markerDark ? CHART_THEME.text : '#0f172a';
    const markerOpacity = markerDark ? 0.55 : 0.28;
    const label = 'Today';
    const title = `Today · ${today.label}`;
    const labelW = Math.max(42, label.length * 5.2 + 10);
    const labelX = Math.max(padL, Math.min(W - padR - labelW, x - labelW / 2));
    const labelY = H - padB + 4;
    currentDateSvg = `<g class="seasonal-current-date"><title>${esc(title)}</title>
      <line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(H-padB).toFixed(1)}" stroke="${markerStroke}" stroke-width="1" stroke-dasharray="3,5" opacity="${markerOpacity}"/>
      <rect x="${labelX.toFixed(1)}" y="${labelY.toFixed(1)}" width="${labelW.toFixed(1)}" height="14" rx="3" fill="#fde68a" stroke="#f59e0b" opacity="1"/>
      <text x="${(labelX + labelW / 2).toFixed(1)}" y="${(labelY + 10).toFixed(1)}" font-size="8.5" fill="#334155" font-family="Geist" font-weight="600" text-anchor="middle">${esc(label)}</text>
    </g>`;
  }
  const crosshairCurves = curves.map(curve => ({
    key: curve.labelKey || curve.key,
    color: curve.color,
    points: curve.data.points.map((val, idx) => ({
      dayIndex: idx,
      x: xAt(idx),
      y: Number.isFinite(val) ? yAt(val) : null,
      value: val
    }))
  }));

  let lx = padL;
  const legend = curves.map(curve => {
    const label = `${curve.labelKey || curve.key} (${curve.data.yearsUsed} yrs · ${curve.data.startYear}-${curve.data.endYear})`;
    const item = `<g transform="translate(${lx},${padT - 8})">
      <line x1="0" y1="0" x2="18" y2="0" stroke="${curve.color}" stroke-width="${curve.stroke}"/>
      <text x="24" y="3" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${esc(label)}</text>
    </g>`;
    lx += 36 + label.length * 6.2;
    return item;
  }).join('');

  const dataStart = cleanHistory[0].date;
  const dataEnd = cleanHistory[cleanHistory.length - 1].date;
  const meta = INDEX[seasonalState.key] || {};
  if (title) title.textContent = `${meta.display_name || cfg.display_name} Seasonality`;
  if (metaEl) metaEl.textContent = `Data ${dataStart} to ${dataEnd} · yfinance continuous history · indexed to 100`;
  document.getElementById('seasonalsTitle').textContent = meta.display_name || 'Seasonals';

  body.innerHTML = `<div class="seasonals-chart-wrap">
    <svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" preserveAspectRatio="xMinYMin meet">
      <rect x="0" y="0" width="${W}" height="${H}" fill="${CHART_THEME.bg}" rx="7"/>
      ${grid}
      ${legend}
      ${paths}
      ${currentDateSvg}
      <text x="${padL}" y="${H-4}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">Seasonal average performance from first trading day of year</text>
    </svg>
  </div>`;
  bindSeasonalsCrosshair(body.querySelector('.seasonals-chart-wrap'), {
    W, H, padL, padR, padT, padB, plotW, plotH, yMin, yMax,
    curves: crosshairCurves
  });
}

function bindSeasonalsCrosshair(wrap, cfg) {
  if (!wrap || !cfg || !cfg.curves || !cfg.curves.length) return;
  const svg = wrap.querySelector('svg');
  if (!svg) return;

  const NS = 'http://www.w3.org/2000/svg';
  const make = (name, attrs = {}) => {
    const el = document.createElementNS(NS, name);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const yValue = y => cfg.yMax - ((y - cfg.padT) / cfg.plotH) * (cfg.yMax - cfg.yMin);
  const layer = make('g', { class: 'chart-crosshair-layer', style: 'display:none' });
  const vLine = make('line', { class: 'crosshair-line', y1: cfg.padT, y2: cfg.H - cfg.padB });
  const hLine = make('line', { class: 'crosshair-soft-line', x1: cfg.padL, x2: cfg.W - cfg.padR });

  function label() {
    const g = make('g');
    const rect = make('rect', { class: 'crosshair-label-bg', rx: 3, height: 17 });
    const text = make('text', { class: 'crosshair-label', y: 0, 'dominant-baseline': 'middle' });
    g.appendChild(rect);
    g.appendChild(text);
    layer.appendChild(g);
    return { g, rect, text };
  }
  function setLabel(tag, textValue, x, y, align = 'left') {
    const width = Math.max(42, textValue.length * 6 + 10);
    const offset = align === 'right' ? -width : align === 'center' ? -width / 2 : 0;
    tag.g.style.display = '';
    tag.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    tag.rect.setAttribute('x', offset);
    tag.rect.setAttribute('y', -8.5);
    tag.rect.setAttribute('width', width);
    tag.text.setAttribute('x', offset + 5);
    tag.text.textContent = textValue;
  }

  const dateLabel = label();
  const yLabel = label();
  const curveTags = cfg.curves.map(curve => ({
    curve,
    dot: make('circle', { class: 'crosshair-dot', r: 3, fill: curve.color }),
    label: label()
  }));
  curveTags.forEach(item => layer.appendChild(item.dot));
  layer.append(vLine, hLine);
  svg.appendChild(layer);

  const hit = make('rect', {
    class: 'chart-crosshair-hit',
    x: cfg.padL,
    y: cfg.padT,
    width: cfg.plotW,
    height: cfg.plotH
  });
  svg.appendChild(hit);

  function localPoint(evt) {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX;
    pt.y = evt.clientY;
    return pt.matrixTransform(ctm.inverse());
  }

  function update(evt) {
    const p = localPoint(evt);
    if (!p) return;
    const x = clamp(p.x, cfg.padL, cfg.W - cfg.padR);
    const y = clamp(p.y, cfg.padT, cfg.H - cfg.padB);
    const dayIndex = Math.max(0, Math.min(364, Math.round(((x - cfg.padL) / cfg.plotW) * 364)));
    const snapX = cfg.padL + (dayIndex / 364) * cfg.plotW;

    layer.style.display = '';
    vLine.setAttribute('x1', snapX.toFixed(1));
    vLine.setAttribute('x2', snapX.toFixed(1));
    hLine.setAttribute('y1', y.toFixed(1));
    hLine.setAttribute('y2', y.toFixed(1));
    setLabel(dateLabel, seasonalMonthDay(dayIndex), snapX, cfg.H - cfg.padB + 15, 'center');
    setLabel(yLabel, `${(yValue(y) - 100).toFixed(1)}%`, cfg.W - 4, y, 'right');

    curveTags.forEach((item, i) => {
      const point = item.curve.points[dayIndex];
      if (!point || !Number.isFinite(point.value) || point.y === null) {
        item.dot.style.display = 'none';
        item.label.g.style.display = 'none';
        return;
      }
      item.dot.style.display = '';
      item.dot.setAttribute('cx', snapX.toFixed(1));
      item.dot.setAttribute('cy', point.y.toFixed(1));
      const labelY = clamp(point.y + (i - 1) * 12, cfg.padT + 9, cfg.H - cfg.padB - 9);
      setLabel(item.label, `${item.curve.key} ${(point.value - 100).toFixed(1)}%`, cfg.W - 4, labelY, 'right');
    });
  }
  function hide() {
    layer.style.display = 'none';
  }

  hit.addEventListener('pointerenter', update);
  hit.addEventListener('pointermove', update);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('mouseenter', update);
  hit.addEventListener('mousemove', update);
  hit.addEventListener('mouseleave', hide);
  hit.addEventListener('mouseout', hide);
  svg.addEventListener('mouseleave', hide);
}

async function renderSeasonalsPage(key = seasonalState.key || currentKey) {
  if (!INDEX[key]) key = currentKey;
  seasonalState.key = key;
  updateSeasonalsSidebarActive();
  renderWatchlist();

  const body = document.getElementById('seasonalsBody');
  if (body) body.innerHTML = '<div class="seasonals-empty">Loading seasonal history...</div>';
  const meta = INDEX[key];
  if (!meta) return;
  document.getElementById('seasonalsTitle').textContent = meta.display_name;
  document.getElementById('seasonalsChartTitle').textContent = `${meta.display_name} Seasonality`;

  const catData = await loadCategory(meta.slug);
  const cfg = catData && catData[key];
  if (!cfg) {
    if (body) body.innerHTML = '<div class="seasonals-empty">Seasonal data could not be loaded.</div>';
    return;
  }
  const continuous = getContinuousContract(cfg);
  const history = continuous.seasonal_history || continuous.seasonalHistory || continuous.history || [];
  renderSeasonalChart(cfg, history);
}

// ── Chart export / share ──
// CSS rules the chart SVG relies on via classes (inline fills already export fine;
// these cover roll markers, which use classes). Crosshair is stripped before export.
