# The Stage Utility kiosk launcher: finds the server, then opens the browser on it.
#
# install-windows.ps1 downloads this from the server and puts it in
# %ProgramData%\StageUtility as kiosk.ps1, where a scheduled task runs it at logon
# and every minute. kiosk-update-windows.ps1 replaces it when the server has a
# newer one, so this file is the whole launcher: nothing about it is baked in at
# install time. Where it lives is the state folder (device-id, token, bound-to,
# server), and the discovery port comes from the `port` file beside it.
#
# Plain ASCII with no byte-order mark, and it is served byte for byte: the digest
# the server publishes for it, and the release's signature of it, are over exactly
# these bytes. .gitattributes pins it `-text` so no checkout converts its line
# ends. See scripts/lint-powershell.ps1.
$ErrorActionPreference = 'SilentlyContinue'
$StateDir = $PSScriptRoot

# The UDP port the server answers discovery on: the `port` file the installer
# wrote, or 8789 when there is none or it is not a port.
$Port = 8789
$portFile = Join-Path $StateDir 'port'
if (Test-Path $portFile) {
  $parsed = 0
  if ([int]::TryParse(([string](Get-Content $portFile -Raw)).Trim(), [ref]$parsed) -and $parsed -gt 0 -and $parsed -le 65535) { $Port = $parsed }
}

$id    = Get-Content (Join-Path $StateDir 'device-id')
$token = Get-Content (Join-Path $StateDir 'token')
$boundFile = Join-Path $StateDir 'bound-to'
$serverFile = Join-Path $StateDir 'server'

function Get-MacAddress {
  Get-NetAdapter | Where-Object Status -ne 'Disabled' |
    ForEach-Object { '"' + ($_.MacAddress -replace '-', ':').ToLower() + '"' }
}

# More than one server can answer in the two seconds. The answer kept is the one
# from the server this screen remembers, else one from a server that says it is
# set up there, else the first.
function Select-Reply($replies, $bound) {
  if ($bound) {
    $mine = $replies | Where-Object { $_ -match ('"serverId":"' + [regex]::Escape($bound) + '"') } | Select-Object -First 1
    if ($mine) { return $mine }
  }
  $claimed = $replies | Where-Object { $_ -match '"claimed":true' } | Select-Object -First 1
  if ($claimed) { return $claimed }
  return $replies | Select-Object -First 1
}

# What this screen remembers, and puts in every probe as boundTo: a server that
# says it is set up there, forgotten when that same server says it no longer is.
# Every other server ignores a screen that names somebody else, so remembering one
# that merely answered would keep a released screen away from them for good. An
# answer that does not say either way, from a server older than the field, is
# remembered. True when it has just forgotten its server.
function Save-Binding {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingWriteHost', '',
    Justification = 'The line is for whoever looks at this console, and must not become the return value, which is whether the server was forgotten.')]
  param($reply, $bound)
  $srv = if ($reply -match '"serverId":"([^"]+)"') { $matches[1] } else { '' }
  $claimed = if ($reply -match '"claimed":(true|false)') { $matches[1] } else { '' }
  if (-not $srv) { return $false }
  if ($claimed -ne 'false') {
    $srv | Set-Content -NoNewline $boundFile
    return $false
  }
  if ($srv -ne $bound) { return $false }
  Remove-Item $boundFile
  if (Test-Path $boundFile) { return $false }
  Write-Host "[kiosk] server $srv no longer has this screen set up; forgot it, so any server can set it up"
  return $true
}

# One probe, and every answer within two seconds, at most eight: a host that
# keeps sending to the probe's port must not hold the screen off its display. The
# replies are unicast, so nothing has to be open on this machine.
function Send-Probe {
  [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSAvoidUsingEmptyCatchBlock', '',
    Justification = 'A receive timeout is how the two seconds end, and a send that fails is the same as nobody answering: both leave no replies, and the caller tries again.')]
  param($probe)
  $client = New-Object System.Net.Sockets.UdpClient
  $replies = @()
  try {
    $client.EnableBroadcast = $true
    $bytes = [Text.Encoding]::UTF8.GetBytes($probe)
    $null = $client.Send($bytes, $bytes.Length, '255.255.255.255', $Port)
    $remote = New-Object System.Net.IPEndPoint([System.Net.IPAddress]::Any, 0)
    $deadline = [DateTime]::UtcNow.AddSeconds(2)
    while ($replies.Count -lt 8) {
      $left = [int]($deadline - [DateTime]::UtcNow).TotalMilliseconds
      # 0 would mean wait for ever.
      if ($left -le 0) { break }
      $client.Client.ReceiveTimeout = $left
      $replies += [Text.Encoding]::UTF8.GetString($client.Receive([ref]$remote))
    }
  } catch { } finally { $client.Close() }
  return $replies
}

# One probe: the answer kept, remembered, and the address it gives. An answer that
# makes this screen forget its server is followed straight away by one more probe
# without it, so a server with its Screens page open can answer in this boot
# rather than the next. If none does, the address the old server gave stands.
function Find-Server {
  $bound = if (Test-Path $boundFile) { Get-Content $boundFile } else { '' }
  $macs = (Get-MacAddress) -join ','
  $probe = '{"stageUtility":"discover","v":1,"id":"' + $id + '","macs":[' + $macs +
           '],"hostname":"' + $env:COMPUTERNAME + '","os":"Windows"'
  if ($bound) { $probe += ',"boundTo":"' + $bound + '"' }
  $probe += '}'

  $replies = @(Send-Probe $probe)
  if (-not $replies) { return '' }
  $reply = Select-Reply $replies $bound
  $url = if ($reply -match '"url":"([^"]+)"') { $matches[1] } else { '' }
  if (Save-Binding $reply $bound) {
    $again = Find-Server
    if ($again) { $url = $again }
  }
  return $url
}

if (Test-Path $serverFile) {
  $url = Get-Content $serverFile
} else {
  $url = ''; $fails = 0
  while (-not $url) {
    $url = Find-Server
    if (-not $url) {
      $fails++
      # Two seconds while the server might still be booting, then thirty so a
      # screen left on overnight is not shouting all night.
      Start-Sleep -Seconds $(if ($fails -lt 10) { 2 } else { 30 })
    }
  }
}

$target = "$url/enroll?device=$id&token=$token"

$chrome = @(
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

# --no-first-run and the crash flags together stop the "Restore pages?" bar after
# a power cut, which otherwise sits over the display until somebody walks to it.
if ($chrome) {
  & $chrome --kiosk --noerrdialogs --disable-infobars --no-first-run `
    --disable-session-crashed-bubble --user-data-dir="$StateDir\browser" $target
} else {
  Start-Process $target
}
