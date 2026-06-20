#!/usr/bin/env bash
# Build the macOS .dmg. Usage: packaging/macos/build_dmg.sh <version>
set -euo pipefail
VERSION="${1:?usage: build_dmg.sh <version>}"
cd "$(dirname "$0")/../.."            # -> dashboard/
python3 packaging/build_icons.py
python3 -m PyInstaller packaging/charthorizon.spec --noconfirm --clean
APP="dist/ChartHorizon.app"
DMG="dist/ChartHorizon-${VERSION}-macOS.dmg"
STAGE="dist/dmg-stage"

# Drag-to-install layout: the volume shows ChartHorizon.app next to an
# "Applications" symlink, so the user drags the app onto it to install. A bare
# .app (no Applications target) leaves non-technical users with nowhere to
# install to.
rm -rf "$STAGE" "$DMG"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/ChartHorizon.app"
ln -s /Applications "$STAGE/Applications"

hdiutil create -volname "ChartHorizon" -srcfolder "$STAGE" -ov -format UDZO "$DMG"
rm -rf "$STAGE"
echo "Built: $DMG"
