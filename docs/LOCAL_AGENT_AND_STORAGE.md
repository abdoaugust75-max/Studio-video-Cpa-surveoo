# Local Windows agent and daily storage

## Nanobot

Nanobot 0.3.0 is installed in the independent `tools/agent-runtime` Python environment. `tools/setup-agent.ps1` recreates it using a supplied or existing local Python interpreter. No Linux or Docker runtime is needed for this local integration.

The existing Node Telegram receiver remains the only receiver. For each ordinary owner message, Node starts a Nanobot process with one registered tool: `studio_action`. That tool calls the existing backend allowlist, preserving owner authorization, page isolation, mutation revisions and publication hold. Nanobot has no shell, filesystem, web, cron, skill-install or unrestricted MCP tools. Unknown slash commands are rejected before entering its command router.

Gemini remains the LLM provider through the existing Node credential router. The agent receives no provider credentials. Operations use Gemini 3.8 Flash with a Flash Lite fallback; writer and TTS model selections are unchanged. Each request is bounded to four model calls and three backend tool calls. The Python process exits after the request, so it has no idle resident gateway. Disk dependencies are about 197 MiB in the measured installation; actual request memory is recorded in `nanobot-state.json` when available.

Recent Nanobot session context is bounded to eight user turns. Persistent owner preferences, task receipts and the searchable redacted conversation archive remain in the studio data folder. Historical receipts do not establish current completion; live jobs/tool evidence takes priority. Provider quota failures after tool execution return the completed receipts rather than automatically repeating actions.

## Every 24 hours

The worker checks the policy once a minute and cleans when 24 hours have elapsed since the last successful sweep. Individual media files must also be at least 24 hours old. The first eligible sweep runs automatically. If the PC is asleep or off, the due cleanup runs when the worker resumes.

The cleaner protects active/queued job projects and shared media, uncertain uploads, imported owner assets and the latest assembled output for each page. Superseded old local media can expire even when the historical project metadata remains. It writes the retirement ledger and source deduplication identity before deleting bytes, then records each file hash and purge status. Project records, source URLs/IDs, Facebook post IDs/links, publication journals, transcripts and reports remain. Historical local previews/rollback files may therefore be unavailable after expiry; this is intentional media retention, not deletion of the audit trail.

Deletion is confined to real files under the studio media root; symlinks are skipped. Old file bytes and mtimes are rechecked before unlinking. New jobs are checked between batches. A failed ledger write prevents that file from being deleted. The cleaner does not remove runtime dependencies, keys, owner profile clips or application source. Cleanup status and a manual eligible-only sweep are available in Writer Settings → Performance learning → Daily storage cleanup. This manual button applies the same protection and age rules.

The source/ID registry prevents reusing known sources. Hashes retain exact file identity for audit; they do not imply a perceptual duplicate detector for cropped or re-encoded uploads.

Publication is held and the scheduler disabled at the owner's request. Cleanup or agent activation does not enable publishing.
