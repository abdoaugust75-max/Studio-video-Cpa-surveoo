# Audio-first reference learning and API health

The learning worker runs independent local ASR, then submits the entire original
audio to an audio-capable model. The structured result contains the heard script,
timestamped quotes, hook, argument order, delivery and spoken CTA. It is separate
from native-video vision. ASR, model timestamps and vocal delivery observations
remain unverified; high views alone do not establish why a script performed.
Unverified prices, rewards, scarcity, warranties and product claims are not copied
into learned instructions. Each of the seven page identities remains authoritative.

Audio and completed vision evidence are saved before downstream summaries. Invalid
JSON, missing fields and truncated responses fail validation and use bounded model
fallback. A partial reference cannot be applied. Requesting an older reference
without audio analysis creates an upgraded analysis, reusing extant source media,
ASR and completed vision where available. Expired media is downloaded again.

`GET /api/v2/provider-usage` and the private agent tool `api.inspect` show redacted
key health, request reservations, successful/failed requests and provider-reported
token totals. The dashboard displays these under Writer settings → Performance
learning → API health & usage. Existing key controls accept additional keys.

Pool allocation uses the fewest reserved attempts, including in-flight requests.
Duplicate secrets are one key. Suspended/invalid keys are persistently quarantined.
A 429 holds the shared model budget until cooldown; allocation cannot multiply a
quota by the number of keys. Unknown project ownership is treated conservatively
as one scope. Configured RPM/RPD caps apply before dispatch. Daily tracking resets
in America/Los_Angeles. TPM is not guaranteed by this request counter; provider
rejections remain authoritative.

Usage is local since this tracker was introduced, not a Google billing balance.
External consumers and pre-tracking requests are unknown. Remaining requests are
estimates against owner-configured limits, not certified provider headroom.
Authentication via the models endpoint does not prove model-generation quota.
Only actual completed generation marks a key ready for generation.

No credentials are exposed to the agent. Publishing remains held independently.

Focused regression command:

    .\runtime\node\node.exe --test tests/provider-audio.test.js tests/studio-tools.test.js tests/telegram-agent.test.js tests/automation.test.js
