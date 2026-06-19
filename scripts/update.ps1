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

Set-Location $repo
$log = New-TemporaryFile

function Write-Result($ok) {
  $logText = ""
  try { $logText = Get-Content -Raw $log } catch {}
  if ($logText -and $logText.Length -gt 4000) { $logText = $logText.Substring($logText.Length - 4000) }
  @{ ok = [bool]$ok; finishedAt = (Get-Date).ToUniversalTime().ToString("o"); log = $logText } |
    ConvertTo-Json -Compress | Set-Content -Encoding utf8 $result
}

try {
  "[update] git pull --ff-only origin $branch" | Out-File -Append $log
  git pull --ff-only origin $branch *>> $log; if ($LASTEXITCODE -ne 0) { throw "git pull failed" }
  "[update] npm ci"        | Out-File -Append $log
  npm ci *>> $log;        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
  "[update] npm run build" | Out-File -Append $log
  npm run build *>> $log; if ($LASTEXITCODE -ne 0) { throw "npm run build failed" }
} catch {
  $_ | Out-File -Append $log
  Write-Result $false
  exit 1
}

Write-Result $true

# Let the HTTP response flush, then restart by stopping the server.
Start-Sleep -Seconds 2
if ($env:STAGE_UPDATE_SERVER_PID) {
  Stop-Process -Id ([int]$env:STAGE_UPDATE_SERVER_PID) -Force -ErrorAction SilentlyContinue
}
