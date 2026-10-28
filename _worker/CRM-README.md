# Private CRM API — built-in Worker authentication & isolated test setup

## Security architecture (no Cloudflare Zero Trust / no paid plan required)
Mandatory reliance on Cloudflare Access / Zero Trust has been removed and replaced by self-contained authentication inside `_worker/crm-worker.js` using Cloudflare Workers Free Plan + D1 (`nasr-crm-test-db` only for isolated testing; `nasr-market-db` is never touched):

- **Fail-closed secret validation (`503 auth_not_configured`):** Every route except `GET /health` fails closed with `503` unless `CRM_SESSION_SECRET` (`>= 32` chars), `CRM_ALLOWED_ORIGIN` (exact `https://` origin), `CRM_SITE_SOURCE_ID`, `CRM_NASR_AREA_IDS`, and either `CRM_ACCESS_CODE_VERIFIER` (`pbkdf2-sha256$<iterations>$<salt_b64url>$<hash_b64url>`) or `CRM_ACCESS_CODE` (`>= 24` random non-whitespace chars) are configured via Worker Secrets/vars.
- **No secrets in JS, git, or logs:** Secrets are stored exclusively as encrypted Cloudflare Worker Secrets (`CRM_SESSION_SECRET`, `CRM_ACCESS_CODE` / `CRM_ACCESS_CODE_VERIFIER`) and verified using salted `PBKDF2-SHA256` + constant-time byte comparison.
- **Short-lived D1-backed sessions (`__Host-crm_session`):** Sessions use a 256-bit random token in a `__Host-crm_session` cookie (`HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=28800`, 8h absolute TTL + 2h idle timeout). Only the HMAC-SHA256 digest (`token_hash`) and SHA-256 digest (`csrf_hash`) are stored in `crm_sessions`. `POST /api/auth/logout` revokes the session row in D1 and clears the cookie.
- **CSRF + Origin + CORS protection:** All state-changing requests (`POST`/`PUT`/`PATCH`/`DELETE`) enforce exact `Origin === CRM_ALLOWED_ORIGIN`, reject `Sec-Fetch-Site: cross-site`, and require `X-CRM-CSRF` matching the active session's `csrf_hash` on all authenticated mutations. CORS preflight (`OPTIONS`) permits only `CRM_ALLOWED_ORIGIN`.
- **Brute-force rate limiting:** `crm_auth_attempts` tracks failed logins using HMAC-hashed IP buckets (never raw IPs) and locks after 5 failures for 15 minutes (`429 too_many_attempts` + `Retry-After`).
- **Authenticated API gate:** All CRM data routes (`/api/dashboard`, `/api/contacts`, `/api/contacts/:id`, `/api/contacts/:id/phones`, `/api/opportunities`, `/api/opportunities/:id`, `/api/opportunities/:id/activities`, `/api/opportunities/:id/properties`, `/api/listings`) require an active session (`401` otherwise). Static UI shell assets (`/`, `/crm.html`, `/crm-client.js`, `/crm-assets/*`) contain zero customer data and keep `#crm-workspace` hidden until login succeeds.

## Isolated test resources
- **Worker:** `nasr-crm-api-test` (`_worker/wrangler.crm.toml`)
- **D1:** `nasr-crm-test-db` (`65bfcb14-4b48-423b-916f-00eefdb9ae1e`) with migrations `0001_crm_opportunities.sql` + `0002_crm_internal_auth.sql` and synthetic fixtures (`CRM_SITE_SOURCE_ID=9009`, `CRM_NASR_AREA_IDS=90001`).
- **Production isolation:** `nasr-market-db` (`ace5c9a2-c6b1-47b3-adf1-77e84ac50abf`) and all production Workers remain untouched.

## Setting or rotating your owner access code on `nasr-crm-api-test`
Never commit or paste secrets into git or chat. To set your own persistent browser login code (24+ random non-whitespace characters) on the isolated test Worker:
1. Cloudflare Dashboard → **Workers & Pages** → **`nasr-crm-api-test`** → **Settings** → **Variables and Secrets** → Add **Secret** named `CRM_ACCESS_CODE` (or run `npx wrangler@4 secret put CRM_ACCESS_CODE --config _worker/wrangler.crm.toml` locally).

## Local testing
```bash
npm test
npm run lint
npm run lint:sonar
```
