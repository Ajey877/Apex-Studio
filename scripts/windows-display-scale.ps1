# Windows display topology / scaling tool for the P9 (high-DPI) editor acceptance run.
#
# WHAT THIS IS: a thin wrapper over the same Win32 display-configuration calls the
# Windows Settings app uses. It changes the REAL display scale of a REAL Windows
# display, so every window on that display genuinely receives WM_DPICHANGED and
# GetDpiForWindow/GetDpiForMonitor genuinely report the new DPI. Nothing here
# fakes a DPI value or synthesises a window message.
#
# WHAT THIS IS NOT: it cannot create a monitor. On a single-display machine the
# multi-monitor criteria stay NOT_VERIFIED no matter what this script reports.
#
# Usage (PowerShell 5.1 or 7, Windows only):
#   windows-display-scale.ps1 -Action query
#   windows-display-scale.ps1 -Action modes
#   windows-display-scale.ps1 -Action set-resolution -Width 1920 -Height 1080
#   windows-display-scale.ps1 -Action set-scale -Scale 150 [-Monitor 0]
#   windows-display-scale.ps1 -Action screenshot -Hwnd 12345 -Out shot.png
#
# Every action prints exactly one line of JSON on stdout.
param(
  [ValidateSet('query', 'modes', 'set-resolution', 'set-scale', 'screenshot')]
  [string]$Action = 'query',
  [int]$Scale = 0,
  [int]$Monitor = 0,
  [int]$Width = 0,
  [int]$Height = 0,
  [long]$Hwnd = 0,
  [string]$Out = '',
  [int]$MaxWidth = 0
)
$ErrorActionPreference = 'Stop'

$source = @'
using System;
using System.Collections;
using System.Runtime.InteropServices;

public static class ApexDisplay {
  [StructLayout(LayoutKind.Sequential)] public struct LUID { public uint LowPart; public int HighPart; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_SOURCE { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct RATIONAL { public uint Numerator; public uint Denominator; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_TARGET {
    public LUID adapterId; public uint id; public uint modeInfoIdx; public uint outputTechnology; public uint rotation; public uint scaling;
    public RATIONAL refreshRate; public uint scanLineOrdering; public int targetAvailable; public uint statusFlags; }
  [StructLayout(LayoutKind.Sequential)] public struct PATH_INFO { public PATH_SOURCE sourceInfo; public PATH_TARGET targetInfo; public uint flags; }
  [StructLayout(LayoutKind.Explicit, Size = 64)] public struct MODE_INFO {
    [FieldOffset(0)] public uint infoType; [FieldOffset(4)] public uint id; [FieldOffset(8)] public LUID adapterId;
    [FieldOffset(16)] public uint sourceWidth; [FieldOffset(20)] public uint sourceHeight; [FieldOffset(24)] public uint pixelFormat;
    [FieldOffset(28)] public int positionX; [FieldOffset(32)] public int positionY; }
  [StructLayout(LayoutKind.Sequential)] public struct INFO_HEADER { public int type; public uint size; public LUID adapterId; public uint id; }
  [StructLayout(LayoutKind.Sequential)] public struct DPI_SCALE_GET { public INFO_HEADER header; public int minScaleRel; public int curScaleRel; public int maxScaleRel; }
  [StructLayout(LayoutKind.Sequential)] public struct DPI_SCALE_SET { public INFO_HEADER header; public int scaleRel; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct SOURCE_NAME {
    public INFO_HEADER header; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName; }
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct MONITORINFOEX {
    public int cbSize; public RECT rcMonitor; public RECT rcWork; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] public struct DEVMODE {
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
    public ushort dmSpecVersion, dmDriverVersion, dmSize, dmDriverExtra; public uint dmFields;
    public int dmPositionX, dmPositionY; public uint dmDisplayOrientation, dmDisplayFixedOutput;
    public short dmColor, dmDuplex, dmYResolution, dmTTOption, dmCollate;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
    public ushort dmLogPixels; public uint dmBitsPerPel, dmPelsWidth, dmPelsHeight, dmDisplayFlags, dmDisplayFrequency;
    public uint dmICMMethod, dmICMIntent, dmMediaType, dmDitherType, dmReserved1, dmReserved2, dmPanningWidth, dmPanningHeight; }

  public delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll")] static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPaths, out uint numModes);
  [DllImport("user32.dll")] static extern int QueryDisplayConfig(uint flags, ref uint numPaths, [Out] PATH_INFO[] paths, ref uint numModes, [Out] MODE_INFO[] modes, IntPtr topology);
  [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo")] static extern int GetDpiScale(ref DPI_SCALE_GET packet);
  [DllImport("user32.dll", EntryPoint = "DisplayConfigSetDeviceInfo")] static extern int SetDpiScale(ref DPI_SCALE_SET packet);
  [DllImport("user32.dll", EntryPoint = "DisplayConfigGetDeviceInfo", CharSet = CharSet.Unicode)] static extern int GetSourceName(ref SOURCE_NAME packet);
  [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorEnumProc proc, IntPtr data);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool GetMonitorInfoW(IntPtr hMonitor, ref MONITORINFOEX info);
  [DllImport("shcore.dll")] static extern int GetDpiForMonitor(IntPtr hMonitor, int dpiType, out uint dpiX, out uint dpiY);
  [DllImport("user32.dll")] static extern uint GetDpiForSystem();
  [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
  [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
  [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern bool EnumDisplaySettingsW(string device, int mode, ref DEVMODE dm);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int ChangeDisplaySettingsExW(string device, ref DEVMODE dm, IntPtr hwnd, uint flags, IntPtr param);
  [DllImport("user32.dll")] static extern bool SystemParametersInfoW(uint action, int param, IntPtr pv, uint winIni);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out RECT value, int size);
  [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);

  public static readonly int[] Steps = { 100, 125, 150, 175, 200, 225, 250, 300, 350, 400, 450, 500 };

  // Per-monitor-v2 for the calling thread, so every rectangle and DPI below is in
  // real physical pixels rather than virtualised for a DPI-unaware shell process.
  public static void Aware() { try { SetThreadDpiAwarenessContext(new IntPtr(-4)); } catch { } }

  static PATH_INFO[] Paths(out MODE_INFO[] modes) {
    uint numPaths, numModes;
    int sized = GetDisplayConfigBufferSizes(2, out numPaths, out numModes);
    if (sized != 0) throw new Exception("GetDisplayConfigBufferSizes failed: " + sized);
    PATH_INFO[] paths = new PATH_INFO[numPaths];
    modes = new MODE_INFO[numModes];
    int queried = QueryDisplayConfig(2, ref numPaths, paths, ref numModes, modes, IntPtr.Zero);
    if (queried != 0) throw new Exception("QueryDisplayConfig failed: " + queried);
    Array.Resize(ref paths, (int)numPaths);
    return paths;
  }

  public static ArrayList Sources() {
    Aware();
    ArrayList result = new ArrayList();
    MODE_INFO[] modes;
    PATH_INFO[] paths = Paths(out modes);
    for (int i = 0; i < paths.Length; i++) {
      Hashtable item = new Hashtable();
      item["index"] = i;
      item["sourceId"] = paths[i].sourceInfo.id;
      SOURCE_NAME name = new SOURCE_NAME();
      name.header.type = 1; name.header.size = (uint)Marshal.SizeOf(typeof(SOURCE_NAME));
      name.header.adapterId = paths[i].sourceInfo.adapterId; name.header.id = paths[i].sourceInfo.id;
      item["device"] = GetSourceName(ref name) == 0 ? name.viewGdiDeviceName : null;
      DPI_SCALE_GET get = new DPI_SCALE_GET();
      get.header.type = -3; get.header.size = (uint)Marshal.SizeOf(typeof(DPI_SCALE_GET));
      get.header.adapterId = paths[i].sourceInfo.adapterId; get.header.id = paths[i].sourceInfo.id;
      int status = GetDpiScale(ref get);
      item["dpiScaleQueryStatus"] = status;
      if (status == 0) {
        int cur = Math.Max(get.minScaleRel, Math.Min(get.maxScaleRel, get.curScaleRel));
        int minAbs = Math.Abs(get.minScaleRel);
        item["minScaleRel"] = get.minScaleRel; item["curScaleRel"] = get.curScaleRel; item["maxScaleRel"] = get.maxScaleRel;
        if (minAbs + get.maxScaleRel < Steps.Length) {
          item["recommendedPercent"] = Steps[minAbs];
          item["currentPercent"] = Steps[minAbs + cur];
          item["maximumPercent"] = Steps[minAbs + get.maxScaleRel];
        }
      }
      result.Add(item);
    }
    return result;
  }

  public static ArrayList Monitors() {
    Aware();
    ArrayList result = new ArrayList();
    MonitorEnumProc proc = delegate(IntPtr hMonitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      MONITORINFOEX info = new MONITORINFOEX();
      info.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
      Hashtable item = new Hashtable();
      item["handle"] = hMonitor.ToInt64();
      if (GetMonitorInfoW(hMonitor, ref info)) {
        item["device"] = info.szDevice;
        item["primary"] = (info.dwFlags & 1) != 0;
        item["left"] = info.rcMonitor.left; item["top"] = info.rcMonitor.top;
        item["width"] = info.rcMonitor.right - info.rcMonitor.left; item["height"] = info.rcMonitor.bottom - info.rcMonitor.top;
        item["workLeft"] = info.rcWork.left; item["workTop"] = info.rcWork.top;
        item["workWidth"] = info.rcWork.right - info.rcWork.left; item["workHeight"] = info.rcWork.bottom - info.rcWork.top;
      }
      uint x, y;
      int status = GetDpiForMonitor(hMonitor, 0, out x, out y);
      item["effectiveDpi"] = status == 0 ? (object)x : null;
      result.Add(item);
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
    GC.KeepAlive(proc);
    return result;
  }

  public static uint SystemDpi() { Aware(); return GetDpiForSystem(); }
  public static int MonitorCount() { return GetSystemMetrics(80); }

  /** Set one display source's scale exactly the way Settings does. Returns the Win32 status. */
  public static Hashtable SetScale(int pathIndex, int percent) {
    Aware();
    Hashtable result = new Hashtable();
    MODE_INFO[] modes;
    PATH_INFO[] paths = Paths(out modes);
    if (pathIndex < 0 || pathIndex >= paths.Length) { result["error"] = "no such display path"; return result; }
    DPI_SCALE_GET get = new DPI_SCALE_GET();
    get.header.type = -3; get.header.size = (uint)Marshal.SizeOf(typeof(DPI_SCALE_GET));
    get.header.adapterId = paths[pathIndex].sourceInfo.adapterId; get.header.id = paths[pathIndex].sourceInfo.id;
    int queried = GetDpiScale(ref get);
    result["queryStatus"] = queried;
    if (queried != 0) { result["error"] = "DisplayConfigGetDeviceInfo(DPI scale) failed"; return result; }
    int recommendedIndex = Math.Abs(get.minScaleRel);
    int wantedIndex = Array.IndexOf(Steps, percent);
    if (wantedIndex < 0) { result["error"] = "unsupported percent"; return result; }
    int relative = wantedIndex - recommendedIndex;
    result["relative"] = relative; result["minScaleRel"] = get.minScaleRel; result["maxScaleRel"] = get.maxScaleRel;
    if (relative < get.minScaleRel || relative > get.maxScaleRel) {
      result["error"] = "requested scale is outside the range Windows offers for this display";
      return result;
    }
    DPI_SCALE_SET set = new DPI_SCALE_SET();
    set.header.type = -4; set.header.size = (uint)Marshal.SizeOf(typeof(DPI_SCALE_SET));
    set.header.adapterId = paths[pathIndex].sourceInfo.adapterId; set.header.id = paths[pathIndex].sourceInfo.id;
    set.scaleRel = relative;
    result["setStatus"] = SetDpiScale(ref set);
    return result;
  }

  /** Primary-display fallback (the control the legacy Display applet used). */
  public static bool SetPrimaryScaleLegacy(int relativeIndex) { return SystemParametersInfoW(0x009F, relativeIndex, IntPtr.Zero, 1); }

  public static ArrayList Modes() {
    ArrayList result = new ArrayList();
    Hashtable seen = new Hashtable();
    DEVMODE dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    for (int i = 0; EnumDisplaySettingsW(null, i, ref dm); i++) {
      string key = dm.dmPelsWidth + "x" + dm.dmPelsHeight;
      if (!seen.ContainsKey(key)) { seen[key] = true; result.Add(key); }
    }
    return result;
  }

  public static Hashtable CurrentMode() {
    Hashtable result = new Hashtable();
    DEVMODE dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    if (EnumDisplaySettingsW(null, -1, ref dm)) { result["width"] = dm.dmPelsWidth; result["height"] = dm.dmPelsHeight; result["bitsPerPel"] = dm.dmBitsPerPel; }
    return result;
  }

  public static int SetResolution(int width, int height) {
    DEVMODE dm = new DEVMODE(); dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
    if (!EnumDisplaySettingsW(null, -1, ref dm)) return -100;
    dm.dmPelsWidth = (uint)width; dm.dmPelsHeight = (uint)height; dm.dmFields = 0x80000 | 0x100000;
    return ChangeDisplaySettingsExW(null, ref dm, IntPtr.Zero, 0, IntPtr.Zero);
  }

  /** Visible bounds of a top-level window in physical pixels (DWM extended frame). */
  public static Hashtable WindowBounds(long hwnd) {
    Aware();
    Hashtable result = new Hashtable();
    IntPtr handle = new IntPtr(hwnd);
    result["isWindow"] = IsWindow(handle);
    RECT rect;
    if (DwmGetWindowAttribute(handle, 9, out rect, Marshal.SizeOf(typeof(RECT))) != 0) {
      if (!GetWindowRect(handle, out rect)) return result;
      result["source"] = "GetWindowRect";
    } else result["source"] = "DWMWA_EXTENDED_FRAME_BOUNDS";
    result["left"] = rect.left; result["top"] = rect.top; result["width"] = rect.right - rect.left; result["height"] = rect.bottom - rect.top;
    result["dpi"] = GetDpiForWindow(handle);
    return result;
  }
}
'@
Add-Type -TypeDefinition $source -Language CSharp

function Get-State {
  [ordered]@{
    monitorCount = [ApexDisplay]::MonitorCount()
    systemDpi    = [ApexDisplay]::SystemDpi()
    mode         = [ApexDisplay]::CurrentMode()
    monitors     = @([ApexDisplay]::Monitors())
    sources      = @([ApexDisplay]::Sources())
  }
}

switch ($Action) {
  'query' { $result = Get-State }
  'modes' { $result = [ordered]@{ current = [ApexDisplay]::CurrentMode(); available = @([ApexDisplay]::Modes()) } }
  'set-resolution' {
    $status = [ApexDisplay]::SetResolution($Width, $Height)
    Start-Sleep -Milliseconds 1500
    $result = [ordered]@{ requested = "${Width}x${Height}"; status = $status; state = Get-State }
  }
  'set-scale' {
    $before = Get-State
    $set = [ApexDisplay]::SetScale($Monitor, $Scale)
    Start-Sleep -Milliseconds 2000
    $after = Get-State
    $result = [ordered]@{ requestedPercent = $Scale; monitor = $Monitor; set = $set; before = $before; after = $after }
  }
  'screenshot' {
    Add-Type -AssemblyName System.Drawing
    $bounds = [ApexDisplay]::WindowBounds($Hwnd)
    $result = [ordered]@{ hwnd = $Hwnd; bounds = $bounds; out = $Out; written = $false }
    if ($bounds['width'] -gt 0 -and $bounds['height'] -gt 0) {
      $bitmap = New-Object System.Drawing.Bitmap([int]$bounds['width'], [int]$bounds['height'])
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $size = New-Object System.Drawing.Size([int]$bounds['width'], [int]$bounds['height'])
      # Copies what is actually on the screen: the composed desktop pixels, not a
      # private render of the window. An occluded or off-screen window shows as such.
      $graphics.CopyFromScreen([int]$bounds['left'], [int]$bounds['top'], 0, 0, $size)
      $graphics.Dispose()
      if ($MaxWidth -gt 0 -and $bitmap.Width -gt $MaxWidth) {
        $scaledHeight = [int][math]::Round($bitmap.Height * $MaxWidth / $bitmap.Width)
        $scaled = New-Object System.Drawing.Bitmap($bitmap, $MaxWidth, $scaledHeight)
        $bitmap.Dispose(); $bitmap = $scaled
      }
      $bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
      $result['pixelWidth'] = $bitmap.Width; $result['pixelHeight'] = $bitmap.Height
      $bitmap.Dispose()
      $result['written'] = $true
      $result['bytes'] = (Get-Item $Out).Length
    }
  }
}
$result | ConvertTo-Json -Depth 8 -Compress
