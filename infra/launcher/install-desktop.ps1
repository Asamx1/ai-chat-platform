# 桌面快捷方式生成（AI-Chat 演示控制台）
# 用法: powershell -File install-desktop.ps1
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent | Split-Path -Parent | Split-Path -Parent
$target = Join-Path $repo 'infra\launcher\console.ps1'
$desktop = [Environment]::GetFolderPath('Desktop')
$lnk = Join-Path $desktop 'AI-Chat 演示控制台.lnk'

$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($lnk)
$sc.TargetPath = 'powershell.exe'
$sc.Arguments = "-WindowStyle Hidden -STA -ExecutionPolicy Bypass -File `"$target`""
$sc.WorkingDirectory = Join-Path $repo 'infra\launcher'
$sc.IconLocation = "$env:SystemRoot\System32\shell32.dll,25"  # 电机图标
$sc.Description = 'AI-Chat 平台答辩演示一键启动器'
$sc.WindowStyle = 7  # Minimized（隐藏 powershell 宿主窗口）
$sc.Save()

Write-Host "OK: $lnk"
Write-Host "目标: $target"
