@echo off
cd /d "%~dp0app"
cls

echo ChartHorizon wird gestartet...
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start.py
) else (
  python start.py
)

echo.
echo Dieses Fenster kann jetzt geschlossen werden.
pause
