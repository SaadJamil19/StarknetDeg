param(
  [ValidateSet('all', 'phase4', 'phase6')]
  [string]$Target = 'all'
)

$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot

function Start-JobWindow {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Title,

    [Parameter(Mandatory = $true)]
    [string]$Command
  )

  $escapedProjectRoot = $projectRoot.Replace("'", "''")
  $fullCommand = @"
$Host.UI.RawUI.WindowTitle = '$Title'
Set-Location '$escapedProjectRoot'
$Command
"@

  Start-Process powershell -ArgumentList @(
    '-NoExit',
    '-ExecutionPolicy', 'Bypass',
    '-Command', $fullCommand
  ) | Out-Null
}

$phase4Window = @{ Title = 'StarknetDeg - Phase4'; Command = 'npm run start:phase4' }
$phase6Window = @{ Title = 'StarknetDeg - Phase6'; Command = 'npm run start:phase6' }

if ($Target -eq 'all') {
  Start-JobWindow -Title 'StarknetDeg - Indexer' -Command 'npm run start:indexer'
}

if ($Target -in @('all', 'phase4')) {
  Start-JobWindow -Title $phase4Window.Title -Command $phase4Window.Command
}

if ($Target -in @('all', 'phase6')) {
  Start-JobWindow -Title $phase6Window.Title -Command $phase6Window.Command
}

Write-Host "Started StarknetDeg stack target='$Target' from $projectRoot"
