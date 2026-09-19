$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
$nodePath = if ($nodeCommand) { $nodeCommand.Source } else { Join-Path $env:USERPROFILE '.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' }
if (-not (Test-Path -LiteralPath $nodePath)) { throw '需要 Node.js 22 或更新版本。安装后重新打开启动脚本。' }
$appPort = if ($env:PORT) { $env:PORT } else { '3210' }
Write-Host "陪伴启动后，请在浏览器打开 http://127.0.0.1:$appPort"
Write-Host '保留此窗口即可持续运行。按 Ctrl+C 停止。'
& $nodePath (Join-Path $PSScriptRoot 'app\server.mjs')
exit $LASTEXITCODE
