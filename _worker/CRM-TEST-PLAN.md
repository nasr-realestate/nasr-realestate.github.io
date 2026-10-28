# CRM isolated Cloudflare test plan (built-in Worker authentication)

## Isolation rules
- **Test D1 only:** `nasr-crm-test-db` (`65bfcb14-4b48-423b-916f-00eefdb9ae1e`). Never bind or query `nasr-market-db` (`ace5c9a2-c6b1-47b3-adf1-77e84ac50abf`).
- **Test Worker only:** `nasr-crm-api-test` on `<worker>.<subdomain>.workers.dev` (`preview_urls = false`). Never modify production Workers or routes.
- **No Cloudflare Zero Trust / no payment card:** Built-in Worker authentication replaces Cloudflare Access completely on the free Workers + D1 plan.
- **No secrets in repo, JS, or logs:** Secrets (`CRM_SESSION_SECRET`, `CRM_ACCESS_CODE_VERIFIER` / `CRM_ACCESS_CODE`) are stored solely as Cloudflare Worker Secrets.

## Live isolated verification checklist (`.github/workflows/crm-cloudflare-test-deploy.yml`)
1. Confirm `wrangler.crm.toml` targets only `nasr-crm-api-test` and `nasr-crm-test-db` (`65bfcb14-4b48-423b-916f-00eefdb9ae1e`).
2. Apply additive migration `0002_crm_internal_auth.sql` (`crm_sessions`, `crm_auth_attempts`) to `nasr-crm-test-db` and verify 8 `crm_*` tables + 2 synthetic listings.
3. Deploy `nasr-crm-api-test` with `ASSETS` (`_worker/crm-ui`) and `DB` (`nasr-crm-test-db`).
4. Verify fail-closed (`503 auth_not_configured`) when auth secrets are absent, then configure encrypted Worker Secrets (`CRM_SESSION_SECRET` + `CRM_ACCESS_CODE_VERIFIER`).
5. Execute live HTTPS E2E checks against `nasr-crm-api-test`:
   - Unauthenticated `GET /api/contacts`, `GET /api/dashboard`, `POST /api/contacts` → `401 authentication_required`
   - Disallowed `Origin` on `POST /api/auth/login` → `403 origin_not_allowed`
   - Wrong passcode on `POST /api/auth/login` → `401 invalid_credentials`
   - Valid passcode on `POST /api/auth/login` → `200` + `__Host-crm_session` (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`) + `csrf_token`
   - Authenticated `POST /api/contacts` without `X-CRM-CSRF` → `403 csrf_invalid`
   - Authenticated `POST /api/contacts` with `X-CRM-CSRF` + `Idempotency-Key` → `201` (synthetic customer saved)
   - Authenticated `GET /api/contacts/{id}`, `GET /api/contacts?q=...`, and `GET /api/listings` → `200` (synthetic customer retrieved; listing scope restricted to `crm-test-only-inside`)
   - Authenticated `POST /api/auth/logout` → `200` (`Max-Age=0`) and D1 revocation
   - Post-logout replay of the former session cookie → `401 authentication_required`
6. Clean up synthetic E2E test rows in `nasr-crm-test-db` while keeping `nasr-crm-api-test` protected (`401` on all unauthenticated `/api/*` requests).
7. Keep PR open and do not deploy to production until the owner reviews the live test results.
