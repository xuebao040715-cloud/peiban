# Capture the primary screen, downscale it, write a JPEG. Windows only.
# ASCII-only on purpose: Windows PowerShell 5.1 reads BOM-less UTF-8 as ANSI.
# Usage: powershell -File capture-screen.ps1 -Out C:\temp\shot.jpg [-Width 1024] [-Quality 72]
param(
    [Parameter(Mandatory = $true)][string]$Out,
    [int]$Width = 1024,
    [int]$Quality = 72
)
$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($bounds.Width -le 0 -or $bounds.Height -le 0) { throw 'no desktop session available' }

$full = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $bounds.Width, $bounds.Height
$grab = [System.Drawing.Graphics]::FromImage($full)
try {
    $grab.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $full.Size)
} finally {
    $grab.Dispose()
}

$scale = [Math]::Min(1.0, [double]$Width / [double]$bounds.Width)
$w = [int]($bounds.Width * $scale)
$h = [int]($bounds.Height * $scale)
if ($w -lt 1) { $w = 1 }
if ($h -lt 1) { $h = 1 }

$thumb = New-Object -TypeName System.Drawing.Bitmap -ArgumentList $w, $h
$resize = [System.Drawing.Graphics]::FromImage($thumb)
try {
    $resize.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $resize.DrawImage($full, 0, 0, $w, $h)
} finally {
    $resize.Dispose()
    $full.Dispose()
}

$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() |
    Where-Object { $_.MimeType -eq 'image/jpeg' } |
    Select-Object -First 1
$encoderParams = New-Object -TypeName System.Drawing.Imaging.EncoderParameters -ArgumentList 1
$encoderParams.Param[0] = New-Object -TypeName System.Drawing.Imaging.EncoderParameter `
    -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)

$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

try {
    $thumb.Save($Out, $codec, $encoderParams)
} finally {
    $thumb.Dispose()
    $encoderParams.Dispose()
}

Write-Output ("{0}x{1}->{2}x{3}" -f $bounds.Width, $bounds.Height, $w, $h)
