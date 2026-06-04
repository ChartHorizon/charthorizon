#!/bin/zsh

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="$ROOT_DIR/app"

mkdir -p "$ROOT_DIR/logs"

echo "============================================================"
echo "ChartHorizon Auto Update"
echo "Start: $(date '+%Y-%m-%d %H:%M:%S %Z')"
echo "============================================================"
echo

cd "$APP_DIR" || exit 1
python3 start.py --refresh --no-serve
status=$?

echo
if [ $status -eq 0 ]; then
  echo "Fertig: $(date '+%Y-%m-%d %H:%M:%S %Z')"
else
  echo "Fehler: $(date '+%Y-%m-%d %H:%M:%S %Z')"
fi


exit $status
