<#
  测试用的假传感器：按固定顺序吐出一串事件后保持安静，用来验证主程序的事件链路。
#>
[CmdletBinding()]
param(
  [int]$PollMs = 1000,
  [int]$PairMs = 1000,
  [int]$HeartbeatMs = 60000,
  [int]$ParentPid = 0
)
$ErrorActionPreference = 'Continue'
$lines = @(
  '{"ev":"ready","platform":"win32","engine":"fake","pollMs":1000,"pairMs":1000,"connected":[{"address":"aabbccddeeff","name":"TestPhone","kind":"classic","status":"Started","id":"BTHENUM\\Dev_AABBCCDDEEFF"}],"paired":["AABBCCDDEEFF","111111111111"]}',
  '{"ev":"connected","device":{"address":"112233445566","name":"NewHeadset","kind":"le","status":"Started","id":"BTHLE\\Dev_112233445566"}}',
  '{"ev":"disconnected","device":{"address":"aabbccddeeff","name":"TestPhone","kind":"classic","status":"Started","id":"BTHENUM\\Dev_AABBCCDDEEFF"}}',
  '{"ev":"paired","device":{"address":"999999999999","name":"NewPair","kind":"paired","status":"Paired","id":"BTHPORT\\999999999999"}}',
  '{"ev":"heartbeat","active":1}'
)
foreach ($line in $lines) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 80
}
Start-Sleep -Seconds 25
