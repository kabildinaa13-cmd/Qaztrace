$ports = 5174, 8787
$rows = foreach ($port in $ports) {
  $line = netstat -ano | Select-String ":$port " | Where-Object { $_.Line -match "LISTENING" } | Select-Object -First 1
  [pscustomobject]@{
    Component = if ($port -eq 5174) { "Local site" } else { "Local API" }
    Address = "http://localhost:$port"
    Status = if ($line) { "RUNNING" } else { "STOPPED" }
    ProcessId = if ($line -and $line.Line -match "\s(\d+)\s*$") { $Matches[1] } else { "-" }
  }
}
$rows | Format-Table -AutoSize

$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "ChainSentinelLocal"
$runValue = Get-ItemPropertyValue -Path $runKeyPath -Name $runValueName -ErrorAction SilentlyContinue
$taskStatus = if ($runValue) { "INSTALLED" } else { "NOT INSTALLED" }
Write-Host ""
Write-Host "Windows user autostart: $taskStatus"
