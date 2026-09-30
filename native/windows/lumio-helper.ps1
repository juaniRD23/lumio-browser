# lumio-helper.ps1: Windows twin of the Mac helper (native/LumioHelper).
# Reads JSON lines on stdin ({id, cmd, ...}) and answers on stdout
# ({id, ok, ...} or {id, ok:false, error}). Coordinates are physical screen
# pixels (the process is DPI-aware), the same space SetCursorPos uses.
# Runs under Windows PowerShell 5.1: powershell.exe -NoProfile -File lumio-helper.ps1
$ErrorActionPreference = 'Stop'
# UTF-8 without a byte-order mark, so the first JSON line parses cleanly.
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding $false
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class LumioNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll", SetLastError = true)] public static extern uint SendInput(uint n, INPUT[] inputs, int size);

  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk; public ushort wScan; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct HARDWAREINPUT { public uint uMsg; public ushort wParamL; public ushort wParamH; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
    [FieldOffset(0)] public HARDWAREINPUT hi;
  }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }

  const uint INPUT_MOUSE = 0, INPUT_KEYBOARD = 1;
  const uint KEYUP = 0x0002, UNICODE = 0x0004;

  static void Send(INPUT[] inputs) { SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(INPUT))); }

  public static void Mouse(uint flags, int data) {
    var i = new INPUT { type = INPUT_MOUSE };
    i.u.mi = new MOUSEINPUT { dwFlags = flags, mouseData = (uint)data };
    Send(new[] { i });
  }

  public static void Key(ushort vk, bool up) {
    var i = new INPUT { type = INPUT_KEYBOARD };
    i.u.ki = new KEYBDINPUT { wVk = vk, dwFlags = up ? KEYUP : 0 };
    Send(new[] { i });
  }

  // Unicode typing works for any character, independent of keyboard layout.
  public static void TypeText(string text) {
    foreach (char c in text) {
      if (c == '\n' || c == '\r') { if (c == '\n') { Key(0x0D, false); Key(0x0D, true); } continue; }
      var down = new INPUT { type = INPUT_KEYBOARD };
      down.u.ki = new KEYBDINPUT { wScan = c, dwFlags = UNICODE };
      var up = new INPUT { type = INPUT_KEYBOARD };
      up.u.ki = new KEYBDINPUT { wScan = c, dwFlags = UNICODE | KEYUP };
      Send(new[] { down, up });
    }
  }

  public static string ForegroundTitle() {
    var sb = new StringBuilder(512);
    GetWindowText(GetForegroundWindow(), sb, sb.Capacity);
    return sb.ToString();
  }

  public static uint ForegroundPid() {
    uint pid;
    GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    return pid;
  }
}
"@

[void][LumioNative]::SetProcessDPIAware()

$MOUSE = @{ LEFTDOWN = 0x0002; LEFTUP = 0x0004; RIGHTDOWN = 0x0008; RIGHTUP = 0x0010; WHEEL = 0x0800; HWHEEL = 0x1000 }
$VK = @{
  'ctrl' = 0x11; 'control' = 0x11; 'cmd' = 0x11; 'command' = 0x11; 'shift' = 0x10; 'alt' = 0x12; 'option' = 0x12; 'win' = 0x5B; 'meta' = 0x5B; 'super' = 0x5B;
  'enter' = 0x0D; 'return' = 0x0D; 'tab' = 0x09; 'escape' = 0x1B; 'esc' = 0x1B; 'space' = 0x20; 'backspace' = 0x08; 'delete' = 0x2E; 'del' = 0x2E;
  'up' = 0x26; 'down' = 0x28; 'left' = 0x25; 'right' = 0x27; 'arrowup' = 0x26; 'arrowdown' = 0x28; 'arrowleft' = 0x25; 'arrowright' = 0x27;
  'home' = 0x24; 'end' = 0x23; 'pageup' = 0x21; 'pagedown' = 0x22; 'insert' = 0x2D; 'capslock' = 0x14; 'printscreen' = 0x2C;
  '-' = 0xBD; '=' = 0xBB; ',' = 0xBC; '.' = 0xBE; '/' = 0xBF; ';' = 0xBA; "'" = 0xDE; '[' = 0xDB; ']' = 0xDD; '\' = 0xDC; '`' = 0xC0
}
for ($i = 1; $i -le 24; $i++) { $VK["f$i"] = 0x6F + $i }
$MODIFIERS = @(0x11, 0x10, 0x12, 0x5B)

function Get-Displays {
  $screens = [System.Windows.Forms.Screen]::AllScreens
  $list = @()
  for ($i = 0; $i -lt $screens.Length; $i++) {
    $b = $screens[$i].Bounds
    $list += [ordered]@{ id = $i + 1; main = $screens[$i].Primary; x = $b.X; y = $b.Y; width = $b.Width; height = $b.Height }
  }
  return ,$list
}

function Get-Cursor {
  $p = New-Object LumioNative+POINT
  [void][LumioNative]::GetCursorPos([ref]$p)
  return $p
}

function Pick-Display($which) {
  $displays = Get-Displays
  if ($which -eq 'main') { return ($displays | Where-Object { $_.main } | Select-Object -First 1) }
  $n = 0
  if ([int]::TryParse([string]$which, [ref]$n)) {
    $d = $displays | Where-Object { $_.id -eq $n } | Select-Object -First 1
    if ($d) { return $d }
  }
  $c = Get-Cursor
  $d = $displays | Where-Object { $c.X -ge $_.x -and $c.X -lt ($_.x + $_.width) -and $c.Y -ge $_.y -and $c.Y -lt ($_.y + $_.height) } | Select-Object -First 1
  if ($d) { return $d }
  return $displays[0]
}

function Take-Screenshot($msg) {
  $d = Pick-Display $msg.display
  $bmp = New-Object System.Drawing.Bitmap $d.width, $d.height
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($d.x, $d.y, 0, 0, $bmp.Size)
  $g.Dispose()
  $maxWidth = if ($msg.maxWidth) { [int]$msg.maxWidth } else { 1440 }
  $w = [Math]::Min($maxWidth, $d.width)
  $h = [int][Math]::Round($d.height * $w / $d.width)
  $out = New-Object System.Drawing.Bitmap $w, $h
  $g2 = [System.Drawing.Graphics]::FromImage($out)
  $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g2.DrawImage($bmp, 0, 0, $w, $h)
  $g2.Dispose(); $bmp.Dispose()
  $codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
  $params = New-Object System.Drawing.Imaging.EncoderParameters 1
  $params.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 80L
  $ms = New-Object System.IO.MemoryStream
  $out.Save($ms, $codec, $params)
  $out.Dispose()
  $front = ''
  try { $front = (Get-Process -Id ([LumioNative]::ForegroundPid())).ProcessName } catch {}
  return @{
    image = [Convert]::ToBase64String($ms.ToArray()); width = $w; height = $h; display = $d.id;
    bounds = @{ x = $d.x; y = $d.y; width = $d.width; height = $d.height };
    displays = (Get-Displays); frontmost = $front
  }
}

function Click-At($x, $y, $button, $count) {
  [void][LumioNative]::SetCursorPos([int]$x, [int]$y)
  Start-Sleep -Milliseconds 30
  $down = if ($button -eq 'right') { $MOUSE.RIGHTDOWN } else { $MOUSE.LEFTDOWN }
  $up = if ($button -eq 'right') { $MOUSE.RIGHTUP } else { $MOUSE.LEFTUP }
  for ($i = 0; $i -lt [Math]::Max(1, [int]$count); $i++) {
    [LumioNative]::Mouse($down, 0); [LumioNative]::Mouse($up, 0)
    Start-Sleep -Milliseconds 40
  }
}

function Drag($x1, $y1, $x2, $y2) {
  [void][LumioNative]::SetCursorPos([int]$x1, [int]$y1)
  Start-Sleep -Milliseconds 50
  [LumioNative]::Mouse($MOUSE.LEFTDOWN, 0)
  for ($s = 1; $s -le 20; $s++) {
    [void][LumioNative]::SetCursorPos([int]($x1 + ($x2 - $x1) * $s / 20), [int]($y1 + ($y2 - $y1) * $s / 20))
    Start-Sleep -Milliseconds 15
  }
  [LumioNative]::Mouse($MOUSE.LEFTUP, 0)
}

function Press-Combo([string]$combo) {
  $parts = $combo.ToLower().Replace(' ', '') -split '\+'
  $codes = @()
  foreach ($p in $parts) {
    if ($p -eq '') { continue }
    if ($VK.ContainsKey($p)) { $codes += $VK[$p] }
    elseif ($p.Length -eq 1 -and $p -match '[a-z0-9]') { $codes += [int][char]$p.ToUpper() }
    else { throw "Unknown key '$p' in '$combo'." }
  }
  $mods = @($codes | Where-Object { $MODIFIERS -contains $_ })
  $keys = @($codes | Where-Object { $MODIFIERS -notcontains $_ })
  foreach ($m in $mods) { [LumioNative]::Key([uint16]$m, $false) }
  foreach ($k in $keys) { [LumioNative]::Key([uint16]$k, $false); [LumioNative]::Key([uint16]$k, $true) }
  [array]::Reverse($mods)
  foreach ($m in $mods) { [LumioNative]::Key([uint16]$m, $true) }
}

function Get-Apps {
  $frontPid = [LumioNative]::ForegroundPid()
  $apps = @(); $windows = @(); $seen = @{}
  foreach ($p in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle })) {
    $name = $p.ProcessName
    try { if ($p.MainModule.FileVersionInfo.FileDescription) { $name = $p.MainModule.FileVersionInfo.FileDescription } } catch {}
    if (-not $seen.ContainsKey($name)) { $seen[$name] = $true; $apps += @{ name = $name; active = ($p.Id -eq $frontPid); hidden = $false } }
    $windows += @{ owner = $name; title = $p.MainWindowTitle }
  }
  return @{ apps = $apps; windows = $windows }
}

function Reply($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
  [Console]::Out.Flush()
}

while ($null -ne ($line = [Console]::In.ReadLine())) {
  if (-not $line.Trim()) { continue }
  try { $msg = $line | ConvertFrom-Json } catch { continue }
  $id = $msg.id
  try {
    $result = @{}
    switch ($msg.cmd) {
      'ping' { $result = @{ pong = $true } }
      'permissions' { $result = @{ accessibility = $true; screen = $true } }
      'request_permissions' { }
      'displays' { $c = Get-Cursor; $result = @{ displays = (Get-Displays); cursor = @{ x = $c.X; y = $c.Y } } }
      'screenshot' { $result = Take-Screenshot $msg }
      'move' { [void][LumioNative]::SetCursorPos([int]$msg.x, [int]$msg.y) }
      'click' { Click-At $msg.x $msg.y $msg.button $msg.count }
      'drag' { Drag $msg.x1 $msg.y1 $msg.x2 $msg.y2 }
      'scroll' {
        [void][LumioNative]::SetCursorPos([int]$msg.x, [int]$msg.y)
        if ($msg.dy) { [LumioNative]::Mouse($MOUSE.WHEEL, [int]$msg.dy * 120) }
        if ($msg.dx) { [LumioNative]::Mouse($MOUSE.HWHEEL, -[int]$msg.dx * 120) }
      }
      'type' { [LumioNative]::TypeText([string]$msg.text) }
      'key' { Press-Combo ([string]$msg.combo) }
      'apps' { $result = Get-Apps }
      default { throw "Unknown command $($msg.cmd)." }
    }
    $result['id'] = $id; $result['ok'] = $true
    Reply $result
  } catch {
    Reply @{ id = $id; ok = $false; error = $_.Exception.Message }
  }
}
