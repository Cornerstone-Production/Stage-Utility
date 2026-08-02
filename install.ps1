# Stage Utility installer — Windows.
#
#   irm https://raw.githubusercontent.com/Cornerstone-Production/Stage-Utility/main/install.ps1 | iex
#
# Downloads the release archive, verifies it against the published checksums, and
# registers a startup task that keeps it running. Nothing is built here and no
# toolchain is needed: the archive carries its own Node runtime.
#
# Options (environment):
#   STAGE_TRACK    main | beta          which release line to follow (default: main)
#   STAGE_VERSION  v1.9.2               pin an exact release
#   STAGE_PREFIX   C:\Program Files\…   where to install
#   STAGE_DATA     C:\ProgramData\…     where config and history live
#   STAGE_PORT     8788                 the port to serve on

$ErrorActionPreference = "Stop"

$repo    = if ($env:STAGE_REPO)   { $env:STAGE_REPO }   else { "Cornerstone-Production/Stage-Utility" }
$track   = if ($env:STAGE_TRACK)  { $env:STAGE_TRACK }  else { "main" }
$port    = if ($env:STAGE_PORT)   { $env:STAGE_PORT }   else { "8788" }
$prefix  = if ($env:STAGE_PREFIX) { $env:STAGE_PREFIX } else { "$env:ProgramFiles\Stage Utility" }
$data    = if ($env:STAGE_DATA)   { $env:STAGE_DATA }   else { "$env:ProgramData\stage-utility" }
$taskName = "StageUtility"

function Say  ($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Fail ($m) { Write-Host "error $m" -ForegroundColor Red; Write-UpdateResult $false $m; exit 1 }

# ── Update protocol (optional) ────────────────────────────────────────────────
# Mirrors install.sh. When the app drives this script it passes these paths and
# polls them to narrate the update; run by hand, both are unset and these are
# no-ops. The format matches scripts/update.sh, which is why driving the
# installer from the app needs no UI change.
function Write-UpdateProgress ($Step) {
  if (-not $env:STAGE_UPDATE_PROGRESS) { return }
  $at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  "{`"step`":`"$Step`",`"at`":`"$at`"}" | Set-Content -Path $env:STAGE_UPDATE_PROGRESS -Encoding utf8
}
function Write-UpdateResult ($Ok, $ErrorText) {
  if (-not $env:STAGE_UPDATE_RESULT) { return }
  $at = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
  $b = if ($Ok) { "true" } else { "false" }
  "{`"ok`":$b,`"error`":`"$ErrorText`",`"at`":`"$at`"}" | Set-Content -Path $env:STAGE_UPDATE_RESULT -Encoding utf8
}

# Administrator is required to write under Program Files and register a task that
# runs at boot. Checked before anything is downloaded or written.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
  [Security.Principal.WindowsIdentity]::GetCurrent()
).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Fail @"
Run this from an Administrator PowerShell — it installs a service.

  Right-click PowerShell -> Run as Administrator, then:
  irm https://raw.githubusercontent.com/$repo/main/install.ps1 | iex
"@
}

if ($env:PROCESSOR_ARCHITECTURE -notin @("AMD64", "x86")) {
  Fail "Only 64-bit Intel/AMD Windows is published (found $env:PROCESSOR_ARCHITECTURE)."
}
$platform = "win-x64"

# ── Which release ─────────────────────────────────────────────────────────────
if ($env:STAGE_VERSION) {
  $tag = "v" + ($env:STAGE_VERSION -replace '^v', '')
} else {
  Say "Finding the newest $track release"
  $headers = @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "stage-utility-installer" }
  if ($track -eq "beta") {
    # beta takes prereleases and releases both; main takes only full releases.
    $release = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases?per_page=20" -Headers $headers)[0]
  } else {
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers $headers
  }
  $tag = $release.tag_name
}
if (-not $tag) { Fail "Could not determine a release to install." }

$version = $tag -replace '^v', ''
$archive = "stage-utility-$version-$platform.tar.gz"
$base    = "https://github.com/$repo/releases/download/$tag"

Say "Installing $tag for $platform"
Write-UpdateProgress "pull"

# ── Download and verify ───────────────────────────────────────────────────────
$work = Join-Path $env:TEMP ("stage-utility-" + [guid]::NewGuid())
New-Item -ItemType Directory -Path $work -Force | Out-Null
try {
  Invoke-WebRequest "$base/$archive" -OutFile "$work\$archive" -UseBasicParsing

  # The expected hash comes from the releases API, not from anything inside the
  # archive - a checksum shipped inside the file it describes proves nothing,
  # because whoever alters the file alters the checksum with it.
  if (-not $release) {
    $headers = @{ "Accept" = "application/vnd.github+json"; "User-Agent" = "stage-utility-installer" }
    $release = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/tags/$tag" -Headers $headers
  }

  Write-UpdateProgress "install"
  Say "Verifying"
  $asset = $release.assets | Where-Object { $_.name -eq $archive } | Select-Object -First 1
  if (-not $asset -or -not $asset.digest) {
    Fail "Release $tag publishes no checksum for $archive; refusing to install unverified."
  }
  $want = ($asset.digest -replace '^sha256:', '').ToLower()
  $got  = (Get-FileHash "$work\$archive" -Algorithm SHA256).Hash.ToLower()
  if ($want -ne $got) {
    Fail "Checksum mismatch - the download does not match the published release. Nothing installed."
  }

  # ── Unpack beside the current release, then switch ──────────────────────────
  # The running install is untouched until the new one is complete, and the
  # previous release stays on disk.
  $releaseDir = Join-Path $prefix "releases\$version"
  Say "Unpacking to $releaseDir"
  if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force }
  New-Item -ItemType Directory -Path $releaseDir -Force | Out-Null
  # tar ships with Windows 10 1803 and later.
  tar -xzf "$work\$archive" -C $releaseDir
  if ($LASTEXITCODE -ne 0) { Fail "Could not unpack the archive." }
  if (-not (Test-Path (Join-Path $releaseDir "node.exe"))) {
    Fail "Archive is missing its runtime - refusing to switch to it."
  }

  New-Item -ItemType Directory -Path $data -Force | Out-Null

  # A junction rather than a symlink: it needs no developer mode and no extra
  # privilege, and points at a directory just the same.
  Write-UpdateProgress "build"
  $current = Join-Path $prefix "current"
  if (Test-Path $current) { (Get-Item $current).Delete() }
  New-Item -ItemType Junction -Path $current -Target $releaseDir | Out-Null

  # ── Update mode ─────────────────────────────────────────────────────────────
  # The task already exists and is RUNNING: the download, verify and unpack above
  # all happened while it kept serving, and the junction has just been repointed.
  # So do not stop it and do not re-register it - ask it to exit, and Task
  # Scheduler restarts it on the new files.
  #
  # Stopping first would blank every display for the length of the download.
  if ($env:STAGE_UPDATE_MODE -eq "swap") {
    Say "Swap complete. Restarting the running server."
    Write-UpdateProgress "restarting"
    Write-UpdateResult $true ""
    if ($env:STAGE_UPDATE_SERVER_PID) {
      Start-Sleep -Seconds 1  # let the HTTP response that triggered this flush
      Stop-Process -Id ([int]$env:STAGE_UPDATE_SERVER_PID) -Force -ErrorAction SilentlyContinue
    }
    exit 0
  }

  # ── Register it ─────────────────────────────────────────────────────────────
  # A scheduled task rather than a Windows service: Node is not a service-aware
  # binary, so a real service would need a third-party wrapper downloaded onto
  # the machine. Task Scheduler is built in and restarts on failure, which is
  # what the in-app updater relies on when it exits to apply a new build.
  Say "Registering the startup task"
  $exe    = Join-Path $current "node.exe"
  $script = Join-Path $current "server.mjs"

  $action = New-ScheduledTaskAction -Execute $exe -Argument "`"$script`"" -WorkingDirectory $current
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
      -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)

  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger `
      -Principal $principal -Settings $settings | Out-Null

  # The task itself carries no environment, so put the settings where the process
  # will find them: machine-level variables, then start it.
  [Environment]::SetEnvironmentVariable("STAGE_UTILITY_DATA", $data,    "Machine")
  [Environment]::SetEnvironmentVariable("STAGE_UTILITY_PORT", $port,    "Machine")
  [Environment]::SetEnvironmentVariable("STAGE_UTILITY_ROOT", $current, "Machine")
  # Declares how this copy was installed, so the in-app updater picks the right
  # strategy instead of inferring one from the path.
  [Environment]::SetEnvironmentVariable("STAGE_UTILITY_INSTALL_KIND", "tarball", "Machine")
  $env:STAGE_UTILITY_DATA = $data; $env:STAGE_UTILITY_PORT = $port; $env:STAGE_UTILITY_ROOT = $current; $env:STAGE_UTILITY_INSTALL_KIND = "tarball"

  Start-ScheduledTask -TaskName $taskName

  # ── Confirm it is actually serving ──────────────────────────────────────────
  Say "Waiting for it to come up"
  foreach ($i in 1..30) {
    Start-Sleep -Seconds 1
    try {
      Invoke-WebRequest "http://127.0.0.1:$port/api/state" -UseBasicParsing -TimeoutSec 2 | Out-Null
      $ip = (Get-NetIPAddress -AddressFamily IPv4 |
             Where-Object { $_.IPAddress -notlike "127.*" -and $_.IPAddress -notlike "169.254.*" } |
             Select-Object -First 1).IPAddress
      if (-not $ip) { $ip = "localhost" }
      Write-Host ""
      Write-Host "Stage Utility $tag is running." -ForegroundColor Green
      Write-Host ""
      Write-Host "  Open   http://${ip}:$port/"
      Write-Host "  Data   $data"
      Write-Host "  Update from Settings -> Advanced -> Updates"
      Write-Host ""
      exit 0
    } catch { }
  }
  Fail "Installed, but it did not answer on port $port within 30s. Check Task Scheduler -> $taskName."
}
finally {
  Remove-Item $work -Recurse -Force -ErrorAction SilentlyContinue
}
