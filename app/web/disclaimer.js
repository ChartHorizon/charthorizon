// ── disclaimer.js ── The risk notice, once per installation.
//
// packaging/public/RISK-NOTICE.txt is the canonical wording; the Windows installer compiles
// it in as a wizard page that cannot be walked past unread. This is the other half: the
// dashboard shows a short form of it on the FIRST launch of an installation and never
// again — and on macOS and Linux it is the only place it appears at all, because a .dmg and
// an AppImage have no installer to put a page in front of.
//
// Three rules hold this file together:
//
//   1. NEVER in card mode. The content bot shoots its PNGs through this very page, and its
//      headless Chromium starts with an empty profile on every run — a dialog here would
//      land on every card it ever exports. boot.js only calls in on the normal-dashboard
//      branch; the guard below is the second lock on the same door.
//   2. The state lives on the SERVER (ff_data/risk_notice_ack.json, via /api/risk-notice).
//      localStorage would ask again after every cache clear and in every browser, which is
//      not what "first start" means.
//   3. The long text is CLONED from footer.page-disclaimer, never retyped. That footer is
//      already the app's full risk notice; a second copy in here would drift from it.

const RISK_NOTICE_SHORT =
  'ChartHorizon is an educational and informational tool. Nothing it shows is investment '
  + 'advice or a recommendation to buy or sell anything, and trading futures, forex or other '
  + 'leveraged products carries a substantial risk of loss — you can lose more than your '
  + 'deposit. Seasonal, COT and structure signals are statistical: past results do not '
  + 'guarantee future ones. The market data is end-of-day, comes from free third-party '
  + 'sources and is provided as is, without warranty. The authors accept no liability for '
  + 'any loss or damage arising from use of this tool; you use it entirely at your own risk.';

// The dialog is opened from two places and differs in exactly two ways: the first run must
// be acknowledged (Esc cannot dismiss it, and the button records the acknowledgement),
// while Settings → About only reads it back.
function riskNoticeDialog({ mustAcknowledge }) {
  return new Promise(resolve => {
    const dlg = document.createElement('dialog');
    dlg.className = 'app-dialog risk-dialog';
    dlg.setAttribute('aria-labelledby', 'riskNoticeTitle');
    dlg.setAttribute('aria-describedby', 'riskNoticeShort');
    const footer = document.querySelector('footer.page-disclaimer');
    dlg.innerHTML =
      '<h2 class="app-dialog-title" id="riskNoticeTitle">Risk notice</h2>'
      + `<p class="app-dialog-msg" id="riskNoticeShort">${esc(RISK_NOTICE_SHORT)}</p>`
      + (footer
        ? `<details class="risk-full"><summary>Read the full notice</summary>
             <div class="risk-full-body">${footer.innerHTML}</div></details>`
        : '')
      + '<p class="risk-where">The full text ships with the app as <code>RISK-NOTICE.txt</code>'
      + ' and stays reachable under Settings → About.</p>'
      + '<div class="app-dialog-actions">'
      + `<button type="button" class="set-btn set-btn-primary">${mustAcknowledge ? 'I understand' : 'Close'}</button>`
      + '</div>';
    const btn = dlg.querySelector('button');
    btn.addEventListener('click', () => dlg.close());
    // Esc closes a <dialog> by default. On the first run there is nothing to close it TO:
    // the one button is the whole point, so the cancel event is refused.
    if (mustAcknowledge) dlg.addEventListener('cancel', (e) => e.preventDefault());
    dlg.addEventListener('close', () => { dlg.remove(); resolve(true); });
    document.body.appendChild(dlg);
    dlg.showModal();
    btn.focus();
  });
}

// Settings → About. Always readable, whether or not it was acknowledged.
function openRiskNotice() {
  return riskNoticeDialog({ mustAcknowledge: false });
}

// The splash owns the screen until bootWarmup() reveals the board (or the user takes the
// "Open anyway" exit); a modal over it would be a dialog on top of a loading screen. So
// wait for html.booting to go, and give up after a few minutes rather than leave an
// interval running for the life of the page — an installation that never got the notice
// will be asked again on the next start, which is the safe direction to fail in.
function _riskNoticeAfterReveal(timeoutMs = 300000) {
  const root = document.documentElement;
  if (!root.classList.contains('booting')) return Promise.resolve(true);
  return new Promise(resolve => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (!root.classList.contains('booting')) { clearInterval(timer); resolve(true); }
      else if (Date.now() - started > timeoutMs) { clearInterval(timer); resolve(false); }
    }, 150);
  });
}

// Called from boot.js on the normal-dashboard branch. Fire-and-forget: every failure path
// simply shows nothing, and the question comes back on the next start.
async function ensureRiskNotice() {
  if (_isCardMode()) return;                       // rule 1 — the bot's page is never asked
  let state = null;
  try {
    const res = await fetch('/api/risk-notice', { cache: 'no-store' });
    if (!res.ok) return;
    state = await res.json();
  } catch (e) { return; }
  if (!state || state.accepted) return;
  if (!(await _riskNoticeAfterReveal())) return;
  await riskNoticeDialog({ mustAcknowledge: true });
  try {
    await fetch('/api/risk-notice-ack', { method: 'POST', cache: 'no-store' });
  } catch (e) { /* not stored: the notice returns on the next start, which is the safe way to fail */ }
}
