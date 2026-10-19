# Per-page learning and Telegram tools

The seven profiles retain their own idea, language, audience, voice and profile clip. Learning observations and prompt edits are stored separately for each profile. Current footage remains authoritative for each new script.

## Owner commands

- “Check Meta connections now.”
- “Scan MaghrebTech Store old videos and show the highest views.”
- “Analyze the highest-view scanned MaghrebTech Store video.”
- “Apply the completed MaghrebTech Store reference.”
- “Make a fresh MaghrebTech Store video inspired by that reference.”
- “Change Maghrebly writer instructions: keep the opening short.”
- “Show Maghrebly writer edit history.”
- “Undo the latest Maghrebly writer edit.”

Changes require the configured private owner conversation and a clear instruction naming one profile. Read-only HTTP assistant previews cannot edit prompts or queue analysis. Provider credentials stay in backend services and are never supplied to the model. The tool allowlist contains no shell, arbitrary file access, deletion or direct publishing operation.

Writer changes affect future runs; existing scripts, narration and assembled videos retain their original settings. Revision history stores the previous and new instructions. Undo refuses to overwrite a later manual change. Dashboard Writer Settings also contains per-page scan, reference analysis, apply, production and revision controls.

## Evidence and scope

Historical scans read both Page videos and reels, up to 100 records per edge and destination per scan. Results report coverage and whether more records exist. Rankings describe only scanned videos, not an exhaustive lifetime ranking. Facebook `Video.views` is used where available; missing metrics stay unknown. High views alone do not establish why a video performed well.

Metadata refreshes daily. Heavy reference analysis is queued on owner request, limited to 180 seconds and 200 MiB, and restricted to owned Page media on Meta's CDN. Independent audio recognition and full-source vision review must finish before observations can be enabled. Failures remain visible; an incomplete analysis supplies no learning context. The owner chooses when to enable observations or edit instructions.

Fresh inspired production searches new footage and uses the existing selected-page writer, TTS and assembly pipeline. It does not request an extra publication outside the existing publishing workflow. Reference analysis shares the durable job queue; an already-running production job may delay it. Completed or failed reference analysis sends a notification when Telegram reporting is enabled.

Meta identity checks run live but do not establish every upload/insights permission. Each API operation verifies its own access. Instagram history and publishing are not connected in this implementation.

## Local operations tools

The owner assistant can inspect all queue records (including jobs older than the UI's 60-record view), scheduler gaps, saved page scripts, narration/output metadata and redacted errors. It can perform technical video checks, create fresh production for a named page, and retry failed non-publishing campaigns. It cannot retry a publishing campaign, run a shell, edit application code, delete files, reveal credentials or change profile identities.

`/tools` lists these capabilities in the configured private Telegram chat. Production commands require explicit owner instructions and a named page; repeated Telegram deliveries are deduplicated by request ID. A publication hold blocks the actual uploader independently of the scheduler being disabled.

Queue dispatch examines the full queue. Publication and page assembly have higher priority than background reference learning; a running heavy job is not forcefully interrupted. Technical video checks inspect saved file/probe and subtitle-alignment provenance; they do not establish actual pronunciation or visual quality.
