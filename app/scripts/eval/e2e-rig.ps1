# End-to-end eval rig: drives the running app exactly like a user. It focuses its own text box, presses the
# Dictation hotkey, plays each clip into the VB-Cable virtual mic, presses the hotkey again and waits for the
# paste. Started by eval.ts --layer e2e:
#   powershell -Sta -File e2e-rig.ps1 <jobs.json> <out.json> <dev electron.exe path>
# jobs.json is [{ id, path, leadInMs }]. Needs Shuddhalekhan running with its microphone set to CABLE Output.
param([string]$Jobs, [string]$Out, [string]$ElectronExe)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms, System.Drawing -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

public class ClipRun { public string Id { get; set; } public string Text { get; set; } public double StopToPasteMs { get; set; } public bool ClipboardRestored { get; set; } }
public class RigRun { public ClipRun[] Clips { get; set; } public double PeakRssMb { get; set; } public double CpuMs { get; set; } }

public static class E2eRig {
  // ponytail: Dictation hotkey fixed to F2 in toggle mode; read it from the app config if that ever varies.
  const byte VK_F2 = 0x71;
  const string Sentinel = "shuddhalekhan-eval-clipboard-sentinel";
  const int PasteTimeoutMs = 15000;

  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hwnd);

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct WaveOutCaps { public ushort Mid, Pid; public uint DriverVersion; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name; public uint Formats; public ushort Channels, Reserved; public uint Support; }
  [StructLayout(LayoutKind.Sequential)]
  struct WaveFormat { public ushort Tag, Channels; public uint SampleRate, ByteRate; public ushort BlockAlign, Bits, Size; }
  [StructLayout(LayoutKind.Sequential)]
  struct WaveHeader { public IntPtr Data; public uint Length, Recorded; public IntPtr User; public uint Flags, Loops; public IntPtr Next, Reserved; }

  [DllImport("winmm.dll")] static extern int waveOutGetNumDevs();
  [DllImport("winmm.dll", EntryPoint = "waveOutGetDevCapsW", CharSet = CharSet.Unicode)] static extern int waveOutGetDevCaps(IntPtr id, ref WaveOutCaps caps, int size);
  [DllImport("winmm.dll")] static extern int waveOutOpen(out IntPtr handle, int device, ref WaveFormat format, IntPtr callback, IntPtr instance, int flags);
  [DllImport("winmm.dll")] static extern int waveOutPrepareHeader(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveOutWrite(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveOutUnprepareHeader(IntPtr handle, IntPtr header, int size);
  [DllImport("winmm.dll")] static extern int waveOutClose(IntPtr handle);

  static Form form;
  static TextBox box;
  static long pastedAt;

  static int CableDevice() {
    for (int i = 0; i < waveOutGetNumDevs(); i++) {
      var caps = new WaveOutCaps();
      if (waveOutGetDevCaps((IntPtr)i, ref caps, Marshal.SizeOf(caps)) == 0 && caps.Name.StartsWith("CABLE Input")) return i;
    }
    throw new Exception("No CABLE Input playback device; install VB-Audio Virtual Cable.");
  }

  /** Plays a PCM WAV into the device and returns once the driver has consumed it. */
  static void Play(int device, string path) {
    byte[] bytes = File.ReadAllBytes(path);
    var format = new WaveFormat();
    int dataOffset = -1, dataLength = 0;
    for (int pos = 12; pos + 8 <= bytes.Length; ) {
      string id = Encoding.ASCII.GetString(bytes, pos, 4);
      int size = BitConverter.ToInt32(bytes, pos + 4);
      if (id == "fmt ") {
        format.Tag = 1; // PCM; eval.ts only feeds PCM16 clips it has already decoded
        format.Channels = BitConverter.ToUInt16(bytes, pos + 10);
        format.SampleRate = BitConverter.ToUInt32(bytes, pos + 12);
        format.ByteRate = BitConverter.ToUInt32(bytes, pos + 16);
        format.BlockAlign = BitConverter.ToUInt16(bytes, pos + 20);
        format.Bits = BitConverter.ToUInt16(bytes, pos + 22);
      } else if (id == "data") {
        dataOffset = pos + 8;
        dataLength = Math.Min(size, bytes.Length - dataOffset);
        break;
      }
      pos += 8 + size + (size & 1);
    }
    if (dataOffset < 0) throw new Exception(path + " has no data chunk.");

    IntPtr handle;
    int status = waveOutOpen(out handle, device, ref format, IntPtr.Zero, IntPtr.Zero, 0);
    if (status != 0) throw new Exception("waveOutOpen failed: " + status);
    IntPtr data = Marshal.AllocHGlobal(dataLength);
    int headerSize = Marshal.SizeOf(typeof(WaveHeader));
    IntPtr header = Marshal.AllocHGlobal(headerSize);
    try {
      Marshal.Copy(bytes, dataOffset, data, dataLength);
      Marshal.StructureToPtr(new WaveHeader { Data = data, Length = (uint)dataLength }, header, false);
      waveOutPrepareHeader(handle, header, headerSize);
      waveOutWrite(handle, header, headerSize);
      int flagsOffset = (int)Marshal.OffsetOf(typeof(WaveHeader), "Flags");
      while ((Marshal.ReadInt32(header, flagsOffset) & 1) == 0) Thread.Sleep(5); // WHDR_DONE
      waveOutUnprepareHeader(handle, header, headerSize);
    } finally {
      waveOutClose(handle);
      Marshal.FreeHGlobal(header);
      Marshal.FreeHGlobal(data);
    }
  }

  /** The app's process tree: the packaged exe, or this repo's dev Electron (other Electron apps are ignored). */
  static List<Process> AppProcesses(string electronExe) {
    var found = new List<Process>();
    foreach (var process in Process.GetProcesses()) {
      if (process.ProcessName == "Shuddhalekhan") { found.Add(process); continue; }
      if (process.ProcessName != "electron") continue;
      try {
        if (string.Equals(process.MainModule.FileName, electronExe, StringComparison.OrdinalIgnoreCase)) found.Add(process);
      } catch (Exception) { }
    }
    return found;
  }

  static object Ui(Func<object> action) { return form.Invoke(action); }

  static void PressHotkey() {
    keybd_event(VK_F2, 0, 0, UIntPtr.Zero);
    keybd_event(VK_F2, 0, 2, UIntPtr.Zero); // KEYEVENTF_KEYUP
  }

  public static RigRun Run(string[] ids, string[] paths, int[] leadIns, string electronExe) {
    var startCpu = new Dictionary<int, TimeSpan>();
    foreach (var process in AppProcesses(electronExe)) startCpu[process.Id] = process.TotalProcessorTime;
    if (startCpu.Count == 0) throw new Exception("Shuddhalekhan isn't running. Start it (bun run dev or the installed app) first.");
    int device = CableDevice();

    var clock = Stopwatch.StartNew();
    form = new Form { Text = "Shuddhalekhan eval - keep this window focused, don't type", TopMost = true, Width = 900, Height = 300 };
    box = new TextBox { Multiline = true, Dock = DockStyle.Fill, Font = new System.Drawing.Font("Segoe UI", 12) };
    form.Controls.Add(box);
    box.TextChanged += delegate {
      if (box.TextLength > 0) Interlocked.CompareExchange(ref pastedAt, clock.ElapsedTicks, 0);
    };

    var clips = new List<ClipRun>();
    Exception failure = null;
    form.Shown += delegate {
      form.Activate();
      new Thread(delegate () {
        try {
          for (int i = 0; i < ids.Length; i++) {
            Ui(delegate { box.Clear(); Clipboard.SetText(Sentinel); box.Focus(); return null; });
            var hwnd = (IntPtr)Ui(delegate { return form.Handle; });
            if (GetForegroundWindow() != hwnd) {
              Ui(delegate { form.Activate(); return null; });
              SetForegroundWindow(hwnd);
              Thread.Sleep(300);
              if (GetForegroundWindow() != hwnd) throw new Exception("The eval window lost focus; stopped so a transcript can't land in another app.");
            }
            Thread.Sleep(500); // let the previous session fully settle
            Interlocked.Exchange(ref pastedAt, 0);

            PressHotkey();
            Thread.Sleep(leadIns[i]);
            Play(device, paths[i]);
            Thread.Sleep(300); // the clip's tail is still in the cable when the driver reports done
            long stopAt = clock.ElapsedTicks;
            PressHotkey();

            var waited = Stopwatch.StartNew();
            while (Interlocked.Read(ref pastedAt) == 0 && waited.ElapsedMilliseconds < PasteTimeoutMs) Thread.Sleep(5);
            long pasted = Interlocked.Read(ref pastedAt);
            if (pasted != 0) Thread.Sleep(1000); // the rest of the paste lands and the app restores the clipboard

            clips.Add(new ClipRun {
              Id = ids[i],
              Text = (string)Ui(delegate { return box.Text; }),
              StopToPasteMs = pasted == 0 ? -1 : (pasted - stopAt) * 1000.0 / Stopwatch.Frequency,
              ClipboardRestored = (string)Ui(delegate { return Clipboard.GetText(); }) == Sentinel,
            });
            Console.Error.WriteLine((i + 1) + "/" + ids.Length + " " + ids[i]);
            if (i == 2 && clips.TrueForAll(delegate (ClipRun clip) { return clip.StopToPasteMs < 0; })) {
              throw new Exception("Nothing pasted for the first 3 clips. Is Shuddhalekhan's microphone CABLE Output and Dictation on F2 (toggle)?");
            }
          }
        } catch (Exception error) {
          failure = error;
        } finally {
          form.BeginInvoke(new Action(form.Close));
        }
      }) { IsBackground = true }.Start();
    };
    Application.Run(form);
    if (failure != null) throw failure;

    // ponytail: summed per-process peak working sets (not a simultaneous peak), and CPU of processes that
    // exited mid-run is lost; fine for a paired comparison on the same machine.
    double peakBytes = 0, cpuMs = 0;
    foreach (var process in AppProcesses(electronExe)) {
      peakBytes += process.PeakWorkingSet64;
      TimeSpan before;
      cpuMs += (process.TotalProcessorTime - (startCpu.TryGetValue(process.Id, out before) ? before : TimeSpan.Zero)).TotalMilliseconds;
    }
    return new RigRun { Clips = clips.ToArray(), PeakRssMb = peakBytes / (1 << 20), CpuMs = cpuMs };
  }
}
'@
$jobList = Get-Content -LiteralPath $Jobs -Raw | ConvertFrom-Json
$run = [E2eRig]::Run([string[]]$jobList.id, [string[]]$jobList.path, [int[]]$jobList.leadInMs, $ElectronExe)
[IO.File]::WriteAllText($Out, (ConvertTo-Json -InputObject $run -Depth 4))
