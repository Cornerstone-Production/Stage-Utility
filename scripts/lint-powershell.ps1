# PSScriptAnalyzer over the PowerShell that runs elevated on a display machine.
#
#   pwsh scripts/lint-powershell.ps1
#
# CI (.github/workflows/psscriptanalyzer.yml) calls this rather than carrying its
# own file list, so the check you run here is the check that runs there.
#
# Every finding fails it, at any severity, with the analyzer's default rules and
# no settings file. A finding is fixed, or silenced where it stands with
# [Diagnostics.CodeAnalysis.SuppressMessageAttribute('PSRuleName', '',
# Justification = 'why')] on the function or param block that owns it; a
# repo-wide exclusion is never the answer.
#
# The installer is kept ASCII. PSUseBOMForUnicodeEncodedFile asks for a byte-order
# mark on a file with other characters, but Windows PowerShell 5.1 reads a file
# without one as ANSI, and a BOM on text fetched with `irm | iex` can break the
# first line. ASCII needs neither.
$ErrorActionPreference = 'Stop'

$Files = @(
  'scripts/kiosk/install-windows.ps1',
  'scripts/lint-powershell.ps1'
)

# Tracked PowerShell not linted yet, one per line. Each fails the analyzer today
# (Write-Host, empty catch blocks, a missing BOM), and update.ps1 is the in-app
# updater, so they are fixed on their own rather than here. A new .ps1 that is in
# neither list fails the check: it is either linted or deferred on purpose.
$Deferred = @(
  'install.ps1',
  'scripts/survival/run-windows.ps1',
  'scripts/update.ps1'
)

if (-not (Get-Module -ListAvailable -Name PSScriptAnalyzer)) {
  throw 'PSScriptAnalyzer is not installed (Install-Module PSScriptAnalyzer -Scope CurrentUser).'
}

$root = (& git rev-parse --show-toplevel).Trim()
$unaccounted = @(& git -C $root ls-files '*.ps1') | Where-Object { $_ -notin $Files -and $_ -notin $Deferred }
if ($unaccounted) {
  throw "PowerShell in neither `$Files nor `$Deferred in scripts/lint-powershell.ps1: $($unaccounted -join ', ')"
}
$findings = @()
foreach ($file in $Files) {
  $path = Join-Path $root $file
  # A path that does not resolve would analyze nothing and pass.
  if (-not (Test-Path -LiteralPath $path)) {
    throw "$file is not here: refusing to report a vacuous pass"
  }
  $findings += @(Invoke-ScriptAnalyzer -Path $path)
}

Write-Output "PSScriptAnalyzer over $($Files.Count) scripts: $($findings.Count) findings"
foreach ($f in $findings) {
  $rel = [IO.Path]::GetRelativePath($root, $f.ScriptPath)
  Write-Output "${rel}:$($f.Line) [$($f.Severity)] $($f.RuleName): $($f.Message)"
  if ($env:GITHUB_ACTIONS) {
    $level = if ($f.Severity -eq 'Error') { 'error' } else { 'warning' }
    Write-Output "::$level file=$rel,line=$($f.Line),title=$($f.RuleName)::$($f.Message)"
  }
}
if ($findings.Count -gt 0) { exit 1 }
