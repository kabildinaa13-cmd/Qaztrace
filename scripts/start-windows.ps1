$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location -LiteralPath $root

if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
  throw "npm.cmd was not found. Install Node.js LTS for Windows first."
}

if (-not (Test-Path -LiteralPath (Join-Path $root ".env"))) {
  $legacyEnv = Join-Path ([Environment]::GetFolderPath("UserProfile")) "Downloads\ChainSentinel (1)\ChainSentinel\.env"

  if (Test-Path -LiteralPath $legacyEnv) {
    Copy-Item -LiteralPath $legacyEnv -Destination (Join-Path $root ".env")
    Write-Host "Existing API configuration imported from the previous ChainSentinel folder."
  } else {
    Copy-Item -LiteralPath (Join-Path $root ".env.example") -Destination (Join-Path $root ".env")
    Write-Warning "A new .env file was created. Add a TRONGRID_API_KEY before tracing real TRON transactions."
  }
}

if (-not (Test-Path -LiteralPath (Join-Path $root "node_modules"))) {
  Write-Host "Installing npm dependencies..."
  npm.cmd install
}

$supervisorPath = Join-Path $PSScriptRoot "local-supervisor.ps1"
Start-Process powershell.exe -ArgumentList @("-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass", "-File", $supervisorPath) -WindowStyle Hidden
Start-Sleep -Seconds 7
Start-Process "http://localhost:5174"

Write-Host ""
Write-Host "ChainSentra started in local Windows mode."
Write-Host "Frontend: http://localhost:5174"
Write-Host "API:      http://localhost:8787"
Write-Host ""
Write-Host "The local supervisor will keep the site and API running in the background."
