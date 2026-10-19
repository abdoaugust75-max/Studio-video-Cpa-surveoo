$ErrorActionPreference = 'Stop'
$studioRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$shell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$watchdog = Join-Path $PSScriptRoot 'studio-watchdog.ps1'
$arguments = '-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $watchdog + '"'
$installed = $false
try {
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action = New-ScheduledTaskAction -Execute $shell -Argument $arguments -WorkingDirectory $studioRoot
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName 'VideoStudio Dashboard' -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Description 'Keep VideoStudio available on localhost port 34567.' -Force | Out-Null
    Start-ScheduledTask -TaskName 'VideoStudio Dashboard'
    $installed = $true
    Write-Output 'Installed and started the per-user VideoStudio Dashboard scheduled task.'
} catch {
    Write-Output 'Scheduled task unavailable; installing the per-user login startup entry.'
}
if (-not $installed) {
    $runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    if (-not (Test-Path -LiteralPath $runKey)) { New-Item -Path $runKey -Force | Out-Null }
    New-ItemProperty -LiteralPath $runKey -Name 'VideoStudio' -PropertyType String -Value ('"' + $shell + '" ' + $arguments) -Force | Out-Null
    & (Join-Path $PSScriptRoot 'launch-studio.ps1')
    Write-Output 'Installed the VideoStudio login startup entry.'
}
