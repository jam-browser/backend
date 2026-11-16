@echo off
rem Keeps the Jam relay running. Started by the "Jam Relay" scheduled task.
rem When an update changes current.txt the relay exits by itself (when idle) and this loop starts the new version.
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
:loop
set VER=
set /p VER=<current.txt
if not exist "versions\%VER%\jam-relay.js" (
  echo [%date% %time%] version "%VER%" not found >> logs\relay.log
  if exist previous.txt copy /y previous.txt current.txt >nul
  ping -n 11 127.0.0.1 >nul
  goto loop
)
node "versions\%VER%\jam-relay.js" --config "%~dp0config.json" --home "%~dp0." >> logs\relay.log 2>&1
ping -n 3 127.0.0.1 >nul
goto loop
