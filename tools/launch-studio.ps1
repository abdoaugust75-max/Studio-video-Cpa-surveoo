param([switch]$OpenDashboard)
$ErrorActionPreference = 'Stop'
$watchdog = Join-Path $PSScriptRoot 'studio-watchdog.ps1'
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
Start-Process -FilePath $shell -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watchdog + '"') -WindowStyle Hidden | Out-Null
$ready = $false
for ($attempt=0; $attempt -lt 40; $attempt++) {
    try { $health=Invoke-RestMethod 'http://127.0.0.1:34567/health/live' -TimeoutSec 2; if ($health.ok) { $ready=$true; break } } catch {}
    Start-Sleep -Milliseconds 500
}
if (-not $ready) { throw 'Dashboard did not start. See data\watchdog.log and data\pipeline-server.stderr.log.' }
Write-Output 'Dashboard ready: http://127.0.0.1:34567/pipeline.html'
if ($OpenDashboard) { Start-Process 'http://127.0.0.1:34567/pipeline.html' }
