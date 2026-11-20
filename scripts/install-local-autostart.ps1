$ErrorActionPreference = "Stop"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$supervisorPath = Join-Path $PSScriptRoot "local-supervisor.ps1"
$startupDir = [Environment]::GetFolderPath("Startup")
$desktopDir = [Environment]::GetFolderPath("Desktop")
$startupFile = Join-Path $startupDir "ChainSentra Local.cmd"
$desktopShortcut = Join-Path $desktopDir "ChainSentra Local.url"
$runKeyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$runValueName = "ChainSentinelLocal"

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue) -or -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "Node.js and npm are required."
}

Set-Location -LiteralPath $projectRoot
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot "node_modules"))) {
  & npm.cmd install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed." }
}

& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw "Production build failed." }

$escapedSupervisor = $supervisorPath.Replace('"', '""')
$startupContent = "@echo off`r`nstart `"`" /min powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$escapedSupervisor`"`r`n"
[System.IO.File]::WriteAllText($startupFile, $startupContent, [System.Text.UTF8Encoding]::new($false))

$shortcutContent = "[InternetShortcut]`r`nURL=http://localhost:5174`r`nIconFile=$env:SystemRoot\System32\shell32.dll`r`nIconIndex=14`r`n"
[System.IO.File]::WriteAllText($desktopShortcut, $shortcutContent, [System.Text.UTF8Encoding]::new($false))

$runCommand = "powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$supervisorPath`""
New-Item -Path $runKeyPath -Force | Out-Null
Set-ItemProperty -Path $runKeyPath -Name $runValueName -Value $runCommand -Type String

Start-Process powershell.exe -ArgumentList @(
  "-NoProfile",
  "-WindowStyle", "Hidden",
  "-ExecutionPolicy", "Bypass",
  "-File", $supervisorPath
) -WindowStyle Hidden | Out-Null

Start-Sleep -Seconds 7
Write-Host "ChainSentra local autostart installed."
Write-Host "Site: http://localhost:5174"
Write-Host "Startup file: $startupFile"
Write-Host "Desktop shortcut: $desktopShortcut"
Write-Host "Windows user autostart: $runValueName"
