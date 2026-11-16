# Jam relay - install as an always-on Windows service-like setup with automatic updates.
# Run from an extracted release (or a checkout) in an Administrator PowerShell:
#   powershell -ExecutionPolicy Bypass -File windows\install.ps1 [-InstallDir C:\JamRelay] [-Port 3031]
#        [-Pfx C:\certs\relay.pfx -PfxPass secret] [-NoAutoUpdate]
#
# Result:
#   C:\JamRelay\versions\<version>\   program files (one folder per version, previous kept for rollback)
#   C:\JamRelay\current.txt           version that should run
#   C:\JamRelay\config.json           port / certificate / auto-update settings
#   Task "Jam Relay"          starts at boot, keeps the relay running (LOCAL SERVICE account)
#   Task "Jam Relay Updater"  checks GitHub releases every 6 hours, installs only correctly signed versions
param(
  [string]$InstallDir = "C:\JamRelay",
  [int]$Port = 3031,
  [string]$Pfx = "",
  [string]$PfxPass = "",
  [switch]$NoAutoUpdate
)
$ErrorActionPreference = "Stop"

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) { Write-Host "Please run this script in an Administrator PowerShell." -ForegroundColor Yellow; exit 1 }

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { Write-Host "Node.js not found. Install it first:  winget install OpenJS.NodeJS.LTS" -ForegroundColor Yellow; exit 1 }

$src = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$pkg = Get-Content (Join-Path $src "package.json") -Raw | ConvertFrom-Json
$ver = $pkg.version
Write-Host "Installing Jam relay $ver to $InstallDir"

# 1. program files
$target = Join-Path $InstallDir "versions\$ver"
New-Item -ItemType Directory -Force -Path $target, (Join-Path $InstallDir "logs") | Out-Null
robocopy $src $target /E /XD .git dist test tools node_modules /XF .gitignore .gitattributes /NFL /NDL /NJH /NJS /NP | Out-Null
if (Test-Path (Join-Path $src "node_modules\ws")) {
  robocopy (Join-Path $src "node_modules") (Join-Path $target "node_modules") /E /NFL /NDL /NJH /NJS /NP | Out-Null
} else {
  Push-Location $target; npm ci --omit=dev --no-audit --no-fund; Pop-Location
}
Copy-Item (Join-Path $src "windows\run-relay.cmd") (Join-Path $InstallDir "run-relay.cmd") -Force
Copy-Item (Join-Path $src "windows\run-updater.cmd") (Join-Path $InstallDir "run-updater.cmd") -Force

# 2. settings (kept if already there, unless new values are given)
$cfgPath = Join-Path $InstallDir "config.json"
if (Test-Path $cfgPath) { $cfg = Get-Content $cfgPath -Raw | ConvertFrom-Json } else { $cfg = [pscustomobject]@{} }
$set = @{ port = $Port; repo = "jam-browser/backend"; autoUpdate = (-not $NoAutoUpdate) }
if ($Pfx) { $set.pfx = $Pfx; $set.pfxPass = $PfxPass }
foreach ($k in $set.Keys) { $cfg | Add-Member -NotePropertyName $k -NotePropertyValue $set[$k] -Force }
$cfg | ConvertTo-Json | Set-Content -Path $cfgPath -Encoding ASCII
Set-Content -Path (Join-Path $InstallDir "current.txt") -Value $ver -Encoding ASCII -NoNewline

# 3. permissions: the relay and the updater run as LOCAL SERVICE (no admin rights, no network share access).
#    The updater must write new versions + current.txt, so LOCAL SERVICE gets Modify on this folder only.
#    Normal users get no access (config.json may contain the certificate password).
icacls $InstallDir /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" "*S-1-5-18:(OI)(CI)F" "*S-1-5-19:(OI)(CI)M" | Out-Null

# 4. firewall
& (Join-Path $src "windows\open-firewall.ps1") -Port $Port

# 5. scheduled tasks
$principal = New-ScheduledTaskPrincipal -UserId "NT AUTHORITY\LOCALSERVICE" -LogonType ServiceAccount
$runSettings = New-ScheduledTaskSettingsSet -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -MultipleInstances IgnoreNew
$relayAction = New-ScheduledTaskAction -Execute (Join-Path $InstallDir "run-relay.cmd") -WorkingDirectory $InstallDir
Register-ScheduledTask -TaskName "Jam Relay" -Action $relayAction -Trigger (New-ScheduledTaskTrigger -AtStartup) -Principal $principal -Settings $runSettings -Force | Out-Null

$updAction = New-ScheduledTaskAction -Execute (Join-Path $InstallDir "run-updater.cmd") -WorkingDirectory $InstallDir
$every6h = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(10) -RepetitionInterval (New-TimeSpan -Hours 6)
$boot = New-ScheduledTaskTrigger -AtStartup
$boot.Delay = "PT10M"
$updSettings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName "Jam Relay Updater" -Action $updAction -Trigger @($every6h, $boot) -Principal $principal -Settings $updSettings -Force | Out-Null
if ($NoAutoUpdate) { Disable-ScheduledTask -TaskName "Jam Relay Updater" | Out-Null }

Stop-ScheduledTask -TaskName "Jam Relay" -ErrorAction SilentlyContinue
Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like "*jam-relay.js*" } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
Start-ScheduledTask -TaskName "Jam Relay"
Start-Sleep -Seconds 3
try { $v = (Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/version" -TimeoutSec 5).Content } catch { $v = "(not answering yet - see $InstallDir\logs\relay.log)" }

Write-Host ""
Write-Host "Done. Jam relay is running: $v" -ForegroundColor Green
Write-Host "  Port to forward / open : TCP $Port"
Write-Host "  Address for the app    : <this server's public IP or domain>:$Port"
Write-Host "  Logs                   : $InstallDir\logs"
Write-Host "  Auto update            : $(if ($NoAutoUpdate) { 'off' } else { 'every 6 hours, signed releases only' })"
