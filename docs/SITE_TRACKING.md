# Website and MyLead attribution

This implementation adds the visit → offer click → synchronized lead join. Website
source is managed through the existing private Studio GitHub repository and deployed
to each mapped Cloudflare Pages project through the Studio settings and agent tools.
MyLead synchronization remains read-only, social publishing is unchanged, and this
does not edit existing MyLead offers. Google remains the script provider.

## Owner setup

Open Settings → MyLead CPA → Website tracking. Enter the public HTTPS origin of
the Studio tracker. Add each site's identifier, exact allowed origins, landing
page URL, existing MyLead offer URL, optional campaign identifier and market.
Sites start as drafts. Save and enable only the intended sites.

Markets are `morocco_darija`, `arabic` and `english`. The Moroccan website results
aggregate together, while `alshihna` and `vouchteck` use their respective market.
Every social page and source video still has a separate result. Neither market
grouping nor site settings change any writer identity, language, voice or card.

Copy the generated script into the static landing page. Add `data-studio-offer`
to the existing offer anchors. Keep their original href: if tracking fails or
has not loaded yet, the original link remains available and that click is not
recorded. Sites must permit the tracker in their CSP script-src/connect-src.
The tracker must be reachable by visitors. A proxy protecting the dashboard must
allow `/track/client.js`, `/track/event`, `/track/go` and the keyed `/mylead-lead`
receiver through without owner login. No settings or report path should be public.

New campaign caption links are annotated with `st_page`, `st_video` and, when
configured, `st_campaign`, only if exactly one enabled site matches the website's
market, origin and landing path. Existing outputs and published posts are not
changed. The embed's `data-page` is a fallback for dedicated sites. Shared bio
links without source tags cannot attribute a visitor to a particular video.
Query-string source labels are attribution labels, not verified platform events.

## Click join

The script records one page-load event and receives a signed, 24-hour redirect.
Only allowed site origins may collect events. The redirect resolves exclusively
to the offer URL saved by the owner, with these MyLead sub IDs:

| Parameter | Stored source |
| --- | --- |
| ml_sub1 | Signed visit's recorded unique click identifier |
| ml_sub2 | Social writer/page key, or empty when unknown |
| ml_sub3 | Final Studio video artifact, or empty when unknown |
| ml_sub4 | Website identifier |
| ml_sub5 | Campaign identifier, or empty |

The offer must preserve these fields in MyLead's conversion API. Confirm this
against the actual offer's link format before relying on live attribution. Existing
sub IDs in the configured offer URL are replaced intentionally. No fake lead is
needed or created. The authenticated Settings → MyLead CPA panel now also provides
a private postback URL and a text download. Configure that URL under MyLead's
For Webmasters → Postback with **Any status**, preserving every bracketed macro.
`[payout_decimal]` is used because `[payout]` is expressed in cents.

The public `/mylead-lead` receiver requires the private URL key. Its exact path must
also be in the Umbrel proxy whitelist. Invalid keys, unresolved macros and missing
decimal payout/currency are rejected. Repeated identical receipts are idempotent;
status changes update the same transaction. Accepted is provisional (`pre_approved`),
not final approval. Unknown status codes remain unknown. Receiver verification uses
`verify=1` and creates no receipt. It stores no IP or user-agent fields.

Network postback receipts are shown as separate provisional signals. They are not
added to API-confirmed conversion/payout totals, since the relationship between a
callback transaction ID and an API conversion ID must be established before merging
them. This avoids double-counting a lead. API synchronization remains read-only and
manual. The secret URL is exposed only through the owner's authenticated dashboard
and download; it is never included in the agent's report or source release.

Official configuration reference: https://mylead.global/en/blog/postback-api-configuration

The numeric report joins synchronized leads to click receipts by ml_sub1. Saved
click metadata determines the group if other returned sub IDs disagree. Mismatches
and unmatched conversions are counted explicitly. An unmatched conversion may be
from older traffic, another cohort or another source; it is not discarded from the
separate MyLead account report.

## Metric meaning

Reports use a UTC visit cohort (default 30 days, maximum 90). Next-day clicks are
included for a visit in the cohort. Subsequent synchronized conversions update
that cohort. Visits are page loads, not unique people or verified human traffic.
Click counts deduplicate repeated navigation from the same signed visit. Only
approved leads contribute revenue. Approval rate counts distinct approved click
IDs, so multiple approved goals from one click cannot inflate the rate beyond
100%. Payouts and revenue per visit stay separated by currency. Country revenue
is in MyLead's report; visit geography is unknown, so a country-specific conversion
rate cannot be inferred here. No model calculates these arithmetic totals.

The owner Telegram agent has a read-only `tracking.overview` tool for these
metrics. It cannot change tracking settings, destinations, sites or publishing.
Separate specialist agent departments and website experiments are later work.

## Storage and limits

Private settings and the signing key stay in `data/studio/site-tracking-private.json`.
Compact receipts stay in `data/studio/tracking-events/YYYY-MM-DD.jsonl`. No cookies,
IP addresses, user-agents, full visitor URLs or browser fingerprints are collected.
This uses the existing single writer process; do not share one state directory
between competing web processes. Each accepted receipt is appended before success
is returned. Ledger errors fail explicitly rather than inventing zero metrics.

The receiver limits requests to 8 KB, uses an origin/site budget of 300 accepted
visits or redirect requests per minute, and caps daily receipts at 20,000. These
are basic resource limits, not bot detection or proof of legitimate visitors.
Receipts remain after media cleanup so old leads can still be attributed. Automatic
receipt compaction is not implemented; reports display at most 100 groups per
dimension and read at most 90 days, with an explicit 100,000-receipt report budget
to limit memory usage. Larger reports require a shorter date range; partial totals
are not silently returned. HTTP on localhost is allowed for isolated
development; public tracking requires HTTPS.

## Verification

`node --test tests/site-tracking.test.js` uses disposable state and a loopback HTTP
server. It checks origin rejection, signatures, missing/corrupt settings, persistence,
market grouping, mixed currencies, duplicate goals, midnight cohorts, source tags
and authenticated/public route boundaries. No external offer or Meta API is called.
Actual website installation, MyLead synchronization and live attribution remain
separate verification steps. The additional isolated-application test boots the
real Studio with Basic authentication, verifies public tracking vs protected
settings/report access, and confirms publishing and scheduling remain held.
