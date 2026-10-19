# Windows local setup

This workflow does not use a VPS, Linux or Docker.

## Existing installation

1. Keep the configured `data/` and owner `assets/` beside the source. They contain
   the seven page identities/instructions, saved model selections, private tokens,
   website/prices, tutorial, profile clips, publication history and source registry.
   Never commit those directories to GitHub.
2. Run `node tools/check-local.js` (or `runtime\node\node.exe` in this installation).
   It checks imports with the same Windows DLL preparation as transcription.
3. Run `start-pipeline.bat`. It uses the bundled Node or falls back to installed Node.
4. Open `http://127.0.0.1:34567/pipeline.html`.

## Fresh source checkout

Install Node 22+ and Python 3.11+ on Windows. Supply FFmpeg/FFprobe and yt-dlp:
FFmpeg may be on PATH or under `tools/ffmpeg/ffmpeg-<version>/bin/`; put the Windows
yt-dlp executable at `tools/yt-dlp.exe`. Keep tool binaries outside Git history.
These tools are not embedded in the source release and this guide installs nothing.

Prepare the isolated Python environments, using your installed Python path:

```powershell
.\tools\setup-speech.ps1 -Python 'C:\path\to\python.exe'
.\tools\setup-agent.ps1 -PythonPath 'C:\path\to\python.exe'
node tools/check-local.js
```

Speech model weights download on first use unless the local model cache is restored.
The HTTP dashboard can boot without these dependencies, but cannot produce videos
until they are present. Fresh copies have seven default profiles, empty credentials,
no owner clips, publishing held and scheduling off.

To carry over the configured studio, stop its supervisor/worker first and copy its
private `data/` and `assets/` locally. Preserve relative paths; absolute Windows paths
may need correction on another computer. Run only one worker against a state folder.
Never merge two live copies of the job/publication journals.

## Tests and source release

```powershell
npm test
node tests/production-model-routing.js
node tests/video-understanding.js
node tests/source-continuation.js
npm run release
```

`npm test` starts an isolated web process with temporary empty state; it cannot
consume the owner's queue or tokens. Its publication request must be refused.
The remaining focused tests use fixtures. Actual search/generation requires the
configured local studio, provider capacity and accessible source media.

The release is an explicit allowlist with credential-pattern scanning and a SHA256
manifest. Upload only that release to the intended private repository. It excludes
private state, clips, media, models and installed runtimes. A scan is a safeguard,
not proof that every possible secret format is recognizable.

Scheduling remains disabled and publication held until the owner explicitly
re-enables publishing. Tests and source upload do not change that setting.
