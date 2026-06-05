@echo off
cd /d "%~dp0app"
cls

echo Starting ChartHorizon...
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start.py
) else (
  python start.py
)

echo.
echo You can close this window now.
pause
