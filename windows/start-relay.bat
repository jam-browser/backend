@echo off
rem Run the Jam relay in this window for a quick test (close the window to stop).
rem For an always-on server with automatic updates use install.ps1 instead.
cd /d "%~dp0.."
if not exist node_modules\ws (
  echo Installing dependencies...
  call npm ci --omit=dev --no-fund --no-audit
)
if "%PORT%"=="" set PORT=3031
echo Starting Jam relay on port %PORT% ...
node jam-relay.js
pause
