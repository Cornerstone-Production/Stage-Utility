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

$ErrorActionPreference = 'Stop'

$StateDir = Join-Path $env:ProgramData 'StageUtility'
$Port     = if ($env:STAGE_KIOSK_PORT) { [int]$env:STAGE_KIOSK_PORT } else { 8789 }
$Server   = $env:STAGE_SERVER

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
           ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Error 'Run this in an elevated PowerShell - the device id lives in ProgramData.'
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
$Launcher = Join-Path $StateDir 'kiosk.ps1'
@"
`$ErrorActionPreference = 'SilentlyContinue'
`$StateDir = '$StateDir'
`$Port     = $Port

`$id    = Get-Content (Join-Path `$StateDir 'device-id')
`$token = Get-Content (Join-Path `$StateDir 'token')
`$boundFile = Join-Path `$StateDir 'bound-to'
`$serverFile = Join-Path `$StateDir 'server'

function Get-Macs {
  Get-NetAdapter | Where-Object Status -ne 'Disabled' |
    ForEach-Object { '"' + (`$_.MacAddress -replace '-', ':').ToLower() + '"' }
}

# More than one server can answer in the two seconds. The answer kept is the one
# from the server this screen remembers, else one from a server that says it is
# set up there, else the first.
function Select-Reply(`$replies, `$bound) {
  if (`$bound) {
    `$mine = `$replies | Where-Object { `$_ -match ('"serverId":"' + [regex]::Escape(`$bound) + '"') } | Select-Object -First 1
    if (`$mine) { return `$mine }
  }
  `$claimed = `$replies | Where-Object { `$_ -match '"claimed":true' } | Select-Object -First 1
  if (`$claimed) { return `$claimed }
  return `$replies | Select-Object -First 1
}

# What this screen remembers, and puts in every probe as boundTo: a server that
# says it is set up there, forgotten when that same server says it no longer is.
# Every other server ignores a screen that names somebody else, so remembering one
# that merely answered would keep a released screen away from them for good. An
# answer that does not say either way, from a server older than the field, is
# remembered. True when it has just forgotten its server.
function Save-Binding(`$reply, `$bound) {
  `$srv = if (`$reply -match '"serverId":"([^"]+)"') { `$matches[1] } else { '' }
  `$claimed = if (`$reply -match '"claimed":(true|false)') { `$matches[1] } else { '' }
  if (-not `$srv) { return `$false }
  if (`$claimed -ne 'false') {
    `$srv | Set-Content -NoNewline `$boundFile
    return `$false
  }
  if (`$srv -ne `$bound) { return `$false }
  Remove-Item `$boundFile
  if (Test-Path `$boundFile) { return `$false }
  Write-Host "[kiosk] server `$srv no longer has this screen set up; forgot it, so any server can set it up"
  return `$true
}

# One probe, and every answer within two seconds, at most eight: a host that
# keeps sending to the probe's port must not hold the screen off its display. The
# replies are unicast, so nothing has to be open on this machine.
function Send-Probe(`$probe) {
  `$client = New-Object System.Net.Sockets.UdpClient
  `$replies = @()
  try {
    `$client.EnableBroadcast = `$true
    `$bytes = [Text.Encoding]::UTF8.GetBytes(`$probe)
    `$null = `$client.Send(`$bytes, `$bytes.Length, '255.255.255.255', `$Port)
    `$remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    `$deadline = [DateTime]::UtcNow.AddSeconds(2)
    while (`$replies.Count -lt 8) {
      `$left = [int](`$deadline - [DateTime]::UtcNow).TotalMilliseconds
      # 0 would mean wait for ever.
      if (`$left -le 0) { break }
      `$client.Client.ReceiveTimeout = `$left
      `$replies += [Text.Encoding]::UTF8.GetString(`$client.Receive([ref]`$remote))
    }
  } catch { } finally { `$client.Close() }
  return `$replies
}

# One probe: the answer kept, remembered, and the address it gives. An answer that
# makes this screen forget its server is followed straight away by one more probe
# without it, so a server with its Screens page open can answer in this boot
# rather than the next. If none does, the address the old server gave stands.
function Find-Server {
  `$bound = if (Test-Path `$boundFile) { Get-Content `$boundFile } else { '' }
  `$macs = (Get-Macs) -join ','
  `$probe = '{"stageUtility":"discover","v":1,"id":"' + `$id + '","macs":[' + `$macs +
           '],"hostname":"' + `$env:COMPUTERNAME + '","os":"Windows"'
  if (`$bound) { `$probe += ',"boundTo":"' + `$bound + '"' }
  `$probe += '}'

  `$replies = @(Send-Probe `$probe)
  if (-not `$replies) { return '' }
  `$reply = Select-Reply `$replies `$bound
  `$url = if (`$reply -match '"url":"([^"]+)"') { `$matches[1] } else { '' }
  if (Save-Binding `$reply `$bound) {
    `$again = Find-Server
    if (`$again) { `$url = `$again }
  }
  return `$url
}

if (Test-Path `$serverFile) {
  `$url = Get-Content `$serverFile
} else {
  `$url = ''; `$fails = 0
  while (-not `$url) {
    `$url = Find-Server
    if (-not `$url) {
      `$fails++
      # Two seconds while the server might still be booting, then thirty so a
      # screen left on overnight is not shouting all night.
      Start-Sleep -Seconds `$(if (`$fails -lt 10) { 2 } else { 30 })
    }
  }
}

`$target = "`$url/enroll?device=`$id&token=`$token"

`$chrome = @(
  "`$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "`${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "`$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path `$_ } | Select-Object -First 1

# --no-first-run and the crash flags together stop the "Restore pages?" bar after
# a power cut, which otherwise sits over the display until somebody walks to it.
if (`$chrome) {
  & `$chrome --kiosk --noerrdialogs --disable-infobars --no-first-run ``
    --disable-session-crashed-bubble --user-data-dir="`$StateDir\browser" `$target
} else {
  Start-Process `$target
}
"@ | Set-Content -Encoding UTF8 $Launcher

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

# Display sleep is the difference between a display and a black rectangle.
powercfg /change monitor-timeout-ac 0  2>$null
powercfg /change standby-timeout-ac 0  2>$null

Write-Output ''
Write-Output "==> Done. This screen is device $(Get-Content $IdFile)"
Write-Output '    It starts at the next logon. Open Screens in Stage Utility and'
Write-Output '    set it up under "Not set up yet".'
Write-Output ''
Write-Output '    Still to do by hand, once: enable automatic login (netplwiz).'

Write-Host "red proof"
