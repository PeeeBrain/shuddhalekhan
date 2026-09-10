$ErrorActionPreference = 'SilentlyContinue'
foreach ($procId in @(78448, 76596)) {
  Write-Host "killing tree $procId"
  & taskkill /T /F /PID $procId 2>$null | Out-Null
}
Start-Sleep -Seconds 2

Add-Type @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public class W2 {
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
  public static List<string> Find(string needle) {
    var r = new List<string>();
    EnumWindows((h, lp) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      GetWindowText(h, sb, 512);
      if (sb.ToString().Contains(needle)) r.Add(h.ToInt64() + ":" + sb.ToString());
      return true;
    }, IntPtr.Zero);
    return r;
  }
}
'@
Write-Host "remaining: $([W2]::Find('shuddha-smoke-code-').Count)"
