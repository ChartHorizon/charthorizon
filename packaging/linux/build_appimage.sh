#!/usr/bin/env bash
# Build the Linux AppImage. Usage: packaging/linux/build_appimage.sh <version>
set -euo pipefail
VERSION="${1:?usage: build_appimage.sh <version>}"
cd "$(dirname "$0")/../.."            # -> dashboard/
python3 packaging/build_icons.py
python3 -m PyInstaller packaging/charthorizon.spec --noconfirm --clean

APPDIR="dist/ChartHorizon.AppDir"
rm -rf "$APPDIR"
mkdir -p "$APPDIR/usr/bin"
cp -r dist/ChartHorizon/* "$APPDIR/usr/bin/"
cp packaging/icons/icon.png "$APPDIR/charthorizon.png"

cat > "$APPDIR/charthorizon.desktop" <<EOF
[Desktop Entry]
Name=ChartHorizon
Exec=ChartHorizon
Icon=charthorizon
Type=Application
Categories=Office;Finance;
EOF

cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/bash
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/ChartHorizon" "$@"
EOF
chmod +x "$APPDIR/AppRun"

if [ ! -x appimagetool ]; then
  curl -fsSL -o appimagetool \
    "https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"
  chmod +x appimagetool
fi
# APPIMAGE_EXTRACT_AND_RUN: appimagetool is itself an AppImage and would need FUSE
# (libfuse.so.2) to mount-and-run — absent on GitHub ubuntu-latest. Extract-and-run
# unpacks it instead, so the build needs no FUSE on the runner.
ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 ./appimagetool "$APPDIR" "dist/ChartHorizon-${VERSION}-x86_64.AppImage"
echo "Built: dist/ChartHorizon-${VERSION}-x86_64.AppImage"
