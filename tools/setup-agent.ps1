param([string]$PythonPath)
$ErrorActionPreference='Stop'
$studioRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if(-not $PythonPath){$PythonPath=Join-Path $PSScriptRoot 'speech-runtime\Scripts\python.exe'}
if(-not(Test-Path -LiteralPath $PythonPath)){throw 'Supply a Python 3.11+ interpreter using -PythonPath.'}
$agentRuntime=Join-Path $PSScriptRoot 'agent-runtime'
& $PythonPath -m venv $agentRuntime
if($LASTEXITCODE -ne 0){throw 'Agent runtime creation failed'}
& (Join-Path $agentRuntime 'Scripts\python.exe') -m pip install 'nanobot-ai==0.3.0' --disable-pip-version-check
if($LASTEXITCODE -ne 0){throw 'Nanobot installation failed'}
Write-Output 'Nanobot installed in the studio private runtime. The existing Telegram receiver remains the only receiver.'
