#!/bin/zsh

PLIST_SRC="$(cd "$(dirname "$0")" && pwd)/com.charthorizon.daily-update.plist"
PLIST_DST="$HOME/Library/LaunchAgents/com.charthorizon.daily-update.plist"

echo "Disabling ChartHorizon Auto Update..."

launchctl unload "$PLIST_DST" 2>/dev/null
rm -f "$PLIST_DST"

echo
echo "Disabled."
echo "You can close this window now."
read -r "?Press Enter to close..."
