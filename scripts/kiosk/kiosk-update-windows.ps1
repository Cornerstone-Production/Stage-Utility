# Keeps this PC's kiosk launcher on the server's version.
#
# install-windows.ps1 puts this in %ProgramFiles%\StageUtility\kiosk-update.ps1 and
# registers it as the scheduled task StageUtilityKioskUpdate, which runs it as
# SYSTEM every five minutes. It lives in Program Files, which only an
# administrator can write to, because it runs as SYSTEM; the state folder in
# ProgramData lets any user create files.
#
# Each run asks the server GET /api/machine-updates/check whether the launcher
# (kiosk.ps1 in the state folder) should be replaced. The server decides (the
# operator's switch, and a version that already failed here); this does what the
# answer says. Replacing a file restarts nothing, so service times do not hold it. To replace it, it
# downloads kiosk-windows.ps1, checks its SHA-256 against the one the server
# named, checks that it parses, and only then moves it over kiosk.ps1. Nothing is
# restarted: the new launcher runs at the next sign-in or when the browser exits.
# Any failure leaves kiosk.ps1 as it was and is reported on the next check, after
# which the server does not offer that version again until someone asks from
# Screens.
#
# Which server: the `server` file in the state folder when there is one (it pins
# this PC to a server), else `update-from` beside this script, which is the
# server the installer was fetched from.
#
# Its own record of what it last did is status.json beside this script: state
# (idle, updated or failed), target (the digest that state is about), detail (why
# it failed) and answer (the last reason the server gave, or "unreachable", so
# the log says a thing once). The log is kiosk-update.log beside this script, not in
# the state folder: SYSTEM writes it, and a standard user could leave a link in
# ProgramData for SYSTEM to write through. One line for each change of the
# server's reason or of the outcome, never one every five minutes.
#
# Test hook, not for use on a PC: STAGE_KIOSK_TEST_ROOT replaces both
# %ProgramData%\StageUtility and %ProgramFiles%\StageUtility with folders under
# it (ProgramData\StageUtility and ProgramFiles\StageUtility), so the tests can run
# this under pwsh on macOS or Linux against a fake server.
#
# Plain ASCII with no byte-order mark, and it runs under Windows PowerShell 5.1 as
# well as pwsh. See scripts/lint-powershell.ps1.
$ErrorActionPreference = 'Stop'

if ($env:STAGE_KIOSK_TEST_ROOT) {
  $StateDir = Join-Path (Join-Path $env:STAGE_KIOSK_TEST_ROOT 'ProgramData') 'StageUtility'
  $AppDir   = Join-Path (Join-Path $env:STAGE_KIOSK_TEST_ROOT 'ProgramFiles') 'StageUtility'
} else {
  # ProgramW6432 is the real Program Files even from a 32-bit PowerShell, where
  # ProgramFiles names the x86 one.
  $programFiles = if ($env:ProgramW6432) { $env:ProgramW6432 } else { $env:ProgramFiles }
  $StateDir = Join-Path $env:ProgramData 'StageUtility'
  $AppDir   = Join-Path $programFiles 'StageUtility'
}
$Launcher   = Join-Path $StateDir 'kiosk.ps1'
$StatusFile = Join-Path $AppDir 'status.json'
$LogFile    = Join-Path $AppDir 'kiosk-update.log'
$Utf8       = New-Object System.Text.UTF8Encoding $false

# One line in the log, and on the console for a person running this by hand. Only
# called where the output is not a return value.
function Write-UpdateLog([string]$Text) {
  $line = '{0} [helper-update] {1}' -f [DateTime]::UtcNow.ToString('yyyy-MM-ddTHH:mm:ssZ'), ($Text -replace '[\r\n]+', ' ')
  New-Item -ItemType Directory -Force -Path (Split-Path $LogFile) | Out-Null
  [IO.File]::AppendAllText($LogFile, $line + "`n", $Utf8)
  Write-Output $line
}

# What this updater last did. A file that is missing or not JSON reads as idle.
function Read-Status {
  $status = @{ state = 'idle'; target = ''; detail = ''; answer = '' }
  if (-not (Test-Path -LiteralPath $StatusFile)) { return $status }
  $saved = Get-Content -LiteralPath $StatusFile -Raw | ConvertFrom-Json -ErrorAction SilentlyContinue
  if (-not $saved) { return $status }
  foreach ($key in @($status.Keys)) {
    if ($saved.$key -is [string]) { $status[$key] = $saved.$key }
  }
  return $status
}

function Write-Status([string]$State, [string]$Target, [string]$Detail, [string]$Answer) {
  $cut = { param($s, $n) $one = $s -replace '[\r\n]+', ' '; if ($one.Length -gt $n) { $one.Substring(0, $n) } else { $one } }
  New-Item -ItemType Directory -Force -Path $AppDir | Out-Null
  $json = [ordered]@{
    state  = $State
    target = $Target
    detail = (& $cut $Detail 200)
    answer = (& $cut $Answer 300)
  } | ConvertTo-Json -Compress
  [IO.File]::WriteAllText($StatusFile, $json, $Utf8)
}

# A server root and nothing else: the same shape as HOST_RE in
# main/services/kiosk-installer-origin.ts and is_origin in install-macos.sh.
$OriginPattern = '^https?://([A-Za-z0-9.-]+|\[[0-9A-Fa-f:.]+\])(:[0-9]{1,5})?$'

function Read-Origin([string]$File) {
  if (-not (Test-Path -LiteralPath $File)) { return '' }
  $text = ([string](Get-Content -LiteralPath $File -Raw)).Trim().TrimEnd('/')
  if ($text -match $OriginPattern) { return $text }
  return ''
}

# Record this check's answer (the server's reason, or why there was none) and say
# it only when it differs from the last one: a check every five minutes must not
# be a log line every five minutes.
function Write-Answer($Status, [string]$Answer, [string]$Message) {
  if ($Status.answer -ne $Answer) { Write-UpdateLog $Message }
  Write-Status -State $Status.state -Target $Status.target -Detail $Status.detail -Answer $Answer
}

# Ask the server what to do with the launcher whose digest is $Have.
function Invoke-Check([string]$Origin, [string]$Have, [string]$Machine, $Status) {
  $pairs = [ordered]@{
    machine  = $Machine
    platform = 'windows'
    have     = $Have
    host     = $env:COMPUTERNAME
    state    = $Status.state
    target   = $Status.target
    detail   = $Status.detail
  }
  $query = ($pairs.Keys | ForEach-Object { '{0}={1}' -f $_, [uri]::EscapeDataString([string]$pairs[$_]) }) -join '&'
  $response = Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$Origin/api/machine-updates/check?$query"
  return ($response.Content | ConvertFrom-Json)
}

# Replace the launcher with the one the server serves, or throw why not. The old
# kiosk.ps1 is not touched until the new one has been downloaded, matched the
# digest the server named, and parsed.
function Install-NewLauncher([string]$Origin, [string]$Want) {
  if ($Want -notmatch '^[0-9a-f]{64}$') { throw 'the server said to update but did not name a SHA-256 for the new launcher' }
  $item = Get-Item -LiteralPath $Launcher -Force
  if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
    throw "$Launcher is a link, not a file, and is not replaced"
  }
  $temp = Join-Path $AppDir ('kiosk-windows.{0}.tmp' -f [guid]::NewGuid().ToString('N'))
  try {
    # -OutFile writes the bytes exactly as served, which the digest is over.
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 30 -Uri "$Origin/kiosk/kiosk-windows.ps1" -OutFile $temp
    $got = (Get-FileHash -Algorithm SHA256 -LiteralPath $temp).Hash.ToLowerInvariant()
    # Short enough that the whole of it fits in the 200 characters the server keeps.
    if ($got -ne $Want) { throw "the download has SHA-256 $got, expected $Want" }
    $tokens = $null
    $errors = $null
    [void][System.Management.Automation.Language.Parser]::ParseFile($temp, [ref]$tokens, [ref]$errors)
    if ($errors -and $errors.Count -gt 0) { throw "the launcher downloaded from $Origin does not parse: $($errors[0].Message)" }
    Move-Item -Force -LiteralPath $temp -Destination $Launcher
  } finally {
    if (Test-Path -LiteralPath $temp) { Remove-Item -Force -LiteralPath $temp }
  }
}

function Invoke-Updater {
  $status = Read-Status
  $idFile = Join-Path $StateDir 'device-id'
  if (-not (Test-Path -LiteralPath $idFile) -or -not (Test-Path -LiteralPath $Launcher)) {
    Write-Answer -Status $status -Answer 'not-installed' -Message "there is no device id or kiosk.ps1 in $StateDir, so there is nothing to update; run the installer again"
    return
  }
  $machine = ([string](Get-Content -LiteralPath $idFile -Raw)).Trim()
  $have = (Get-FileHash -Algorithm SHA256 -LiteralPath $Launcher).Hash.ToLowerInvariant()

  $pinned = Read-Origin -File (Join-Path $StateDir 'server')
  $origin = if ($pinned) { $pinned } else { Read-Origin -File (Join-Path $AppDir 'update-from') }
  if (-not $origin) {
    Write-Answer -Status $status -Answer 'no-server' -Message "there is no server to ask: no server file in $StateDir and no update-from in $AppDir; run the installer again"
    return
  }

  try {
    $answer = Invoke-Check -Origin $origin -Have $have -Machine $machine -Status $status
  } catch {
    Write-Answer -Status $status -Answer 'unreachable' -Message "$origin did not answer the update check ($($_.Exception.Message)); trying again in five minutes"
    return
  }
  $reason = [string]$answer.reason
  Write-Answer -Status $status -Answer $reason -Message "${origin}: $reason"
  if ($answer.update -ne $true) { return }

  # For a Windows kiosk the server's version is the digest of its launcher.
  $want = [string]$answer.version
  Write-UpdateLog "updating the launcher from $($have.Substring(0, 12)) to $($want.Substring(0, [Math]::Min(12, $want.Length))), from $origin"
  try {
    Install-NewLauncher -Origin $origin -Want $want
  } catch {
    $why = $_.Exception.Message
    Write-Status -State 'failed' -Target $want -Detail $why -Answer $reason
    Write-UpdateLog "the update to $want failed: $why. kiosk.ps1 is unchanged, and it is not tried again until someone asks from Screens."
    return
  }
  Write-Status -State 'updated' -Target $want -Detail '' -Answer $reason
  Write-UpdateLog 'updated kiosk.ps1; the new launcher runs at the next sign-in or when the browser exits'
}

try {
  Invoke-Updater
} catch {
  # Not something the server's answer explains: say it, and fail the task so
  # Task Scheduler shows it.
  Write-UpdateLog "the updater stopped: $($_.Exception.Message)"
  exit 1
}
