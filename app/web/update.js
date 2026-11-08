// ── update.js ── "ChartHorizon X is available": the Settings → Updates card and the notice.
//
// The question itself is asked by the LOCAL server (update_check.py, via /api/update-check),
// never by this page: one place sends the one request, and it sends nothing about the user —
// no version, no OS, no ID. The comparison happens on this machine. That is what keeps the
// website's "your data never leaves your machine" true.
//
// Nothing is asked until the user says so (operator decision 2026-11-08). The card has two
// controls, each with its own hint:
//   - "Check automatically" — a switch, OFF on a fresh installation. Switched on, the server
//     asks at most once a day, and the notice appears when a newer version is out.
//   - "Check now" — one request, on the click. It does not switch the automatic check on.
//
// Rules:
//   1. NEVER in card mode. The content bot shoots its PNGs through this page; a notice would
//      be on every card. boot.js only calls in on the normal-dashboard branch; the guard below
//      is the second lock on that door.
//   2. Not over the splash: the notice waits for the board, like the risk notice does.
//   3. The notice's close button hides THIS version for good (stored by the server, so it
//      holds in every browser); the next release is shown again. "Download" only hides it for
//      this page — opening the download page is not the same as having installed it.
//
// State is `var` on purpose: settings.js calls into this file from openSettings(), and a
// `let` read before this file has run would throw in the temporal dead zone.

var _updateState = null;          // last answer of /api/update-check
var _updateStateLoading = null;   // single-flight: the boot call and the Settings tab share it
var _updateChecking = false;      // "Check now" in flight

function loadUpdateState() {
  if (_updateStateLoading) return _updateStateLoading;
  if (_updateState) return Promise.resolve(_updateState);
  _updateStateLoading = (async () => {
    try {
      const res = await fetch('/api/update-check', { cache: 'no-store' });
      if (res.ok) _updateState = await res.json();
    } catch (e) { /* server gone: no notice, and the card says so */ }
    _updateStateLoading = null;
    return _updateState;
  })();
  return _updateStateLoading;
}

async function _postUpdateCheck(body) {
  const res = await fetch('/api/update-check', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  _updateState = await res.json();
  return _updateState;
}

function _hideUpdateNotice() {
  const el = document.getElementById('updateNotice');
  if (el) el.remove();
}

function showUpdateNotice(st) {
  _hideUpdateNotice();
  const el = document.createElement('div');
  el.id = 'updateNotice';
  el.className = 'update-notice';
  el.setAttribute('role', 'status');
  el.innerHTML =
    `<span class="update-notice-text">ChartHorizon <strong>${esc(st.latest)}</strong> is available`
      + ` <span class="update-notice-current">· you have ${esc(st.current)}</span></span>`
    + `<a class="update-notice-link" href="${esc(st.url)}" target="_blank" rel="noopener">Download</a>`
    + `<button type="button" class="app-notice-close" aria-label="Dismiss until the next version"`
      + ` title="Don't show this again for ${esc(st.latest)}">${lineIcon('close')}</button>`;
  el.querySelector('a').addEventListener('click', () => _hideUpdateNotice());
  el.querySelector('button').addEventListener('click', async () => {
    _hideUpdateNotice();
    try { await _postUpdateCheck({ dismiss: st.latest }); }
    catch (e) { /* not stored: it comes back on the next start, which is harmless */ }
    renderSettingsUpdates();
  });
  document.body.appendChild(el);
}

// Called from boot.js on the normal-dashboard branch. Fire-and-forget. With the automatic
// check off this asks the server only for what it already knows — no request leaves.
async function ensureUpdateNotice() {
  if (_isCardMode()) return;                       // rule 1
  const st = await loadUpdateState();
  renderSettingsUpdates();
  if (!st || !st.newer || st.dismissed) return;
  if (typeof _riskNoticeAfterReveal === 'function' && !(await _riskNoticeAfterReveal())) return;  // rule 2
  showUpdateNotice(st);
}

// The automatic-check switch. Switching it on asks at once (the server clears the last
// check), so it shows the same "Checking…" state as the button.
async function setUpdateCheckAuto(on) {
  if (_updateChecking) return;
  _updateChecking = !!on;
  renderSettingsUpdates();
  try {
    const st = await _postUpdateCheck({ auto: !!on });
    if (st.newer && !st.dismissed) showUpdateNotice(st);
  } catch (e) {
    appNotice('Could not save the setting — the local server did not answer.');
  }
  _updateChecking = false;
  renderSettingsUpdates();
}

// The "Check now" button.
async function checkForUpdateNow() {
  if (_updateChecking) return;
  _updateChecking = true;
  renderSettingsUpdates();
  try {
    const st = await _postUpdateCheck({ check: true });
    if (st.newer && !st.dismissed) showUpdateNotice(st);
  } catch (e) {
    appNotice('Could not check — the local server did not answer.');
  }
  _updateChecking = false;
  renderSettingsUpdates();
}

function _updateStatusLine(st) {
  if (_updateChecking) return 'Checking chart-horizon.com…';
  if (!st) return 'Update status unavailable — the local server did not answer.';
  const when = st.checked_at ? ` (checked ${esc(st.checked_at.replace('T', ' ').slice(0, 16))})` : '';
  if (st.newer) {
    return `ChartHorizon <strong>${esc(st.latest)}</strong> is available — you have ${esc(st.current)}. `
      + `<a class="set-about-link" href="${esc(st.url)}" target="_blank" rel="noopener">Download</a>`;
  }
  if (st.failed) {
    return 'The last check did not reach chart-horizon.com.'
      + (st.latest ? ` The latest release it knows of is ${esc(st.latest)}${when}.` : '');
  }
  if (st.latest) return `Up to date — the latest release is ${esc(st.latest)}${when}.`;
  return 'Not checked yet.';
}

// Settings → Updates.
function renderSettingsUpdates() {
  const host = document.getElementById('settingsUpdates');
  if (!host) return;
  const st = _updateState;
  const auto = !!(st && st.auto);
  host.innerHTML =
    '<div class="set-card-h"><div class="set-card-title">Updates</div>'
      + '<div class="set-card-sub">Is a newer ChartHorizon out?</div></div>'
    + `<div class="set-update${st && st.newer ? ' set-update-new' : ''}" aria-live="polite">${_updateStatusLine(st)}</div>`
    + '<label class="set-checkrow">'
      + `<input type="checkbox"${auto ? ' checked' : ''}${st && !_updateChecking ? '' : ' disabled'} onchange="setUpdateCheckAuto(this.checked)">`
      + '<span>Check automatically once a day</span>'
    + '</label>'
    + '<div class="set-hint">Off unless you switch it on. Once a day ChartHorizon downloads one small '
      + 'file from chart-horizon.com and shows a notice when a new version is out. Nothing about you, '
      + 'your data or this installation is sent, not even the version number — the comparison '
      + 'happens on this computer.</div>'
    + `<button type="button" class="set-btn" onclick="checkForUpdateNow()"${_updateChecking || !st ? ' disabled' : ''}>`
      + `${_updateChecking ? 'Checking…' : 'Check now'}</button>`
    + '<div class="set-hint set-hint-after-btn">Asks chart-horizon.com once, right now — the same '
      + 'single file, nothing sent. Works with the automatic check off, and does not switch it on.</div>';
}
