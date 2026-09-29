# Cloudflare Worker deployment notes

Both Workers are configured to use the existing `nasr-market-db` D1 database through the `DB` binding. The shared `_worker/market-data.js` module reads market aggregates from `price_snapshots`; it does not read `listings` or the static `market-data.json` file. The valuation page may project only names/levels/landmarks/streets from that old JSON for descriptive display—never prices, confidence, or valuation fallbacks. The agent's active-property search remains on `ai-feed.json`.

## Which file belongs to which Cloudflare Worker

| Repository file | Wrangler config | Cloudflare Worker | Role |
| --- | --- | --- | --- |
| `_worker/worker.js` | `_worker/wrangler.agent.toml` (`main = "worker.js"`) | `royal-snow-ea32` | The conversational agent used by `agent.html` |
| `_worker/valuation-worker.js` | `_worker/wrangler.valuation.toml` (`main = "valuation-worker.js"`) | `noisy-bush-fd84` | The valuation API (`/areas`, `/api`) used by `tools/valuation.html` |
| `_worker/market-data.js` | — (no config of its own) | shared by **both** Workers | Read-only D1 access to `price_snapshots` / `areas` |

`_worker/market-data.js` is **not** a Worker and has no Wrangler file. It is an ES module imported by both entrypoints:

- `_worker/valuation-worker.js` → `import { calculateMarketTotals, getMarketSnapshot, listMarketAreas, normalizePropertyType, normalizeTransaction } from "./market-data.js";`
- `_worker/worker.js` → `import { calculateMarketTotals, findAreaMention, findAreaName, getMarketSnapshot, listMarketAreas, normalizeArabic, normalizePropertyType, normalizeRentCondition, normalizeTransaction } from "./market-data.js";`

**Deployment consequence:** uploading or pasting a single entrypoint file is *not* sufficient. `npx wrangler deploy` bundles the relative import automatically, but any method that only transfers one file (dashboard "Quick edit", copy/paste of `valuation-worker.js` alone, a single-file upload) will fail at runtime with an unresolved-module error, or silently keep an older `market-data.js` behind. Always deploy the whole `_worker/` directory through Wrangler, and never move `market-data.js` out of the folder that holds the two entrypoints.

Bindings and settings required by both Workers: the `DB` D1 binding to `nasr-market-db` (already declared in both TOML files), `compatibility_date = "2026-09-01"`, and `workers_dev = true`. No KV, R2, queue, route or vars entry is needed. Secrets: only the **agent** Worker needs `GEMINI_API_KEY` and `IMGBB_API_KEY` (set with `npx wrangler secret put …`, never stored in this repository); the **valuation** Worker needs no secret at all. `ALLOWED_ORIGINS` is an optional comma-separated plain variable for extra CORS origins — the site origin is already allowed by default in code.

## Valuation → agent handoff (`valuationResult`)

`tools/valuation.html` builds a "back to agent" link (`/agent.html?return=valuation&estimate=…&confidence=…&samples=…&perMeter=…&area=…&size=…`), `agent.html` re-reads those params into `state.valuationResult` and sends the field in every chat POST to the agent Worker. `_worker/worker.js` now consumes it under these rules:

- **Untrusted input.** The value comes from the browser, so anyone can edit it. It is never treated as a confirmed valuation. Full server-side verification is impossible with the current return contract, because the link carries no property type, transaction or furnishing state — so the number cannot be recomputed from D1 and compared. The prompt therefore states explicitly that the figure is client-reported and unverified.
- **Validated shape and bounds.** `sanitizeValuationResult()` requires a plain object, a positive `estimate` (≤ 1e11), a finite `savedAt` inside the same 24 h window `agent.html` uses, `size` within 20–100000 (the tool's own limits), `perMeter` ≤ 1e7, `samples` ≤ 100000, and `confidence` from the whitelist `high|medium|low|unknown` (anything else degrades to `unknown`). A field that is present but out of range rejects the whole payload.
- **Internal consistency.** Because the page derives both numbers from the same `price_per_meter`, `estimate` must equal `perMeter × size` within the page's own rounding tolerance; otherwise the payload is treated as tampered with or corrupt and dropped entirely.
- **No raw browser text in the prompt.** The reported `area` is only used as a lookup key against the D1 market-area list (`canonicalMarketArea()`); the prompt prints the canonical name *from D1* or states that the reported area does not match the current market list. HTML, backticks, markup and injected instructions therefore never reach the system prompt. Area matching keeps `المنطقة الأولى` distinct from `الحي الأول`.
- **Bounded output shape.** The sanitized object has exactly seven keys, so smuggled fields (name, phone, GPS, free text) are dropped and no extra personal or location data is forwarded to the model.
- **No behaviour change elsewhere.** The value is never stored in `formState`, never added to `leadData`, `waMessage` or `whatsappUrl`, and never touches the deterministic D1 price path. It is appended only to the conversational Gemini system prompts (`geminiFirstMsg`, `geminiComment`, `geminiContextual`), with instructions to keep qualifying the request as usual. The comment cache key includes the estimate so two clients never share a reply that referenced the other's number.

## Local checks

Run the D1/Worker integration fixtures (no real D1 rows or credentials are included):

```sh
node --experimental-default-type=module --test _worker/tests/*.test.mjs
```

Syntax check every Worker file and test file:

```sh
for f in _worker/*.js _worker/tests/*.mjs; do node --check "$f"; done
```

What each fixture covers:

- `_worker/tests/market-integration.test.mjs` — D1 area separation and aliases, snapshot pricing (avg/median, min/max), the valuation Worker's `/areas` + `/api` contract, the agent's valuation CTA, and `ai-feed.json` listing behaviour when D1 has no row.
- `_worker/tests/valuation-page.test.mjs` — `tools/valuation.html`: D1-contract gate, area resolution, description-only use of the legacy JSON, agent prefill, and the shared WhatsApp report (including its re-open link).
- `_worker/tests/valuation-handoff.test.mjs` — the `valuationResult` handoff: accepted payload, malformed/out-of-range/stale/self-contradictory payloads, confidence whitelist, fixed output shape with no PII or GPS, prompt-injection attempts in `area`, D1-only area canonicalisation, the qualified-lead and deterministic-D1 paths staying byte-identical, and the valuation Worker still declaring `v4.0` / `d1-price-snapshots-v1`.

## Required existing agent secrets

Do not put secret values in these files. Before an approved deployment, verify that the existing Cloudflare Worker still has its current secrets configured (the agent uses `GEMINI_API_KEY` and `IMGBB_API_KEY`). The valuation Worker does not need an API key.

## Read-only D1 schema check

Before deployment, compare the real column names against `_worker/market-data.js` (the reader introspects them, but this check confirms which optional sample/period/range fields exist):

```sh
npx wrangler d1 execute nasr-market-db --remote --command "PRAGMA table_info('price_snapshots');"
npx wrangler d1 execute nasr-market-db --remote --command "SELECT COUNT(*) AS total FROM price_snapshots;"
```

## Deploy commands (run only after explicit approval)

From the repository root:

```sh
npx wrangler deploy --config _worker/wrangler.agent.toml
npx wrangler deploy --config _worker/wrangler.valuation.toml
```

These target the existing Worker names and bind both to the provided D1 database. Do not run them before the user's explicit approval.

## Post-deployment smoke checks

Preparation note (verified 2026-09-29 from the sandbox over the public internet): `GET https://noisy-bush-fd84.footcai-555.workers.dev/areas` now answers `{"service":"nasr-valuation","status":"running","version":"v4.0","api_contract":"d1-price-snapshots-v1","areas":31,…,"data_source":"price_snapshots","source_table":"price_snapshots"}` and lists 31 area names including both `المنطقة الأولى` and `الحي الأول` as separate entries. The deployed valuation Worker therefore already matches the `v4.0` / `d1-price-snapshots-v1` source in this repository, so `_worker/valuation-worker.js` needs **no** change for the handoff work. `GET https://royal-snow-ea32.footcai-555.workers.dev/` answers `{"error":"Method not allowed"}`, i.e. the agent Worker is live and POST-only as coded. A live `POST /api` could not be exercised from the sandbox (outbound TLS to `*.workers.dev` is blocked for `curl`, only GET fetches succeeded), so re-verify the POST contract after an approved rollout. The earlier note about the endpoint reporting `v3.0` is obsolete.

- `GET https://noisy-bush-fd84.footcai-555.workers.dev/areas` should report `v4.0`, contract `d1-price-snapshots-v1`, and the D1-provided `available_areas` list; the page uses this named path rather than assuming the root response shape.
- `POST https://noisy-bush-fd84.footcai-555.workers.dev/api` an apartment-sale request for `المنطقة الأولى` and `ممر مكرم عبيد`, each at `180` m²; verify each response identifies `source_table: price_snapshots` and contains its own D1 source, period, sample count, price/m², and range.
- Try a property/operation with no suitable D1 row (for example, villa sale) and confirm the API returns an insufficient/unsupported-data response with no estimate.
- Verify the agent still returns the existing active-listing flow, and that valuation/sale intent responses add a separate `قيّم عقارك` navigation button without changing the agent's qualified WhatsApp payload.
- Handoff check: run a valuation in `tools/valuation.html` from the agent (so the back button carries `from=agent`), return to `agent.html`, then send an ordinary message. The agent may refer to the number conversationally but must call it indicative/unconfirmed, must not add it to the WhatsApp message or the qualified lead, and must keep asking the normal qualification questions.
- Negative handoff check: replay the same chat POST with `valuationResult` edited in devtools (for example `estimate` multiplied by 10 while `perMeter`/`size` stay unchanged, or `savedAt` set 48 h in the past, or `area` set to `<script>alert(1)</script>`). The reply must be indistinguishable from a request with no `valuationResult`, and no markup may appear anywhere in the answer.
