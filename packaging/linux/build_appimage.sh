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
# Minimal 1x1 icon placeholder (replace with the real icon in a later polish pass).
printf '\x89PNG\r\n\x1a\n' > "$APPDIR/charthorizon.png"
ARCH=x86_64 appimagetool --appimage-extract-and-run "$APPDIR" dist/ChartHorizon-x86_64.AppImage
echo "OK: dist/ChartHorizon-x86_64.AppImage"
