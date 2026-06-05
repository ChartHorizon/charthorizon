@echo off
cd /d "%~dp0app"
cls

echo ChartHorizon is updating its data...
echo This may take a few minutes.
echo.

where py >nul 2>nul
if %errorlevel%==0 (
  py -3 start.py --refresh
) else (
  python start.py --refresh
)

echo.
echo You can close this window now.
pause
