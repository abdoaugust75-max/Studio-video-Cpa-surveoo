# Telegram video review

The VPS is the only Telegram receiver. The PC dashboard and its scheduled task
are disabled; local source, credentials and state are preserved.

Simple greetings reply immediately without inspecting the studio or calling a
model. Typing continues during real work. The generic delayed progress message
was removed because it claimed tool activity even for conversational requests.

## Review and a permanent page example

- New assembled campaign outputs are sent as MP4s to the configured private chat.
  Startup establishes a cutoff so old campaigns do not flood the owner. A new
  render of an older campaign is also eligible. The owner can request an existing
  output with `video.send`.
- Reply to a delivered video and name its page, for example:
  `خلي هاد المثال مرجع دائم لـMaghrebly`.
- `example.save` extracts an abstract spoken hook, pacing, transitions and CTA
  recipe. It preserves the selected script and identifiers as lightweight private
  evidence. It does not preserve media forever or copy old prices/product claims.
- The same page's future writer briefs use the recipe with current footage and
  owner instructions. All seven identities and languages remain fixed. The
  original visual settings, voices, cards and editing pipeline remain in control.
- `example.inspect` and `example.undo` expose and reverse the selection. Ambiguous
  examples, cross-page replies and malformed extraction do not save a recipe.
- Selection is not publication approval, a schedule change or a production loop.
  Fresh production still uses `production.start` or the existing scheduler when
  separately enabled. The publication hold remains enabled; scheduling is off.

Private receipts and examples live in `data/studio/telegram-video-review.json`.
Sending is serialized and persisted before dispatch. Unknown Telegram acceptance
is never retried automatically; definite failures can be retried explicitly.
Direct uploads are limited to 49 MiB and 180 seconds request time; larger files
remain in the dashboard and return a clear error. Telegram delivery is not social
publication or evidence of final creative quality.

The six focused tests cover upload format, greeting behavior, receipt deduplication,
reply scope, persistent examples, rollback and malformed/uncertain outcomes.
