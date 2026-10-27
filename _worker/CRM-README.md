# Private CRM API — local draft / isolated-test plan

## Safety boundary
The merged draft has not been deployed and its migration has not been applied. The audited account had one D1, `nasr-market-db`, shared by the property, sync, and valuation Workers. Do not bind this CRM Worker to that production D1 or modify its tables. `_worker/wrangler.crm.toml` is now deliberately test-only: it names `nasr-crm-api-test` and `nasr-crm-test-db`, disables the default `workers.dev` route, and contains an all-zero placeholder D1 ID that must be replaced only after a dedicated test database exists. It is not a deployable production configuration.

## Data model
- `crm_contacts` represents a person/customer, not a phone number. A customer can exist without a phone and can have multiple phone methods.
- `crm_contact_phones` stores normalized unique numbers, labels, and one optional primary number. A number already attached to a different name/customer returns a review conflict; the API does not silently merge records.
- A customer can have multiple `crm_opportunities`; each opportunity has its own activity history and property-presentation/viewing/offer history.
- Communication consent is tracked separately and defaults to `request_only`; no automated call, WhatsApp, or bulk messaging is implemented.
- `crm_opportunity_properties.listing_id` references the existing listings table. Only site-owned `source_id=9` listings in the audited Nasr City area set are eligible.
- All CRM tables are additive. The migration does not alter property, valuation, listing, or sync tables.

## Atomic writes and API
`POST /api/opportunities` writes a new customer (when needed), phone method (when needed), opportunity, idempotency receipt, and initial activity in one D1 batch. D1 batch failure rolls back the entire write. Existing customer/phone resolution occurs before the batch; uniqueness races are returned as review/retry conflicts, not automatic merges.

- `GET /health` — static status only; it returns no customer data.
- `GET /api/contacts?q=...` — authenticated contact search and phone summary.
- `POST /api/contacts` — authenticated customer registration, optional phone, required `Idempotency-Key`.
- `POST /api/contacts/{id}/phones` — attach another number to a customer.
- `GET /api/dashboard?day=YYYY-MM-DD`, `/api/opportunities`, `/api/opportunities/{id}` — authenticated CRM views.
- `POST /api/opportunities` — authenticated opportunity creation; requires `Idempotency-Key`, a phone or existing `contact_id`, intent/source, and a next step or explicit no-follow-up reason for active work.
- `POST /api/opportunities/{id}/activities` — add an activity/result and update status/follow-up.
- `GET /api/listings` and `POST /api/opportunities/{id}/properties` — search and record site-owned Nasr City listings only.

## Private Arabic UI (local draft only)
`_worker/crm-ui/crm.html` and `_worker/crm-ui/crm-assets/` implement the Arabic, responsive CRM screen; `_worker/crm-ui/crm-client.js` is its same-origin API layer. Wrangler binds this folder as `ASSETS`, and the Worker serves assets only after the same fail-closed Access JWT validation as the API. The UI supports manual multi-phone customer entry, customer/opportunity search and profiles, follow-up activities, and linking only listings returned by the authorized listings API. It uses no localStorage, phonebook import, or browser-side credentials. It is not deployed, and no Cloudflare Access configuration has been tested.

## Access and CORS configuration — no defaults assumed
The Worker fails closed unless all are explicitly configured:
- `ACCESS_TEAM_DOMAIN`: exact Cloudflare Access team issuer hostname (host only; code constructs the HTTPS issuer).
- `ACCESS_AUD`: audience tag from the specific Access application; it is not guessed or shared between test and production.
- `ADMIN_EMAIL`: the single owner email expected in the verified JWT; no email value is embedded in the Worker.
- `CRM_ALLOWED_ORIGIN`: exact HTTPS origin of the actual CRM UI, with no path or trailing slash; no GitHub Pages or custom domain is assumed. Preflight is allowed only for this origin, with credentials, GET/POST, and the required headers.
- `CRM_SITE_SOURCE_ID` and `CRM_NASR_AREA_IDS`: positive integer source ID and comma-separated verified area IDs for the selected site inventory. Both are required and strictly parsed; the prior audit observed source ID 9 and area IDs 1–31, but those values must be reconfirmed for the isolated fixture/account and must not be treated as permanent production config.

The Worker validates JWT RS256 signature via the configured team JWKS, issuer, audience, expiry/not-before, and exact email. The Access app itself must require the owner identity and deny everyone else; application-level JWT checks are defense in depth. No password/API key is placed in browser code. The origin and API hostname relationship, cookie behavior, JWT injection, and CORS must be tested in a real browser on the eventual test hostname. Do not attach the test app to a production or unowned hostname.

The detailed resource, hostname, permission, setup sequence, verification, and rollback proposal is in `_worker/CRM-TEST-PLAN.md`.

## Proposed isolated test resources (not created)
- D1: `nasr-crm-test-db`, in the same Cloudflare account only if that account is approved, with synthetic rows only. It must not be shared with any existing Worker. Seed the minimum compatible `areas`, `sources`, and `listings` fixture schema/data needed to test CRM listing links; do not copy production customer/listing rows.
- Worker: `nasr-crm-api-test`, bound only to `nasr-crm-test-db`, with no `workers.dev` route and no production route/binding.
- Access application: `nasr-crm-test-access`, self-hosted application restricted to the owner email only, with its own AUD and a verified test hostname.
- Hostname: use only a domain/subdomain the owner confirms they control and that is available for Cloudflare Access. If no such domain is already configured in Cloudflare DNS, stop and have the owner choose/provision a suitable domain or another supported private route; do not infer one from the GitHub Pages URL. The GitHub Pages hostname is not presumed to be under this Cloudflare account's DNS control.
- UI origin: the owner must choose its final HTTPS origin; set that exact value in `CRM_ALLOWED_ORIGIN`, then verify allowlisted preflight and denied untrusted origin from a browser.

## Required isolated verification before any production consideration
1. Confirm no test resource shares a production D1 binding or route; record resource IDs and owner-approved hostname.
2. Apply the migration only to the new D1 after loading synthetic baseline listing schema. Inspect tables/indexes and verify pre-existing test listing fixture definitions are unchanged.
3. Run Worker integration tests against the test binding: contact creation, multiple phones/opportunities, atomic rollback on injected opportunity failure, follow-up/activity/property links, idempotency, and synthetic listing scope.
4. Verify no Access identity gets data without owner authorization; test wrong email/AUD/issuer/expired JWT and missing configuration fail closed.
5. Test browser Access login, JWT assertion, credentials, successful preflight from the selected UI origin, and 403 from an untrusted origin. Local unit mocks are not a substitute for these checks.
6. Capture rollback steps for the test Worker and test D1. None of these steps authorizes a production migration/deployment.

## Permissions needed later — not requested or used now
No Cloudflare write permissions were used or changed. Later, if separately approved, use a distinct short-lived credential (or owner-operated dashboard actions) with only these Cloudflare permission labels and narrowest supported scopes:
- `Account / D1 / Edit` and `Account / D1 / Read` on `nasr-crm-test-db` only (account scope only if unavoidable for database creation; pause for owner approval if broader scope is required).
- `Account / Workers Scripts / Edit` and `/ Read` on `nasr-crm-api-test` only.
- `Account / Workers Routes / Edit` and `/ Read` only if required for the approved test hostname route.
- `Account / Access: Apps and Policies / Edit` and `/ Read` only as narrowly as the account allows to configure/verify `nasr-crm-test-access`.
- `Zone / DNS / Edit` and `/ Read` only on the owner-approved test zone and only if needed to provision/verify the hostname.
- Pages permissions are not required because UI assets are served by the Worker; ask only if the owner later chooses a separate Pages project.

Verify labels and available resource scoping in the Cloudflare account UI before granting; do not add them to the current token or allow production write access. This list is planning, not an authorization or request for credentials. Never paste secret values in chat.

## Local testing
`node --test scripts/tests/crm-schema.test.mjs _worker/tests/crm-worker.test.mjs` runs schema constraints on in-memory SQLite and exercises the Worker through a local SQLite-backed D1 adapter with synthetic Access JWT/JWKS. It does not contact Cloudflare, prove real D1 batch semantics, prove Access configuration, or validate browser cookie/CORS behavior. Production migration, Worker deployment, route, Access, DNS, token permissions, and localStorage transfer remain out of scope.
