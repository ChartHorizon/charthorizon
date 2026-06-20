const CHART_EXPORT_CSS = `
  text { font-family: 'Geist', system-ui, sans-serif; }
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
    <text x="${pad}" y="42" font-size="20" font-family="'Geist', system-ui, sans-serif" fill="${pal.name}">${escapeXml(ctx.name)}</text>
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
  ctx.font = '600 11px Geist, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(exportCtx.category, pad, 20);
  ctx.fillStyle = pal.name;
  ctx.font = '20px Georgia, serif';
  ctx.fillText(exportCtx.name, pad, 42);
  ctx.textAlign = 'right';
  ctx.fillStyle = pal.sym;
  ctx.font = '10px Geist, system-ui, sans-serif';
  ctx.fillText(exportCtx.symbol, w - pad, 20);
  ctx.fillStyle = pal.brand;
  ctx.font = '700 11px Geist, system-ui, sans-serif';
  ctx.fillText('ChartHorizon', w - pad, 42);
  // Metadata row: data "as of" date (left) and export timestamp (right).
  ctx.font = '10px Geist, system-ui, sans-serif';
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
    ctx.font = '600 11px Geist, system-ui, sans-serif';
    const tail = exportCtx.runway.note || 'before dropping to 3/4';
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

// Share the current chart on X (Twitter). X's web intent cannot attach an image, so
// we copy the chart PNG to the clipboard and the user pastes it into the post with
// Cmd/Ctrl+V. The clipboard write must be ISSUED inside the click gesture: Safari/
// WebKit rejects a write made after `await`, so we hand ClipboardItem a Promise<Blob>
// (the blob renders lazily) instead of awaiting the blob first. Chrome/Firefox accept
// the promise form too. Awaiting the blob first silently failed on Safari (no image).
async function shareToX(kind = 'overview') {
  const ctx = getChartExportContext(kind);
  const text = `${ctx.name || 'Chart'} · ChartHorizon`;
  const intentUrl = `https://x.com/intent/post?text=${encodeURIComponent(text)}`;

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

  const win = window.open(intentUrl, '_blank');
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
      + `<text x="${W - padR + 5}" y="${(+y + 3).toFixed(1)}" font-size="9" fill="${txt}" font-family="Geist">${rf.label}</text>`;
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
    svg += `<text x="${W - padR + 5}" y="${(top + 8).toFixed(1)}" font-size="9" fill="${txt}" font-family="Geist">${hi.toFixed(pdec)}</text>`
      + `<text x="${W - padR + 5}" y="${(bottom - 2).toFixed(1)}" font-size="9" fill="${txt}" font-family="Geist">${lo.toFixed(pdec)}</text>`;
  }
  const heading = `<text x="${padL}" y="${(top - 8).toFixed(1)}" font-size="10" font-weight="600" fill="${indicatorColor(ind)}" font-family="Geist" letter-spacing="0.05em">${esc(indicatorChipLabel(ind).toUpperCase())}</text>`;
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
  // Middle-mouse toggle: the middle button flips the inspection crosshair on/off and the
  // choice sticks as a manual override. Default (override null) follows the tool — off under
  // the Charts-tab Cursor tool (a plain arrow for selecting/moving drawings), on for every
  // other tool and on the Futures tab (no palette). The override wins over that default, so
  // you can summon the crosshair even while the Cursor tool is active, and dismiss it again.
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
  function toggleCrosshair(evt) {
    if (evt.button !== 1) return;   // middle button only
    evt.preventDefault();
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

function injectLivePoint(bars, symbol) {
  if (!bars || !bars.length) return bars;
  if (document.body.classList.contains('card-mode')) return bars;
  if (typeof liveQuotes !== 'object' || !liveQuotes) return bars;
  const lp = symbol && liveQuotes[symbol];
  if (!lp || !Number.isFinite(lp.price) || !lp.day) return bars;

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
  bars = injectLivePoint(bars, chartSource.symbol);

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
    if (st._zoomSig !== sig) { st.zoomStart = null; st.zoomEnd = null; st._zoomSig = sig; }
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
  const plotW = Math.max(120, innerW - edgePad * 2);
  const n = bars.length;

  if (!n) {
    body.innerHTML = (showControls ? renderChartControls() : '') + '<div class="chart-empty">No data for the selected range.</div>';
    if (showControls) bindChartControls(cfg);
    return;
  }

  // Candle geometry
  const slot = plotW / n;
  const _widthFactor = CHART_STYLE.width === 'narrow' ? 0.55 : CHART_STYLE.width === 'wide' ? 0.85 : 0.7;
  const candleW = Math.max(1, Math.min(12, slot * _widthFactor));
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

  // Candlesticks — stil-bewusst: gefuellt / hohl (Up nur Umriss) / Linie (nur Close); Docht-Dicke.
  const _wickW = CHART_STYLE.wick === 'thick' ? 2 : CHART_STYLE.wick === 'medium' ? 1.5 : 1;
  let candles = '';
  if (CHART_STYLE.candle === 'line') {
    let dPath = '';
    bars.forEach((d, i) => {
      if (!Number.isFinite(d.close)) return;
      dPath += `${dPath ? 'L' : 'M'}${xAt(i).toFixed(1)} ${pY(d.close).toFixed(1)}`;
    });
    if (dPath) candles = `<path d="${dPath}" fill="none" stroke="${CHART_THEME.bull}" stroke-width="1.5"/>`;
  } else {
    const hollow = CHART_STYLE.candle === 'hollow';
    const border = CHART_STYLE.border;   // null | hex | 'darken' — candle-body outline colour
    const _darken = (hex) => {
      const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || ''); if (!m) return hex || '#000000';
      const n = parseInt(m[1], 16), d = v => Math.max(0, Math.round(v * 0.66));
      return '#' + ((1 << 24) | (d((n >> 16) & 255) << 16) | (d((n >> 8) & 255) << 8) | d(n & 255)).toString(16).slice(1);
    };
    bars.forEach((d, i) => {
      const x = xAt(i);
      const up = d.close >= d.open;
      const col = up ? CHART_THEME.bull : CHART_THEME.bear;
      const wickCol = up ? CHART_THEME.bullWick : CHART_THEME.bearWick;
      const yHn = pY(d.high), yLn = pY(d.low);
      const bTopR = Math.min(pY(d.open), pY(d.close)), bBotR = Math.max(pY(d.open), pY(d.close));   // real body bounds
      const fill = (hollow && up) ? 'none' : col;
      const strokeCol = !border ? col : (border === 'darken' ? _darken(col) : border);   // body outline
      const strokeW = border ? 1 : (hollow ? 1 : 0.5);
      const wickStroke = border ? strokeCol : wickCol;   // wicks match the body outline when a border is set
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

  // ── Aktuelle-Preis-Linie: dezente gestrichelte Linie auf dem zuletzt handelnden Preis
  // (Live-Tick wenn vorhanden — injectLivePoint hat ihn als letzten Bar gespliced; sonst der
  // letzte settled Close) + Preis-Tag RECHTSBUENDIG an der Achse: rechte Kante fix am Chart-Rand,
  // Tag waechst nach links — lange Zahlen (z.B. BTC) werden nie abgeschnitten. Eigene Klasse (kein
  // chart-live-dot), damit der SVG-Export sie behaelt; erscheint auch in Card-Mode. `curY` wird
  // unten genutzt, um das kollidierende Round-Level-Label auf gleicher Hoehe wegzulassen.
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
        `<text x="${(tagX + tagW / 2).toFixed(1)}" y="${(tagY + 3.5).toFixed(1)}" font-size="10" font-weight="600" text-anchor="middle" fill="${CHART_THEME.text}" font-family="Geist">${txt}</text>` +
        `</g>`;
    }
  }

  // ── Roll-Marker: geplante Frontmonat-Verfallstermine (Boersenkalender) ──
  // Deterministisch aus contract_months + expiry_rule (generatorseitig in roll_dates).
  // Nur On-Screen + nativer Continuous: NICHT in Card-Mode-Exports und nicht bei
  // Einzelkontrakt-Ansicht. Marker = geplanter Verfall und kann ein paar Tage neben
  // Yahoos tatsaechlichem Roll liegen (dessen Punkt ist nicht bekannt). Labels werden
  // bei dichten (monatlichen) Zyklen ausgeduennt, die Linie bleibt.
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
        rollLabels += `<text x="${(x + 2).toFixed(1)}" y="${(padT + priceH - 4).toFixed(1)}" font-size="9" font-weight="600" fill="#475569" font-family="Geist">${r.code}</text>`;
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
    // Label weglassen, wenn es mit dem Aktuelle-Preis-Tag auf gleicher Hoehe kollidiert.
    // Rechtsbuendig (text-anchor=end) an der rechten Kante, damit lange Zahlen (BTC: "100000.00")
    // nicht am Rand abgeschnitten werden.
    if (!(curY != null && Math.abs(+y - curY) < 9))
      roundLevels += `<text x="${W-4}" y="${(+y+3).toFixed(1)}" font-size="10" text-anchor="end" fill="${CHART_THEME.text}" font-family="Geist">${lv.toFixed(dec)}</text>`;
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
        <text x="${W-padR+5}" y="${(volumeTop+8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(volumeMax/1000).toFixed(0)}K</text>`
        : `<text x="${padL}" y="${volumeTop+volumeH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No volume data in this range</text>`;
    } else {
      volumeSvg = `<text x="${padL}" y="${volumeTop+volumeH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No volume data in this range</text>`;
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

  // OI pane (oiTop precomputed via the stack-cursor)
  if (showOi && oiPoints.length) {
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
      <text x="${W-padR+5}" y="${(oiTop+5).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(oiMax/1000).toFixed(0)}K</text>
      <text x="${W-padR+5}" y="${(oiTop+oiH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(oiMin/1000).toFixed(0)}K</text>`;
  } else if (showOi) {
    oiSvg = `<text x="${padL}" y="${oiTop+oiH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No Open Interest data in this range</text>`;
  }

  // COT pane (report-dependent net position; cotTop precomputed via the stack-cursor)
  if (showCot && cotBars.length) {
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
    const midLabel = cotHedgingActive ? `<text x="${W-padR+5}" y="${(cotMid+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.bull}" font-family="Geist">${(cotThreshold/1000).toFixed(0)}K</text>` : '';
    cotSvg = `
      <line x1="${padL}" y1="${cotMid.toFixed(1)}" x2="${W-padR}" y2="${cotMid.toFixed(1)}" stroke="${cotHedgingActive ? CHART_THEME.bull : CHART_THEME.axis}" stroke-dasharray="4,3"/>
      ${bars2}
      <text x="${W-padR+5}" y="${(cotTop+8).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(upperLabel/1000).toFixed(0)}K</text>
      ${midLabel}
      <text x="${W-padR+5}" y="${(cotTop+cotH).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${(lowerLabel/1000).toFixed(0)}K</text>`;
  } else if (showCot) {
    cotSvg = `<text x="${padL}" y="${cotTop+cotH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No CFTC COT data in this range</text>`;
  }

  // Calendar-spread pane (front minus next contract; negative = contango).
  // Optional, off by default. Daily only — the spread is built from daily EoD
  // contracts; in weekly view we still plot the underlying daily points.
  if (showSpread) {
    // spreadTop precomputed via the stack-cursor (stacks below COT / OI / Volume / price as present).
    // Settled EoD only: the pane ends at the last closed bar. No live/forming point is
    // appended (the price line keeps its live candle; the spread deliberately does not).
    let spreadSeries = normalizeSpreadSeries(cfg.calendar_spread_series || []);
    spreadSeries = spreadSeries.filter(inVisibleRange);
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
        <text x="${W-padR+5}" y="${(zeroY+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">0</text>
        ${spreadSeries.length > 1 ? `<path d="${spPath}" fill="none" stroke="${CHART_THEME.spread}" stroke-width="1.5" opacity="0.85"/>` : ''}
        ${spDots}
        <text x="${W-padR+5}" y="${(spreadY(dataHi)+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${dataHi.toFixed(dec)}</text>
        <text x="${W-padR+5}" y="${(spreadY(dataLo)+3).toFixed(1)}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist">${dataLo.toFixed(dec)}</text>`;
    } else {
      spreadSvg = `<text x="${padL}" y="${spreadTop+spreadH/2}" font-size="11" fill="${CHART_THEME.text}" font-family="Geist" font-style="italic">No calendar-spread data in this range (fills in over time)</text>`;
    }
  }

  // X-Labels liegen unter dem letzten Pane.
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
        if (label) dividerLabels += `<text x="${(barXs[i] - slot / 2 + 3).toFixed(1)}" y="${(padT + 10).toFixed(1)}" font-size="9" fill="${CHART_THEME.text}" font-family="Geist" opacity="0.85">${label}</text>`;
      }
      prevKey = key;
    });
  }

  let xLabels = '';
  for (let g = 0; g <= 5; g++) {
    const i = Math.round((n-1) * g / 5);
    const x = xAt(i).toFixed(1);
    xLabels += `<text x="${x}" y="${totalH-4}" font-size="10" fill="${CHART_THEME.text}" font-family="Geist" text-anchor="middle">${bars[i].date.slice(2)}</text>`;
  }
  const intervalLabel = { daily:'Daily', weekly:'Weekly', monthly:'Monthly', quarterly:'Quarterly' }[chartState.interval] || 'Daily';
  const rangeLabel = { '6m':'6 Months', '12m':'12 Months', '5y':'5 Years', '20y':'20 Years', 'max':'Max History' }[chartState.range] || '';

  // Source legend, placed to the right of the OI heading.
  const oiHeadingText = `OPEN INTEREST (${oiHeading})`;
  // width at 10px Geist 600 incl. 0.05em letter-spacing, plus a comfortable gap
  const oiHeadingWidth = oiHeadingText.length * (6.8 + 0.5) + 28;
  const oiLegendStartX = padL + oiHeadingWidth;
  const legendDefs = [];
  if (presentOiSources.has('cftc_cot') || !useDailyOi)
    legendDefs.push({ mark: `<circle cx="0" cy="-3" r="2.3" fill="${CHART_THEME.oiCftc}" opacity="0.6"/>`, label: 'CFTC weekly' });
  let oiHeadingLegend = '';
  if (legendDefs.length > 1) {
    let lx = oiLegendStartX;
    oiHeadingLegend = legendDefs.map(d => {
      const g = `<g transform="translate(${lx.toFixed(1)},${(oiTop - 8).toFixed(1)})">${d.mark}<text x="7" y="0" font-size="9" fill="${CHART_THEME.text}" font-family="Geist">${d.label}</text></g>`;
      lx += 18 + d.label.length * 5.0;
      return g;
    }).join('');
  }

  const volumePaneSvg = showVolume ? `
        <text x="${padL}" y="${volumeTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" letter-spacing="0.05em">VOLUME (${volumeHeading})</text>
        ${volumeSvg}` : '';

  const panesSvg = showPanes ? `
        ${volumePaneSvg}
        ${taPaneHeadings}
        ${taPanesSvg}
        ${showOi ? `<text x="${padL}" y="${oiTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" letter-spacing="0.05em">${oiHeadingText}</text>
        ${oiHeadingLegend}
        ${oiSvg}` : ''}
        ${showCot ? `<text x="${padL}" y="${cotTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" letter-spacing="0.05em">COT · ${cotLabel.toUpperCase()}${cotHedgingActive ? ` · ${chartState.range.toUpperCase()} HEDGING PROGRAM` : ''}</text>
        ${cotSvg}` : ''}
        ${showSpread ? `<text x="${padL}" y="${spreadTop-8}" font-size="10" font-weight="600" fill="${CHART_THEME.text}" font-family="Geist" letter-spacing="0.05em">CALENDAR SPREAD · FRONT - NEXT (&lt;0 = CONTANGO)</text>` : ''}
        ${spreadSvg}` : '';

  const chartKind = chartSource.mode === 'contract'
    ? `Single Contract ${esc(chartSource.displaySymbol || chartSource.label)}`
    : esc(chartSource.displayMode || 'Continuous Contract');
  const cftcPaneLabel = (showOi && showCot) ? 'CFTC OI &amp; COT' : (showOi ? 'CFTC OI' : (showCot ? 'CFTC COT' : null));
  const paneBits = [showVolume ? 'Volume' : null, cftcPaneLabel, showSpread ? 'Calendar Spread' : null].filter(Boolean);
  const sectionPanes = paneBits.length
    ? ` · with ${paneBits.join(', ')}${cotHedgingActive && showCot ? ' · COT Hedging Program' : ''}`
    : '';
  const sectionLabel = showPanes
    ? `${chartKind} · ${intervalLabel} · ${rangeLabel} (${n} Candles)${sectionPanes}`
    : `${chartKind} · ${intervalLabel} · ${rangeLabel} (${n} Candles)`;

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
  // Card-Mode (nur Content-Bot via ?card=): 4/4-Perioden-Schattierung aus
  // window.__fourFourLog. Passiert AUSSCHLIESSLICH hier — normales Dashboard bleibt clean.
  // (Entry- und Exit/Drop-Marker wurden bewusst entfernt — nur noch das Band bleibt.)
  let cardShade = '';
  if (document.body.classList.contains('card-mode') && window.__fourFourLog) {
    const periods = ((window.__fourFourLog[chartState.key] || {}).periods) || [];
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
    <div style="font-size:0.65rem;color:var(--muted);margin-top:0.6rem;line-height:1.5">${legend}</div>`;
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
    const _xForTime = (t) => {
      const m = barTimes.length;
      if (!m) return padL;
      if (m === 1) return barXs[0];
      if (t <= barTimes[0]) return barXs[0] + (t - barTimes[0]) * ((barXs[1] - barXs[0]) / ((barTimes[1] - barTimes[0]) || 1));
      if (t >= barTimes[m - 1]) return barXs[m - 1] + (t - barTimes[m - 1]) * ((barXs[m - 1] - barXs[m - 2]) / ((barTimes[m - 1] - barTimes[m - 2]) || 1));
      let lo = 0, hi = m - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (barTimes[mid] <= t) lo = mid; else hi = mid; }
      const f = (t - barTimes[lo]) / ((barTimes[hi] - barTimes[lo]) || 1);
      return barXs[lo] + f * (barXs[hi] - barXs[lo]);
    };
    const _timeForX = (x) => {
      const m = barXs.length;
      if (!m) return 0;
      if (m === 1) return barTimes[0];
      if (x <= barXs[0]) return barTimes[0] + (x - barXs[0]) * ((barTimes[1] - barTimes[0]) / ((barXs[1] - barXs[0]) || 1));
      if (x >= barXs[m - 1]) return barTimes[m - 1] + (x - barXs[m - 1]) * ((barTimes[m - 1] - barTimes[m - 2]) / ((barXs[m - 1] - barXs[m - 2]) || 1));
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
      snapDate: (x) => { const b = bars[nearestBarIndexByTime(_timeForX(x))]; return b ? b.date : null; },
      snapDateAny: (t) => {
        if (!_fullBarTimes.length) return null;
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


