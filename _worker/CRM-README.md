# Private CRM API — implementation status

## Live database facts
See `_diag/d1-live-audit-2026-10-27.md`. The only D1 visible in the account is `nasr-market-db`; it is shared by the agent, property-sync, and valuation Workers. Do not alter or repurpose existing market/valuation tables. The CRM migration creates only `crm_*` tables and has not been applied.

## Draft components
- `migrations/0001_crm_opportunities.sql`: additive tables for normalized contacts, multiple opportunities, activity history, linked listings, and idempotent submissions.
- `crm-worker.js`: private API draft with strict JSON bounds, parameterized SQL, Egyptian phone normalization, duplicate-name conflict review, idempotency keys, explicit next-step validation, listing source/area filter, and dashboard queries.
- `wrangler.crm.toml`: a separate Worker configuration binding the existing D1; it has no production route.

## Authentication boundary (fail closed)
The API does not accept a password or API key from browser code. It requires a Cloudflare Access signed JWT and verifies signature, issuer, audience, expiry, and one exact configured administrator email. Missing `ACCESS_TEAM_DOMAIN`, `ACCESS_AUD`, `ADMIN_EMAIL`, or D1 binding returns `503 auth_not_configured`. A configured but missing/invalid JWT returns `401`. CORS allows only `https://nasr-realestate.github.io`; no customer data is returned by `/health`.

Before any deployment, configure and verify a Cloudflare Access application on a custom hostname for this API, with an allow policy for the owner only; obtain that hostname and Access application audience, set the Worker variables, test the browser Access flow and CORS/preflight, and confirm HTTPS cookies/JWT injection. The live account's Access app inventory and custom domains have **not** yet been verified. Do not expose the Worker on an unprotected hostname or deploy this API until those checks pass.

## Draft endpoints
- `GET /health` — static service status only.
- `GET /api/dashboard?day=YYYY-MM-DD` — due today, overdue, stale seven-day, missing next-step, scheduled viewings, outcomes.
- `GET /api/opportunities` and `GET /api/opportunities/{id}` — authenticated records and activity/property history.
- `POST /api/opportunities` — authenticated create; `Idempotency-Key` required; duplicate phone with conflicting saved name returns review conflict instead of silently merging.
- `POST /api/opportunities/{id}/activities` — activity/result and next-step update; `POST /api/opportunities/{id}/properties` appends each property presentation/viewing/offer event so repeated offers and price changes are retained.
- `GET /api/listings` and `POST /api/opportunities/{id}/properties` — only site-owned `source_id=9` listings with `area_id` in the 31 live-audited City of Nasr City areas; live area inventory currently contains City of Nasr City only.

The website currently has WhatsApp links rather than a server-side lead form. This draft does not claim automatic WhatsApp/call ingestion or connect the live phone/client interface.

## Testing and release controls
`node --test scripts/tests/crm-schema.test.mjs _worker/tests/crm-worker.test.mjs` tests the migration against an in-memory SQLite fixture and exercises authentication, phone normalization, duplicate review, and endpoint validation with synthetic data. It does not touch Cloudflare. No production database write, migration, Worker deployment, secret change, route change, or Access policy change has occurred.
