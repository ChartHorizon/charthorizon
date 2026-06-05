#!/usr/bin/env bash
# Wrap dist/ChartHorizon.app into dist/ChartHorizon-macOS.dmg (drag-to-Applications).
set -euo pipefail
cd "$(dirname "$0")/../.."
APP="dist/ChartHorizon.app"
OUT="dist/ChartHorizon-macOS.dmg"
[ -d "$APP" ] || { echo "FEHLER: $APP fehlt — erst pyinstaller laufen lassen" >&2; exit 1; }
rm -f "$OUT"
STAGE="$(mktemp -d)"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
hdiutil create -volname "ChartHorizon" -srcfolder "$STAGE" -ov -format UDZO "$OUT"
rm -rf "$STAGE"
echo "OK: $OUT"
