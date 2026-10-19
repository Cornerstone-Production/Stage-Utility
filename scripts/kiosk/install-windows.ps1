# Turn this PC into a Stage Utility display.
#
#   irm http://<server>/kiosk/install-windows.ps1 | iex
#
# Best-effort, and honestly so: Windows is a general-purpose machine that sleeps,
# locks and reboots for updates on its own schedule. For a permanent wall screen a
# purpose-built Pi is the right tool. This is for a PC already sitting at FOH.
#
# What it needs from you, once:
#   * automatic login for this account (netplwiz)
#   * Power & sleep -> Screen and Sleep both set to Never
#
# Run in an ELEVATED PowerShell: the device id lives in ProgramData so that
# clearing a browser profile, or the user profile, cannot cost you a claim.
#
# The launcher (kiosk-windows.ps1) and an updater task (kiosk-update-windows.ps1) are
# downloaded from the server this was fetched from, so the launcher follows the
# server's version. From a copy that was not fetched from a server, say where to
# download from:  $env:STAGE_DOWNLOAD_FROM = 'http://<server>:<port>'

$ErrorActionPreference = 'Stop'

# The server stamps its own address over this line when it sends the installer, so
# the launcher and the updater can be downloaded from it. Empty when the file did
# not come from a server.
$FetchedFrom = ''

$StateDir = Join-Path $env:ProgramData 'StageUtility'
# ProgramW6432 is the real Program Files even from a 32-bit PowerShell.
$ProgramFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
$AppDir   = Join-Path $ProgramFiles 'StageUtility'
$Port     = if ($env:STAGE_KIOSK_PORT) { [int]$env:STAGE_KIOSK_PORT } else { 8789 }
$Server   = $env:STAGE_SERVER

# Where the launcher and the updater are downloaded from, best first: this download
# only (STAGE_DOWNLOAD_FROM), the server this PC is pinned to as it is installed
# (STAGE_SERVER), the server this installer came from, the server it is already
# pinned to.
function Get-DownloadOrigin {
  $pinned = Join-Path $StateDir 'server'
  $candidates = @($env:STAGE_DOWNLOAD_FROM, $env:STAGE_SERVER, $FetchedFrom)
  if (Test-Path -LiteralPath $pinned) { $candidates += ([string](Get-Content -LiteralPath $pinned -Raw)).Trim() }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $origin = $candidate.Trim().TrimEnd('/')
    # A server root, the shape kiosk-update-windows.ps1 and the server's HOST_RE
    # admit: anything else is refused here rather than downloaded from.
    if ($origin -notmatch '^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$') {
      throw "$origin is not a server address (http://<host>:<port>, nothing after it)"
    }
    return $origin
  }
  return ''
}

# One script from the server, parsed before it replaces anything.
function Save-KioskScript([string]$From, [string]$Name, [string]$To) {
  $temp = "$To.download"
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "$From/kiosk/$Name" -OutFile $temp
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($temp, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { throw "$Name from $From does not parse: $($errors[0].Message)" }
    Move-Item -Force -LiteralPath $temp -Destination $To
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -Force -LiteralPath $temp }
  }
}

# The updater: a SYSTEM task, so its script is in Program Files, where only an
# administrator can write. Returns why it could not be installed, or '' when it was.
function Install-Updater([string]$From) {
  try {
    New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
    $updater = Join-Path $AppDir 'kiosk-update.ps1'
    Save-KioskScript -From $From -Name 'kiosk-update-windows.ps1' -To $updater
    [IO.File]::WriteAllText((Join-Path $AppDir 'update-from'), $From)
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' `
      -Argument "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$updater`""
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date) `
      -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration ([TimeSpan]::MaxValue)
    $principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -MultipleInstances IgnoreNew -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
    Register-ScheduledTask -TaskName 'StageUtilityKioskUpdate' -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings -Force | Out-Null
    return ''
  } catch {
    return $_.Exception.Message
  }
}

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error 'Run this in an elevated PowerShell - the device id lives in ProgramData.'
  exit 1
}

$Origin = Get-DownloadOrigin
if (-not $Origin) {
  Write-Error 'This installer does not know which server to download from. Set STAGE_DOWNLOAD_FROM to its address (http://<server>:<port>) and run it again.'
  exit 1
}

Write-Output '==> Installing the Stage Utility kiosk agent'
New-Item -ItemType Directory -Force -Path $StateDir | Out-Null

# Generated ONCE. Re-running must never mint a new id, or this screen's binding
# is orphaned and needs re-claiming.
$IdFile = Join-Path $StateDir 'device-id'
if (-not (Test-Path $IdFile)) { [guid]::NewGuid().ToString() | Set-Content -NoNewline $IdFile }

# The device's own secret - pinned by the server the first time it is claimed.
$TokenFile = Join-Path $StateDir 'token'
if (-not (Test-Path $TokenFile)) {
  $bytes = New-Object byte[] 24
  [Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
  ($bytes | ForEach-Object { $_.ToString('x2') }) -join '' | Set-Content -NoNewline $TokenFile
}
if ($Server) { $Server | Set-Content -NoNewline (Join-Path $StateDir 'server') }
Write-Output "    device id: $(Get-Content $IdFile)"

# -- The launcher ------------------------------------------------------------
# Downloaded from the server rather than written from this script, so the launcher
# a PC runs is whatever the server has, and the updater below can replace it later.
# The bytes are kept exactly as served: the server's digest of the file is what the
# updater compares, and Set-Content would re-encode it.
$Launcher = Join-Path $StateDir 'kiosk.ps1'
try {
  Save-KioskScript -From $Origin -Name 'kiosk-windows.ps1' -To $Launcher
} catch {
  Write-Error "could not get the kiosk launcher from ${Origin}: $($_.Exception.Message) Set STAGE_DOWNLOAD_FROM to the server's address (http://<server>:<port>) and run this again."
  exit 1
}
[IO.File]::WriteAllText((Join-Path $StateDir 'port'), "$Port")

# -- Survive a reboot, and a browser that dies ------------------------------
# At logon, not at boot: this needs a desktop session to put a window on a
# screen, which is why automatic login is a prerequisite.
$action  = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$Launcher`""
# TWO triggers. -AtLogOn alone has no repetition, and -RestartCount only applies
# when a task FAILS -- so a kiosk browser that somebody closed cleanly, or that
# exited zero after a display change, was never relaunched, contrary to what the
# comment above this block claimed. The minute repetition is what actually makes
# it come back.
$atLogon = New-ScheduledTaskTrigger -AtLogOn
$repeat  = New-ScheduledTaskTrigger -Once -At (Get-Date) `
  -RepetitionInterval (New-TimeSpan -Minutes 1) -RepetitionDuration ([TimeSpan]::MaxValue)

# IgnoreNew, or the minute trigger stacks a second browser on top of the running
# one every minute until the machine is unusable.
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
  -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero)

Register-ScheduledTask -TaskName 'StageUtilityKiosk' -Action $action `
  -Trigger @($atLogon, $repeat) -Settings $settings -Force | Out-Null

# -- Keep the launcher on the server's version --------------------------------
$updaterWhy = Install-Updater -From $Origin
if ($updaterWhy) {
  Write-Warning "automatic launcher updates are NOT installed: $updaterWhy; run the installer again"
} else {
  Write-Output "==> The launcher now follows $Origin's version: it is checked every five minutes,"
  Write-Output '    and never replaced during a service.'
}

# Display sleep is the difference between a display and a black rectangle.
powercfg /change monitor-timeout-ac 0  2>$null
powercfg /change standby-timeout-ac 0  2>$null

Write-Output ''
Write-Output "==> Done. This screen is device $(Get-Content $IdFile)"
Write-Output '    It starts at the next logon. Open Screens in Stage Utility and'
Write-Output '    set it up under "Not set up yet".'
Write-Output ''
Write-Output '    Still to do by hand, once: enable automatic login (netplwiz).'
