#!/usr/bin/env bash
# Wrap the PyInstaller onedir (dist/ChartHorizon) into dist/ChartHorizon-x86_64.AppImage.
# Expects appimagetool on PATH (the CI installs it).
set -euo pipefail
cd "$(dirname "$0")/../.."
APPDIR="dist/ChartHorizon.AppDir"
rm -rf "$APPDIR"; mkdir -p "$APPDIR/usr/bin"
cp -R dist/ChartHorizon/* "$APPDIR/usr/bin/"
cat > "$APPDIR/AppRun" <<'EOF'
#!/bin/sh
HERE="$(dirname "$(readlink -f "$0")")"
exec "$HERE/usr/bin/ChartHorizon" "$@"
EOF
chmod +x "$APPDIR/AppRun"
cat > "$APPDIR/charthorizon.desktop" <<'EOF'
[Desktop Entry]
Name=ChartHorizon
Exec=ChartHorizon
Icon=charthorizon
Type=Application
Terminal=false
Categories=Office;Finance;
EOF
# App icon (sun logo). The .desktop Icon= references "charthorizon"; appimagetool also
# uses the top-level .DirIcon for the AppImage's own thumbnail.
cp packaging/icons/charthorizon.png "$APPDIR/charthorizon.png"
cp packaging/icons/charthorizon.png "$APPDIR/.DirIcon"
ARCH=x86_64 appimagetool --appimage-extract-and-run "$APPDIR" dist/ChartHorizon-x86_64.AppImage
echo "OK: dist/ChartHorizon-x86_64.AppImage"
