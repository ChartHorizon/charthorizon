#!/bin/zsh

# Aktiviert die taegliche automatische EOD-Aktualisierung (macOS LaunchAgent).
# Der Pfad wird automatisch aus dem aktuellen Ordner ermittelt – egal, wohin
# du den ChartHorizon-Ordner verschiebst.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.charthorizon.daily-update"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$ROOT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"
chmod +x "$ROOT_DIR/AUTO_UPDATE_CHARTHORIZON.command" 2>/dev/null

echo "============================================================"
echo "ChartHorizon Auto Update wird aktiviert"
echo "============================================================"
echo "Ordner: $ROOT_DIR"
echo "Zeit:   taeglich 23:30 Uhr (Ortszeit dieses Macs)"
echo

cat > "$PLIST_DST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>$ROOT_DIR/AUTO_UPDATE_CHARTHORIZON.command</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT_DIR</string>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>23</integer>
    <key>Minute</key>
    <integer>30</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>$ROOT_DIR/logs/auto_update.log</string>

  <key>StandardErrorPath</key>
  <string>$ROOT_DIR/logs/auto_update_error.log</string>
</dict>
</plist>
PLIST

# Falls schon geladen: erst entladen, dann frisch laden.
launchctl unload "$PLIST_DST" 2>/dev/null
launchctl load -w "$PLIST_DST"

echo
if launchctl list | grep -q "$LABEL"; then
  echo "Aktiviert. Die Aktualisierung laeuft jetzt taeglich um 23:30 Uhr."
  echo "Wenn der Mac um 23:30 aus ist, holt macOS den Lauf beim naechsten"
  echo "Einschalten nach."
else
  echo "Konnte den Status nicht sicher bestaetigen."
  echo "Pruefe ggf. unter Systemeinstellungen > Allgemein > Anmeldeobjekte."
fi
echo
echo "Logs:    $ROOT_DIR/logs/auto_update.log"
echo "Beenden: AUTO_UPDATE_DEAKTIVIEREN.command"
echo
echo "Dieses Fenster kann jetzt geschlossen werden."
read -r "?Enter druecken zum Schliessen..."
