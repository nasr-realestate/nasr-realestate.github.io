# Private CRM API — implementation and isolated-test status

## Current verified Cloudflare state
- The GitHub Actions workflow read the nonempty secret `ARENA_CLOUDFLARE_TOKEN` by its exact name and passed it as a Bearer token; the value was not printed, logged, or committed. `GET /accounts` and account resource inventories succeeded. `GET /user/tokens/verify` returned HTTP 401/code 1000, while account-scoped verification reported active but returned no permission groups. The credential is accepted for account reads and was sufficient to create/migrate the isolated test D1; the 401 is specific to the user-token verification endpoint, not evidence that the secret was missing.
- D1 `nasr-crm-test-db` was created and migrated only with synthetic fixtures. UUID: `65bfcb14-4b48-423b-916f-00eefdb9ae1e`. Remote verification found six `crm_*` tables and two test-only listings.
- The latest GET-only Cloudflare preflight found: two D1s (`nasr-market-db` and the test D1), four existing Workers, zero Access applications, zero identity providers, and zero zones. `GET /accounts/{id}/workers/subdomain` returned 200, so the account has a configured `workers.dev` subdomain. The Access organization GET returned 403/code 10000; because the token's permission groups were not returned, this does not distinguish an unconfigured Zero Trust organization from missing read permission (preflight run [40598636959](https://github.com/nasr-realestate/nasr-realestate.github.io/actions/runs/40598636959)). No CRM Worker, Access app, route, DNS record, or production change has been made.
- **No custom domain is required in principle:** Cloudflare documents Worker-level Access that protects the Worker across all its hostnames, including `workers.dev`. No Access policy is currently confirmed active for CRM; the inventory does not prove that any CRM endpoint is protected. See the official [Workers Access guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) and [workers.dev guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/).
- `_worker/wrangler.crm.toml` remains test-only and binds only the test D1. Keep both `workers_dev = false` and `preview_urls = false` until Access is configured and verified for the isolated Worker; do not expose a route or preview first.

Do not bind the CRM Worker to `nasr-market-db` or change its tables.

## Data model
- `crm_contacts` represents a person/customer, not a phone number. A customer can exist without a phone and can have multiple phone methods.
- `crm_contact_phones` stores normalized unique numbers, labels, and one optional primary number. A number already attached to a different name/customer returns a review conflict; the API does not silently merge records.
- A customer can have multiple `crm_opportunities`; each opportunity has its own activity history and property-presentation/viewing/offer history.
- Communication consent is tracked separately and defaults to `request_only`; no automated call, WhatsApp, or bulk messaging is implemented.
- `crm_opportunity_properties.listing_id` references the existing listings table. Only site-owned `source_id=9` listings in the audited Nasr City area set are eligible.
- All CRM tables are additive. The migration does not alter property, valuation, listing, or sync tables.

## Atomic writes and API
`POST /api/opportunities` writes a new customer (when needed), phone method (when needed), opportunity, idempotency receipt, and initial activity in one D1 batch. The application is designed to use D1 batch atomicity, but remote fault-injection/rollback behavior has not yet been verified against Cloudflare D1. Existing customer/phone resolution occurs before the batch; uniqueness races are returned as review/retry conflicts, not automatic merges.

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

The Worker validates JWT RS256 signature via the configured team JWKS, issuer, audience, expiry/not-before, and exact email. The Worker-level Access policy must require the owner identity and deny everyone else; application-level JWT checks are defense in depth. No password/API key is placed in browser code. The origin and API relationship, cookie behavior, JWT injection, and CORS must be tested in a real browser on the protected test `workers.dev` URL. Do not attach Access to a production Worker or bypass the Access policy.

The detailed Worker-level Access sequence, resource scopes, verification, and rollback plan is in `_worker/CRM-TEST-PLAN.md`.

## Remaining isolated test resources
- D1 `nasr-crm-test-db` exists with only the synthetic dependency schema, two labeled test listing fixtures, and the CRM migration. It is not bound to any deployed CRM Worker.
- Worker `nasr-crm-api-test` has not been created/deployed. It can use the account's existing `workers.dev` subdomain; a custom domain or zone is not required by Cloudflare's Worker-level Access flow. Keep `workers_dev = false` until Access is applied and verified, then expose only the test Worker under Access.
- Access application `nasr-crm-test-access` has not been created. The live read-only inventory found zero Access apps and zero identity providers; Access organization status is unresolved because its GET returned 403.
- No custom hostname or DNS input is needed if the test Worker itself is protected. A single authorized owner identity is still required for the allow policy and real login test. Do not infer that identity from the Cloudflare API token or account name. `CRM_ALLOWED_ORIGIN` should be set to the exact `workers.dev` origin of the protected test Worker/UI.

## Required isolated verification before any production consideration
1. Confirm no test resource shares a production D1 binding or route; record resource IDs and the exact `workers.dev` origin after the Access-first route is enabled.
2. Apply the migration only to the new D1 after loading synthetic baseline listing schema. Inspect tables/indexes and verify pre-existing test listing fixture definitions are unchanged.
3. Run Worker integration tests against the test binding: contact creation, multiple phones/opportunities, atomic rollback on injected opportunity failure, follow-up/activity/property links, idempotency, and synthetic listing scope.
4. Verify no Access identity gets data without owner authorization; test wrong email/AUD/issuer/expired JWT and missing configuration fail closed.
5. Test browser Access login, JWT assertion, credentials, successful preflight from the selected UI origin, and 403 from an untrusted origin. Local unit mocks are not a substitute for these checks.
6. Capture rollback steps for the test Worker and test D1. None of these steps authorizes a production migration/deployment.

## Permissions and resource scope
The existing secret was used only by the read-only inventory and the isolated `nasr-crm-test-db` creation/migration workflow. Those D1 operations succeeded, demonstrating the D1 write capability needed for that test database. Cloudflare returned no permission-group list, so no other capability is assumed. Worker, Access, route, and DNS write permissions have not been tested or used.

If later setup requires them, use the narrowest supported scopes and do not alter production resources:
- `Account / D1 / Edit` and `Account / D1 / Read` were exercised on the isolated test D1; do not use them against `nasr-market-db`.
- `Account / Workers Scripts / Edit` and `/ Read` on `nasr-crm-api-test` only.
- `Account / Access: Apps and Policies / Edit` and `/ Read` only as narrowly as the account allows to configure/verify `nasr-crm-test-access`.
- Workers Routes and Zone DNS permissions are not needed for this `workers.dev` plan; keep the default route disabled until Worker-level Access is confirmed.
- Pages permissions are not required because UI assets are served by the Worker; ask only if the owner later chooses a separate Pages project.

Verify labels and available resource scoping in the Cloudflare account UI before granting; do not add them to the current token or allow production write access. This list is planning, not an authorization or request for credentials. Never paste secret values in chat.

## Local testing
`node --test scripts/tests/crm-schema.test.mjs _worker/tests/crm-worker.test.mjs` runs schema constraints on in-memory SQLite and exercises the Worker through a local SQLite-backed D1 adapter with synthetic Access JWT/JWKS. It does not contact Cloudflare, prove real D1 batch semantics, prove Access configuration, or validate browser cookie/CORS behavior. Production migration, Worker deployment, route, Access, DNS, token permissions, and localStorage transfer remain out of scope.
