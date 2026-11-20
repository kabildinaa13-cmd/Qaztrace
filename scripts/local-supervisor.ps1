$ErrorActionPreference = "Continue"

$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$runtimeDir = Join-Path $projectRoot "runtime"
$nodePath = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
$npmPath = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
$vitePath = Join-Path $projectRoot "node_modules\vite\bin\vite.js"
$mutex = New-Object System.Threading.Mutex($false, "Local\ChainSentinelLocalSupervisor")
$ownsMutex = $false

try {
  $ownsMutex = $mutex.WaitOne(0)
  if (-not $ownsMutex) { exit 0 }

  if (-not $nodePath -or -not $npmPath -or -not (Test-Path -LiteralPath $vitePath)) {
    throw "Node.js, npm or the local Vite runtime is not installed."
  }

  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  Set-Location -LiteralPath $projectRoot

  function Test-LocalPort([int]$port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
      $task = $client.ConnectAsync("127.0.0.1", $port)
      return $task.Wait(800) -and $client.Connected
    } catch {
      return $false
    } finally {
      $client.Dispose()
    }
  }

  function Start-Api {
    $env:STORAGE_DRIVER = "json"
    $env:HOST = "127.0.0.1"
    $env:PORT = "8787"
    Start-Process -FilePath $nodePath `
      -ArgumentList "backend/server.mjs" `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtimeDir "api.log") `
      -RedirectStandardError (Join-Path $runtimeDir "api-error.log") | Out-Null
  }

  function Start-Web {
    Start-Process -FilePath $nodePath `
      -ArgumentList @($vitePath, "preview", "--host", "127.0.0.1", "--port", "5174", "--strictPort") `
      -WorkingDirectory $projectRoot `
      -WindowStyle Hidden `
      -RedirectStandardOutput (Join-Path $runtimeDir "web.log") `
      -RedirectStandardError (Join-Path $runtimeDir "web-error.log") | Out-Null
  }

  while ($true) {
    if (-not (Test-LocalPort 8787)) {
      Start-Api
      Start-Sleep -Seconds 3
    }
    if (-not (Test-LocalPort 5174)) {
      Start-Web
      Start-Sleep -Seconds 3
    }
    Start-Sleep -Seconds 10
  }
} catch {
  New-Item -ItemType Directory -Force -Path $runtimeDir | Out-Null
  "$(Get-Date -Format o) $($_.Exception.Message)" | Add-Content -LiteralPath (Join-Path $runtimeDir "supervisor-error.log")
  exit 1
} finally {
  if ($ownsMutex) { $mutex.ReleaseMutex() | Out-Null }
  $mutex.Dispose()
}
