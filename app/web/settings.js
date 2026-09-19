// ── Settings tab: chart layout presets (light/dark) + timezone ──
// Plain script, one global scope. The data layer (preset store, applyActivePreset,
// timezone helpers) lives in core.js; this file is view + event handlers only.

// Which theme the chart-layout editor is currently editing (independent of the app theme).
let settingsEditTheme = null;

// Color tokens as UI groups: [group name, [token, label]...]
const SETTINGS_COLOR_GROUPS = [
  ['Surface', [['--chart-bg', 'Background'], ['--chart-grid', 'Grid'], ['--chart-grid-soft', 'Grid (soft)'], ['--chart-axis', 'Axis'], ['--chart-text', 'Text']]],
  ['Candles', [['--chart-bull', 'Bull'], ['--chart-bull-wick', 'Bull wick'], ['--chart-bear', 'Bear'], ['--chart-bear-wick', 'Bear wick']]],
  ['Volume', [['--chart-volume', 'Volume'], ['--chart-volume-bull', 'Volume bull'], ['--chart-volume-bear', 'Volume bear']]],
  ['Open Interest', [['--chart-oi', 'OI'], ['--chart-oi-cftc', 'OI CFTC'], ['--chart-oi-cme', 'OI CME'], ['--chart-oi-yf', 'OI yfinance']]],
  ['Other', [['--chart-spread', 'Spread'], ['--chart-trend', 'Trend line']]],
];

// Style options: [key, label, [value, label]...]
const SETTINGS_STYLE_OPTIONS = [
  ['candle', 'Candle style', [['filled', 'Filled'], ['hollow', 'Hollow'], ['line', 'Line']]],
  ['wick', 'Wick thickness', [['thin', 'Thin'], ['medium', 'Medium'], ['thick', 'Thick']]],
  ['width', 'Candle width', [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']]],
  ['grid', 'Grid', [['normal', 'Normal'], ['subtle', 'Subtle'], ['off', 'Off']]],
];

// Read a theme's pure CSS default colors: temporarily strip the inline overrides, set
// data-theme, read the computed values, restore everything synchronously (no flash).
function settingsReadThemeDefaults(theme) {
  const root = document.documentElement;
  const prevTheme = root.getAttribute('data-theme');
  const prevInline = {};
  CHART_COLOR_TOKENS.forEach(tok => { prevInline[tok] = root.style.getPropertyValue(tok); root.style.removeProperty(tok); });
  root.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  const cs = getComputedStyle(root);
  const out = {};
  CHART_COLOR_TOKENS.forEach(tok => { out[tok] = (cs.getPropertyValue(tok).trim() || '#000000'); });
  if (prevTheme) root.setAttribute('data-theme', prevTheme); else root.removeAttribute('data-theme');
  CHART_COLOR_TOKENS.forEach(tok => { if (prevInline[tok]) root.style.setProperty(tok, prevInline[tok]); });
  return out;
}

// Resolved colors/style of a preset (theme defaults + preset overrides).
function settingsCurrentColors(theme, preset) {
  const out = { ...settingsReadThemeDefaults(theme) };
  if (preset && preset.colors) Object.keys(preset.colors).forEach(k => { if (preset.colors[k]) out[k] = preset.colors[k]; });
  return out;
}
function settingsCurrentStyle(preset) {
  return { ...CHART_STYLE_DEFAULT, ...((preset && preset.style) || {}) };
}

// Normalise a color value to #rrggbb (mandatory for <input type="color">).
function _toHex6(v) {
  if (!v) return '#000000';
  v = String(v).trim();
  if (/^#[0-9a-fA-F]{6}$/.test(v)) return v.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(v)) return ('#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3]).toLowerCase();
  return '#000000';
}

// Fixed demo candles for the live preview.
const SETTINGS_PREVIEW_BARS = [
  { o: 100, h: 104, l: 99, c: 103 }, { o: 103, h: 106, l: 102, c: 105 }, { o: 105, h: 107, l: 101, c: 102 },
  { o: 102, h: 103, l: 98, c: 99 }, { o: 99, h: 102, l: 97, c: 101 }, { o: 101, h: 105, l: 100, c: 104 },
  { o: 104, h: 108, l: 103, c: 107 }, { o: 107, h: 109, l: 105, c: 106 }, { o: 106, h: 107, l: 102, c: 103 },
  { o: 103, h: 105, l: 101, c: 104 }, { o: 104, h: 110, l: 103, c: 109 }, { o: 109, h: 112, l: 108, c: 111 },
];

// Standalone mini candlestick renderer (no coupling to chart.js).
function settingsMiniPreview(colors, style) {
  const W = 260, H = 120, padL = 6, padR = 6, padT = 8, padB = 8;
  const bars = SETTINGS_PREVIEW_BARS;
  const plotW = W - padL - padR, plotH = H - padT - padB;
  const all = bars.flatMap(b => [b.h, b.l]);
  const lo = Math.min(...all), hi = Math.max(...all), span = (hi - lo) || 1;
  const x = i => padL + plotW * (i + 0.5) / bars.length;
  const y = v => padT + (1 - (v - lo) / span) * plotH;
  const col = t => colors[t] || '#888888';
  const bg = col('--chart-bg');
  const wf = style.width === 'narrow' ? 0.45 : style.width === 'wide' ? 0.8 : 0.62;
  const cw = Math.max(2, (plotW / bars.length) * wf);
  const ww = style.wick === 'thick' ? 2 : style.wick === 'medium' ? 1.5 : 1;
  let body = '';
  if (style.candle === 'line') {
    let d = '';
    bars.forEach((b, i) => { d += `${d ? 'L' : 'M'}${x(i).toFixed(1)} ${y(b.c).toFixed(1)}`; });
    body = `<path d="${d}" fill="none" stroke="${col('--chart-bull')}" stroke-width="1.6"/>`;
  } else {
    const hollow = style.candle === 'hollow';
    const border = style.border;   // null | hex | 'darken'
    const _darken = (hex) => {
      const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || ''); if (!m) return hex || '#000000';
      const n = parseInt(m[1], 16), dd = v => Math.max(0, Math.round(v * 0.66));
      return '#' + ((1 << 24) | (dd((n >> 16) & 255) << 16) | (dd((n >> 8) & 255) << 8) | dd(n & 255)).toString(16).slice(1);
    };
    bars.forEach((b, i) => {
      const up = b.c >= b.o;
      const c = up ? col('--chart-bull') : col('--chart-bear');
      const wc = up ? col('--chart-bull-wick') : col('--chart-bear-wick');
      const yo = y(b.o), yc = y(b.c), bt = Math.min(yo, yc), bbt = Math.max(yo, yc);   // real body bounds
      const xi = x(i).toFixed(1), L = (x(i) - cw / 2).toFixed(1), R = (x(i) + cw / 2).toFixed(1);
      const fill = (hollow && up) ? 'none' : c;
      const strokeC = !border ? c : (border === 'darken' ? _darken(c) : border);
      const strokeW = border ? 1 : (hollow ? 1 : 0.5);
      const wickC = border ? strokeC : wc;
      // Wicks as two guarded segments so they never cross a hollow body. (This preview SVG is
      // scaled to fit, so pixel-snapping/crispEdges don't apply here — normal AA is fine.)
      if (y(b.h) < bt) body += `<line x1="${xi}" y1="${y(b.h).toFixed(1)}" x2="${xi}" y2="${bt.toFixed(1)}" stroke="${wickC}" stroke-width="${ww}"/>`;
      if (bbt < y(b.l)) body += `<line x1="${xi}" y1="${bbt.toFixed(1)}" x2="${xi}" y2="${y(b.l).toFixed(1)}" stroke="${wickC}" stroke-width="${ww}"/>`;
      if (bbt - bt < 1) {
        const yb = bt.toFixed(1);
        body += `<line x1="${L}" y1="${yb}" x2="${R}" y2="${yb}" stroke="${col('--chart-text')}" stroke-width="1"/>`;
      } else {
        body += `<rect x="${L}" y="${bt.toFixed(1)}" width="${cw.toFixed(1)}" height="${(bbt - bt).toFixed(1)}" fill="${fill}" stroke="${strokeC}" stroke-width="${strokeW}"/>`;
      }
    });
  }
  let grid = '';
  if (style.grid !== 'off') {
    const op = style.grid === 'subtle' ? 0.4 : 0.78;
    for (let g = 1; g <= 3; g++) {
      const gy = (padT + plotH * g / 4).toFixed(1);
      grid += `<line x1="${padL}" y1="${gy}" x2="${W - padR}" y2="${gy}" stroke="${col('--chart-axis')}" stroke-width="1" stroke-dasharray="2,4" opacity="${op}"/>`;
    }
  }
  return `<svg viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMid meet"><rect x="0" y="0" width="${W}" height="${H}" fill="${bg}"/>${grid}${body}</svg>`;
}

// Renders the tab. The typeof guards keep it runnable even when a render function is
// not defined yet (empty but clickable tab).
function openSettings() {
  if (typeof renderSettingsAppearance === 'function') renderSettingsAppearance();
  if (typeof renderSettingsLayouts === 'function') renderSettingsLayouts();
  if (typeof renderSettingsTimezone === 'function') renderSettingsTimezone();
  if (typeof renderSettingsDrawings === 'function') renderSettingsDrawings();
  if (typeof renderSettingsBackup === 'function') renderSettingsBackup();
  if (typeof renderSettingsAbout === 'function') {
    renderSettingsAbout();                                    // draw immediately (version may still be pending)
    loadSettingsVersion().then(() => renderSettingsAbout());  // and redraw once the server has answered
  }
}

function renderSettingsLayouts() {
  const host = document.getElementById('settingsLayouts');
  if (!host) return;
  if (!settingsEditTheme) settingsEditTheme = currentTheme();
  const theme = settingsEditTheme;
  const store = loadPresetStore();
  const t = store[theme];
  const preset = t.presets.find(p => p.id === t.activeId) || t.presets[0];
  const builtin = !!preset.builtin;
  const colors = settingsCurrentColors(theme, preset);
  const style = settingsCurrentStyle(preset);

  const themeTabs = ['light', 'dark'].map(th =>
    `<button type="button" class="set-seg${th === theme ? ' active' : ''}" onclick="setSettingsEditTheme('${th}')">${th === 'light' ? 'Light' : 'Dark'}</button>`).join('');

  const presetOpts = t.presets.map(p =>
    `<option value="${esc(p.id)}"${p.id === preset.id ? ' selected' : ''}>${esc(p.name)}</option>`).join('');

  const colorGrid = SETTINGS_COLOR_GROUPS.map(([gl, toks]) =>
    `<div class="set-colgroup"><div class="set-colgroup-h">${esc(gl)}</div><div class="set-colrow">` +
    toks.map(([tok, label]) =>
      `<label class="set-color"><input type="color" value="${_toHex6(colors[tok])}"${builtin ? ' disabled' : ''} onchange="setPresetColor('${tok}', this.value)"><span>${esc(label)}</span></label>`
    ).join('') + `</div></div>`).join('');

  const styleCtrls = SETTINGS_STYLE_OPTIONS.map(([key, label, opts]) =>
    `<label class="set-style"><span>${esc(label)}</span><select${builtin ? ' disabled' : ''} onchange="setPresetStyle('${key}', this.value)">` +
    opts.map(([v, l]) => `<option value="${v}"${style[key] === v ? ' selected' : ''}>${esc(l)}</option>`).join('') +
    `</select></label>`).join('');

  host.innerHTML =
    `<div class="set-card-h"><div class="set-card-title">Chart Layouts</div><div class="set-card-sub">Colors &amp; style per theme · "Standard" is always available</div></div>` +
    `<div class="set-themetabs"><span class="set-themetabs-label">Edit the layout for</span>${themeTabs}</div>` +
    `<div class="set-presetbar">` +
      `<select class="set-presetsel" onchange="selectPreset(this.value)">${presetOpts}</select>` +
      `<button type="button" class="set-btn" onclick="newPreset()">New</button>` +
      `<button type="button" class="set-btn" onclick="renamePreset()"${builtin ? ' disabled' : ''}>Rename</button>` +
      `<button type="button" class="set-btn set-btn-danger" onclick="deletePreset()"${builtin ? ' disabled' : ''}>Delete</button>` +
    `</div>` +
    (builtin ? `<div class="set-hint">"Standard" is read-only. Use "New" to create your own layout.</div>` : '') +
    `<div class="set-editor">` +
      `<div class="set-colors">${colorGrid}<div class="set-styles">${styleCtrls}</div></div>` +
      `<div class="set-preview"><div class="set-preview-h">Preview (${theme === 'light' ? 'Light' : 'Dark'})</div>${settingsMiniPreview(colors, style)}</div>` +
    `</div>`;
}

function setSettingsEditTheme(theme) {
  settingsEditTheme = theme === 'dark' ? 'dark' : 'light';
  renderSettingsLayouts();
}

// Edits the active (custom) preset of the theme being edited; saves it, applies it
// live (only when it is the app theme) and redraws the tab.
function _updateActivePresetField(mutator) {
  const theme = settingsEditTheme || currentTheme();
  const store = loadPresetStore();
  const t = store[theme];
  const preset = t.presets.find(p => p.id === t.activeId);
  if (!preset || preset.builtin) return;
  mutator(preset);
  savePresetStore(store);
  if (theme === currentTheme()) applyActivePreset();
  renderSettingsLayouts();
}
function setPresetColor(token, value) {
  _updateActivePresetField(p => { p.colors = p.colors || {}; p.colors[token] = value; });
}
function setPresetStyle(key, value) {
  _updateActivePresetField(p => { p.style = p.style || {}; p.style[key] = value; });
}

function selectPreset(id) {
  const theme = settingsEditTheme || currentTheme();
  const store = loadPresetStore();
  if (!store[theme].presets.some(p => p.id === id)) return;
  store[theme].activeId = id;
  savePresetStore(store);
  if (theme === currentTheme()) applyActivePreset();
  renderSettingsLayouts();
}

function newPreset() {
  const theme = settingsEditTheme || currentTheme();
  const store = loadPresetStore();
  const t = store[theme];
  const cur = t.presets.find(p => p.id === t.activeId) || t.presets[0];
  const colors = settingsCurrentColors(theme, cur);
  const style = settingsCurrentStyle(cur);
  const n = t.presets.filter(p => !p.builtin).length + 1;
  const id = 'p_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
  t.presets.push({ id, name: 'Layout ' + n, builtin: false, colors, style });
  t.activeId = id;
  savePresetStore(store);
  if (theme === currentTheme()) applyActivePreset();
  renderSettingsLayouts();
}

async function renamePreset() {
  const theme = settingsEditTheme || currentTheme();
  const store = loadPresetStore();
  const t = store[theme];
  const preset = t.presets.find(p => p.id === t.activeId);
  if (!preset || preset.builtin) return;
  const name = await appAsk({ title: 'Rename layout', value: preset.name, confirmLabel: 'Rename' });
  if (!name) return;
  preset.name = name;
  savePresetStore(store);
  renderSettingsLayouts();
}

async function deletePreset() {
  const theme = settingsEditTheme || currentTheme();
  const store = loadPresetStore();
  const t = store[theme];
  const preset = t.presets.find(p => p.id === t.activeId);
  if (!preset || preset.builtin) return;
  const ok = await appAsk({ title: `Delete "${preset.name}"?`, message: `Charts in ${theme} mode go back to the Standard layout.`, confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  t.presets = t.presets.filter(p => p.id !== preset.id);
  t.activeId = 'standard';
  savePresetStore(store);
  if (theme === currentTheme()) applyActivePreset();
  renderSettingsLayouts();
}

// Kuratierte Zeitzonenliste [Wert, Label]. 'auto' = Systemzone.
const TZ_OPTIONS = [
  ['auto', 'Auto (System)'],
  ['UTC', 'UTC'],
  ['America/New_York', 'New York'],
  ['America/Chicago', 'Chicago'],
  ['America/Los_Angeles', 'Los Angeles'],
  ['Europe/London', 'London'],
  ['Europe/Berlin', 'Berlin'],
  ['Asia/Dubai', 'Dubai'],
  ['Asia/Singapore', 'Singapore'],
  ['Asia/Tokyo', 'Tokyo'],
  ['Australia/Sydney', 'Sydney'],
];

function renderSettingsTimezone() {
  const host = document.getElementById('settingsTimezone');
  if (!host) return;
  const cur = getTimezone();
  const opts = TZ_OPTIONS.map(([v, l]) => `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(l)}</option>`).join('');
  const resolved = resolveTimezone();
  let preview = '–';
  try { preview = new Intl.DateTimeFormat('en-US', { timeZone: resolved, hour: '2-digit', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date()); } catch (e) {}
  host.innerHTML =
    `<div class="set-card-h"><div class="set-card-title">Timezone</div><div class="set-card-sub">Clock &amp; date, top right</div></div>` +
    `<div class="set-tzrow">` +
      `<select class="set-presetsel" onchange="setSettingsTimezone(this.value)">${opts}</select>` +
      `<span class="set-tzpreview">${esc(preview)} · ${esc(resolved)}</span>` +
    `</div>`;
}

function setSettingsTimezone(tz) {
  setTimezone(tz);
  if (typeof initHeaderClock === 'function') initHeaderClock();
  renderSettingsTimezone();
}

// ── Appearance: theme mode Light / Dark / System ──
function renderSettingsAppearance() {
  const host = document.getElementById('settingsAppearance');
  if (!host) return;
  const mode = (typeof getThemeMode === 'function') ? getThemeMode() : 'light';
  const seg = [['light', 'Light'], ['dark', 'Dark'], ['system', 'System']].map(([m, l]) =>
    `<button type="button" class="set-seg${m === mode ? ' active' : ''}" onclick="setSettingsThemeMode('${m}')">${l}</button>`).join('');
  const note = mode === 'system'
    ? `<div class="set-hint">Following system (currently ${currentTheme() === 'dark' ? 'Dark' : 'Light'}).</div>`
    : '';
  host.innerHTML =
    `<div class="set-card-h"><div class="set-card-title">Appearance</div><div class="set-card-sub">Light, dark, or follow your system</div></div>` +
    `<div class="set-themetabs">${seg}</div>` + note;
}

function setSettingsThemeMode(mode) {
  if (typeof setThemeMode === 'function') setThemeMode(mode);   // applies theme + calls refreshSettingsThemeUI
  else renderSettingsAppearance();
}

// Re-render theme-dependent settings UI when the theme changes from elsewhere
// (header toggle, OS change). Only touches the DOM if the Settings tab is present.
function refreshSettingsThemeUI() {
  if (document.getElementById('settingsAppearance')) renderSettingsAppearance();
}

// ── Drawings: defaults for the Charts-tab drawing tools ──
// Only the DEFAULT for newly drawn objects. Every existing rectangle and trend line keeps its
// own switch (right-click on it -> Extend -> Right edge), so ticking this never rewrites work
// that is already on a chart.
function renderSettingsDrawings() {
  const host = document.getElementById('settingsDrawings');
  if (!host) return;
  const on = (typeof getDrawExtendRightDefault === 'function') ? getDrawExtendRightDefault() : false;
  host.innerHTML =
    `<div class="set-card-h"><div class="set-card-title">Drawings</div><div class="set-card-sub">Charts tab &middot; defaults for new objects</div></div>` +
    `<label class="set-checkrow">` +
      `<input type="checkbox"${on ? ' checked' : ''} onchange="setSettingsDrawExtendRight(this.checked)">` +
      `<span>Extend new rectangles and trend lines to the right edge</span>` +
    `</label>` +
    `<div class="set-hint">Applies to objects drawn from now on. Any single object can be switched with a right-click on it.</div>`;
}

function setSettingsDrawExtendRight(on) {
  if (typeof setDrawExtendRightDefault === 'function') setDrawExtendRightDefault(!!on);
  renderSettingsDrawings();
}

// ── Backup: export / import all settings as a JSON file ──
function renderSettingsBackup() {
  const host = document.getElementById('settingsBackup');
  if (!host) return;
  host.innerHTML =
    `<div class="set-card-h"><div class="set-card-title">Backup</div><div class="set-card-sub">Stored locally in this browser · export to back up or move to another browser</div></div>` +
    `<div class="set-presetbar">` +
      `<button type="button" class="set-btn" onclick="exportSettings()">Export…</button>` +
      `<button type="button" class="set-btn" onclick="importSettings()">Import…</button>` +
    `</div>`;
}

function exportSettings() {
  const data = {
    _type: 'charthorizon-settings',
    version: 1,
    themeMode: (typeof getThemeMode === 'function') ? getThemeMode() : 'system',
    timezone: (typeof getTimezone === 'function') ? getTimezone() : 'auto',
    drawExtendRight: (typeof getDrawExtendRightDefault === 'function') ? getDrawExtendRightDefault() : false,
    presets: loadPresetStore(),
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement('a');
  a.href = url;
  a.download = `charthorizon-settings-${stamp}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function importSettings() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    const notSettings = 'That file is not a ChartHorizon settings backup. Choose a file saved with Export.';
    reader.onerror = () => appNotice('ChartHorizon could not read that file.');
    reader.onload = async () => {
      let data;
      try { data = JSON.parse(reader.result); } catch (e) { appNotice(notSettings); return; }
      if (!data || data._type !== 'charthorizon-settings' || !data.presets || !data.presets.light || !data.presets.dark) {
        appNotice(notSettings);
        return;
      }
      const ok = await appAsk({ title: 'Import settings?', message: 'This replaces your chart layouts, theme and timezone in this browser.', confirmLabel: 'Import' });
      if (!ok) return;
      savePresetStore(data.presets);
      // Optional field: files written before this setting existed simply leave it off.
      if (typeof setDrawExtendRightDefault === 'function') setDrawExtendRightDefault(!!data.drawExtendRight);
      if (typeof setTimezone === 'function') setTimezone(data.timezone || 'auto');
      if (typeof initHeaderClock === 'function') initHeaderClock();
      settingsEditTheme = null;   // re-default the layout editor to the (possibly new) active theme
      if (typeof setThemeMode === 'function') setThemeMode(data.themeMode || 'system');   // applies theme + presets
      else if (typeof applyActivePreset === 'function') applyActivePreset();
      openSettings();             // re-render every card from imported state
    };
    reader.readAsText(file);
  });
  document.body.appendChild(input);
  input.click();
  input.remove();
}

// ── About: which version is actually running here ──
// The version comes from the running server (/api/version), NOT from config.js: config.js
// is written by the generator, and after an update it still names the old version until
// the first refresh is through. A version display must not lie.
let _settingsVersionInfo = null;      // cached — does not change at runtime
let _settingsVersionTried = false;    // one failure is not retried on every tab switch

async function loadSettingsVersion() {
  if (_settingsVersionInfo || _settingsVersionTried) return _settingsVersionInfo;
  _settingsVersionTried = true;
  try {
    const res = await fetch('/api/version', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (data && data.version) _settingsVersionInfo = data;
  } catch (e) { /* server gone / page opened as file:// — the card then shows "unavailable" */ }
  return _settingsVersionInfo;
}

function renderSettingsAbout() {
  const host = document.getElementById('settingsAbout');
  if (!host) return;
  const info = _settingsVersionInfo;
  // refresh.js keeps genDate current after a background refresh.
  const asOf = (window.__CONFIG__ && window.__CONFIG__.genDate) || '';

  const rows = [];
  if (info) {
    rows.push(['Build', info.build === 'installer'
      ? `Installer${info.platform ? ' · ' + info.platform : ''}`
      : `Source${info.platform ? ' · ' + info.platform : ''}`]);
    if (info.python) rows.push(['Python', info.python]);
  }
  if (asOf) rows.push(['Data as of', asOf]);

  host.innerHTML =
    `<div class="set-card-h"><div class="set-card-title">About</div><div class="set-card-sub">Which ChartHorizon version is running here</div></div>` +
    `<div class="set-about-v">ChartHorizon <strong>${info ? esc(info.version) : '—'}</strong></div>` +
    (info
      ? `<div class="set-kv">${rows.map(([k, v]) => `<div class="set-kv-k">${esc(k)}</div><div class="set-kv-v">${esc(v)}</div>`).join('')}</div>`
      : `<div class="set-hint">Version unavailable — the local server did not answer. Restart ChartHorizon.</div>`) +
    `<div class="set-hint">Latest release and release notes: ` +
      // Deliberately the bare link, not /from-dashboard: that one counts the logo clicks
      // in the banner and must not be diluted by a second entry point.
      `<a class="set-about-link" href="https://chart-horizon.com/dashboard" target="_blank" rel="noopener">chart-horizon.com/dashboard</a></div>` +
    // The notice the first launch showed once, kept reachable afterwards — the installer's
    // wizard page and RISK-NOTICE.txt beside the app are the other two copies of it.
    `<div class="set-hint">Educational tool — not investment advice, and trading carries a ` +
      `substantial risk of loss. <button type="button" class="set-notice-link" onclick="openRiskNotice()">Read the risk notice</button></div>`;
}
