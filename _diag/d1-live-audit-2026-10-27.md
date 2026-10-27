# Cloudflare D1 live audit — 2026-10-27

## Access and method
The repository Actions secret `ARENA_CLOUDFLARE_TOKEN` was consumed only by a manually/scoped-triggered audit job. It performed account inventory GET requests and one `SELECT` from `sqlite_schema`; it did not select customer rows or issue DDL/DML. The schema/inventory report was encrypted with an ephemeral RSA-3072 public key and AES-256-GCM before leaving the runner; plaintext was decrypted only in the agent workspace. The ephemeral private key was not committed. The workflow run succeeded: [40576408509](https://github.com/nasr-realestate/nasr-realestate.github.io/actions/runs/40576408509).

## Verified live account state
- D1 databases visible to the account: **one**, `nasr-market-db`, UUID `ace5c9a2-c6b1-47b3-adf1-77e84ac50abf`.
- Workers visible: `royal-snow-ea32`, `nasr-properties-sync`, `noisy-bush-fd84`, `nasr-ai-gateway`.
- Live D1 bindings: `royal-snow-ea32`, `nasr-properties-sync`, and `noisy-bush-fd84` all bind `DB` to `nasr-market-db`; `nasr-ai-gateway` has no bindings.
- `nasr-properties-sync` live schedule: `17 * * * *` (hourly at minute 17).
- The live valuation Worker compatibility date was `2026-09-27`, while `_worker/wrangler.valuation.toml` records `2026-09-01`. No deployment was attempted; preserve this difference until its source is understood.
- `areas` contains 31 rows: one City of Nasr City row (`id=1`) plus neighborhood/zone/corridor rows. No other city appeared in the live `areas` inventory.
- Binding names/types and D1 object definitions only were audited. No secret binding values or customer records were requested or recorded.

## Live D1 schema objects (22)
Application tables: `areas`, `area_streets`, `demand_signals`, `ingestion_runs`, `landmarks`, `listing_location_evidence`, `listings`, `price_snapshots`, `properties_sync_state`, `sources`, `streets`.
SQLite-managed objects: `_cf_KV`, `sqlite_sequence`, and associated/unique indexes. No CRM/contact/opportunity table exists in the live schema.

Foreign key relationships verified in table definitions:
- `area_streets.area_id → areas.id`; `area_streets.street_id → streets.id`.
- `streets.area_id → areas.id`.
- `landmarks.area_id → areas.id`, `landmarks.street_id → streets.id`, `landmarks.source_id → sources.id`.
- `listings.source_id → sources.id`; `listings.area_id → areas.id` (the live table also has `street_id`, but its DDL does not declare a foreign key for it).
- `listing_location_evidence.listing_id → listings.id`, plus its area/street/source references.
- `price_snapshots.area_id → areas.id`.
- `ingestion_runs.source_id → sources.id`.
- `properties_sync_state` has a composite primary key `(source_id, external_id)`; its DDL does not declare a foreign key.

## Safety conclusion
The existing `listings` and valuation inputs (`price_snapshots`, `areas`, and related evidence) are shared production data used by Workers. Do not repurpose or alter them for CRM. The safe data design is additive `crm_*` tables, with `crm_opportunity_properties.listing_id` referencing the existing `listings.id`; test migration locally and in a separate D1 before any production application.

A local additive migration (`_worker/migrations/0001_crm_opportunities.sql`), fail-closed Access-JWT Worker draft (`_worker/crm-worker.js`) and local SQLite/API tests are present on the active Arena branch. The migration is tested against a SQLite fixture based on the live DDL but has not been applied. No production D1 write, Worker deployment, Access configuration change, or API route change has occurred. The existing opportunity page remains browser-local storage only. A centralized UI cannot be enabled until a Cloudflare Access application/custom hostname is confirmed and authenticated browser flow is tested.
