# Move / pin the desktop-pet browser window. ASCII-only (PS 5.1 reads BOM-less UTF-8 as ANSI).
# Usage:
#   powershell -File pet-window.ps1 -Title "..." -Dx 40 -Dy -20
#   powershell -File pet-window.ps1 -Title "..." -Topmost
#   powershell -File pet-window.ps1 -Title "..." -Normal
param(
    [string]$Title = '',
    [int]$Dx = 0,
    [int]$Dy = 0,
    [switch]$Topmost,
    [switch]$Normal
)
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PetWin {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hWnd, IntPtr after, int X, int Y, int cx, int cy, uint flags);
}
'@

$target = $null
if ($Title) {
    $target = Get-Process -Name msedge, chrome -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*$Title*" } |
        Select-Object -First 1
}
if (-not $target) { Write-Output 'no-window'; exit 1 }
$h = $target.MainWindowHandle

if ($Topmost) {
    [void][PetWin]::SetWindowPos($h, [IntPtr](-1), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010)
} elseif ($Normal) {
    [void][PetWin]::SetWindowPos($h, [IntPtr](-2), 0, 0, 0, 0, 0x0001 -bor 0x0002 -bor 0x0010)
} else {
    $rect = New-Object PetWin+RECT
    if (-not [PetWin]::GetWindowRect($h, [ref]$rect)) { Write-Output 'no-rect'; exit 1 }
    [void][PetWin]::SetWindowPos($h, [IntPtr]::Zero, $rect.Left + $Dx, $rect.Top + $Dy, 0, 0, 0x0001 -bor 0x0010)
}
Write-Output 'ok'
