# Website source, tracking, and Cloudflare deployment

The Studio keeps the seven landing websites in the existing private Studio GitHub repository, one isolated folder per site (`sites/<site-id>`). It does not create a separate repository per website. The seven existing Cloudflare Pages projects remain Direct Upload projects; the Studio publishes their saved source with the Pages Direct Upload API.

Credentials live in `data/studio/site-integrations-private.json`. The settings API exposes only connection status and public mappings, never tokens. The private file must not be added to the repository or release archive.

## Available workflow

1. Connect the private Studio GitHub repository using a fine-grained token with **Metadata: read** and **Contents: read/write** on that repository.
2. Connect the Cloudflare account using a token with **Pages: Edit** for the account, and verify the account ID.
3. Map each existing Pages project/domain to its own folder in the existing Studio repository. The mapping is checked against GitHub repository privacy and Cloudflare project domains.
4. Import the live website HTML and same-origin referenced assets. Existing `price-low.eu/a/...` affiliate links are labeled as separate offers and routed through signed Studio tracking links. This saves a GitHub commit only; it does not change the live domain.
5. Edit website text files within the mapped folder. Preview creates a Cloudflare Pages preview deployment on the `studio-preview` branch. Production deployment is a separate explicit action; successful deployments are recorded. Rollback is limited to a successful production deployment belonging to that same project.

The Telegram Studio agent has bounded website tools for inventory, inspection, import, text source reads/edits, preview, explicit production deploy, history, and rollback. Mutations require a direct owner request in the private bot conversation and an exact mapped site ID/domain. The agent does not receive integration credentials. A website edit is saved to GitHub first; the live website is unchanged until deployment.

## Tracking limits

The browser tracker records page loads and distinct affiliate offer clicks, attaching MyLead sub IDs for the signed click, profile, video, site, and campaign. Subsequent MyLead postbacks/API conversion rows can join back to the original click. This supports site/offer funnel comparisons; it does not identify visitors or observe actions inside an external survey. Cloudflare Pages analytics is not the source of CPA conversion attribution.

## Current project scope

The seven existing projects are `warehouse-morocco`, `vouchteck`, `tasshilatttech`, `maghrebtechstore`, `maghrebtech-online`, `maghrebly-shop`, and `alshihna`. The unrelated `monetagepush10` project is excluded. Website deployment does not publish social videos or enable social scheduling.

## Validation

Unit tests cover private settings, account/project mapping, direct-upload preview, rollback validation, tracker attribution, offer separation, cross-origin rejection, idempotent clicks, and that the tracker endpoints do not expose private reports. A successful Cloudflare identity/list call proves only the operation tested; GitHub contents write and Cloudflare Pages Edit must be exercised before claiming end-to-end write access.
