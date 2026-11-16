# Removes the Jam relay tasks and firewall rule (run as Administrator).
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-InstallDir C:\JamRelay] [-RemoveFiles]
param([string]$InstallDir = "C:\JamRelay", [switch]$RemoveFiles)

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Please run this script as Administrator." -ForegroundColor Yellow; exit 1 }

foreach ($t in "Jam Relay", "Jam Relay Updater") {
  Stop-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $t -Confirm:$false -ErrorAction SilentlyContinue
}
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*jam-relay.js*" -or $_.CommandLine -like "*updater.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { $_.CommandLine -like "*run-relay.cmd*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Get-NetFirewallRule -DisplayName "Jam Relay*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($RemoveFiles -and (Test-Path $InstallDir)) { Remove-Item -Recurse -Force $InstallDir; Write-Host "Removed $InstallDir" }
Write-Host "Jam relay removed."
