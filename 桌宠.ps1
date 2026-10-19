# Open the desktop-pet window.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
param(
    [int]$Port = 3210,
    [int]$Width = 300,
    [int]$Height = 430
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'app\server.mjs'))) { $root = $PSScriptRoot }

function Test-Port([int]$p) {
    try {
        $client = New-Object System.Net.Sockets.TcpClient
        $async = $client.BeginConnect('127.0.0.1', $p, $null, $null)
        $ready = $async.AsyncWaitHandle.WaitOne(300)
        if ($ready -and $client.Connected) { $client.Close(); return $true }
        $client.Close(); return $false
    } catch { return $false }
}

function Resolve-Node {
    $cmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $fallback = Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
    if (Test-Path -LiteralPath $fallback) { return $fallback }
    return $null
}

if (-not (Test-Port $Port)) {
    $node = Resolve-Node
    if (-not $node) { Write-Host 'Node.js 22+ not found. Install Node or run the main launcher first.'; exit 1 }
    Write-Host "Starting peiban server on port $Port ..."
    Start-Process -WindowStyle Hidden -FilePath $node -ArgumentList (Join-Path $root 'app\server.mjs') -WorkingDirectory $root
    $waited = 0
    while (-not (Test-Port $Port) -and $waited -lt 40) { Start-Sleep -Milliseconds 250; $waited++ }
    if (-not (Test-Port $Port)) { Write-Host 'Server did not come up. Run the main launcher and try again.'; exit 1 }
}

$browser = @(
    "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles (x86)\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $browser) { Write-Host 'Edge or Chrome not found.'; exit 1 }

Add-Type -AssemblyName System.Windows.Forms
$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$x = $area.Right - $Width - 24
$y = $area.Bottom - $Height - 24

$profileDir = Join-Path $root '.pet-profile'
$started = Get-Date
$launchArgs = @(
    "--app=http://127.0.0.1:$Port/pet",
    "--window-size=$Width,$Height",
    "--window-position=$x,$y",
    "--user-data-dir=$profileDir",
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,MediaRouter'
)
Start-Process -FilePath $browser -ArgumentList $launchArgs | Out-Null

# 找到刚启动的那个窗口，置顶并贴到右下角
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PetWin {
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
}
'@ -ErrorAction SilentlyContinue

$topmost = $true
try {
    $state = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/api/state" -TimeoutSec 5
    if ($null -ne $state.settings.pet.alwaysOnTop) { $topmost = [bool]$state.settings.pet.alwaysOnTop }
} catch { }

$hwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 40 -and $hwnd -eq [IntPtr]::Zero; $i++) {
    Start-Sleep -Milliseconds 250
    $proc = Get-Process -Name msedge, chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.StartTime -ge $started.AddSeconds(-2) } |
        Select-Object -First 1
    if ($proc) { $hwnd = $proc.MainWindowHandle }
}
if ($hwnd -eq [IntPtr]::Zero) { Write-Host 'Pet window opened, but it could not be pinned on top (move it with Alt+Space, M).'; exit 0 }

[void][PetWin]::SetWindowPos($hwnd, [IntPtr]::Zero, $x, $y, $Width, $Height, 0x0010)
if ($topmost) { [void][PetWin]::SetWindowPos($hwnd, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010) }
Write-Host "Pet window ready at http://127.0.0.1:$Port/pet"
