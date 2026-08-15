// draw.js — Charts-tab drawing tools (TradingView-style palette).
//
// Self-contained drawing engine for the maximized "Charts" tab (bigchart.js). Plain
// global-scope script (NOT an ES module), like every other app/web/*.js. Drawings are
// stored in DATA coordinates (date + price) keyed per market in localStorage, so they
// survive the full SVG rebuild loadChart does on every zoom / resize / timeframe change.
//
// chart.js calls renderChartDrawings(svg, coord) + bindChartDrawingInteractions(wrap,
// coord, rerender) ONLY when opts.drawings is set (renderBigChart). So the Futures tab and
// content-bot card-mode never show a drawing layer.

const DRAW_STORE_KEY = 'charthorizon.drawings.v1';
// Default fib levels (the classic retracement set). Each shown level is { r: ratio, color?: hex };
// which levels show, plus any custom ratios and per-level colours, are stored per drawing and edited
// from the right-click menu. Back-compat: an older number-array `style.levels` maps to {r}.
const FIB_DEFAULT_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIBTIME_SEQ = [0, 1, 2, 3, 5, 8, 13, 21, 34, 55];   // default Fibonacci-time-zone multiples of the base interval
// Per-drawing time-zone levels mirror the retracement levels: { n: multiple, color?, width?, dash? }.
function fibTimeLevelObjs(d) {
  const st = d.style || {};
  if (Array.isArray(st.timeLevels)) return st.timeLevels;
  return FIBTIME_SEQ.map(n => ({ n }));
}
// Filled arrow glyph with its TIP at (x,y): up → shaft hangs below (marks a low), down → above (marks a high).
function _arrowPath(x, y, up) {
  return up
    ? `M${x} ${y} L${x - 6} ${y + 9} L${x - 2.3} ${y + 9} L${x - 2.3} ${y + 18} L${x + 2.3} ${y + 18} L${x + 2.3} ${y + 9} L${x + 6} ${y + 9} Z`
    : `M${x} ${y} L${x - 6} ${y - 9} L${x - 2.3} ${y - 9} L${x - 2.3} ${y - 18} L${x + 2.3} ${y - 18} L${x + 2.3} ${y - 9} L${x + 6} ${y - 9} Z`;
}
function _arrowPathH(x, y, right) {   // horizontal arrow, tip at (x,y)
  return right
    ? `M${x} ${y} L${x - 9} ${y - 6} L${x - 9} ${y - 2.3} L${x - 18} ${y - 2.3} L${x - 18} ${y + 2.3} L${x - 9} ${y + 2.3} L${x - 9} ${y + 6} Z`
    : `M${x} ${y} L${x + 9} ${y - 6} L${x + 9} ${y - 2.3} L${x + 18} ${y - 2.3} L${x + 18} ${y + 2.3} L${x + 9} ${y + 2.3} L${x + 9} ${y + 6} Z`;
}
// Symbol shapes drawn as <path> (arrows filled; marks stroked). Emoji symbols are handled separately
// (rendered as <text>). The picker flyout lists both.
const SYMBOL_SHAPES = {
  arrowup:    { label: 'Arrow up',    fill: true,  path: (x, y) => _arrowPath(x, y, true) },
  arrowdown:  { label: 'Arrow down',  fill: true,  path: (x, y) => _arrowPath(x, y, false) },
  arrowleft:  { label: 'Arrow left',  fill: true,  path: (x, y) => _arrowPathH(x, y, false) },
  arrowright: { label: 'Arrow right', fill: true,  path: (x, y) => _arrowPathH(x, y, true) },
  check:      { label: 'Check',  fill: false, path: (x, y) => `M${x - 6} ${y} L${x - 1} ${y + 6} L${x + 7} ${y - 7}` },
  cross:      { label: 'Cross',  fill: false, path: (x, y) => `M${x - 6} ${y - 6} L${x + 6} ${y + 6} M${x + 6} ${y - 6} L${x - 6} ${y + 6}` },
  circle:     { label: 'Circle', fill: false, path: (x, y) => `M${x} ${y} m-6 0 a6 6 0 1 0 12 0 a6 6 0 1 0 -12 0` },
};
const SYMBOL_EMOJIS = ['📈', '📉', '⭐', '🔥', '✅', '❌', '⚠️', '🎯', '💰', '🚀', '🐂', '🐻', '👀', '💎', '🛑', '📌', '❗', '💡'];
function fibLevelObjs(d) {
  const st = d.style || {};
  if (Array.isArray(st.fibLevels)) return st.fibLevels;
  if (Array.isArray(st.levels)) return st.levels.map(r => ({ r }));
  return FIB_DEFAULT_LEVELS.map(r => ({ r }));
}

// Active tool + current selection. Tool changes do NOT trigger a chart rebuild on their
// own (setDrawTool repaints when needed); the mousedown handler reads drawState.tool live.
// toolBeforeCrosshair: the tool the middle-mouse crosshair toggle (chart.js) displaced, so
// the next middle-click puts it back. It lives here, not in a render closure, because the
// tool switch rebuilds the chart and takes any closure state with it.
let drawState = { tool: 'cursor', selectedId: null, magnet: true, objTree: false, symbol: { sym: 'arrowup' }, toolBeforeCrosshair: null };

// ── small helpers (make/clamp are local to chart.js's bindChartCrosshair, not global) ──
function svgEl(name, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', name);
  if (attrs) for (const k in attrs) { if (attrs[k] != null) el.setAttribute(k, attrs[k]); }
  return el;
}
function clampN(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy || 1;
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

// ── persistence (per market) ──
function loadAllDrawings() {
  try { return JSON.parse(localStorage.getItem(DRAW_STORE_KEY)) || {}; } catch (e) { return {}; }
}
function currentDrawKey() {
  return (typeof bigChartState !== 'undefined' && bigChartState) ? bigChartState.key : null;
}
function drawingsForKey(key) {
  if (!key) return [];
  const arr = loadAllDrawings()[key];
  return Array.isArray(arr) ? arr : [];
}
function saveDrawingsForKey(key, arr) {
  if (!key) return;
  const all = loadAllDrawings();
  all[key] = arr;
  try { localStorage.setItem(DRAW_STORE_KEY, JSON.stringify(all)); } catch (e) {}
}
// Unique id within a market's list, no Date/random: max existing numeric id + 1.
function nextDrawId(arr) {
  let max = 0;
  (arr || []).forEach(d => { const n = parseInt(String(d.id).replace(/\D/g, ''), 10); if (Number.isFinite(n) && n > max) max = n; });
  return 'd' + (max + 1);
}

// ── geometry: project a drawing to pixel space (shared by render + hit-test) ──
function drawingGeometry(d, coord) {
  if (d.type === 'hline') {
    const y = coord.yForPrice(d.points[0].price);
    return { y, x1: coord.plotLeft, x2: coord.plotRight };
  }
  if (d.type === 'hray') {   // horizontal ray: from its anchor to the right edge only
    const p = d.points[0];
    return { y: coord.yForPrice(p.price), x1: coord.xForTime(new Date(p.date).getTime()), x2: coord.plotRight };
  }
  if (d.type === 'vline') {   // vertical line spanning the price pane
    const x = coord.xForTime(new Date(d.points[0].date).getTime());
    return { x, top: coord.plotTop, bottom: coord.plotBottom, midY: (coord.plotTop + coord.plotBottom) / 2 };
  }
  if (d.type === 'text' || d.type === 'symbol' || d.type === 'arrowup' || d.type === 'arrowdown') {   // single-anchor marks
    const p = d.points[0];
    return { ax: coord.xForTime(new Date(p.date).getTime()), ay: coord.yForPrice(p.price) };
  }
  if (d.type === 'long' || d.type === 'short') {   // risk/reward: x-range at entry + stop/target levels
    const a = d.points[0], b = d.points[1];
    const ax = coord.xForTime(new Date(a.date).getTime()), bx = coord.xForTime(new Date(b.date).getTime());
    const entryY = coord.yForPrice(a.price);
    return { ax, ay: entryY, bx, by: entryY, leftX: Math.min(ax, bx), rightX: Math.max(ax, bx),
      entryY, stopY: coord.yForPrice(d.stop), targetY: coord.yForPrice(d.target) };
  }
  if (d.type === 'pencil' || d.type === 'marker') {   // freehand: a polyline of points
    return { pts: d.points.map(p => ({ x: coord.xForTime(new Date(p.date).getTime()), y: coord.yForPrice(p.price) })) };
  }
  const a = d.points[0], b = d.points[1];   // trend / fib / rect / fibtime
  return {
    ax: coord.xForTime(new Date(a.date).getTime()), ay: coord.yForPrice(a.price),
    bx: coord.xForTime(new Date(b.date).getTime()), by: coord.yForPrice(b.price),
  };
}
function handlePoints(d, g) {
  if (d.type === 'hline') return [{ x: (g.x1 + g.x2) / 2, y: g.y, pointIndex: 0 }];
  if (d.type === 'hray') return [{ x: g.x1, y: g.y, pointIndex: 0 }];
  if (d.type === 'vline') return [{ x: g.x, y: g.midY, pointIndex: 0 }];
  if (d.type === 'text' || d.type === 'symbol' || d.type === 'arrowup' || d.type === 'arrowdown') return [{ x: g.ax, y: g.ay, pointIndex: 0 }];
  if (d.type === 'pencil' || d.type === 'marker') return [];   // freehand: move-only, no per-point handles
  if (d.type === 'long' || d.type === 'short') {
    const midX = (g.leftX + g.rightX) / 2;
    return [
      { x: g.leftX, y: g.entryY, kind: 'rr', role: 'entry' },   // entry line + left edge
      { x: g.rightX, y: g.entryY, kind: 'rr', role: 'right' },  // width
      { x: midX, y: g.targetY, kind: 'rr', role: 'target' },
      { x: midX, y: g.stopY, kind: 'rr', role: 'stop' },
    ];
  }
  if (d.type === 'rect') {
    // Full TradingView handle set: 4 corners + 4 edge midpoints. Corners reshape both dimensions;
    // an edge handle moves only one side, so dragging the right edge extends purely horizontally.
    // dx/dy name the bounding-box side each handle controls (the reshape maps them to a point).
    const lx = Math.min(g.ax, g.bx), rx = Math.max(g.ax, g.bx);
    const ty = Math.min(g.ay, g.by), by = Math.max(g.ay, g.by);
    const mx = (lx + rx) / 2, my = (ty + by) / 2;
    return [
      { x: lx, y: ty, kind: 'rect', dx: 'left',  dy: 'top' },
      { x: rx, y: ty, kind: 'rect', dx: 'right', dy: 'top' },
      { x: lx, y: by, kind: 'rect', dx: 'left',  dy: 'bottom' },
      { x: rx, y: by, kind: 'rect', dx: 'right', dy: 'bottom' },
      { x: mx, y: ty, kind: 'rect', dx: null,    dy: 'top' },
      { x: mx, y: by, kind: 'rect', dx: null,    dy: 'bottom' },
      { x: lx, y: my, kind: 'rect', dx: 'left',  dy: null },
      { x: rx, y: my, kind: 'rect', dx: 'right', dy: null },
    ];
  }
  return [{ x: g.ax, y: g.ay, pointIndex: 0 }, { x: g.bx, y: g.by, pointIndex: 1 }];
}
function fibLevelYs(d, coord) {
  const p0 = d.points[0].price, p1 = d.points[1].price;
  return fibLevelObjs(d).map(o => coord.yForPrice(p0 + (p1 - p0) * o.r));
}

// ── render one drawing into a <g data-draw-id> (selected → handle circles too) ──
// Per-drawing overrides (color/width/dash, set via the right-click menu) are applied as an inline
// `style` string so they beat the .chart-draw-* class rules; absent → the class default (accent).
function _drawStyleCss(d, withFill) {
  const st = d.style;
  if (!st) return null;
  let s = '';
  if (st.color) { s += 'stroke:' + st.color + ';'; if (withFill) s += 'fill:' + st.color + ';'; }
  if (st.width) s += 'stroke-width:' + st.width + ';';
  if (st.dash) s += 'stroke-dasharray:6,4;';
  return s || null;
}
function priceTag(coord, y, price, color) {
  const txt = price.toFixed(coord.dec);
  const w = txt.length * 6 + 10;
  const x0 = Math.max(coord.plotLeft, coord.plotRight - w);   // don't run off the left edge for wide values
  const g = svgEl('g', { class: 'chart-draw-pricetag' });
  g.appendChild(svgEl('rect', { class: 'chart-draw-pricetag-bg', x: x0, y: y - 8, width: w, height: 16, rx: 3, style: color ? 'fill:' + color : null }));
  const t = svgEl('text', { class: 'chart-draw-pricetag-text', x: x0 + 5, y: y + 3 });
  t.textContent = txt;
  g.appendChild(t);
  return g;
}
// Optional text label attached to a line drawing (trend / hline / hray) — d.text.
function _lineLabel(grp, d, x, y, color) {
  if (!d.text) return;
  const t = svgEl('text', { class: 'chart-draw-linelabel', x, y, style: color ? 'fill:' + color : null });
  t.textContent = d.text;
  grp.appendChild(t);
}
function renderOneDrawing(d, coord, selected) {
  const g = drawingGeometry(d, coord);
  const grp = svgEl('g', { class: 'chart-draw-item' + (selected ? ' selected' : ''), 'data-draw-id': d.id });
  const style = _drawStyleCss(d);
  const color = d.style && d.style.color;
  if (d.type === 'hline') {
    grp.appendChild(svgEl('line', { class: 'chart-draw-line', x1: g.x1, y1: g.y, x2: g.x2, y2: g.y, style }));
    grp.appendChild(priceTag(coord, g.y, d.points[0].price, color || null));
    _lineLabel(grp, d, coord.plotLeft + 6, g.y - 5, color);
  } else if (d.type === 'trend') {
    grp.appendChild(svgEl('line', { class: 'chart-draw-line', x1: g.ax, y1: g.ay, x2: g.bx, y2: g.by, style }));
    _lineLabel(grp, d, (g.ax + g.bx) / 2, (g.ay + g.by) / 2 - 5, color);
  } else if (d.type === 'rect') {
    const lx = Math.min(g.ax, g.bx), rx = Math.max(g.ax, g.bx);
    const ty = Math.min(g.ay, g.by), bottom = Math.max(g.ay, g.by);
    grp.appendChild(svgEl('rect', { class: 'chart-draw-rect', x: lx, y: ty, width: rx - lx, height: bottom - ty, style: _drawStyleCss(d, true) }));
    // Optional internal guides (toggled from the right-click menu): the 50% midline and the
    // 25%/75% quarter levels, drawn across the box width and following the rect's colour.
    const st = d.style || {};
    const lvlStyle = color ? 'stroke:' + color : null;
    if (st.quarters) [0.25, 0.75].forEach(f => {
      const y = ty + (bottom - ty) * f;
      grp.appendChild(svgEl('line', { class: 'chart-draw-rect-quarter', x1: lx, y1: y, x2: rx, y2: y, style: lvlStyle }));
    });
    if (st.mid) {
      const y = (ty + bottom) / 2;
      grp.appendChild(svgEl('line', { class: 'chart-draw-rect-mid', x1: lx, y1: y, x2: rx, y2: y, style: lvlStyle }));
    }
  } else if (d.type === 'fib') {
    const p0 = d.points[0].price, p1 = d.points[1].price;
    const st = d.style || {};
    // Levels run from the fib's left anchor to the right edge (no infinite left extension); the
    // value labels sit on the RIGHT, right-aligned. Off-screen-left anchor → clamp to the pane edge.
    const fibLeft = Math.max(coord.plotLeft, Math.min(g.ax, g.bx));
    fibLevelObjs(d).forEach(o => {
      const r = o.r, price = p0 + (p1 - p0) * r, y = coord.yForPrice(price);
      // Each level can override the drawing's base colour / width / dash; otherwise inherits them.
      const lc = o.color || color;
      const lw = o.width || st.width;
      const ld = (o.dash != null) ? o.dash : st.dash;
      let ls = '';
      if (lc) ls += 'stroke:' + lc + ';';
      if (lw) ls += 'stroke-width:' + lw + ';';
      if (ld) ls += 'stroke-dasharray:6,4;';
      grp.appendChild(svgEl('line', { class: 'chart-draw-fibline', x1: fibLeft, y1: y, x2: coord.plotRight, y2: y, style: ls || null }));
      const t = svgEl('text', { class: 'chart-draw-fiblabel', x: coord.plotRight - 4, y: y - 2, style: o.color ? 'fill:' + o.color : null });
      t.textContent = `${(r * 100).toFixed(1)}%  ${price.toFixed(coord.dec)}`;
      grp.appendChild(t);
    });
    // Subtle dashed connector between the two anchor points, so the swing the retracement is
    // measured from is easy to read (the 0%→100% leg). Keeps its dash; only the color follows.
    grp.appendChild(svgEl('line', { class: 'chart-draw-fibtrend', x1: g.ax, y1: g.ay, x2: g.bx, y2: g.by, style: color ? 'stroke:' + color : null }));
  } else if (d.type === 'hray') {
    grp.appendChild(svgEl('line', { class: 'chart-draw-line', x1: g.x1, y1: g.y, x2: g.x2, y2: g.y, style }));
    grp.appendChild(priceTag(coord, g.y, d.points[0].price, color || null));
    _lineLabel(grp, d, g.x1 + 6, g.y - 5, color);
  } else if (d.type === 'vline') {
    grp.appendChild(svgEl('line', { class: 'chart-draw-line', x1: g.x, y1: g.top, x2: g.x, y2: g.bottom, style }));
    _lineLabel(grp, d, g.x + 6, g.top + 12, color);
  } else if (d.type === 'text') {
    const st = d.style || {};
    let ts = '';
    if (color) ts += 'fill:' + color + ';';
    if (st.fontSize) ts += 'font-size:' + st.fontSize + 'px;';
    const t = svgEl('text', { class: 'chart-draw-text', x: g.ax, y: g.ay, style: ts || null });
    t.textContent = d.text || '';
    grp.appendChild(t);
  } else if (d.type === 'pencil' || d.type === 'marker') {
    const st = d.style || {};
    const pts = g.pts;
    if (pts.length) {
      const dPath = 'M' + pts.map(p => `${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' L');
      let ps = '';
      if (color) ps += 'stroke:' + color + ';';
      if (st.width) ps += 'stroke-width:' + st.width + ';';
      grp.appendChild(svgEl('path', { class: d.type === 'marker' ? 'chart-draw-marker' : 'chart-draw-pencil', d: dPath, style: ps || null }));
    }
  } else if (d.type === 'symbol' || d.type === 'arrowup' || d.type === 'arrowdown') {
    const st = d.style || {};
    if (d.emoji) {
      const t = svgEl('text', { class: 'chart-draw-emoji', x: g.ax, y: g.ay, style: st.fontSize ? 'font-size:' + st.fontSize + 'px' : null });
      t.textContent = d.emoji;
      grp.appendChild(t);
    } else {
      const sym = d.sym || d.type;   // back-compat: legacy arrowup/arrowdown types
      const def = SYMBOL_SHAPES[sym] || SYMBOL_SHAPES.arrowup;
      grp.appendChild(svgEl('path', { class: def.fill ? 'chart-draw-arrow' : 'chart-draw-symbol-stroke', d: def.path(g.ax, g.ay), style: color ? (def.fill ? 'fill:' + color : 'stroke:' + color) : null }));
    }
  } else if (d.type === 'fibtime') {
    const st = d.style || {};
    const t0 = new Date(d.points[0].date).getTime(), t1 = new Date(d.points[1].date).getTime();
    const unit = t1 - t0;
    fibTimeLevelObjs(d).forEach(o => {
      const x = coord.xForTime(t0 + o.n * unit);
      if (x < coord.plotLeft - 1 || x > coord.plotRight + 1) return;   // off-screen → skip
      // Each multiple can override the drawing's base colour / width / dash; otherwise inherits them.
      const lc = o.color || color, lw = o.width || st.width, ld = (o.dash != null) ? o.dash : st.dash;
      let ls = '';
      if (lc) ls += 'stroke:' + lc + ';';
      if (lw) ls += 'stroke-width:' + lw + ';';
      if (ld) ls += 'stroke-dasharray:6,4;';
      grp.appendChild(svgEl('line', { class: 'chart-draw-fibtime', x1: x, y1: coord.plotTop, x2: x, y2: coord.plotBottom, style: ls || null }));
      const lbl = svgEl('text', { class: 'chart-draw-fibtime-num', x: x + 3, y: coord.plotTop + 11, style: (o.color || color) ? 'fill:' + (o.color || color) : null });
      lbl.textContent = String(o.n);
      grp.appendChild(lbl);
    });
    // Connector between the two anchor points (the 0→1 base interval), like the retracement's.
    grp.appendChild(svgEl('line', { class: 'chart-draw-fibtrend', x1: g.ax, y1: g.ay, x2: g.bx, y2: g.by, style: color ? 'stroke:' + color : null }));
  } else if (d.type === 'long' || d.type === 'short') {
    const entry = d.points[0].price, lx = g.leftX, rx = g.rightX, w = rx - lx;
    grp.appendChild(svgEl('rect', { class: 'chart-draw-rr-reward', x: lx, y: Math.min(g.entryY, g.targetY), width: w, height: Math.abs(g.targetY - g.entryY) }));
    grp.appendChild(svgEl('rect', { class: 'chart-draw-rr-risk', x: lx, y: Math.min(g.entryY, g.stopY), width: w, height: Math.abs(g.stopY - g.entryY) }));
    [g.targetY, g.entryY, g.stopY].forEach(y => grp.appendChild(svgEl('line', { class: 'chart-draw-rr-line', x1: lx, y1: y, x2: rx, y2: y })));
    const risk = Math.abs(entry - d.stop), reward = Math.abs(d.target - entry);
    const rr = risk ? (reward / risk) : 0, midX = (lx + rx) / 2;
    // signed distance from entry, in price points + % move
    const tgtPts = d.target - entry, stpPts = d.stop - entry;
    const fmtPts = v => (v >= 0 ? '+' : '') + v.toFixed(coord.dec);
    const fmtPct = v => (v >= 0 ? '+' : '') + (entry ? (v / entry * 100) : 0).toFixed(2) + '%';
    const mk = (y, txt, cls) => { const t = svgEl('text', { class: 'chart-draw-rr-label ' + cls, x: midX, y: y - 3 }); t.textContent = txt; grp.appendChild(t); };
    mk(g.targetY, `Target ${d.target.toFixed(coord.dec)} · ${fmtPts(tgtPts)} (${fmtPct(tgtPts)})`, 'rr-up');
    mk(g.stopY, `Stop ${d.stop.toFixed(coord.dec)} · ${fmtPts(stpPts)} (${fmtPct(stpPts)})`, 'rr-down');
    mk(g.entryY, `Entry ${entry.toFixed(coord.dec)} · R/R ${rr.toFixed(2)}`, 'rr-mid');
  }
  if (selected) handlePoints(d, g).forEach(hp => grp.appendChild(svgEl('circle', { class: 'chart-draw-handle', cx: hp.x, cy: hp.y, r: 4 })));
  return grp;
}

// ── entry point #1: (re)build the persistent draw layer, clipped to the price pane ──
function renderChartDrawings(svg, coord) {
  if (!svg) return;
  svg.querySelectorAll('.chart-draw-layer').forEach(el => el.remove());
  if (!drawState.hideDrawings) {   // visibility toggle: skip the whole layer when drawings are hidden
    const layer = svgEl('g', { class: 'chart-draw-layer', 'pointer-events': 'none' });
    const clip = svgEl('clipPath', { id: 'chartDrawClip' });
    clip.appendChild(svgEl('rect', { x: coord.plotLeft, y: coord.plotTop, width: coord.plotRight - coord.plotLeft, height: coord.priceH }));
    layer.appendChild(clip);
    const shapes = svgEl('g', { 'clip-path': 'url(#chartDrawClip)' });
    drawingsForKey(currentDrawKey()).forEach(d => shapes.appendChild(renderOneDrawing(d, coord, d.id === drawState.selectedId)));
    layer.appendChild(shapes);
    svg.appendChild(layer);
  }
  // Keep the object tree in sync — every create/delete/select/market-switch rebuilds the chart.
  if (typeof renderObjectTree === 'function') renderObjectTree();
}

// ── entry point #2: interaction. Full implementation. ──

// Hit-test a drawing in pixel space. Handles (point index) only when the drawing is selected.
function hitTestDrawing(d, coord, px, py, isSelected) {
  const TOL = 6;
  const g = drawingGeometry(d, coord);
  if (isSelected) {
    const hs = handlePoints(d, g);
    // Return the handle's array index; reshape looks the descriptor back up via handlePoints().
    for (let i = 0; i < hs.length; i++) if (Math.hypot(px - hs[i].x, py - hs[i].y) <= TOL + 2) return { hit: true, handle: i };
  }
  let hit = false;
  if (d.type === 'hline') hit = Math.abs(py - g.y) <= TOL && px >= g.x1 - TOL && px <= g.x2 + TOL;
  else if (d.type === 'hray') hit = Math.abs(py - g.y) <= TOL && px >= g.x1 - TOL && px <= g.x2 + TOL;
  else if (d.type === 'vline') hit = Math.abs(px - g.x) <= TOL && py >= g.top - TOL && py <= g.bottom + TOL;
  else if (d.type === 'trend') hit = distToSegment(px, py, g.ax, g.ay, g.bx, g.by) <= TOL;
  else if (d.type === 'rect') hit = px >= Math.min(g.ax, g.bx) - TOL && px <= Math.max(g.ax, g.bx) + TOL && py >= Math.min(g.ay, g.by) - TOL && py <= Math.max(g.ay, g.by) + TOL;
  else if (d.type === 'fib') { const lx = Math.max(coord.plotLeft, Math.min(g.ax, g.bx)); hit = px >= lx - TOL && px <= coord.plotRight + TOL && fibLevelYs(d, coord).some(y => Math.abs(py - y) <= TOL); }
  else if (d.type === 'text') { const w = (d.text || '').length * 7 + 8; hit = px >= g.ax - TOL && px <= g.ax + w && py >= g.ay - 14 && py <= g.ay + 6; }
  else if (d.type === 'symbol' || d.type === 'arrowup' || d.type === 'arrowdown') hit = px >= g.ax - 12 && px <= g.ax + 12 && py >= g.ay - 18 && py <= g.ay + 18;
  else if (d.type === 'fibtime') { const t0 = new Date(d.points[0].date).getTime(), t1 = new Date(d.points[1].date).getTime(), unit = t1 - t0; hit = py >= coord.plotTop - TOL && py <= coord.plotBottom + TOL && fibTimeLevelObjs(d).some(o => Math.abs(px - coord.xForTime(t0 + o.n * unit)) <= TOL); }
  else if (d.type === 'long' || d.type === 'short') { const top = Math.min(g.stopY, g.targetY), bot = Math.max(g.stopY, g.targetY); hit = px >= g.leftX - TOL && px <= g.rightX + TOL && py >= top - TOL && py <= bot + TOL; }
  else if (d.type === 'pencil' || d.type === 'marker') { const pts = g.pts, t = TOL + (d.type === 'marker' ? 7 : 1); for (let i = 1; i < pts.length; i++) if (distToSegment(px, py, pts[i - 1].x, pts[i - 1].y, pts[i].x, pts[i].y) <= t) { hit = true; break; } }
  return { hit, handle: -1 };
}

// Interaction: ONE mousedown on the crosshair hit-zone, branching on the live drawState.tool.
// Measure ('measure') and pure inspect ('crosshair') are no-ops here (measure runs via chart.js's
// gated legacy handler). A full chart rebuild (rerender) happens only on COMMIT, never per-move —
// in-progress shapes/drags render into a lightweight preview <g>, like the existing measure tool.
const MAGNET_SNAP_PX = 8;   // magnet is always light: only snap when the cursor is within this many px of a candle level

// Magnet (TradingView-style, always LIGHT): when on, snap a price to the nearest O/H/L/C of the
// visible bar nearest x — but ONLY when the cursor is already within MAGNET_SNAP_PX of that level.
// Otherwise (and when the magnet is off) the free cursor price is used, so anchors stay drawable
// anywhere and only gently click onto a candle when you're right next to one.
function magnetSnapPrice(coord, x, y) {
  const free = coord.priceFromY(y);
  if (!drawState.magnet) return free;
  const bars = coord.bars, barXs = coord.barXs;
  if (!bars || !bars.length || !barXs || !barXs.length) return free;
  let bi = 0, bd = Math.abs(barXs[0] - x);
  for (let i = 1; i < barXs.length; i++) { const d = Math.abs(barXs[i] - x); if (d < bd) { bd = d; bi = i; } }
  const b = bars[bi];
  const cands = [b.open, b.high, b.low, b.close].filter(Number.isFinite);
  if (!cands.length) return free;
  let best = cands[0], bestD = Math.abs(coord.yForPrice(cands[0]) - y);
  for (let i = 1; i < cands.length; i++) { const d = Math.abs(coord.yForPrice(cands[i]) - y); if (d < bestD) { bestD = d; best = cands[i]; } }
  if (bestD > MAGNET_SNAP_PX) return free;
  return best;
}

function bindChartDrawingInteractions(wrap, coord, rerender) {
  const svg = wrap.querySelector('svg');
  const hit = wrap.querySelector('.chart-crosshair-hit');
  if (!svg || !hit) return;

  // The Cursor tool is a plain arrow (select/move) — override the hit-zone's CSS crosshair pointer.
  // Every other tool keeps the crosshair pointer. Re-runs on each render, so it tracks tool changes.
  hit.style.cursor = drawState.tool === 'cursor' ? 'default' : 'crosshair';

  const local = (evt) => {
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = evt.clientX; pt.y = evt.clientY;
    return pt.matrixTransform(ctm.inverse());
  };
  const cx = (x) => clampN(x, coord.plotLeft, coord.plotRight);
  const cy = (y) => clampN(y, coord.plotTop, coord.plotBottom);
  const inPlot = (p) => p.x >= coord.plotLeft - 6 && p.x <= coord.plotRight + 6 && p.y >= coord.plotTop - 6 && p.y <= coord.plotBottom + 6;

  let preview = null;
  const previewShow = (drawing) => {
    if (!preview) { preview = svgEl('g', { class: 'chart-draw-preview', 'pointer-events': 'none' }); svg.appendChild(preview); }
    preview.innerHTML = '';
    preview.appendChild(renderOneDrawing({ ...drawing, id: '__preview__' }, coord, true));
  };
  const previewClear = () => { if (preview) { preview.remove(); preview = null; } };

  const commit = (drawing) => {
    const key = currentDrawKey();
    if (!key) return;
    const arr = drawingsForKey(key);
    drawing.id = nextDrawId(arr);
    arr.push(drawing);
    saveDrawingsForKey(key, arr);
    drawState.selectedId = drawing.id;
    drawState.tool = 'cursor';
    renderDrawToolbar();
    rerender();
  };

  // --- create (drawing tools) ---
  function startCreate(evt, p0, type) {
    evt.preventDefault();
    const sx = cx(p0.x), sy = cy(p0.y);
    const anchor = () => ({ date: coord.snapDate(sx), price: magnetSnapPrice(coord, sx, sy) });
    // Single-click marks (commit immediately, no drag):
    if (type === 'hline') { commit({ type: 'hline', points: [{ date: null, price: magnetSnapPrice(coord, sx, sy) }] }); return; }
    if (type === 'hray') { commit({ type: 'hray', points: [anchor()] }); return; }
    if (type === 'vline') { commit({ type: 'vline', points: [anchor()] }); return; }
    if (type === 'symbol') {
      const s = drawState.symbol || { sym: 'arrowup' };
      const dr = { type: 'symbol', points: [anchor()] };
      if (s.emoji) dr.emoji = s.emoji; else dr.sym = s.sym || 'arrowup';
      commit(dr); return;
    }
    // Freehand pencil / highlighter: capture a sampled path (no magnet); commit on release.
    if (type === 'pencil' || type === 'marker') {
      const toData = (x, y) => ({ date: new Date(coord.timeForX(cx(x))).toISOString(), price: coord.priceFromY(cy(y)) });
      const pts = [toData(p0.x, p0.y)];
      let lastX = p0.x, lastY = p0.y;
      const onMove = (e2) => {
        const q = local(e2); if (!q) return;
        if (Math.hypot(q.x - lastX, q.y - lastY) < 2.5) return;   // sample, don't store every pixel
        lastX = q.x; lastY = q.y;
        pts.push(toData(q.x, q.y));
        previewShow({ type, points: pts.slice() });
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        previewClear();
        if (pts.length >= 2) commit({ type, points: pts });
        else { drawState.tool = 'cursor'; renderDrawToolbar(); rerender(); }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp, { once: true });
      return;
    }
    if (type === 'text') {
      const txt = window.prompt('Text:');
      if (txt && txt.trim()) commit({ type: 'text', text: txt.trim(), points: [anchor()] });
      else { drawState.tool = 'cursor'; renderDrawToolbar(); rerender(); }
      return;
    }
    // Both anchors use the (always-light) magnet: they snap to a candle O/H/L/C only when the cursor
    // is right next to one, otherwise they stay wherever you drop them. Magnet off → fully free.
    const build = (x1, y1) => {
      const a = { date: coord.snapDate(sx), price: magnetSnapPrice(coord, sx, sy) };
      const b = { date: coord.snapDate(x1), price: magnetSnapPrice(coord, x1, y1) };
      if (type === 'long' || type === 'short') {
        // Direction is fixed by the chosen tool (Long → target above entry, Short → below); the drag
        // magnitude sets the reward distance. Stop is auto-placed at half that (a 2:1 default).
        const entry = a.price, rel = magnetSnapPrice(coord, x1, y1);
        const dist = Math.abs(rel - entry) || entry * 0.01;
        const target = type === 'long' ? entry + dist : entry - dist;
        const stop = type === 'long' ? entry - dist / 2 : entry + dist / 2;
        return { type, points: [{ date: a.date, price: entry }, { date: b.date, price: entry }], stop, target };
      }
      return { type, points: [a, b] };
    };
    const onMove = (e2) => { const q = local(e2); if (q) previewShow(build(cx(q.x), cy(q.y))); };
    const onUp = (e2) => {
      document.removeEventListener('mousemove', onMove);
      const q = local(e2) || { x: sx, y: sy };
      const x1 = cx(q.x), y1 = cy(q.y);
      previewClear();
      if (Math.abs(x1 - sx) + Math.abs(y1 - sy) < 4) return;   // stray click, not a drag
      commit(build(x1, y1));
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
    onMove(evt);
  }

  // --- cursor: select / move / reshape ---
  function startCursor(evt, p0) {
    const key = currentDrawKey();
    const items = drawingsForKey(key);
    let target = null, handleIndex = -1;
    for (let i = items.length - 1; i >= 0; i--) {
      const ht = hitTestDrawing(items[i], coord, p0.x, p0.y, items[i].id === drawState.selectedId);
      if (ht.hit) { target = items[i]; handleIndex = ht.handle; break; }
    }
    if (!target) { if (drawState.selectedId) { drawState.selectedId = null; rerender(); } return; }
    evt.preventDefault();
    drawState.selectedId = target.id;
    const sx = p0.x, sy = p0.y;
    const orig = target.points.map(pt => ({ ...pt }));
    // Grabbing a handle: capture its descriptor now. For a rect it tells us which bounding-box side
    // this handle drives; map that to the point that currently owns the side (by orig geometry) so an
    // edge handle moves only that side — e.g. the right edge extends purely to the right.
    const handleDesc = handleIndex >= 0 ? handlePoints(target, drawingGeometry(target, coord))[handleIndex] : null;
    let rectRoles = null;
    if (handleDesc && handleDesc.kind === 'rect') {
      const ta = new Date(orig[0].date).getTime(), tb = new Date(orig[1].date).getTime();
      rectRoles = {
        leftPt:  ta <= tb ? 0 : 1, rightPt: ta <= tb ? 1 : 0,
        topPt:   orig[0].price >= orig[1].price ? 0 : 1, botPt: orig[0].price >= orig[1].price ? 1 : 0,
      };
    }
    let rrIdx = null;
    if (handleDesc && handleDesc.kind === 'rr') {
      const ta = new Date(orig[0].date).getTime(), tb = new Date(orig[1].date).getTime();
      rrIdx = { left: ta <= tb ? 0 : 1, right: ta <= tb ? 1 : 0 };
    }
    let moved = false, work = null;
    const hideStored = () => { const el = svg.querySelector(`.chart-draw-layer [data-draw-id="${target.id}"]`); if (el) el.style.display = 'none'; };
    const onMove = (e2) => {
      const q = local(e2);
      if (!q) return;
      moved = true; hideStored();
      const dx = q.x - sx, dy = q.y - sy;
      work = { ...target, points: orig.map(pt => ({ ...pt })) };
      if (handleDesc && handleDesc.kind === 'rr') {
        // Risk/reward handles: entry moves the entry line (+ left edge), right sets width,
        // target/stop move their own level. Price uses the always-light magnet; off → free.
        work.stop = target.stop; work.target = target.target;
        const price = magnetSnapPrice(coord, cx(q.x), cy(q.y));
        if (handleDesc.role === 'entry') { work.points[0].price = price; work.points[1].price = price; work.points[rrIdx.left].date = coord.snapDate(cx(q.x)); }
        else if (handleDesc.role === 'right') { work.points[rrIdx.right].date = coord.snapDate(cx(q.x)); }
        else if (handleDesc.role === 'target') { work.target = price; }
        else if (handleDesc.role === 'stop') { work.stop = price; }
      } else if (handleDesc && handleDesc.kind === 'rect') {
        // Rect handle: drive only the side(s) it owns, leaving the others fixed. Corners move both a
        // date and a price; edge handles move just one. Price uses the (always-light) magnet; off → free.
        const t1 = coord.snapDate(cx(q.x)), p1 = magnetSnapPrice(coord, cx(q.x), cy(q.y));
        if (handleDesc.dx === 'left')   work.points[rectRoles.leftPt].date  = t1;
        if (handleDesc.dx === 'right')  work.points[rectRoles.rightPt].date = t1;
        if (handleDesc.dy === 'top')    work.points[rectRoles.topPt].price  = p1;
        if (handleDesc.dy === 'bottom') work.points[rectRoles.botPt].price  = p1;
      } else if (handleIndex >= 0) {
        const pt = work.points[handleIndex];
        // Every anchor uses the always-light magnet on reshape (snaps only near a candle; off → free).
        pt.price = magnetSnapPrice(coord, cx(q.x), cy(q.y));
        if (pt.date != null) pt.date = coord.snapDate(cx(q.x));
      } else {
        const dPrice = coord.priceFromY(cy(sy + dy)) - coord.priceFromY(cy(sy));
        // Uniform time shift from the drag, applied to every point and snapped against the FULL bar
        // set — so an endpoint scrolled off-screen keeps its (shifted) date instead of collapsing to
        // the visible plot edge.
        const dT = coord.timeForX(cx(sx + dx)) - coord.timeForX(cx(sx));
        const freehand = target.type === 'pencil' || target.type === 'marker';
        work.points = orig.map(pt => {
          const np = { ...pt, price: pt.price + dPrice };
          // Freehand keeps continuous (un-snapped) timestamps so the sketch shape isn't quantized to bars.
          if (pt.date != null) np.date = freehand ? new Date(new Date(pt.date).getTime() + dT).toISOString() : coord.snapDateAny(new Date(pt.date).getTime() + dT);
          return np;
        });
        if (target.type === 'long' || target.type === 'short') { work.stop = target.stop + dPrice; work.target = target.target + dPrice; }
      }
      previewShow(work);
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      previewClear();
      if (moved && work) {
        const fresh = drawingsForKey(key);
        const t = fresh.find(d => d.id === target.id);
        if (t) { t.points = work.points; if (work.stop != null) t.stop = work.stop; if (work.target != null) t.target = work.target; saveDrawingsForKey(key, fresh); }
      }
      rerender();   // also repaints handles for a plain selection click
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp, { once: true });
  }

  hit.addEventListener('mousedown', (evt) => {
    if (evt.button !== 0) return;
    const tool = drawState.tool;
    if (tool === 'crosshair') return;   // crosshair = inspect + drag-to-measure, handled by the legacy measure path in chart.js
    const p = local(evt);
    if (!p) return;
    if (tool === 'cursor') { startCursor(evt, p); return; }
    if (!inPlot(p)) return;
    startCreate(evt, p, tool);
  });

  // Right-click a drawing → select it and open the edit menu (color / thickness / style / delete).
  // Off a drawing, leave the native context menu alone.
  hit.addEventListener('contextmenu', (evt) => {
    const p = local(evt);
    if (!p) return;
    const items = drawingsForKey(currentDrawKey());
    let target = null;
    for (let i = items.length - 1; i >= 0; i--) {
      if (hitTestDrawing(items[i], coord, p.x, p.y, false).hit) { target = items[i]; break; }
    }
    if (!target) return;
    evt.preventDefault();
    drawState.tool = 'cursor';
    drawState.selectedId = target.id;
    renderDrawToolbar();
    rerender();                       // show the selection handles…
    openDrawContextMenu(evt.clientX, evt.clientY, target.id);   // …then the edit menu on top
  });
}

// ── repaint the Charts-tab chart (rebuilds the draw layer with current state) ──
function repaintChartForDrawings() {
  if (typeof renderBigChart === 'function' && typeof currentBigChartCfg === 'function') {
    const cfg = currentBigChartCfg();
    if (cfg) renderBigChart(cfg);
  }
}

// ── toolbar (left-edge vertical strip) ──
// Per-tool metadata; tools are exposed either as direct buttons or grouped into a flyout "area".
const TOOL_META = {
  cursor:    { title: 'Cursor — select & move (Esc)', icon: '<path d="M5 3l14 7-6 1.5L9.5 18z"/>' },
  crosshair: { title: 'Crosshair — inspect; hold left button + drag to measure', icon: '<path d="M12 3v6M12 15v6M3 12h6M15 12h6"/>' },
  trend:     { title: 'Trend line', icon: '<path d="M4 19L20 5"/>' },
  hline:     { title: 'Horizontal line', icon: '<path d="M3 12h18"/>' },
  hray:      { title: 'Horizontal ray — extends right only', icon: '<path d="M4 12h16"/><path d="M4 8v8"/>' },
  vline:     { title: 'Vertical line', icon: '<path d="M12 3v18"/>' },
  fib:       { title: 'Fibonacci retracement', icon: '<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/>' },
  fibtime:   { title: 'Fibonacci time zones', icon: '<path d="M4 4v16M8 4v16M13 4v16M20 4v16"/>' },
  rect:      { title: 'Rectangle / zone', icon: '<rect x="4" y="6" width="16" height="12" rx="1"/>' },
  long:      { title: 'Long position — risk / reward', icon: '<path d="M4 13h16M4 6h16v12H4z"/><path d="M8.5 11.5L12 8l3.5 3.5"/>' },
  short:     { title: 'Short position — risk / reward', icon: '<path d="M4 11h16M4 6h16v12H4z"/><path d="M8.5 12.5L12 16l3.5-3.5"/>' },
  text:      { title: 'Text', icon: '<path d="M5 5h14M12 5v14"/>' },
  pencil:    { title: 'Pencil — freehand', icon: '<path d="M4 20l3.2-.9L18 8.3 15.7 6 5 16.8z"/><path d="M14 7l3 3"/>' },
  marker:    { title: 'Highlighter — freehand', icon: '<path d="M4 21h6"/><path d="M7 17l-1.2 3 3.2-1 9-9-2.5-2.5z"/><path d="M14.5 7l2.5 2.5"/>' },
};
// Grouped flyout areas — one drawbar button each opens a picker of the group's tools.
const TOOL_GROUPS = [
  { key: 'lines', title: 'Lines', icon: '<path d="M4 20L20 4"/><path d="M3 12h18"/>', tools: ['trend', 'hline', 'hray', 'vline'] },
  { key: 'fib',   title: 'Fibonacci', icon: '<path d="M3 6h18M3 12h18M3 18h18"/>', tools: ['fib', 'fibtime'] },
  { key: 'rr',    title: 'Risk / Reward', icon: '<path d="M4 12h16M4 6h16v12H4z"/><path d="M8.5 9.5L12 6l3.5 3.5M8.5 14.5L12 18l3.5-3.5"/>', tools: ['long', 'short'] },
  { key: 'brush', title: 'Freehand', icon: '<path d="M4 20l3.2-.9L18 8.3 15.7 6 5 16.8z"/><path d="M14 7l3 3"/>', tools: ['pencil', 'marker'] },
];
function _drawIconBtn(inner, cls, attrs) {
  return `<button class="draw-tool-btn ${cls}" type="button" ${attrs}>`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${inner}</svg></button>`;
}
function _toolBtn(t) {
  return _drawIconBtn(TOOL_META[t].icon, drawState.tool === t ? 'active' : '',
    `title="${TOOL_META[t].title}" aria-label="${TOOL_META[t].title}" onclick="setDrawTool('${t}')"`);
}
function _groupBtn(g) {
  const active = g.tools.includes(drawState.tool);
  return `<button id="drawGroupBtn-${g.key}" class="draw-tool-btn has-flyout ${active ? 'active' : ''}" type="button" title="${g.title}" aria-label="${g.title}" onclick="toggleGroupFlyout('${g.key}',this)">`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${g.icon}</svg></button>`;
}
function renderDrawToolbar() {
  const bar = document.getElementById('bigchartDrawbar');
  if (!bar) return;
  const symActive = drawState.tool === 'symbol' || drawState.tool === 'arrowup' || drawState.tool === 'arrowdown';
  const grp = k => TOOL_GROUPS.find(g => g.key === k);
  bar.innerHTML =
    _toolBtn('cursor') + _toolBtn('crosshair')
    + '<div class="draw-tool-sep"></div>'
    + _groupBtn(grp('lines')) + _groupBtn(grp('fib')) + _toolBtn('rect') + _groupBtn(grp('rr'))
    + _groupBtn(grp('brush')) + _toolBtn('text')
    + `<button id="drawSymbolBtn" class="draw-tool-btn has-flyout ${symActive ? 'active' : ''}" type="button" title="Symbols & emojis — pick one to place" aria-label="Symbols and emojis" onclick="toggleSymbolFlyout(this)">`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M8.7 14a4 4 0 0 0 6.6 0"/><path d="M9 9.5h.01M15 9.5h.01"/></svg></button>`
    + '<div class="draw-tool-sep"></div>'
    + _drawIconBtn('<path d="M6 4v6a6 6 0 0 0 12 0V4"/><path d="M3 4h6M15 4h6"/>', drawState.magnet ? 'active' : '',
      `title="Magnet — lightly snap anchors to a nearby candle O/H/L/C" aria-label="Magnet snap" aria-pressed="${drawState.magnet}" onclick="toggleMagnet()"`)
    + _drawIconBtn('<rect x="3" y="4" width="5" height="5" rx="1"/><rect x="3" y="13" width="5" height="5" rx="1"/><path d="M11 6.5h10M11 15.5h10"/>', drawState.objTree ? 'active' : '',
      `title="Object tree — list & select every drawing" aria-label="Object tree" aria-pressed="${drawState.objTree}" onclick="toggleObjectTree()"`)
    + `<button id="drawVisBtn" class="draw-tool-btn has-flyout ${(drawState.hideDrawings || (typeof bigChartState !== 'undefined' && bigChartState._indHidden)) ? 'active' : ''}" type="button" title="Visibility — hide drawings / indicators" aria-label="Visibility" onclick="toggleVisFlyout(this)">`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg></button>`
    + '<div class="draw-tool-sep"></div>'
    + _drawIconBtn('<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', 'draw-action',
      `title="Delete selected (Del)" aria-label="Delete selected" onclick="deleteSelectedDrawing()"`)
    + _drawIconBtn('<path d="M5 5l14 14M19 5L5 19"/>', 'draw-action',
      `title="Clear all drawings" aria-label="Clear all drawings" onclick="clearAllDrawings()"`)
    + '<div class="draw-tool-sep"></div>'
    + _drawIconBtn('<path d="M4 8h3l2-2h6l2 2h3v11H4z"/><circle cx="12" cy="13.5" r="3.2"/>', 'draw-action',
      `title="Screenshot — download the chart as PNG" aria-label="Chart screenshot" onclick="exportChartScreenshot()"`);
}
function toggleMagnet() {
  drawState.magnet = !drawState.magnet;
  renderDrawToolbar();   // reflect the active state; magnet only affects subsequent drawing, no chart repaint needed
}
function setDrawTool(name) {
  drawState.tool = name;
  if (name !== 'cursor') drawState.selectedId = null;   // selection only meaningful with the cursor
  if (typeof closeDrawContextMenu === 'function') closeDrawContextMenu();
  if (typeof closeSymbolFlyout === 'function') closeSymbolFlyout();
  if (typeof closeVisFlyout === 'function') closeVisFlyout();
  if (typeof closeGroupFlyout === 'function') closeGroupFlyout();
  renderDrawToolbar();
  repaintChartForDrawings();   // drop/redraw selection handles
}

// ── symbols & emojis flyout (arms a symbol; the next chart click places it) ──
function _symbolPreviewPath(k) {
  const def = SYMBOL_SHAPES[k];
  const at = { arrowup: [12, 4], arrowdown: [12, 20], arrowleft: [4, 12], arrowright: [20, 12] }[k] || [12, 12];
  return `<path d="${def.path(at[0], at[1])}"/>`;
}
function toggleSymbolFlyout(btn) {
  if (document.getElementById('drawSymbolFlyout')) { closeSymbolFlyout(); return; }
  const fly = document.createElement('div');
  fly.id = 'drawSymbolFlyout';
  fly.className = 'draw-symflyout';
  const shapes = Object.keys(SYMBOL_SHAPES).map(k =>
    `<button class="draw-sym-btn" type="button" title="${SYMBOL_SHAPES[k].label}" onclick="pickSymbol('${k}')">`
    + `<svg viewBox="0 0 24 24" width="18" height="18" fill="${SYMBOL_SHAPES[k].fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${_symbolPreviewPath(k)}</svg></button>`).join('');
  const emojis = SYMBOL_EMOJIS.map(e => `<button class="draw-sym-emoji" type="button" onclick="pickEmoji('${e}')">${e}</button>`).join('');
  fly.innerHTML = `<div class="draw-sym-head">Shapes</div><div class="draw-sym-grid">${shapes}</div>`
    + `<div class="draw-sym-head">Emojis</div><div class="draw-sym-grid draw-sym-emojis">${emojis}</div>`;
  document.body.appendChild(fly);
  const r = btn.getBoundingClientRect();
  const fw = fly.offsetWidth, fh = fly.offsetHeight;
  fly.style.left = Math.min(r.right + 6, window.innerWidth - fw - 8) + 'px';
  fly.style.top = Math.max(8, Math.min(r.top, window.innerHeight - fh - 8)) + 'px';
}
function closeSymbolFlyout() { const f = document.getElementById('drawSymbolFlyout'); if (f) f.remove(); }
function pickSymbol(k) { drawState.symbol = { sym: k }; closeSymbolFlyout(); setDrawTool('symbol'); }
function pickEmoji(e) { drawState.symbol = { emoji: e }; closeSymbolFlyout(); setDrawTool('symbol'); }

// ── grouped-tool flyout (Lines / Fibonacci / Freehand): pick a tool from the group ──
function toggleGroupFlyout(key, btn) {
  const existing = document.getElementById('drawGroupFlyout');
  if (existing) { const cur = existing.dataset.key; closeGroupFlyout(); if (cur === key) return; }
  const grp = TOOL_GROUPS.find(g => g.key === key);
  if (!grp) return;
  const fly = document.createElement('div');
  fly.id = 'drawGroupFlyout'; fly.className = 'draw-symflyout draw-groupflyout'; fly.dataset.key = key;
  fly.innerHTML = `<div class="draw-sym-head">${grp.title}</div>`
    + grp.tools.map(t => `<button class="draw-group-opt${drawState.tool === t ? ' active' : ''}" type="button" onclick="pickGroupTool('${t}')">`
      + `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${TOOL_META[t].icon}</svg><span>${TOOL_META[t].title}</span></button>`).join('');
  document.body.appendChild(fly);
  const r = btn.getBoundingClientRect(), fw = fly.offsetWidth, fh = fly.offsetHeight;
  fly.style.left = Math.min(r.right + 6, window.innerWidth - fw - 8) + 'px';
  fly.style.top = Math.max(8, Math.min(r.top, window.innerHeight - fh - 8)) + 'px';
}
function closeGroupFlyout() { const f = document.getElementById('drawGroupFlyout'); if (f) f.remove(); }
function pickGroupTool(t) { closeGroupFlyout(); setDrawTool(t); }

// ── visibility flyout: hide all drawings and/or all indicators (TradingView-style) ──
function _eyeSvg(open) {
  const head = '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">';
  return head + (open
    ? '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'
    : '<path d="M4 4l16 16"/><path d="M9.9 5.2A9.6 9.6 0 0 1 12 5c6.5 0 10 7 10 7a17 17 0 0 1-3 3.6M6.1 7.2A17 17 0 0 0 2 12s3.5 7 10 7a9.6 9.6 0 0 0 3.3-.6"/>') + '</svg>';
}
function _bigIndicatorKeys() { return ['showVolume', 'showOi', 'showCot', 'showSpread', 'showDividers', 'cotHedging']; }
function indicatorsHidden() { return typeof bigChartState !== 'undefined' && !!bigChartState._indHidden; }
function setIndicatorsHidden(hide) {
  if (typeof bigChartState === 'undefined') return;
  if (hide && !bigChartState._indHidden) {
    const saved = {};
    _bigIndicatorKeys().forEach(k => { saved[k] = bigChartState[k]; bigChartState[k] = false; });
    bigChartState._indSaved = saved; bigChartState._indHidden = true;
  } else if (!hide && bigChartState._indHidden) {
    const saved = bigChartState._indSaved || {};
    _bigIndicatorKeys().forEach(k => { if (k in saved) bigChartState[k] = saved[k]; });
    bigChartState._indSaved = null; bigChartState._indHidden = false;
  }
  if (typeof renderBigChartIndicatorBar === 'function') renderBigChartIndicatorBar();
  if (typeof renderBigChartTaBar === 'function') renderBigChartTaBar();   // dim/undim the TA chips
}
function toggleVisFlyout(btn) { if (document.getElementById('drawVisFlyout')) { closeVisFlyout(); return; } _renderVisFlyout(btn); }
function closeVisFlyout() { const f = document.getElementById('drawVisFlyout'); if (f) f.remove(); }
function _renderVisFlyout(btn) {
  const ref = btn || document.getElementById('drawVisBtn');
  const old = document.getElementById('drawVisFlyout'); if (old) old.remove();
  if (!ref) return;
  const dHidden = !!drawState.hideDrawings, iHidden = indicatorsHidden();
  const fly = document.createElement('div');
  fly.id = 'drawVisFlyout'; fly.className = 'draw-symflyout draw-visflyout';
  fly.innerHTML = `<div class="draw-sym-head">Visibility</div>`
    + `<button class="draw-vis-opt${dHidden ? ' off' : ''}" type="button" onclick="visToggleDrawings()">${_eyeSvg(!dHidden)}<span>Drawings</span></button>`
    + `<button class="draw-vis-opt${iHidden ? ' off' : ''}" type="button" onclick="visToggleIndicators()">${_eyeSvg(!iHidden)}<span>Indicators</span></button>`
    + `<div class="draw-vis-both"><button class="draw-ctx-btn" type="button" onclick="visSetBoth(true)">Hide both</button><button class="draw-ctx-btn" type="button" onclick="visSetBoth(false)">Show all</button></div>`;
  document.body.appendChild(fly);
  const r = ref.getBoundingClientRect(), fw = fly.offsetWidth, fh = fly.offsetHeight;
  fly.style.left = Math.min(r.right + 6, window.innerWidth - fw - 8) + 'px';
  fly.style.top = Math.max(8, Math.min(r.top, window.innerHeight - fh - 8)) + 'px';
}
function visToggleDrawings() { drawState.hideDrawings = !drawState.hideDrawings; renderDrawToolbar(); repaintChartForDrawings(); _renderVisFlyout(); }
function visToggleIndicators() { setIndicatorsHidden(!indicatorsHidden()); renderDrawToolbar(); repaintChartForDrawings(); _renderVisFlyout(); }
function visSetBoth(hide) { drawState.hideDrawings = hide; setIndicatorsHidden(hide); renderDrawToolbar(); repaintChartForDrawings(); _renderVisFlyout(); }
function deleteSelectedDrawing() {
  const key = currentDrawKey();
  if (!key || !drawState.selectedId) return;
  saveDrawingsForKey(key, drawingsForKey(key).filter(d => d.id !== drawState.selectedId));
  drawState.selectedId = null;
  repaintChartForDrawings();
}
function clearAllDrawings() {
  const key = currentDrawKey();
  if (!key) return;
  saveDrawingsForKey(key, []);
  drawState.selectedId = null;
  repaintChartForDrawings();
}

// ── object tree: a side list of every drawing on the current chart; click a row to select it ──
const OBJ_TREE_ICONS = {
  hline: '<path d="M3 12h18"/>',
  hray:  '<path d="M4 12h16"/><path d="M4 8v8"/>',
  vline: '<path d="M12 3v18"/>',
  trend: '<path d="M4 19L20 5"/>',
  fib:   '<path d="M3 5h18M3 10h18M3 14h18M3 19h18"/>',
  fibtime: '<path d="M4 4v16M8 4v16M13 4v16M20 4v16"/>',
  rect:  '<rect x="4" y="6" width="16" height="12" rx="1"/>',
  long:  '<path d="M4 13h16M4 6h16v12H4z"/>',
  short: '<path d="M4 11h16M4 6h16v12H4z"/>',
  text:  '<path d="M5 5h14M12 5v14"/>',
  symbol: '<circle cx="12" cy="12" r="9"/><path d="M8.7 14a4 4 0 0 0 6.6 0"/><path d="M9 9.5h.01M15 9.5h.01"/>',
  pencil: '<path d="M4 20l3.2-.9L18 8.3 15.7 6 5 16.8z"/><path d="M14 7l3 3"/>',
  marker: '<path d="M4 21h6"/><path d="M7 17l-1.2 3 3.2-1 9-9-2.5-2.5z"/><path d="M14.5 7l2.5 2.5"/>',
  arrowup:   '<path d="M12 4v16M6 10l6-6 6 6"/>',
  arrowdown: '<path d="M12 4v16M6 14l6 6 6-6"/>',
};
function _objTreeFmtPrice(p) {
  if (!Number.isFinite(p)) return '';
  const a = Math.abs(p), dec = a >= 100 ? 2 : (a >= 1 ? 3 : 5);
  return p.toFixed(dec);
}
function objTreeLabel(d) {
  if (d.type === 'hline') return 'Horizontal line · ' + _objTreeFmtPrice(d.points[0].price);
  if (d.type === 'hray')  return 'Horizontal ray · ' + _objTreeFmtPrice(d.points[0].price);
  if (d.type === 'vline') return 'Vertical line';
  if (d.type === 'trend') return 'Trend line';
  if (d.type === 'fib')   return 'Fib retracement';
  if (d.type === 'fibtime') return 'Fib time zones';
  if (d.type === 'rect')  return 'Rectangle';
  if (d.type === 'long')  return 'Long position';
  if (d.type === 'short') return 'Short position';
  if (d.type === 'text')  return 'Text · ' + (d.text || '').slice(0, 18);
  if (d.type === 'symbol') return d.emoji ? ('Emoji ' + d.emoji) : ('Symbol · ' + (SYMBOL_SHAPES[d.sym] ? SYMBOL_SHAPES[d.sym].label : (d.sym || '')));
  if (d.type === 'pencil') return 'Pencil';
  if (d.type === 'marker') return 'Highlighter';
  if (d.type === 'arrowup')   return 'Arrow up';
  if (d.type === 'arrowdown') return 'Arrow down';
  return d.type;
}
function toggleObjectTree() {
  drawState.objTree = !drawState.objTree;
  const panel = document.getElementById('bigchartObjTree');
  if (panel) panel.hidden = !drawState.objTree;   // change the layout BEFORE the chart measures its new width
  renderDrawToolbar();
  repaintChartForDrawings();   // re-render the chart at the new width; renderObjectTree runs at the end of renderChartDrawings
}
function renderObjectTree() {
  const panel = document.getElementById('bigchartObjTree');
  if (!panel) return;
  panel.hidden = !drawState.objTree;
  if (!drawState.objTree) { panel.innerHTML = ''; return; }
  const items = drawingsForKey(currentDrawKey());
  let html = '<div class="objtree-head"><span>Objects</span>'
    + (items.length ? '<button class="objtree-clear" type="button" title="Remove all drawings" onclick="clearAllDrawings()">Clear all</button>' : '')
    + '</div>';
  if (!items.length) {
    panel.innerHTML = html + '<div class="objtree-empty">No drawings yet</div>';
    return;
  }
  // Newest on top (drawing order is append; reverse so the latest is first, like a layer stack).
  html += items.slice().reverse().map(d => {
    const label = objTreeLabel(d);
    return '<div class="objtree-row' + (d.id === drawState.selectedId ? ' selected' : '') + '" '
      + `onclick="selectDrawing('${d.id}')" title="${label}">`
      + '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + (OBJ_TREE_ICONS[d.type] || '') + '</svg>'
      + '<span class="objtree-label">' + label + '</span>'
      + `<button class="objtree-del" type="button" title="Delete" onclick="event.stopPropagation();deleteDrawingById('${d.id}')">×</button>`
      + '</div>';
  }).join('');
  panel.innerHTML = html;
}
function selectDrawing(id) {
  drawState.tool = 'cursor';        // selection is only meaningful with the cursor (shows handles)
  drawState.selectedId = id;
  renderDrawToolbar();
  repaintChartForDrawings();
}
function deleteDrawingById(id) {
  const key = currentDrawKey();
  if (!key) return;
  saveDrawingsForKey(key, drawingsForKey(key).filter(d => d.id !== id));
  if (drawState.selectedId === id) drawState.selectedId = null;
  repaintChartForDrawings();
}

// ── right-click edit menu: per-drawing color / thickness / line style / delete ──
// Preset palette: 8 hue families × 6 shades + 6 neutrals (54 swatches); the custom picker covers the rest.
const DRAW_COLORS = [
  '#fca5a5', '#f87171', '#ef4444', '#dc2626', '#b91c1c', '#991b1b',  // red
  '#fdba74', '#fb923c', '#f97316', '#ea580c', '#c2410c', '#9a3412',  // orange
  '#fcd34d', '#fbbf24', '#f59e0b', '#d97706', '#b45309', '#92400e',  // amber
  '#86efac', '#4ade80', '#22c55e', '#16a34a', '#15803d', '#166534',  // green
  '#5eead4', '#2dd4bf', '#14b8a6', '#0d9488', '#0f766e', '#115e59',  // teal
  '#93c5fd', '#60a5fa', '#3b82f6', '#2563eb', '#1d4ed8', '#1e40af',  // blue
  '#d8b4fe', '#c084fc', '#a855f7', '#9333ea', '#7e22ce', '#6b21a8',  // purple
  '#f9a8d4', '#f472b6', '#ec4899', '#db2777', '#be185d', '#9d174d',  // pink
  '#ffffff', '#e5e7eb', '#94a3b8', '#64748b', '#334155', '#111827',  // neutrals
];
let _drawCtxId = null, _drawCtxX = 0, _drawCtxY = 0, _drawCtxFibEdit = null;

function _drawSetStyle(id, patch) {
  const key = currentDrawKey();
  if (!key) return;
  const arr = drawingsForKey(key);
  const d = arr.find(x => x.id === id);
  if (!d) return;
  d.style = { ...(d.style || {}), ...patch };
  saveDrawingsForKey(key, arr);
  repaintChartForDrawings();   // re-render the chart with the new style (the menu lives in <body>, survives)
}
function openDrawContextMenu(x, y, id) { _drawCtxId = id; _drawCtxX = x; _drawCtxY = y; _drawCtxFibEdit = null; _renderDrawContextMenu(); }
function closeDrawContextMenu() { _drawCtxId = null; _drawCtxFibEdit = null; const m = document.getElementById('drawContextMenu'); if (m) m.remove(); }
function _renderDrawContextMenu() {
  const old = document.getElementById('drawContextMenu');
  if (old) old.remove();
  const id = _drawCtxId;
  if (id == null) return;
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) { _drawCtxId = null; return; }
  const st = d.style || {};
  const cur = (st.color || '').toLowerCase();
  const swatches = DRAW_COLORS.map(c =>
    `<button class="draw-ctx-swatch${cur === c.toLowerCase() ? ' active' : ''}" style="background:${c}" title="${c}" onclick="drawCtxSetColor('${id}','${c}')"></button>`).join('');
  const widthBtns = [1, 2, 3].map(w =>
    `<button class="draw-ctx-btn${(st.width || 0) === w ? ' active' : ''}" type="button" onclick="drawCtxSetWidth('${id}',${w})">${w}px</button>`).join('');
  const menu = document.createElement('div');
  menu.id = 'drawContextMenu';
  menu.className = 'draw-ctx';
  menu.innerHTML =
    `<div class="draw-ctx-title">${objTreeLabel(d)}</div>`
    + `<div class="draw-ctx-section">Color</div>`
    + `<div class="draw-ctx-colors">${swatches}</div>`
    + `<div class="draw-ctx-customrow"><label class="draw-ctx-custom" title="Custom color"><input type="color" value="${st.color || '#ef9412'}" onchange="drawCtxSetColor('${id}', this.value)"></label><span class="draw-ctx-customlbl">Custom…</span></div>`
    + `<div class="draw-ctx-section">Thickness</div>`
    + `<div class="draw-ctx-row">${widthBtns}</div>`
    + `<div class="draw-ctx-section">Style</div>`
    + `<div class="draw-ctx-row">`
    + `<button class="draw-ctx-btn${!st.dash ? ' active' : ''}" type="button" onclick="drawCtxSetDash('${id}',false)">Solid</button>`
    + `<button class="draw-ctx-btn${st.dash ? ' active' : ''}" type="button" onclick="drawCtxSetDash('${id}',true)">Dashed</button>`
    + `</div>`
    + (d.type === 'rect'
      ? `<div class="draw-ctx-section">Levels</div>`
        + `<div class="draw-ctx-row">`
        + `<button class="draw-ctx-btn${st.mid ? ' active' : ''}" type="button" onclick="drawCtxSetMid('${id}',${!st.mid})">Midline</button>`
        + `<button class="draw-ctx-btn${st.quarters ? ' active' : ''}" type="button" onclick="drawCtxSetQuarters('${id}',${!st.quarters})">Quarters</button>`
        + `</div>`
      : '')
    + (d.type === 'fib'
      ? `<div class="draw-ctx-section">Levels — click to edit</div>`
        + `<div class="draw-ctx-fiblist">`
        + fibLevelObjs(d).map(o => {
            const pct = (o.r * 100).toFixed(1).replace(/\.0$/, '');
            const dot = o.color || st.color || '#ef9412';
            const open = _drawCtxFibEdit === o.r;
            let html = `<div class="draw-ctx-fibrow${open ? ' open' : ''}" onclick="drawCtxFibEditToggle('${id}',${o.r})">`
              + `<span class="draw-ctx-fibdot" style="background:${dot}"></span>`
              + `<span class="draw-ctx-fibval">${pct}%</span>`
              + `<button class="draw-ctx-fibdel" type="button" title="Remove level" onclick="event.stopPropagation();drawCtxRemoveFibLevel('${id}',${o.r})">×</button>`
              + `</div>`;
            if (open) {
              const col = o.color || st.color || '#ef9412';
              html += `<div class="draw-ctx-fibedit">`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Level</span>`
                + `<input type="number" step="0.1" class="draw-ctx-fibinput" value="${pct}" onchange="drawCtxSetFibLevelValue('${id}',${o.r},this.value)"><span class="draw-ctx-fibpct">%</span></div>`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Color</span>`
                + `<label class="draw-ctx-custom" title="Level colour"><input type="color" value="${col}" onchange="drawCtxSetFibLevelColor('${id}',${o.r},this.value)"></label></div>`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Size</span>`
                + [1, 2, 3].map(w => `<button class="draw-ctx-btn${(o.width || 0) === w ? ' active' : ''}" type="button" onclick="drawCtxSetFibLevelWidth('${id}',${o.r},${w})">${w}px</button>`).join('')
                + `</div>`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Style</span>`
                + `<button class="draw-ctx-btn${!o.dash ? ' active' : ''}" type="button" onclick="drawCtxSetFibLevelDash('${id}',${o.r},false)">Solid</button>`
                + `<button class="draw-ctx-btn${o.dash ? ' active' : ''}" type="button" onclick="drawCtxSetFibLevelDash('${id}',${o.r},true)">Dashed</button>`
                + `</div></div>`;
            }
            return html;
          }).join('')
        + `</div>`
        + `<div class="draw-ctx-fibadd">`
        + `<input type="number" step="0.1" class="draw-ctx-fibinput" id="drawFibAdd" placeholder="e.g. 65" onkeydown="if(event.key==='Enter')drawCtxAddFibLevel('${id}')">`
        + `<button class="draw-ctx-btn" type="button" onclick="drawCtxAddFibLevel('${id}')">Add %</button>`
        + `</div>`
      : '')
    + (d.type === 'fibtime'
      ? `<div class="draw-ctx-section">Levels — click to edit</div>`
        + `<div class="draw-ctx-fiblist">`
        + fibTimeLevelObjs(d).map(o => {
            const dot = o.color || st.color || '#ef9412';
            const open = _drawCtxFibEdit === o.n;
            let html = `<div class="draw-ctx-fibrow${open ? ' open' : ''}" onclick="drawCtxFibTimeEditToggle('${id}',${o.n})">`
              + `<span class="draw-ctx-fibdot" style="background:${dot}"></span>`
              + `<span class="draw-ctx-fibval">${o.n}</span>`
              + `<button class="draw-ctx-fibdel" type="button" title="Remove" onclick="event.stopPropagation();drawCtxRemoveFibTimeLevel('${id}',${o.n})">×</button>`
              + `</div>`;
            if (open) {
              const col = o.color || st.color || '#ef9412';
              html += `<div class="draw-ctx-fibedit">`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Mult.</span>`
                + `<input type="number" step="1" class="draw-ctx-fibinput" value="${o.n}" onchange="drawCtxSetFibTimeValue('${id}',${o.n},this.value)"></div>`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Color</span>`
                + `<label class="draw-ctx-custom"><input type="color" value="${col}" onchange="drawCtxSetFibTimeColor('${id}',${o.n},this.value)"></label></div>`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Size</span>`
                + [1, 2, 3].map(w => `<button class="draw-ctx-btn${(o.width || 0) === w ? ' active' : ''}" type="button" onclick="drawCtxSetFibTimeWidth('${id}',${o.n},${w})">${w}px</button>`).join('')
                + `</div>`
                + `<div class="draw-ctx-fibedit-row"><span class="draw-ctx-fibedit-lbl">Style</span>`
                + `<button class="draw-ctx-btn${!o.dash ? ' active' : ''}" type="button" onclick="drawCtxSetFibTimeDash('${id}',${o.n},false)">Solid</button>`
                + `<button class="draw-ctx-btn${o.dash ? ' active' : ''}" type="button" onclick="drawCtxSetFibTimeDash('${id}',${o.n},true)">Dashed</button>`
                + `</div></div>`;
            }
            return html;
          }).join('')
        + `</div>`
        + `<div class="draw-ctx-fibadd">`
        + `<input type="number" step="1" class="draw-ctx-fibinput" id="drawFibTimeAdd" placeholder="e.g. 89" onkeydown="if(event.key==='Enter')drawCtxAddFibTimeLevel('${id}')">`
        + `<button class="draw-ctx-btn" type="button" onclick="drawCtxAddFibTimeLevel('${id}')">Add</button>`
        + `</div>`
      : '')
    + ((d.type === 'trend' || d.type === 'hline' || d.type === 'hray' || d.type === 'vline')
      ? `<div class="draw-ctx-section">Label</div>`
        + `<div class="draw-ctx-row"><button class="draw-ctx-btn" type="button" onclick="drawCtxEditText('${id}')">${d.text ? 'Edit label…' : 'Add label…'}</button>`
        + (d.text ? `<button class="draw-ctx-btn" type="button" onclick="drawCtxClearLabel('${id}')">Clear</button>` : '')
        + `</div>`
      : '')
    + (d.type === 'text'
      ? `<div class="draw-ctx-section">Text</div>`
        + `<div class="draw-ctx-row"><button class="draw-ctx-btn" type="button" onclick="drawCtxEditText('${id}')">Edit text…</button></div>`
        + `<div class="draw-ctx-section">Size</div>`
        + `<div class="draw-ctx-row">`
        + [['S', 11], ['M', 14], ['L', 18], ['XL', 24]].map(([lbl, px]) => `<button class="draw-ctx-btn${(st.fontSize || 14) === px ? ' active' : ''}" type="button" onclick="drawCtxSetTextSize('${id}',${px})">${lbl}</button>`).join('')
        + `</div>`
      : '')
    + `<div class="draw-ctx-sep"></div>`
    + `<button class="draw-ctx-del" type="button" onclick="drawCtxDelete('${id}')">Delete</button>`;
  document.body.appendChild(menu);
  // keep it on-screen
  const mw = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(_drawCtxX, window.innerWidth - mw - 8)) + 'px';
  menu.style.top = Math.max(8, Math.min(_drawCtxY, window.innerHeight - mh - 8)) + 'px';
}
function drawCtxSetColor(id, c) { _drawSetStyle(id, { color: c }); _renderDrawContextMenu(); }
function drawCtxSetWidth(id, w) { const d = drawingsForKey(currentDrawKey()).find(x => x.id === id); _drawSetStyle(id, { width: (d && d.style && d.style.width === w) ? null : w }); _renderDrawContextMenu(); }
function drawCtxSetDash(id, on) { _drawSetStyle(id, { dash: !!on }); _renderDrawContextMenu(); }
function drawCtxSetMid(id, on) { _drawSetStyle(id, { mid: !!on }); _renderDrawContextMenu(); }
function drawCtxSetQuarters(id, on) { _drawSetStyle(id, { quarters: !!on }); _renderDrawContextMenu(); }
function drawCtxFibEditToggle(id, r) { _drawCtxFibEdit = (_drawCtxFibEdit === r ? null : r); _renderDrawContextMenu(); }
function _drawPatchFibLevel(id, r, patch) {
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  _drawSetStyle(id, { fibLevels: fibLevelObjs(d).map(o => o.r === r ? { ...o, ...patch } : o) });
  _renderDrawContextMenu();
}
function drawCtxSetFibLevelValue(id, oldR, pct) {
  const v = parseFloat(pct);
  if (!Number.isFinite(v)) { _renderDrawContextMenu(); return; }
  const newR = Math.round((v / 100) * 1e5) / 1e5;
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  const cur = fibLevelObjs(d);
  if (newR !== oldR && cur.some(o => o.r === newR)) { _renderDrawContextMenu(); return; }   // would duplicate → ignore
  const next = cur.map(o => o.r === oldR ? { ...o, r: newR } : o).sort((a, b) => a.r - b.r);
  if (_drawCtxFibEdit === oldR) _drawCtxFibEdit = newR;   // keep the editor open on the renamed level
  _drawSetStyle(id, { fibLevels: next });
  _renderDrawContextMenu();
}
function drawCtxSetFibLevelColor(id, r, color) { _drawPatchFibLevel(id, r, { color }); }
function drawCtxSetFibLevelWidth(id, r, w) {
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  const o = d && fibLevelObjs(d).find(x => x.r === r);
  _drawPatchFibLevel(id, r, { width: (o && o.width === w) ? null : w });   // click the active size again → back to default
}
function drawCtxSetFibLevelDash(id, r, on) { _drawPatchFibLevel(id, r, { dash: !!on }); }
function drawCtxRemoveFibLevel(id, r) {
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  _drawSetStyle(id, { fibLevels: fibLevelObjs(d).filter(o => o.r !== r) });
  _renderDrawContextMenu();
}
function drawCtxAddFibLevel(id) {
  const inp = document.getElementById('drawFibAdd');
  if (!inp) return;
  const pct = parseFloat(inp.value);
  if (!Number.isFinite(pct)) return;
  const r = Math.round((pct / 100) * 1e5) / 1e5;
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  const cur = fibLevelObjs(d);
  if (!cur.some(o => o.r === r)) {
    _drawSetStyle(id, { fibLevels: cur.concat([{ r }]).sort((a, b) => a.r - b.r) });
  }
  _renderDrawContextMenu();
}
// fib time-zone per-level setters (mirror the retracement ones, keyed by multiple n)
function drawCtxFibTimeEditToggle(id, n) { _drawCtxFibEdit = (_drawCtxFibEdit === n ? null : n); _renderDrawContextMenu(); }
function _drawPatchFibTimeLevel(id, n, patch) {
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  _drawSetStyle(id, { timeLevels: fibTimeLevelObjs(d).map(o => o.n === n ? { ...o, ...patch } : o) });
  _renderDrawContextMenu();
}
function drawCtxSetFibTimeColor(id, n, color) { _drawPatchFibTimeLevel(id, n, { color }); }
function drawCtxSetFibTimeWidth(id, n, w) {
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  const o = d && fibTimeLevelObjs(d).find(x => x.n === n);
  _drawPatchFibTimeLevel(id, n, { width: (o && o.width === w) ? null : w });
}
function drawCtxSetFibTimeDash(id, n, on) { _drawPatchFibTimeLevel(id, n, { dash: !!on }); }
function drawCtxSetFibTimeValue(id, oldN, val) {
  const v = parseFloat(val);
  if (!Number.isFinite(v)) { _renderDrawContextMenu(); return; }
  const newN = Math.round(v * 1e4) / 1e4;
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  const cur = fibTimeLevelObjs(d);
  if (newN !== oldN && cur.some(o => o.n === newN)) { _renderDrawContextMenu(); return; }
  const next = cur.map(o => o.n === oldN ? { ...o, n: newN } : o).sort((a, b) => a.n - b.n);
  if (_drawCtxFibEdit === oldN) _drawCtxFibEdit = newN;
  _drawSetStyle(id, { timeLevels: next });
  _renderDrawContextMenu();
}
function drawCtxRemoveFibTimeLevel(id, n) {
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  _drawSetStyle(id, { timeLevels: fibTimeLevelObjs(d).filter(o => o.n !== n) });
  _renderDrawContextMenu();
}
function drawCtxAddFibTimeLevel(id) {
  const inp = document.getElementById('drawFibTimeAdd');
  if (!inp) return;
  const v = parseFloat(inp.value);
  if (!Number.isFinite(v)) return;
  const n = Math.round(v * 1e4) / 1e4;
  const d = drawingsForKey(currentDrawKey()).find(x => x.id === id);
  if (!d) return;
  const cur = fibTimeLevelObjs(d);
  if (!cur.some(o => o.n === n)) _drawSetStyle(id, { timeLevels: cur.concat([{ n }]).sort((a, b) => a.n - b.n) });
  _renderDrawContextMenu();
}
function drawCtxClearLabel(id) {
  const key = currentDrawKey();
  const arr = drawingsForKey(key);
  const d = arr.find(x => x.id === id);
  if (d) { delete d.text; saveDrawingsForKey(key, arr); repaintChartForDrawings(); }
  _renderDrawContextMenu();
}
function drawCtxSetTextSize(id, px) { _drawSetStyle(id, { fontSize: px }); _renderDrawContextMenu(); }
function drawCtxEditText(id) {
  const key = currentDrawKey();
  const cur = drawingsForKey(key).find(x => x.id === id);
  if (!cur) return;
  const v = window.prompt('Text:', cur.text || '');
  if (v != null) {
    const arr = drawingsForKey(key);
    const d = arr.find(x => x.id === id);
    if (d) { d.text = v.trim(); saveDrawingsForKey(key, arr); repaintChartForDrawings(); }
  }
  _renderDrawContextMenu();
}
function drawCtxDelete(id) { closeDrawContextMenu(); deleteDrawingById(id); }

// ── chart screenshot: serialize the live SVG (with drawings) to a PNG download ──
// The SVG references external CSS, so we inline the relevant computed styles onto a clone first,
// then rasterize via an <img> onto a canvas with the chart background, and save.
function exportChartScreenshot() {
  const svg = document.querySelector('#bigchartBody .chart-svg-wrap svg');
  if (!svg) return;
  const STYLE_PROPS = ['fill', 'fill-opacity', 'stroke', 'stroke-width', 'stroke-dasharray', 'stroke-opacity', 'opacity', 'font-size', 'font-family', 'font-weight', 'text-anchor'];
  const inline = (src, dst) => {
    const cs = getComputedStyle(src);
    let s = '';
    STYLE_PROPS.forEach(p => { const v = cs.getPropertyValue(p); if (v) s += p + ':' + v + ';'; });
    dst.setAttribute('style', s);
    const sc = src.children, dc = dst.children;
    for (let i = 0; i < sc.length && i < dc.length; i++) inline(sc[i], dc[i]);
  };
  const clone = svg.cloneNode(true);
  clone.querySelectorAll('.chart-draw-handle, .chart-draw-preview').forEach(el => el.remove());   // no selection handles in the export
  inline(svg, clone);
  const W = svg.width.baseVal.value || svg.getBoundingClientRect().width;
  const H = svg.height.baseVal.value || svg.getBoundingClientRect().height;
  const cssVar = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n) || fb).trim() || fb;
  const bg = cssVar('--chart-bg', '#ffffff'), accent = cssVar('--accent', '#ef9412'), txt2 = cssVar('--text2', '#46586d'), border = cssVar('--border', '#e5e9ef');
  // Footer caption: ChartHorizon mark + which market/contract + capture time.
  const market = (document.getElementById('bigchartName')?.textContent || '').trim();
  const sym = (document.getElementById('bigchartSym')?.textContent || '').trim();
  const now = new Date(), p2 = n => String(n).padStart(2, '0');
  const ts = `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
  const meta = (market ? '   ·   ' + market : '') + (sym ? '   ·   ' + sym : '');
  const footerH = 30;
  const xml = new XMLSerializer().serializeToString(clone);
  const url = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(W * scale); canvas.height = Math.round((H + footerH) * scale);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.drawImage(img, 0, 0, W, H);
    // footer band
    ctx.strokeStyle = border; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(0, H + 0.5); ctx.lineTo(W, H + 0.5); ctx.stroke();
    const cyf = H + footerH / 2;
    ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
    ctx.fillStyle = accent; ctx.beginPath(); ctx.moveTo(10, cyf + 5); ctx.lineTo(16, cyf - 6); ctx.lineTo(22, cyf + 5); ctx.closePath(); ctx.fill();   // ▲ mark
    ctx.font = '700 13px Geist, system-ui, sans-serif'; ctx.fillText('ChartHorizon', 28, cyf);
    const chW = ctx.measureText('ChartHorizon').width;
    ctx.font = '500 12px Geist, system-ui, sans-serif'; ctx.fillStyle = txt2; ctx.fillText(meta, 28 + chW, cyf);
    ctx.textAlign = 'right'; ctx.fillText('captured ' + ts, W - 10, cyf); ctx.textAlign = 'left';
    canvas.toBlob(blob => {
      if (!blob) return;
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'charthorizon-' + (currentDrawKey() || 'chart') + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  };
  img.onerror = () => {};
  img.src = url;
}

// Dismiss the edit menu on any click outside it (capture, so it runs before the chart handlers).
document.addEventListener('mousedown', (e) => {
  const m = document.getElementById('drawContextMenu');
  if (m && !m.contains(e.target)) closeDrawContextMenu();
  const f = document.getElementById('drawSymbolFlyout'), b = document.getElementById('drawSymbolBtn');
  if (f && !f.contains(e.target) && !(b && b.contains(e.target))) closeSymbolFlyout();
  const vf = document.getElementById('drawVisFlyout'), vb = document.getElementById('drawVisBtn');
  if (vf && !vf.contains(e.target) && !(vb && vb.contains(e.target))) closeVisFlyout();
  const gf = document.getElementById('drawGroupFlyout');
  if (gf && !gf.contains(e.target) && !e.target.closest('[id^="drawGroupBtn-"]')) closeGroupFlyout();
}, true);

// ── keyboard: Delete removes the selected drawing; Esc returns to the cursor + deselects.
// Only while the Charts tab is visible and no form field is focused. Registered once at load. ──
document.addEventListener('keydown', (e) => {
  if (document.getElementById('bigchartPage')?.hidden) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.key === 'Escape') {
    if (document.getElementById('drawSymbolFlyout')) { closeSymbolFlyout(); return; }
    if (document.getElementById('drawVisFlyout')) { closeVisFlyout(); return; }
    if (document.getElementById('drawGroupFlyout')) { closeGroupFlyout(); return; }
    if (document.getElementById('drawContextMenu')) { closeDrawContextMenu(); return; }
    if (drawState.tool !== 'cursor' || drawState.selectedId) { drawState.selectedId = null; setDrawTool('cursor'); }
    return;
  }
  if ((e.key === 'Delete' || e.key === 'Backspace') && drawState.selectedId) { e.preventDefault(); deleteSelectedDrawing(); }
});
