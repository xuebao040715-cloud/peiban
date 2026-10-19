# 像素桌宠：透明、无边框、置顶，直接站在桌面上。
# 依赖：仅 Windows PowerShell 5.1 + WPF（系统自带），零第三方依赖。
param(
    [string]$BaseUrl = 'http://127.0.0.1:3210',
    [int]$SpriteSize = 160
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase, System.Windows.Forms

$root = Split-Path -Parent $PSScriptRoot
if (-not (Test-Path (Join-Path $root 'app\server.mjs'))) { $root = $PSScriptRoot }
$spritePath = Join-Path $root 'personal\pet\sprite.png'
if (-not (Test-Path -LiteralPath $spritePath)) { $spritePath = Join-Path $root 'assets\pet\sprite.png' }

# ---------- 窗口 ----------
$window = New-Object System.Windows.Window
$window.WindowStyle = 'None'
$window.AllowsTransparency = $true
$window.Background = [System.Windows.Media.Brushes]::Transparent
$window.Topmost = $true
$window.ShowInTaskbar = $false
$window.ResizeMode = 'NoResize'
$window.SizeToContent = 'WidthAndHeight'
$window.WindowStartupLocation = 'Manual'

$area = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$window.Left = $area.Right - 260
$window.Top = $area.Bottom - 320

$stack = New-Object System.Windows.Controls.StackPanel
$stack.HorizontalAlignment = 'Center'

# 气泡
$bubble = New-Object System.Windows.Controls.Border
$bubble.CornerRadius = '12'
$bubble.Padding = '10,7,10,7'
$bubble.Margin = '0,0,0,6'
$bubble.MaxWidth = 230
$bubble.Background = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(240, 255, 255, 255))
$bubble.BorderBrush = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(60, 82, 118, 91))
$bubble.BorderThickness = '1'
$bubble.Visibility = 'Collapsed'
$bubbleText = New-Object System.Windows.Controls.TextBlock
$bubbleText.TextWrapping = 'Wrap'
$bubbleText.FontSize = 12
$bubbleText.ForeColor = $null
$bubbleText.Foreground = New-Object System.Windows.Media.SolidColorBrush ([System.Windows.Media.Color]::FromArgb(255, 38, 61, 53))
$bubble.Child = $bubbleText
$bubble.Effect = New-Object System.Windows.Media.Effects.DropShadowEffect -Property @{ BlurRadius = 12; ShadowDepth = 2; Opacity = 0.18; Color = [System.Windows.Media.Colors]::Black }
[void]$stack.Children.Add($bubble)

# 精灵
$image = New-Object System.Windows.Controls.Image
if (Test-Path -LiteralPath $spritePath) {
    $bitmap = New-Object System.Windows.Media.Imaging.BitmapImage
    $bitmap.BeginInit()
    $bitmap.UriSource = New-Object System.Uri($spritePath)
    $bitmap.CacheOption = 'OnLoad'
    $bitmap.EndInit()
    $image.Source = $bitmap
    [System.Windows.Media.RenderOptions]::SetBitmapScalingMode($image, [System.Windows.Media.BitmapScalingMode]::NearestNeighbor)
    $image.Width = $SpriteSize
    $image.Height = $SpriteSize
} else {
    $fallback = New-Object System.Windows.Controls.TextBlock
    $fallback.Text = 'pet'
    $fallback.FontSize = 14
    [void]$stack.Children.Add($fallback)
}
$image.Cursor = [System.Windows.Input.Cursors]::Hand
$image.AllowDrop = $false
$bob = New-Object System.Windows.Media.TranslateTransform
$image.RenderTransform = $bob
if ($image.Source) { [void]$stack.Children.Add($image) }

$window.Content = $stack

# ---------- 气泡逻辑 ----------
$script:hideTimer = $null
function Show-Line([string]$text) {
    if (-not $text) { return }
    $bubbleText.Text = $text
    $bubble.Visibility = 'Visible'
    if ($script:hideTimer) { $script:hideTimer.Stop() }
    $script:hideTimer = New-Object System.Windows.Threading.DispatcherTimer
    $script:hideTimer.Interval = [TimeSpan]::FromSeconds(14)
    $script:hideTimer.Add_Tick({ $bubble.Visibility = 'Collapsed'; $script:hideTimer.Stop() })
    $script:hideTimer.Start()
}

# ---------- 观察（后台任务，别冻住窗口） ----------
$script:job = $null
$script:poll = New-Object System.Windows.Threading.DispatcherTimer
$script:poll.Interval = [TimeSpan]::FromMilliseconds(600)
$script:poll.Add_Tick({
    if (-not $script:job) { return }
    if ($script:job.State -eq 'Completed') {
        try {
            $data = Receive-Job -Job $script:job
            if ($data.line) { Show-Line ([string]$data.line) }
            elseif ($data.error) { Show-Line ([string]$data.error) }
        } catch { Show-Line '看了一眼，没看清。' }
        Remove-Job -Job $script:job -Force
        $script:job = $null
    } elseif ($script:job.State -eq 'Failed') {
        Show-Line '连不上陪伴服务。'
        Remove-Job -Job $script:job -Force
        $script:job = $null
    }
})
$script:poll.Start()

function Invoke-Observe {
    if ($script:job) { return }
    Show-Line '看一眼…'
    $url = "$BaseUrl/api/pet/observe"
    $script:job = Start-Job -ScriptBlock {
        param($u)
        try { Invoke-RestMethod -Uri $u -Method Post -ContentType 'application/json' -Body '{}' -TimeoutSec 90 }
        catch { @{ error = $_.Exception.Message } }
    } -ArgumentList $url
}

# ---------- 空闲小动作 ----------
$script:tick = 0
$script:bobTimer = New-Object System.Windows.Threading.DispatcherTimer
$script:bobTimer.Interval = [TimeSpan]::FromMilliseconds(120)
$script:bobTimer.Add_Tick({
    $script:tick = ($script:tick + 1) % 40
    $bob.Y = [math]::Round(-3 * [math]::Sin($script:tick / 40 * 2 * [math]::PI), 2)
})
$script:bobTimer.Start()

# ---------- 交互 ----------
$image.Add_MouseLeftButtonDown({
    param($s, $e)
    if ($e.ClickCount -eq 2) { Invoke-Observe }
    else { $window.DragMove() }
})

$menu = New-Object System.Windows.Controls.ContextMenu
function Add-MenuItem([string]$text, [scriptblock]$action) {
    $item = New-Object System.Windows.Controls.MenuItem
    $item.Header = $text
    $item.Add_Click($action)
    [void]$menu.Items.Add($item)
}
Add-MenuItem '看一眼' { Invoke-Observe }
Add-MenuItem '打开陪伴' { Start-Process "$BaseUrl/" }
Add-MenuItem '置顶开关' {
    $window.Topmost = -not $window.Topmost
}
Add-MenuItem '退出' { $window.Close() }
$image.ContextMenu = $menu

# ---------- 自动观察 ----------
$script:auto = New-Object System.Windows.Threading.DispatcherTimer
$script:auto.Interval = [TimeSpan]::FromMinutes(5)
$script:auto.Add_Tick({ Invoke-Observe })
$script:auto.Start()

$window.ShowDialog() | Out-Null
