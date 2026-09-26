
<#
  bt-anim 附近蓝牙设备扫描（Windows / Windows PowerShell 5.1）
  输出一行 JSON：
    {"ev":"scan","ok":true,"mode":"le","devices":[{"address","name","kind"}],"elapsedMs":...}
  说明：使用 WinRT BluetoothLEDevice / BluetoothDevice 的“未配对设备”选择器，
        会真正触发一次系统蓝牙扫描（约 30 秒），可与 Windows 设置里的“添加设备”看到同样的设备。
#>
[CmdletBinding()]
param(
  [int]$TimeoutSec = 45,
  [ValidateSet('le', 'classic', 'both')]
  [string]$Mode = 'le'
)

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$sw = [System.Diagnostics.Stopwatch]::StartNew()
$devices = New-Object System.Collections.ArrayList
$errors = New-Object System.Collections.ArrayList

function Emit-Scan {
  param($Payload)
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $Payload -Compress -Depth 8))
  [Console]::Out.Flush()
}

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime -ErrorAction Stop
  [void][Windows.Devices.Enumeration.DeviceInformation, Windows.Devices.Enumeration, ContentType = WindowsRuntime]
  [void][Windows.Devices.Bluetooth.BluetoothDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
  [void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
} catch {
  Emit-Scan @{ ev = 'scan'; ok = $false; mode = $Mode; devices = @(); elapsedMs = $sw.ElapsedMilliseconds; error = 'WinRT unavailable: ' + $_.Exception.Message }
  exit 1
}

$awaitMethod = ([System.WindowsRuntimeSystemExtensions].GetMethods() |
  Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -like 'IAsyncOperation*' -and
    $_.GetParameters()[0].ParameterType.Name -notlike '*Progress*'
  })[0]

if (-not $awaitMethod) {
  Emit-Scan @{ ev = 'scan'; ok = $false; mode = $Mode; devices = @(); elapsedMs = $sw.ElapsedMilliseconds; error = 'AsTask helper not found' }
  exit 1
}

function Await-Op($op, $type) {
  $task = $awaitMethod.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait($TimeoutSec * 1000)) { throw ('timeout after ' + $TimeoutSec + 's') }
  return $task.Result
}

function Get-Address {
  param([string]$Id)
  if (-not $Id) { return '' }
  $idx = $Id.LastIndexOf('-')
  $tail = if ($idx -ge 0) { $Id.Substring($idx + 1) } else { '' }
  $hex = ($tail -replace '[^0-9A-Fa-f]', '')
  if ($hex.Length -eq 12) { return $hex.ToUpperInvariant() }
  return ''
}

$selectors = @()
if ($Mode -eq 'le' -or $Mode -eq 'both') {
  $selectors += @{ kind = 'le'; selector = [Windows.Devices.Bluetooth.BluetoothLEDevice]::GetDeviceSelectorFromPairingState($false) }
}
if ($Mode -eq 'classic' -or $Mode -eq 'both') {
  $selectors += @{ kind = 'classic'; selector = [Windows.Devices.Bluetooth.BluetoothDevice]::GetDeviceSelectorFromPairingState($false) }
}

$seen = @{}
foreach ($entry in $selectors) {
  try {
    $found = Await-Op ([Windows.Devices.Enumeration.DeviceInformation]::FindAllAsync($entry.selector)) ([Windows.Devices.Enumeration.DeviceInformationCollection])
    foreach ($info in $found) {
      $address = Get-Address -Id ([string]$info.Id)
      if (-not $address) { continue }
      $key = $entry.kind + ':' + $address
      if ($seen.ContainsKey($key)) { continue }
      $seen[$key] = $true
      $name = ''
      if ($info.Name) { $name = ([string]$info.Name).Trim() }
      [void]$devices.Add(@{ address = $address; name = $name; kind = $entry.kind })
    }
  } catch {
    [void]$errors.Add((($entry.kind + ': ') + $_.Exception.Message))
  }
}

$result = @{
  ev        = 'scan'
  ok        = ($errors.Count -eq 0)
  mode      = $Mode
  devices   = @($devices)
  elapsedMs = $sw.ElapsedMilliseconds
}
if ($errors.Count -gt 0) { $result['errors'] = @($errors) }
Emit-Scan $result
