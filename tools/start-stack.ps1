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

$phase4Jobs = @(
  @{ Title = 'StarknetDeg - Meta Refresher'; Command = 'npm run start:meta-refresher' },
  @{ Title = 'StarknetDeg - ABI Refresh'; Command = 'npm run start:abi-refresh' },
  @{ Title = 'StarknetDeg - Security Scanner'; Command = 'npm run start:security-scanner' }
)

$phase6Jobs = @(
  @{ Title = 'StarknetDeg - Bridge Accounting'; Command = '$env:PHASE6_BRIDGE_ACCOUNTING_RUN_ONCE=''false''; npm run start:bridge-accounting' },
  @{ Title = 'StarknetDeg - Wallet Rollups'; Command = '$env:PHASE6_WALLET_ROLLUPS_RUN_ONCE=''false''; npm run start:wallet-rollups' },
  @{ Title = 'StarknetDeg - Concentration Rollups'; Command = '$env:PHASE6_CONCENTRATION_RUN_ONCE=''false''; npm run start:concentration-rollups' },
  @{ Title = 'StarknetDeg - Finality Promoter'; Command = '$env:PHASE6_FINALITY_PROMOTER_RUN_ONCE=''false''; npm run start:finality-promoter' }
)

if ($Target -eq 'all') {
  Start-JobWindow -Title 'StarknetDeg - Indexer' -Command 'npm run start:indexer'
}

if ($Target -in @('all', 'phase4')) {
  foreach ($job in $phase4Jobs) {
    Start-JobWindow -Title $job.Title -Command $job.Command
  }
}

if ($Target -in @('all', 'phase6')) {
  foreach ($job in $phase6Jobs) {
    Start-JobWindow -Title $job.Title -Command $job.Command
  }
}

Write-Host "Started StarknetDeg stack target='$Target' from $projectRoot"
