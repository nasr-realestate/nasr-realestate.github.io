# CRM isolated Cloudflare test plan — proposal only

**Status:** planning document only. No resource, route, DNS record, Access app, permission, secret, or production data was created or changed in this phase. Do not execute the Cloudflare steps without explicit owner authorization.

## Proposed names and hostname

| Resource | Proposed name | Must be isolated from |
|---|---|---|
| D1 | `nasr-crm-test-db` | `nasr-market-db` and every production Worker binding |
| Worker | `nasr-crm-api-test` | all production scripts/routes/bindings |
| Access app | `nasr-crm-test-access` | production audiences and policies |
| UI (future) | `nasr-crm-test-ui` or UI served by the test Worker | production pages and localStorage |
| Hostname | `crm-test.<owner-confirmed-domain>` | GitHub Pages hostname unless its DNS ownership/control is independently proven |

`<owner-confirmed-domain>` is intentionally a placeholder, not a domain assumption. The owner must select a domain/subdomain they control and confirm that its zone is active in the intended Cloudflare account. If there is no such zone, stop and decide on a supported private hostname/hosting pattern first. Do not use the production website hostname or production DNS as a shortcut.

Prefer one same-origin private hostname for the UI and API to avoid third-party Access-cookie/CORS complexity. The current local draft serves `_worker/crm-ui/` through the Worker `ASSETS` binding after the same Access JWT verification as API routes; the test Wrangler config uses that layout. If the final UI is moved to a separate hostname, protect that UI with owner-only Access too, set `CRM_ALLOWED_ORIGIN` to the exact UI origin, and test the cross-origin Access flow in a real browser.

## Resource-by-resource requirements

### 1. D1: `nasr-crm-test-db`
- Create a new D1 in the approved account. Do not clone production rows or bind the CRM Worker to `nasr-market-db`.
- Before creation, use the Cloudflare D1 inventory read-only and record the production database UUID (`ace5c9a2-c6b1-47b3-adf1-77e84ac50abf`) and all existing bindings. After creation, record the new test UUID and require it to be different from the production UUID. Confirm `nasr-crm-test-db` is not bound to any existing Worker; configure only `nasr-crm-api-test` to use it. Stop on any mismatch.
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
  (90001,'مدينة نصر - اختبار'), (99999,'منطقة خارج النطاق - اختبار');
INSERT INTO sources(id,name) VALUES(9009,'مصدر CRM اصطناعي');
INSERT INTO listings(id,source_id,external_id,url,title,property_type,transaction_type,area_id,area_m2,price,observed_at)
VALUES
  (900001,9009,'crm-test-inside','/test/inside','عقار اختبار داخل النطاق','apartment','sale',90001,100,1000000,'2026-10-28'),
  (900002,9009,'crm-test-outside','/test/outside','عقار اختبار خارج النطاق','apartment','sale',99999,100,1000000,'2026-10-28');
```

  Configure `CRM_SITE_SOURCE_ID=9009` and `CRM_NASR_AREA_IDS=90001` for this fixture. These are test-only IDs and must not be confused with the prior production audit values.
- Apply `_worker/migrations/0001_crm_opportunities.sql` only after the test base schema exists. Compare baseline DDL before/after; expect six `crm_*` tables plus CRM indexes, with unchanged baseline tables.
- Record the new D1 ID in the test-only Wrangler config after it has been created; the checked-in all-zero ID is deliberately unusable and is not a credential. Before every remote operation, verify both `database_name = "nasr-crm-test-db"` and that the configured UUID equals the recorded test UUID and differs from production.
- Future operator sequence (not run now): read-only D1 inventory; create the test D1; capture its returned UUID; update only the placeholder in the test config; re-run the read-only inventory and binding check; then run `wrangler d1 info nasr-crm-test-db --remote --config _worker/wrangler.crm.toml` and inspect the reported UUID before any DDL. Apply using `wrangler d1 migrations apply nasr-crm-test-db --remote --config _worker/wrangler.crm.toml` only after the prechecks pass. If any command resolves to the production name/UUID, stop without applying.
- **Permission:** a separate credential with D1 Read and D1 Edit, scoped to the approved account and preferably the test database resource. Account-level D1 Edit may be needed only to create the new database; after creation, narrow access to the test D1 where possible. D1 Edit is needed to apply the test migration; Read is for schema and verification. Do not give this credential write access to `nasr-market-db`.

### 2. Worker: `nasr-crm-api-test`
- Bind `DB` only to `nasr-crm-test-db`. Keep `workers_dev = false`; do not create a `workers.dev` public route or any production route.
- Use only a hostname the owner approves. Configure the hostname route/custom domain only after the owner-only Access policy is ready. Verify the route resolves to the test Worker and not any production service.
- Configure these explicit test settings after creating the Access app and synthetic listing fixture:
  - `ACCESS_TEAM_DOMAIN`: verified team issuer hostname (host only).
  - `ACCESS_AUD`: audience copied from this test Access application, never guessed or reused from production.
  - `ADMIN_EMAIL`: the exact owner email confirmed by the owner and used by the Access policy.
  - `CRM_ALLOWED_ORIGIN`: exact HTTPS origin of the eventual UI, no path, wildcard, or trailing slash.
  - `CRM_SITE_SOURCE_ID`: positive synthetic source ID.
  - `CRM_NASR_AREA_IDS`: comma-separated synthetic area IDs, validated and checked against the test D1.
- All are absent from Wrangler config until the test setup is approved; the API fails closed without them.
- **Permission:** separate Workers Scripts Read/Edit for verifying and deploying the test script; Workers Routes Edit only if a hostname route must be configured; scope route permission to the test zone/route where available. Do not grant permissions to edit existing production Workers or bindings.

### 3. Access: `nasr-crm-test-access`
- Create a self-hosted Access application for the exact approved test hostname. Require the owner’s chosen identity provider and an allow policy for exactly the confirmed owner email; deny everyone else. Do not use a broad email-domain rule.
- Obtain the AUD from the created test application and configure it only on the test Worker. Verify issuer/team hostname and JWT assertion at the Worker.
- If the UI uses a second hostname, protect it with an equivalent owner-only Access application/policy before browser testing; do not assume a policy on the API hostname protects another hostname.
- **Permission:** separate Access Apps and Policies Read/Edit on the approved account, only for creating and verifying the test app/policies. No production Access-app changes.

### 4. DNS / hostname
- Use only a zone that the owner confirms is controlled in the approved Cloudflare account. A GitHub Pages hostname is not presumed to be a Cloudflare-controlled zone.
- Add only the single test hostname/route needed after Access policy design is verified. No production zone or DNS changes.
- **Permission:** Zone DNS Read/Edit only on the specifically approved test zone, and only if creating/verifying that hostname requires DNS changes. If DNS is already correctly configured, do not request DNS Edit.

### 5. UI: `_worker/crm-ui/` (local implementation; not deployed)
- The Arabic responsive interface is served as Worker assets on the same test hostname and falls behind the same Access JWT gate. Verify the Access application protects both `/crm.html`, `/crm-assets/*`, and `/api/*` paths. Static asset requests and API requests must return no customer data before authentication.
- If using a separate Cloudflare Pages project instead, request Pages Read/Edit scoped to that test project only, and separately protect its hostname. This permission is not needed for the Worker-hosted UI.
- Do not import, auto-transfer, or delete the existing localStorage tracker data. Any later transfer must be an explicit, user-initiated, validated export/import with a backup and no destructive cleanup.

## Test execution sequence (all test resources only)

1. Owner confirms account, controlled test zone/hostname, exact owner email, UI hosting choice, and approves the isolated resources/permission scopes. If any item is unknown, pause.
2. Create `nasr-crm-test-db`; seed synthetic dependency schema/rows and record its ID. Confirm it is not bound to any other Worker.
3. Create `nasr-crm-test-access`, configure owner-only allow/deny policy for the approved hostname, and record issuer hostname and AUD. Confirm access for the owner and denial for a second/non-owner identity.
4. Set up the isolated Worker with `workers_dev=false`, test D1 binding, and no production routes. Attach the test hostname only after Access is in place. Set the six explicit config values above, sourced from verified test setup (not from guesses or old production defaults).
5. Apply the migration to the test D1 only. Verify additive schema, foreign keys, unique primary-phone rule, customer/phone separation, and no changes to seeded non-CRM tables.
6. Exercise Worker reads/writes using synthetic data: contact without phone; multiple phones per contact; multiple opportunities per contact; name/phone conflict review; idempotency; activities/follow-ups; synthetic Nasr City property links; outside-scope listing rejected.
7. Trigger a database error during opportunity insertion and verify that customer, phone, opportunity, receipt, and activity counts are all unchanged (the existing local SQLite test covers transaction behavior; the remote test validates Cloudflare D1 behavior).
8. Verify Access with missing config, missing JWT, wrong issuer, wrong AUD, wrong email, expired token, and invalid signature. Confirm no authenticated data is returned to non-owner identities.
9. Test browser login on the approved hostname: Access challenge, JWT injection, cookie behavior, normal API request, successful CORS preflight from the exact configured UI origin, and rejection of an untrusted origin. A mocked/local JWT test does not replace this step.
10. Save test-only verification results and a rollback plan. Rollback may disable/delete only the test route, test Access app, test Worker, and test D1 as separately approved. Production D1/Worker/site/DNS remain untouched.

## Pass gates, failure gates, and safe stop

**Pass only if every item is evidenced:**
- Read-only inventory shows a unique test D1 UUID that is not `ace5c9a2-c6b1-47b3-adf1-77e84ac50abf`; the test Worker binding names that exact test database and no other Worker uses it.
- Test config has `workers_dev=false`, the exact test UUID, no production route, and all six required settings sourced from the approved test Access app, UI origin, and synthetic fixture.
- Migration creates the six expected CRM tables and indexes, preserves the synthetic base-table DDL, and all fixture/property scope checks pass.
- Synthetic write tests pass, including fault injection proving zero partial rows after opportunity failure; activity, follow-up, idempotency, contact/phone, and property-scope checks pass.
- Owner can access through the test Access challenge; a different identity is denied; the invalid JWT/config cases fail closed; browser CORS succeeds only for the exact approved origin.

**Stop immediately without retrying writes if:** the database UUID/name/binding differs, any production ID/route appears in test config, the domain or owner identity is unconfirmed, Access is bypassable, CORS allows an unapproved origin, the migration alters a baseline table, a test query returns non-synthetic data, or any transactional test leaves partial rows. Preserve logs without customer data; record the failing step. Do not attempt a production fallback.

**Safe rollback:** stop/disable only the test hostname route first, then disable the test Worker and test Access app as required. Keep the isolated test D1 for diagnosis until the owner approves disposal; if it must be reset, export only synthetic test state and recreate/drop only `nasr-crm-test-db`. Never use a down-migration or cleanup command against `nasr-market-db`. No production rollback action is part of this plan.

## Least-privilege permission summary (future only; none requested or used now)

Do not add permissions to the current token. Use a separate short-lived credential or owner-performed dashboard operations. Cloudflare dashboard permission labels to select, subject to confirming the exact label/scope offered by that account at setup time:

| Cloudflare permission label | Scope | Why it may be needed |
|---|---|---|
| `Account / D1 / Edit` | Only `nasr-crm-test-db`; account scope temporarily only if required to create that database | Create the isolated D1 and apply its migration. |
| `Account / D1 / Read` | Only `nasr-crm-test-db` | Inspect database identity/schema and verify migration. |
| `Account / Workers Scripts / Edit` | Only `nasr-crm-api-test` | Upload/update only the isolated Worker. |
| `Account / Workers Scripts / Read` | Only `nasr-crm-api-test` | Inspect deployed test Worker and verify configuration. |
| `Account / Workers Routes / Edit` | Only if a route must be added; approved test zone/hostname only | Attach the isolated test hostname. Omit if no route change is needed. |
| `Account / Workers Routes / Read` | Approved test zone/hostname only, if available/needed | Verify the test route and detect accidental production routing. |
| `Account / Access: Apps and Policies / Edit` | Only to the extent account UI permits; use only for `nasr-crm-test-access` | Create the isolated owner-only Access app/policy. |
| `Account / Access: Apps and Policies / Read` | Same narrowest available scope | Verify app audience and policy without edits. |
| `Zone / DNS / Edit` | Only the owner-approved test zone, only if a DNS change is required | Add/verify the test hostname. Omit otherwise. |
| `Zone / DNS / Read` | Only the owner-approved test zone, if needed | Verify test hostname records. |

`Pages / Edit` is not needed because the UI is served from the test Worker; request Pages permissions only if the owner later chooses a separate Pages project. Resource-level scoping varies by permission and account, so verify available scope controls before granting. If Cloudflare only offers broader scope for a necessary operation, pause for explicit owner approval rather than granting it. These names are a later planning reference, not authorization or a request for credentials. Never grant production D1/Worker/route/zone write access or expose credential values in chat.
