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

  [string]$CommitSha = 'unspecified',

  [ValidateSet('diagnostic-unverified', 'packaged-windows-x64')]
  [string]$Comparability = 'diagnostic-unverified',

  [int]$SettleSeconds = 60,
  [int]$SampleCount = 60,
  [int]$SampleIntervalMs = 1000,
  [int]$StartupTimeoutSeconds = 30,
  [int]$ActionTimeoutSeconds = 45,
  [int]$WarmupRepetitions = 0,
  [int]$ActionRepetitions = 1,
  [string]$FixtureRoot = '',
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
$resolvedFixtureRoot = if ($FixtureRoot) {
  [System.IO.Path]::GetFullPath($FixtureRoot)
} else {
  Join-Path $PSScriptRoot 'performance\fixtures'
}
$fixtureProcesses = @()

function Start-FixtureService {
  param(
    [string]$ScriptName,
    [string]$PortEnvironmentName
  )

  $bunCommand = (Get-Command -Name 'bun' -ErrorAction Stop).Source
  $fixtureStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $fixtureStartInfo.FileName = $bunCommand
  $fixtureStartInfo.UseShellExecute = $false
  $fixtureStartInfo.CreateNoWindow = $true
  $fixtureStartInfo.RedirectStandardOutput = $true
  $fixtureStartInfo.RedirectStandardError = $true
  $fixtureStartInfo.Environment[$PortEnvironmentName] = '0'
  [void]$fixtureStartInfo.ArgumentList.Add((Join-Path $resolvedFixtureRoot $ScriptName))
  $fixtureProcess = [System.Diagnostics.Process]::Start($fixtureStartInfo)
  if ($null -eq $fixtureProcess) { throw "Failed to start fixture service $ScriptName." }
  $script:fixtureProcesses += $fixtureProcess
  $readyLine = $fixtureProcess.StandardOutput.ReadLine()
  if (-not $readyLine) {
    throw "Fixture service $ScriptName exited before publishing its endpoint: $($fixtureProcess.StandardError.ReadToEnd())"
  }
  return $readyLine | ConvertFrom-Json
}

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

function Get-DescendantProcessIds {
  param([int]$RootProcessId)
  $descendants = [System.Collections.Generic.List[int]]::new()
  $queue = [System.Collections.Generic.Queue[int]]::new()
  $queue.Enqueue($RootProcessId)
  while ($queue.Count -gt 0) {
    $parentProcessId = $queue.Dequeue()
    foreach ($child in @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentProcessId" -ErrorAction SilentlyContinue)) {
      $childProcessId = [int]$child.ProcessId
      $descendants.Add($childProcessId)
      $queue.Enqueue($childProcessId)
    }
  }
  return @($descendants)
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
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_DRIVER'] = '1'
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_FIXTURE_ROOT'] = $resolvedFixtureRoot
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_WARMUP_REPETITIONS'] = [string]$WarmupRepetitions
$processStartInfo.Environment['SHUDDHALEKHAN_PERF_ACTION_REPETITIONS'] = [string]$ActionRepetitions

$providerFixture = $null
$mcpHttpFixture = $null
foreach ($argument in @(ConvertFrom-Json -InputObject $ExecutableArgumentsJson)) {
  [void]$processStartInfo.ArgumentList.Add([string]$argument)
}

$process = $null
try {
  if ($ScenarioId -in @('dictation-recording', 'agent-no-mcp', 'mcp-stdio-tool', 'mcp-http-tool')) {
    $providerFixture = Start-FixtureService `
      -ScriptName 'benchmark-provider-server.ts' `
      -PortEnvironmentName 'SHUDDHALEKHAN_BENCHMARK_PROVIDER_PORT'
    $processStartInfo.Environment['SHUDDHALEKHAN_PERF_PROVIDER_BASE_URL'] = "$($providerFixture.baseUrl)/v1"
  }
  if ($ScenarioId -eq 'mcp-http-tool') {
    $mcpHttpFixture = Start-FixtureService `
      -ScriptName 'mcp-http-server.ts' `
      -PortEnvironmentName 'SHUDDHALEKHAN_BENCHMARK_MCP_PORT'
    $processStartInfo.Environment['SHUDDHALEKHAN_PERF_MCP_HTTP_URL'] = [string]$mcpHttpFixture.url
  }

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

  $actionDeadline = [DateTime]::UtcNow.AddSeconds($ActionTimeoutSeconds)
  $actionCompleted = $ScenarioId -eq 'dictation-idle'
  while (-not $actionCompleted -and [DateTime]::UtcNow -lt $actionDeadline) {
    if ($process.HasExited) {
      throw "Benchmark process exited before the $ScenarioId action completed (exit $($process.ExitCode))."
    }
    $actionMarkers = @(Get-Content -LiteralPath $eventsPath | ForEach-Object {
      try { ConvertFrom-Json -InputObject $_ } catch { $null }
    } | Where-Object { $null -ne $_ })
    if ($actionMarkers | Where-Object { $_.event -eq 'scenario.action.failed' } | Select-Object -First 1) {
      throw "The in-app $ScenarioId action driver reported a failure."
    }
    $actionCompleted = @($actionMarkers | Where-Object {
      $_.event -eq 'scenario.action.dispatched'
    }).Count -gt 0
    if (-not $actionCompleted) { Start-Sleep -Milliseconds 25 }
  }
  if (-not $actionCompleted) {
    throw "Timed out after $ActionTimeoutSeconds seconds waiting for the $ScenarioId action to complete."
  }

  $creationTime = $process.StartTime.ToUniversalTime().ToString('o')
  $appMarkers = @(Get-Content -LiteralPath $eventsPath | ForEach-Object {
    try { ConvertFrom-Json -InputObject $_ } catch { $null }
  } | Where-Object { $null -ne $_ })
  $declaredProcessRoles = @{
    $process.Id = 'electron-main'
  }
  $includeDescendantsByPid = @{
    $process.Id = $false
  }
  $inventoryMarker = $appMarkers | Where-Object { $_.event -eq 'process.inventory' } | Select-Object -Last 1
  if ($null -ne $inventoryMarker) {
    foreach ($inventoryProcess in @($inventoryMarker.processes)) {
      $declaredProcessRoles[[int]$inventoryProcess.pid] = [string]$inventoryProcess.role
      $includeDescendantsByPid[[int]$inventoryProcess.pid] = $false
    }
  }
  $sidecarProcessIds = @()
  foreach ($sidecarMarker in @($appMarkers | Where-Object { $_.event -eq 'sidecar.spawned' })) {
    if ($sidecarMarker.childPid) {
      $sidecarProcessId = [int]$sidecarMarker.childPid
      $sidecarProcessIds += $sidecarProcessId
      $declaredProcessRoles[$sidecarProcessId] = 'agent-sidecar'
      $includeDescendantsByPid[$sidecarProcessId] = $false
    }
  }
  $sidecarDescendantIds = @()
  foreach ($sidecarProcessId in $sidecarProcessIds) {
    foreach ($sidecarDescendantId in @(Get-DescendantProcessIds -RootProcessId $sidecarProcessId)) {
      $sidecarDescendantIds += $sidecarDescendantId
      $declaredProcessRoles[$sidecarDescendantId] = if ($ScenarioId -eq 'mcp-stdio-tool') {
        'mcp:benchmark-echo'
      } else {
        'agent-sidecar-helper'
      }
      $includeDescendantsByPid[$sidecarDescendantId] = $false
    }
  }
  foreach ($electronDescendantId in @(Get-DescendantProcessIds -RootProcessId $process.Id)) {
    if ($declaredProcessRoles.ContainsKey($electronDescendantId) -or $electronDescendantId -in $sidecarDescendantIds) {
      continue
    }
    $declaredProcessRoles[$electronDescendantId] = 'electron-other'
    $includeDescendantsByPid[$electronDescendantId] = $false
  }

  $declaredProcesses = @()
  foreach ($declaredPid in $declaredProcessRoles.Keys) {
    try {
      $declaredProcess = Get-Process -Id $declaredPid -ErrorAction Stop
      $declaredProcesses += @{
        pid = $declaredProcess.Id
        creationTime = $declaredProcess.StartTime.ToUniversalTime().ToString('o')
        role = $declaredProcessRoles[$declaredPid]
        includeDescendants = [bool]$includeDescendantsByPid[$declaredProcess.Id]
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
    commitSha = $CommitSha
    executablePath = $command.Source
    executableSha256 = (Get-FileHash -LiteralPath $command.Source -Algorithm SHA256).Hash.ToLowerInvariant()
    processId = $process.Id
    processCreationTime = $creationTime
    qpcFrequency = $qpcFrequency
    launchQpcTicks = $launchTicks
    runtimeOperationalReceiptQpcTicks = $operationalReceiptTicks
    startupDurationMs = (($operationalReceiptTicks - $launchTicks) * 1000) / $qpcFrequency
    windows = if ($null -ne $inventoryMarker) { @($inventoryMarker.windows) } else { @() }
    browserWindowCount = if ($null -ne $inventoryMarker) { @($inventoryMarker.windows).Count } else { 0 }
    fixtureProviderBaseUrl = if ($null -ne $providerFixture) { [string]$providerFixture.baseUrl } else { '' }
    fixtureMcpHttpUrl = if ($null -ne $mcpHttpFixture) { [string]$mcpHttpFixture.url } else { '' }
    warmupRepetitions = $WarmupRepetitions
    actionRepetitions = $ActionRepetitions
    capturedUtc = [DateTime]::UtcNow.ToString('o')
  } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $captureMetadataPath -Encoding utf8
} finally {
  if ($null -ne $process -and -not $process.HasExited) {
    $process.Kill($true)
    $process.WaitForExit(5000) | Out-Null
  }
  foreach ($fixtureProcess in $fixtureProcesses) {
    if ($null -ne $fixtureProcess -and -not $fixtureProcess.HasExited) {
      $fixtureProcess.Kill($true)
      $fixtureProcess.WaitForExit(5000) | Out-Null
    }
  }
}
