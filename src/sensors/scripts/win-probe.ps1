<#
  bt-anim 环境探测（Windows）—— 供 bt-anim doctor 使用。
  输出一行 JSON：{ ps, pnputil, connected, adapters, winrt, error }
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Continue'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}

$result = @{
  ps        = $PSVersionTable.PSVersion.ToString()
  pnputil   = $false
  connected = 0
  devices   = @()
  adapters  = @()
  winrt     = $false
  error     = ''
}

try {
  $raw = & pnputil.exe /enum-devices /class Bluetooth 2>$null
  if ($LASTEXITCODE -eq 0 -and $raw) {
    $result.pnputil = $true
    $cur = $null
    $names = New-Object System.Collections.ArrayList
    foreach ($line in $raw) {
      $s = [string]$line
      if ($s -match '^\s*Instance ID:\s*(.+?)\s*$') {
        if ($cur) { [void]$names.Add($cur) }
        $cur = @{ id = $Matches[1]; name = '' }
      } elseif ($cur) {
        if ($s -match '^\s*Device Description:\s*(.+?)\s*$') { $cur.name = $Matches[1] }
      }
    }
    if ($cur) { [void]$names.Add($cur) }
    foreach ($item in $names) {
      if ($item.id -match '^(?i)(BTHENUM|BTHLE)\\Dev_([0-9A-Fa-f]{12})') {
        $result.connected = $result.connected + 1
        $result.devices += $item.name
      } elseif ($item.id -match '^(?i)(BTH|USB)\\') {
        $result.adapters += $item.name
      }
    }
  }
} catch {
  $result.error = $_.Exception.Message
}

try {
  [void][Windows.Devices.Bluetooth.BluetoothLEDevice, Windows.Devices.Bluetooth, ContentType = WindowsRuntime]
  $result.winrt = $true
} catch {
  $result.winrt = $false
}

[Console]::Out.WriteLine((ConvertTo-Json -InputObject $result -Compress -Depth 5))
