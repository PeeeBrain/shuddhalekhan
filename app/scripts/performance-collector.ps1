param(
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,

  [int]$SampleSeconds = 60,
  [int]$SampleIntervalMs = 1000,
  [int]$SampleCount = 0,
  [int[]]$WatchPids = @(),
  [string]$WatchPidsCsv = '',
  [string]$ProcessRolesPath = '',
  [string]$DockerContainerId = '',
  [string]$DockerCommandPath = 'docker',
  [string]$NvidiaSmiPath = '',
  [switch]$IncludeRelatedProcesses
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ($WatchPidsCsv) {
  $WatchPids = @($WatchPidsCsv.Split(',') | ForEach-Object { [int]$_.Trim() } | Where-Object { $_ -gt 0 })
}

$processIdentityByPid = @{}
if ($ProcessRolesPath) {
  $roleManifest = Get-Content -Raw -LiteralPath $ProcessRolesPath | ConvertFrom-Json
  foreach ($entry in @($roleManifest.processes)) {
    $pidValue = [int]$entry.pid
    $declaredCreationTimeTicks = if ($null -ne $entry.PSObject.Properties['creationTime'] -and $entry.creationTime) {
      if ($entry.creationTime -is [DateTime]) {
        $entry.creationTime.ToUniversalTime().Ticks
      } else {
        ([DateTimeOffset]::Parse(
          [string]$entry.creationTime,
          [Globalization.CultureInfo]::InvariantCulture,
          [Globalization.DateTimeStyles]::RoundtripKind
        )).UtcTicks
      }
    } else {
      $null
    }
    $processIdentityByPid[$pidValue] = @{
      Role = [string]$entry.role
      CreationTimeTicks = $declaredCreationTimeTicks
      IncludeDescendants = if ($null -ne $entry.PSObject.Properties['includeDescendants']) {
        [bool]$entry.includeDescendants
      } else {
        $true
      }
    }
  }
  $WatchPids = @($processIdentityByPid.Keys | ForEach-Object { [int]$_ })
}

$effectiveSampleCount = if ($SampleCount -gt 0) {
  $SampleCount
} else {
  [Math]::Max(1, [Math]::Ceiling(($SampleSeconds * 1000) / $SampleIntervalMs))
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null

$processSamplePath = Join-Path $OutputDir 'process-samples.csv'
$metadataPath = Join-Path $OutputDir 'metadata.json'
$identityErrorPath = Join-Path $OutputDir 'process-identity-errors.jsonl'
$dockerSamplePath = Join-Path $OutputDir 'docker-samples.csv'
$gpuSamplePath = Join-Path $OutputDir 'gpu-samples.csv'
Remove-Item -LiteralPath $identityErrorPath -Force -ErrorAction SilentlyContinue

$header = 'sampleIndex,qpcTicks,qpcFrequency,utc,pid,creationTime,role,privateBytes,workingSet,handleCount,threadCount,cpuPercent'
Set-Content -Path $processSamplePath -Value $header -Encoding utf8
if ($DockerContainerId) {
  Set-Content -Path $dockerSamplePath -Encoding utf8 -Value 'sampleIndex,qpcTicks,qpcFrequency,utc,containerId,cpuPercent,memoryUsage,memoryLimit,networkInput,networkOutput,blockInput,blockOutput,pids'
}
if ($NvidiaSmiPath) {
  Set-Content -Path $gpuSamplePath -Encoding utf8 -Value 'sampleIndex,qpcTicks,qpcFrequency,utc,gpuUuid,utilizationPercent,memoryUsedMiB,memoryTotalMiB,powerWatts,temperatureCelsius'
}

$frequency = [System.Diagnostics.Stopwatch]::Frequency
$previousCpu = @{}
$trackedPids = @()
$trackedRoleByPid = @{}

function Update-TrackedPids {
  param([int[]]$RootPids, [switch]$IncludeTree)

  $all = [System.Collections.Generic.HashSet[int]]::new()
  $roles = @{}
  foreach ($rootPid in $RootPids) {
    [void]$all.Add($rootPid)
    $rootIdentity = $processIdentityByPid[$rootPid]
    $rootRole = if ($null -ne $rootIdentity) { $rootIdentity.Role } else { 'tracked' }
    $roles[$rootPid] = $rootRole
    $rootIncludesDescendants = $IncludeTree -and (
      $null -eq $rootIdentity -or [bool]$rootIdentity.IncludeDescendants
    )
    if (-not $rootIncludesDescendants) { continue }
    $queue = [System.Collections.Generic.Queue[int]]::new()
    $queue.Enqueue($rootPid)
    while ($queue.Count -gt 0) {
      $parentPid = $queue.Dequeue()
      $children = Get-CimInstance Win32_Process -Filter "ParentProcessId=$parentPid" -ErrorAction SilentlyContinue
      foreach ($child in $children) {
        $childPid = [int]$child.ProcessId
        $declaredChild = $processIdentityByPid[$childPid]
        [void]$all.Add($childPid)
        if ($null -ne $declaredChild) {
          $roles[$childPid] = $declaredChild.Role
          continue
        }
        $roles[$childPid] = $rootRole
        $queue.Enqueue($childPid)
      }
    }
  }
  $script:trackedPids = @($all)
  $script:trackedRoleByPid = $roles
}

Update-TrackedPids -RootPids $WatchPids -IncludeTree:$IncludeRelatedProcesses

function Get-ProcessRole {
  param(
    [System.Diagnostics.Process]$Process,
    [hashtable]$DeclaredProcesses,
    [hashtable]$TrackedRoles
  )

  if ($DeclaredProcesses.ContainsKey($Process.Id)) {
    return $DeclaredProcesses[$Process.Id].Role
  }
  if ($TrackedRoles.ContainsKey($Process.Id)) {
    return $TrackedRoles[$Process.Id]
  }

  $name = $Process.ProcessName.ToLowerInvariant()
  if ($name -like 'shuddhalekhan*' -or $name -eq 'electron') { return 'electron' }
  if ($name -like 'bun*') { return 'agent-sidecar' }
  if ($name -like 'docker*' -or $name -like 'com.docker*' -or $name -like 'wsl*' -or $name -like 'vmmemwsl') {
    return 'docker-wsl'
  }
  return 'other'
}

function Get-CpuPercent {
  param(
    [System.Diagnostics.Process]$Process,
    [long]$QpcTicks,
    [long]$QpcFrequency
  )

  $key = "$($Process.Id)|$($Process.StartTime.ToUniversalTime().ToString('o'))"
  try {
    $totalProcessorTime = $Process.TotalProcessorTime.TotalSeconds
  } catch {
    return 0
  }

  if (-not $previousCpu.ContainsKey($key)) {
    $previousCpu[$key] = @{ Total = $totalProcessorTime; AtQpc = $QpcTicks }
    return 0
  }

  $deltaSeconds = $totalProcessorTime - $previousCpu[$key].Total
  $elapsedSeconds = ($QpcTicks - $previousCpu[$key].AtQpc) / $QpcFrequency
  $previousCpu[$key] = @{ Total = $totalProcessorTime; AtQpc = $QpcTicks }
  if ($elapsedSeconds -le 0) { return 0 }
  $logicalCores = [Environment]::ProcessorCount
  return [Math]::Round((100 * $deltaSeconds) / ($elapsedSeconds * $logicalCores), 2)
}

$dockerImageDigest = ''
if ($DockerContainerId) {
  try {
    $dockerImageDigest = [string](& $DockerCommandPath inspect --format '{{.Image}}' $DockerContainerId 2>$null)
    $dockerImageDigest = $dockerImageDigest.Trim()
  } catch {
    # The sample remains diagnostic when immutable container provenance is unavailable.
  }
}

$nvidiaDriverVersion = ''
if ($NvidiaSmiPath) {
  try {
    $driverRows = @(& $NvidiaSmiPath '--query-gpu=driver_version' '--format=csv,noheader,nounits' 2>$null)
    $nvidiaDriverVersion = [string]($driverRows | Select-Object -First 1)
    $nvidiaDriverVersion = $nvidiaDriverVersion.Trim()
  } catch {
    # GPU samples remain useful when driver provenance cannot be queried.
  }
}

$metadata = @{
  schemaVersion = 1
  collector = 'performance-collector.ps1'
  qpcFrequency = $frequency
  logicalProcessorCount = [Environment]::ProcessorCount
  sampleIntervalMs = $SampleIntervalMs
  sampleSeconds = $SampleSeconds
  sampleCount = $effectiveSampleCount
  watchPids = $WatchPids
  dockerContainerId = $DockerContainerId
  dockerImageDigest = $dockerImageDigest
  nvidiaSamplingEnabled = [bool]$NvidiaSmiPath
  nvidiaDriverVersion = $nvidiaDriverVersion
  startedUtc = (Get-Date).ToUniversalTime().ToString('o')
  hostname = $env:COMPUTERNAME
}
$metadata | ConvertTo-Json -Depth 4 | Set-Content -Path $metadataPath -Encoding utf8

function Get-ThreadCount {
  param([System.Diagnostics.Process]$Process)
  try {
    return $Process.Threads.Count
  } catch {
    return 0
  }
}

function Split-MetricPair {
  param([string]$Value)
  $parts = @($Value -split '\s*/\s*')
  return @($parts[0], $(if ($parts.Count -gt 1) { $parts[1] } else { '' }))
}

for ($sampleIndex = 0; $sampleIndex -lt $effectiveSampleCount; $sampleIndex += 1) {
  if ($IncludeRelatedProcesses -and ($sampleIndex % 10) -eq 0) {
    Update-TrackedPids -RootPids $WatchPids -IncludeTree:$true
  }

  $qpcTicks = [System.Diagnostics.Stopwatch]::GetTimestamp()
  $utc = (Get-Date).ToUniversalTime().ToString('o')

  $processMap = @{}
  foreach ($watchPid in $trackedPids) {
    try {
      $candidate = Get-Process -Id $watchPid -ErrorAction Stop
      $declaredIdentity = $processIdentityByPid[$watchPid]
      if ($null -ne $declaredIdentity) {
        $declaredCreationTimeTicks = $declaredIdentity['CreationTimeTicks']
        if ($null -ne $declaredCreationTimeTicks) {
          $actualCreationTimeTicks = $candidate.StartTime.ToUniversalTime().Ticks
          if ([Math]::Abs([long]$actualCreationTimeTicks - [long]$declaredCreationTimeTicks) -gt [TimeSpan]::TicksPerMillisecond) {
            [ordered]@{
              pid = $candidate.Id
              expectedCreationTimeTicks = [long]$declaredCreationTimeTicks
              actualCreationTimeTicks = [long]$actualCreationTimeTicks
              observedUtc = [DateTime]::UtcNow.ToString('o')
            } | ConvertTo-Json -Compress | Add-Content -LiteralPath $identityErrorPath -Encoding utf8
            continue
          }
        }
      }
      $processMap[$watchPid] = $candidate
    } catch {
      continue
    }
  }

  foreach ($process in $processMap.Values) {
    try {
      $creationTime = $process.StartTime.ToUniversalTime().ToString('o')
      $role = Get-ProcessRole -Process $process -DeclaredProcesses $processIdentityByPid -TrackedRoles $trackedRoleByPid
      $cpuPercent = Get-CpuPercent -Process $process -QpcTicks $qpcTicks -QpcFrequency $frequency
      $line = @(
        $sampleIndex,
        $qpcTicks,
        $frequency,
        $utc,
        $process.Id,
        $creationTime,
        $role,
        $process.PrivateMemorySize64,
        $process.WorkingSet64,
        $process.HandleCount,
        (Get-ThreadCount -Process $process),
        $cpuPercent
      ) -join ','
      Add-Content -Path $processSamplePath -Value $line -Encoding utf8
    } catch {
      continue
    }
  }

  if ($DockerContainerId) {
    try {
      $dockerRaw = & $DockerCommandPath stats --no-stream --format '{{json .}}' $DockerContainerId 2>$null
      $dockerStats = $dockerRaw | ConvertFrom-Json
      $memory = Split-MetricPair ([string]$dockerStats.MemUsage)
      $network = Split-MetricPair ([string]$dockerStats.NetIO)
      $block = Split-MetricPair ([string]$dockerStats.BlockIO)
      $dockerLine = @(
        $sampleIndex,
        $qpcTicks,
        $frequency,
        $utc,
        $DockerContainerId,
        ([string]$dockerStats.CPUPerc).TrimEnd('%'),
        $memory[0],
        $memory[1],
        $network[0],
        $network[1],
        $block[0],
        $block[1],
        $dockerStats.PIDs
      ) -join ','
      Add-Content -LiteralPath $dockerSamplePath -Value $dockerLine -Encoding utf8
    } catch {
      # A missing/paused container invalidates this resource row, not the Windows sample.
    }
  }

  if ($NvidiaSmiPath) {
    try {
      $gpuRows = & $NvidiaSmiPath `
        '--query-gpu=uuid,utilization.gpu,memory.used,memory.total,power.draw,temperature.gpu' `
        '--format=csv,noheader,nounits' 2>$null
      foreach ($gpuRow in @($gpuRows)) {
        if (-not $gpuRow) { continue }
        $gpuValues = @(([string]$gpuRow).Split(',') | ForEach-Object { $_.Trim() })
        Add-Content -LiteralPath $gpuSamplePath -Encoding utf8 -Value "$sampleIndex,$qpcTicks,$frequency,$utc,$($gpuValues -join ',')"
      }
    } catch {
      # Unsupported GPU queries invalidate this resource row, not the Windows sample.
    }
  }

  Start-Sleep -Milliseconds $SampleIntervalMs
}

Write-Output "Wrote process samples to $processSamplePath"
