# CRM isolated Cloudflare test plan and execution status

**Status:** A real Cloudflare read-only inventory and isolated D1 test were executed. `nasr-crm-test-db` exists (UUID `65bfcb14-4b48-423b-916f-00eefdb9ae1e`); synthetic base tables/fixtures were created, the CRM migration was applied, and a remote query verified six CRM tables plus two synthetic listings. `nasr-market-db` was not modified. No CRM Worker, Access app, route, DNS record, or production data was created or changed. Cloudflare officially supports Worker-level Access on `workers.dev`, so a custom domain/zone is not needed. This account's `workers.dev` subdomain is configured, but Access apps/IdPs inventory is empty and organization GET returned 403/code 10000 (setup-vs-read-permission unresolved; see [GET-only preflight run](https://github.com/nasr-realestate/nasr-realestate.github.io/actions/runs/40598636959)); Worker/browser tests remain blocked until the account's Zero Trust setup and owner identity are confirmed.

## Test resources and hostname

| Resource | Test name | Isolation boundary |
|---|---|---|
| D1 | `nasr-crm-test-db` (created; UUID `65bfcb14-4b48-423b-916f-00eefdb9ae1e`) | Never use `nasr-market-db` or any production Worker binding |
| Worker | `nasr-crm-api-test` | No production script, route, or binding |
| Access app | `nasr-crm-test-access` | Owner-only policy; no production audiences/policies |
| UI | Served by the same test Worker | No production Pages/localStorage |
| Hostname | `<worker>.<account-subdomain>.workers.dev` | Enable only after Access is applied to that Worker |

**A custom domain or Cloudflare Zone is not required for the intended setup.** Cloudflare's [Workers Access guide](https://developers.cloudflare.com/workers/configuration/cloudflare-access/) documents protecting one Worker across its `workers.dev` URL; the [workers.dev guide](https://developers.cloudflare.com/workers/configuration/routing/workers-dev/) confirms that Access can require sign-in. Enabling the worker's `workers.dev` route while Access is not yet applied would make it public, so retain `workers_dev = false` until the Access-first sequence is verified. Cloudflare requires a Zero Trust organization, which was not established by this inventory: the organization GET returned 403/code 10000 (the current token's permission groups were not returned, so setup-vs-read-denial remains unresolved; see [GET-only preflight run](https://github.com/nasr-realestate/nasr-realestate.github.io/actions/runs/40598636959)). The `workers.dev` subdomain GET returned 200; its value is intentionally not copied into this plan.

Prefer one same-origin `workers.dev` URL for the UI and API, which avoids cross-origin Access-cookie/CORS complexity. The current local draft serves `_worker/crm-ui/` through the Worker `ASSETS` binding after the same Access JWT verification as API routes. Set `CRM_ALLOWED_ORIGIN` to the exact protected Worker origin. If the UI moves to a separate origin, protect it independently and test cross-origin Access/CORS in a real browser.

### Exact remaining account setup
1. In the existing Cloudflare account, open **Zero Trust** and complete or verify organization onboarding. This chooses a Cloudflare team identifier (`<team>.cloudflareaccess.com`), not a user-owned DNS domain. Cloudflare's [Zero Trust setup guide](https://developers.cloudflare.com/cloudflare-one/setup/) says the Free plan is $0 but still asks for billing details at onboarding; users choosing Free are not charged. Current [Cloudflare Zero Trust pricing](https://www.cloudflare.com/plans/sase-zero-trust/) lists Free for up to 50 users.
2. Confirm the single owner email that must be allowed and ensure that identity can authenticate with the selected provider (Cloudflare account login or configured one-time PIN). Do not authorize an entire domain or all account members unless that broader set is explicitly approved.
3. Deploy `nasr-crm-api-test` with `workers_dev=false` and `preview_urls=false`, test D1 only, and no route. In **Workers & Pages → nasr-crm-api-test → Access**, protect the Worker across **all traffic** (not previews-only) using an allow policy for the exact owner identity; leave everyone else denied.
4. Verify the Worker-level Access application/policy, its AUD, and issuer, and test that no request reaches CRM data without a valid owner session. Only after this gate passes, enable the Worker's `workers.dev` route while keeping `preview_urls=false`. Cloudflare's Worker-level Access is documented to protect the Worker across its `workers.dev` URL and previews.
5. Test the exact public workers.dev URL with no session, an unauthorized identity, and the owner identity; then exercise CRM create/read flows using synthetic data only. Keep PR #113 open and do not deploy for real use until all live tests pass.

## Resource-by-resource requirements

### 1. D1: `nasr-crm-test-db`
- **Completed:** the read-only inventory found one existing D1, `nasr-market-db`, and no `nasr-crm-test-db`. A new D1 named `nasr-crm-test-db` was created with UUID `65bfcb14-4b48-423b-916f-00eefdb9ae1e`. It was not bound to any existing Worker; no production D1 was used.
- Synthetic baseline only (never copy live rows): create `areas`, `sources`, and the lookup columns of `listings`, then seed reserved test IDs. For example:

```sql
CREATE TABLE areas(id INTEGER PRIMARY KEY, name_ar TEXT NOT NULL);
CREATE TABLE sources(id INTEGER PRIMARY KEY, name TEXT NOT NULL);
CREATE TABLE listings(
  id INTEGER PRIMARY KEY, source_id INTEGER, external_id TEXT, url TEXT,
  title TEXT, property_type TEXT, transaction_type TEXT, area_id INTEGER,
  area_m2 REAL, price REAL, bedrooms INTEGER, bathrooms INTEGER,
  finishing TEXT, observed_at TEXT,
  FOREIGN KEY(source_id) REFERENCES sources(id),
  FOREIGN KEY(area_id) REFERENCES areas(id)
);
INSERT INTO areas(id,name_ar) VALUES
  (90001,'TEST ONLY Nasr City'), (99999,'TEST ONLY out of scope');
INSERT INTO sources(id,name) VALUES(9009,'TEST ONLY synthetic CRM source');
INSERT INTO listings(id,source_id,external_id,url,title,property_type,transaction_type,area_id,area_m2,price,observed_at)
VALUES
  (900001,9009,'crm-test-only-inside','/test-only/inside','TEST ONLY — synthetic listing','test','sale',90001,NULL,NULL,'2026-10-28'),
  (900002,9009,'crm-test-only-outside','/test-only/outside','TEST ONLY — out-of-scope listing','test','sale',99999,NULL,NULL,'2026-10-28');
```

  Configure `CRM_SITE_SOURCE_ID=9009` and `CRM_NASR_AREA_IDS=90001` for this fixture. These are test-only IDs and must not be confused with the prior production audit values.
- **Completed on real Cloudflare D1:** created only the baseline `areas`, `sources`, and `listings` schema, inserted two clearly labeled synthetic rows with no fabricated price/area values, applied `_worker/migrations/0001_crm_opportunities.sql`, then ran a remote verification query. It returned the expected six `crm_*` tables and two synthetic listings. No live CRM customer/listing rows were copied.
- `_worker/wrangler.crm.toml` now records the exact test D1 UUID. It binds only `nasr-crm-test-db`; `workers_dev=false`, and no route is configured. The test database has not yet been bound to any Worker.
- **Permission evidence:** the supplied token successfully created this D1 and applied its migration (D1 write capability demonstrated operationally). Cloudflare's account token verification response returned no permission-group list, so no broader permission set is inferred. No Worker Scripts, Access Apps/Policies, DNS, or route write permission has been tested or used. Never grant write access to `nasr-market-db`.

### 2. Worker: `nasr-crm-api-test`
- Bind `DB` only to `nasr-crm-test-db`. Initially deploy with `workers_dev = false` and no route. Cloudflare's Worker-level Access can protect the Worker across its `workers.dev` hostname, so no custom zone/hostname is required.
- Create/apply the Worker-level Access allow policy before enabling `workers.dev`; verify the Access app targets this Worker and only this Worker. Only then may `workers_dev = true` be enabled for the test service. Never expose the test route before Access is active.
- Configure these explicit test settings after creating the Access app and synthetic listing fixture:
  - `ACCESS_TEAM_DOMAIN`: verified team issuer hostname (host only).
  - `ACCESS_AUD`: audience copied from this test Access application, never guessed or reused from production.
  - `ADMIN_EMAIL`: the exact owner email confirmed by the owner and used by the Access policy.
  - `CRM_ALLOWED_ORIGIN`: exact HTTPS origin of the eventual UI, no path, wildcard, or trailing slash.
  - `CRM_SITE_SOURCE_ID`: positive synthetic source ID.
  - `CRM_NASR_AREA_IDS`: comma-separated synthetic area IDs, validated and checked against the test D1.
- All are absent from Wrangler config until the test setup is approved; the API fails closed without them.
- **Permission:** Workers Scripts Read/Edit for verifying and deploying only the test script; no Workers Routes or DNS permission is needed for the account's workers.dev subdomain. Do not grant permissions to edit existing production Workers or bindings.

### 3. Access: `nasr-crm-test-access`
- Create a Worker-level Access application for `nasr-crm-api-test` (Cloudflare API destination type `worker`, scoped by that Worker ID); this protects its `workers.dev` route and previews without a custom zone. Require an allow policy for exactly the owner-confirmed identity and deny everyone else. Do not use a broad email-domain or account-wide rule unless the owner explicitly confirms it is single-user.
- Obtain the AUD from the created test application and configure it only on the test Worker. Verify issuer/team hostname and JWT assertion at the Worker. The Worker itself also validates issuer, AUD, expiry, signature, and the exact configured email.
- If the UI uses a second hostname, protect it with an equivalent owner-only Access application/policy before browser testing; do not assume a policy on the API hostname protects another hostname.
- **Permission:** separate Access Apps and Policies Read/Edit on the approved account, only for creating and verifying the test app/policies. No production Access-app changes.

### 4. Hostname / DNS
- Use the account's existing Cloudflare-managed `workers.dev` subdomain for the test Worker, and enable its route only after Worker-level Access is verified. This requires no user-owned custom domain, Cloudflare Zone, DNS record, or DNS permission.
- Do not configure any route on `nasr-realestate.github.io`, production DNS, or an existing Worker.
- **Permission:** no DNS Read/Edit is needed for this plan. Workers Scripts and Access Apps/Policies permissions remain to be verified for the specific test resources.

### 5. UI: `_worker/crm-ui/` (local implementation; not deployed)
- The Arabic responsive interface is served as Worker assets on the same test hostname and falls behind the same Access JWT gate. Verify the Access application protects both `/crm.html`, `/crm-assets/*`, and `/api/*` paths. Static asset requests and API requests must return no customer data before authentication.
- If using a separate Cloudflare Pages project instead, request Pages Read/Edit scoped to that test project only, and separately protect its hostname. This permission is not needed for the Worker-hosted UI.
- Do not import, auto-transfer, or delete the existing localStorage tracker data. Any later transfer must be an explicit, user-initiated, validated export/import with a backup and no destructive cleanup.

## Test execution sequence (all test resources only)

1. **Completed, read-only:** inventory found one account, two D1s (`nasr-market-db` and the isolated test D1), four existing Workers, zero Access applications, zero Access identity providers, zero zones, and a configured `workers.dev` subdomain. The token's user verification route returned 401/code 1000; account-level token verification reported active but returned no permission groups. The Access organization GET returned 403/code 10000, so its configuration state cannot be distinguished from insufficient read permission (see [GET-only preflight run](https://github.com/nasr-realestate/nasr-realestate.github.io/actions/runs/40598636959)).
2. **Completed:** created only `nasr-crm-test-db`; seeded the synthetic dependency schema and two labeled fixtures, applied the CRM migration remotely, and verified six `crm_*` tables plus the two synthetic listings. Its UUID is recorded in the Wrangler test config. No existing Worker is bound to this newly created D1.
3. **Blocked pending owner prerequisite:** confirm the exact owner identity to allow and ensure the account's Zero Trust organization is enabled/accessible. No custom domain or zone is needed. Do not infer an identity from the Cloudflare token/account name. Current account inventory has no Access app or IdP; Access/Worker write capability has not been exercised.
4. **Not run:** after Zero Trust and the owner identity are confirmed, deploy the isolated Worker first with `workers_dev=false`, `preview_urls=false`, and test D1 only; configure Worker-level Access for that Worker, verify it, and only then enable its `workers.dev` route while leaving previews disabled. Set the six explicit config values above from verified test setup, never guesses or production defaults.
5. **Migration applied:** additional remote checks are still needed for foreign keys, unique primary-phone behavior, customer/phone separation, and baseline schema preservation.
6. Exercise Worker reads/writes using synthetic data: contact without phone; multiple phones per contact; multiple opportunities per contact; name/phone conflict review; idempotency; activities/follow-ups; synthetic Nasr City property links; outside-scope listing rejected.
7. **Not run on remote D1:** after a protected, isolated Worker is available, trigger a database error during opportunity insertion and verify customer, phone, opportunity, receipt, and activity counts are unchanged. Local SQLite tests cover application transaction logic only; they do not validate Cloudflare D1 behavior.
8. Verify Access with missing config, missing JWT, wrong issuer, wrong AUD, wrong email, expired token, and invalid signature. Confirm no authenticated data is returned to non-owner identities.
9. Test browser login on the approved hostname: Access challenge, JWT injection, cookie behavior, normal API request, successful CORS preflight from the exact configured UI origin, and rejection of an untrusted origin. A mocked/local JWT test does not replace this step.
10. Save test-only verification results and a rollback plan. Rollback may disable/delete only the test route, test Access app, test Worker, and test D1 as separately approved. Production D1/Worker/site/DNS remain untouched.

## Pass gates, failure gates, and safe stop

**Pass only if every item is evidenced:**
- Read-only inventory shows a unique test D1 UUID that is not `ace5c9a2-c6b1-47b3-adf1-77e84ac50abf`; the test Worker binding names that exact test database and no other Worker uses it.
- Test config starts with `workers_dev=false` and `preview_urls=false`, the exact test UUID, no production binding, and all six required settings sourced from the approved test Access app, same-origin UI, and synthetic fixture. If `workers_dev` is later enabled, Worker-level Access must already be active for all traffic and its owner-only policy verified; keep previews disabled.
- Migration creates the six expected CRM tables and indexes, preserves the synthetic base-table DDL, and all fixture/property scope checks pass.
- Synthetic write tests pass, including fault injection proving zero partial rows after opportunity failure; activity, follow-up, idempotency, contact/phone, and property-scope checks pass.
- Owner can access through the test Access challenge; a different identity is denied; the invalid JWT/config cases fail closed; browser CORS succeeds only for the exact approved origin.

**Stop immediately without retrying writes if:** the database UUID/name/binding differs, any production ID/route appears in test config, the owner identity or Zero Trust organization is unconfirmed, Access is bypassable or not active before enabling the workers.dev route, CORS allows an unapproved origin, the migration alters a baseline table, a test query returns non-synthetic data, or any transactional test leaves partial rows. Preserve logs without customer data; record the failing step. Do not attempt a production fallback.

**Safe rollback:** disable the test Worker's `workers.dev` route first, then disable the test Worker and its Access app as required. Keep the isolated test D1 for diagnosis until the owner approves disposal; if it must be reset, export only synthetic test state and recreate/drop only `nasr-crm-test-db`. Never use a down-migration or cleanup command against `nasr-market-db`. No production rollback action is part of this plan.

## Least-privilege permission summary

The existing secret was used without exposing its value. D1 creation and migration succeeded, proving the required D1 write operations are currently available. The account token verifier returned no permission-group list, so other write scopes remain unknown. Do not broaden this credential. If a specific later operation is denied, request only that operation's narrowly scoped permission after the hostname/Access prerequisites are resolved. Confirm exact labels and resource scope in the account UI before any such change.

| Cloudflare permission label | Scope | Why it may be needed |
|---|---|---|
| `Account / D1 / Edit` | Used for isolated `nasr-crm-test-db` create/migration operations; exact token scope metadata was not returned | D1 creation and migration succeeded; do not use against production D1. |
| `Account / D1 / Read` | Used to inventory and verify the isolated test D1; exact token scope metadata was not returned | Read-only inventory and remote schema/fixture checks succeeded. |
| `Account / Workers Scripts / Edit` | Only `nasr-crm-api-test` | Deploy with no route, then enable only the already Access-protected workers.dev route. |
| `Account / Workers Scripts / Read` | Only `nasr-crm-api-test` | Inspect deployed test Worker and verify configuration. |
| `Account / Access: Apps and Policies / Edit` | Only to the extent account UI permits; use only for `nasr-crm-test-access` | Create the isolated owner-only Worker Access app/policy. |
| `Account / Access: Apps and Policies / Read` | Same narrowest available scope | Verify app audience and policy without edits. |
| `Account / Access: Organizations / Read/Edit` | Only if needed to verify or initialize Zero Trust; current GET returned 403 and permission groups are unknown | Resolve the actual prerequisite/permission status; do not create a team organization or broaden scopes without the owner's confirmation. |

`Pages / Edit` is not needed because the UI is served from the test Worker; request Pages permissions only if the owner later chooses a separate Pages project. Resource-level scoping varies by permission and account, so verify available scope controls before granting. If Cloudflare only offers broader scope for a necessary operation, pause for explicit owner approval rather than granting it. These names are a later planning reference, not authorization or a request for credentials. Never grant production D1/Worker/route/zone write access or expose credential values in chat.
