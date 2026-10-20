# ARM64 Umbrel deployment

Owner-authorized Ubuntu migration, 20 October 2026. The Windows installation stays
intact. No Docker engine was installed: the VPS already ran Docker and Umbrel.

## Layout

- Umbrel app ID: `freebuff-videostudio`, in the existing Freebuff community store.
- Persistent state/assets: `/home/ubuntu/umbrel-data/app-data/freebuff-videostudio/`.
- Build/rollback directory: `/home/ubuntu/videostudio-build-2026-10-20/`.
- HTTPS entry: `https://51.170.133.14:34568/pipeline.html`.
- Caddy forwards HTTPS to Umbrel's existing app authentication proxy. An anonymous
  request redirects to the normal Umbrel sign-in. No authentication is disabled.
- The app manifest uses an absolute HTTPS path; Umbrel supports URL resolution of
  this field. Existing services and their routes are preserved.
- Dedicated local image registry: `127.0.0.1:5001`. Umbrel always pulls app images;
  this registry supplies the privately built ARM image without publishing it.

The app has a 6 GiB memory ceiling, two CPU quota, one job worker and bounded logs.
Its persistent data/assets are mounted only into its own container. No Docker socket
or privileged mode is granted to the studio. Image includes Node 22, FFmpeg,
yt-dlp, independent speech and Nanobot runtimes. CPU speech model weights live in
the persistent state directory. Owner fonts were transferred privately for matching
Arabic rendering and are not distributed in the source repository.

## Migration controls

The authenticated encrypted recovery snapshot was extracted only into a new
directory. Windows-root paths were remapped to `/app`; old pending jobs were
quarantined. The temporary VPS copy of the recovery key was removed after restore;
the original remains privately on the owner's PC. Downloaded/generated historical
media are excluded from that snapshot; metadata alone does not restore old videos.

Publishing remains held and the scheduler disabled. Migration tests cannot enable
either. Telegram polling starts on only one installation at a time; stop its PC
receiver before enabling the VPS receiver. The dashboard on the PC need not stop.

## Operations

Open VideoStudio from the logged-in Umbrel home screen. Its restart policy and
Umbrel auto-start preserve operation after restarts. Docker health checks report
liveness; API readiness and real pipeline results must be checked separately.

The extra Caddy site is additive and the previous config is backed up at
`/etc/caddy/Caddyfile.before-videostudio-2026-10-20`. UFW permits only the additional
HTTPS TCP port 34568. `videostudio-private-ingress.service` denies external access
to the raw Docker proxy port 34567, preserving loopback HTTPS forwarding. The
interface name in that unit is specific to this inspected VPS.

Do not run two workers against the same JSON store or let both Telegram receivers
poll one bot. Review absolute paths, credentials, unresolved uploads and readiness
before enabling production. Current Meta identity checks are not proof of upload
permission and do not make tokens permanent.

To roll back, stop this app through Umbrel and preserve its data. Remove only the
added Caddy site and this app's UFW/ingress rules after checking their exact names.
Do not uninstall other apps, prune Docker globally, replace the Caddy configuration
or restore all firewall rules over the current host.

## Validation on 20 October 2026

- All six dependency checks passed inside the ARM64 image, including both Python
  runtimes. The CPU small speech model loaded successfully.
- 52 tests passed on the final VPS image with zero failures/skips; the three
  focused routing, understanding and source-continuation suites also passed.
- Automatic discovery selected a source after continuing to a second search round.
  Three distinct models completed the full 38.97s source review with 29 timed scenes.
- Campaign `CRmvg0vzly2c7a09` produced one real MaghrebTech output: 30.40s portrait
  MP4 with audio, full FFmpeg decode, actual audio-word alignment and 0.00s duration
  difference. All seven identities and eight destinations remain configured.
- The single-profile campaign validator passed: price/grounding checks, one
  simulated destination pair and a publication hold that blocked execution before
  any outbound upload request. Approval was not saved; uploaded videos: zero.
- Fresh Meta identity checks passed for all eight destinations. These do not
  establish upload permission or permanent token validity.
- Nanobot completed a live `api.inspect` preview in Arabic. Telegram test delivery
  succeeded, and the VPS receiver listened without errors after the PC receiver
  was paused. PC credentials remain saved privately.
- After the app-only update/restart, health was ready, the new output persisted,
  authenticated HTTPS dashboard/icon requests returned 200 and MP4 range playback
  returned 206. Anonymous HTTPS redirects to Umbrel sign-in.
- Same-host HTTPS writer/video settings requests reached normal validation;
  cross-host requests returned 403. This caught and fixed old HTTP-only guards.

The schedule tests formerly hardcoded an outdated Morocco UTC offset. They now
exercise local wall time against installed IANA rules. The VPS Node runtime uses
tzdb 2026c; the Windows runtime may carry older data. No production offset is
hardcoded. Successful technical tests do not prove every creative choice or remove
the need to monitor quotas, platform permissions, disk space and future failures.

Private receipts are saved in the VPS data directory, including
`vps-validation-2026-10-20.json`, `vps-test-results.txt` and
`local-campaign-validation-CRmvg0vzly2c7a09.json`. The latter confirms zero uploads.
