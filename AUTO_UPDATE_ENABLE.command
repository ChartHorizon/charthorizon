#!/bin/zsh

# Enables the daily automatic EOD update (macOS LaunchAgent).
# The path is detected automatically from the current folder — no matter
# where you move the ChartHorizon folder.

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.charthorizon.daily-update"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

mkdir -p "$ROOT_DIR/logs"
mkdir -p "$HOME/Library/LaunchAgents"
chmod +x "$ROOT_DIR/AUTO_UPDATE_CHARTHORIZON.command" 2>/dev/null

echo "============================================================"
echo "Enabling ChartHorizon Auto Update"
echo "============================================================"
echo "Folder: $ROOT_DIR"
echo "Time:   daily at 23:30 (this Mac's local time)"
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

# If already loaded: unload first, then load fresh.
launchctl unload "$PLIST_DST" 2>/dev/null
launchctl load -w "$PLIST_DST"

echo
if launchctl list | grep -q "$LABEL"; then
  echo "Enabled. The update now runs daily at 23:30."
  echo "If the Mac is off at 23:30, macOS catches the run up the next"
  echo "time it is switched on."
else
  echo "Could not reliably confirm the status."
  echo "Check System Settings > General > Login Items if needed."
fi
echo
echo "Logs:    $ROOT_DIR/logs/auto_update.log"
echo "Disable: AUTO_UPDATE_DISABLE.command"
echo
echo "You can close this window now."
read -r "?Press Enter to close..."
