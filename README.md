<p align="center">
  <img src="brand/charthorizon_logo.png" alt="ChartHorizon" width="420">
</p>

<p align="center">
  <b>Local-first commodity futures dashboard</b> — COT (commercials/hedgers), seasonals, screener &amp; FX strength.
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg"></a>
</p>

---

## Was ist ChartHorizon?

ChartHorizon ist ein **local-first** Dashboard fuer Rohstoff-Futures: Es zieht Marktdaten
ueber freie APIs, speichert sie lokal und rendert sie im Browser — ohne Cloud, Login oder
Tracking. Mit dabei: Futures-Charts, COT-Positionierung (Commercials/Hedger),
Saisonalitaet, ein Signal-Screener und eine FX-Staerke-Heatmap.

> ⚠️ Nur zu Informationszwecken — **keine Anlageberatung.**

## Starten

Du brauchst keine Coding-Erfahrung. Fuer den normalen Start klickst du nur eine
Datei doppelt an.

### Mac

Doppelklick auf:

`START_CHARTHORIZON.command`

Falls macOS beim ersten Mal blockiert:

1. Rechtsklick auf `START_CHARTHORIZON.command`
2. `Oeffnen` waehlen
3. Nochmal `Oeffnen` bestaetigen

### Windows

Doppelklick auf:

`START_CHARTHORIZON_WINDOWS.bat`

## Daten aktualisieren

Wenn du neue Marktdaten laden moechtest:

Mac:

`DATEN_AKTUALISIEREN.command`

Windows:

`DATEN_AKTUALISIEREN_WINDOWS.bat`

Die Aktualisierung prueft zuerst, ob die erwarteten yfinance-EOD-Daten bereits
lokal gespeichert sind. ChartHorizon erwartet neue yfinance-Tagesdaten ab ca.
`17:30 ET` (wegen Verzoegerung nach US-Futures-Boersenschluss). Wenn der lokale
Stand schon aktuell ist, wird kein neuer API-Download gestartet.

CFTC fuer Open Interest/COT wird nur im passenden Wochenfenster nach der
offiziellen COT-Veroeffentlichung neu abgefragt.

## Automatische Aktualisierung (nur Mac)

ChartHorizon kann die EOD-Daten automatisch einmal taeglich im Hintergrund
aktualisieren.

Einschalten:

`AUTO_UPDATE_AKTIVIEREN.command`

Danach laeuft die Aktualisierung jeden Tag um:

`23:30 Uhr` (Ortszeit dieses Macs)

Das ist fuer normale yfinance-EOD-Daten gedacht und entspricht ungefaehr
`17:30 ET`. Pro EOD-Zieltag laedt ChartHorizon maximal einmal neu; danach werden
die lokal gespeicherten JSON-/SQLite-Daten verwendet. CFTC-COT/Open-Interest-
Daten werden intern trotzdem nur einmal pro Woche aktualisiert: nach dem
CFTC-Release um 15:30 ET, mit einem kleinen Sicherheitsfenster. Wenn ein
US-Feiertag die CFTC-Veroeffentlichung verschiebt, wartet ChartHorizon auf den
naechsten bekannten Release-Termin.

Das Aktivieren-Skript merkt sich automatisch, wo der ChartHorizon-Ordner liegt.
Wenn du den Ordner spaeter verschiebst, einfach `AUTO_UPDATE_AKTIVIEREN.command`
noch einmal doppelklicken.

Der automatische Job erzeugt nur neue Daten und startet keinen Browser.
Die Seite nutzt danach beim naechsten Neuladen die aktualisierten Daten. Wenn
der Mac um 23:30 ausgeschaltet ist, holt macOS den Lauf beim naechsten
Einschalten nach.

Logs findest du hier:

`logs/auto_update.log`

Wieder ausschalten:

`AUTO_UPDATE_DEAKTIVIEREN.command`

Hinweis fuer Windows: Hier gibt es noch keine automatische Aktualisierung.
Unter Windows die Daten bei Bedarf manuell ueber
`DATEN_AKTUALISIEREN_WINDOWS.bat` neu laden.

## Im Dashboard

Der Hauptchart startet immer als Continuous Contract.

Wenn du in der Terminkurve eine Kontrakt-Zeile anklickst, wechselt der
Hauptchart auf genau diesen Einzelkontrakt. Oben im Chart erscheint dann neben
`Continuous` ein Button mit dem Kontraktsymbol, zum Beispiel `CLN26`.

Mit `Continuous` wechselst du wieder zurueck zum Continuous Contract.

## Was passiert beim Start?

Das normale Startfenster startet schnell mit den vorhandenen Dashboard-Dateien.
Wenn noch keine Dateien vorhanden sind, werden sie automatisch erzeugt.

Die Aktualisieren-Datei erledigt automatisch alles:

1. Es prueft, ob die benoetigten Python-Pakete vorhanden sind.
2. Es installiert fehlende Pakete wie `yfinance`, `pypdf` und `curl_cffi`
   automatisch.
3. Es laedt aktuelle Futures-, COT- und Open-Interest-Daten.
4. Es erzeugt das Dashboard neu.
5. Es startet einen lokalen Webserver.
6. Es oeffnet die Seite im Browser.

Wenn die erwarteten yfinance-EOD-Daten bereits lokal vorhanden sind, werden die
Schritte 3 und 4 uebersprungen, damit der Start schneller bleibt.

Der erste Start kann ein paar Minuten dauern, weil viele Marktdaten geladen
werden.

## Beenden

Das Terminal-/Konsolenfenster offen lassen, solange du das Dashboard nutzen
moechtest.

Zum Beenden im Fenster `Ctrl + C` druecken. Auf deutschen Tastaturen ist das
meist `Strg + C`.

## Ordnerstruktur

```text
Chart Horizon/
  START_CHARTHORIZON.command       <- Mac: hier doppelklicken
  START_CHARTHORIZON_WINDOWS.bat   <- Windows: hier doppelklicken
  DATEN_AKTUALISIEREN.command      <- Mac: Daten neu laden
  DATEN_AKTUALISIEREN_WINDOWS.bat
  AUTO_UPDATE_AKTIVIEREN.command   <- Mac: taegliches Update einschalten
  AUTO_UPDATE_DEAKTIVIEREN.command <- Mac: taegliches Update ausschalten
  AUTO_UPDATE_CHARTHORIZON.command <- Mac: wird vom Auto-Update aufgerufen
  com.charthorizon.daily-update.plist <- Vorlage fuer macOS LaunchAgent
  README.md                        <- diese Anleitung
  LICENSE                          <- GNU AGPL-3.0
  logs/                            <- automatische Update-Logs
  app/                             <- technische Dateien
    start.py
    commodity_dashboard.py
    index.html
    web/
    ff_data/
```

Den Ordner `app` musst du normalerweise nicht anfassen.

## Wichtig

Bitte nicht nur `index.html` per Doppelklick oeffnen. Die Seite
braucht den lokalen Webserver, weil die Daten aus `ff_data/` nachgeladen werden.
Darum immer ueber die Startdatei starten.

## Voraussetzung

Es muss Python 3 installiert sein.

Auf dem Mac ist Python oft schon vorhanden. Falls nicht, installiere Python von:

https://www.python.org/downloads/

Danach wieder `START_CHARTHORIZON.command` doppelklicken.

## Datenquellen & Rechtliches

- **Preisdaten, Charts und Saisonalitaet** kommen ueber [yfinance](https://github.com/ranaroussi/yfinance) (Yahoo Finance) und sind fuer die **persoenliche Nutzung** gedacht. ChartHorizon ist *local-first*: Jede Installation laedt die Daten selbst auf den eigenen Rechner — es werden **keine** Preisdaten weiterverbreitet.
- **COT und Open Interest** stammen von der **CFTC** (US-Behoerde) und sind gemeinfrei (public domain).
- Die Forex-Ansicht bettet zum Anschauen das **TradingView**-Widget ein.
- Alle Inhalte dienen **nur zu Informationszwecken** und sind **keine Anlageberatung**.

### Lizenz

ChartHorizon steht unter der **GNU AGPL-3.0** (siehe [`LICENSE`](LICENSE)): nutzen,
studieren, anpassen und weitergeben ist erlaubt; wer es als Netzwerk-Dienst betreibt,
muss seine Aenderungen offenlegen.
