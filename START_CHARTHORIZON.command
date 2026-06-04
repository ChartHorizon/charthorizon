#!/bin/zsh

cd "$(dirname "$0")/app" || exit 1
clear

echo "ChartHorizon wird gestartet..."
echo

python3 start.py
status=$?

echo
if [ $status -ne 0 ]; then
  echo "ChartHorizon konnte nicht gestartet werden."
  echo "Pruefe bitte, ob Python 3 installiert ist: https://www.python.org/downloads/"
else
  echo "ChartHorizon wurde beendet."
fi
echo
echo "Dieses Fenster kann jetzt geschlossen werden."
read -r "?Enter druecken zum Schliessen..."
