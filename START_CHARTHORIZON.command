#!/bin/zsh

cd "$(dirname "$0")/app" || exit 1
clear

echo "Starting ChartHorizon..."
echo

python3 start.py
status=$?

echo
if [ $status -ne 0 ]; then
  echo "ChartHorizon could not be started."
  echo "Please check that Python 3 is installed: https://www.python.org/downloads/"
else
  echo "ChartHorizon has exited."
fi
echo
echo "You can close this window now."
read -r "?Press Enter to close..."
