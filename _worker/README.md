# Cloudflare Worker deployment notes

Both Workers are configured to use the existing `nasr-market-db` D1 database through the `DB` binding. The shared `_worker/market-data.js` module reads market aggregates from `price_snapshots`; it does not read `listings` or the static `market-data.json` file. The valuation page may project only names/levels/landmarks/streets from that old JSON for descriptive display—never prices, confidence, or valuation fallbacks. The agent's active-property search remains on `ai-feed.json`.

## Local checks

Run the D1/Worker integration fixtures (no real D1 rows or credentials are included):

```sh
node --experimental-default-type=module --test _worker/tests/*.test.mjs
```

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

Preparation note (2026-09-29): the public `/areas` endpoint still reports `v3.0`; it exposes 31 area names and reports 32 `price_snapshots` across 14 areas. This is endpoint metadata, not verification of the live SQL schema. A live POST could not be exercised from the sandbox, so verify the deployed API contract after an approved rollout. The repository source below is `v4.0`.

- `GET https://noisy-bush-fd84.footcai-555.workers.dev/areas` should report `v4.0`, contract `d1-price-snapshots-v1`, and the D1-provided `available_areas` list; the page uses this named path rather than assuming the root response shape.
- `POST https://noisy-bush-fd84.footcai-555.workers.dev/api` an apartment-sale request for `المنطقة الأولى` and `ممر مكرم عبيد`, each at `180` m²; verify each response identifies `source_table: price_snapshots` and contains its own D1 source, period, sample count, price/m², and range.
- Try a property/operation with no suitable D1 row (for example, villa sale) and confirm the API returns an insufficient/unsupported-data response with no estimate.
- Verify the agent still returns the existing active-listing flow, and that valuation/sale intent responses add a separate `قيّم عقارك` navigation button without changing the agent's qualified WhatsApp payload.
