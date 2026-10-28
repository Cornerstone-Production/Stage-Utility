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
# server's version, with the release signing key the updater verifies every new
# launcher against. From a copy that was not fetched from a server, say where to
# download from:  $env:STAGE_DOWNLOAD_FROM = 'http://<server>:<port>'
#
# A PC that already has the release signing key keeps it when this runs again. To
# take the server's in its place (rotating the key):
#   $env:STAGE_REPLACE_SIGNING_KEY = '1'

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

# Where the launcher and the updater are downloaded from, best first, and so the
# server the updater asks from then on: STAGE_DOWNLOAD_FROM (which does not pin the
# PC), the server this PC is pinned to as it is installed (STAGE_SERVER), the server
# this installer came from, the server it is already pinned to.
# A server root and nothing else: the same pattern as kiosk-update-windows.ps1's
# and is_origin in install-macos.sh (scripts/origin-shape.test.ts).
$OriginPattern = '^https?://([A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*|\[[0-9A-Fa-f:.]{2,45}\])(:[0-9]{1,5})?$'

function Get-DownloadOrigin {
  $pinned = Join-Path $StateDir 'server'
  $candidates = @($env:STAGE_DOWNLOAD_FROM, $env:STAGE_SERVER, $FetchedFrom)
  if (Test-Path -LiteralPath $pinned) { $candidates += ([string](Get-Content -LiteralPath $pinned -Raw)).Trim() }
  foreach ($candidate in $candidates) {
    if (-not $candidate) { continue }
    $origin = $candidate.Trim().TrimEnd('/')
    # A server root, the shape kiosk-update-windows.ps1 and the server's HOST_RE
    # admit: anything else is refused here rather than downloaded from.
    if ($origin -notmatch $OriginPattern) {
      throw "$origin is not a server address (http://<host>:<port>, nothing after it)"
    }
    return $origin
  }
  return ''
}

# One script from the server, parsed before it replaces anything. With an $Accept
# block, it is given the download's SHA-256 first and throws to refuse the file.
# It is staged in Program Files, under a name nobody could have guessed, never
# beside $To: the state folder in ProgramData lets any user create files, and one
# who pre-created the staging file would still own it after it was moved into place.
function Save-KioskScript([string]$From, [string]$Name, [string]$To, [scriptblock]$Accept = $null) {
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  $temp = Join-Path $AppDir ('{0}.{1}.tmp' -f $Name, [guid]::NewGuid().ToString('N'))
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "$From/kiosk/$Name" -OutFile $temp
    if ($Accept) { & $Accept (Get-FileHash -Algorithm SHA256 -LiteralPath $temp).Hash.ToLowerInvariant() }
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($temp, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { throw "$Name from $From does not parse: $($errors[0].Message)" }
    Move-Item -Force -LiteralPath $temp -Destination $To
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -Force -LiteralPath $temp }
  }
}

# The launcher, held to the same standard as an update: the download must have the
# SHA-256 the server names for it in GET /api/machine-updates/check, the check the
# updater makes. The check is made about the file that was downloaded (that digest
# is what this PC will have), so the server lists the PC with the launcher it is
# about to run, and the digest is read whatever the answer says about updating: the
# operator's switch holds updates, not a first install. Nothing is installed
# without a digest, so a server that does not answer is a launcher not installed.
# This check lists the PC in Screens, and the updater's first check replaces it.
function Install-Launcher([string]$From, [string]$Machine, [string]$To) {
  $accept = {
    param([string]$Got)
    $query = 'machine={0}&platform=windows&have={1}&host={2}' -f [uri]::EscapeDataString($Machine), $Got, [uri]::EscapeDataString([string]$env:COMPUTERNAME)
    $answer = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$From/api/machine-updates/check?$query").Content | ConvertFrom-Json
    $want = [string]$answer.version
    if ($want -notmatch '^[0-9a-f]{64}$') { throw "$From did not name a SHA-256 for the launcher" }
    if ($Got -ne $want) { throw "kiosk-windows.ps1 from $From has SHA-256 $Got, expected $want" }
  }.GetNewClosure()
  Save-KioskScript -From $From -Name 'kiosk-windows.ps1' -To $To -Accept $accept
}

# The release signing key the updater checks every launcher's signature against,
# in Program Files beside the updater. The updater never fetches one. A PC that
# already has one keeps it, so running the installer again does not let a server
# swap it; $env:STAGE_REPLACE_SIGNING_KEY = '1' takes the server's in its place,
# for rotating the key. Otherwise, on a first install, it is the server's: the one
# time the server is trusted with it. Refused unless .NET reads it as a 3072-bit
# RSA key.
function Save-SigningKey([string]$From) {
  $to = Join-Path $AppDir 'release-signing.pub.xml'
  if ((Test-Path -LiteralPath $to) -and $env:STAGE_REPLACE_SIGNING_KEY -ne '1') {
    # Not Write-Output: Install-Updater's output is its answer, and '' means installed.
    Write-Information -InformationAction Continue "    keeping the release signing key already installed ($to); set STAGE_REPLACE_SIGNING_KEY=1 to take the server's"
    return
  }
  $temp = Join-Path $AppDir ('release-signing.{0}.tmp' -f [guid]::NewGuid().ToString('N'))
  try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 60 -Uri "$From/kiosk/release-signing.pub.xml" -OutFile $temp
    $rsa = [Security.Cryptography.RSA]::Create()
    try {
      try { $rsa.FromXmlString([IO.File]::ReadAllText($temp)) } catch { throw "the release signing key from $From is not an RSA key" }
      if ($rsa.KeySize -ne 3072) { throw "the release signing key from $From is a $($rsa.KeySize)-bit key, not 3072-bit" }
    } finally {
      $rsa.Dispose()
    }
    Move-Item -Force -LiteralPath $temp -Destination $to
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
    Save-SigningKey -From $From
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
# download is checked against, here and in the updater, and Set-Content would
# re-encode it.
$Launcher = Join-Path $StateDir 'kiosk.ps1'
try {
  Install-Launcher -From $Origin -Machine (Get-Content $IdFile -Raw).Trim() -To $Launcher
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
  Write-Output '    and a new one takes effect at the next sign-in.'
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
