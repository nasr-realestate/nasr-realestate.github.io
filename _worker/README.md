# Cloudflare Workers — deployment notes

A fourth Worker (`nasr-ai-gateway`, added 2026-10-16) exposes the site's listings over Model Context Protocol; unlike the other three it binds **nothing** and uses **no secret**. Two independent Workers serve the site; a third one syncs GitHub content into D1. Those three use the existing `nasr-market-db` D1 database through the `DB` binding. The two serving Workers are **read-only** (`SELECT` / `PRAGMA` only). The sync Worker is the only writer, and it writes **only** `listings` rows whose `source_id = 9`, plus its own state table and the `ingestion_runs` log — never `areas`, `price_snapshots`, other sources, and never a `DELETE`.

| Repository file | Wrangler config | Cloudflare Worker | Version | Role |
| --- | --- | --- | --- | --- |
| `_worker/worker.js` | `_worker/wrangler.agent.toml` (`main = "worker.js"`) | `royal-snow-ea32` | **v10.0-chat** in the repository (`release:` header); the **live** module stays v9.3-W (deployed 2026-10-14) until the owner runs the configure workflow | The agent behind `agent.html`: `POST /chat` (Gemini-first, v10) + the legacy `POST /` formState chat and `POST /upload-images` (kept for compatibility) |
| `_worker/valuation-worker.js` | `_worker/wrangler.valuation.toml` (`main = "valuation-worker.js"`) | `noisy-bush-fd84` | **v6.2**, contract `d1-price-snapshots-v2` | The valuation API used by `tools/valuation.html` (`GET /areas`, `POST /api`) |
| `_worker/properties-sync-worker.js` | `_worker/wrangler.sync.toml` (`main = "properties-sync-worker.js"`) | `nasr-properties-sync` | **v1.0.4** | GitHub `_properties/*.md` → D1 `listings` (source_id = 9), hourly Cron + manual HTTP trigger |
| `_worker/mcp-worker.js` | `_worker/wrangler.mcp.toml` (`main = "mcp-worker.js"`) | `nasr-ai-gateway` | **v1.0.1** | Read-only MCP server + JSON API over the public `ai-feed.json` — no binding, no secret, no D1 |

**Each Worker is one self-contained file and imports nothing.** There is no shared module: the legacy shared D1 reader (`market-data`) was never imported by either Worker (Wrangler only bundles what is imported, so it was never deployed) and has been removed. The static `assets/data/market-data.json` is a different file: the valuation page reads only area *descriptions* from it (names, level, landmarks, streets) — never prices, confidence or fallbacks.

Bindings and settings required by both Workers: the `DB` D1 binding to `nasr-market-db` (declared in both TOML files) and `workers_dev = true`. The **live** agent Worker runs `compatibility_date = "2026-09-04"` (the 2026-09-01 values in older notes were never its production date — `wrangler.agent.toml` now mirrors the live settings and is documentation only). Since 2026-10-10 the agent Worker also binds `PUSH_SUBS` → KV namespace `nasr-push-subs` for Web Push subscriptions (see `PUSH-NOTIFICATIONS.md`). `GEMINI_MODEL` (a plain-text variable that existed since the first deployment but was unused until v9.3) is now read by the code: if Google rejects the name (400/404) the Worker falls back to the built-in `gemini-3.5-flash-lite` once, so a wrong variable can never turn the agent silent. v9.3 also caches `ai-feed.json` at the Cloudflare edge (`cf.cacheTtl = 300`) — a newly published listing can take up to 5 minutes to appear in the agent's gallery. Deployment of the agent Worker is gated by `EXPECTED_WORKER_SHA256` in `.github/workflows/push-notify-setup.yml`: any change to `_worker/worker.js` requires updating that fingerprint deliberately (`release:` in the file header is the human-readable twin of that fingerprint, and the read-only audit compares it against the live module). Secrets: the **agent** Worker keeps `GEMINI_API_KEY`, `IMGBB_API_KEY` (and now `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY`, `PUSH_SEND_SECRET` for Web Push — never stored in this repository); the **valuation** Worker needs no secret. `ALLOWED_ORIGINS` is an optional comma-separated plain variable for extra CORS origins — the site origin is already allowed by default in code. The agent Worker does **not** read prices from D1; its property listings come from `ai-feed.json`.

## Agent Worker — `POST /chat` (v10.0-chat, Gemini-first)

`agent.html` now sends **every** visitor message (greetings, general questions, corrections, quick-reply chips) to `POST /chat` after a one-time explicit consent in the page. The route is stateless and independent of the legacy `POST /` formState chat, which is left untouched for compatibility (the new page no longer calls it, and no longer uploads images).

| Request field | Meaning |
| --- | --- |
| `consent` | must equal `"gemini-v1"`, otherwise `412 consent_required` before anything else happens |
| `message` | the visitor's text (≤ 1000 characters) |
| `state` | the short structured state returned by the previous turn (role, operation, property type, location, area, price + kind, optional owner details) — sanitised field by field |
| `history` | the last ≤ 10 messages `{role, text}` from page memory (each capped at 600 characters before Gemini) |
| `focus` *(optional)* | a listing slug the visitor asked about («اسأل عنه») |
| `valuation` *(optional)* | the numbers returned by the valuation tool, sent once after the round trip; reaches Gemini only as numbers and only for owners |

Per message: sanitise the client state → redact phone/national ID/card/IBAN/e-mail/password and exact building numbers → deterministic parse of the user's own words → one Gemini `generateContent` call (JSON mode + `responseSchema` + minimal thinking for the model family — `thinkingLevel: "minimal"` then `"low"` on Gemini 3.x, `thinkingBudget: 0` on 2.5 Flash, 128 on 2.5 Pro; each rejected setting (`400`) is retried with a simpler one, an env model rejected with `404` falls back to the built-in model, an overloaded model (`5xx`/`429`) switches to the next model (`gemini-flash-latest` → `gemini-3.5-flash` → `gemini-flash-lite-latest` → `gemini-2.5-flash`; names that do not exist answer `404` in ~0.15 s and are skipped — `gemini-2.5-flash-lite` is already retired); **if no answer arrives within 6 s a second, lighter JSON-only request to an alternative model is sent in parallel (each of its attempts capped at 7 s so one slow model cannot block the next) and the first valid answer wins, the other is aborted** — live latency of `gemini-3.5-flash-lite` alone ranged from 5.9 s to 503/timeouts after 16–22 s; 22 s budget; errors carry content-free `diag` timings) → merge Gemini's proposed patch **only where the user's words support it** (deal conflicts or seeker/owner ambiguity become one clarifying question; a buy↔rent switch drops the old price) → search / comparables from `ai-feed.json` (Nasr City rows only; comparison needs ≥ 3 published asking prices of the same type and deal, location first then the whole city, always labelled as asking prices with count and data date) → ground Gemini's reply (numbers must come from the user, the data or the published site facts; no availability, «sent/registered», legal, rent-commission, deposit or price-verdict claims without data; site links only; one question per reply; ≤ 700 characters).

Errors are explicit — never a canned local answer: `503 gemini_unconfigured` (no key), `503 gemini_unavailable` / `gemini_busy`, `504 gemini_timeout`, `502 gemini_invalid`, `429 rate_limited` (15 per 30 s per IP, shared with the legacy route), `413`, `415`, `400`. The Worker logs nothing but Gemini's HTTP status code, and touches no D1, KV, ImgBB or WhatsApp.

Deployment order (merging the PR deploys **only** GitHub Pages, never the Worker): run **Push Notifications Setup → configure** (it can be dispatched on the PR branch; it uploads this single file after the `EXPECTED_WORKER_SHA256` gate and then probes `OPTIONS /chat` → 204, `POST /chat` without consent → 412, and **three synthetic consented messages (no customer data; only HTTP code, model, latency and reply length are logged)**, at least two of which must come back `ok` from Gemini for a `SUCCESS` verdict) and only then merge, so the new page never meets an old or broken Worker. If the page does meet an old Worker, it shows «الخادم مش جاهز» and offers the local search — it never renders the legacy answer as a Gemini reply. The same check by hand:

```bash
curl -sS -X POST https://royal-snow-ea32.footcai-555.workers.dev/chat \
  -H "Origin: https://nasr-realestate.github.io" -H "Content-Type: application/json" \
  --data '{"consent":"gemini-v1","message":"أهلا"}' | jq '{ok, error, provider, reply}'
```

## MCP Gateway — `nasr-ai-gateway` (v1.0.1)

Purpose: the site already *publishes* data (`llms.txt`, `ai-feed.json`, JSON-LD) so models can read it while crawling. This Worker makes the site **callable**: any client that speaks the Model Context Protocol can search and quote a real unit instead of paraphrasing a page. That is the difference between "a model may mention the broker" and "a model returns unit `shop-abbas-elakkad-60m-jan26` with its price and link".

| Endpoint | Purpose |
| --- | --- |
| `POST /mcp` | MCP on Streamable HTTP (JSON-RPC 2.0): `initialize` · `ping` · `tools/list` · `tools/call` · `resources/list` · `resources/read` · `resources/templates/list` · `prompts/list` · `prompts/get` · `logging/setLevel` · `completion/complete`. Notifications (`notifications/initialized`, `notifications/cancelled`) answer `202` with an empty body. JSON-RPC batches are still accepted for older clients. |
| `GET /mcp` | `405` + `Allow: POST`. This server is stateless and opens no SSE stream — allowed by the spec, and the reason the Worker needs no session storage. |
| `GET /` | Service card: protocol version, tools, resources, prompts, read-only flag, citation policy. |
| `GET /health` | `200` when the feed reads, `503` `degraded` when it does not. Reports the feed's own `generated_at` so staleness is visible. |
| `GET /api/properties` | Compact JSON with `transaction`, `property_type`, `zone`, `query`, `min_price`, `max_price`, `min_area`, `max_area`, `min_rooms`, `furnished`, `limit` (cap 50). |
| `GET /api/properties/{slug}` | One unit. `404` with the catalogue URL when the slug is unknown. |
| `GET /api/stats` · `GET /api/zones` | Aggregates over the *asking* prices and the zone distribution. |

Tools: `search_properties` · `get_property` · `market_summary` · `list_zones` · `get_contact`. Every `inputSchema` sets `additionalProperties: false`, and `limit` is capped at 50 so one call can never flood a context window. Resources: `semsar://catalog` · `semsar://llms-full` · `semsar://contact` · `semsar://stats`. Prompt: `recommend_units`, which instructs the model to widen filters instead of inventing a unit and to state that prices are asking prices.

Design rules this Worker obeys, all covered by blocking tests:

* **Read-only.** It issues `GET` requests only, has no `DB` binding, and never runs SQL. The tests strip comments and assert the absence of `import`, `env.DB`, any secret name, any non-`GET` upstream request, and any SQL write keyword.
* **Secretless.** It reads one public file (`ai-feed.json`) with a 300 s edge cache plus a 60 s in-isolate cache. If the feed fails it serves the stale copy rather than failing; if there is no copy at all it returns a clear `FEED_UNAVAILABLE` error — never an empty-but-successful answer.
* **No invented numbers.** `priceNumeric`/`areaNumeric`/`roomsNumeric`/`bathsNumeric` are passed through or returned as `null`. A price filter can never be satisfied by a unit whose price is unknown.
* **Deterministic types.** `property_type` matches on the structured field, not on free text — the earlier text-matching version let a `warehouse` through a `shop` filter because its category said `commercial`.
* **Isolated.** `compatibility_date = "2026-09-04"` matches the live agent Worker, but nothing else is shared. `.github/workflows/deploy-mcp-gateway.yml` runs the blocking tests first, deploys **only** `nasr-ai-gateway`, and skips cleanly (success, with a notice) when the repository has no Cloudflare credential — so it can never touch the other three Workers.

Deploy: `cd _worker && npx wrangler@3 deploy --config wrangler.mcp.toml` (or push a change to `_worker/mcp-worker.js` on `master`/`arena/**`). Smoke check: `curl -s https://nasr-ai-gateway.footcai-555.workers.dev/` — expect `service: semsar-talabk`, `read_only: true`, `requires_secrets: false`.

## Properties Sync Worker (v1.0.0)

Source of truth for published listings is GitHub (`_properties/*.md`); D1 keeps a structured copy for the other systems. The Worker reads the real D1 schema at runtime (`PRAGMA table_info` / `PRAGMA index_list`) and **refuses to write anything** if it cannot map the required columns (`schema_mismatch`), so a different schema can never be corrupted. Nothing is ever invented: fields come from the file's front matter, and a property whose front matter has no numeric price or no numeric area is reported as invalid instead of being written half-empty.

| Endpoint | Purpose |
| --- | --- |
| `GET /` or `GET /health` | service info + real schema summary + last `ingestion_runs` row |
| `GET /schema` | the D1 schema as read at runtime + the column mapping |
| `GET /verify?in_scope=&out_of_scope=&invalid=&null_area=&rows=` | read-only D1 report used by CI: total/source-9 row counts, duplicates, per-list presence checks, `PRAGMA foreign_key_check` + `integrity_check`. Runs the same fixed `SELECT`/`PRAGMA` statements through the `DB` binding, never writes, and requires `SYNC_TOKEN` when that binding is set |
| `GET /` (`scope_policy`) | explains the in-scope rule: Nasr City only, out-of-scope files are never written, most-specific area wins |
| `GET /sync?dryRun=1` | manual **dry run** (default for GET): parses and reports, writes nothing |
| `POST /sync` | real run (requires `SYNC_TOKEN` as `Authorization: Bearer …` or `?token=…` when that binding is set; two manual runs inside `SYNC_MIN_INTERVAL_S`, default 60 s, answer `429 throttled` — Cron is never throttled) |

Sync behaviour, in order: read schema → load areas → load existing `listings` rows **where `source_id = 9`** → read the published `ai-feed.json` **once** to get the file list (`source_path` + `source_sha256` per unit; no GitHub Tree API and no anonymous 60 req/h cliff) → fetch only files whose SHA is not already recorded in `properties_sync_state` (fetch budget `SYNC_FETCH_BUDGET`, default 40 per run, so one run can never explode into hundreds of subrequests). Feed fetches and raw reads retry with backoff and honour `Retry-After` / `X-RateLimit-*`; a feed without `source_path` is a clear error (no filename guessing), with a single documented fallback to the Contents API only when `GITHUB_TOKEN` is set → parse front matter → validate → `INSERT` new / `UPDATE` the same row when a mapped value actually changed / skip when nothing changed → append one row to `ingestion_runs`. A file that disappears from GitHub is only reported (`missing_from_github`): there is no delete path at all. Files that are unchanged *and* known-invalid are skipped on later runs through the same state table (`__invalid__:` / `__oos__:` marker rows), so a run after the first one costs a single GitHub API call when nothing changed. Cron trigger: `17 * * * *` (hourly). Optional vars, all owner-set and sanitised before use: `LISTINGS_TABLE` / `STATE_TABLE` (table-name overrides), `GITHUB_BRANCH` (branch override, default `master`), `SYNC_FETCH_BUDGET`, `SYNC_ALLOW_DDL=0`, `SYNC_TOKEN` (protects the manual trigger), `GITHUB_TOKEN` (optional; only used for the Contents-API fallback and to raise the GitHub limit), `SYNC_FEED_URL` (feed override, default `https://nasr-realestate.github.io/ai-feed.json`). `GET /verify` now also returns `run_health`: the last `ingestion_runs` error/partial row is reported by name and considered *active* until a newer successful run supersedes it (logical clear — there is still no `DELETE`).

Scope (the Nasr City boundary): a file is **out of scope** when its text carries an explicit marker of a location outside Nasr City (`مصر الجديدة`, `هليوبوليس`, `التجمع الأول/الخامس`, `القاهرة الجديدة`, `الرحاب`, `مدينتي`, `مستقبل سيتي`, `وادي دجلة`, `مدينة السلام`, `مدينة العبور`, `الشروق`, `الشيخ زايد`, `اكتوبر`, `المعادي`… , `شارع التسعين`, `التسعين الجنوبي/الشمالي`, `الشويفات`, `نيوبوليس`, `مدينة بدر`) or, when the text never says `مدينة نصر`, the conditional markers `شيراتون` / `مساكن شيراتون`. Out-of-scope files are **never** inserted or updated in `listings` — they are counted and listed with their reasons in every run report (`out_of_scope_files`), and remembered in the state table so later runs skip them. Matching is token-based after Arabic normalisation, including attached prefixes (`بالحي الثامن`, `وبالواحة`), so `بدريسنج` never triggers `بدر` and `مباني التسعينات` never triggers `التسعين`. This is what stops a New-Cairo «الحي الأول/الثاني» villa from being filed under a Nasr City area.

Identity and mapping: `external_id` = front matter `id` (falls back to `slug`, then the file name; both are unique across the current 98 files). `transaction_type` = `rent` only on an explicit signal (`rent` / `للإيجار` / `شهري…` in `category` / `slug` / `title` / `price` / file name), otherwise `sale` — and the run report exposes how many used the default (`transactionEvidence`). `property_type` comes from `category` (`apartments → apartment`, `villas → villa`, `admin-hq → admin`, …). `price` uses `priceNumeric` first then the digits inside `price` (rent prices are monthly). `area_m2` uses `areaNumeric` then the digits inside `area`; the 5 files whose area is free text ("مساحة كبيرة واسعة") and the 3 whose price is "السعر عند التسليم" are reported as invalid, never guessed. Current first-run outcome over the 98 files: **78 written** (28 on the city node, 45 on sub-areas, 5 without a matching area), **12 out of scope**, **8 invalid**. `area_id` is matched against the real `areas` table with the **most-specific-wins** rule: any sub-area beats the city node (so «الواحة … مدينة نصر» is الواحة, not the city), the longest sub-area match wins inside its group, and the city node is only a fallback; with no clear match the column stays empty — it is never defaulted to `area_id = 1`. Corridor aliases are derived from the area's own name only (`ممر مكرم عبيد` → `مكرم عبيد`), so «شارع مكرم عبيد» and «عباس العقاد» reach areas 29 / 30. Latitude/longitude are written only if the schema has the columns and the file carries them; the current files carry none.

Rows already in D1 under `source_id = 9` are updated in place, never duplicated; rows of every other source are never read for writing and never touched. `price_snapshots` is never written and no valuation is recomputed.

## Valuation Worker — contract `d1-price-snapshots-v2` (v6.2)

Rules: **median** (`median_price_m2`) is the central indicator; **P25 → P75** is the core range; **Min/Max** are observed sample bounds (not the market range). Confidence comes from the sample count: `>= 30` high, `10–29` medium, `< 10` low. Prices are asking prices, not closing prices. No number is ever invented: without a valid snapshot the Worker answers with an error.

`GET /areas` — health + areas: `{ service, status:"running", version:"v6.2", api_contract, source_table, data_source, areas, available_areas:[{ id, name, name_ar, name_en, scope }], valuation_method, sources }`. The first area is `مدينة نصر (ككل)` (id 1, scope `city`).

`POST /api` — request: `{ area, areaType: "sale"|"rent", propertyType, size (20–100000), rentCondition? }`
(`transaction` is accepted as an alias of `areaType`; `furnished: true|false` as an alias of `rentCondition`). `rentCondition` is `furnished`, `unfurnished` or `all`; `null` / `""` / `"unknown"` / `"غير محدد"` mean "not specified" and are accepted silently (it only applies to rent).

Success (`200`): `estimate`, `price_per_meter`, `price_per_m2_range {low, high}` (P25–P75), `range {low, high}` (total value), `market_bounds {min_price_per_m2, max_price_per_m2, min_value, max_value}`, `price_basis:"median_price_m2"`, `confidence`, `sample_count`, `period`, `area_found`, `fallback_used`, … and `requested_area` / `fallback_reason` when a fallback happened.

**Whole-city fallback.** If a sub-area has no valid snapshot (none, or median / P25 / P75 missing), the Worker uses the real `مدينة نصر (ككل)` snapshot (area id 1) and marks the answer `fallback_used: true` with `requested_area` and `fallback_reason` (`no_snapshot_for_area` | `invalid_snapshot_for_area`). The property type and transaction are never substituted. If the city has no snapshot either, the answer is `503 MARKET_UNAVAILABLE`.

Errors — every `POST /api` failure carries `{ code, error, available_areas }` (the list is `[]` if D1 itself is down); protocol-level errors carry `{ code, error }` only:

| `code` | HTTP | When |
| --- | --- | --- |
| `AREA_REQUIRED` | 400 | no area |
| `TRANSACTION_REQUIRED` | 400 | no / invalid `areaType` |
| `PROPERTY_TYPE_REQUIRED` | 400 | no property type |
| `UNSUPPORTED_PROPERTY_TYPE` | 422 | property type not recognised |
| `INVALID_AREA_SIZE` | 400 | size missing, below 20 or above 100000 |
| `INVALID_RENT_CONDITION` | 400 | rent only: a non-empty, unknown `rentCondition` |
| `AREA_NOT_FOUND` | 400 | name not in the D1 `areas` list |
| `MARKET_UNAVAILABLE` | 503 | no valid snapshot for the area nor the whole city, or D1 unavailable |
| `INSUFFICIENT_MARKET_DATA` | 422 | defensive: a snapshot that cannot produce a valuation |
| `REQUEST_TOO_LARGE` | 413 | body above 16 KB (counted on the wire) — protocol-level |
| `INVALID_JSON` / `INVALID_PAYLOAD` | 400 | body is not JSON / not an object — protocol-level |
| `METHOD_NOT_ALLOWED` | 405 | anything but GET / POST / OPTIONS — protocol-level |

D1 reads (v6.2): `SELECT * FROM areas LIMIT 1000` and `SELECT * FROM price_snapshots WHERE area_id IN (?,?) LIMIT 1000` (the requested area + whole city, one query for the request and its fallback). `property_type` / `transaction_type` are filtered in JavaScript on purpose (D1 may store `apartment` or `شقة`). Fail-safes: a SQL error **or** 0 rows falls back to the previous full read (`SELECT * FROM price_snapshots LIMIT 1000`), so a different column type can never cause a false `MARKET_UNAVAILABLE`.

## Agent Worker (v8.7.2)

- **Valuation gift.** After `notes` and before `ownerName` (owner flow only) the agent offers the valuation tool once (`valuationGift`). The reply carries `valuationCta` (`intent`, `area`, `size`, `propertyType`, `areaType`, `rentCondition`, `price`, `floor`, `finishing`); `agent.html` renders it as the **💎 قيّم عقارك** link. Any answer at that step counts as "skip" — except an explicit request to see the valuation (e.g. «عايز أشوف التقييم»), which re-offers the gift with its button instead of skipping it.
- **`valuationResult` handling.** `agent.html` sends the figures read from the return URL. The Worker treats them as untrusted browser input: `sanitizeValuation()` accepts only a plain object with a positive `estimate` (≤ 1e12) and **never coerces types** (numbers or plain decimal strings only — booleans, arrays, `0x…`, `1e3`, padded strings are rejected); an optional field of the wrong type becomes 0 / empty; `confidence`, `priceBasis` and `areaType` are whitelist-only; the free-text `area` label is stripped of markup, control characters and phone numbers (80 chars max). A consistency check drops a payload whose `estimate` differs from `perMeter × size` by more than `0.51 × size + 1` (`perMeter` is itself rounded, so the legitimate gap can reach 0.505 × size). The valid result is stored in `formState.data.valuation`, announced once (area line, total range P25×size…P75×size, per-m² range, confidence with sample count, and a status line: high "🟢 عينة قوية — مؤشر موثوق نسبيًا", medium "🟡 عينة متوسطة — استرشادي", low "🔴 عينة محدودة — استرشادي فقط", unknown "⚪ الثقة غير محددة — مؤشر عام فقط"), and added to the owner's WhatsApp message as the "💎 التقييم السوقي (استرشادي)" section. It is ignored when no flow is active.
- **Privacy towards Gemini.** No GPS (lat/lng/`gps`/address) and no exact address is ever sent to Gemini: `safeDataForPrompt` drops `gps`, `location` and other location keys and reduces `valuation` to numbers; the Gemini comment is skipped on the `location` / `landmark` answers, and it is given only the real next question — never the valuation announcement (which contains the area label that came from the browser); known addresses are replaced by `[عنوان]` in history and side questions. All Egyptian mobile numbers (010 / 011 / 012 / 015, in any format: `01…`, `1…`, `201…`, `+20`, `0020`, with spaces / dashes / dots / parentheses, Arabic or Persian digits) and 14-digit national IDs are replaced by `[رقم]` in every Gemini prompt. These two protections are one change set — never ship one without the other.
- **Dead code removed:** `buildValuationUrl` (never called; `agent.html` builds the link itself).

### Limits

| Limit | Value | Notes |
| --- | --- | --- |
| Agent chat body | 256 KB | counted on the wire (`413` above) — chunked bodies included |
| Agent `POST /upload-images` body | 12 MB | counted on the wire (`413` above); `Content-Type: application/json` required (`415` otherwise) |
| Single image (decoded) | 6 MB | larger images are rejected as invalid |
| Images per upload | 5 | |
| Upload rate | 4 / minute and 20 / hour per IP | `429` above |
| Chat rate | 15 messages / 30 s per IP | `429` above |
| Valuation `POST /api` body | 16 KB | counted on the wire (`413` above) |
| Valuation size range | 20 – 100000 m² | `INVALID_AREA_SIZE` outside |

These in-Worker limits are best-effort: they live in each isolate's memory and reset when it restarts. Real rate limiting is a Cloudflare edge rule (dashboard → Security → WAF → Rate limiting rules), which is a manual owner task and is not configured in code.

## URL contracts between the pages

Entry to the tool: `/tools/valuation.html?area=6th-district&size=180&type=apartment&deal=sale` — keys: `area` (a slug such as `6th-district`, or free text that contains an area name, e.g. `ابراهيم نواره المنطقه السادسه`), `size`, `type` (`apartment`, `villa`, `duplex`, `roof`, `shop`, `office`, `warehouse`), `deal` (`sale` | `rent`), `furnished` (`yes` | `no`, rent only), `finish` (`ultra-lux`, `super-lux`, `semi-finished`, `red-brick`), `floor` (`ground`, `1`–`4`, `5plus`), `age` (`new`, `medium`, `old`), `price` (asking price, comparison only), plus `from=agent&journey=seller` when it comes from the chat. Old keys still work: `pt` / `propertyType`, `areaType`, `type=sale|rent`, `rentCondition`, `askingPrice`, `finishing`. The tool's share link never carries `from`, `journey` or `return`.

Return to the agent: `/agent.html?return=valuation&estimate=…&confidence=…&samples=…&perMeter=…&p25=…&p75=…&basis=…&area=…&size=…&areaType=…`. The agent re-reads them into `state.valuationResult`, clears them from the address bar, and re-arms the one-time send on every new return.

## Local checks

Run the whole suite (plain `node:test`, no dependencies, no network, no real D1 rows or credentials — the fixtures contain invented numbers and never ship; `_worker/` is excluded from the Jekyll build):

```sh
node --test _worker/tests/*.test.mjs
```

Since 2026-10-14 the same command runs in CI on every push and PR
(`.github/workflows/tests.yml`): a full advisory run, then a blocking run that
excludes the two known *content* failures (the agent page says «أنا طارق طنطاوي»
while the test expects the «وكيل ذكي» wording, and the status line says «متصل الآن»
instead of «وكيل ذكي • متصل الآن»). Any other failure stops the build — this gate
did not exist before, which is why the v9.3 page regressions reached `master`.

The sync Worker tests (`properties-sync.test.mjs`, 36 tests) run entirely offline against a mock D1 and a mock GitHub: first/second run idempotency, in-place update, invalid files, out-of-scope exclusion (R1/R2: the two New-Cairo «الحي الأول/الثاني» files, plus the positive/negative marker matrix), the most-specific area rule and the corridor aliases (R3), duplicates, missing files (no delete), other-source isolation, `price_snapshots` untouched, schema mismatch, alternative column names, dry run, `SYNC_TOKEN`, fetch budget and the cron handler.

Syntax check every Worker file and test file, and confirm both Workers bundle (no Cloudflare login needed):

```sh
for f in _worker/*.js _worker/tests/*.mjs; do node --check "$f"; done
npx wrangler deploy --dry-run --outdir /tmp/wr-valuation --config _worker/wrangler.valuation.toml
npx wrangler deploy --dry-run --outdir /tmp/wr-agent --config _worker/wrangler.agent.toml
```

221 tests in 13 files, 36 of them the sync suite. Two failures are known and documented (`agent-page`: identity wording + status line — a content decision, not code); everything else is green. Helpers (shared, not tests): `_fixtures.mjs` (invented D1 rows + mock D1), `_agent-harness.mjs` (drives the agent Worker through its public `fetch` handler and records every Gemini request), `_dom-agent.mjs` and `_dom-page.mjs` (run the inline scripts of `agent.html` / `tools/valuation.html` under `node:vm` with a small DOM stub — selects are built from the real HTML). `market-integration` and `valuation-handoff` were rewritten because their old versions imported a removed module and removed exports; each new test is tagged `[was #N]`.

What each test file covers:

- `valuation-worker.test.mjs` — the valuation Worker end to end over a mock D1: contract v2, median + P25–P75 + Min/Max, confidence thresholds, rent conditions, whole-city fallback, every error code with `available_areas`, the narrowed D1 read and its fail-safes, the real byte cap, read-only SQL.
- `market-integration.test.mjs` — `المنطقة الأولى` vs `الحي الأول`, the median-only rule (no average fallback, no property-type or rent-condition substitution), the `/areas` + `/api` contract v2, the agent that never quotes prices (the 💎 CTA only exists at the owner's gift step), and listings that stay on `ai-feed.json` whatever D1 does.
- `valuation-handoff.test.mjs` — the `valuationResult` handoff: accepted payload, strict types, consistency, stale/malformed input, fixed output shape, injection attempts, no PII/GPS in prompts, the lead and WhatsApp section.
- `valuation-gift.test.mjs` — the gift step (position, owners only, CTA context), skip / back / typing, re-announcing a stored valuation, and two end-to-end loops (sale and rent) that run the real agent Worker, `agent.html`, `tools/valuation.html` and the real valuation Worker against each other up to the WhatsApp lead.
- `worker-safety.test.mjs` — the agent Worker's protections: strict sanitiser, announcement text, GPS/address kept out of Gemini (both channels), the Egyptian-mobile redaction matrix, byte caps and upload limits.
- `agent-page.test.mjs` — `agent.html`: forced dark palette (compared with `style.css`), image-source safety, message escaping, history cap, return-from-valuation banner and hostile parameters, session restore without GPS, identity wording, the 💎 link and button, smart scroll, the on-screen-keyboard viewport lock and 16px input, no analytics.
- `valuation-page.test.mjs` — `tools/valuation.html`: contracts v1/v2, area list and order, area extraction from text, error messages, URL keys and backward compatibility, share link, bounds row, report link.

## Read-only D1 checks (run before the first deployment of a new version)

```sh
npx wrangler d1 execute nasr-market-db --remote --command "PRAGMA table_info('price_snapshots');"
npx wrangler d1 execute nasr-market-db --remote --command "SELECT DISTINCT property_type, transaction_type FROM price_snapshots;"
npx wrangler d1 execute nasr-market-db --remote --command "SELECT typeof(area_id) AS t, COUNT(*) AS n FROM price_snapshots GROUP BY 1;"
npx wrangler d1 execute nasr-market-db --remote --command "SELECT area_id, property_type, transaction_type, COUNT(*) AS n FROM price_snapshots WHERE area_id IN (22,24,25,11,1) GROUP BY area_id, property_type, transaction_type ORDER BY area_id, property_type, transaction_type;"
```

They confirm the real column names (the narrowed read assumes `area_id`), the stored property/transaction values, that `area_id` is stored as integers, and which priority areas (المنطقة السادسة = 22, الثامنة = 24, التاسعة = 25, الحي العاشر = 11, whole city = 1) actually have apartment/sale data. If the whole city lacks a valid snapshot for a type, `MARKET_UNAVAILABLE` is a **data** gap, not a code problem.

## Deploy (run only with the owner's approval and Cloudflare login)

From the repository root, one command deploys the two serving Workers (valuation first):

```sh
npx wrangler deploy --config _worker/wrangler.valuation.toml && npx wrangler deploy --config _worker/wrangler.agent.toml
```

The properties sync Worker deploys from CI (`.github/workflows/deploy-properties-sync.yml`) with the repository secret `CLOUDFLARE_API_TOKEN` (`+ CLOUDFLARE_ACCOUNT_ID`, optional `SYNC_TOKEN`), and the same workflow runs the live verification: `GET /schema`, counts of `listings` and `price_snapshots` before and after, a dry run, two real sync runs to prove idempotency, a duplicate query, `PRAGMA foreign_key_check` / `PRAGMA integrity_check`, and the source-9 sample rows. Locally it is the same single command:

```sh
npx wrangler deploy --config _worker/wrangler.sync.toml
```

The site itself (`agent.html`, `tools/valuation.html`) is published by GitHub Pages when the change is merged to `master` (`.github/workflows/deploy.yml`). All contract changes are additive, so either order works; deploy the Workers first to be safe.

## Post-deploy smoke checks

1. `GET https://noisy-bush-fd84.footcai-555.workers.dev/areas` → `"version":"v6.2"`, `"api_contract":"d1-price-snapshots-v2"`, 31 areas, whole city first. `GET https://royal-snow-ea32.footcai-555.workers.dev/` → `{"error":"Method not allowed"}` (the agent Worker is POST-only).
2. Valuation API (cases 1–7 and 9 of the acceptance list):

```sh
API=https://noisy-bush-fd84.footcai-555.workers.dev
post() { echo "--- $1"; curl -sS -i -X POST "$API/api" -H "Content-Type: application/json" -d "$1"; echo; }
for A in "المنطقة السادسة" "المنطقة الثامنة" "المنطقة التاسعة" "الحي العاشر"; do
  post "{\"area\":\"$A\",\"areaType\":\"sale\",\"propertyType\":\"شقة\",\"size\":180}"          # cases 1–4: 200, or 200 + fallback_used
done
post '{"area":"المنطقة السادسة","areaType":"rent","propertyType":"شقة","size":120,"rentCondition":"furnished"}'     # case 5
post '{"area":"المنطقة السادسة","areaType":"rent","propertyType":"شقة","size":120,"rentCondition":"unfurnished"}'   # case 6
post '{"area":"المنطقة السادسة","areaType":"sale","propertyType":"مخزن","size":200}'              # case 7: 503 MARKET_UNAVAILABLE (or 200 + fallback_used)
post '{"area":"المنطقة السادسة","areaType":"sale","propertyType":"شقة","size":0}'                 # case 9: 400 INVALID_AREA_SIZE + available_areas
post '{"area":"منطقة وهمية","areaType":"sale","propertyType":"شقة","size":100}'                   # 400 AREA_NOT_FOUND + available_areas
```

   A `200` with `"fallback_used":false` means the area has its own snapshot; `fallback_used:true` or a `503` for apartment + sale means a **data** gap (see the D1 checks above).
3. In the browser: empty size and size `0` show "⚠️ أدخل مساحة صحيحة" with no request (cases 8–9); with the network off the tool shows "تعذر الاتصال بخدمة التقييم" (case 10); open `/tools/valuation.html?from=agent&journey=seller&area=ابراهيم نواره المنطقه السادسه&size=180&type=apartment&deal=sale` → area auto-selected and the valuation runs (case 11); use "الرجوع للوكيل" → the agent shows the card with P25–P75 (case 12); finish an owner request after returning → the WhatsApp message contains the "💎 التقييم السوقي (استرشادي)" section (case 13).
4. On a real phone: scroll up in the chat and wait for a reply — the view must not jump and the "للأسفل" button appears (case 14); focus the input — header and input bar stay in view, nothing zooms or shifts (case 15).
5. Cases 16–17 (no GPS and no phone number in any Gemini prompt) are covered by the automated tests; they cannot be observed live.

**R1 completion (area_id):** when an in-scope file has no clear sub-area match, `area_id` must be `NULL` — never a Nasr-City fallback. If an older ingestion had already stored a value there, the sync Worker now clears that column to `NULL` for the row it manages (`SYNC_CLEAR_UNMATCHED_AREA=0` turns the clearing off) and reports it in `area_cleared` / the run summary. Rows outside the scope are never touched. Every `properties_sync_state` row records the Worker version that produced it (`content_hash` is stored as `<version>:<sha256>`), so deploying a new version automatically re-processes the affected files — spread over as many runs as the fetch budget needs — and a file is only skipped again once it was handled by the current version.
