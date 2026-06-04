@echo off
cd /d "%~dp0app"
cls

echo ChartHorizon Daten werden aktualisiert...
echo Das kann ein paar Minuten dauern.
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start.py --refresh
) else (
  python start.py --refresh
)

echo.
echo Dieses Fenster kann jetzt geschlossen werden.
pause
