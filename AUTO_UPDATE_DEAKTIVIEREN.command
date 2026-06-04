#!/bin/zsh

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.charthorizon.daily-update.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.charthorizon.daily-update.plist"

echo "ChartHorizon Auto Update wird deaktiviert..."

launchctl unload "$PLIST_DST" 2>/dev/null
rm -f "$PLIST_DST"

echo
echo "Deaktiviert."
echo "Dieses Fenster kann jetzt geschlossen werden."
read -r "?Enter druecken zum Schliessen..."
