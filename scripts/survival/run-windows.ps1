# run-windows.ps1 — does a detached child survive the scheduled task stopping?
#
# Task Scheduler can terminate a task's descendants, and this has never been
# exercised. PowerShell's Start-Process detaches by default, so the shape is
# closer to launchd than to systemd - but that is an expectation, not a result,
# and assuming it by analogy is how the systemd cgroup difference would have
# reached a Sunday morning.
#
# Windows also has a separate, unproven question this test does NOT cover: it
# locks open executables, so replacing node.exe while the task runs may fail
# outright. If that shows up, the answer is stop-swap-start on Windows only -
# a documented platform exception, not a redesign. Do not work around it here.

$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$node = (Get-Command node).Source
$taskName = "StageSurvivalTest"
$log = Join-Path $env:TEMP ("survival-" + [guid]::NewGuid() + ".log")

function Cleanup {
  Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue
}

try {
  Cleanup
  New-Item -ItemType File -Path $log -Force | Out-Null

  # SURVIVAL_LOG has to reach the task, and a scheduled task does not inherit
  # this shell's environment - so it is passed through the command line.
  $inner = "`$env:SURVIVAL_LOG='$log'; & '$node' '$here\parent.mjs'"
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument "-NoProfile -ExecutionPolicy Bypass -Command `"$inner`""
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest

  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $principal | Out-Null
  Start-ScheduledTask -TaskName $taskName

  Start-Sleep -Seconds 5
  Stop-ScheduledTask -TaskName $taskName
  Start-Sleep -Seconds 14

  $content = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($content -and $content -match "FINISHED") {
    Write-Host "  windows survival: detached child outlived Stop-ScheduledTask and finished"
  } else {
    Write-Host "  windows survival: FAILED - the child did not finish after the task was stopped"
    Write-Host "  --- log ---"
    if ($content) { $content -split "`n" | ForEach-Object { Write-Host "    $_" } }
    Write-Host "  An update on Windows cannot be trusted while this fails: the swap"
    Write-Host "  would be interrupted partway through."
    exit 1
  }
} finally {
  Cleanup
}
