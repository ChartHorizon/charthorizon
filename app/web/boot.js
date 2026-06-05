initSidebar();
initSeasonalsSidebar();
renderWatchlist();

// Card-Mode: NUR der Content-Bot ruft `?card=<key>` auf. Konfiguriert den Future-Chart
// (Front-Month · Daily · 12M · Spread + COT Hedging Program) für den PNG-Export und
// zeichnet die 4/4-Marker — beides passiert ausschließlich hier, das normale
// Dashboard bleibt unberührt.
const _cardKey = (() => {
  try { return new URLSearchParams(location.search).get('card'); } catch (e) { return null; }
})();
if (_cardKey === 'fx') {
  // FX-Heatmap-Karte (zweite Signalquelle): gebrandete Heatmap als DOM-Screenshot.
  document.body.classList.add('card-mode', 'fx-card-mode');
  openForexCard();
} else if (_cardKey && _cardKey.indexOf('fxpair-') === 0) {
  // Natives FX-Paar-Chart (Preis-only + Marker): ?card=fxpair-<baseKey>-<quoteKey>.
  document.body.classList.add('card-mode');
  const _p = _cardKey.split('-');   // ['fxpair', baseKey, quoteKey] (Keys haben nur '_')
  openFxPairCard(_p[1], _p[2]);
} else if (_cardKey && INDEX[_cardKey]) {
  document.body.classList.add('card-mode');
  const _q = new URLSearchParams(location.search);
  // hedge=0 -> COT-Pane OHNE Hedging-Program-Overlay; band=0 -> KEIN 4/4-Band/Marker/
  // Runway-Footer (z.B. COT-Extrem-Posts: nur Chart + rohes COT-Net + Risk-Disclaimer).
  // Ohne Flags bleibt beides AN (4/4-Posts, unveraendert).
  chartState.cotHedging = _q.get('hedge') !== '0';
  chartState.showSpread = true;
  if (_q.get('band') === '0') {
    window.__fourFourLog = {};                 // Log gar nicht laden -> kein Band/Marker/Runway
    switchCommodity(_cardKey);
  } else {
    // 4/4-Log laden (vom Bot erzeugt), DANN den Chart rendern, damit die Marker da sind.
    fetch(`${DATA_DIR}/four_four_log.json?v=${DATA_VERSION}`, { cache: 'no-store' })
      .then(r => (r.ok ? r.json() : {}))
      .then(log => { window.__fourFourLog = log; })
      .catch(() => {})
      .finally(() => switchCommodity(_cardKey));
  }
} else {
  switchCommodity(currentKey);
  // Reopen whichever top tab was active before the last reload.
  try {
    const savedPage = localStorage.getItem(ACTIVE_PAGE_KEY);
    if (savedPage && savedPage !== 'overview' && PAGE_IDS.has(savedPage)) switchPage(savedPage);
  } catch (e) {}
}

// Responsive: redraw chart on resize (debounced)
let _resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(() => {
    if (!document.getElementById('seasonalsPage')?.hidden) {
      renderSeasonalsPage();
      return;
    }
    if (!document.getElementById('smtPage')?.hidden) {
      renderSmtCharts();
      return;
    }
    if (document.getElementById('overviewPage')?.hidden) return;
    const key = chartState.key;
    if (!key) return;
    const meta = INDEX[key];
    const cat = meta && catCache[meta.slug];
    if (cat && cat[key]) loadChart(cat[key]);
  }, 150);
});


  /* Live Eastern Time in the top-right header */
  (function(){
    var clock = document.getElementById('clock');
    var dateEl = document.querySelector('.hdr-date');
    if (!clock) return;
    var timeFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      timeZoneName: 'short'
    });
    var dateFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      month: 'short',
      day: '2-digit',
      year: 'numeric'
    });
    function tick(){
      var now = new Date();
      clock.textContent = timeFmt.format(now);
      if (dateEl) dateEl.textContent = dateFmt.format(now);
    }
    tick();
    setInterval(tick, 1000);
  })();
