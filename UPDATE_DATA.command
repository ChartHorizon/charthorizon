#!/bin/zsh

cd "$(dirname "$0")/app" || exit 1
clear

echo "ChartHorizon is updating its data..."
echo "This may take a few minutes."
echo

python3 start.py --refresh
status=$?

echo
if [ $status -ne 0 ]; then
  echo "The update could not be completed."
  echo "Please check your internet connection and that Python 3 is installed."
else
  echo "ChartHorizon has exited."
fi
echo
echo "You can close this window now."
read -r "?Press Enter to close..."
