# AI-Chat 演示控制台（WPF 壳，A1 规格实现）
# 启动: powershell -WindowStyle Hidden -STA -File console.ps1
# 依赖: 零（Windows 自带）；调 infra/launcher/{check,start,stop}-demo.ps1
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..\')).Path  # repo/infra/launcher -> repo
$launcher = Join-Path $repo 'infra\launcher'

Add-Type -AssemblyName PresentationFramework, PresentationCore, WindowsBase

# ---------- 配色 token（A1 规格） ----------
$T = @{
  bg='#0B0B10'; panel='#15151D'; border='#262633'
  text='#E5E7EB'; dim='#9CA3AF'; accent='#A855F7'
  ok='#22C55E'; warn='#F59E0B'; err='#EF4444'
}

[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="AI-Chat 演示控制台" Height="640" Width="420"
        WindowStartupLocation="CenterScreen" Topmost="True"
        Background="$($T.bg)" WindowStyle="SingleBorderWindow" ResizeMode="CanMinimize">
  <Grid Margin="14">
    <Grid.RowDefinitions>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="Auto"/>
      <RowDefinition Height="*"/>
    </Grid.RowDefinitions>
    <!-- 状态面板 -->
    <Border Grid.Row="0" Background="$($T.panel)" BorderBrush="$($T.border)" BorderThickness="1" CornerRadius="8" Padding="10">
      <StackPanel>
        <TextBlock Text="系统状态" Foreground="$($T.dim)" FontSize="11" Margin="0,0,0,6"/>
        <UniformGrid Columns="2" Name="SvcGrid"/>
        <TextBlock Text="模型驻留" Foreground="$($T.dim)" FontSize="11" Margin="0,8,0,4"/>
        <UniformGrid Columns="3" Name="ModelGrid"/>
      </StackPanel>
    </Border>
    <!-- 按钮区 -->
    <StackPanel Grid.Row="1" Orientation="Horizontal" Margin="0,12,0,0">
      <Button Name="BtnStart" Content="▶ 一键启动" Width="110" Height="34" Margin="0,0,8,0"
              Background="$($T.accent)" Foreground="White" BorderThickness="0" FontSize="13" Cursor="Hand"/>
      <Button Name="BtnStop" Content="■ 一键停止" Width="110" Height="34" Margin="0,0,8,0"
              Background="$($T.panel)" Foreground="$($T.text)" BorderBrush="$($T.border)" BorderThickness="1" FontSize="13" Cursor="Hand"/>
      <Button Name="BtnCheck" Content="✓ 自检" Width="72" Height="34"
              Background="$($T.panel)" Foreground="$($T.text)" BorderBrush="$($T.border)" BorderThickness="1" FontSize="13" Cursor="Hand"/>
    </StackPanel>
    <CheckBox Name="CkContainers" Content="停止时一并停容器" Foreground="$($T.dim)" FontSize="11" Margin="0,8,0,0" Grid.Row="1" HorizontalAlignment="Right"/>
    <!-- 演示入口 -->
    <Border Grid.Row="2" Background="$($T.panel)" BorderBrush="$($T.border)" BorderThickness="1" CornerRadius="8" Padding="10" Margin="0,12,0,0">
      <StackPanel>
        <TextBlock Text="演示入口" Foreground="$($T.dim)" FontSize="11" Margin="0,0,0,6"/>
        <TextBlock Name="LnkLogin" Text="⧉ 登录 admin@example.com / admin12345（点击复制）" Foreground="$($T.accent)" FontSize="12" Cursor="Hand" Margin="0,0,0,4"/>
        <TextBlock Name="LnkGuide" Text="▸ 答辩演示教程（defense-demo-guide.md）" Foreground="$($T.accent)" FontSize="12" Cursor="Hand" Margin="0,0,0,4"/>
        <TextBlock Name="LnkExp" Text="▸ 实验表格（m7-exp2-results.md）" Foreground="$($T.accent)" FontSize="12" Cursor="Hand"/>
      </StackPanel>
    </Border>
    <!-- 日志 -->
    <Border Grid.Row="3" Background="$($T.panel)" BorderBrush="$($T.border)" BorderThickness="1" CornerRadius="8" Padding="8" Margin="0,12,0,0">
      <RichTextBox Name="Log" Background="Transparent" BorderThickness="0" Foreground="$($T.text)"
               FontFamily="Consolas" FontSize="10" IsReadOnly="True"
               VerticalScrollBarVisibility="Auto"/>
    </Border>
  </Grid>
</Window>
"@

$reader = New-Object System.Xml.XmlNodeReader $xaml
$win = [Windows.Markup.XamlReader]::Load($reader)

$svcGrid = $win.FindName('SvcGrid'); $modelGrid = $win.FindName('ModelGrid')
$logBox  = $win.FindName('Log')
$btnStart= $win.FindName('BtnStart'); $btnStop = $win.FindName('BtnStop'); $btnCheck = $win.FindName('BtnCheck')
$ckCont  = $win.FindName('CkContainers')
$lnkLogin= $win.FindName('LnkLogin'); $lnkGuide = $win.FindName('LnkGuide'); $lnkExp = $win.FindName('LnkExp')

# ---------- UI 工具 ----------
function Log([string]$msg, [string]$color = $T.text) {
  $win.Dispatcher.Invoke([action]{
    $run = New-Object System.Windows.Documents.Run("[$(Get-Date -Format HH:mm:ss)] $msg`n")
    $run.Foreground = (CreateBrush $color)
    $logBox.Document.Blocks.Add((New-Object System.Windows.Documents.Paragraph $run))
    $logBox.ScrollToEnd()
  })
}
function CreateBrush([string]$hex) {
  $b = New-Object System.Windows.Media.SolidColorBrush
  $b.Color = [System.Windows.Media.ColorConverter]::ConvertFromString($hex)
  return $b
}
function SetLight([System.Windows.Controls.TextBlock]$tb, [string]$state) {
  $color = switch ($state) { 'ok' {$T.ok} 'warn' {$T.warn} default {$T.err} }
  $mark  = switch ($state) { 'ok' {'●'} 'warn' {'◐'} default {'○'} }
  $tb.Dispatcher.Invoke([action]{ $tb.Text = "$mark " + $tb.Tag; $tb.Foreground = (CreateBrush $color) })
}

# 状态灯条目
$svcDefs = @('postgres','redis','minio','Ollama','Web:3100','Worker')
$svcLights = @{}
foreach ($name in $svcDefs) {
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Tag = $name; $tb.FontSize = 11; $tb.Margin = '2,3'
  $tb.Text = "○ $name"; $tb.Foreground = (CreateBrush $T.dim)
  $svcGrid.Children.Add($tb); $svcLights[$name] = $tb
}
$modelDefs = @('qwen3:8b','qwen2.5:7b','qwen3:0.6b')
$modelLights = @{}
foreach ($name in $modelDefs) {
  $tb = New-Object System.Windows.Controls.TextBlock
  $tb.Tag = $name; $tb.FontSize = 10; $tb.Margin = '2,3'
  $tb.Text = "○ $name"; $tb.Foreground = (CreateBrush $T.dim)
  $modelGrid.Children.Add($tb); $modelLights[$name] = $tb
}

# ---------- 编排脚本调用（Runspace 里跑，不冻 UI） ----------
function Invoke-Script([string]$file, [string[]]$args = @(), [scriptblock]$onLine) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$file`" $($args -join ' ')"
  $psi.WorkingDirectory = $repo
  $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $psi.UseShellExecute = $false; $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [Text.Encoding]::UTF8
  $p = [System.Diagnostics.Process]::Start($psi)
  while (-not $p.StandardOutput.EndOfStream) {
    $line = $p.StandardOutput.ReadLine()
    if ($line) { & $onLine $line }
  }
  $p.WaitForExit()
  return $p.ExitCode
}

# ---------- 状态轮询（3s，A1 规格） ----------
$pollTimer = New-Object System.Windows.Threading.DispatcherTimer
$pollTimer.Interval = [TimeSpan]::FromSeconds(3)
$pollTimer.Add_Tick({
  try {
    $j = powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $launcher 'check-demo.ps1') -Json 2>$null | Select-Object -Last 1 | ConvertFrom-Json
    if ($j) {
      $map = @{ docker='Ollama' }  # 占位映射
      foreach ($c in $j.checks) {
        $target = $null
        switch -Regex ($c.name) {
          'daemon|docker'  { }
          'postgres'       { $target='postgres' }
          'redis'          { $target='redis' }
          'minio'          { $target='minio' }
          'ollama.*在线|online' { $target='Ollama' }
          'web'            { $target='Web:3100' }
          'worker'         { $target='Worker' }
        }
        if ($target -and $svcLights[$target]) {
          $state = if ($c.state -eq 'pass') {'ok'} elseif ($c.state -eq 'warn') {'warn'} else {'err'}
          SetLight $svcLights[$target] $state
        }
        if ($c.name -match 'model|驻留|resident' -and $c.detail) {
          foreach ($m in $modelDefs) {
            $resident = ($c.detail -match [regex]::Escape($m))
            SetLight $modelLights[$m] ($(if ($resident) {'ok'} else {'warn'}))
          }
        }
      }
    }
  } catch { }
})

# ---------- 按钮 ----------
$busy = $false
$btnStart.Add_Click({
  if ($busy) { return }
  $busy = $true; $btnStart.IsEnabled = $false
  Log '一键启动开始…' $T.accent
  $rs = [runspacefactory]::CreateRunspace(); $rs.Open()
  $rs.SessionStateProxy.SetVariable('launcher',$launcher); $rs.SessionStateProxy.SetVariable('repo',$repo)
  $ps = [powershell]::Create().AddScript({
    param($launcher,$repo)
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName='powershell.exe'
    $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$launcher\start-demo.ps1`""
    $psi.WorkingDirectory=$repo; $psi.RedirectStandardOutput=$true; $psi.RedirectStandardError=$true
    $psi.UseShellExecute=$false; $psi.CreateNoWindow=$true; $psi.StandardOutputEncoding=[Text.Encoding]::UTF8
    $p=[System.Diagnostics.Process]::Start($psi)
    $out=@()
    while (-not $p.StandardOutput.EndOfStream) { $out += $p.StandardOutput.ReadLine() }
    $p.WaitForExit()
    [pscustomobject]@{ Lines=$out; Code=$p.ExitCode }
  }).AddArgument($launcher).AddArgument($repo)
  $handle = $ps.BeginInvoke()
  # 轮询收割输出（防 UI 冻结）
  $harvest = New-Object System.Windows.Threading.DispatcherTimer
  $harvest.Interval = [TimeSpan]::FromMilliseconds(400)
  $harvest.Add_Tick({
    if ($handle.IsCompleted) {
      $harvest.Stop()
      $res = $ps.EndInvoke($handle)
      foreach ($l in $res.Lines) {
        $color = if ($l -match '\[FAIL\]') { $T.err } elseif ($l -match '\[OK\]|\[PASS\]') { $T.ok } elseif ($l -match '\[WAIT\]') { $T.warn } else { $T.text }
        Log $l $color
      }
      if ($res.Code -eq 0) { Log '✅ 一键启动完成，浏览器已打开' $T.ok }
      else { Log "❌ 启动失败（exit $($res.Code)），看上方日志定位" $T.err }
      $busy = $false; $btnStart.IsEnabled = $true
      $pollTimer.Start()
    }
  })
  $harvest.Start()
})

$btnStop.Add_Click({
  if ($busy) { return }
  Log '一键停止…' $T.warn
  $sw = switch ($ckCont.IsChecked) { $true {'-IncludeContainers'} default {''} }
  $code = Invoke-Script (Join-Path $launcher 'stop-demo.ps1') @($sw | Where-Object {$_}) {
    param($l) $color = if ($l -match '\[FAIL\]') { $T.err } elseif ($l -match '\[OK\]') { $T.ok } else { $T.text }; Log $l $color
  }
  Log $(if ($code -eq 0) {'✅ 已停止'} else {"停止异常 exit $code"}) $(if ($code -eq 0) {$T.ok} else {$T.err})
})

$btnCheck.Add_Click({
  Log '自检…' $T.accent
  $code = Invoke-Script (Join-Path $launcher 'check-demo.ps1') @() {
    param($l)
    $color = if ($l -match 'PASS') { $T.ok } elseif ($l -match 'WARN') { $T.warn } elseif ($l -match 'FAIL') { $T.err } else { $T.text }
    Log $l $color
  }
})

# ---------- 演示入口 ----------
$lnkLogin.Add_MouseLeftButtonUp({ Set-Clipboard 'admin@example.com / admin12345'; Log '登录信息已复制' $T.ok })
$lnkGuide.Add_MouseLeftButtonUp({ Start-Process (Join-Path $repo 'docs\operations\defense-demo-guide.md') })
$lnkExp.Add_MouseLeftButtonUp({ Start-Process (Join-Path $repo 'docs\experiments\m7-exp2-results.md') })

# ---------- 启动 ----------
Log "仓库: $repo" $T.dim
Log '点击「一键启动」开始；状态灯每 3 秒刷新' $T.dim
$pollTimer.Start()
$win.ShowDialog() | Out-Null
