param([string]$Python = 'python')
$ErrorActionPreference = 'Stop'
$speechRuntime = Join-Path $PSScriptRoot 'speech-runtime'
& $Python -m venv $speechRuntime
if ($LASTEXITCODE -ne 0) { throw 'Could not create the speech runtime.' }
$speechPython = Join-Path $speechRuntime 'Scripts/python.exe'
& $speechPython -m pip install -r (Join-Path $PSScriptRoot 'speech-requirements.txt') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Could not install the audio transcription dependencies.' }
Write-Output 'Speech runtime ready. The first transcription downloads the multilingual Whisper model.'
