# Live Dictation packaged insertion smoke.
#
# Drives the production Live Dictation dispatch seam (captureForegroundTarget ->
# validateExactTarget -> SendInput KEYEVENTF_UNICODE) against real Windows target
# applications and verifies the inserted text:
#   - Notepad / VS Code: save (^s) and compare the edited file on disk.
#   - Chromium textarea / Word / Windows Terminal: UI Automation readback.
#
# Reliability notes:
#   * A real mouse click (not UI Automation SetFocus) focuses the edit surface;
#     UIA SetFocus does not reliably move OS keyboard focus in hosted apps.
#   * The dispatcher runs in a hidden window so its console cannot steal
#     foreground away from the target between focus and SendInput.
#   * Top-level windows are discovered by owning process id (plus a class diff
#     for shared hosts) rather than by "newest window" heuristics.
# Cleanup closes only what this script created: dedicated processes are
# terminated by tracked PID; shared hosts (Windows Terminal tabs, Word windows)
# are closed on their exact created window/tab element.
#
# Usage:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\live-insertion-smoke\run-smoke.ps1
#     [-Targets notepad,windows-terminal,vscode,chromium-textarea,word]
#
# Results: <repo>\benchmark-output\live-insertion-smoke\<timestamp>\results.json and matrix.md

param(
  [string]$OutputRoot = "",
  [string]$Targets = "notepad,windows-terminal,vscode,chromium-textarea,word",
  [string]$VsCodePath = ""
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type -Namespace Native -Name Win32 -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder text, int count);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
[DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
"@

if (-not $OutputRoot) {
  $RepoGuess = (Get-Item (Join-Path $PSScriptRoot '..\..\..')).FullName
  $OutputRoot = Join-Path (Join-Path $RepoGuess 'benchmark-output') 'live-insertion-smoke'
}
$RunDir = Join-Path $OutputRoot (Get-Date -Format 'yyyy-MM-ddTHH-mm-ss')
New-Item -ItemType Directory -Force -Path $RunDir | Out-Null

$SelectedTargets = @($Targets.Split(',') | ForEach-Object { $_.Trim() })

$Cases = @(
  @{ Id = 'english';   Text = 'Hello from Shuddhalekhan smoke 123.' },
  @{ Id = 'hindi';     Text = 'नमस्ते दुनिया' },
  @{ Id = 'marathi';   Text = 'नमस्कार महाराष्ट्र' },
  @{ Id = 'emoji-zwj'; Text = 'ok 👨‍👩‍👧‍👦 🇮🇳 end' }
)

function Test-Selected { param([string]$Name) return $SelectedTargets -contains $Name }

function Get-RealPidFromHwnd {
  param([int]$Hwnd)
  $pidOut = 0
  [Native.Win32]::GetWindowThreadProcessId([IntPtr]$Hwnd, [ref]$pidOut) | Out-Null
  return [int]$pidOut
}

function Get-TopLevelWindows {
  return [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children,
    [System.Windows.Automation.Condition]::TrueCondition)
}

function Get-HwndSnapshot {
  param([string]$ClassName)
  $hwnds = @()
  if (-not $ClassName) { return $hwnds }
  $classCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ClassNameProperty, $ClassName)
  $windows = [System.Windows.Automation.AutomationElement]::RootElement.FindAll(
    [System.Windows.Automation.TreeScope]::Children, $classCond)
  foreach ($w in $windows) { $hwnds += [int]$w.Current.NativeWindowHandle }
  return $hwnds
}

function Find-WindowForPids {
  param([int[]]$Pids, [int[]]$ExcludeHwnds, [string]$ClassName, [string]$TitleNeedle)
  # Electron/Store apps expose auxiliary zero-size top-level windows alongside
  # the real one, so pick the largest visible match instead of the last one.
  $best = $null
  $bestArea = -1
  foreach ($w in Get-TopLevelWindows) {
    $hwnd = [int]$w.Current.NativeWindowHandle
    if ($hwnd -eq 0) { continue }
    if ($ExcludeHwnds -and ($ExcludeHwnds -contains $hwnd)) { continue }
    if (-not [Native.Win32]::IsWindowVisible([IntPtr]$hwnd)) { continue }
    if ($ClassName -and $w.Current.ClassName -ne $ClassName) { continue }
    if ($TitleNeedle -and ($w.Current.Name -notlike "*$TitleNeedle*")) { continue }
    if ($Pids -and $Pids.Count -gt 0 -and ($Pids -notcontains (Get-RealPidFromHwnd $hwnd))) { continue }
    $area = 0
    try {
      $rect = New-Object Native.Win32+RECT
      if ([Native.Win32]::GetWindowRect([IntPtr]$hwnd, [ref]$rect)) {
        $area = ([int]$rect.Right - [int]$rect.Left) * ([int]$rect.Bottom - [int]$rect.Top)
      }
    } catch { }
    if ($null -eq $best -or $area -gt $bestArea) {
      $best = $w
      $bestArea = $area
    }
  }
  return $best
}

function Find-TextSurface {
  param([System.Windows.Automation.AutomationElement]$Root, [string]$PreferredType)
  $typeNames = if ($PreferredType) { @($PreferredType, 'Edit', 'Document') } else { @('Edit', 'Document') }
  $seen = @{}
  foreach ($typeName in $typeNames) {
    if ($seen.ContainsKey($typeName)) { continue }
    $seen[$typeName] = $true
    $typeCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::$typeName)
    $el = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $typeCond)
    if ($null -ne $el) { return $el }
  }
  # Terminal surfaces expose neither Edit nor Document control types but do
  # carry a text pattern. Several descendants may expose one (for example the
  # tab label and the terminal buffer), so choose the largest visible region.
  $textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
  $candidates = $Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $textCond)
  $best = $null; $bestArea = -1.0
  for ($i = 0; $i -lt $candidates.Count; $i++) {
    $el = $candidates.Item($i)
    if ($null -eq $el) { continue }
    try {
      $r = $el.Current.BoundingRectangle
      if ($r.IsEmpty) { continue }
      if ([double]::IsNaN($r.Width) -or [double]::IsInfinity($r.Width) -or
          [double]::IsNaN($r.Height) -or [double]::IsInfinity($r.Height)) { continue }
      $area = $r.Width * $r.Height
    } catch { continue }
    if ($area -gt $bestArea) { $bestArea = $area; $best = $el }
  }
  if ($null -ne $best) { return $best }
  return $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $textCond)
}

function Read-UiText {
  param([System.Windows.Automation.AutomationElement]$Root)
  if ($null -eq $Root) { return $null }
  $vp = $null
  if ($Root.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$vp)) {
    $v = $vp.Current.Value
    if ($v) { return $v }
  }
  $tp = $null
  if ($Root.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp)) {
    $t = $tp.DocumentRange.GetText(40000)
    if ($t) { return $t }
  }
  $textCond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::IsTextPatternAvailableProperty, $true)
  $el = $Root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $textCond)
  if ($null -ne $el) {
    $tp2 = $null
    if ($el.TryGetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern, [ref]$tp2)) {
      return $tp2.DocumentRange.GetText(40000)
    }
  }
  return $null
}

function Invoke-MouseClick {
  param([System.Windows.Automation.AutomationElement]$Element, [System.Windows.Automation.AutomationElement]$WindowEl)
  $x = $null; $y = $null
  try {
    $r = $Element.Current.BoundingRectangle
    if ($r.Width -gt 1 -and $r.Height -gt 1) {
      $x = [int]($r.X + $r.Width / 2)
      $y = [int]($r.Y + $r.Height / 2)
    }
  } catch { }
  if ($null -eq $x -and $null -ne $WindowEl) {
    try {
      $r = $WindowEl.Current.BoundingRectangle
      $x = [int]($r.X + $r.Width / 2)
      $y = [int]($r.Y + [Math]::Min(120, $r.Height / 2))
    } catch { }
  }
  if ($null -eq $x) { return $false }
  [Native.Win32]::SetCursorPos($x, $y) | Out-Null
  Start-Sleep -Milliseconds 120
  [Native.Win32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  [Native.Win32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 250
  return $true
}

function Set-WindowForeground {
  param([int]$Hwnd)
  $target = [IntPtr]$Hwnd
  $fg = [Native.Win32]::GetForegroundWindow()
  if ($fg -eq $target) { return $true }
  try { [Native.Win32]::ShowWindow($target, 9) | Out-Null } catch { }  # SW_RESTORE
  $fgThread = 0; $fgPid = 0
  if ($fg -ne [IntPtr]::Zero) {
    $fgThread = [Native.Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
  }
  $myThread = [Native.Win32]::GetCurrentThreadId()
  $attached = $false
  if ($fgThread -ne 0 -and $fgThread -ne $myThread) {
    $attached = [Native.Win32]::AttachThreadInput($myThread, $fgThread, $true)
  }
  [Native.Win32]::SetForegroundWindow($target) | Out-Null
  if ($attached) { [Native.Win32]::AttachThreadInput($myThread, $fgThread, $false) | Out-Null }
  return ([Native.Win32]::GetForegroundWindow() -eq $target)
}

function Assert-WindowForeground {
  param([int]$Hwnd, [int[]]$AcceptablePids, [int]$TimeoutMs = 9000)
  $target = [IntPtr]$Hwnd
  $usedAltTrick = $false
  $deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
  while ([DateTime]::UtcNow -lt $deadline) {
    $fg = [Native.Win32]::GetForegroundWindow()
    if ($fg -eq $target) {
      if ($usedAltTrick) { [System.Windows.Forms.SendKeys]::SendWait('{ESC}') }
      return $true
    }
    if ($fg -ne [IntPtr]::Zero) {
      $fgPid = 0
      [Native.Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
      if ($AcceptablePids -contains [int]$fgPid -and $usedAltTrick) {
        [System.Windows.Forms.SendKeys]::SendWait('{ESC}')
        return $true
      }
    }
    [Native.Win32]::SetForegroundWindow($target) | Out-Null
    try { [Microsoft.VisualBasic.Interaction]::AppActivate($AcceptablePids[0]) } catch { }
    if (-not $usedAltTrick -and ([DateTime]::UtcNow -gt $deadline.AddSeconds(-4))) {
      # Last resort near timeout: an ALT tap unlocks SetForegroundWindow.
      [Native.Win32]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
      [Native.Win32]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
      [Native.Win32]::SetForegroundWindow($target) | Out-Null
      $usedAltTrick = $true
    }
    Start-Sleep -Milliseconds 400
  }
  $fg = [Native.Win32]::GetForegroundWindow()
  if ($fg -eq $target) { return $true }
  if ($fg -ne [IntPtr]::Zero) {
    $fgPid = 0
    [Native.Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid) | Out-Null
    return ($AcceptablePids -contains [int]$fgPid)
  }
  return $false
}

function Invoke-Dispatcher {
  param([string]$Text, [int]$SettleMs, [string]$ExeMatch, [int]$OwnerPid, [int]$Hwnd)
  $textB64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($Text))
  $outFile = Join-Path $env:TEMP ("shuddha-dispatch-" + [Guid]::NewGuid().ToString('N') + '.json')
  $errFile = "$outFile.err"
  $dispatchArgs = @(
    'run', (Join-Path $PSScriptRoot 'dispatch-once.ts'),
    '--textB64', $textB64, '--settle-ms', "$SettleMs",
    "--expect-exe=$ExeMatch", "--expect-pid=$OwnerPid", "--expect-hwnd=$Hwnd"
  )
  try {
    $proc = Start-Process -FilePath 'bun' -ArgumentList $dispatchArgs -WindowStyle Hidden `
      -RedirectStandardOutput $outFile -RedirectStandardError $errFile -PassThru
    if (-not $proc.WaitForExit(30000)) { try { $proc.Kill() } catch { } }
    Start-Sleep -Milliseconds 100
    $raw = if (Test-Path $outFile) { Get-Content -Raw -Path $outFile } else { '' }
    $json = $null
    foreach ($line in @($raw -split "`r?`n")) {
      $trimmed = $line.Trim()
      if ($trimmed.StartsWith('{')) { $json = $trimmed | ConvertFrom-Json; break }
    }
    if ($null -eq $json) {
      $err = if (Test-Path $errFile) { (Get-Content -Raw -Path $errFile) } else { '' }
      return @{ json = $null; raw = "$raw $err" }
    }
    return @{ json = $json; raw = $raw }
  } finally {
    Remove-Item -Force -ErrorAction SilentlyContinue $outFile, $errFile
  }
}

function Close-WindowGracefully {
  param([System.Windows.Automation.AutomationElement]$WindowEl)
  # Returns 'closed', 'save-prompt-discarded', or 'left-open'. Closes only the
  # exact window/tab element this script created.
  try {
    $wp = $null
    if ($WindowEl.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$wp)) {
      $wp.Close()
    } else {
      $hwnd = [IntPtr]$WindowEl.Current.NativeWindowHandle
      if ($hwnd -eq [IntPtr]::Zero) { return 'left-open' }
      [Native.Win32]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
    }
    Start-Sleep -Seconds 3

    # Discard a possible save prompt ("Don't Save") on a top-level dialog.
    $buttonCond = New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
      [System.Windows.Automation.ControlType]::Button)
    foreach ($round in 1..4) {
      foreach ($name in @("Don't Save", "Do&n't Save", 'Nicht speichern', '不保存', "Don't save")) {
        $nameCond = New-Object System.Windows.Automation.PropertyCondition(
          [System.Windows.Automation.AutomationElement]::NameProperty, $name)
        $and = New-Object System.Windows.Automation.AndCondition($buttonCond, $nameCond)
        $btn = [System.Windows.Automation.AutomationElement]::RootElement.FindFirst(
          [System.Windows.Automation.TreeScope]::Children, $and)
        if ($null -ne $btn) {
          $inv = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
          $inv.Invoke()
          Start-Sleep -Seconds 2
          return 'save-prompt-discarded'
        }
      }
      Start-Sleep -Seconds 1
    }
    return 'closed'
  } catch { return 'left-open' }
}

function Stop-Tree {
  param([int]$PidToKill)
  if ($PidToKill -le 0) { return }
  try { & taskkill /T /F /PID $PidToKill 2>$null | Out-Null } catch { }
  # Wait synchronously: the next cell must not race a dying instance for
  # foreground ownership.
  $deadline = [DateTime]::UtcNow.AddSeconds(6)
  while ([DateTime]::UtcNow -lt $deadline) {
    if ($null -eq (Get-Process -Id $PidToKill -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  }
}

function Invoke-Cell {
  param([string]$TargetId, [hashtable]$Case, [scriptblock]$Launch,
        [int]$SettleMs = 1200, [string]$FocusType = $null)

  $tempFiles = New-Object 'System.Collections.Generic.List[string]'
  $launchedPids = New-Object 'System.Collections.Generic.List[int]'
  $result = [ordered]@{
    target = $TargetId; case = $Case.Id
    dispatched = $false; certainty = $null; capturedExe = $null
    readbackFound = $false; status = 'not-run'; detail = $null
  }
  $windowEl = $null; $focusEl = $null; $launchInfo = $null; $sharedHost = $false
  try {
    $launchInfo = & $Launch $Case $tempFiles $launchedPids
    $sharedHost = [bool]$launchInfo.SharedHost

    $deadline = [DateTime]::UtcNow.AddSeconds(35)
    while ([DateTime]::UtcNow -lt $deadline -and $null -eq $windowEl) {
      Start-Sleep -Milliseconds 500
      $windowEl = Find-WindowForPids -Pids @($launchInfo.WindowPids) `
        -ExcludeHwnds @($launchInfo.KnownHwnds) -ClassName $launchInfo.WindowClass `
        -TitleNeedle $launchInfo.TitleNeedle
    }
    if ($null -eq $windowEl) { $result.status = 'window-timeout'; return $result }

    $hwnd = [int]$windowEl.Current.NativeWindowHandle
    $ownerPid = Get-RealPidFromHwnd $hwnd
    if ($ownerPid -gt 0 -and -not $sharedHost) { $launchedPids.Add($ownerPid) }
    $acceptablePids = @($ownerPid)

    $deadline = [DateTime]::UtcNow.AddSeconds(25)
    while ([DateTime]::UtcNow -lt $deadline -and $null -eq $focusEl) {
      Start-Sleep -Milliseconds 500
      $focusEl = Find-TextSurface -Root $windowEl -PreferredType $launchInfo.FocusType
    }
    if ($null -eq $focusEl) { $result.status = 'no-edit-surface'; return $result }

    $activated = $false
    for ($attempt = 1; $attempt -le 3 -and -not $activated; $attempt++) {
      if (-not (Assert-WindowForeground -Hwnd $hwnd -AcceptablePids $acceptablePids) -and -not $sharedHost) {
        $result.status = 'activation-failed'; return $result
      }
      Invoke-MouseClick -Element $focusEl -WindowEl $windowEl | Out-Null
      Start-Sleep -Milliseconds 150
      if (Assert-WindowForeground -Hwnd $hwnd -AcceptablePids $acceptablePids -TimeoutMs 4000) {
        $activated = $true
      }
    }
    if (-not $activated) { $result.status = 'activation-failed'; return $result }

    $dispatch = Invoke-Dispatcher -Text $Case.Text -SettleMs $SettleMs `
      -ExeMatch $launchInfo.ExeMatch -OwnerPid $ownerPid -Hwnd $hwnd
    if ($null -eq $dispatch.json) {
      $result.status = 'dispatcher-no-json'; $result.detail = $dispatch.raw; return $result
    }
    $json = $dispatch.json
    $result.capturedExe = $json.target.executablePath
    if ($json.ok -ne $true) {
      $result.status = "dispatcher-$($json.stage)"; $result.detail = $json.reason; return $result
    }

    if ($launchInfo.ExeMatch -and $result.capturedExe -and
        ($result.capturedExe.ToLower() -notlike "*$($launchInfo.ExeMatch)*")) {
      $result.status = 'wrong-target'
      $result.detail = "captured $($result.capturedExe)"
      return $result
    }

    $result.dispatched = $true
    $result.certainty = $json.certainty
    if ($json.certainty -ne 'os-accepted-all') {
      $result.status = "dispatch-$($json.certainty)"
      return $result
    }

    Start-Sleep -Milliseconds 800

    # Ground truth when we own the edited file: save (^s keeps the insertion
    # path clipboard-free) and compare on disk.
    if ($launchInfo.SavePath) {
      [Native.Win32]::SetForegroundWindow([IntPtr]$hwnd) | Out-Null
      Start-Sleep -Milliseconds 200
      [System.Windows.Forms.SendKeys]::SendWait('^s')
      Start-Sleep -Milliseconds 2000
      $saved = Get-Content -Raw -Encoding UTF8 -Path $launchInfo.SavePath -ErrorAction SilentlyContinue
      if ($null -ne $saved) {
        $needleNorm = ($Case.Text -replace '\s+', ' ')
        $savedNorm = ($saved -replace '\s+', ' ')
        if ($saved.Contains($Case.Text)) {
          $result.readbackFound = $true; $result.status = 'pass-saved-file'
        } elseif ($savedNorm.Contains($needleNorm)) {
          $result.readbackFound = $true; $result.status = 'pass-saved-normalized'
        } else {
          $result.status = 'text-mismatch'
          $snippet = $saved.Substring(0, [Math]::Min(70, $saved.Length))
          $result.detail = "saved=[$snippet]"
        }
        return $result
      }
      # Saving produced nothing readable yet; fall back to UIA readback.
    }

    $text = Read-UiText -Root $focusEl
    if ($null -eq $text -or $text.Length -eq 0) { $text = Read-UiText -Root $windowEl }
    if ($null -eq $text) { $result.status = 'readback-unavailable'; return $result }

    if ($text.Contains($Case.Text)) {
      $result.readbackFound = $true; $result.status = 'pass'
    } else {
      $normText = ($text -replace '\s+', ' ')
      $normNeedle = ($Case.Text -replace '\s+', ' ')
      if ($normText.Contains($normNeedle)) {
        $result.readbackFound = $true; $result.status = 'pass-normalized'
      } else {
        $result.status = 'text-mismatch'
        $snippet = $text.Substring(0, [Math]::Min(90, $text.Length))
        $result.detail = "readback=[$snippet]"
      }
    }
    return $result
  } catch {
    $result.status = 'error'; $result.detail = $_.Exception.Message
    return $result
  } finally {
    if ($sharedHost -and $null -ne $windowEl) {
      Close-WindowGracefully -WindowEl $windowEl | Out-Null
    } else {
      foreach ($p in $launchedPids) { Stop-Tree -PidToKill $p }
    }
    foreach ($f in $tempFiles) { Remove-Item -Force -ErrorAction SilentlyContinue $f }
    Start-Sleep -Milliseconds 1200
  }
}

$results = New-Object 'System.Collections.Generic.List[object]'

# --- Notepad ----------------------------------------------------------------
# Windows 11 Notepad is a Store app: the process Start-Process returns is a
# launcher stub, and the visible window belongs to a separate app-host process.
# Discover the window by class + unique filename, close it on its own element,
# and refuse to touch any Notepad window that was open before this run.
$script:notepadBaseline = @(Get-Process -Name Notepad -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 })
$notepadLaunch = {
  param($Case, $tempFiles, $launchedPids)
  if ($script:notepadBaseline.Count -gt 0) {
    throw 'a pre-existing Notepad window is open; refusing to drive it'
  }
  $docPath = Join-Path $env:TEMP ("shuddha-smoke-notepad-" + [Guid]::NewGuid().ToString('N') + '.txt')
  Set-Content -Path $docPath -Encoding UTF8 -Value ''
  $tempFiles.Add($docPath)
  Start-Process "$env:SystemRoot\System32\notepad.exe" -ArgumentList "`"$docPath`"" | Out-Null
  Start-Sleep -Seconds 3
  @{
    ExeMatch = 'notepad.exe'
    TitleNeedle = (Split-Path -Leaf $docPath)
    WindowPids = @()
    KnownHwnds = @()
    WindowClass = 'Notepad'
    FocusType = 'Document'
    SavePath = $docPath
    SharedHost = $true
  }
}
if (Test-Selected 'notepad') {
  foreach ($case in $Cases) {
    Write-Host "smoke: notepad / $($case.Id)"
    $results.Add((Invoke-Cell -TargetId 'notepad' -Case $case -Launch $notepadLaunch))
  }
}

# --- Windows Terminal -------------------------------------------------------
# wt.exe opens tabs inside the running single-instance terminal process, so the
# created window is closed on its own element; the host process is never killed.
$wtLaunch = {
  param($Case, $tempFiles, $launchedPids)
  $known = Get-HwndSnapshot -ClassName 'CASCADIA_HOSTING_WINDOW_CLASS'
  Start-Process 'wt.exe' -ArgumentList @('-w', 'new', 'nt') | Out-Null
  Start-Sleep -Seconds 4
  @{
    ExeMatch = 'windowsterminal.exe'
    WindowPids = @()
    KnownHwnds = $known
    WindowClass = 'CASCADIA_HOSTING_WINDOW_CLASS'
    SharedHost = $true
  }
}
if (Test-Selected 'windows-terminal') {
  foreach ($case in $Cases) {
    Write-Host "smoke: windows-terminal / $($case.Id)"
    $results.Add((Invoke-Cell -TargetId 'windows-terminal' -Case $case -Launch $wtLaunch -SettleMs 1500))
  }
}

# --- VS Code ----------------------------------------------------------------
$codeLaunch = {
  param($Case, $tempFiles, $launchedPids)
  $candidates = @()
  if ($VsCodePath) { $candidates += $VsCodePath }
  if ($env:LOCALAPPDATA) { $candidates += Join-Path $env:LOCALAPPDATA 'Programs\Microsoft VS Code\Code.exe' }
  if ($env:ProgramFiles) { $candidates += Join-Path $env:ProgramFiles 'Microsoft VS Code\Code.exe' }
  if (${env:ProgramFiles(x86)}) { $candidates += Join-Path ${env:ProgramFiles(x86)} 'Microsoft VS Code\Code.exe' }
  $codeExe = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $codeExe) { throw 'VS Code not found. Pass -VsCodePath with the path to Code.exe.' }
  $tmp = Join-Path $env:TEMP ("shuddha-smoke-code-" + [Guid]::NewGuid().ToString('N') + '.txt')
  Set-Content -Path $tmp -Encoding UTF8 -Value ''
  $tempFiles.Add($tmp)
  $userData = Join-Path ([System.IO.Path]::GetTempPath()) "shuddha-smoke-code-$([Guid]::NewGuid().ToString('N'))"
  $before = @(Get-Process -Name Code -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  Start-Process $codeExe -ArgumentList @(
    '--force-renderer-accessibility', '--new-window', '--disable-extensions',
    '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
    "--user-data-dir=$userData", $tmp) | Out-Null
  Start-Sleep -Seconds 8
  $newPids = @(Get-Process -Name Code -ErrorAction SilentlyContinue |
    Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  if ($newPids.Count -eq 0) { throw 'VS Code did not spawn new processes' }
  foreach ($p in $newPids) { $launchedPids.Add($p) }
  @{
    ExeMatch = 'code.exe'
    TitleNeedle = (Split-Path -Leaf $tmp)
    WindowPids = $newPids
    KnownHwnds = @()
    WindowClass = $null
    FocusType = 'Document'
    SavePath = $tmp
  }
}
if (Test-Selected 'vscode') {
  foreach ($case in $Cases) {
    Write-Host "smoke: vscode / $($case.Id)"
    $results.Add((Invoke-Cell -TargetId 'vscode' -Case $case -Launch $codeLaunch))
  }
}

# --- Chromium text fields ----------------------------------------------------
$formHtmlPath = Join-Path $env:TEMP ('shuddha-smoke-form-' + [Guid]::NewGuid().ToString('N') + '.html')
@'
<!doctype html><html><body>
<textarea id="t" rows="8" cols="60" autofocus></textarea>
</body></html>
'@ | Set-Content -Path $formHtmlPath -Encoding UTF8

$chromeLaunch = {
  param($Case, $tempFiles, $launchedPids)
  $chromeExe = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
  if (-not (Test-Path $chromeExe)) { throw "Chrome not found at $chromeExe" }
  $userData = Join-Path ([System.IO.Path]::GetTempPath()) "shuddha-smoke-chrome-$([Guid]::NewGuid().ToString('N'))"
  $before = @(Get-Process -Name chrome -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  Start-Process $chromeExe -ArgumentList @(
    "--user-data-dir=$userData", '--no-first-run', '--window-size=700,500',
    ('"file:///' + (($formHtmlPath -replace '\\', '/')) + '"')) | Out-Null
  Start-Sleep -Seconds 6
  $newPids = @(Get-Process -Name chrome -ErrorAction SilentlyContinue |
    Where-Object { $before -notcontains $_.Id } | ForEach-Object { $_.Id })
  if ($newPids.Count -eq 0) { throw 'Chrome did not spawn new processes' }
  foreach ($p in $newPids) { $launchedPids.Add($p) }
  @{
    ExeMatch = 'chrome.exe'
    TitleNeedle = (Split-Path -Leaf $formHtmlPath)
    WindowPids = $newPids
    KnownHwnds = @()
    WindowClass = $null
  }
}
if (Test-Selected 'chromium-textarea') {
  foreach ($case in $Cases) {
    Write-Host "smoke: chromium / $($case.Id)"
    $results.Add((Invoke-Cell -TargetId 'chromium-textarea' -Case $case -Launch $chromeLaunch))
  }
}
Remove-Item -Force -ErrorAction SilentlyContinue $formHtmlPath

# --- Microsoft Word ----------------------------------------------------------
# Word hosts every open document in one process. Snapshot existing document
# windows (class OpusApp), open our own throwaway RTF document, and close only
# that window afterwards.
$wordLaunch = {
  param($Case, $tempFiles, $launchedPids)
  $wordExe = 'C:\Program Files\Microsoft Office\root\Office16\WINWORD.EXE'
  if (-not (Test-Path $wordExe)) { throw "Word not found at $wordExe" }
  $docPath = Join-Path $env:TEMP ("shuddha-smoke-word-$($Case.Id)-" + [Guid]::NewGuid().ToString('N') + '.rtf')
  Set-Content -Path $docPath -Encoding ASCII -Value '{\rtf1\ansi SMOKE\par}'
  $tempFiles.Add($docPath)
  $known = Get-HwndSnapshot -ClassName 'OpusApp'
  Start-Process $wordExe -ArgumentList @('/q', '/n', "`"$docPath`"") | Out-Null
  Start-Sleep -Seconds 16
  @{
    ExeMatch = 'winword.exe'
    TitleNeedle = (Split-Path -Leaf $docPath)
    WindowPids = @()
    KnownHwnds = $known
    WindowClass = 'OpusApp'
    FocusType = 'Document'
    SharedHost = $true
  }
}
if (Test-Selected 'word') {
  foreach ($case in $Cases) {
    Write-Host "smoke: word / $($case.Id)"
    $results.Add((Invoke-Cell -TargetId 'word' -Case $case -Launch $wordLaunch -SettleMs 2500))
  }
}

# --- Emit artifacts ----------------------------------------------------------
$jsonPath = Join-Path $RunDir 'results.json'
$results | ConvertTo-Json -Depth 5 | Set-Content -Path $jsonPath -Encoding UTF8

$md = New-Object 'System.Collections.Generic.List[string]'
$md.Add('# Live insertion packaged smoke — ' + (Split-Path -Leaf $RunDir))
$md.Add('')
$md.Add('| Target | Case | Dispatch | Certainty | Readback | Status | Detail |')
$md.Add('|---|---|---|---|---|---|---|')
foreach ($r in $results) {
  $md.Add("| $($r.target) | $($r.case) | $($r.dispatched) | $($r.certainty) | $($r.readbackFound) | $($r.status) | $($r.detail) |")
}
$md | Set-Content -Path (Join-Path $RunDir 'matrix.md') -Encoding UTF8

Write-Host "results: $jsonPath"
$unverified = @($results | Where-Object { $_.status -eq 'readback-unavailable' })
if ($unverified.Count -gt 0) {
  Write-Host "unverified insertions (no readback surface): $($unverified.Count)"
}
$failed = @($results | Where-Object {
  $_.status -notin @('pass', 'pass-normalized', 'pass-saved-file', 'pass-saved-normalized') })
exit $(if ($failed.Count -gt 0) { 1 } else { 0 })
