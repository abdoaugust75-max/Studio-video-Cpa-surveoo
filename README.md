# VideoStudio · Production Atlas

Phone unboxing discovery and visual screening, whole-video analysis, seven page writers, Kore narration, audio-aligned karaoke, profile clips and scheduled Facebook publishing.

## Local

Requires Node 22+, FFmpeg/FFprobe, yt-dlp and the Python speech runtime. On Windows, run `tools/setup-speech.ps1` to install speech alignment. Existing installs keep all state in `data/` and all owner media in `assets/`.

```powershell
$env:VS_PORT='34567'
node server.js
```

On Windows, `start-pipeline.bat` starts a hidden supervisor and opens the dashboard. `install_autostart.bat` installs the per-user login task; it keeps the server running and restarts it after a crash. All launchers use port 34567. The computer must remain awake; login startup is not an always-on cloud deployment.

Open `http://127.0.0.1:34567/pipeline.html`. Settings → Automation & Telegram contains the two daily slots, worker results and the private Telegram connection form.

```sh
npm test
npm run release
```

The release command produces a scanned, allowlisted source folder under `release/`. Use that folder for a new **private** GitHub repository. It contains no runtime data, tokens, source videos, owner assets or conversations. It does not push anything.

## Local setup and source checks

This release targets the existing Windows studio. See [local setup](docs/LOCAL_SETUP.md).
Run `node tools/check-local.js` for dependency checks; it installs nothing.
GitHub stores the source and Windows CI checks it. It does not run the video worker.

The source release excludes private `data/`, owner `assets/`, credentials, media,
Python environments, model downloads and local binaries. A clean source can open
with empty state and seven default profiles, but needs its owner configuration,
profile clips and runtime dependencies before production is available.

Publishing is held and scheduling is off by default on a new copy. Tests do not
upload videos. The existing owner's publishing hold remains in place.

An owner-authorized encrypted state snapshot is stored separately in this private
repository. See [configuration recovery](docs/PRIVATE_BACKUP.md). Its recovery key
is retained locally outside GitHub and Notion; the normal release stays source-only.

## Verified scope

`npm test` includes fresh empty-state boot, default publication hold, scheduling,
per-destination upload deduplication, agent authorization/memory, provider health,
audio evidence, retention and pipeline controls. Most platform tests use mocks;
actual generation and Meta identity checks are tracked separately in the local
validation report. No test establishes that the application has no possible bugs.

Instagram publishing is not connected. Unavailable Facebook metrics stay unknown,
not zero. No guaranteed reach or permanent token validity is promised.

## Telegram AI assistant

Settings → Automation & Telegram connects the owner’s bot. Save shows progress, verifies the bot username and provides an Open my bot link. Press Start in that bot, choose your private chat using Find my chats, and save. The worker listens for messages only from that configured private chat.

Ask naturally about the current pages, saved analyses/scripts, narration, assembled videos, schedules and failures. `/report` and `/status` generate a live report; `/help` explains the commands. Daily reports include an AI summary with a factual report fallback when the model is unavailable. The authorized private owner conversation can check Meta live, scan historical videos, queue transcription and full-source vision review, apply same-page observations, and request fresh production. Explicit instructions naming one page can edit or undo only that page's writer instructions; revisions are saved. These tools do not publish an extra post or delete content. See [learning and tool controls](docs/PAGE_LEARNING.md).

The local operations assistant uses Nanobot with a restricted studio-only tool bridge, Gemini 3.8 Flash and a Flash Lite fallback; video writer/TTS selections remain independent. The model receives a redacted snapshot, not provider credentials. UI Save logic, inbound authorization, reply deduplication and structured AI output have focused tests. Live Telegram delivery still requires the owner’s real bot token and private chat.

## Local agent and storage

See [Nanobot and daily cleanup](docs/LOCAL_AGENT_AND_STORAGE.md). On Windows, tools/setup-agent.ps1 installs the independent agent runtime. Daily media cleanup preserves deduplication/publication records and protects active work and latest page outputs.
