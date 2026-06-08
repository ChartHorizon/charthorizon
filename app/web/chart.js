const CHART_EXPORT_CSS = `
  text { font-family: 'Sora', system-ui, sans-serif; }
`;
const CHART_EXPORT_WIDTH = 1200; // ~on-screen display size; height stays proportional to the chart.
const CHART_EXPORT_TITLE_H = 70; // header band: brand rows + a metadata row (data-as-of / export time).

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
  const dark = typeof currentTheme === 'function' && currentTheme() === 'dark';
  return dark
    ? { bg: '#0e1822', cat: '#f9b03a', name: '#f3f6fa', sym: '#8493a6', brand: '#f97316', meta: '#8493a6', sep: '#243240', strong: '#f3f6fa' }
    : { bg: '#ffffff', cat: '#1a56db', name: '#0f1923', sym: '#8896a8', brand: '#f97316', meta: '#8896a8', sep: '#e5e9f0', strong: '#0f1923' };
}

// Latest data date represented in a chart's history -> "Jun 01, 2026" (UTC), or null when unknown.
function exportAsOfDate(cfg) {
  if (!cfg) return null;
  const hist = (getContinuousContract(cfg).history) || [];
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
  // Card-Mode: synthetisches FX-Paar-Chart (eigener Header, kein Markt-cfg dahinter).
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
    asOf: exportAsOfDate(getCurrentCfg()),
    // Card-Mode: nur die Telegram-/Social-Karten -> Risk-Disclaimer + Seasonal-Runway
    // im Export-Footer-Band (das normale In-App-Export bleibt clean).
    cardMode: document.body.classList.contains('card-mode'),
    runway: (document.body.classList.contains('card-mode') && window.__fourFourLog
             && window.__fourFourLog[currentKey] && window.__fourFourLog[currentKey].runway) || null,
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
    <text x="${pad}" y="42" font-size="20" font-family="'Instrument Serif', Georgia, serif" fill="${pal.name}">${escapeXml(ctx.name)}</text>
    <text x="${w - pad}" y="20" font-size="10" fill="${pal.sym}" text-anchor="end">${escapeXml(ctx.symbol)}</text>
    <text x="${w - pad}" y="42" font-size="11" font-weight="700" fill="${pal.brand}" text-anchor="end">ChartHorizon</text>
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
  const cssOpacity = parseNum(window.getComputedStyle(el).opacity, 1);
  const attrOpacity = el.hasAttribute('opacity') ? parseNum(el.getAttribute('opacity'), 1) : 1;
  return cssOpacity * attrOpacity;
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
  const family = el.getAttribute('font-family') || css.fontFamily || 'Sora, system-ui, sans-serif';
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
  if (cls.includes('chart-crosshair-layer') || cls.includes('chart-hit-zone')) return;

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
  ctx.font = '600 11px Sora, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(exportCtx.category, pad, 20);
  ctx.fillStyle = pal.name;
  ctx.font = '20px Georgia, serif';
  ctx.fillText(exportCtx.name, pad, 42);
  ctx.textAlign = 'right';
  ctx.fillStyle = pal.sym;
  ctx.font = '10px Sora, system-ui, sans-serif';
  ctx.fillText(exportCtx.symbol, w - pad, 20);
  ctx.fillStyle = pal.brand;
  ctx.font = '700 11px Sora, system-ui, sans-serif';
  ctx.fillText('ChartHorizon', w - pad, 42);
  // Metadata row: data "as of" date (left) and export timestamp (right).
  ctx.font = '10px Sora, system-ui, sans-serif';
  ctx.fillStyle = pal.meta;
  ctx.textAlign = 'left';
  if (exportCtx.asOf) ctx.fillText(`Data as of ${exportCtx.asOf}`, pad, 60);
  ctx.textAlign = 'right';
  ctx.fillText(`Exported ${exportNowStamp()}`, w - pad, 60);
}

// Footer-Band (nur Card-Mode): optionale Seasonal-Runway-Zeile (das einzige vorhersehbare
// Signal) + immer ein Risk-Disclaimer. Beginnt mit einem dünnen Trenner unter dem Chart.
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
    ctx.font = '600 11px Sora, system-ui, sans-serif';
    const tail = exportCtx.runway.note || 'before dropping to 3/4';
    ctx.fillText(`Seasonal window supports this setup ~${exportCtx.runway.days} more days (until ${until}) ${tail}`, pad, cursor + 17);
    cursor += 21;
  }
  ctx.fillStyle = pal.meta;
  ctx.font = '9px Sora, system-ui, sans-serif';
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
  // Card-Mode-Footer: Disclaimer immer, Runway-Zeile zusätzlich falls vorhanden.
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
function chartSvgToPngBlob(targetWidth = CHART_EXPORT_WIDTH, kind = null) {
  return new Promise((resolve, reject) => {
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
  });
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
      alert('PNG export failed, so ChartHorizon downloaded an SVG instead.');
    } catch (_) {
      alert('Chart export failed: ' + e.message);
    }
  }
}

async function shareChart(kind = 'overview') {
  let blob;
  try {
    blob = await chartSvgToPngBlob(CHART_EXPORT_WIDTH, kind);
  } catch (e) {
    console.error('Share export failed:', e);
    alert('Chart export failed: ' + e.message);
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

// Share the current chart on X (Twitter). X's web intent cannot attach an image,
// so we copy the chart PNG to the clipboard first (while this tab still has focus)
// and open the compose window with prefilled text — the user then pastes the image
// into the post with Cmd/Ctrl+V.
async function shareToX(kind = 'overview') {
  const ctx = getChartExportContext(kind);
  const text = `${ctx.name || 'Chart'} · ChartHorizon`;
  const intentUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

  let copied = false;
  try {
    const blob = await chartSvgToPngBlob(CHART_EXPORT_WIDTH, kind);
    if (navigator.clipboard && window.ClipboardItem) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      copied = true;
    }
  } catch (e) {
    // Clipboard may be blocked/unavailable — still open the compose window.
  }

  const win = window.open(intentUrl, '_blank');
  if (!win) {
    setBtnStatus(ctx.xButtonId, ctx.xLabelId, 'Allow popups', 'X', 3000);
    return;
  }
  setBtnStatus(ctx.xButtonId, ctx.xLabelId, copied ? 'Copied · paste in X' : 'Opened X', 'X', 3000);
}

// ── Build sidebars grouped by category from the lightweight INDEX ──

let chartState = {
  key: null,
  interval: 'daily',
  range: '12m',
  cotHedging: false,
  showVolume: false,  // default off: yfinance volume still has too many API-side gaps/errors
  showSpread: false,  // calendar-spread pane: advanced metric, off by default
  chartMode: 'continuous',
  contractSymbol: null,
  contractLabel: null
};

const RANGE_DAYS = { '6m': 182, '12m': 365, '5y': 1825 };
const CONTRACT_HISTORY_PERIOD = '5y';

// Aggregate daily bars to weekly bars.
function aggregateWeekly(bars) {
  if (!bars.length) return [];
  const weeks = {};
  for (const b of bars) {
    const d = new Date(b.date);
    // ISO week as key (year + week number)
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    const key = d.getFullYear() + '-W' + week;
    if (!weeks[key]) weeks[key] = { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 };
    else {
      const w = weeks[key];
      w.high = Math.max(w.high, b.high);
      w.low = Math.min(w.low, b.low);
      w.close = b.close;
      w.date = b.date;
      w.volume += (b.volume || 0);
    }
  }
  return Object.values(weeks);
}

function aggregateWeeklyVolume(rows) {
  if (!rows.length) return [];
  const weeks = {};
  for (const row of rows) {
    const d = new Date(row.date);
    const onejan = new Date(d.getFullYear(), 0, 1);
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    const key = d.getFullYear() + '-W' + week;
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

function chartDisplayMode(source) {
  if (!source || source.format === 'continuous_front_month') return 'Continuous Contract';
  if (source.format === 'dxy_index_proxy') return 'DXY Index Proxy';
  return source.label || 'Price Chart';
}

function getSelectedContract(cfg) {
  if (!chartState.contractSymbol || !cfg.contracts) return null;
  return cfg.contracts.find(c => c.yf_symbol === chartState.contractSymbol) || null;
}

function getActiveChartSource(cfg) {
  const continuous = getContinuousContract(cfg);
  const selected = getSelectedContract(cfg);
  if (chartState.chartMode === 'contract' && selected) {
    return {
      mode: 'contract',
      label: selected.delivery_month_label || selected.label || selected.contract_symbol || selected.yf_symbol,
      symbol: selected.yf_symbol || selected.contract_symbol,
      displaySymbol: selected.contract_symbol || selected.yf_symbol,
      history: selected.chart_history || selected.history || [],
      contract: selected
    };
  }
  return {
    mode: 'continuous',
    label: continuous.label || 'Continuous Contract',
    symbol: continuous.yf_symbol || continuous.tv_symbol || 'Continuous',
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
  if (chartState.interval === 'weekly') bars = aggregateWeekly(bars);
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
    const chgCol = chg > 0 ? 'var(--up)' : chg < 0 ? 'var(--down)' : 'var(--muted)';
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
  function update(evt) {
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

    const bar = cfg.bars[nearestBarByX(x)];
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

    setLabel(dateLabel, (bar.date || '').slice(2), x, cfg.axisY + 12, 'center');
    if (vol) {
      showPoint(volumeDot, vol, CHART_THEME.volume);
      setLabel(volumeLabel, `VOL ${compact(vol.value)}`, cfg.W - 4, clamp(vol.y, cfg.volumeTop + 9, cfg.volumeTop + cfg.volumeH - 9), 'right');
    } else {
      showPoint(volumeDot, null);
      hideEl(volumeLabel);
    }
    if (oi) {
      showPoint(oiDot, oi, CHART_THEME.oi);
      setLabel(oiLabel, `OI ${compact(oi.value)}`, cfg.W - 4, clamp(oi.y, cfg.oiTop + 9, cfg.oiTop + cfg.oiH - 9), 'right');
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
      showPoint(spreadDot, spread, CHART_THEME.spread);
      setLabel(spreadLabel, `SPR ${Number(spread.value).toFixed(cfg.dec)}`, cfg.W - 4, clamp(spread.y, cfg.spreadTop + 9, cfg.spreadTop + cfg.spreadH - 9), 'right');
    } else {
      showPoint(spreadDot, null);
      hideEl(spreadLabel);
    }
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

// ── Multi-pane candlestick chart: price + OI + COT ──
function loadChart(cfg) {
  const body = document.getElementById('chartBody');
  const chartSource = getActiveChartSource(cfg);
  const fullHist = chartSource.history || [];
  const symEl = document.getElementById('chartSym');
  if (symEl) {
    const modeLabel = chartSource.mode === 'contract' ? 'Single Contract' : chartSource.displayMode;
    symEl.textContent = `${chartSource.displaySymbol || chartSource.symbol} · ${modeLabel} · ${cfg.unit} · ${cfg.currency}`;
  }

  if (!fullHist.length) {
    const emptyMsg = chartSource.mode === 'contract'
      ? `No chart history available for ${esc(chartSource.displaySymbol || chartSource.label)}.`
      : 'No volume-led continuous history available. yfinance returned no chart data.';
    body.innerHTML = renderChartControls() +
      `<div class="chart-empty">${emptyMsg}</div>`;
    bindChartControls(cfg);
    return;
  }

  const bars = getChartBars(cfg);
  const cot  = normalizeCotSeries(cfg.cot_series || []);
  const isWeekly = chartState.interval === 'weekly';

  // Responsive: derive width from the real content area.
  // body.clientWidth includes padding; the SVG is inside the content box.
  // If both are not aligned 1:1, the browser scales slightly and lines look blurry.
  const bodyRect = body.getBoundingClientRect();
  const bodyStyle = window.getComputedStyle(body);
  const padX = (Number.parseFloat(bodyStyle.paddingLeft) || 0) + (Number.parseFloat(bodyStyle.paddingRight) || 0);
  const wrapW = Math.max(320, (bodyRect.width || body.clientWidth || 900) - padX);
  const W = Math.max(320, Math.floor(wrapW));
  const padL = 52, padR = 56, padT = 8;
  const priceH = Math.round(W * 0.38);   // keep price dominant; added panes grow the chart downward
  const volumeH = 62, oiH = 68, cotH = 84, spreadH = 64, gap = 22;
  const innerW = W - padL - padR;
  const edgePad = Math.max(24, Math.min(56, Math.round(innerW * 0.05)));
  const plotW = Math.max(120, innerW - edgePad * 2);
  const n = bars.length;

  if (!n) {
    body.innerHTML = renderChartControls() + '<div class="chart-empty">No data for the selected range.</div>';
    bindChartControls(cfg);
    return;
  }

  // Candle geometry
  const slot = plotW / n;
  const candleW = Math.max(1, Math.min(12, slot * 0.7));
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

  // Price scale. Filter to finite values first: a single null/undefined low/high would
  // make Math.min/Math.max NaN, poisoning the whole domain so the SVG renders nothing.
  const lows = bars.map(d => d.low).filter(Number.isFinite);
  const highs = bars.map(d => d.high).filter(Number.isFinite);
  const pMin = lows.length ? Math.min(...lows) : 0;
  const pMax = highs.length ? Math.max(...highs) : 1;
  const pRng = (pMax - pMin) || 1;
  const pad = pRng * 0.05;
  const pLo = pMin - pad, pHi = pMax + pad, pSpan = pHi - pLo;
  const pY = v => padT + (1 - (v - pLo) / pSpan) * priceH;

  const dec = cfg.tick_decimals;

  // Candlesticks
  let candles = '';
  bars.forEach((d, i) => {
    const x = xAt(i);
    const up = d.close >= d.open;
    const col = up ? CHART_THEME.bull : CHART_THEME.bear;
    const wickCol = up ? CHART_THEME.bullWick : CHART_THEME.bearWick;
    const yH = pY(d.high).toFixed(1), yL = pY(d.low).toFixed(1);
    const yO = pY(d.open), yC = pY(d.close);
    const bodyTop = Math.min(yO, yC), bodyH = Math.max(1, Math.abs(yC - yO));
    candles += `<line x1="${x.toFixed(1)}" y1="${yH}" x2="${x.toFixed(1)}" y2="${yL}" stroke="${wickCol}" stroke-width="1"/>`;
    candles += `<rect x="${(x - candleW/2).toFixed(1)}" y="${bodyTop.toFixed(1)}" width="${candleW.toFixed(1)}" height="${bodyH.toFixed(1)}" fill="${col}" stroke="${col}" stroke-width="0.5"/>`;
  });

  // ── Roll-Marker: geplante Frontmonat-Verfallstermine (Boersenkalender) ──
  // Deterministisch aus contract_months + expiry_rule (generatorseitig in roll_dates).
  // Nur On-Screen + nativer Continuous: NICHT in Card-Mode-Exports und nicht bei
  // Einzelkontrakt-Ansicht. Marker = geplanter Verfall und kann ein paar Tage neben
  // Yahoos tatsaechlichem Roll liegen (dessen Punkt ist nicht bekannt). Labels werden
  // bei dichten (monatlichen) Zyklen ausgeduennt, die Linie bleibt.
  let rollLines = '', rollLabels = '';
  if (!document.body.classList.contains('card-mode')
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
        rollLabels += `<text x="${(x + 2).toFixed(1)}" y="${(padT + priceH - 4).toFixed(1)}" font-size="9" font-weight="600" fill="#475569" font-family="Sora">${r.code}</text>`;
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
  let roundLevels = '';
  for (let lv = firstLevel; lv <= pHi; lv += levelStep) {
    // Smooth floating point noise
    lv = Math.round(lv / levelStep) * levelStep;
    if (lv < pLo || lv > pHi) continue;
    const y = pY(lv).toFixed(1);
    roundLevels += `<line x1="${padL}" y1="${y}" x2="${W-padR}" y2="${y}" stroke="${CHART_THEME.axis}" stroke-width="1" stroke-dasharray="2,4" opacity="0.78"/>`;
    roundLevels += `<text x="${W-padR+5}" y="${(+y+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${lv.toFixed(dec)}</text>`;
  }

  // ── OI and COT panes in daily and weekly views (CFTC data is weekly) ──
  const firstDate = new Date(bars[0].date), lastDate = new Date(bars[n-1].date);
  const inVisibleRange = d => {
    const dt = new Date(d.date);
    return dt >= firstDate && dt <= lastDate;
  };
  function evenPaneX(index, count, inset = 0) {
    if (count <= 1) return padL + edgePad + plotW / 2;
    const usableW = Math.max(0, plotW - inset * 2);
    return padL + edgePad + inset + usableW * index / (count - 1);
  }

  const showVolume = chartState.showVolume;
  const showSpread = chartState.showSpread;
  let volumeSvg = '', oiSvg = '', cotSvg = '', spreadSvg = '', volumeTop = 0, oiTop = 0, cotTop = 0, spreadTop = 0;
  let presentOiSources = new Set();
  const panesH = (showVolume ? volumeH + gap : 0) + (oiH + gap) + (cotH + gap) + (showSpread ? spreadH + gap : 0);
  const visCot = cot.filter(inVisibleRange);
  const cotLabel = (cot[0] && (cot[0].cot_label || cot[0].cotLabel)) || 'Commercial Net';
  const cotReport = (cot[0] && cot[0].cot_report) || 'CFTC';
  const latestCotDate = cot.length ? cot[cot.length - 1].date : null;
  const cotValue = d => (d.cot_net !== undefined && d.cot_net !== null) ? d.cot_net : d.comm_net;
  const cotHedgingActive = chartState.cotHedging && (chartState.range === '6m' || chartState.range === '12m');
  function trailingCotWindow(series, range) {
    if (!series.length || (range !== '6m' && range !== '12m')) return [];
    const last = new Date(series[series.length - 1].date);
    const days = RANGE_DAYS[range] || 365;
    const cutoff = new Date(last);
    cutoff.setDate(cutoff.getDate() - days);
    return series.filter(d => {
      const dt = new Date(d.date);
      return dt >= cutoff && dt <= last;
    });
  }
  const hedgeCot = cotHedgingActive ? trailingCotWindow(cot, chartState.range) : [];
  const cotBars = (cotHedgingActive ? hedgeCot : visCot).filter(inVisibleRange);
  let crosshairVolumePoints = [], crosshairOiPoints = [], crosshairCotPoints = [], crosshairSpreadPoints = [];

  volumeTop = padT + priceH + gap;
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
        <text x="${W-padR+5}" y="${(volumeTop+8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${(volumeMax/1000).toFixed(0)}K</text>`
        : `<text x="${padL}" y="${volumeTop+volumeH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora" font-style="italic">No volume data in this range</text>`;
    } else {
      volumeSvg = `<text x="${padL}" y="${volumeTop+volumeH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora" font-style="italic">No volume data in this range</text>`;
    }
  }

  const dailyOi = normalizeOiSeries(cfg.daily_oi_series || []);
  const visDailyOi = dailyOi.filter(inVisibleRange);
  const useDailyOi = chartState.interval === 'daily' && visDailyOi.length > 0;
  const oiPoints = useDailyOi ? visDailyOi : visCot.filter(d => d.oi != null);
  const latestOiPoint = oiPoints.length ? oiPoints[oiPoints.length - 1] : null;
  const latestOiDate = latestOiPoint?.date || latestCotDate;
  const oiHeading = 'CFTC WEEKLY TOTAL';
  const oiLegend = `Open Interest: CFTC weekly total${latestOiDate ? ' · report date ' + latestOiDate : ''}`;

  // OI pane
  oiTop = showVolume ? volumeTop + volumeH + gap : padT + priceH + gap;
  if (oiPoints.length) {
    const oiVals = oiPoints.map(d => d.oi);
    const oiMin = Math.min(...oiVals), oiMax = Math.max(...oiVals);
    const oiRng = oiMax - oiMin;
    const oiY = v => oiTop + (oiRng ? (1 - (v - oiMin) / oiRng) * oiH : oiH / 2);
    let oiPath = '';
    crosshairOiPoints = oiPoints.map((d, i) => ({
      date: d.date,
      x: xForDate(d.date),
      y: oiY(d.oi),
      value: d.oi
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

    oiSvg = `
      <line x1="${padL}" y1="${oiTop}" x2="${W-padR}" y2="${oiTop}" stroke="${CHART_THEME.grid}"/>
      <line x1="${padL}" y1="${oiTop+oiH}" x2="${W-padR}" y2="${oiTop+oiH}" stroke="${CHART_THEME.grid}"/>
      ${oiPoints.length > 1 ? `<path d="${oiPath}" fill="none" stroke="${CHART_THEME.oi}" stroke-width="1.5" opacity="0.8"/>` : ''}
      ${oiDots}
      <text x="${W-padR+5}" y="${(oiTop+5).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${(oiMax/1000).toFixed(0)}K</text>
      <text x="${W-padR+5}" y="${(oiTop+oiH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${(oiMin/1000).toFixed(0)}K</text>`;
  } else {
    oiSvg = `<text x="${padL}" y="${oiTop+oiH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora" font-style="italic">No Open Interest data in this range</text>`;
  }

  // COT pane (report-dependent net position)
  cotTop = oiTop + oiH + gap;
  if (cotBars.length) {
    const thresholdSource = cotHedgingActive ? hedgeCot : cotBars;
    const cotVals = thresholdSource.map(cotValue).filter(v => v !== null && v !== undefined);
    const cotMin = cotVals.length ? Math.min(...cotVals) : -1;
    const cotMax = cotVals.length ? Math.max(...cotVals) : 1;
    const cotThreshold = (cotMin + cotMax) / 2;
    const cotAbs = cotVals.length ? (Math.max(...cotVals.map(Math.abs)) || 1) : 1;
    const cotPad = Math.max(1, (cotMax - cotMin) * 0.08);
    const cotLo = cotHedgingActive ? cotMin - cotPad : -cotAbs;
    const cotHi = cotHedgingActive ? cotMax + cotPad : cotAbs;
    const cotSpan = (cotHi - cotLo) || 1;
    const cotY = v => cotTop + (1 - (v - cotLo) / cotSpan) * cotH;
    const cotMid = cotHedgingActive ? cotY(cotThreshold) : cotY(0);
    const cotStep = cotBars.length > 1 ? plotW / (cotBars.length - 1) : plotW;
    const barW = Math.max(1, Math.min(14, cotStep * 0.55));
    let bars2 = '';
    cotBars.forEach((d, i) => {
      const net = cotValue(d);
      if (net === null || net === undefined) return;
      const x = evenPaneX(i, cotBars.length, barW / 2), y = cotY(net), h = Math.abs(y - cotMid);
      const col = cotHedgingActive
        ? (net >= cotThreshold ? '#0ea679' : '#e53e3e')
        : (net >= 0 ? '#0ea679' : '#e53e3e');
      crosshairCotPoints.push({ date: d.date, x, y, value: net, color: col });
      bars2 += `<rect x="${(x-barW/2).toFixed(1)}" y="${Math.min(y,cotMid).toFixed(1)}" width="${barW.toFixed(1)}" height="${Math.max(1,h).toFixed(1)}" fill="${col}" opacity="0.7" rx="1"/>`;
    });
    const upperLabel = cotHedgingActive ? cotMax : cotAbs;
    const lowerLabel = cotHedgingActive ? cotMin : -cotAbs;
    const midLabel = cotHedgingActive ? `<text x="${W-padR+5}" y="${(cotMid+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.bull}" font-family="Sora">${(cotThreshold/1000).toFixed(0)}K</text>` : '';
    cotSvg = `
      <line x1="${padL}" y1="${cotMid.toFixed(1)}" x2="${W-padR}" y2="${cotMid.toFixed(1)}" stroke="${cotHedgingActive ? CHART_THEME.bull : CHART_THEME.axis}" stroke-dasharray="4,3"/>
      ${bars2}
      <text x="${W-padR+5}" y="${(cotTop+8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${(upperLabel/1000).toFixed(0)}K</text>
      ${midLabel}
      <text x="${W-padR+5}" y="${(cotTop+cotH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${(lowerLabel/1000).toFixed(0)}K</text>`;
  } else {
    cotSvg = `<text x="${padL}" y="${cotTop+cotH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora" font-style="italic">No CFTC COT data in this range</text>`;
  }

  // Calendar-spread pane (front minus next contract; negative = contango).
  // Optional, off by default. Daily only — the spread is built from daily EoD
  // contracts; in weekly view we still plot the underlying daily points.
  if (showSpread) {
    spreadTop = cotTop + cotH + gap;
    const spreadSeries = normalizeSpreadSeries(cfg.calendar_spread_series || []).filter(inVisibleRange);
    if (spreadSeries.length) {
      const spVals = spreadSeries.map(d => d.spread);
      const dataLo = Math.min(...spVals), dataHi = Math.max(...spVals);
      // Eng um die ECHTEN Werte skalieren (0 NICHT erzwingen), mit Polster, damit sich die
      // Linie über die ganze Box entfaltet und nicht an die Rahmenlinien stößt (vgl. CAD-Bug).
      // Würde man 0 erzwingen, klebt ein durchweg positiver/negativer Spread (z.B. USD-Index
      // ~+0,26) als flaches Band am Rand, statt das Fenster zu nutzen.
      const pad = ((dataHi - dataLo) || Math.abs(dataHi) || 1) * 0.12;
      const spLo = dataLo - pad, spHi = dataHi + pad;
      const spRng = (spHi - spLo) || 1;
      const spreadY = v => spreadTop + (1 - (v - spLo) / spRng) * spreadH;
      // 0-Linie als Orientierung IMMER zeigen: an ihrer echten Position, wenn 0 im
      // Fenster liegt; sonst an den näheren Rand geheftet (Linie über 0 = Premium /
      // Backwardation, darunter = Contango). Bei geheftetem 0 ist der Abstand bewusst
      // NICHT maßstabsgetreu — die Linie soll dynamisch das Fenster füllen.
      const zeroYraw = spreadY(0);
      const zeroY = Math.max(spreadTop, Math.min(spreadTop + spreadH, zeroYraw));
      const zeroPinned = zeroYraw !== zeroY;
      crosshairSpreadPoints = spreadSeries.map(d => ({
        date: d.date, x: xForDate(d.date), y: spreadY(d.spread), value: d.spread
      })).sort((a, b) => a.x - b.x);
      // Break the line across gaps (>7 days) so missing days aren't bridged.
      let spPath = '', prevTime = null;
      crosshairSpreadPoints.forEach((p, i) => {
        const t = new Date(p.date).getTime();
        const brk = prevTime !== null && (t - prevTime) > 7 * 864e5;
        spPath += (i === 0 || brk ? 'M' : 'L') + p.x.toFixed(1) + ',' + p.y.toFixed(1) + ' ';
        prevTime = t;
      });
      const spDots = crosshairSpreadPoints.map(p =>
        `<circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="1.6" fill="${CHART_THEME.spread}" opacity="0.5"/>`).join('');
      spreadSvg = `
        <line x1="${padL}" y1="${spreadTop}" x2="${W-padR}" y2="${spreadTop}" stroke="${CHART_THEME.grid}"/>
        <line x1="${padL}" y1="${spreadTop+spreadH}" x2="${W-padR}" y2="${spreadTop+spreadH}" stroke="${CHART_THEME.grid}"/>
        <line x1="${padL}" y1="${zeroY.toFixed(1)}" x2="${W-padR}" y2="${zeroY.toFixed(1)}" stroke="${CHART_THEME.axis}" stroke-dasharray="4,3"${zeroPinned ? ' opacity="0.65"' : ''}/>
        <text x="${W-padR+5}" y="${(zeroY+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">0</text>
        ${spreadSeries.length > 1 ? `<path d="${spPath}" fill="none" stroke="${CHART_THEME.spread}" stroke-width="1.5" opacity="0.85"/>` : ''}
        ${spDots}
        <text x="${W-padR+5}" y="${(spreadY(dataHi)+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${dataHi.toFixed(dec)}</text>
        <text x="${W-padR+5}" y="${(spreadY(dataLo)+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora">${dataLo.toFixed(dec)}</text>`;
    } else {
      spreadSvg = `<text x="${padL}" y="${spreadTop+spreadH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Sora" font-style="italic">No calendar-spread data in this range (fills in over time)</text>`;
    }
  }

  // X-Labels liegen unter dem letzten Pane.
  const axisY = padT + priceH + panesH;
  const totalH = axisY + 22;
  let xLabels = '';
  for (let g = 0; g <= 5; g++) {
    const i = Math.round((n-1) * g / 5);
    const x = xAt(i).toFixed(1);
    xLabels += `<text x="${x}" y="${totalH-4}" font-size="10" fill="${CHART_THEME.text}" font-family="Sora" text-anchor="middle">${bars[i].date.slice(2)}</text>`;
  }
  const intervalLabel = isWeekly ? 'Weekly' : 'Daily';
  const rangeLabel = { '6m':'6 Months', '12m':'12 Months', '5y':'5 Years' }[chartState.range];

  // Source legend, placed to the right of the OI heading.
  const oiHeadingText = `OPEN INTEREST (${oiHeading})`;
  // width at 10px Sora 600 incl. 0.05em letter-spacing, plus a comfortable gap
  const oiHeadingWidth = oiHeadingText.length * (6.8 + 0.5) + 28;
  const oiLegendStartX = padL + oiHeadingWidth;
  const legendDefs = [];
  if (presentOiSources.has('cftc_cot') || !useDailyOi)
    legendDefs.push({ mark: `<circle cx="0" cy="-3" r="2.3" fill="${CHART_THEME.oiCftc}" opacity="0.6"/>`, label: 'CFTC weekly' });
  let oiHeadingLegend = '';
  if (legendDefs.length > 1) {
    let lx = oiLegendStartX;
    oiHeadingLegend = legendDefs.map(d => {
      const g = `<g transform="translate(${lx.toFixed(1)},${(oiTop - 8).toFixed(1)})">${d.mark}<text x="7" y="0" font-size="9" fill="${CHART_THEME.text}" font-family="Sora">${d.label}</text></g>`;
      lx += 18 + d.label.length * 5.0;
      return g;
    }).join('');
  }

  const volumePaneSvg = showVolume ? `
        <text x="${padL}" y="${volumeTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Sora" letter-spacing="0.05em">VOLUME (${volumeHeading})</text>
        ${volumeSvg}` : '';

  const panesSvg = `
        ${volumePaneSvg}
        <text x="${padL}" y="${oiTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Sora" letter-spacing="0.05em">${oiHeadingText}</text>
        ${oiHeadingLegend}
        ${oiSvg}
        <text x="${padL}" y="${cotTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Sora" letter-spacing="0.05em">COT · ${cotLabel.toUpperCase()}${cotHedgingActive ? ` · ${chartState.range.toUpperCase()} HEDGING PROGRAM` : ''}</text>
        ${cotSvg}
        ${showSpread ? `<text x="${padL}" y="${spreadTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Sora" letter-spacing="0.05em">CALENDAR SPREAD · FRONT - NEXT (&lt;0 = CONTANGO)</text>` : ''}
        ${spreadSvg}`;

  const chartKind = chartSource.mode === 'contract'
    ? `Single Contract ${esc(chartSource.displaySymbol || chartSource.label)}`
    : esc(chartSource.displayMode || 'Continuous Contract');
  const sectionLabel = `${chartKind} · ${intervalLabel} · ${rangeLabel} (${n} Candles) · with ${showVolume ? 'Volume, ' : ''}CFTC OI &amp; COT${cotHedgingActive ? ' · COT Hedging Program' : ''}`;

  const hedgingLegend = cotHedgingActive
    ? `COT Hedging Program ${chartState.range.toUpperCase()} trailing: green above midpoint, red below &nbsp;·&nbsp;`
    : '';
  const volumeLegendText = showVolume && volumeLegend ? `${esc(volumeLegend)} · ` : '';
  const priceSourceLabel = chartSource.mode === 'contract'
    ? 'single contract'
    : 'continuous';
  const legend = `COT net: <span class="legend-dot" style="background:#0ea679"></span> net long &nbsp;
       <span class="legend-dot" style="background:#e53e3e"></span> net short &nbsp;·&nbsp;
       ${hedgingLegend}${volumeLegendText}${esc(oiLegend)} · COT: ${cotReport}${latestCotDate ? ' · report date ' + latestCotDate : ''} · Price: ${intervalLabel.toLowerCase()} (${esc(chartSource.symbol)}, yfinance ${priceSourceLabel})`;
  // Card-Mode (nur Content-Bot via ?card=): 4/4-Perioden-Schattierung + Trigger-Marker
  // aus window.__fourFourLog. Passiert AUSSCHLIESSLICH hier — normales Dashboard bleibt clean.
  let cardShade = '', cardMarks = '';
  if (document.body.classList.contains('card-mode') && window.__fourFourLog) {
    const periods = ((window.__fourFourLog[chartState.key] || {}).periods) || [];
    const lastX = barXs[barXs.length - 1];
    const winT0 = barTimes[0], winT1 = barTimes[n - 1];
    periods.forEach(p => {
      const ps = new Date(p.start).getTime();
      const pe = p.end ? new Date(p.end).getTime() : null;
      const x1 = xForDate(p.start), x2 = p.end ? xForDate(p.end) : lastX;
      if (x1 != null && x2 != null && x2 > x1) {
        const col = p.direction === 'bullish' ? '#16a34a' : '#dc2626';
        cardShade += `<rect x="${x1.toFixed(1)}" y="${padT}" width="${(x2 - x1).toFixed(1)}" height="${priceH}" fill="${col}" opacity="0.2"/>`;
      }
      // Drop-Marker am Ende einer GESCHLOSSENEN 4/4-Periode (Setup auf 3/4 gefallen):
      // hohles, weiss umrandetes Amber-X am Fall-Punkt. Offene Perioden (end=null) bekommen keinen.
      // Nur zeichnen, wenn der Fall-Tag im sichtbaren Fenster liegt — sonst klemmt
      // nearestBarIndexByTime ihn an den Rand und setzt einen Phantom-Marker am Chart-Rand.
      if (pe != null && pe >= winT0 && pe <= winT1) {
        const eIdx = nearestBarIndexByTime(pe);
        const eb = bars[eIdx], ex = barXs[eIdx];
        if (eb != null && ex != null) {
          const ey = p.direction === 'bullish' ? pY(eb.high) - 13 : pY(eb.low) + 13;
          cardMarks += `<g fill="none" stroke="#f59e0b" stroke-width="2" stroke-linecap="round">`
            + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6.5" stroke="#fff" stroke-width="3.4"/>`
            + `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="6.5"/>`
            + `<line x1="${(ex - 3).toFixed(1)}" y1="${(ey - 3).toFixed(1)}" x2="${(ex + 3).toFixed(1)}" y2="${(ey + 3).toFixed(1)}"/>`
            + `<line x1="${(ex - 3).toFixed(1)}" y1="${(ey + 3).toFixed(1)}" x2="${(ex + 3).toFixed(1)}" y2="${(ey - 3).toFixed(1)}"/>`
            + `</g>`;
        }
      }
      // Entry-Marker nur, wenn der Einstiegs-Tag im sichtbaren Fenster liegt (sonst Phantom am Rand).
      if (!(ps >= winT0 && ps <= winT1)) return;
      const idx = nearestBarIndexByTime(ps);
      const b = bars[idx], mx = barXs[idx];
      if (b == null || mx == null) return;
      if (p.direction === 'bullish') {
        const y = pY(b.low) + 6;
        cardMarks += `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y + 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y + 11).toFixed(1)} Z" fill="${CHART_THEME.bull}" stroke="#fff" stroke-width="0.8"/>`;
      } else {
        const y = pY(b.high) - 6;
        cardMarks += `<path d="M ${mx.toFixed(1)},${y.toFixed(1)} L ${(mx - 6).toFixed(1)},${(y - 11).toFixed(1)} L ${(mx + 6).toFixed(1)},${(y - 11).toFixed(1)} Z" fill="${CHART_THEME.bear}" stroke="#fff" stroke-width="0.8"/>`;
      }
    });
  }

  const chartBg = `<rect x="0" y="0" width="${W}" height="${totalH}" fill="${CHART_THEME.bg}" rx="7"/>`;

  // Height in px = totalH (1:1 to the viewBox so nothing is distorted)
  body.innerHTML = renderChartControls() + `
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
        ${candles}
        ${rollLabels}
        ${cardMarks}
        ${panesSvg}
        ${xLabels}
      </svg>
    </div>
    <div style="font-size:0.65rem;color:var(--muted);margin-top:0.6rem;line-height:1.5">${legend}</div>`;
  bindChartCrosshair(body.querySelector('.chart-svg-wrap'), {
    W, totalH, padL, padR, padT, priceH, axisY,
    volumeTop, volumeH, oiTop, oiH, cotTop, cotH, spreadTop, spreadH,
    bars, barXs,
    pHi, pSpan, dec,
    volumePoints: crosshairVolumePoints,
    oiPoints: crosshairOiPoints,
    cotPoints: crosshairCotPoints,
    spreadPoints: crosshairSpreadPoints
  });
  bindChartControls(cfg);
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
}


