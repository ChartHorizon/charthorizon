#!/usr/bin/env bash
# Build the macOS .dmg. Usage: packaging/macos/build_dmg.sh <version>
set -euo pipefail
VERSION="${1:?usage: build_dmg.sh <version>}"
cd "$(dirname "$0")/../.."            # -> dashboard/
python3 packaging/build_icons.py
python3 -m PyInstaller packaging/charthorizon.spec --noconfirm --clean
APP="dist/ChartHorizon.app"
DMG="dist/ChartHorizon-${VERSION}-macOS.dmg"
rm -f "$DMG"
hdiutil create -volname "ChartHorizon" -srcfolder "$APP" -ov -format UDZO "$DMG"
echo "Built: $DMG"
