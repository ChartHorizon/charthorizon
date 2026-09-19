// Share of the plot width held free to the right of the newest candle on the Charts tab, so
// drawings have somewhere to go past the last bar. Every other chart in the app renders with
// no margin at all (see loadChart) and is pixel-identical to before.
const CHART_DRAW_RIGHT_MARGIN = 0.12;

const CHART_EXPORT_CSS = `
  text { font-family: 'Geist', system-ui, sans-serif; }
`;
const CHART_EXPORT_WIDTH = 1200; // ~on-screen display size; height stays proportional to the chart.
const CHART_EXPORT_TITLE_H = 70; // header band: brand rows + a metadata row (data-as-of / export time).
// Brand mark stamped on every image that leaves the app (download / share / X / card-mode).
// The domain, not the product name: a shared chart should say where it came from.
const EXPORT_BRAND = 'Chart-Horizon.com';

// Risk disclaimer baked into the bottom of CARD-MODE exports only (the Telegram/social
// cards). The normal in-app chart export stays clean. Kept to one line (no emoji, so it
// renders reliably in canvas fillText).
const CARD_RISK_DISCLAIMER =
  'Not financial advice · educational only · futures trading involves substantial risk of loss · '
  + 'seasonal & positioning signals do not guarantee future results';

// Export color palette — follows the active theme so card-mode (the content-bot's
// PNGs) and in-app downloads match the on-screen look. Card-mode runs in dark, so
// the exported cards are dark/navy; light keeps the original white card.
function exportPalette() {
  // Blog cards in the website's newsprint (PAPER_CARD_COLORS in core.js): the category takes the
  // gold-ink of the paper's datelines, and the wordmark recedes to muted ink instead of orange.
  if (typeof _isPaperCard === 'function' && _isPaperCard()) {
    return { bg: '#fbfbf9', cat: '#7d641e', name: '#17150f', sym: '#736b5c', brand: '#736b5c', meta: '#736b5c', sep: '#ddd9d0', strong: '#17150f' };
  }
  const dark = typeof currentTheme === 'function' && currentTheme() === 'dark';
  return dark
    ? { bg: '#0e1822', cat: '#f9b03a', name: '#f3f6fa', sym: '#8493a6', brand: '#f97316', meta: '#8493a6', sep: '#243240', strong: '#f3f6fa' }
    : { bg: '#ffffff', cat: '#1a56db', name: '#0f1923', sym: '#8896a8', brand: '#f97316', meta: '#8896a8', sep: '#e5e9f0', strong: '#0f1923' };
}

// Latest data date represented in a chart's history -> "Jun 01, 2026" (UTC), or null when unknown.
// `drawn`: read the series the chart actually draws (getActiveChartSource), not the continuous
// one. The Futures/card export needs it — card mode draws the front contract, and around a roll
// the two end on different days: the 2026-09-11 cards said "Data as of Sep 09" over a Sep 10
// candle. The Seasonals export keeps the continuous series its curves are built from.
function exportAsOfDate(cfg, drawn = false) {
  if (!cfg) return null;
  const hist = (drawn ? getActiveChartSource(cfg).history : getContinuousContract(cfg).history) || [];
  let iso = null;
  for (let i = hist.length - 1; i >= 0; i--) { if (hist[i] && hist[i].date) { iso = String(hist[i].date).slice(0, 10); break; } }
  if (!iso) return null;
  const d = new Date(iso + 'T00:00:00Z');
  if (isNaN(d)) return null;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: '2-digit', year: 'numeric' }).format(d);
}

// Moment of export in Eastern Time (matches the live header clock) -> "Jun 02, 2026 · 14:30 EDT".
function exportNowStamp() {
  const now = new Date();
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: '2-digit', year: 'numeric' }).format(now);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false, timeZoneName: 'short' }).format(now);
  return `${day} · ${time}`;
}

function getChartExportContext(kind = null) {
  const seasonalsActive = kind === 'seasonals' || (kind !== 'overview' && !document.getElementById('seasonalsPage')?.hidden);
  if (seasonalsActive) {
    const meta = INDEX[seasonalState.key] || {};
    return {
      kind: 'seasonals',
      svg: document.querySelector('#seasonalsBody .seasonals-chart-wrap svg'),
      category: 'SEASONALS',
      name: `${meta.display_name || 'Market'} Seasonality`,
      symbol: document.getElementById('seasonalsChartMeta')?.textContent || 'Seasonal tendencies',
      asOf: exportAsOfDate((catCache[meta.slug] || {})[seasonalState.key]),
      shareButtonId: 'btnSeasonalsShare',
      shareLabelId: 'btnSeasonalsShareLabel',
      xButtonId: 'btnSeasonalsX',
      xLabelId: 'btnSeasonalsXLabel'
    };
  }
  // Card-mode: synthetic FX pair chart (its own header, no market cfg behind it).
  if (window.__fxPairCard) {
    return {
      kind: 'overview',
      svg: document.querySelector('#chartBody .chart-svg-wrap svg'),
      category: 'FOREX',
      name: window.__fxPairCard.label,
      symbol: window.__fxPairCard.symbol,
      asOf: (window.__CONFIG__ && window.__CONFIG__.genDate) || null,
      cardMode: true,
      runway: window.__fxPairCard.runway || null,
      shareButtonId: 'btnChartShare',
      shareLabelId: 'btnChartShareLabel',
      xButtonId: 'btnChartX',
      xLabelId: 'btnChartXLabel'
    };
  }
  const meta = INDEX[currentKey] || {};
  return {
    kind: 'overview',
    svg: document.querySelector('#chartBody .chart-svg-wrap svg'),
    category: (meta.category || '').toUpperCase(),
    name: meta.display_name || 'Chart',
    symbol: document.getElementById('chartSym')?.textContent || '',
    asOf: exportAsOfDate(getCurrentCfg(), true),
    // Card-mode: only the Telegram/social cards get a risk disclaimer + seasonal runway
    // in the export footer band (the normal in-app export stays clean).
    cardMode: document.body.classList.contains('card-mode'),
    runway: (document.body.classList.contains('card-mode') && window.__threeThreeLog
             && window.__threeThreeLog[currentKey] && window.__threeThreeLog[currentKey].runway) || null,
    shareButtonId: 'btnChartShare',
    shareLabelId: 'btnChartShareLabel',
    xButtonId: 'btnChartX',
    xLabelId: 'btnChartXLabel'
  };
}

function chartExportName(ext, kind = null) {
  const ctx = getChartExportContext(kind);
  const prefix = ctx.kind === 'seasonals' ? 'Seasonals_' : '';
  const name = (ctx.name || 'chart').replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  const today = new Date().toISOString().slice(0, 10);
  return `ChartHorizon_${prefix}${name}_${today}.${ext}`;
}

// Build a standalone, self-contained SVG string of the current chart (with title).
function buildExportSvg(kind = null) {
  const ctx = getChartExportContext(kind);
  const live = ctx.svg;
  if (!live) return null;
  const svg = live.cloneNode(true);

  // Remove the interactive crosshair layer if present.
  svg.querySelectorAll('.chart-crosshair-layer').forEach(el => el.remove());
  svg.querySelectorAll('.chart-live-dot').forEach(el => el.remove());

  const vb = (svg.getAttribute('viewBox') || '0 0 1000 600').split(/\s+/).map(Number);
  const w = vb[2] || 1000;
  const innerH = vb[3] || 600;
  const titleH = CHART_EXPORT_TITLE_H;
  const pad = 16;
  const totalH = innerH + titleH;

  svg.removeAttribute('width');
  svg.removeAttribute('height');
  svg.removeAttribute('style');
  svg.setAttribute('x', '0');
  svg.setAttribute('y', '0');
  svg.setAttribute('width', w);
  svg.setAttribute('height', innerH);
  svg.setAttribute('viewBox', `0 0 ${w} ${innerH}`);

  const chartMarkup = new XMLSerializer().serializeToString(svg);
  const pal = exportPalette();

  return `<?xml version="1.0" encoding="UTF-8"?>
  <svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${totalH}" viewBox="0 0 ${w} ${totalH}">
    <style>${CHART_EXPORT_CSS}</style>
    <rect x="0" y="0" width="${w}" height="${totalH}" fill="${pal.bg}"/>
    <text x="${pad}" y="20" font-size="11" font-weight="600" letter-spacing="1" fill="${pal.cat}">${escapeXml(ctx.category)}</text>
    <text x="${pad}" y="42" font-size="20" font-weight="700" font-family="Geist, system-ui, sans-serif" fill="${pal.name}">${escapeXml(ctx.name)}</text>
    <text x="${w - pad}" y="20" font-size="10" fill="${pal.sym}" text-anchor="end">${escapeXml(ctx.symbol)}</text>
    <text x="${w - pad}" y="42" font-size="11" font-weight="700" fill="${pal.brand}" text-anchor="end">${EXPORT_BRAND}</text>
    ${ctx.asOf ? `<text x="${pad}" y="60" font-size="10" fill="${pal.meta}">Data as of ${escapeXml(ctx.asOf)}</text>` : ''}
    <text x="${w - pad}" y="60" font-size="10" fill="${pal.meta}" text-anchor="end">Exported ${escapeXml(exportNowStamp())}</text>
    <g transform="translate(0,${titleH})">${chartMarkup}</g>
  </svg>`;
}

function escapeXml(s) {
  return String(s).replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function exportLooksBlack(ctx, width, height) {
  const boxes = [
    [0, 0, Math.min(160, width), Math.min(90, height)],
    [0, Math.floor(height * 0.16), Math.min(220, width), Math.min(160, height)],
    [Math.floor(width * 0.35), Math.floor(height * 0.2), Math.min(260, width), Math.min(180, height)]
  ];
  for (const [x, y, w, h] of boxes) {
    const data = ctx.getImageData(x, y, Math.min(w, width - x), Math.min(h, height - y)).data;
    let total = 0, opaque = 0, veryDark = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 8) continue;
      opaque += 1;
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      total += lum;
      if (lum < 18) veryDark += 1;
    }
    if (opaque > 1000 && (total / opaque) < 24 && veryDark / opaque > 0.78) return true;
  }
  return false;
}

function parseNum(value, fallback = 0) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

function svgPaint(el, prop, fallback = null) {
  const attr = el.getAttribute(prop);
  if (attr === 'none') return null;
  if (attr && attr !== 'currentColor') return attr;
  const css = window.getComputedStyle(el);
  const val = css[prop];
  if (!val || val === 'none' || val === 'rgba(0, 0, 0, 0)') return fallback;
  return val === 'currentColor' ? (css.color || fallback) : val;
}

function svgOpacity(el) {
  // ONE source, not two multiplied. An SVG `opacity` presentation attribute IS a
  // (lowest-priority) CSS declaration, so getComputedStyle already returns it —
  // reading both and multiplying SQUARED every translucent element in the PNG
  // export: the card-mode 3/3 band shipped at 0.04 instead of 0.2 (invisible once a
  // card is scaled into a video insert), the COT bars at 0.49 instead of 0.7. The
  // attribute is only a fallback for a computed value the browser won't hand over.
  const css = window.getComputedStyle(el).opacity;
  if (Number.isFinite(Number.parseFloat(css))) return parseNum(css, 1);
  return el.hasAttribute('opacity') ? parseNum(el.getAttribute('opacity'), 1) : 1;
}

function applyStrokeStyle(ctx, el) {
  const stroke = svgPaint(el, 'stroke', null);
  if (!stroke) return false;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = parseNum(el.getAttribute('stroke-width') || window.getComputedStyle(el).strokeWidth, 1);
  ctx.lineCap = el.getAttribute('stroke-linecap') || 'butt';
  ctx.lineJoin = el.getAttribute('stroke-linejoin') || 'miter';
  const dash = el.getAttribute('stroke-dasharray') || window.getComputedStyle(el).strokeDasharray;
  if (dash && dash !== 'none') {
    ctx.setLineDash(dash.split(/[,\s]+/).map(Number).filter(Number.isFinite));
  } else {
    ctx.setLineDash([]);
  }
  return true;
}

function applyFillStyle(ctx, el, fallback = null) {
  const fill = svgPaint(el, 'fill', fallback);
  if (!fill) return false;
  ctx.fillStyle = fill;
  return true;
}

function applySvgTransform(ctx, el) {
  const transform = el.getAttribute('transform') || '';
  const translate = transform.match(/translate\(\s*([-0-9.]+)(?:[,\s]+([-0-9.]+))?\s*\)/);
  if (translate) ctx.translate(parseNum(translate[1]), parseNum(translate[2]));
}

function drawSvgRect(ctx, el) {
  const x = parseNum(el.getAttribute('x'));
  const y = parseNum(el.getAttribute('y'));
  const w = parseNum(el.getAttribute('width'));
  const h = parseNum(el.getAttribute('height'));
  const rx = parseNum(el.getAttribute('rx'));
  if (w <= 0 || h <= 0) return;
  ctx.beginPath();
  if (rx > 0 && ctx.roundRect) {
    ctx.roundRect(x, y, w, h, rx);
  } else {
    ctx.rect(x, y, w, h);
  }
  if (applyFillStyle(ctx, el, null)) ctx.fill();
  if (applyStrokeStyle(ctx, el)) ctx.stroke();
}

function drawSvgLine(ctx, el) {
  if (!applyStrokeStyle(ctx, el)) return;
  ctx.beginPath();
  ctx.moveTo(parseNum(el.getAttribute('x1')), parseNum(el.getAttribute('y1')));
  ctx.lineTo(parseNum(el.getAttribute('x2')), parseNum(el.getAttribute('y2')));
  ctx.stroke();
}

function drawSvgCircle(ctx, el) {
  const r = parseNum(el.getAttribute('r'));
  if (r <= 0) return;
  ctx.beginPath();
  ctx.arc(parseNum(el.getAttribute('cx')), parseNum(el.getAttribute('cy')), r, 0, Math.PI * 2);
  if (applyFillStyle(ctx, el, null)) ctx.fill();
  if (applyStrokeStyle(ctx, el)) ctx.stroke();
}

function drawSimpleSvgPath(ctx, d) {
  const tokens = (d || '').match(/[MLHVZmlhvz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) || [];
  let i = 0, cmd = '', x = 0, y = 0, startX = 0, startY = 0;
  ctx.beginPath();
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i])) cmd = tokens[i++];
    const rel = cmd === cmd.toLowerCase();
    switch (cmd.toUpperCase()) {
      case 'M':
      case 'L': {
        const nx = parseNum(tokens[i++]);
        const ny = parseNum(tokens[i++]);
        x = rel ? x + nx : nx;
        y = rel ? y + ny : ny;
        if (cmd.toUpperCase() === 'M') { ctx.moveTo(x, y); startX = x; startY = y; cmd = rel ? 'l' : 'L'; }
        else ctx.lineTo(x, y);
        break;
      }
      case 'H': {
        const nx = parseNum(tokens[i++]);
        x = rel ? x + nx : nx;
        ctx.lineTo(x, y);
        break;
      }
      case 'V': {
        const ny = parseNum(tokens[i++]);
        y = rel ? y + ny : ny;
        ctx.lineTo(x, y);
        break;
      }
      case 'Z':
        ctx.lineTo(startX, startY);
        i += 1;
        break;
      default:
        i += 1;
    }
  }
}

function drawSvgPath(ctx, el) {
  const d = el.getAttribute('d');
  if (!d) return;
  ctx.beginPath();
  try {
    const path = new Path2D(d);
    if (applyFillStyle(ctx, el, null)) ctx.fill(path);
    if (applyStrokeStyle(ctx, el)) ctx.stroke(path);
  } catch (_) {
    drawSimpleSvgPath(ctx, d);
    if (applyFillStyle(ctx, el, null)) ctx.fill();
    if (applyStrokeStyle(ctx, el)) ctx.stroke();
  }
}

function drawSvgText(ctx, el) {
  const text = el.textContent || '';
  if (!text.trim()) return;
  const css = window.getComputedStyle(el);
  const size = parseNum(el.getAttribute('font-size') || css.fontSize, 10);
  const weight = el.getAttribute('font-weight') || css.fontWeight || '400';
  const family = el.getAttribute('font-family') || css.fontFamily || 'Geist, system-ui, sans-serif';
  ctx.font = `${weight} ${size}px ${family}`;
  const anchor = el.getAttribute('text-anchor') || css.textAnchor;
  ctx.textAlign = anchor === 'middle' ? 'center' : (anchor === 'end' ? 'right' : 'left');
  ctx.textBaseline = 'alphabetic';
  if (applyFillStyle(ctx, el, '#0f172a')) {
    ctx.fillText(text, parseNum(el.getAttribute('x')), parseNum(el.getAttribute('y')));
  }
}

function drawSvgNode(ctx, node) {
  if (!node || node.nodeType !== 1) return;
  const tag = node.tagName.toLowerCase();
  if (tag === 'style' || tag === 'title') return;
  const cls = node.getAttribute('class') || '';
  // The live dot too, as buildExportSvg already removes it: it pulses (SMIL opacity 1 -> 0.2), and
  // the computed opacity read below put it into each PNG at whatever phase the export caught.
  if (cls.includes('chart-crosshair-layer') || cls.includes('chart-hit-zone') || cls.includes('chart-live-dot')) return;
  // Only what the browser actually paints. The measure tool's layer sits in every chart at
  // display:none, and its two circles carry no cx/cy (so 0,0) and no fill (so black): drawn
  // anyway, they put a black dot in the plot's top-left corner of every PNG, bot cards included.
  const css = window.getComputedStyle(node);
  if (css.display === 'none' || css.visibility === 'hidden') return;

  ctx.save();
  ctx.globalAlpha *= svgOpacity(node);
  applySvgTransform(ctx, node);

  if (tag === 'rect') drawSvgRect(ctx, node);
  else if (tag === 'line') drawSvgLine(ctx, node);
  else if (tag === 'circle') drawSvgCircle(ctx, node);
  else if (tag === 'path') drawSvgPath(ctx, node);
  else if (tag === 'text') drawSvgText(ctx, node);
  else {
    Array.from(node.children).forEach(child => drawSvgNode(ctx, child));
  }
  ctx.restore();
}

function drawExportHeader(ctx, w, exportCtx = getChartExportContext()) {
  const pad = 16;
  const pal = exportPalette();
  ctx.fillStyle = pal.cat;
  ctx.font = '600 11px Geist, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(exportCtx.category, pad, 20);
  ctx.fillStyle = pal.name;
  ctx.font = '700 20px Geist, system-ui, sans-serif';   /* the on-screen chart name's face, not a serif */
  ctx.fillText(exportCtx.name, pad, 42);
  ctx.textAlign = 'right';
  ctx.fillStyle = pal.sym;
  ctx.font = '10px Geist, system-ui, sans-serif';
  ctx.fillText(exportCtx.symbol, w - pad, 20);
  ctx.fillStyle = pal.brand;
  ctx.font = '700 11px Geist, system-ui, sans-serif';
  ctx.fillText(EXPORT_BRAND, w - pad, 42);
  // Metadata row: data "as of" date (left) and export timestamp (right).
  ctx.font = '10px Geist, system-ui, sans-serif';
  ctx.fillStyle = pal.meta;
  ctx.textAlign = 'left';
  if (exportCtx.asOf) ctx.fillText(`Data as of ${exportCtx.asOf}`, pad, 60);
  ctx.textAlign = 'right';
  ctx.fillText(`Exported ${exportNowStamp()}`, w - pad, 60);
}

// Footer band (card-mode only): an optional seasonal-runway line (the only foreseeable
// signal) + always a risk disclaimer. Starts with a thin divider below the chart.
function drawExportFooter(ctx, w, y, exportCtx) {
  const pad = 16;
  const pal = exportPalette();
  let cursor = y;
  ctx.strokeStyle = pal.sep;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(pad, cursor + 0.5);
  ctx.lineTo(w - pad, cursor + 0.5);
  ctx.stroke();
  ctx.textAlign = 'left';
  if (exportCtx.runway) {
    let until = exportCtx.runway.until;
    try {
      until = new Date(exportCtx.runway.until).toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    } catch (e) {}
    ctx.fillStyle = pal.strong;
    ctx.font = '600 11px Geist, system-ui, sans-serif';
    const tail = exportCtx.runway.note || 'before dropping to 2/3';
    ctx.fillText(`Seasonal window supports this setup ~${exportCtx.runway.days} more days (until ${until}) ${tail}`, pad, cursor + 17);
    cursor += 21;
  }
  ctx.fillStyle = pal.meta;
  ctx.font = '9px Geist, system-ui, sans-serif';
  ctx.fillText(CARD_RISK_DISCLAIMER, pad, cursor + 15);
}

function chartSvgToCanvas(targetWidth = CHART_EXPORT_WIDTH, kind = null) {
  const exportCtx = getChartExportContext(kind);
  const live = exportCtx.svg;
  if (!live) throw new Error('No chart to export');
  const vb = (live.getAttribute('viewBox') || '0 0 1000 600').split(/\s+/).map(Number);
  const w = vb[2] || 1000;
  const innerH = vb[3] || 600;
  const titleH = CHART_EXPORT_TITLE_H;
  // Card-mode footer: disclaimer always, runway line in addition when present.
  const footerH = exportCtx.cardMode ? (exportCtx.runway ? 46 : 24) : 0;
  const totalH = innerH + titleH + footerH;
  const scale = targetWidth / w;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(targetWidth);
  canvas.height = Math.round(totalH * scale);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  ctx.fillStyle = exportPalette().bg;
  ctx.fillRect(0, 0, w, totalH);
  drawExportHeader(ctx, w, exportCtx);
  ctx.save();
  ctx.translate(0, titleH);
  drawSvgNode(ctx, live);
  ctx.restore();
  if (footerH) drawExportFooter(ctx, w, titleH + innerH, exportCtx);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  return canvas;
}

// Render the current chart to a high-resolution PNG blob.
// The session a market card must reach, from the server that owns the settle rule
// (`settled_eod_payload` in start.py: 17:30 ET, weekends and exchange holidays skipped).
async function cardSettledEod() {
  const res = await fetch('/api/settled-eod', { cache: 'no-store' });
  if (!res.ok) throw new Error(`SETTLE_UNKNOWN /api/settled-eod answered ${res.status}`);
  const payload = await res.json();
  if (!payload || !payload.settled_eod) throw new Error('SETTLE_UNKNOWN /api/settled-eod gave no date');
  return String(payload.settled_eod).slice(0, 10);
}

// The last candle the chart actually draws. Not exportAsOfDate(cfg): that reads the continuous
// series, and card mode draws the front contract — the two disagree around every roll.
function drawnLastBarIso(cfg) {
  const hist = (cfg && getActiveChartSource(cfg).history) || [];
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i] && hist[i].date) return String(hist[i].date).slice(0, 10);
  }
  return null;
}

// A market card whose last candle is behind the settled EoD is refused, loudly. The 2026-09-11
// Hedgers' Ledger shipped Thursday's candles under a note about Friday's release: shot three
// minutes before the settle, off a contract cache that did not know which settle it was built
// for. STALE_CARD lets the bot-side capture tell this apart from a render failure. Card mode
// only, and only a market card: the FX pair card draws a synthetic series, and the in-app
// export stays the user's own business.
async function assertCardNotStale(kind) {
  if (!document.body.classList.contains('card-mode') || window.__fxPairCard || kind === 'seasonals') return;
  const cfg = (typeof getCurrentCfg === 'function') ? getCurrentCfg() : null;
  if (!cfg) return;
  const settled = await cardSettledEod();
  const drawn = drawnLastBarIso(cfg);
  if (!drawn || drawn < settled) {
    throw new Error(`STALE_CARD ${currentKey}: last candle ${drawn || 'none'} is behind the settled EoD ${settled}`);
  }
}

function chartSvgToPngBlob(targetWidth = CHART_EXPORT_WIDTH, kind = null) {
  return assertCardNotStale(kind).then(() => new Promise((resolve, reject) => {
    try {
      const canvas = chartSvgToCanvas(targetWidth, kind);
      const ctx = canvas.getContext('2d');
      // The "looks black" guard is a light-theme failure heuristic; a legitimately
      // dark (navy) card export must not trip it.
      const darkTheme = typeof currentTheme === 'function' && currentTheme() === 'dark';
      if (!darkTheme && exportLooksBlack(ctx, canvas.width, canvas.height)) {
        reject(new Error('PNG export rendered black'));
        return;
      }
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('PNG encode failed')), 'image/png');
    } catch (e) {
      reject(e);
    }
  }));
}

function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function chartSvgBlob(kind = null) {
  const svgStr = buildExportSvg(kind);
  if (!svgStr) throw new Error('No chart to export');
  return new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
}

function setShareStatus(text, ms = 1800, kind = null) {
  const ctx = getChartExportContext(kind);
  const btn = document.getElementById(ctx.shareButtonId);
  const label = document.getElementById(ctx.shareLabelId);
  if (!btn || !label) return;
  label.textContent = text;
  btn.classList.add('copied');
  setTimeout(() => {
    label.textContent = 'Share';
    btn.classList.remove('copied');
  }, ms);
}

async function downloadChart(kind = 'overview') {
  try {
    const blob = await chartSvgToPngBlob(CHART_EXPORT_WIDTH, kind);
    triggerDownload(blob, chartExportName('png', kind));
  } catch (e) {
    console.error('Chart download failed:', e);
    try {
      triggerDownload(chartSvgBlob(kind), chartExportName('svg', kind));
      appNotice('PNG export failed, so the chart was saved as an SVG instead.');
    } catch (_) {
      appNotice('Chart export failed: ' + e.message);
    }
  }
}

async function shareChart(kind = 'overview') {
  let blob;
  try {
    blob = await chartSvgToPngBlob(CHART_EXPORT_WIDTH, kind);
  } catch (e) {
    console.error('Share export failed:', e);
    appNotice('Chart export failed: ' + e.message);
    return;
  }

  const file = new File([blob], chartExportName('png', kind), { type: 'image/png' });

  // Prefer the native share sheet where available, but keep falling back if a
  // desktop/browser implementation rejects the request. Share the file only:
  // the title/category/symbol are already baked into the PNG, and passing both
  // `title` and `text` makes targets like iMessage render the caption twice.
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e && e.name === 'AbortError') return;
    }
  }

  // Fallback: copy the image to the clipboard.
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      setShareStatus('Copied!', 1800, kind);
      return;
    } catch (e) {
      // Continue to the download fallback.
    }
  }

  // Last resort: download the PNG.
  triggerDownload(blob, chartExportName('png', kind));
  setShareStatus('Downloaded', 1800, kind);
}

// Transient label feedback on any action button (restores `restore` after `ms`).
function setBtnStatus(buttonId, labelId, text, restore, ms = 2400) {
  const btn = document.getElementById(buttonId);
  const label = document.getElementById(labelId);
  if (!btn || !label) return;
  label.textContent = text;
  btn.classList.add('copied');
  setTimeout(() => { label.textContent = restore; btn.classList.remove('copied'); }, ms);
}

// Share the current chart on X (Twitter). X attaches no image via URL, so we copy the
// chart PNG to the clipboard and the user pastes it into the post with Cmd/Ctrl+V.
//
// Open the FULL composer (`/compose/post`), NOT the web intent (`/intent/post`): the
// intent dialog accepts no media at all — no upload button, no paste target — so it
// silently swallowed the pasted image and posted text only, in every browser. Both
// routes take the same `?text=` prefill. Do not "simplify" this back to /intent/post.
//
// The clipboard write must be ISSUED inside the click gesture: Safari/WebKit rejects a
// write made after `await`, so we hand ClipboardItem a Promise<Blob> (the blob renders
// lazily) instead of awaiting the blob first. Chrome/Firefox accept the promise form
// too. Awaiting the blob first silently failed on Safari (no image).
async function shareToX(kind = 'overview') {
  const ctx = getChartExportContext(kind);
  const text = `${ctx.name || 'Chart'} · ChartHorizon`;
  const composeUrl = `https://x.com/compose/post?text=${encodeURIComponent(text)}`;

  let copied = false;
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({ 'image/png': chartSvgToPngBlob(CHART_EXPORT_WIDTH, kind) }),
      ]);
      copied = true;
    } catch (e) {
      // Clipboard blocked/unavailable — still open the compose window.
    }
  }

  const win = window.open(composeUrl, '_blank');
  if (!win) {
    setBtnStatus(ctx.xButtonId, ctx.xLabelId, 'Allow popups', '', 3000);
    return;
  }
  setBtnStatus(ctx.xButtonId, ctx.xLabelId, copied ? 'Copied · paste in X' : 'Opened X', '', 3000);
}

// ── Build sidebars grouped by category from the lightweight INDEX ──

let chartState = {
  key: null,
  interval: 'daily',
  range: '12m',
  cotHedging: false,
  showVolume: false,  // default off: yfinance volume still has too many API-side gaps/errors
  showSpread: false,  // calendar-spread pane: advanced metric, off by default
  showOiSeasonal: false,  // OI seasonal overlay: opt-in, and `=== true` everywhere so card mode never draws it
  chartMode: 'continuous',
  contractSymbol: null,
  contractLabel: null
};

// Pane geometry below the price pane. Shared by loadChart and the maximized Charts tab
// (bigchart.js), which subtracts the reserved pane height from its viewport-filling price
// pane so price + panes still fit the window. OI/COT are CFTC-weekly data, so they only
// render in daily/weekly views — see paneShowsOiCot() and the showOi/showCot gates in loadChart.
const PANE_H = { volume: 62, oi: 68, cot: 84, spread: 64 };
const PANE_GAP = 22;
// Height of one technical-indicator oscillator pane (RSI/Stoch/MACD/ATR — Charts tab only).
const PANE_H_TA = 72;

// How many TA oscillator panes a chartState would render (Charts-tab only state carries
// .indicators; the Futures tab has none → 0). Mirrors the gating in loadChart so panesHeight
// and the maximize math agree. Hidden via the visibility eye (_indHidden) → counts 0.
function taPaneCount(state) {
  if (!state || state._indHidden || !Array.isArray(state.indicators) || typeof INDICATOR_DEFS === 'undefined') return 0;
  return state.indicators.filter(i =>
    i && i.visible !== false && INDICATOR_DEFS[i.type] && INDICATOR_DEFS[i.type].kind === 'pane').length;
}

// Whether the current interval shows the CFTC OI + COT panes (weekly data → daily/weekly only).
function paneShowsOiCot(interval) {
  return interval === 'daily' || interval === 'weekly';
}

// Total height reserved below the price pane for the active toggles/interval. Mirrors the
// pane stacking in loadChart so the Charts tab can size its maximized price pane to leave
// exactly this much room. `state` is a chartState-shaped object (reads showVolume/showSpread/interval).
function panesHeight(state) {
  let h = 0;
  if (state.showVolume) h += PANE_H.volume + PANE_GAP;
  // OI and COT default on (Futures tab has no flags → undefined !== false → both shown); the
  // Charts tab can turn each off independently via its OI / COT toggles (bigChartState.showOi/showCot).
  const oiCotOk = paneShowsOiCot(state.interval);
  if (oiCotOk && state.showOi !== false) h += PANE_H.oi + PANE_GAP;
  if (oiCotOk && state.showCot !== false) h += PANE_H.cot + PANE_GAP;
  if (state.showSpread) h += PANE_H.spread + PANE_GAP;
  h += taPaneCount(state) * (PANE_H_TA + PANE_GAP);
  return h;
}

// ── Technical-indicator SVG render helpers (Charts tab). Pure string builders that read the
// normalized spec from computeIndicator(). Overlays draw into the price pane; oscillator panes
// draw into their own stacked band. ──

// Polyline from an aligned (number|null)[]; the pen lifts across null gaps (no bridging).
function _taLinePath(values, xs, yFn, color, width, dash, opacity) {
  let d = '', pen = false;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) { pen = false; continue; }
    d += (pen ? 'L' : 'M') + xs[i].toFixed(1) + ' ' + yFn(v).toFixed(1) + ' ';
    pen = true;
  }
  if (!d) return '';
  return `<path d="${d.trim()}" fill="none" stroke="${color}" stroke-width="${width || 1.4}"`
    + (dash ? ` stroke-dasharray="${dash}"` : '')
    + (opacity != null ? ` opacity="${opacity}"` : '') + '/>';
}

// Faint filled band between two aligned series (Bollinger). Split into contiguous segments so
// gaps aren't bridged into one closed blob.
function _taBandPath(upper, lower, xs, yFn, color) {
  let out = '', i = 0;
  const N = upper.length;
  while (i < N) {
    if (!Number.isFinite(upper[i]) || !Number.isFinite(lower[i])) { i++; continue; }
    let j = i;
    while (j < N && Number.isFinite(upper[j]) && Number.isFinite(lower[j])) j++;
    let top = '', bot = '';
    for (let k = i; k < j; k++) top += (k === i ? 'M' : 'L') + xs[k].toFixed(1) + ' ' + yFn(upper[k]).toFixed(1) + ' ';
    for (let k = j - 1; k >= i; k--) bot += 'L' + xs[k].toFixed(1) + ' ' + yFn(lower[k]).toFixed(1) + ' ';
    out += `<path d="${(top + bot).trim()} Z" fill="${color}" opacity="0.07" stroke="none"/>`;
    i = j;
  }
  return out;
}

// Render one oscillator pane. Returns { svg, heading, cross } — `cross` is the crosshair spec
// (geometry + value→y fn + per-line values) the crosshair reads back for hover readouts.
function _renderTaPane(ind, data, geo) {
  const { top, h, padL, padR, W, dec, barXs, slot } = geo;
  const bottom = top + h;
  const grid = CHART_THEME.grid, axis = CHART_THEME.axis, txt = CHART_THEME.text;
  let lo, hi;
  if (data.domain) { lo = data.domain[0]; hi = data.domain[1]; }
  else {
    lo = Infinity; hi = -Infinity;
    data.series.forEach(s => s.values.forEach(v => { if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } }));
    if (data.zero) { if (0 < lo) lo = 0; if (0 > hi) hi = 0; }
    if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) { const c = Number.isFinite(lo) ? lo : 0; lo = c - 1; hi = c + 1; }
    const padv = (hi - lo) * 0.08; lo -= padv; hi += padv;
  }
  const span = (hi - lo) || 1;
  const yFn = v => top + (1 - (v - lo) / span) * h;
  const pdec = (data.dec != null) ? data.dec : dec;
  let svg = `<line x1="${padL}" y1="${top}" x2="${W - padR}" y2="${top}" stroke="${grid}"/>`
    + `<line x1="${padL}" y1="${bottom}" x2="${W - padR}" y2="${bottom}" stroke="${grid}"/>`;
  (data.refs || []).forEach(rf => {
    if (rf.value < lo || rf.value > hi) return;
    const y = yFn(rf.value).toFixed(1);
    svg += `<line x1="${padL}" y1="${y}" x2="${W - padR}" y2="${y}" stroke="${axis}" stroke-width="1" stroke-dasharray="2,4" opacity="0.6"/>`
      + `<text x="${W - padR + 5}" y="${(+y + 3).toFixed(1)}" font-size="9" fill="${txt}" font-family="Geist, system-ui, sans-serif">${rf.label}</text>`;
  });
  if (data.zero) {
    const zy = yFn(0).toFixed(1);
    svg += `<line x1="${padL}" y1="${zy}" x2="${W - padR}" y2="${zy}" stroke="${axis}" stroke-dasharray="4,3" opacity="0.6"/>`;
  }
  data.series.forEach(s => {
    if (s.kind === 'hist') {
      const baseY = yFn(0);
      const bw = Math.max(1, (slot || 6) * 0.6);
      for (let i = 0; i < s.values.length; i++) {
        const v = s.values[i];
        if (!Number.isFinite(v)) continue;
        const y = yFn(v), yy = Math.min(baseY, y), hh = Math.max(0.5, Math.abs(baseY - y));
        const c = v >= 0 ? (s.up || '#26a69a') : (s.down || '#ef5350');
        svg += `<rect x="${(barXs[i] - bw / 2).toFixed(1)}" y="${yy.toFixed(1)}" width="${bw.toFixed(1)}" height="${hh.toFixed(1)}" fill="${c}" opacity="0.5"/>`;
      }
    } else {
      svg += _taLinePath(s.values, barXs, yFn, s.color, s.width || 1.4);
    }
  });
  // Auto-scaled panes (MACD/ATR) label their own hi/lo at the right axis; fixed 0–100 panes
  // (RSI/Stoch) rely on the ref-line labels instead.
  if (!data.domain) {
    svg += `<text x="${W - padR + 5}" y="${(top + 8).toFixed(1)}" font-size="9" fill="${txt}" font-family="Geist, system-ui, sans-serif">${hi.toFixed(pdec)}</text>`
      + `<text x="${W - padR + 5}" y="${(bottom - 2).toFixed(1)}" font-size="9" fill="${txt}" font-family="Geist, system-ui, sans-serif">${lo.toFixed(pdec)}</text>`;
  }
  const heading = `<text x="${padL}" y="${(top - 8).toFixed(1)}" font-size="10" font-weight="600" fill="${indicatorColor(ind)}" font-family="Geist, system-ui, sans-serif" letter-spacing="0.05em">${esc(indicatorChipLabel(ind).toUpperCase())}</text>`;
  const cross = { top, h, yFn, dec: pdec, legend: data.legend };
  return { svg, heading, cross };
}

const RANGE_DAYS = { '6m': 182, '12m': 365, '5y': 1825, '20y': 7305, 'max': 100000 };
const CONTRACT_HISTORY_PERIOD = '5y';

// ISO-ish week bucket key (year + week number). Shared by aggregateWeekly and the live
// overlay so a live tick merges into the EXACT same week bucket the settled bars built.
function weekKeyOf(date) {
  const d = new Date(date);
  const onejan = new Date(d.getFullYear(), 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return d.getFullYear() + '-W' + week;
}

// Calendar-month / calendar-quarter bucket keys (siblings of weekKeyOf). Used by the
// maximized "Charts" tab's 1M / 3M timeframes — both derived from the same daily bars.
function monthKeyOf(date) {
  const d = new Date(date);
  return d.getFullYear() + '-M' + (d.getMonth() + 1);
}
function quarterKeyOf(date) {
  const d = new Date(date);
  return d.getFullYear() + '-Q' + (Math.floor(d.getMonth() / 3) + 1);
}

// Aggregate daily bars into buckets keyed by keyFn (open=first, high/low=extremes,
// close=last, date=last day in bucket, volume=sum). Bars must arrive in chronological order.
function aggregateByKey(bars, keyFn) {
  if (!bars.length) return [];
  const buckets = {};
  for (const b of bars) {
    const key = keyFn(b.date);
    if (!buckets[key]) buckets[key] = { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    else {
      const w = buckets[key];
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.date = b.date;
      w.volume += (b.volume || 0);
    }
  }
  return Object.values(buckets);
}

// Aggregate daily bars to weekly / monthly / quarterly bars.
function aggregateWeekly(bars)    { return aggregateByKey(bars, weekKeyOf); }
function aggregateMonthly(bars)   { return aggregateByKey(bars, monthKeyOf); }
function aggregateQuarterly(bars) { return aggregateByKey(bars, quarterKeyOf); }

function aggregateWeeklyVolume(rows) {
  if (!rows.length) return [];
  const weeks = {};
  for (const row of rows) {
    const key = weekKeyOf(row.date);
    if (!weeks[key]) {
      weeks[key] = { ...row, date: row.date, volume: Number(row.volume) || 0 };
    } else {
      weeks[key].date = row.date;
      weeks[key].volume += Number(row.volume) || 0;
      weeks[key].contract_count = Math.max(weeks[key].contract_count || 0, row.contract_count || 0);
    }
  }
  return Object.values(weeks);
}

function getContinuousContract(cfg) {
  const continuous = cfg.continuous_contract || {};
  return {
    ...continuous,
    history: continuous.history || cfg.chart_history || []
  };
}

function getContinuousHistory(cfg) {
  return getContinuousContract(cfg).history || [];
}

// The "front month" is the LEAD (most-liquid) contract — the one carrying the highest
// reported volume — not merely the nearest by calendar. Liquidity rolls forward before a
// contract expires, so the nearest calendar month can be nearly dead (e.g. mid-June gold
// trades August, not June). Returns the index into `contracts` of the highest-volume
// contract that has a yf_symbol; falls back to the first tradable contract (nearest by
// calendar) when no contract reports positive volume. Ties keep the nearer expiry.
function frontContractIndex(contracts) {
  const list = contracts || [];
  let best = -1, bestVol = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (!c || !c.yf_symbol) continue;
    const v = Number(c.volume);
    if (Number.isFinite(v) && v > bestVol) { bestVol = v; best = i; }
  }
  return best >= 0 ? best : list.findIndex(c => c && c.yf_symbol);
}

function chartDisplayMode(source) {
  if (!source || source.format === 'continuous_front_month') return 'Continuous Contract';
  if (source.format === 'dxy_index_proxy') return 'DXY Index Proxy';
  return source.label || 'Price Chart';
}

function getSelectedContract(cfg) {
  if (!chartState.contractSymbol || !cfg.contracts) return null;
  return cfg.contracts.find(c => c.yf_symbol === chartState.contractSymbol) || null;
}

// The symbol whose still-forming bar is spliced onto the CONTINUOUS series — deliberately not
// the `=F` symbol itself. One Yahoo answer for an `=F` chart prices its settled bars off the
// nearest contract and its still-forming bar off the next: on 2026-09-11 all 12 markets checked
// split that way (SB=F settled SBV26 at 18.73, forming SBH27 at 19.15), so the live candle drew a
// +5 % roll and an up day while both months fell 3 % (coffee: -9.8 %). The generator records the
// contract the written series settles on (`settled_contract`, stamped with its last bar's date);
// a file written before that falls back to the one listed contract whose settled close is the
// series' last close. null = no live candle: yesterday's close is honest, a bar from another
// contract is not. An index quote (DX-Y.NYB) is a single instrument and polls itself.
function continuousLiveSymbol(cfg) {
  const cont = getContinuousContract(cfg);
  const sym = cont.yf_symbol || cont.tv_symbol || null;
  if (!sym || !/=F$/.test(sym)) return sym;
  const hist = cont.history || [];
  const last = hist[hist.length - 1];
  if (!last) return null;
  const settled = cont.settled_contract;
  if (settled && settled.yf_symbol && settled.date === String(last.date).slice(0, 10)) return settled.yf_symbol;
  const close = Number(last.close);
  if (!Number.isFinite(close)) return null;
  const hits = (cfg.contracts || []).filter(c => c && c.yf_symbol && c.last !== null && c.last !== undefined
    && Math.abs(Number(c.last) - close) <= Math.max(1e-9, Math.abs(close) * 1e-7));
  return hits.length === 1 ? hits[0].yf_symbol : null;
}

// `symbol` names what is drawn; `liveSymbol` is what the live overlay polls and splices onto it.
// They differ only for the continuous series (see continuousLiveSymbol). Every live path —
// loadChart, the Charts tab's poll target, live.js — reads liveSymbol off this one function.
function getActiveChartSource(cfg) {
  const continuous = getContinuousContract(cfg);
  const selected = getSelectedContract(cfg);
  if (chartState.chartMode === 'contract' && selected) {
    return {
      mode: 'contract',
      label: selected.delivery_month_label || selected.label || selected.contract_symbol || selected.yf_symbol,
      symbol: selected.yf_symbol || selected.contract_symbol,
      liveSymbol: selected.yf_symbol || selected.contract_symbol,
      displaySymbol: selected.contract_symbol || selected.yf_symbol,
      history: selected.chart_history || selected.history || [],
      contract: selected
    };
  }
  return {
    mode: 'continuous',
    label: continuous.label || 'Continuous Contract',
    symbol: continuous.yf_symbol || continuous.tv_symbol || 'Continuous',
    liveSymbol: continuousLiveSymbol(cfg),
    displaySymbol: continuous.yf_symbol || continuous.tv_symbol || 'Continuous',
    displayMode: chartDisplayMode(continuous),
    format: continuous.format || 'continuous_front_month',
    history: continuous.history || [],
    totalVolumeHistory: continuous.total_volume_series || continuous.totalVolumeSeries || [],
    contract: null
  };
}

function getChartBars(cfg) {
  let bars = getActiveChartSource(cfg).history || [];
  // Filter the selected range
  const days = RANGE_DAYS[chartState.range] || 365;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);
  bars = bars.filter(b => new Date(b.date) >= cutoff);
  // Interval
  switch (chartState.interval) {
    case 'weekly':    bars = aggregateWeekly(bars); break;
    case 'monthly':   bars = aggregateMonthly(bars); break;
    case 'quarterly': bars = aggregateQuarterly(bars); break;
    // 'daily' -> raw
  }
  return bars;
}

function normalizeCotSeries(series) {
  const byDate = new Map();
  (series || []).forEach(row => {
    if (!row || !row.date) return;
    byDate.set(String(row.date).slice(0, 10), row);
  });
  return Array.from(byDate.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function normalizeOiSeries(series) {
  const byDate = new Map();
  (series || []).forEach(row => {
    if (!row || !row.date) return;
    const oi = row.oi ?? row.open_interest ?? row.total_open_interest;
    if (oi === null || oi === undefined || !Number.isFinite(Number(oi))) return;
    byDate.set(String(row.date).slice(0, 10), {
      ...row,
      date: String(row.date).slice(0, 10),
      oi: Number(oi)
    });
  });
  return Array.from(byDate.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function normalizeSpreadSeries(series) {
  const byDate = new Map();
  (series || []).forEach(row => {
    if (!row || !row.date) return;
    const sp = row.spread;
    if (sp === null || sp === undefined || !Number.isFinite(Number(sp))) return;
    byDate.set(String(row.date).slice(0, 10), {
      ...row,
      date: String(row.date).slice(0, 10),
      spread: Number(sp)
    });
  });
  return Array.from(byDate.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// ── Calendar-spread pane: ONE drawing, used by the Futures / Charts pane (loadChart) and the
// Weekly Outlook (wkDrawChart in screener.js). Each used to keep its own copy of the scale and
// the labels, and both grew the same zero-label collision at once.

// What the pane draws: the run of the pair trading today — the spread of the current front
// month, which starts over at every roll. The generator writes nothing else since 2026-09-12
// (`_trailing_same_pair_spread`); a category file written before could still carry ONE
// preceding pair, which sat at an unrelated level behind the break and read as a broken line
// (sugar, 2026-09-09: Oct/Mar at -0.99, Mar/May at +0.63). `series` is date-sorted.
function currentPairSpread(series) {
  const last = series[series.length - 1];
  let start = series.length;
  while (start > 0 && series[start - 1].front_contract === last.front_contract
         && series[start - 1].next_contract === last.next_contract) start--;
  return series.slice(start);
}

// A spread moves in whole price steps, and where one leg barely trades they are coarse: the
// 10Y's Dec/Mar pair sat on three levels (5.5, 6 and 6.5 32nds) for its first eleven sessions
// after the 2026-08-27 roll, its March leg settling off the calendar spread at ~100 lots a day.
// Scaled tightly around the data, ONE tick filled the whole pane and read as a crash. So the
// scale spans at least this many of the series' own steps. Measured 2026-09-11 that reaches
// 10Y (2 steps), 30Y (3) and JPY (4), and any pair only a few sessions past its roll, whose few
// steps are all it has; corn (9), CHF (10) and everything finer scale as before.
const SPREAD_MIN_SCALE_STEPS = 8;

// The smallest step the series moves in. A difference under 1% of the largest move is rounding
// residue, not a step (0.1874 against 0.1875 on legs rounded to four places).
function spreadStepQuantum(vals) {
  const steps = [];
  for (let i = 1; i < vals.length; i++) {
    const d = Math.abs(vals[i] - vals[i - 1]);
    if (d > 0) steps.push(d);
  }
  if (!steps.length) return 0;
  const residue = Math.max(...steps) * 0.01;
  return Math.min(...steps.filter(d => d > residue));
}

// Scale tightly around the REAL values (do NOT force 0), with padding, so the line unfolds
// across the whole box instead of touching the frame (cf. the CAD bug) — but never narrower
// than SPREAD_MIN_SCALE_STEPS steps. Forcing 0 would glue a consistently positive/negative
// spread (e.g. USD index ~+0.26) to the border as a flat band. The zero line is ALWAYS returned
// for orientation: at its true position when 0 is inside the window, otherwise pinned to the
// nearer edge, where its distance is deliberately NOT to scale.
function spreadPaneScale(vals, top, height) {
  const dataLo = Math.min(...vals), dataHi = Math.max(...vals);
  const span = Math.max(dataHi - dataLo, spreadStepQuantum(vals) * SPREAD_MIN_SCALE_STEPS);
  const pad = (span || Math.abs(dataHi) || 1) * 0.12;
  const lo = (dataLo + dataHi) / 2 - span / 2 - pad;
  const rng = (span + 2 * pad) || 1;
  const y = v => top + (1 - (v - lo) / rng) * height;
  const zeroYraw = y(0);
  const zeroY = Math.max(top, Math.min(top + height, zeroYraw));
  return { top, height, dataLo, dataHi, y, zeroY, zeroPinned: zeroYraw !== zeroY };
}

// Above the zero line the spread is a premium (backwardation), at or below it a discount
// (contango): the same `> 0` the screener's structure signal reads (screener.py), so the
// colour of the line can never disagree with the signal.
function spreadSideColor(v) {
  return v > 0 ? CHART_THEME.spreadPremium : CHART_THEME.spreadDiscount;
}

// SVG path data per side, split exactly where the line crosses zero. The line also breaks
// across a gap of more than 7 days, so missing days aren't bridged, and at a change of contract
// pair — connecting two pairs would draw the step between two different horizons as a move in
// the spread. The pane passes one pair only (currentPairSpread); the pair break is the guard.
function spreadPanePaths(points, zeroY) {
  const d = { premium: '', discount: '' };
  const xy = (x, y) => x.toFixed(1) + ',' + y.toFixed(1) + ' ';
  let side = null;
  points.forEach((p, i) => {
    const prev = points[i - 1];
    const s = p.value > 0 ? 'premium' : 'discount';
    const brk = !prev || (new Date(p.date) - new Date(prev.date)) > 7 * 864e5 || p.pair !== prev.pair;
    if (brk) {
      d[s] += 'M' + xy(p.x, p.y);
    } else if (s !== side) {
      // Opposite sides, so 0 lies between the two values: zeroY is not pinned here and
      // prev.value - p.value cannot be 0.
      const cx = prev.x + prev.value / (prev.value - p.value) * (p.x - prev.x);
      d[side] += 'L' + xy(cx, zeroY);
      d[s] += 'M' + xy(cx, zeroY) + 'L' + xy(p.x, p.y);
    } else {
      d[s] += 'L' + xy(p.x, p.y);
    }
    side = s;
  });
  return d;
}

// Right-edge labels: high, low and zero. Whenever 0 lay outside the data, the pinned zero label
// sat ~6 px from the low (or high) label in 10 px type and covered it — on nearly every market.
// High and low are pushed apart where they would touch, and the zero label is left out where
// it would land on either; the line's colour already says which side of zero it is on.
function spreadPaneLabels(scale, x, dec, edge = Infinity) {
  const GAP = 11;
  // A label too long for the margin (the yen's "-0.0000440" at seven decimals) is right-aligned to
  // the chart's edge instead of running past it; every label that fits is written exactly as before.
  const label = (y, txt) => {
    const atEdge = x + txt.length * 6.2 > edge;
    return `<text x="${atEdge ? edge : x}" y="${(y + 3).toFixed(1)}" font-size="10"${atEdge ? ' text-anchor="end"' : ''} fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${txt}</text>`;
  };
  const hiTxt = scale.dataHi.toFixed(dec), loTxt = scale.dataLo.toFixed(dec);
  const single = hiTxt === loTxt;
  let yHi = scale.y(scale.dataHi), yLo = scale.y(scale.dataLo);
  if (!single && yLo - yHi < GAP) {
    const mid = (yHi + yLo) / 2;
    yHi = mid - GAP / 2; yLo = mid + GAP / 2;
  }
  const zeroFree = Math.abs(scale.zeroY - yHi) >= GAP && (single || Math.abs(scale.zeroY - yLo) >= GAP);
  return label(yHi, hiTxt) + (single ? '' : label(yLo, loTxt)) + (zeroFree ? label(scale.zeroY, '0') : '');
}

// The pane itself: frame, zero line, the line coloured by side, dots and labels. `points` are
// {date, x, y, value, pair} sorted by x, their y taken from `scale`.
function spreadPaneSvg(points, scale, left, right, dec, edge) {
  const { top, height, zeroY } = scale;
  const paths = spreadPanePaths(points, zeroY);
  const line = (d, col) => d
    ? `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.5" opacity="0.85"/>` : '';
  return `<line x1="${left}" y1="${top}" x2="${right}" y2="${top}" stroke="${CHART_THEME.grid}"/>`
    + `<line x1="${left}" y1="${top + height}" x2="${right}" y2="${top + height}" stroke="${CHART_THEME.grid}"/>`
    + `<line x1="${left}" y1="${zeroY.toFixed(1)}" x2="${right}" y2="${zeroY.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-dasharray="4,3"${scale.zeroPinned ? ' opacity="0.65"' : ''}/>`
    + (points.length > 1 ? line(paths.premium, CHART_THEME.spreadPremium) + line(paths.discount, CHART_THEME.spreadDiscount) : '')
    + points.map(p => `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.6" fill="${spreadSideColor(p.value)}" opacity="0.5"/>`).join('')
    + spreadPaneLabels(scale, right + 5, dec, edge);
}

function normalizeVolumeSeries(series) {
  const byDate = new Map();
  (series || []).forEach(row => {
    if (!row || !row.date) return;
    const volume = row.volume ?? row.total_volume;
    if (volume === null || volume === undefined || !Number.isFinite(Number(volume))) return;
    byDate.set(String(row.date).slice(0, 10), {
      ...row,
      date: String(row.date).slice(0, 10),
      volume: Number(volume)
    });
  });
  return Array.from(byDate.values())
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

function bindChartCrosshair(wrap, cfg) {
  if (!wrap || !cfg || !cfg.bars || !cfg.bars.length) return;
  const svg = wrap.querySelector('svg');
  if (!svg) return;

  const NS = 'http://www.w3.org/2000/svg';
  const make = (name, attrs = {}) => {
    const el = document.createElementNS(NS, name);
    Object.entries(attrs).forEach(([k, v]) => el.setAttribute(k, v));
    return el;
  };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const nearestIndex = (items, x) => {
    if (!items.length) return -1;
    let best = 0, dist = Math.abs(items[0].x - x);
    for (let i = 1; i < items.length; i++) {
      const d = Math.abs(items[i].x - x);
      if (d < dist) { best = i; dist = d; }
    }
    return best;
  };
  const compact = (value, signed = false) => {
    if (value === null || value === undefined || !Number.isFinite(Number(value))) return 'n/a';
    const n = Number(value);
    const sign = signed && n > 0 ? '+' : '';
    if (Math.abs(n) >= 1000000) return `${sign}${(n / 1000000).toFixed(2)}M`;
    return `${sign}${(n / 1000).toFixed(0)}K`;
  };
  const formatPrice = value => Number(value).toFixed(cfg.dec);
  const ohlcReadout = wrap.parentElement?.querySelector('[data-ohlc-readout]');
  function setOhlcReadout(bar) {
    if (!bar || !ohlcReadout) return;
    const _i = cfg.bars.indexOf(bar);
    const prevClose = _i > 0 ? cfg.bars[_i - 1].close : bar.open;
    const chg = prevClose ? (bar.close - prevClose) / prevClose * 100 : 0;
    const chgCol = chg > 0 ? 'var(--up-text)' : chg < 0 ? 'var(--down-text)' : 'var(--muted)';
    const chgStr = `${chg > 0 ? '+' : ''}${chg.toFixed(2)}%`;
    ohlcReadout.innerHTML =
      `<span class="ohlc-k">O</span> ${formatPrice(bar.open)}  ` +
      `<span class="ohlc-k">H</span> ${formatPrice(bar.high)}  ` +
      `<span class="ohlc-k">L</span> ${formatPrice(bar.low)}  ` +
      `<span class="ohlc-k">C</span> ${formatPrice(bar.close)}  ` +
      `<span class="ohlc-k">&Delta;</span> <span style="color:${chgCol};font-weight:700">${chgStr}</span>`;
  }

  const layer = make('g', { class: 'chart-crosshair-layer', style: 'display:none' });
  const vLine = make('line', { class: 'crosshair-line', y1: cfg.padT, y2: cfg.axisY });
  const hLine = make('line', { class: 'crosshair-soft-line', x1: cfg.padL, x2: cfg.W - cfg.padR });
  const volumeDot = make('circle', { class: 'crosshair-dot', r: 3, fill: CHART_THEME.volume });
  const oiDot = make('circle', { class: 'crosshair-dot', r: 3, fill: CHART_THEME.oi });
  const cotDot = make('circle', { class: 'crosshair-dot', r: 3 });
  const spreadDot = make('circle', { class: 'crosshair-dot', r: 3, fill: CHART_THEME.spread });

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
    const width = Math.max(34, textValue.length * 6 + 10);
    const offset = align === 'right' ? -width : align === 'center' ? -width / 2 : 0;
    tag.g.style.display = '';
    tag.g.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)})`);
    tag.rect.setAttribute('x', offset);
    tag.rect.setAttribute('y', -8.5);
    tag.rect.setAttribute('width', width);
    tag.text.setAttribute('x', offset + 5);
    tag.text.textContent = textValue;
  }
  function hideEl(el) {
    if (el.g) el.g.style.display = 'none';
    else el.style.display = 'none';
  }

  layer.append(vLine, hLine, volumeDot, oiDot, cotDot, spreadDot);
  const priceLabel = label();
  const dateLabel = label();
  const volumeLabel = label();
  const oiLabel = label();
  const cotLabel = label();
  const spreadLabel = label();
  // TA oscillator panes: one dot + right-axis label per series line (e.g. Stoch %K/%D, MACD/signal),
  // built dynamically from cfg.taPanes. Each carries its pane geometry + value→y fn.
  const taPaneCrosshair = (cfg.taPanes || []).map(p => ({
    p,
    lines: (p.legend || []).map(L => ({ L, dot: make('circle', { class: 'crosshair-dot', r: 3, fill: L.color || '#888' }), lbl: label() })),
  }));
  taPaneCrosshair.forEach(tp => tp.lines.forEach(ln => layer.appendChild(ln.dot)));
  setOhlcReadout(cfg.bars[cfg.bars.length - 1]);
  svg.appendChild(layer);

  const hit = make('rect', {
    class: 'chart-crosshair-hit',
    x: cfg.padL,
    y: cfg.padT,
    width: cfg.W - cfg.padL - cfg.padR,
    height: cfg.axisY - cfg.padT
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
  function nearestBarByX(x) {
    const idx = nearestIndex(cfg.barXs.map((px, i) => ({ x: px, i })), x);
    return idx < 0 ? 0 : idx;
  }
  function showPoint(dot, point, color) {
    if (!point) {
      dot.style.display = 'none';
      return;
    }
    dot.style.display = '';
    dot.setAttribute('cx', point.x.toFixed(1));
    dot.setAttribute('cy', point.y.toFixed(1));
    if (color) dot.setAttribute('fill', color);
  }
  // Middle-mouse toggle. On the Charts tab it switches the actual Crosshair TOOL (see
  // toggleCrosshair below) — a cosmetic-only override there would summon a crosshair you
  // cannot measure with, since measureStart is gated on the tool. This override therefore
  // only serves the Futures tab (no palette, drawingsActive false): null = follow the tool
  // default (crosshair on), true/false = manual on/off.
  let crosshairOverride = null;   // null = follow tool default; true/false = manual on/off
  function crosshairShouldShow() {
    const cursorTool = cfg.drawingsActive && typeof drawState !== 'undefined' && drawState.tool === 'cursor';
    return crosshairOverride === null ? !cursorTool : crosshairOverride;
  }
  function update(evt) {
    if (!crosshairShouldShow()) { hide(); return; }
    const p = localPoint(evt);
    if (!p) return;

    const plotLeft = cfg.barXs[0];
    const plotRight = cfg.barXs[cfg.barXs.length - 1];
    const rawX = clamp(p.x, plotLeft, plotRight);
    const inPrice = p.y >= cfg.padT && p.y <= cfg.padT + cfg.priceH;
    const inVolume = p.y >= cfg.volumeTop && p.y <= cfg.volumeTop + cfg.volumeH;
    const inOi = p.y >= cfg.oiTop && p.y <= cfg.oiTop + cfg.oiH;
    const inCot = p.y >= cfg.cotTop && p.y <= cfg.cotTop + cfg.cotH;
    const inSpread = (cfg.spreadPoints || []).length && p.y >= cfg.spreadTop && p.y <= cfg.spreadTop + cfg.spreadH;

    let x = cfg.barXs[nearestBarByX(rawX)];
    if (inCot && cfg.cotPoints.length) {
      const idx = nearestIndex(cfg.cotPoints, rawX);
      if (idx >= 0) x = cfg.cotPoints[idx].x;
    } else if (inOi && cfg.oiPoints.length) {
      const idx = nearestIndex(cfg.oiPoints, rawX);
      if (idx >= 0) x = cfg.oiPoints[idx].x;
    } else if (inVolume && (cfg.volumePoints || []).length) {
      const idx = nearestIndex(cfg.volumePoints || [], rawX);
      if (idx >= 0) x = cfg.volumePoints[idx].x;
    } else if (inSpread && (cfg.spreadPoints || []).length) {
      const idx = nearestIndex(cfg.spreadPoints || [], rawX);
      if (idx >= 0) x = cfg.spreadPoints[idx].x;
    }

    const barIdx = nearestBarByX(x);
    const bar = cfg.bars[barIdx];
    const volumePoints = cfg.volumePoints || [];
    const oiPoints = cfg.oiPoints || [];
    const cotPoints = cfg.cotPoints || [];
    const spreadPoints = cfg.spreadPoints || [];
    const vol = volumePoints[nearestIndex(volumePoints, x)];
    const oi = oiPoints[nearestIndex(oiPoints, x)];
    const cot = cotPoints[nearestIndex(cotPoints, x)];
    const spread = spreadPoints[nearestIndex(spreadPoints, x)];

    setOhlcReadout(bar);
    layer.style.display = '';
    vLine.setAttribute('x1', x.toFixed(1));
    vLine.setAttribute('x2', x.toFixed(1));

    if (inPrice) {
      const y = clamp(p.y, cfg.padT, cfg.padT + cfg.priceH);
      const price = cfg.pHi - ((y - cfg.padT) / cfg.priceH) * cfg.pSpan;
      hLine.style.display = '';
      hLine.setAttribute('y1', y.toFixed(1));
      hLine.setAttribute('y2', y.toFixed(1));
      setLabel(priceLabel, price.toFixed(cfg.dec), cfg.W - 4, clamp(y, cfg.padT + 9, cfg.padT + cfg.priceH - 9), 'right');
    } else {
      hLine.style.display = 'none';
      hideEl(priceLabel);
    }

    setLabel(dateLabel, fmtAxisDate(bar.date), x, cfg.axisY + 12, 'center');
    if (vol) {
      showPoint(volumeDot, vol, CHART_THEME.volume);
      setLabel(volumeLabel, `VOL ${compact(vol.value)}`, cfg.W - 4, clamp(vol.y, cfg.volumeTop + 9, cfg.volumeTop + cfg.volumeH - 9), 'right');
    } else {
      showPoint(volumeDot, null);
      hideEl(volumeLabel);
    }
    if (oi) {
      showPoint(oiDot, oi, CHART_THEME.oi);
      // With the seasonal overlay on, the reading that matters is the distance to it, not the
      // level: "411K · +6% vs seasonal" is the whole point of the indicator.
      const seas = oi.seasonal;
      const dev = Number.isFinite(seas) && seas > 0 ? (oi.value / seas - 1) * 100 : null;
      const devText = dev === null ? '' : ` · ${dev >= 0 ? '+' : ''}${dev.toFixed(0)}% vs seas`;
      setLabel(oiLabel, `OI ${compact(oi.value)}${devText}`, cfg.W - 4, clamp(oi.y, cfg.oiTop + 9, cfg.oiTop + cfg.oiH - 9), 'right');
    } else {
      showPoint(oiDot, null);
      hideEl(oiLabel);
    }
    if (cot) {
      showPoint(cotDot, cot, cot.color);
      setLabel(cotLabel, `COT ${compact(cot.value, true)}`, cfg.W - 4, clamp(cot.y, cfg.cotTop + 9, cfg.cotTop + cfg.cotH - 9), 'right');
    } else {
      showPoint(cotDot, null);
      hideEl(cotLabel);
    }
    if (spread && inSpread) {
      showPoint(spreadDot, spread, spread.color);
      setLabel(spreadLabel, `SPR ${Number(spread.value).toFixed(cfg.dec)}`, cfg.W - 4, clamp(spread.y, cfg.spreadTop + 9, cfg.spreadTop + cfg.spreadH - 9), 'right');
    } else {
      showPoint(spreadDot, null);
      hideEl(spreadLabel);
    }
    // TA oscillator panes: dot + right-axis readout per line at the hovered bar.
    taPaneCrosshair.forEach(({ p, lines }) => {
      lines.forEach(({ L, dot, lbl }) => {
        const v = L.values[barIdx];
        if (!Number.isFinite(v)) { dot.style.display = 'none'; hideEl(lbl); return; }
        const yy = p.yFn(v);
        dot.style.display = '';
        dot.setAttribute('cx', x.toFixed(1));
        dot.setAttribute('cy', yy.toFixed(1));
        setLabel(lbl, `${L.label} ${v.toFixed(p.dec)}`, cfg.W - 4, clamp(yy, p.top + 9, p.top + p.h - 9), 'right');
      });
    });
  }
  function hide() {
    layer.style.display = 'none';
    setOhlcReadout(cfg.bars[cfg.bars.length - 1]);
  }

  hit.addEventListener('pointerenter', update);
  hit.addEventListener('pointermove', update);
  hit.addEventListener('pointerleave', hide);
  hit.addEventListener('mouseenter', update);
  hit.addEventListener('mousemove', update);
  hit.addEventListener('mouseleave', hide);
  hit.addEventListener('mouseout', hide);
  svg.addEventListener('mouseleave', hide);

  // Middle mouse button toggles the crosshair on/off. preventDefault on the press
  // suppresses the browser's middle-click autoscroll; auxclick is muted for the same reason.
  //
  // Charts tab (palette present): flip the real Crosshair TOOL, remembering the tool it
  // replaced so the next middle-click restores it. Toggling only the visual layer here would
  // hand back a crosshair that cannot measure — measureStart requires tool === 'crosshair'.
  // setDrawTool rebuilds the chart, so this closure's nodes die with it: re-arm the crosshair
  // by replaying the pointer position onto the FRESH hit-zone, then get out.
  // Futures tab (no palette): no tool to switch — keep the plain show/hide override.
  function toggleCrosshair(evt) {
    if (evt.button !== 1) return;   // middle button only
    evt.preventDefault();
    if (cfg.drawingsActive && typeof drawState !== 'undefined' && typeof setDrawTool === 'function') {
      const wasCrosshair = drawState.tool === 'crosshair';
      const next = wasCrosshair ? (drawState.toolBeforeCrosshair || 'cursor') : 'crosshair';
      drawState.toolBeforeCrosshair = wasCrosshair ? null : drawState.tool;
      const host = wrap.parentElement;   // survives the repaint (only its innerHTML is swapped)
      setDrawTool(next);
      const fresh = host && host.querySelector('.chart-crosshair-hit');
      if (fresh) fresh.dispatchEvent(new MouseEvent('mousemove', {
        clientX: evt.clientX, clientY: evt.clientY, bubbles: true,
      }));
      return;
    }
    crosshairOverride = !crosshairShouldShow();   // flip the current effective state, then lock it
    if (crosshairOverride) update(evt); else hide();
  }
  hit.addEventListener('mousedown', toggleCrosshair);
  hit.addEventListener('auxclick', evt => { if (evt.button === 1) evt.preventDefault(); });

  // ── Measure tool: left-press + drag on the price pane reads the point difference
  // and %-change between press and cursor (free, TradingView-style); releasing the
  // button clears it. Always available, drawn under the crosshair hit-zone so the
  // crosshair keeps working. The layer stays display:none until a drag, so it never
  // appears in a static export. ──
  const mLayer = make('g', { class: 'chart-measure-layer', style: 'display:none; pointer-events:none' });
  const mLine = make('line', { class: 'chart-measure-line' });          // press -> cursor connector
  const mDot0 = make('circle', { class: 'chart-measure-dot', r: 3 });   // press point
  const mDot1 = make('circle', { class: 'chart-measure-dot', r: 3 });   // cursor point
  const mLblG = make('g');
  const mLblBg = make('rect', { class: 'chart-measure-label-bg', rx: 4 });
  const mT1 = make('text', { class: 'chart-measure-t1' });
  const mT2 = make('text', { class: 'chart-measure-t2' });
  mLblG.append(mLblBg, mT1, mT2);
  mLayer.append(mLine, mDot0, mDot1, mLblG);
  svg.insertBefore(mLayer, hit);   // below the transparent hit-zone -> visible, no event steal

  const priceFromY = y =>
    cfg.pHi - ((clamp(y, cfg.padT, cfg.padT + cfg.priceH) - cfg.padT) / cfg.priceH) * cfg.pSpan;
  let measuring = false, mStart = null;

  function measureDraw(evt) {
    if (!measuring || !mStart) return;
    const p = localPoint(evt);
    if (!p) return;
    const plotL = cfg.padL, plotR = cfg.W - cfg.padR, topY = cfg.padT, botY = cfg.padT + cfg.priceH;
    const x0 = mStart.x, y0 = mStart.y;
    const x1 = clamp(p.x, plotL, plotR), y1 = clamp(p.y, topY, botY);
    if (Math.abs(x1 - x0) + Math.abs(y1 - y0) < 3) { mLayer.style.display = 'none'; return; }  // ignore a plain click

    const startPrice = priceFromY(y0), endPrice = priceFromY(y1);
    const diff = endPrice - startPrice;
    const pct = startPrice ? (diff / startPrice) * 100 : 0;
    const up = diff >= 0;
    const sign = up ? '+' : '';
    mLayer.style.display = '';
    mLayer.classList.toggle('up', up);
    mLayer.classList.toggle('down', !up);
    mLine.setAttribute('x1', x0.toFixed(1));
    mLine.setAttribute('y1', y0.toFixed(1));
    mLine.setAttribute('x2', x1.toFixed(1));
    mLine.setAttribute('y2', y1.toFixed(1));
    mDot0.setAttribute('cx', x0.toFixed(1)); mDot0.setAttribute('cy', y0.toFixed(1));
    mDot1.setAttribute('cx', x1.toFixed(1)); mDot1.setAttribute('cy', y1.toFixed(1));

    mT1.textContent = `Δ ${sign}${diff.toFixed(cfg.dec)}`;
    mT2.textContent = `${sign}${pct.toFixed(2)}%`;
    const lineH = 14, padX = 9;
    const w = Math.max(mT1.textContent.length, mT2.textContent.length) * 6.6 + padX * 2;
    const h = lineH * 2 + 9;
    const lblX = clamp(x1 + 12, plotL, plotR - w);
    const lblY = clamp(y1 > y0 ? y1 + 10 : y1 - 10 - h, topY, botY - h);
    mLblG.setAttribute('transform', `translate(${lblX.toFixed(1)},${lblY.toFixed(1)})`);
    mLblBg.setAttribute('x', 0); mLblBg.setAttribute('y', 0);
    mLblBg.setAttribute('width', w.toFixed(1)); mLblBg.setAttribute('height', h);
    mT1.setAttribute('x', padX); mT1.setAttribute('y', lineH);
    mT2.setAttribute('x', padX); mT2.setAttribute('y', lineH * 2 + 2);
  }
  function measureEnd() {
    measuring = false; mStart = null;
    mLayer.style.display = 'none';
  }
  function measureStart(evt) {
    if (evt.button !== 0) return;   // left button only
    // On the Charts tab the palette owns the mouse: drag-to-measure only under the Crosshair tool
    // (like the Futures tab's always-on crosshair-measure). The Futures tab has no palette
    // (cfg.drawingsActive is false) → measure stays unconditional there.
    if (cfg.drawingsActive && typeof drawState !== 'undefined' && drawState.tool !== 'crosshair') return;
    const p = localPoint(evt);
    if (!p) return;
    if (p.y < cfg.padT || p.y > cfg.padT + cfg.priceH) return;   // start only in the price pane
    if (p.x < cfg.padL || p.x > cfg.W - cfg.padR) return;
    measuring = true;
    mStart = { x: clamp(p.x, cfg.padL, cfg.W - cfg.padR), y: clamp(p.y, cfg.padT, cfg.padT + cfg.priceH) };
    evt.preventDefault();
    document.addEventListener('mouseup', measureEnd, { once: true });   // self-removes -> no leak
    measureDraw(evt);
  }
  hit.addEventListener('mousedown', measureStart);
  hit.addEventListener('mousemove', measureDraw);
  hit.addEventListener('pointermove', measureDraw);
}

// Display-only live overlay: splice the latest live tick for the ACTIVE symbol onto a
// COPY of the bars. Never mutates the persisted series (catCache / contract.chart_history)
// and never runs in card-mode (content-bot PNGs stay byte-stable). `liveQuotes` is owned by
// live.js (symbol -> {day, price, open?, high?, low?} — the still-forming bar's intraday
// OHLC when Yahoo provides it, so the provisional candle has a real body + wicks instead of
// a flat single-price mark). The typeof guard keeps this safe if live.js is absent.
// Build the OHLC of a provisional live bar from a live quote (live.js shape:
// {price, open?, high?, low?} — intraday OHLC of the still-forming bar). Any leg Yahoo
// omits falls back to the last price, then high/low are clamped so low <= open,close <= high:
// a degenerate or missing-OHLC tick still paints a thin valid candle, never an inverted one.
// Shared by the Futures, Macro Shift (smt.js) and Screener (screener.js) live overlays.
function liveBarOHLC(lp) {
  const p = lp.price;
  const o = Number.isFinite(lp.open) ? lp.open : p;
  let hi = Number.isFinite(lp.high) ? lp.high : p;
  let lo = Number.isFinite(lp.low) ? lp.low : p;
  return { open: o, high: Math.max(hi, o, p), low: Math.min(lo, o, p), close: p };
}

// The live quote worth splicing onto `history` — the DAILY series it would extend, before any
// aggregation — or null. A quote dated before that series' last bar is not today's forming bar:
// a contract that did not trade reports its last TRADE day (PLU26 on 2026-09-11 quoted 09-09 at
// 1904.5 after settling at 1797.1 on 09-10), and splicing it appended a stale bar behind the
// settled one. Shared by loadChart, smt.js and the Weekly Outlook (screener.js).
function liveQuoteFor(symbol, history) {
  if (typeof liveQuotes !== 'object' || !liveQuotes) return null;
  const lp = symbol && liveQuotes[symbol];
  if (!lp || !Number.isFinite(lp.price) || !lp.day) return null;
  const rows = history || [];
  const last = rows[rows.length - 1];
  if (last && String(lp.day).slice(0, 10) < String(last.date).slice(0, 10)) return null;
  return lp;
}

function injectLivePoint(bars, symbol, history) {
  if (!bars || !bars.length) return bars;
  if (document.body.classList.contains('card-mode')) return bars;
  const lp = liveQuoteFor(symbol, history || bars);
  if (!lp) return bars;

  const out = bars.slice();
  const c = liveBarOHLC(lp);       // real candle: {open, high, low, close}, missing legs filled
  const p = c.close;
  const last = out[out.length - 1];

  if (chartState.interval === 'weekly') {
    // The live tick belongs to the CURRENT week's bar: extend its high/low and move its
    // close to the live price (open stays the week's open). Only when the last aggregated
    // bar is actually this week — otherwise the live tick opens a fresh week.
    if (last && weekKeyOf(last.date) === weekKeyOf(lp.day)) {
      out[out.length - 1] = {
        ...last,
        high: Math.max(last.high, c.high),
        low: Math.min(last.low, c.low),
        close: p,
        date: lp.day,
        __live: true
      };
    } else {
      out.push({ date: lp.day, ...c, volume: null, __live: true });
    }
    return out;
  }

  const pt = { date: lp.day, ...c, volume: null, __live: true };
  if (last && String(last.date).slice(0, 10) === String(lp.day).slice(0, 10)) out[out.length - 1] = pt;
  else out.push(pt);
  return out;
}

// ── Multi-pane candlestick chart: price + OI + COT ──
// opts (all optional; defaults keep the Futures call site `loadChart(cfg)` unchanged):
//   bodyId / symId  — render targets (default the Futures '#chartBody' / '#chartSym')
//   controls        — render the Futures interval/range/filter toggle bar (default true)
//   panes           — render the Volume/OI/COT/Spread panes below price (default true)
//   rollMarkers     — draw scheduled-expiry roll vlines (default true)
//   priceH          — fixed price-pane height (the Charts tab fills the viewport)
//   wheelZoom       — enable mouse-wheel zoom: slice the visible bars to state.[zoomStart,zoomEnd]
//                     and attach a cursor-anchored wheel handler + dblclick-to-reset (default off)
//   initialBars     — with wheelZoom: a new view opens on its newest N bars instead of all (default: all)
//   rerender        — repaint callback the wheel handler calls (default: loadChart(cfg, opts));
//                     the Charts tab passes () => renderBigChart(cfg) so its state-swap/maximize path runs
// The maximized "Charts" tab calls with {controls:false, panes:true, rollMarkers:false, wheelZoom:true}
// and swaps the global chartState for its own bigChartState (synchronous, restored after).
function loadChart(cfg, opts = {}) {
  const bodyId = opts.bodyId || 'chartBody';
  const symId = opts.symId || 'chartSym';
  const showControls = opts.controls !== false;
  const showPanes = opts.panes !== false;
  const showRoll = opts.rollMarkers !== false;
  const body = document.getElementById(bodyId);
  const chartSource = getActiveChartSource(cfg);
  const fullHist = chartSource.history || [];
  const symEl = document.getElementById(symId);
  if (symEl) {
    const modeLabel = chartSource.mode === 'contract' ? 'Single Contract' : chartSource.displayMode;
    symEl.textContent = `${chartSource.displaySymbol || chartSource.symbol} · ${modeLabel} · ${cfg.unit} · ${cfg.currency}`;
  }

  if (!fullHist.length) {
    const emptyMsg = chartSource.mode === 'contract'
      ? `No chart history available for ${esc(chartSource.displaySymbol || chartSource.label)}.`
      : 'No volume-led continuous history available. yfinance returned no chart data.';
    body.innerHTML = (showControls ? renderChartControls() : '') +
      `<div class="chart-empty">${emptyMsg}</div>`;
    if (showControls) bindChartControls(cfg);
    return;
  }

  let bars = getChartBars(cfg);
  bars = injectLivePoint(bars, chartSource.liveSymbol, fullHist);

  // Mouse-wheel zoom (Charts tab): slice the full bar set to the saved visible window. The
  // window auto-resets when the underlying view changes (market / interval / range / mode) so
  // each timeframe opens full, but survives live-tick repaints (same signature). `fullBars`
  // keeps the unsliced set for the wheel handler's index math below.
  const st = chartState;
  const wheelZoom = !!opts.wheelZoom;
  const fullBars = bars;
  if (wheelZoom) {
    const N0 = fullBars.length;
    st._zoomN = N0;                                 // full bar count for this view — read by the Charts tab's "jump to latest" button
    const sig = `${st.key}|${st.interval}|${st.range}|${st.chartMode}|${st.contractSymbol || ''}`;
    if (st._zoomSig !== sig) {
      st.zoomStart = null; st.zoomEnd = null; st._zoomSig = sig;
      // Only the opening window moves (opts.initialBars): every bar stays loaded, the wheel zooms out
      // and a double-click shows all of them.
      if (opts.initialBars && N0 > opts.initialBars) { st.zoomStart = N0 - opts.initialBars; st.zoomEnd = N0 - 1; }
    }
    if (N0 > 3 && Number.isFinite(st.zoomStart) && Number.isFinite(st.zoomEnd)) {
      const zs = Math.max(0, Math.min(st.zoomStart, N0 - 2));
      const ze = Math.max(zs + 1, Math.min(st.zoomEnd, N0 - 1));
      st.zoomStart = zs; st.zoomEnd = ze;            // persist the clamped window
      bars = fullBars.slice(zs, ze + 1);
    }
  }

  const cot  = normalizeCotSeries(cfg.cot_series || []);

  // Responsive: derive width from the real content area.
  // body.clientWidth includes padding; the SVG is inside the content box.
  // If both are not aligned 1:1, the browser scales slightly and lines look blurry.
  const bodyRect = body.getBoundingClientRect();
  const bodyStyle = window.getComputedStyle(body);
  const padX = (Number.parseFloat(bodyStyle.paddingLeft) || 0) + (Number.parseFloat(bodyStyle.paddingRight) || 0);
  const wrapW = Math.max(320, (bodyRect.width || body.clientWidth || 900) - padX);
  // -2 for the .chart-svg-wrap's 1px border each side: the SVG lives inside that wrap, so its
  // available width is 2px less than #chartBody. Matching it keeps the SVG 1:1 (no fractional
  // down-scale that would blur/double the 1px candle strokes).
  const W = Math.max(320, Math.floor(wrapW) - 2);
  const padL = 52, padR = 56, padT = 8;
  // Price-pane height: default 38% of width (price stays dominant; panes grow downward).
  // opts.priceH lets the maximized Charts tab fill the viewport height instead.
  const priceH = Math.round(opts.priceH || (W * 0.38));
  const volumeH = PANE_H.volume, oiH = PANE_H.oi, cotH = PANE_H.cot, spreadH = PANE_H.spread, gap = PANE_GAP;
  const innerW = W - padL - padR;
  const edgePad = Math.max(24, Math.min(56, Math.round(innerW * 0.05)));
  // Empty space kept to the RIGHT of the newest candle, so a drawing can be dragged into the
  // future instead of stopping dead at the last bar. Charts tab only: opts.drawings is set by
  // renderBigChart alone, so the Futures tab, Macro Shift, the Weekly Outlook and card-mode
  // keep their exact old geometry -- which is what keeps the content bot's PNGs byte-stable.
  const rightMargin = opts.drawings ? Math.round(innerW * CHART_DRAW_RIGHT_MARGIN) : 0;
  const plotW = Math.max(120, innerW - edgePad * 2 - rightMargin);
  const n = bars.length;

  if (!n) {
    body.innerHTML = (showControls ? renderChartControls() : '') + '<div class="chart-empty">No data for the selected range.</div>';
    if (showControls) bindChartControls(cfg);
    return;
  }

  // Candle geometry
  const slot = plotW / n;
  const candleW = Math.max(1, Math.min(12, slot * candleWidthFactor()));
  const xAt = i => padL + edgePad + slot * (i + 0.5);
  const barXs = bars.map((_, i) => xAt(i));
  const barTimes = bars.map(b => new Date(b.date).getTime());
  const nearestBarIndexByTime = (time) => {
    let best = 0, dist = Math.abs(barTimes[0] - time);
    for (let i = 1; i < barTimes.length; i++) {
      const d = Math.abs(barTimes[i] - time);
      if (d < dist) { best = i; dist = d; }
    }
    return best;
  };
  const xForDate = date => barXs[nearestBarIndexByTime(new Date(date).getTime())];

  // ── Technical indicators (Charts tab only). Compute now so price-pane overlays can widen the
  // autoscale below, and oscillator panes can reserve stack height. The Futures tab / card-mode
  // pass no opts.drawings and carry no chartState.indicators, so taActive is empty there. The
  // visibility eye (_indHidden) blanks the list too. ──
  const taActive = (opts.drawings && !chartState._indHidden && typeof INDICATOR_DEFS !== 'undefined' && Array.isArray(chartState.indicators))
    ? chartState.indicators.filter(i => i && i.visible !== false && INDICATOR_DEFS[i.type])
    : [];
  const taOverlayData = taActive.filter(i => INDICATOR_DEFS[i.type].kind === 'overlay')
    .map(ind => ({ ind, data: computeIndicator(ind, bars) })).filter(o => o.data);
  const taPaneData = taActive.filter(i => INDICATOR_DEFS[i.type].kind === 'pane')
    .map(ind => ({ ind, data: computeIndicator(ind, bars) })).filter(o => o.data);

  // Price scale. Filter to finite values first: a single null/undefined low/high would
  // make Math.min/Math.max NaN, poisoning the whole domain so the SVG renders nothing.
  const lows = bars.map(d => d.low).filter(Number.isFinite);
  const highs = bars.map(d => d.high).filter(Number.isFinite);
  let pMin = lows.length ? Math.min(...lows) : 0;
  let pMax = highs.length ? Math.max(...highs) : 1;
  // Overlays (SMA/EMA/Bollinger) participate in the price domain so a long MA or a band edge
  // never clips out of the price pane.
  taOverlayData.forEach(({ data }) => data.lines.forEach(ln => {
    for (let i = 0; i < ln.values.length; i++) { const v = ln.values[i]; if (Number.isFinite(v)) { if (v < pMin) pMin = v; if (v > pMax) pMax = v; } }
  }));
  const pRng = (pMax - pMin) || 1;
  const pad = pRng * 0.05;
  const pLo = pMin - pad, pHi = pMax + pad, pSpan = pHi - pLo;
  const pY = v => padT + (1 - (v - pLo) / pSpan) * priceH;

  const dec = cfg.tick_decimals;

  // Candlesticks — style-aware: filled / hollow (up drawn as an outline) / line (close only);
  // colours and outline come from candlePaint() (core.js), the shared definition.
  let candles = '';
  if (CHART_STYLE.candle === 'line') {
    candles = candleLinePath(bars.map((d, i) => ({ x: xAt(i), y: pY(d.close) })));
  } else {
    bars.forEach((d, i) => {
      const x = xAt(i);
      const up = d.close >= d.open;
      const { fill, stroke: strokeCol, strokeW, wick: wickStroke, wickW: _wickW, border } = candlePaint(up);
      const yHn = pY(d.high), yLn = pY(d.low);
      const bTopR = Math.min(pY(d.open), pY(d.close)), bBotR = Math.max(pY(d.open), pY(d.close));   // real body bounds
      // Pixel-snap to keep 1px outlines crisp at integer DPR: a 1px stroke is crisp only when its
      // centre sits at integer+0.5. Bodies with a visible outline (hollow, or a border colour) align
      // their EDGES to .5; plain filled bodies align their fill edges to whole pixels.
      const a = (fill === 'none' || border) ? 0.5 : 0;
      const wx = Math.round(x) + 0.5;                                   // 1px wick centre on the grid
      const L = Math.round(x - candleW / 2) + a, R = Math.round(x + candleW / 2) + a;
      const rT = Math.round(bTopR) + a, rB = Math.round(bBotR) + a;
      // Wicks: two guarded segments (above + below the body) so they never cross a hollow body.
      if (yHn < bTopR) candles += `<line x1="${wx}" y1="${Math.round(yHn) + 0.5}" x2="${wx}" y2="${Math.round(bTopR) + 0.5}" stroke="${wickStroke}" stroke-width="${_wickW}"/>`;
      if (bBotR < yLn) candles += `<line x1="${wx}" y1="${Math.round(bBotR) + 0.5}" x2="${wx}" y2="${Math.round(yLn) + 0.5}" stroke="${wickStroke}" stroke-width="${_wickW}"/>`;
      if (bBotR - bTopR < 1) {
        // doji / sub-pixel body: a single open≈close line across the candle width, in the text
        // colour (black on light themes, light on dark) rather than the up/down fill colour.
        const y = Math.round(bTopR) + 0.5;
        candles += `<line x1="${L}" y1="${y}" x2="${R}" y2="${y}" stroke="${CHART_THEME.text}" stroke-width="1"/>`;
      } else {
        candles += `<rect x="${L}" y="${rT}" width="${R - L}" height="${rB - rT}" fill="${fill}" stroke="${strokeCol}" stroke-width="${strokeW}"/>`;
      }
    });
  }

  // Live tick marker (display-only): a pulsing hollow dot on the provisional last point.
  let liveDot = '';
  const liveBar = bars[bars.length - 1];
  if (liveBar && liveBar.__live) {
    const lx = xAt(bars.length - 1).toFixed(1);
    const ly = pY(liveBar.close).toFixed(1);
    liveDot =
      `<circle class="chart-live-dot" cx="${lx}" cy="${ly}" r="3" fill="none" stroke="${CHART_THEME.bull}" stroke-width="1.5">` +
      `<animate attributeName="r" values="3;6;3" dur="1.6s" repeatCount="indefinite"/>` +
      `<animate attributeName="opacity" values="1;0.2;1" dur="1.6s" repeatCount="indefinite"/></circle>`;
  }

  // ── Current-price line: a subtle dashed line at the last traded price (the live tick
  // when present — injectLivePoint spliced it in as the last bar; otherwise the last
  // settled close) + a price tag RIGHT-ALIGNED to the axis: right edge fixed at the chart
  // border, the tag grows leftwards — long numbers (e.g. BTC) are never clipped. Its own
  // class (not chart-live-dot) so the SVG export keeps it; it also appears in card-mode.
  // `curY` is used below to drop a round-level label that collides at the same height.
  let priceLine = '';
  let curY = null;
  if (liveBar && Number.isFinite(liveBar.close)) {
    const cp = liveBar.close;
    const cy = pY(cp);
    if (Number.isFinite(cy)) {
      curY = cy;
      const tagY = Math.max(padT + 8, Math.min(padT + priceH - 8, cy));
      const txt = cp.toFixed(dec);
      const tagW = Math.max(34, txt.length * 6.2 + 10);
      const tagX = W - 2 - tagW;
      priceLine =
        `<line class="chart-price-line" x1="${padL}" y1="${cy.toFixed(1)}" x2="${tagX.toFixed(1)}" y2="${cy.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="5,4"/>` +
        `<g class="chart-price-line">` +
        `<rect x="${tagX.toFixed(1)}" y="${(tagY - 8).toFixed(1)}" width="${tagW.toFixed(1)}" height="16" rx="2.5" fill="${CHART_THEME.bg}" stroke="${CHART_THEME.axis}" stroke-width="1"/>` +
        `<text x="${(tagX + tagW / 2).toFixed(1)}" y="${(tagY + 3.5).toFixed(1)}" font-size="10" font-weight="600" text-anchor="middle" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${txt}</text>` +
        `</g>`;
    }
  }

  // ── Roll markers: scheduled front-month expiries (exchange calendar) ──
  // Deterministic, from contract_months + expiry_rule (generator-side, in roll_dates).
  // On-screen + native continuous only: NOT in card-mode exports and not in the
  // single-contract view. A marker is the SCHEDULED expiry and can sit a few days away
  // from where Yahoo actually rolled (that point is unknowable). Labels are thinned out
  // on dense (monthly) cycles; the line stays.
  let rollLines = '', rollLabels = '';
  if (showRoll
      && !document.body.classList.contains('card-mode')
      && chartSource.mode !== 'contract'
      && Array.isArray(cfg.roll_dates) && cfg.roll_dates.length) {
    const t0 = barTimes[0], t1 = barTimes[n - 1];
    let lastLabelX = -1e9;
    for (const r of cfg.roll_dates) {
      const rt = new Date(r.date).getTime();
      if (isNaN(rt) || rt < t0 || rt > t1) continue;
      const x = xForDate(r.date);
      rollLines += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${(padT + priceH).toFixed(1)}" stroke="#64748b" stroke-width="1" stroke-dasharray="5,4" opacity="0.38"/>`;
      if (r.code && x - lastLabelX >= 24) {
        rollLabels += `<text x="${(x + 2).toFixed(1)}" y="${(padT + priceH - 4).toFixed(1)}" font-size="9" font-weight="600" fill="#475569" font-family="Geist, system-ui, sans-serif">${r.code}</text>`;
        lastLabelX = x;
      }
    }
  }

  // ── Runde / psychologische Level (institutionelle Schwellen) ──
  // Adjust step size to price magnitude; target: about 3-7 visible levels.
  function roundLevelStep(span, lo, hi) {
    // Base step from the order of magnitude of the range
    const rawStep = span / 5;
    const mag = Math.pow(10, Math.floor(Math.log10(rawStep)));
    // nice multiples: 1, 2, 2.5, 5, 10
    const candidates = [1, 2, 2.5, 5, 10].map(m => m * mag);
    let step = candidates[0];
    for (const c of candidates) {
      if (span / c <= 7) { step = c; break; }
    }
    return step;
  }
  const levelStep = roundLevelStep(pSpan, pLo, pHi);
  const firstLevel = Math.ceil(pLo / levelStep) * levelStep;
  const _gridOff = CHART_STYLE.grid === 'off';
  const _gridOpacity = CHART_STYLE.grid === 'subtle' ? 0.4 : 0.78;
  let roundLevels = '';
  for (let lv = firstLevel; lv <= pHi; lv += levelStep) {
    // Smooth floating point noise
    lv = Math.round(lv / levelStep) * levelStep;
    if (lv < pLo || lv > pHi) continue;
    const y = pY(lv).toFixed(1);
    if (!_gridOff)
      roundLevels += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="2,4" opacity="${_gridOpacity}"/>`;
    // Drop the label when it collides with the current-price tag at the same height.
    // Right-aligned (text-anchor=end) at the right edge so long numbers (BTC: "100000.00")
    // are not clipped at the border.
    if (!(curY != null && Math.abs(+y - curY) < 9))
      roundLevels += `<text x="${W-4}" y="${(+y+3).toFixed(1)}" font-size="10" text-anchor="end" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${lv.toFixed(dec)}</text>`;
  }

  // ── OI and COT panes in daily and weekly views (CFTC data is weekly) ──
  const firstDate = new Date(bars[0].date), lastDate = new Date(bars[n-1].date);
  const inVisibleRange = d => {
    const dt = new Date(d.date);
    return dt >= firstDate && dt <= lastDate;
  };

  const showVolume = showPanes && chartState.showVolume;
  const showSpread = showPanes && chartState.showSpread;
  // CFTC OI + COT are weekly data — only meaningful in daily/weekly views. In monthly/quarterly
  // (the Charts tab's higher timeframes) they're hidden and reserve no height. The Charts tab can
  // toggle OI and COT off independently (chartState.showOi/showCot === false); the Futures tab has
  // no such flags (undefined !== false) so its OI/COT stay always-on.
  const oiCotOk = showPanes && paneShowsOiCot(chartState.interval);
  const showOi = oiCotOk && chartState.showOi !== false;
  const showCot = oiCotOk && chartState.showCot !== false;
  let volumeSvg = '', oiSvg = '', cotSvg = '', spreadSvg = '', volumeTop = 0, oiTop = 0, cotTop = 0, spreadTop = 0;
  // Pane tops via a running stack-cursor: each active pane lands below the previous one (or the
  // price pane), so any on/off combination stacks with no gap. Mirrors panesHeight().
  let stackBottom = padT + priceH;
  if (showVolume) { volumeTop = stackBottom + PANE_GAP; stackBottom = volumeTop + PANE_H.volume; }
  // TA oscillator panes (RSI/Stoch/MACD/ATR) stack directly under price/volume, above the CFTC
  // OI/COT/spread panes (TradingView convention). Each reserves PANE_H_TA via the same cursor.
  const taPaneLayout = (showPanes ? taPaneData : []).map(({ ind, data }) => {
    const top = stackBottom + PANE_GAP; stackBottom = top + PANE_H_TA; return { ind, data, top, h: PANE_H_TA };
  });
  if (showOi)     { oiTop     = stackBottom + PANE_GAP; stackBottom = oiTop     + PANE_H.oi; }
  if (showCot)    { cotTop    = stackBottom + PANE_GAP; stackBottom = cotTop    + PANE_H.cot; }
  if (showSpread) { spreadTop = stackBottom + PANE_GAP; stackBottom = spreadTop + PANE_H.spread; }

  // ── Build the TA overlay paths (price pane) and oscillator panes. taCrosshairPanes feeds the
  // crosshair the per-pane geometry + value arrays for hover readouts. ──
  let taOverlaySvg = '';
  taOverlayData.forEach(({ data }) => {
    if (data.band) taOverlaySvg += _taBandPath(data.band.upper, data.band.lower, barXs, pY, data.band.color);
    data.lines.forEach(ln => { taOverlaySvg += _taLinePath(ln.values, barXs, pY, ln.color, ln.width, ln.dash, ln.opacity); });
  });
  let taPanesSvg = '', taPaneHeadings = '';
  const taCrosshairPanes = [];
  taPaneLayout.forEach(({ ind, data, top, h }) => {
    const r = _renderTaPane(ind, data, { top, h, padL, padR, W, dec, barXs, slot });
    taPanesSvg += r.svg; taPaneHeadings += r.heading; taCrosshairPanes.push(r.cross);
  });

  let presentOiSources = new Set();
  const panesH = showPanes ? panesHeight(chartState) : 0;
  const visCot = cot.filter(inVisibleRange);
  const cotLabel = (cot[0] && (cot[0].cot_label || cot[0].cotLabel)) || 'Commercial Net';
  const cotReport = (cot[0] && cot[0].cot_report) || 'CFTC';
  const latestCotDate = cot.length ? cot[cot.length - 1].date : null;
  const cotValue = cotNetOf;   // core.js — the one definition, shared with the Weekly Outlook
  const cotHedgingActive = chartState.cotHedging && (chartState.range === '6m' || chartState.range === '12m');
  // The program window is the selected range here (6M or 12M); the Weekly Outlook draws the
  // fixed 6M one, because that is what the screener's COT Hedging column reports. Both go
  // through cotHedgeWindow() in core.js — see the note there.
  function trailingCotWindow(series, range) {
    if (!series.length || (range !== '6m' && range !== '12m')) return [];
    return cotHedgeWindow(series, RANGE_DAYS[range] || 365);
  }
  const hedgeCot = cotHedgingActive ? trailingCotWindow(cot, chartState.range) : [];
  const cotBars = (cotHedgingActive ? hedgeCot : visCot).filter(inVisibleRange);
  let crosshairVolumePoints = [], crosshairOiPoints = [], crosshairCotPoints = [], crosshairSpreadPoints = [];

  // volumeTop/oiTop/cotTop/spreadTop are precomputed above via the running stack-cursor.
  let volumeHeading = chartSource.mode === 'continuous' ? 'TOTAL' : 'CONTRACT';
  let volumeLegend = '';

  // Optional volume pane: continuous mode prefers summed contract volume; single-contract mode uses that contract's own bars.
  if (showVolume) {
    const rawTotalVolumeRows = normalizeVolumeSeries(chartSource.totalVolumeHistory || []);
    const hasSummedTotalVolume = chartSource.mode === 'continuous'
      && rawTotalVolumeRows.some(row => row.source === 'yfinance_contract_sum');
    let rawVolumeRows = [];
    volumeLegend = chartSource.mode === 'continuous'
      ? 'Continuous volume: summed yfinance contracts'
      : 'Volume: selected expiration contract from yfinance';

    if (chartSource.mode === 'continuous' && rawTotalVolumeRows.length) {
      rawVolumeRows = chartState.interval === 'weekly' ? aggregateWeeklyVolume(rawTotalVolumeRows) : rawTotalVolumeRows;
      if (!hasSummedTotalVolume) {
        volumeHeading = 'CONTINUOUS';
        volumeLegend = 'Continuous volume: yfinance fallback';
      }
    } else {
      rawVolumeRows = bars.map(row => ({
        date: row.date,
        volume: Number(row.volume) || 0,
        source: chartSource.mode === 'contract' ? 'yfinance_single_contract' : 'yfinance_continuous_volume'
      }));
    }

    const volumeRows = rawVolumeRows.filter(row => {
      const dt = new Date(row.date);
      return dt >= firstDate && dt <= lastDate
        && Number(row.volume) > 0
        && !row.suspect
        && row.source !== 'yfinance_volume_suspect_low';
    });
    const omittedSuspectVolumeRows = rawVolumeRows.filter(row => {
      const dt = new Date(row.date);
      return dt >= firstDate && dt <= lastDate
        && (row.suspect || row.source === 'yfinance_volume_suspect_low');
    });
    if (omittedSuspectVolumeRows.length) {
      volumeLegend += ' · suspect low-volume yfinance gaps omitted';
    }

    if (volumeRows.length) {
      const volumeByBarIndex = new Map();
      volumeRows.forEach(row => {
        const idx = nearestBarIndexByTime(new Date(row.date).getTime());
        if (idx < 0 || idx >= bars.length) return;
        const prev = volumeByBarIndex.get(idx);
        if (prev) {
          prev.volume += Number(row.volume) || 0;
          prev.source = prev.source === row.source ? prev.source : 'mixed_volume';
          prev.contract_count = Math.max(prev.contract_count || 0, row.contract_count || 0);
        } else {
          volumeByBarIndex.set(idx, {
            ...row,
            date: bars[idx].date,
            barIndex: idx,
            volume: Number(row.volume) || 0
          });
        }
      });
      const volumeRenderRows = Array.from(volumeByBarIndex.values())
        .filter(row => row.volume > 0)
        .sort((a, b) => a.barIndex - b.barIndex);
      const volumeMax = volumeRenderRows.length ? Math.max(...volumeRenderRows.map(row => row.volume)) : 0;
      const volumeBase = volumeTop + volumeH;
      const volumeY = v => volumeBase - (volumeMax ? (v / volumeMax) * volumeH : 0);
      const volumeBarW = Math.max(1, Math.min(12, slot * 0.7));
      let volumeBarsSvg = '';
      volumeRenderRows.forEach(row => {
        const x = barXs[row.barIndex];
        const y = volumeY(row.volume);
        const h = Math.max(1, volumeBase - y);
        const priceBar = bars[row.barIndex] || {};
        const up = (priceBar.close ?? 0) >= (priceBar.open ?? 0);
        const color = up ? CHART_THEME.volumeBull : CHART_THEME.volumeBear;
        crosshairVolumePoints.push({ date: row.date, x, y, value: row.volume });
        volumeBarsSvg += `<rect x="${(x-volumeBarW/2).toFixed(1)}" y="${y.toFixed(1)}" width="${volumeBarW.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" opacity="0.48" rx="1"/>`;
      });
      volumeSvg = volumeRenderRows.length ? `
        <line x1="${padL}" y1="${volumeTop}" x2="${W-padR}" y2="${volumeTop}" stroke="${CHART_THEME.grid}"/>
        <line x1="${padL}" y1="${volumeBase}" x2="${W-padR}" y2="${volumeBase}" stroke="${CHART_THEME.grid}"/>
        ${volumeBarsSvg}
        <text x="${W-padR+5}" y="${(volumeTop+8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${(volumeMax/1000).toFixed(0)}K</text>`
        : `<text x="${padL}" y="${volumeTop+volumeH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" font-style="italic">No volume data in this range</text>`;
    } else {
      volumeSvg = `<text x="${padL}" y="${volumeTop+volumeH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" font-style="italic">No volume data in this range</text>`;
    }
  }

  const dailyOi = normalizeOiSeries(cfg.daily_oi_series || []);
  const visDailyOi = dailyOi.filter(inVisibleRange);
  const useDailyOi = chartState.interval === 'daily' && visDailyOi.length > 0;
  const oiPoints = useDailyOi ? visDailyOi : visCot.filter(d => d.oi != null);
  const latestOiPoint = oiPoints.length ? oiPoints[oiPoints.length - 1] : null;
  const latestOiDate = latestOiPoint?.date || latestCotDate;
  const oiHeading = 'CFTC WEEKLY TOTAL';

  // Seasonal-tendency overlay (opt-in). Built from the FULL OI history — the curve needs whole
  // years, not the visible slice — and projected onto the drawn points, so it lands on the pane's
  // own contract scale. `=== true` on purpose: the Futures tab carries no OI/COT flags (undefined
  // !== false keeps those panes on), and card mode renders through this same state, so anything
  // looser would put a new line on the content bot's PNGs.
  const showOiSeasonal = showOi && chartState.showOiSeasonal === true && typeof buildOiSeasonalCurve === 'function';
  let oiSeasonalCurve = null, oiSeasonalPoints = [];
  if (showOiSeasonal) {
    // The FULL OI history, twice: the curve needs whole years, and its level is the trailing year
    // of reports — neither may come from the visible slice, or the same line would draw
    // differently at 6M and at 12M.
    const oiAll = useDailyOi ? dailyOi : cot.filter(d => d.oi != null);
    oiSeasonalCurve = buildOiSeasonalCurve(oiAll, OI_SEASONAL_YEARS);
    if (oiSeasonalCurve) {
      oiSeasonalPoints = oiSeasonalOverlay(oiPoints, oiSeasonalCurve, oiSeasonalLevel(oiAll, oiSeasonalCurve));
    }
  }
  const oiSeasonalYears = oiSeasonalPoints.length ? `${oiSeasonalCurve.yearsUsed}Y` : null;   // 4Y while the archive is short of five

  const oiLegend = `Open Interest: CFTC weekly total${latestOiDate ? ' · report date ' + latestOiDate : ''}`
    + (oiSeasonalPoints.length
        ? ` · Seasonal: average of ${oiSeasonalCurve.yearsUsed} complete years (${oiSeasonalCurve.startYear}-${oiSeasonalCurve.endYear}), at this market's current annual OI level`
        : (showOiSeasonal ? ' · Seasonal: not enough complete years on file' : ''));

  // OI pane (oiTop precomputed via the stack-cursor)
  if (showOi && oiPoints.length) {
    // The seasonal projection is on the pane's own scale, so the scale has to hold it too — a
    // year that runs well under its usual path would otherwise draw the overlay into the frame.
    const oiSeasonalVals = oiSeasonalPoints.filter(Boolean).map(sp => sp.value);
    const oiVals = oiPoints.map(d => d.oi);
    const oiMin = Math.min(...oiVals, ...oiSeasonalVals), oiMax = Math.max(...oiVals, ...oiSeasonalVals);
    const oiRng = oiMax - oiMin;
    const oiY = v => oiTop + (oiRng ? (1 - (v - oiMin) / oiRng) * oiH : oiH / 2);
    let oiPath = '';
    crosshairOiPoints = oiPoints.map((d, i) => ({
      date: d.date,
      x: xForDate(d.date),
      y: oiY(d.oi),
      value: d.oi,
      seasonal: oiSeasonalPoints[i] ? oiSeasonalPoints[i].value : null
    })).sort((a, b) => a.x - b.x);
    let oiDots = '';
    oiPoints.forEach((d, i) => {
      const point = crosshairOiPoints[i];
      oiPath += (i===0?'M':'L') + point.x.toFixed(1) + ',' + point.y.toFixed(1) + ' ';
      const src = d.source || (useDailyOi ? 'daily' : 'cftc_cot');
      const cx = point.x.toFixed(1), cy = point.y.toFixed(1);
      // CFTC weekly history: muted baseline dot
      oiDots += `<circle cx="${cx}" cy="${cy}" r="${useDailyOi ? 2.3 : 1.8}" fill="${CHART_THEME.oiCftc}" opacity="${useDailyOi ? 0.6 : 0.42}"/>`;
    });
    // Which sources appear in view (used by the legend next to the OI heading).
    presentOiSources = new Set(oiPoints.map(d => d.source || (useDailyOi ? 'daily' : 'cftc_cot')));

    // The seasonal line, on the same x positions as the OI line so the two read point by point.
    // ONE unbroken line: the curve carries no anchor, so the only `M` after the first is a point
    // the curve cannot speak for (a leap-day report), which is a hole and must not be bridged.
    // It ran broken at every January while each year was re-anchored — reported on gold, silver
    // and cotton, where the line sits close to the pane edge and the hole reads as a defect.
    let oiSeasonalPath = '';
    let oiSeasonalPen = false;
    oiSeasonalPoints.forEach((sp, i) => {
      const pt = sp ? crosshairOiPoints[i] : null;
      if (!pt || !Number.isFinite(pt.x)) { oiSeasonalPen = false; return; }
      oiSeasonalPath += (oiSeasonalPen ? 'L' : 'M')
        + pt.x.toFixed(1) + ',' + oiY(sp.value).toFixed(1) + ' ';
      oiSeasonalPen = true;
    });
    const oiSeasonalSvg = oiSeasonalPath
      ? `<path d="${oiSeasonalPath}" fill="none" stroke="${CHART_THEME.oiSeasonal}" stroke-width="1.5" stroke-dasharray="5,3" stroke-linecap="round" opacity="0.9"/>`
      : '';

    oiSvg = `
      <line x1="${padL}" y1="${oiTop}" x2="${W-padR}" y2="${oiTop}" stroke="${CHART_THEME.grid}"/>
      <line x1="${padL}" y1="${oiTop+oiH}" x2="${W-padR}" y2="${oiTop+oiH}" stroke="${CHART_THEME.grid}"/>
      ${oiPoints.length > 1 ? `<path d="${oiPath}" fill="none" stroke="${CHART_THEME.oi}" stroke-width="1.5" opacity="0.8"/>` : ''}
      ${oiSeasonalSvg}
      ${oiDots}
      <text x="${W-padR+5}" y="${(oiTop+5).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${(oiMax/1000).toFixed(0)}K</text>
      <text x="${W-padR+5}" y="${(oiTop+oiH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${(oiMin/1000).toFixed(0)}K</text>`;
  } else if (showOi) {
    oiSvg = `<text x="${padL}" y="${oiTop+oiH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" font-style="italic">No Open Interest data in this range</text>`;
  }

  // COT pane (report-dependent net position; cotTop precomputed via the stack-cursor)
  if (showCot && cotBars.length) {
    const thresholdSource = cotHedgingActive ? hedgeCot : cotBars;
    const cotVals = thresholdSource.map(cotValue).filter(v => v !== null && v !== undefined);
    // Midpoint of the window, through core.js — the same level the Weekly Outlook draws and
    // screener.py's cot_hedge signal reads.
    const lv = cotHedgeLevels(thresholdSource) || { min: -1, max: 1, threshold: 0 };
    const cotMin = lv.min, cotMax = lv.max, cotThreshold = lv.threshold;
    const cotAbs = cotVals.length ? (Math.max(...cotVals.map(Math.abs)) || 1) : 1;
    const cotPad = Math.max(1, (cotMax - cotMin) * 0.08);
    const cotLo = cotHedgingActive ? cotMin - cotPad : -cotAbs;
    const cotHi = cotHedgingActive ? cotMax + cotPad : cotAbs;
    const cotSpan = (cotHi - cotLo) || 1;
    const cotY = v => cotTop + (1 - (v - cotLo) / cotSpan) * cotH;
    const cotMid = cotHedgingActive ? cotY(cotThreshold) : cotY(0);
    // Bars stay anchored to the SHARED time axis (xForDate) — like the OI line above and the
    // spread pane below — but their spacing is evened out by cotBarLayout() in core.js: the
    // first and last report keep their true x, the ones between are spread evenly across that
    // span. Weekly reports otherwise land 4, 5 or 6 candles apart (holiday weeks, delayed
    // releases), which left gaps varying by ~2.6x. See core.js for why this must NOT become an
    // even division of the pane width.
    const cotLayout = cotBarLayout(cotBars.map(d => xForDate(d.date)), plotW);
    const barW = Math.max(1, Math.min(14, cotLayout.step * 0.55));
    let bars2 = '';
    // Paper cards (core.js PAPER_CARD_COLORS) draw the bars in the website's bull/bear; the app
    // keeps its own green/red in both themes, which is why these stay literals rather than tokens.
    const paperCard = typeof _isPaperCard === 'function' && _isPaperCard();
    const cotUp = paperCard ? PAPER_CARD_COLORS['--chart-bull'] : '#0ea679';
    const cotDown = paperCard ? PAPER_CARD_COLORS['--chart-bear'] : '#e53e3e';
    cotBars.forEach((d, i) => {
      const net = cotValue(d);
      if (net === null || net === undefined) return;
      const x = cotLayout.xs[i], y = cotY(net), h = Math.abs(y - cotMid);
      const col = cotHedgingActive
        ? (net >= cotThreshold ? cotUp : cotDown)
        : (net >= 0 ? cotUp : cotDown);
      crosshairCotPoints.push({ date: d.date, x, y, value: net, color: col });
      bars2 += `<rect x="${(x-barW/2).toFixed(1)}" y="${Math.min(y,cotMid).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1,h).toFixed(1)}" fill="${col}" opacity="0.7" rx="1"/>`;
    });
    const upperLabel = cotHedgingActive ? cotMax : cotAbs;
    const lowerLabel = cotHedgingActive ? cotMin : -cotAbs;
    const midLabel = cotHedgingActive ? `<text x="${W-padR+5}" y="${(cotMid+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.bull}" font-family="Geist, system-ui, sans-serif">${(cotThreshold/1000).toFixed(0)}K</text>` : '';
    cotSvg = `
      <line x1="${padL}" y1="${cotMid.toFixed(1)}" x2="${W-padR}" y2="${cotMid.toFixed(1)}" stroke="${cotHedgingActive ? CHART_THEME.bull : CHART_THEME.axis}" stroke-dasharray="4,3"/>
      ${bars2}
      <text x="${W-padR+5}" y="${(cotTop+8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${(upperLabel/1000).toFixed(0)}K</text>
      ${midLabel}
      <text x="${W-padR+5}" y="${(cotTop+cotH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${(lowerLabel/1000).toFixed(0)}K</text>`;
  } else if (showCot) {
    cotSvg = `<text x="${padL}" y="${cotTop+cotH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" font-style="italic">No CFTC COT data in this range</text>`;
  }

  // Calendar-spread pane (front minus next contract; negative = contango).
  // Optional, off by default. Daily only — the spread is built from daily EoD
  // contracts; in weekly view we still plot the underlying daily points.
  if (showSpread) {
    // spreadTop precomputed via the stack-cursor (stacks below COT / OI / Volume / price as present).
    // Settled EoD only: the pane ends at the last closed bar. No live/forming point is
    // appended (the price line keeps its live candle; the spread deliberately does not).
    let spreadSeries = currentPairSpread(normalizeSpreadSeries(cfg.calendar_spread_series || []));
    spreadSeries = spreadSeries.filter(inVisibleRange);
    if (spreadSeries.length) {
      // Only the pair trading today, its scale, colour by side of zero and labels:
      // currentPairSpread / spreadPaneScale / spreadPaneSvg (next to normalizeSpreadSeries),
      // shared with the Weekly Outlook.
      const sp = spreadPaneScale(spreadSeries.map(d => d.spread), spreadTop, spreadH);
      crosshairSpreadPoints = spreadSeries.map(d => ({
        date: d.date, x: xForDate(d.date), y: sp.y(d.spread), value: d.spread,
        color: spreadSideColor(d.spread),
        pair: `${d.front_contract || ''}-${d.next_contract || ''}`
      })).sort((a, b) => a.x - b.x);
      spreadSvg = spreadPaneSvg(crosshairSpreadPoints, sp, padL, W-padR, dec, W - 4);
    } else {
      spreadSvg = `<text x="${padL}" y="${spreadTop+spreadH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" font-style="italic">No calendar-spread data in this range (fills in over time)</text>`;
    }
  }

  // The x labels sit below the last pane.
  const axisY = padT + priceH + panesH;
  const totalH = axisY + 22;

  // Period dividers (Charts tab "Dividers" toggle): full-height vertical lines at calendar
  // boundaries — a new MONTH on the Daily timeframe, a new YEAR on Weekly/Monthly/Quarterly.
  // Charts-tab only (chartState.showDividers is set on bigChartState) and never in card-mode.
  let dividerLines = '', dividerLabels = '';
  if (chartState.showDividers && bars.length && !document.body.classList.contains('card-mode')) {
    const MONTH_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const yearly = chartState.interval !== 'daily';   // daily → months; weekly/monthly/quarterly → years
    let prevKey = null;
    bars.forEach((d, i) => {
      const dt = new Date(d.date);
      const yr = dt.getUTCFullYear(), mo = dt.getUTCMonth();
      const key = yearly ? yr : yr * 12 + mo;
      if (prevKey !== null && key !== prevKey) {
        const x = (barXs[i] - slot / 2).toFixed(1);
        dividerLines += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${axisY.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="4,3" opacity="0.7"/>`;
        // Label the year on yearly dividers and on the January (year-start) daily divider; other
        // monthly dividers stay unlabeled to avoid clutter when bars are dense.
        const label = yearly ? String(yr) : (mo === 0 ? String(yr) : '');
        if (label) dividerLabels += `<text x="${(barXs[i] - slot / 2 + 3).toFixed(1)}" y="${(padT + 10).toFixed(1)}" font-size="9" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" opacity="0.85">${label}</text>`;
      }
      prevKey = key;
    });
  }

  let xLabels = '';
  for (let g = 0; g <= 5; g++) {
    const i = Math.round((n-1) * g / 5);
    const x = xAt(i).toFixed(1);
    xLabels += `<text x="${x}" y="${totalH-4}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" text-anchor="middle">${fmtAxisDate(bars[i].date)}</text>`;
  }
  const intervalLabel = { daily:'Daily', weekly:'Weekly', monthly:'Monthly', quarterly:'Quarterly' }[chartState.interval] || 'Daily';
  const rangeLabel = { '6m':'6 Months', '12m':'12 Months', '5y':'5 Years', '20y':'20 Years', 'max':'Max History' }[chartState.range] || '';

  // Source legend, placed to the right of the OI heading.
  const oiHeadingText = `OPEN INTEREST (${oiHeading}${oiSeasonalYears ? ` · SEASONAL ${oiSeasonalYears} AVG` : ''})`;
  // width at 10px Geist 600 incl. 0.05em letter-spacing, plus a comfortable gap
  const oiHeadingWidth = oiHeadingText.length * (6.8 + 0.5) + 28;
  const oiLegendStartX = padL + oiHeadingWidth;
  const legendDefs = [];
  if (presentOiSources.has('cftc_cot') || !useDailyOi)
    legendDefs.push({ mark: `<circle cx="0" cy="-3" r="2.3" fill="${CHART_THEME.oiCftc}" opacity="0.6"/>`, label: 'CFTC weekly' });
  if (oiSeasonalYears)
    legendDefs.push({
      mark: `<line x1="-2" y1="-3" x2="12" y2="-3" stroke="${CHART_THEME.oiSeasonal}" stroke-width="1.5" stroke-dasharray="5,3"/>`,
      label: `seasonal ${oiSeasonalYears} average`
    });
  let oiHeadingLegend = '';
  if (legendDefs.length > 1) {
    let lx = oiLegendStartX;
    oiHeadingLegend = legendDefs.map(d => {
      const g = `<g transform="translate(${lx.toFixed(1)},${(oiTop - 8).toFixed(1)})">${d.mark}<text x="7" y="0" font-size="9" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif">${d.label}</text></g>`;
      lx += 18 + d.label.length * 5.0;
      return g;
    }).join('');
  }

  const volumePaneSvg = showVolume ? `
        <text x="${padL}" y="${volumeTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" letter-spacing="0.05em">VOLUME (${volumeHeading})</text>
        ${volumeSvg}` : '';

  const panesSvg = showPanes ? `
        ${volumePaneSvg}
        ${taPaneHeadings}
        ${taPanesSvg}
        ${showOi ? `<text x="${padL}" y="${oiTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" letter-spacing="0.05em">${oiHeadingText}</text>
        ${oiHeadingLegend}
        ${oiSvg}` : ''}
        ${showCot ? `<text x="${padL}" y="${cotTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" letter-spacing="0.05em">COT · ${cotLabel.toUpperCase()}${cotHedgingActive ? ` · ${chartState.range.toUpperCase()} HEDGING PROGRAM` : ''}</text>
        ${cotSvg}` : ''}
        ${showSpread ? `<text x="${padL}" y="${spreadTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist, system-ui, sans-serif" letter-spacing="0.05em">CALENDAR SPREAD · FRONT - NEXT (&lt;0 = CONTANGO)</text>` : ''}
        ${spreadSvg}` : '';

  const chartKind = chartSource.mode === 'contract'
    ? `Single Contract ${esc(chartSource.displaySymbol || chartSource.label)}`
    : esc(chartSource.displayMode || 'Continuous Contract');
  const cftcPaneLabel = (showOi && showCot) ? 'CFTC OI &amp; COT' : (showOi ? 'CFTC OI' : (showCot ? 'CFTC COT' : null));
  const paneBits = [showVolume ? 'Volume' : null, cftcPaneLabel, showSpread ? 'Calendar Spread' : null].filter(Boolean);
  const sectionPanes = paneBits.length
    ? ` · with ${paneBits.join(', ')}${cotHedgingActive && showCot ? ' · COT Hedging Program' : ''}`
    : '';
  // Zoomed in, the count says how much of the range is on screen: "5 Years (126 of 1064 Candles)".
  const zoomedIn = wheelZoom && Number.isFinite(st.zoomStart) && Number.isFinite(st.zoomEnd) && n < fullBars.length;
  const candleCount = zoomedIn ? `${n} of ${fullBars.length} Candles` : `${n} Candles`;
  const sectionLabel = showPanes
    ? `${chartKind} · ${intervalLabel} · ${rangeLabel} (${candleCount})${sectionPanes}`
    : `${chartKind} · ${intervalLabel} · ${rangeLabel} (${candleCount})`;

  const hedgingLegend = cotHedgingActive
    ? `COT Hedging Program ${chartState.range.toUpperCase()} trailing: green above midpoint, red below &nbsp;·&nbsp;`
    : '';
  const volumeLegendText = showVolume && volumeLegend ? `${esc(volumeLegend)} · ` : '';
  const priceSourceLabel = chartSource.mode === 'contract'
    ? 'single contract'
    : 'continuous';
  const cotDotsLegend = showCot
    ? `COT net: <span class="legend-dot" style="background:#0ea679"></span> net long &nbsp;
       <span class="legend-dot" style="background:#e53e3e"></span> net short &nbsp;·&nbsp; ${hedgingLegend}`
    : '';
  const oiLegendText = showOi ? `${esc(oiLegend)} · ` : '';
  const cotReportText = showCot ? `COT: ${cotReport}${latestCotDate ? ' · report date ' + latestCotDate : ''} · ` : '';
  const priceLegendText = `Price: ${intervalLabel.toLowerCase()} (${esc(chartSource.symbol)}, yfinance ${priceSourceLabel})`;
  const legend = (showOi || showCot)
    ? `${cotDotsLegend}${volumeLegendText}${oiLegendText}${cotReportText}${priceLegendText}`
    : `${volumeLegendText}${priceLegendText} · candlesticks aggregated from settled daily EoD`;
  // Card-mode (content bot only, via ?card=): 3/3 period shading from
  // window.__threeThreeLog. Happens EXCLUSIVELY here — the normal dashboard stays clean.
  // (Entry and exit/drop markers were removed on purpose — only the band remains.)
  let cardShade = '';
  if (document.body.classList.contains('card-mode') && window.__threeThreeLog) {
    const periods = ((window.__threeThreeLog[chartState.key] || {}).periods) || [];
    const lastX = barXs[barXs.length - 1];
    periods.forEach(p => {
      const x1 = xForDate(p.start), x2 = p.end ? xForDate(p.end) : lastX;
      if (x1 != null && x2 != null && x2 > x1) {
        const col = p.direction === 'bullish' ? '#16a34a' : '#dc2626';
        cardShade += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${(x2 - x1).toFixed(1)}" height="${priceH}" fill="${col}" opacity="0.2"/>`;
      }
    });
  }

  const chartBg = `<rect x="0" y="0" width="${W}" height="${totalH}" fill="${CHART_THEME.bg}" rx="7"/>`;

  // Height in px = totalH (1:1 to the viewBox so nothing is distorted)
  body.innerHTML = (showControls ? renderChartControls() : '') + `
    <div class="chart-section-row">
      <div class="chart-section-label"><span class="legend-dot" style="background:${CHART_THEME.bull}"></span> ${sectionLabel}</div>
      <div class="chart-ohlc-readout" data-ohlc-readout></div>
    </div>
    <div class="chart-svg-wrap">
      <svg viewBox="0 0 ${W} ${totalH}" width="${W}" height="${totalH}" preserveAspectRatio="xMinYMin meet">
        ${chartBg}
        ${cardShade}
        ${roundLevels}
        ${rollLines}
        ${candles}${taOverlaySvg}${priceLine}${liveDot}
        ${rollLabels}
        ${panesSvg}
        ${dividerLines}${dividerLabels}
        ${xLabels}
      </svg>
    </div>
    <div style="font-size:0.625rem;color:var(--muted);margin-top:0.6rem;line-height:1.5">${legend}</div>`;
  bindChartCrosshair(body.querySelector('.chart-svg-wrap'), {
    W, totalH, padL, padR, padT, priceH, axisY,
    volumeTop, volumeH, oiTop, oiH, cotTop, cotH, spreadTop, spreadH,
    bars, barXs,
    pHi, pSpan, dec,
    drawingsActive: !!opts.drawings,
    volumePoints: crosshairVolumePoints,
    oiPoints: crosshairOiPoints,
    cotPoints: crosshairCotPoints,
    spreadPoints: crosshairSpreadPoints,
    taPanes: taCrosshairPanes
  });
  if (opts.drawings && typeof renderChartDrawings === 'function') {
    const wrapEl = body.querySelector('.chart-svg-wrap');
    const svgForDraw = wrapEl && wrapEl.querySelector('svg');
    // Continuous date<->x mapping (bars are evenly spaced by INDEX, not real time): interpolate
    // between the two surrounding bars, extrapolate (nearest gap's slope) outside the range. This
    // is what lets a line drawn on D1 land correctly on 3M or extend off-screen when scrolled.
    // OUTSIDE the bar range the slope cannot come from the two outermost bars' own gap: a
    // Fri->Mon gap is three days where a weekday gap is one, so the same future date would land
    // up to 3x further right depending purely on which weekday the series happens to end on, and
    // a drawing anchored past the last candle would jump from session to session. The MEAN gap
    // over a trailing window is stable and still tracks real calendar time. Bars are evenly
    // spaced by index, so the pixel step per bar is exactly `slot`.
    const EXTRAP_BARS = 60;
    const _meanGapMs = (i0, i1) => {
      const steps = i1 - i0;
      const g = steps > 0 ? (barTimes[i1] - barTimes[i0]) / steps : 0;
      return g > 0 ? g : 864e5;                                  // degenerate series -> one day per bar
    };
    const _mBars = barTimes.length;
    const _gapLeft = _mBars > 1 ? _meanGapMs(0, Math.min(_mBars - 1, EXTRAP_BARS)) : 864e5;
    const _gapRight = _mBars > 1 ? _meanGapMs(Math.max(0, _mBars - 1 - EXTRAP_BARS), _mBars - 1) : 864e5;
    const _xForTime = (t) => {
      const m = barTimes.length;
      if (!m) return padL;
      if (m === 1) return barXs[0];
      if (t <= barTimes[0]) return barXs[0] + (t - barTimes[0]) * (slot / _gapLeft);
      if (t >= barTimes[m - 1]) return barXs[m - 1] + (t - barTimes[m - 1]) * (slot / _gapRight);
      let lo = 0, hi = m - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (barTimes[mid] <= t) lo = mid; else hi = mid; }
      const f = (t - barTimes[lo]) / ((barTimes[hi] - barTimes[lo]) || 1);
      return barXs[lo] + f * (barXs[hi] - barXs[lo]);
    };
    const _timeForX = (x) => {
      const m = barXs.length;
      if (!m) return 0;
      if (m === 1) return barTimes[0];
      if (x <= barXs[0]) return barTimes[0] + (x - barXs[0]) * (_gapLeft / slot);
      if (x >= barXs[m - 1]) return barTimes[m - 1] + (x - barXs[m - 1]) * (_gapRight / slot);
      let lo = 0, hi = m - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (barXs[mid] <= x) lo = mid; else hi = mid; }
      const f = (x - barXs[lo]) / ((barXs[hi] - barXs[lo]) || 1);
      return barTimes[lo] + f * (barTimes[hi] - barTimes[lo]);
    };
    const _fullBarTimes = fullBars.map(b => new Date(b.date).getTime());
    const drawCoord = {
      padL, padR, padT, priceH, W, pHi, pSpan, dec,
      plotLeft: padL, plotRight: W - padR, plotTop: padT, plotBottom: padT + priceH,
      bars, barXs, barTimes,
      yForPrice: (p) => padT + ((pHi - p) / pSpan) * priceH,
      priceFromY: (y) => { const yc = Math.max(padT, Math.min(padT + priceH, y)); return pHi - ((yc - padT) / priceH) * pSpan; },
      xForTime: _xForTime, timeForX: _timeForX,
      // Anchors snap to a real candle inside the series. Past the newest bar there IS no candle
      // to snap to, so the extrapolated time is kept verbatim -- that is what lets a drawing be
      // anchored in the future at all (the right margin above is the room to do it in). Without
      // this every x right of the last bar collapsed onto that bar's date.
      snapDate: (x) => {
        const t = _timeForX(x);
        if (t > barTimes[barTimes.length - 1]) return new Date(t).toISOString();
        const b = bars[nearestBarIndexByTime(t)];
        return b ? b.date : null;
      },
      snapDateAny: (t) => {
        if (!_fullBarTimes.length) return null;
        if (t > _fullBarTimes[_fullBarTimes.length - 1]) return new Date(t).toISOString();   // future: nothing to snap to
        let best = 0, d = Math.abs(_fullBarTimes[0] - t);
        for (let i = 1; i < _fullBarTimes.length; i++) { const e = Math.abs(_fullBarTimes[i] - t); if (e < d) { d = e; best = i; } }
        return fullBars[best].date;
      },
    };
    if (svgForDraw) renderChartDrawings(svgForDraw, drawCoord);
    if (typeof bindChartDrawingInteractions === 'function' && wrapEl)
      bindChartDrawingInteractions(wrapEl, drawCoord, opts.rerender || (() => loadChart(cfg, opts)));
  }
  if (wheelZoom) bindChartWheelZoom(body, { st, cfg, opts, fullBars, W, plotLeftX: padL + edgePad, plotW });
  if (showControls) bindChartControls(cfg);
}

// Mouse-wheel zoom + double-click reset for the Charts tab. The zoom is anchored either at the
// right edge (st.zoomAnchorRight — newest bar stays fixed, the chart doesn't shift; the default)
// or at the bar under the cursor. Mutates st.[zoomStart,zoomEnd] (captured at render time, so it
// targets bigChartState even after the global swap is restored) and repaints via opts.rerender.
// preventDefault stops the page from scrolling under the chart.
function bindChartWheelZoom(body, ctx) {
  const { st, cfg, opts, fullBars, W, plotLeftX, plotW } = ctx;
  const svgEl = body.querySelector('.chart-svg-wrap svg');
  if (!svgEl) return;
  const rerender = opts.rerender || (() => loadChart(cfg, opts));
  const MIN_SPAN = 11;          // floor ≈ 12 candles
  const STEP = 0.82;            // span multiplier per wheel notch

  svgEl.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const N = fullBars.length;
    if (N < 4) return;
    const curS = Number.isFinite(st.zoomStart) ? st.zoomStart : 0;
    const curE = Number.isFinite(st.zoomEnd) ? st.zoomEnd : N - 1;
    const span = curE - curS;
    // Anchor point that stays fixed while zooming: the right edge (chart doesn't shift) when
    // st.zoomAnchorRight is on, else the bar under the cursor. f = its fraction across the plot.
    let f, anchor;
    if (st.zoomAnchorRight) {
      f = 1; anchor = curE;
    } else {
      const rect = svgEl.getBoundingClientRect();
      if (!rect.width) return;
      const svgX = (ev.clientX - rect.left) * (W / rect.width);
      f = Math.max(0, Math.min(1, (svgX - plotLeftX) / plotW));       // cursor position across the plot, 0..1
      anchor = curS + f * span;                                       // full-set index under the cursor
    }
    let newSpan = Math.round(span * (ev.deltaY < 0 ? STEP : 1 / STEP));
    newSpan = Math.max(MIN_SPAN, Math.min(N - 1, newSpan));
    let newS = Math.round(anchor - f * newSpan);
    newS = Math.max(0, Math.min(N - 1 - newSpan, newS));
    const newE = newS + newSpan;
    if (newS === curS && newE === curE) return;                       // already at a limit
    st.zoomStart = newS; st.zoomEnd = newE;
    rerender();
  }, { passive: false });

  svgEl.addEventListener('dblclick', (ev) => {
    if (!Number.isFinite(st.zoomStart) && !Number.isFinite(st.zoomEnd)) return;
    ev.preventDefault();
    st.zoomStart = null; st.zoomEnd = null;
    rerender();
  });
}

// Render toggle buttons
function renderChartControls() {
  const iv = chartState.interval, rg = chartState.range;
  const hedgeSupported = rg === '6m' || rg === '12m';
  const ivBtn = (val,label) => `<button class="ctrl-btn ${iv===val?'active':''}" data-iv="${val}">${label}</button>`;
  const rgBtn = (val,label) => `<button class="ctrl-btn ${rg===val?'active':''}" data-rg="${val}">${label}</button>`;
  const chartModeBtn = (val,label) => `<button class="ctrl-btn ${chartState.chartMode===val?'active':''}" data-chart-mode="${val}">${esc(label)}</button>`;
  const selectedContractBtn = chartState.contractSymbol
    ? chartModeBtn('contract', chartState.contractLabel || chartState.contractSymbol)
    : '';
  return `<div class="chart-controls">
    <div style="display:flex;align-items:center;gap:0.4rem">
      <span class="ctrl-label">Chart</span>
      <div class="ctrl-group">${chartModeBtn('continuous','Continuous')}${selectedContractBtn}</div>
    </div>
    <div style="display:flex;align-items:center;gap:0.4rem">
      <span class="ctrl-label">Interval</span>
      <div class="ctrl-group">${ivBtn('daily','Daily')}${ivBtn('weekly','Weekly')}</div>
    </div>
    <div style="display:flex;align-items:center;gap:0.4rem">
      <span class="ctrl-label">Range</span>
      <div class="ctrl-group">${rgBtn('6m','6M')}${rgBtn('12m','12M')}${rgBtn('5y','5Y')}</div>
    </div>
    <div class="chart-filter-group">
      <label class="cot-filter-box" title="Show or hide the volume pane">
        <input type="checkbox" data-show-volume ${chartState.showVolume ? 'checked' : ''}>
        <span>Volume</span>
      </label>
      <label class="cot-filter-box" title="Show or hide the calendar-spread pane (front minus next contract; below 0 = contango)">
        <input type="checkbox" data-show-spread ${chartState.showSpread ? 'checked' : ''}>
        <span>Spread</span>
      </label>
      <label class="cot-filter-box" title="Overlay the 5-year seasonal average of Open Interest on the OI pane (re-based each January)">
        <input type="checkbox" data-show-oi-seasonal ${chartState.showOiSeasonal ? 'checked' : ''}>
        <span>OI Seasonal</span>
      </label>
      <label class="cot-filter-box ${hedgeSupported ? '' : 'disabled'}" title="Only 6M and 12M">
        <input type="checkbox" data-cot-hedging ${chartState.cotHedging && hedgeSupported ? 'checked' : ''} ${hedgeSupported ? '' : 'disabled'}>
        <span>COT Hedging Program</span>
      </label>
    </div>
  </div>`;
}

// Bind event handlers to toggle buttons
function bindChartControls(cfg) {
  document.querySelectorAll('.ctrl-btn[data-chart-mode]').forEach(b => {
    b.onclick = () => {
      if (b.dataset.chartMode === 'continuous') {
        chartState.chartMode = 'continuous';
        loadChart(cfg);
        renderTable(cfg);
      } else {
        activateSelectedContract(cfg);
      }
    };
  });
  document.querySelectorAll('.ctrl-btn[data-iv]').forEach(b => {
    b.onclick = () => { chartState.interval = b.dataset.iv; loadChart(cfg); };
  });
  document.querySelectorAll('.ctrl-btn[data-rg]').forEach(b => {
    b.onclick = () => {
      chartState.range = b.dataset.rg;
      if (chartState.range === '5y') {
        chartState.cotHedging = false;
        // A single contract spans only months, so its 5Y view is identical to 12M
        // (e.g. a front bond contract has ~6 months of bars). The real 5-year history
        // lives on the native continuous series — switch to it so 5Y actually shows
        // ~5 years. contractSymbol is kept so the single-contract button stays visible
        // to switch back.
        if (chartState.chartMode === 'contract') {
          chartState.chartMode = 'continuous';
          renderTable(cfg);
        }
      }
      loadChart(cfg);
    };
  });
  document.querySelectorAll('input[data-cot-hedging]').forEach(b => {
    b.onchange = () => { chartState.cotHedging = b.checked; loadChart(cfg); };
  });
  document.querySelectorAll('input[data-show-volume]').forEach(b => {
    b.onchange = () => { chartState.showVolume = b.checked; loadChart(cfg); };
  });
  document.querySelectorAll('input[data-show-spread]').forEach(b => {
    b.onchange = () => { chartState.showSpread = b.checked; loadChart(cfg); };
  });
  document.querySelectorAll('input[data-show-oi-seasonal]').forEach(b => {
    b.onchange = () => { chartState.showOiSeasonal = b.checked; loadChart(cfg); };
  });
}


