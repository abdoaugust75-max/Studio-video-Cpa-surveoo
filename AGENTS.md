# VideoStudio working rules

- Work on the local Windows studio. Do not install or introduce Linux, Docker or
  remote hosting as part of the current work.
- The owner currently permits tests only. Keep `publish-hold.json` enabled and
  automation disabled. Do not upload to Facebook/Instagram, save owner approval,
  or enable scheduling without a subsequent explicit owner request.
- Missing/corrupt publication-hold state must fail closed. A test must never turn
  publishing on. Source upload to GitHub is not authorization to post videos.
- Preserve the seven profile ideas, languages, names, Kore voice and profile clips.
  Maghrebly has two separate authorized Facebook destinations. Learning is an
  additive, reversible, same-profile layer; current footage and approved facts
  remain authoritative. A reference script's price/reward/scarcity is not a fact.
- The operations agent uses a restricted backend tool bridge. Never give it shell,
  arbitrary file/secret access, unrestricted deletion, identity edits or publishing.
- Never print tokens or private configurations. GitHub receives only an allowlisted
  source release; `data/`, `assets/`, logs, media, conversations and runtimes stay
  private. Use the intended private repository.
- Report live evidence separately from mocked tests. Readiness is not a successful
  generation, a token identity check is not an upload-permission test, and metadata
  alone does not prove pronunciation or visual quality. Do not claim bug-free work.
- Local checks: `npm test`, `node tests/production-model-routing.js`,
  `node tests/video-understanding.js`, `node tests/source-continuation.js`.
  `node tools/check-local.js` checks dependencies without installing them.
- Actual campaign inspection: `node tools/validate-campaign.js <runId>`. It only
  simulates approval in memory and must prove that the publication hold blocks
  execution before any outbound upload call.
