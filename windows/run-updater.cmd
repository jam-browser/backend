@echo off
rem Checks for a newer signed Jam relay release. Started by the "Jam Relay Updater" scheduled task.
setlocal
cd /d "%~dp0"
if not exist logs mkdir logs
set VER=
set /p VER=<current.txt
node "versions\%VER%\updater.js" --home "%~dp0." >> logs\updater.log 2>&1
