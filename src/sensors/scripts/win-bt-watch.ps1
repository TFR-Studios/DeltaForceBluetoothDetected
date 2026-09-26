
<#
  bt-anim 蓝牙监听器（Windows / Windows PowerShell 5.1）
  持续向 stdout 输出 JSON 行（NDJSON）：
    {"ev":"ready", ...}        启动基线（此时不触发动画）
    {"ev":"connected","device":{...}}
    {"ev":"disconnected","device":{...}}
    {"ev":"paired","device":{...}}
    {"ev":"heartbeat"}
    {"ev":"error","message":"..."}
  参数：
    -PollMs        连接状态轮询间隔（毫秒）
    -PairMs        配对表轮询间隔（毫秒）
    -HeartbeatMs   心跳间隔（毫秒）
    -ParentPid     父进程 PID，父进程退出后自动结束
#>
[CmdletBinding()]
param(
  [int]$PollMs = 1200,
  [int]$PairMs = 5000,
  [int]$HeartbeatMs = 60000,
  [int]$ParentPid = 0
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$script:BthPortPath = 'HKLM:\SYSTEM\CurrentControlSet\Services\BTHPORT\Parameters\Devices'
$script:Seq = 0
$script:Engine = 'pnputil'
$script:Replacement = [char]0xFFFD

function Emit {
  param([hashtable]$Payload)
  $script:Seq++
  $Payload['seq'] = $script:Seq
  $Payload['ts'] = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  $line = ConvertTo-Json -InputObject $Payload -Compress -Depth 8
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}

function New-BtDevice {
  param([string]$Address, [string]$Kind, [string]$Name, [string]$Status, [string]$Id)
  if (-not $Name) { $Name = '' }
  return @{
    address = $Address
    kind    = $Kind
    name    = $Name
    status  = $Status
    id      = $Id
  }
}

function Read-BytesName {
  param($Value)
  if ($null -eq $Value) { return '' }
  if ($Value -is [byte[]] -and $Value.Length -gt 0) {
    $s = [System.Text.Encoding]::UTF8.GetString($Value)
    $s = $s.Trim([char]0).Trim()
    if ($s.IndexOf($script:Replacement) -ge 0) { return '' }
    return $s
  }
  if ($Value -is [string]) { return $Value.Trim() }
  return ''
}

function Get-BthPortNames {
  # 返回 @{ 'MAC(大写)' = '设备名' }；BTHPORT 中名称是 UTF-8 字节，中文可正确还原
  $map = @{}
  try {
    foreach ($k in (Get-ChildItem $script:BthPortPath -ErrorAction SilentlyContinue)) {
      $mac = $k.PSChildName.ToUpperInvariant()
      if ($mac -notmatch '^[0-9A-F]{12}$') { continue }
      $props = Get-ItemProperty $k.PSPath -ErrorAction SilentlyContinue
      if (-not $props) { continue }
      foreach ($field in @('Name', 'LEName', 'FriendlyName')) {
        $name = Read-BytesName $props.$field
        if ($name) { $map[$mac] = $name; break }
      }
    }
  } catch { }
  return $map
}

function Get-PresentRaw {
  # 当前已连接的蓝牙相关设备（存在即已连接）
  $items = New-Object System.Collections.ArrayList
  $done = $false
  try {
    $raw = & pnputil.exe /enum-devices /class Bluetooth 2>$null
    if ($LASTEXITCODE -eq 0 -and $raw) {
      $cur = $null
      foreach ($line in $raw) {
        $s = [string]$line
        if ($s -match '^\s*Instance ID:\s*(.+?)\s*$') {
          if ($cur -and $cur.id) { [void]$items.Add($cur) }
          $cur = @{ id = $Matches[1]; status = 'Started'; name = '' }
        } elseif ($cur) {
          if ($s -match '^\s*Device Description:\s*(.+?)\s*$') { $cur.name = $Matches[1] }
          elseif ($s -match '^\s*Status:\s*(.+?)\s*$') { $cur.status = $Matches[1] }
        }
      }
      if ($cur -and $cur.id) { [void]$items.Add($cur) }
      if ($items.Count -gt 0) { $done = $true }
    }
  } catch { $done = $false }

  if (-not $done) {
    $script:Engine = 'pnpdevice'
    foreach ($dev in (Get-PnpDevice -Class Bluetooth -PresentOnly -ErrorAction SilentlyContinue)) {
      [void]$items.Add(@{ id = [string]$dev.InstanceId; status = [string]$dev.Status; name = [string]$dev.FriendlyName })
    }
  }
  return $items
}

function Select-BtPeripheral {
  param($Raw)
  $result = New-Object System.Collections.ArrayList
  foreach ($item in $Raw) {
    $id = [string]$item.id
    if ($id -match '^(?i)(BTHENUM|BTHLE)\\Dev_([0-9A-Fa-f]{12})') {
      $kind = if ($Matches[1].ToUpperInvariant() -eq 'BTHLE') { 'le' } else { 'classic' }
      $mac = $Matches[2].ToUpperInvariant()
      [void]$result.Add((New-BtDevice -Address $mac -Kind $kind -Name ([string]$item.name) -Status ([string]$item.status) -Id $id))
    }
  }
  return $result
}

function Get-PairedList {
  $result = New-Object System.Collections.ArrayList
  try {
    foreach ($k in (Get-ChildItem $script:BthPortPath -ErrorAction SilentlyContinue)) {
      $mac = $k.PSChildName.ToUpperInvariant()
      if ($mac -notmatch '^[0-9A-F]{12}$') { continue }
      [void]$result.Add((New-BtDevice -Address $mac -Kind 'paired' -Name '' -Status 'Paired' -Id ('BTHPORT\' + $mac)))
    }
  } catch { }
  return $result
}

function Resolve-Name {
  param([string]$Address, [string]$Fallback)
  if ($script:Names.ContainsKey($Address)) { return $script:Names[$Address] }
  if ($Fallback) {
    $clean = $Fallback.Replace([string]$script:Replacement, '').Trim()
    if ($clean) { return $clean }
  }
  return ('Bluetooth ' + $Address.Substring(0, 2) + ':' + $Address.Substring(2, 2) + ':' + $Address.Substring(8, 4))
}

# ---------------- 启动 ----------------
$script:Names = Get-BthPortNames
$connected = @{}
foreach ($dev in (Select-BtPeripheral (Get-PresentRaw))) {
  $dev.name = Resolve-Name -Address $dev.address -Fallback $dev.name
  $connected[$dev.address] = $dev
}
$paired = @{}
foreach ($dev in (Get-PairedList)) { $paired[$dev.address] = $true }

Emit @{
  ev        = 'ready'
  platform  = 'win32'
  engine    = $script:Engine
  pollMs    = $PollMs
  pairMs    = $PairMs
  connected = @($connected.Values)
  paired    = @($paired.Keys)
}

$lastPoll = [DateTime]::UtcNow
$lastPair = [DateTime]::UtcNow
$lastBeat = [DateTime]::UtcNow
$lastNames = [DateTime]::UtcNow
$firstRun = $true

while ($true) {
  Start-Sleep -Milliseconds 400

  if ($ParentPid -gt 0) {
    $parent = Get-Process -Id $ParentPid -ErrorAction SilentlyContinue
    if (-not $parent) { break }
  }

  $now = [DateTime]::UtcNow

  if (($now - $lastNames).TotalMilliseconds -ge 15000) {
    $script:Names = Get-BthPortNames
    $lastNames = $now
  }

  if (($now - $lastPoll).TotalMilliseconds -ge $PollMs) {
    $lastPoll = $now
    try {
      $seen = @{}
      foreach ($dev in (Select-BtPeripheral (Get-PresentRaw))) {
        $dev.name = Resolve-Name -Address $dev.address -Fallback $dev.name
        $seen[$dev.address] = $dev
        if (-not $connected.ContainsKey($dev.address)) {
          $connected[$dev.address] = $dev
          if (-not $firstRun) { Emit @{ ev = 'connected'; device = $dev; active = $seen.Count } }
        } else {
          if ($dev.name) { $connected[$dev.address].name = $dev.name }
          $connected[$dev.address].status = $dev.status
        }
      }
      foreach ($addr in @($connected.Keys)) {
        if (-not $seen.ContainsKey($addr)) {
          $gone = $connected[$addr]
          $connected.Remove($addr)
          if (-not $firstRun) { Emit @{ ev = 'disconnected'; device = $gone; active = $seen.Count } }
        }
      }
      $firstRun = $false
    } catch {
      Emit @{ ev = 'error'; scope = 'poll'; message = $_.Exception.Message }
    }
  }

  if (($now - $lastPair).TotalMilliseconds -ge $PairMs) {
    $lastPair = $now
    try {
      foreach ($dev in (Get-PairedList)) {
        if (-not $paired.ContainsKey($dev.address)) {
          $paired[$dev.address] = $true
          $dev.name = Resolve-Name -Address $dev.address -Fallback ''
          Emit @{ ev = 'paired'; device = $dev }
        }
      }
    } catch {
      Emit @{ ev = 'error'; scope = 'pair'; message = $_.Exception.Message }
    }
  }

  if (($now - $lastBeat).TotalMilliseconds -ge $HeartbeatMs) {
    $lastBeat = $now
    Emit @{ ev = 'heartbeat'; active = @($connected.Keys).Count }
  }
}
