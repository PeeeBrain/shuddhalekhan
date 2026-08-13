param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [string]$ExecutableArgumentsJson = '[]',

  [Parameter(Mandatory = $true)]
  [string]$ScenarioId,

  [Parameter(Mandatory = $true)]
  [string]$RunId,

  [string]$BuildLabel = 'unspecified',

  [ValidateSet('diagnostic-unverified', 'packaged-windows-x64')]
  [string]$Comparability = 'diagnostic-unverified',

  [int]$SettleSeconds = 60,
  [int]$SampleCount = 60,
  [int]$SampleIntervalMs = 1000,
  [int]$StartupTimeoutSeconds = 30,
  [string]$DockerContainerId = '',
  [string]$DockerCommandPath = 'docker',
  [string]$NvidiaSmiPath = ''
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$resolvedOutputDir = [System.IO.Path]::GetFullPath($OutputDir)
New-Item -ItemType Directory -Force -Path $resolvedOutputDir | Out-Null
$eventsPath = Join-Path $resolvedOutputDir 'events.jsonl'
$externalEventsPath = Join-Path $resolvedOutputDir 'external-events.jsonl'
$rolesPath = Join-Path $resolvedOutputDir 'process-roles.json'
$captureMetadataPath = Join-Path $resolvedOutputDir 'capture-metadata.json'
Remove-Item -LiteralPath $eventsPath, $externalEventsPath -Force -ErrorAction SilentlyContinue

$qpcFrequency = [System.Diagnostics.Stopwatch]::Frequency
$externalSequence = 0

function Add-ExternalEvent {
  param(
    [string]$EventName,
    [long]$QpcTicks,
    [int]$ProcessId = 0
  )

  $script:externalSequence += 1
  $record = [ordered]@{
    schemaVersion = 1
    runId = $RunId
    buildLabel = $BuildLabel
    scenarioId = $ScenarioId
    sequence = $script:externalSequence
    event = $EventName
    qpcTicks = $QpcTicks
    qpcFrequency = $qpcFrequency
    utc = [DateTime]::UtcNow.ToString('o')
  }
  if ($ProcessId -gt 0) { $record.pid = $ProcessId }
  Add-Content -LiteralPath $externalEventsPath -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
}

$command = Get-Command -Name $ExecutablePath -ErrorAction Stop
$processStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
$processStartInfo.FileName = $command.Source
$processStartInfo.UseShellExecute = $false
$processStartInfo.WorkingDirectory = Split-Path -Parent $command.Source
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_MARKERS'] = '1'
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_RUN_ID'] = $RunId
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_SCENARIO_ID'] = $ScenarioId
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_EVENTS_PATH'] = $eventsPath
foreach ($argument in @(ConvertFrom-Json -InputObject $ExecutableArgumentsJson)) {
  [void]$processStartInfo.ArgumentList.Add([string]$argument)
}

$process = $null
try {
  $launchTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
  Add-ExternalEvent -EventName 'process.launch.requested' -QpcTicks $launchTicks
  $process = [System.Diagnostics.Process]::Start($processStartInfo)
  if ($null -eq $process) { throw 'Failed to start benchmark process.' }

  $deadline = [DateTime]::UtcNow.AddSeconds($StartupTimeoutSeconds)
  $operational = $false
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($process.HasExited) {
      throw "Benchmark process exited before runtime.operational (exit $($process.ExitCode))."
    }
    if (Test-Path -LiteralPath $eventsPath) {
      $operational = Get-Content -LiteralPath $eventsPath | Where-Object {
        try { (ConvertFrom-Json -InputObject $_).event -eq 'runtime.operational' } catch { $false }
      } | Select-Object -First 1
      if ($operational) { break }
    }
    Start-Sleep -Milliseconds 25
  }
  if (-not $operational) {
    throw "Timed out after $StartupTimeoutSeconds seconds waiting for runtime.operational."
  }

  $operationalReceiptTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
  Add-ExternalEvent -EventName 'runtime.operational.received' -QpcTicks $operationalReceiptTicks -ProcessId $process.Id

  $creationTime = $process.StartTime.ToUniversalTime().ToString('o')
  $appMarkers = @(Get-Content -LiteralPath $eventsPath | ForEach-Object {
    try { ConvertFrom-Json -InputObject $_ } catch { $null }
  } | Where-Object { $null -ne $_ })
  $declaredProcessRoles = @{
    $process.Id = 'electron-main'
  }
  $inventoryMarker = $appMarkers | Where-Object { $_.event -eq 'process.inventory' } | Select-Object -Last 1
  if ($null -ne $inventoryMarker) {
    foreach ($inventoryProcess in @($inventoryMarker.processes)) {
      $declaredProcessRoles[[int]$inventoryProcess.pid] = [string]$inventoryProcess.role
    }
  }
  foreach ($sidecarMarker in @($appMarkers | Where-Object { $_.event -eq 'sidecar.spawned' })) {
    if ($sidecarMarker.childPid) {
      $declaredProcessRoles[[int]$sidecarMarker.childPid] = 'agent-sidecar'
    }
  }

  $declaredProcesses = @()
  foreach ($declaredPid in $declaredProcessRoles.Keys) {
    try {
      $declaredProcess = Get-Process -Id $declaredPid -ErrorAction Stop
      $declaredProcesses += @{
        pid = $declaredProcess.Id
        creationTime = $declaredProcess.StartTime.ToUniversalTime().ToString('o')
        role = $declaredProcessRoles[$declaredPid]
        includeDescendants = $declaredProcess.Id -eq $process.Id -or $declaredProcessRoles[$declaredPid] -eq 'agent-sidecar'
      }
    } catch {
      # A process that ended before the sample window is retained in events, not sampled under a reused PID.
    }
  }
  @{
    schemaVersion = 1
    processes = $declaredProcesses
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $rolesPath -Encoding utf8

  if ($SettleSeconds -gt 0) { Start-Sleep -Seconds $SettleSeconds }

  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'performance-collector.ps1') `
    -OutputDir $resolvedOutputDir `
    -SampleCount $SampleCount `
    -SampleIntervalMs $SampleIntervalMs `
    -ProcessRolesPath $rolesPath `
    -DockerContainerId $DockerContainerId `
    -DockerCommandPath $DockerCommandPath `
    -NvidiaSmiPath $NvidiaSmiPath `
    -IncludeRelatedProcesses | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Process collector failed with exit code $LASTEXITCODE." }

  [ordered]@{
    schemaVersion = 1
    runId = $RunId
    buildLabel = $BuildLabel
    scenarioId = $ScenarioId
    comparability = $Comparability
    executablePath = $command.Source
    processId = $process.Id
    processCreationTime = $creationTime
    qpcFrequency = $qpcFrequency
    launchQpcTicks = $launchTicks
    runtimeOperationalReceiptQpcTicks = $operationalReceiptTicks
    startupDurationMs = (($operationalReceiptTicks - $launchTicks) * 1000) / $qpcFrequency
    windows = if ($null -ne $inventoryMarker) { @($inventoryMarker.windows) } else { @() }
    browserWindowCount = if ($null -ne $inventoryMarker) { @($inventoryMarker.windows).Count } else { 0 }
    capturedUtc = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $captureMetadataPath -Encoding utf8
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    $process.Kill($true)
    $process.WaitForExit(5000) | Out-Null
  }
}
