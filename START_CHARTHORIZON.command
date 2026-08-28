#!/bin/zsh

cd "$(dirname "$0")/app" || exit 1
clear

echo "Starting ChartHorizon..."
echo

python3 start.py
# Not `status=$?`: in zsh `status` is a read-only synonym for `$?`, and assigning to
# it is a FATAL error in a non-interactive script. Everything below this line —
# the diagnostic help text and the "Press Enter to close" prompt — was never
# reached, so a failed start showed a raw zsh error instead of the hint.
rc=$?

echo
if [ $rc -ne 0 ]; then
  echo "ChartHorizon could not be started."
  echo "Please check that Python 3 is installed: https://www.python.org/downloads/"
else
  echo "ChartHorizon has exited."
fi
echo
echo "You can close this window now."
read -r "?Press Enter to close..."
