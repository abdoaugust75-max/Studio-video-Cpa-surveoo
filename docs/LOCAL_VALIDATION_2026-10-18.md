# Local validation — 18 October 2026

Scope: existing Windows installation, generation and tests only. Publication stayed
held and the scheduler disabled. No VPS or Docker installation was performed.

## Real pipeline

The studio automatically searched for phone unboxing footage and selected a source
that passed its visual screening. Three distinct models reviewed its full 65.37s
source: Gemini 3.5 Flash Lite, Gemini 3.1 Flash Lite and Gemini 2.5 Flash. The saved
analysis contains 70 timestamped scenes. Coverage is recorded; model perception
and scene timestamps are not guaranteed exact.

All seven page outputs completed using the existing page ideas, languages, Kore
voice, silent tutorial insert, profile clips and audio-derived karaoke:

| Profile | Final duration | Video/TTS duration difference |
| --- | ---: | ---: |
| alshihna | 47.30s | 0.02s |
| maghrebtechstore | 46.30s | 0.02s |
| maghrebly | 40.10s | 0.02s |
| mubadara | 38.40s | 0.00s |
| tashilat | 48.60s | 0.00s |
| amazon_liquidation | 38.93s | 0.01s |
| vouchteck | 33.37s | 0.01s |

All seven files decoded completely with FFmpeg, were portrait, contained audio,
kept the complete narration duration and retained audio-word alignment metadata.
The current-product price audit passed for all seven. Sample rendered frames were
inspected locally; these checks do not certify every pronunciation or creative choice.

## Defects found and fixed during the run

- Search launched too many downloader helpers. Discovery now works in small batches,
  inspects candidates before waiting for all queries, caps metadata helpers at two,
  includes queue wait in their deadline and stops descendant processes on timeout.
- Unboxing discovery was unnecessarily expanded into reviews. Its secondary query
  now favors ASMR, while preserving the strict visual acceptance gates.
- A legacy price for another phone leaked into a script. Price facts are scoped to
  the visible product, checked before TTS and checked again in campaign validation.
  Missing verified pricing means omission; owner instructions remain saved.
- Independent forced-alignment windows overlapped on a long Darija narration.
  Conflicts can now be reconciled only using nearby, sufficiently confident words
  from independent ASR. Unresolved disagreements still fail. Actual affected words
  were reprocessed and the output completed without invented timestamps.
- Optional planning links made otherwise usable scripts fail. Writers now receive
  structured output requirements and specific validation feedback. Typographic
  quotation differences are normalized only to actual script substrings; invalid
  scene links are discarded, and at least one evidenced link is still required.

## Publication and operations

- Fresh read-only Meta checks passed for all eight authorized destinations,
  including both Maghrebly pages. These checks do not exercise upload permissions.
- A plan with approval simulated **in memory only** produced exactly eight valid
  artifact/destination pairs. No approval was saved on disk.
- Invoking the execution path under the publication hold was blocked before any
  outbound upload call. Uploaded videos: **0**.
- A live Nanobot preview performed `api.inspect` and returned an Arabic owner reply
  after two model calls and one real backend tool call. It sent no Telegram message.
- A clean source copy booted against isolated empty state, showed seven profiles,
  had scheduling off and refused a publication request. No owner data or keys were
  available to that process. Full production still needs the documented runtimes,
  owner configuration and media assets.

## Repeatable checks

The local Node test suite passed 52 tests with zero failures/skips. Separate model
routing, whole-video understanding and source-continuation checks also passed.
The source release is allowlisted and scanned; private runtime state is excluded.
GitHub CI and remote source upload are separate from this local evidence.

Detailed private receipts and exact artifact IDs remain under `data/studio/` and
are deliberately excluded from the GitHub source package.
