# update.ps1 — Windows in-app updater. Mirrors scripts/update.sh.
#
#   git pull --ff-only -> npm ci -> npm run build
#   on success: write the result file + stop the running server (NSSM /
#               Task Scheduler relaunches it with the new build).
#   on failure: write the result file and leave the running server untouched.
#
# Spawned detached by main/services/updater.ts. Inputs come from env vars:
#   STAGE_UPDATE_REPO / STAGE_UPDATE_BRANCH / STAGE_UPDATE_NODE_DIR /
#   STAGE_UPDATE_SERVER_PID / STAGE_UPDATE_RESULT
$ErrorActionPreference = "Continue"

$repo   = if ($env:STAGE_UPDATE_REPO)   { $env:STAGE_UPDATE_REPO }   else { Split-Path -Parent $PSScriptRoot }
if ($env:STAGE_UPDATE_NODE_DIR) { $env:PATH = "$($env:STAGE_UPDATE_NODE_DIR);$($env:PATH)" }
$branch = if ($env:STAGE_UPDATE_BRANCH) { $env:STAGE_UPDATE_BRANCH } else { (git -C $repo rev-parse --abbrev-ref HEAD).Trim() }
$result = if ($env:STAGE_UPDATE_RESULT) { $env:STAGE_UPDATE_RESULT } else { Join-Path $repo "update-result.json" }
$progress = if ($env:STAGE_UPDATE_PROGRESS) { $env:STAGE_UPDATE_PROGRESS } else { Join-Path $repo "update-progress.json" }
# Persistent, size-capped update log (server trims it; we append a bounded tail).
$ulog = $env:STAGE_UPDATE_LOG

Set-Location $repo
$log = New-TemporaryFile
# Commit before the pull — lets us diff what changed and skip the (slow) reinstall
# / rebuild when an update doesn't touch them.
$oldRev = (git rev-parse HEAD 2>$null)
if (-not $oldRev) { $oldRev = "none" }

# Append this run's outcome + a bounded tail of its output to the persistent
# update log, so the git/npm detail survives the restart and shows in /log.
function Persist-Run($outcome) {
  if (-not $ulog) { return }
  try {
    $kind = if ($env:STAGE_UPDATE_CHECKOUT) { "track-switch" } else { "update" }
    $stamp = (Get-Date).ToUniversalTime().ToString("o")
    $tail = ""
    try { $tail = Get-Content -Raw $log } catch {}
    if ($tail -and $tail.Length -gt 8000) { $tail = $tail.Substring($tail.Length - 8000) }
    "$stamp [update.ps1] ==== $kind on $branch finished: $outcome ====`n$tail" | Out-File -Append -Encoding utf8 $ulog
  } catch {}
}

function Write-Result($ok) {
  $logText = ""
  try { $logText = Get-Content -Raw $log } catch {}
  if ($logText -and $logText.Length -gt 4000) { $logText = $logText.Substring($logText.Length - 4000) }
  @{ ok = [bool]$ok; finishedAt = (Get-Date).ToUniversalTime().ToString("o"); log = $logText } |
    ConvertTo-Json -Compress | Set-Content -Encoding utf8 $result
  Persist-Run $(if ($ok) { "success" } else { "FAILED" })
}

# Publish the current step so the (still-running) server can broadcast progress.
function Write-Progress-Step($step) {
  try {
    @{ step = $step; at = (Get-Date).ToUniversalTime().ToString("o") } |
      ConvertTo-Json -Compress | Set-Content -Encoding utf8 $progress
  } catch {}
}

try {
  Write-Progress-Step "pull"
  if ($env:STAGE_UPDATE_CHECKOUT) {
    # Switching tracks: fetch the target branch and force the local branch to it.
    "[update] git fetch origin $branch; git checkout -B $branch origin/$branch" | Out-File -Append $log
    git fetch origin $branch *>> $log; if ($LASTEXITCODE -ne 0) { throw "git fetch failed" }
    git checkout -B $branch "origin/$branch" *>> $log; if ($LASTEXITCODE -ne 0) { throw "git checkout failed" }
  } else {
    "[update] git pull --ff-only origin $branch" | Out-File -Append $log
    git pull --ff-only origin $branch *>> $log; if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
  }
  # Decide what's actually needed. The backend runs via tsx (no build), so a
  # backend-only update just needs a restart. Reinstall only when the lockfile
  # changed; rebuild only when renderer/build inputs changed. Default to doing the
  # work whenever we can't tell (no OLD rev, or build/ missing).
  $newRev = (git rev-parse HEAD 2>$null); if (-not $newRev) { $newRev = "none" }
  $needInstall = $true
  $needBuild = $true
  if ($oldRev -ne "none" -and $newRev -ne "none" -and (Test-Path "build")) {
    $changed = (git diff --name-only $oldRev $newRev 2>$null)
    "[update] changed files:" | Out-File -Append $log
    ($changed | ForEach-Object { "[update]   $_" }) | Out-File -Append $log
    $needInstall = $false
    $needBuild = $false
    if ($changed -match '^package-lock\.json$') { $needInstall = $true; $needBuild = $true }
    if ($changed -match '^(renderer/|index\.html|vite\.config|tailwind\.config|postcss\.config|package\.json|tsconfig)') { $needBuild = $true }
  }

  if ($needInstall) {
    Write-Progress-Step "install"
    # --include=dev: the service runs with NODE_ENV=production, under which npm omits
    # devDependencies — but the build tooling (vite, etc.) lives there. Force them in.
    "[update] npm ci --include=dev" | Out-File -Append $log
    npm ci --include=dev *>> $log;        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  } else {
    "[update] dependencies unchanged — skipping npm ci" | Out-File -Append $log
  }

  if ($needBuild) {
    Write-Progress-Step "build"
    "[update] npm run build" | Out-File -Append $log
    npm run build *>> $log; if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
  } else {
    "[update] no renderer changes — skipping npm run build (backend runs via tsx)" | Out-File -Append $log
  }
} catch {
  $_ | Out-File -Append $log
  Write-Result $false
  exit 1
}

Write-Progress-Step "restarting"
Write-Result $true

# Let the HTTP response flush, then restart by stopping the server.
Start-Sleep -Seconds 2
if ($env:STAGE_UPDATE_SERVER_PID) {
  Stop-Process -Id ([int]$env:STAGE_UPDATE_SERVER_PID) -Force -ErrorAction SilentlyContinue
}
