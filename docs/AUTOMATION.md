# Automation and deployment

## Schedule

Initial experimental slots, editable independently for each profile:

| Audience | Video 1 | Video 2 | IANA timezone |
| --- | --- | --- | --- |
| Moroccan profiles, including both Maghrebly destinations | 13:00 | 20:00 | Africa/Casablanca |
| Al-Shihna | 13:00 | 20:00 | Asia/Riyadh |
| Vouch Teck, UK anchor | 19:00 | — | Europe/London |
| Vouch Teck, US anchor | — | 19:00 | America/New_York |

These times are starting hypotheses, not established peaks for these accounts. English tier-one audiences span multiple timezones. Tune using actual account insights. Morocco Ramadan offset and UK/US daylight saving follow the host's IANA timezone database.

The worker checks every 15 seconds. It prepares fresh sources up to 18 hours ahead, reuses each shared analysed source across the enabled page writers, then dispatches each profile at its own slot. Maghrebly uploads that profile's video to both authorised Facebook IDs. Two daily videos for seven profiles means 14 renders and 16 Facebook uploads when all eight destinations are connected.

A single worker cannot promise publication to the exact second. Heavy running jobs, provider quotas, network requests and Facebook processing can delay completion. Queued publication jobs get priority, and expire 30 minutes after the slot. Startup does not bulk-post missed slots or replay old days. Failed search gets at most three attempts per batch; failed production gets at most two retries per slot. Expired credentials block paid production for that profile and appear in Settings. There is no automatic token renewal guarantee.

Schedule state and jobs persist on disk. Do not run multiple worker replicas against the same JSON store. The scheduler has a process claim and publication has a per-artifact/destination claim. An uncertain upload remains blocked for manual platform reconciliation; it is not automatically re-uploaded. Both successful and partial outcomes are stored per destination. Never remove an upload claim until you have checked Facebook.

## Telegram

1. Create a bot using Telegram BotFather.
2. Paste its token into Settings → Automation & Telegram. The token is stored privately on the server; GET settings returns only a configured flag.
3. Send `/start` to the bot, then choose **Find my chats**.
4. Select your chat, enable reports, save and choose **Send test**.

Reports include publication results, blocked/missed slots and a daily last-24-hours digest at 23:00 Morocco time. The report counts unique accepted uploads, including separate Maghrebly destinations, and fetches available likes/comments/shares for recent posts. Facebook video views are included when Meta exposes them. Missing permission, deleted posts and failed requests remain unavailable, never zero. Telegram is not connected until a real test succeeds. An uncertain Telegram send is not automatically repeated.

## Windows source handoff

Use the allowlisted release from `npm run release` in a private GitHub repository.
See [local setup](LOCAL_SETUP.md) for Windows dependencies and the private state
that must accompany an existing studio. Fresh copies start with publishing held
and scheduling disabled. Source checks run on Windows and do not install Docker.

## Boundaries

The current publishing path is Facebook. Instagram accounts/publishing still require implementation/connection. Valid Facebook identity checks do not establish all upload/analytics permissions; the API confirms these during the actual operation. No schedule can guarantee reach, creator rights or platform approval.
