#!/bin/zsh

cd "$(dirname "$0")/app" || exit 1
clear

echo "ChartHorizon Daten werden aktualisiert..."
echo "Das kann ein paar Minuten dauern."
echo

python3 start.py --refresh
status=$?

echo
if [ $status -ne 0 ]; then
  echo "Die Aktualisierung konnte nicht abgeschlossen werden."
  echo "Pruefe bitte deine Internetverbindung und ob Python 3 installiert ist."
else
  echo "ChartHorizon wurde beendet."
fi
echo
echo "Dieses Fenster kann jetzt geschlossen werden."
read -r "?Enter druecken zum Schliessen..."
