param([switch]$Once)
$ErrorActionPreference = 'Stop'
$studioRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$studioData = Join-Path $studioRoot 'data'
[IO.Directory]::CreateDirectory($studioData) | Out-Null
$mutex = New-Object Threading.Mutex($false, 'Local\VideoStudio-MASTER-34567')
$claimed = $false
try {
    try { $claimed = $mutex.WaitOne(0) } catch [Threading.AbandonedMutexException] { $claimed = $true }
    if (-not $claimed) { exit 0 }
    $env:VS_PORT = '34567'; $env:VS_HOST = '127.0.0.1'; $env:VS_ROLE = 'all'
    $studioNode = Join-Path $studioRoot 'runtime\node\node.exe'
    if (-not (Test-Path -LiteralPath $studioNode)) { $studioNode = (Get-Command node -ErrorAction Stop).Source }
    $watchLog = Join-Path $studioData 'watchdog.log'
    function Write-WatchLog([string]$message) {
        Add-Content -LiteralPath $watchLog -Value ((Get-Date -Format o) + ' ' + $message)
    }
    Write-WatchLog 'Supervisor started; dashboard port 34567.'
    do {
        $healthy = $false
        try { $health = Invoke-RestMethod 'http://127.0.0.1:34567/health/live' -TimeoutSec 3; $healthy = $health.ok -eq $true } catch {}
        if (-not $healthy) {
            $listener = Get-NetTCPConnection -LocalPort 34567 -State Listen -ErrorAction SilentlyContinue
            if (-not $listener) {
                foreach ($name in @('pipeline-server.stdout.log','pipeline-server.stderr.log')) {
                    $current = Join-Path $studioData $name
                    if (Test-Path -LiteralPath $current) { Copy-Item -LiteralPath $current -Destination ($current + '.previous') -Force }
                }
                $child = Start-Process -FilePath $studioNode -ArgumentList @('server.js') -WorkingDirectory $studioRoot -WindowStyle Hidden -RedirectStandardOutput (Join-Path $studioData 'pipeline-server.stdout.log') -RedirectStandardError (Join-Path $studioData 'pipeline-server.stderr.log') -PassThru
                Write-WatchLog ('Server started, PID ' + $child.Id)
                @{ pid=$child.Id; supervisorPid=$PID; port=34567; startedAt=(Get-Date -Format o) } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $studioData 'watchdog-state.json')
                # Give one child enough time to initialise. Never spawn a second copy
                # just because the first has not bound its port yet.
                for ($startupAttempt=0; $startupAttempt -lt 30; $startupAttempt++) {
                    Start-Sleep -Seconds 1
                    $child.Refresh()
                    if ($child.HasExited) { Write-WatchLog ('Server exited during startup, code ' + $child.ExitCode); break }
                    try { $startupHealth=Invoke-RestMethod 'http://127.0.0.1:34567/health/live' -TimeoutSec 2; if ($startupHealth.ok) { Write-WatchLog ('Server healthy, PID ' + $startupHealth.pid); break } } catch {}
                }
            } else { Write-WatchLog 'Port is occupied but health is unavailable; leaving the existing process untouched.' }
        }
        if (-not $Once) { Start-Sleep -Seconds 5 }
    } while (-not $Once)
} finally {
    if ($claimed) { $mutex.ReleaseMutex() }
    $mutex.Dispose()
}
