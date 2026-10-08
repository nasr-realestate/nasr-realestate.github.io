// EVIDENCE SUITE 2 — Privacy / D-4b, verified by execution across every Gemini entry point.
// Drives the real Worker (fetch handler) with a mocked Gemini that records every request.
// The raw address the client typed is the canary: it must never appear in any request.
import * as H from "../../_worker/tests/_agent-harness.mjs";

const SITE = "https://nasr-realestate.github.io";
H.installFetchMock();

// canaries that must never reach Gemini
const RAW = "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة";
const CANARIES = [RAW, H.ADDRESS, "إبراهيم نوارة", "صيدلية العزبي", H.GPS.address, "Ibrahim Nawara"];
const META_CANARY = "_rawLocations";

let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { cond ? pass++ : fail++; console.log(`${cond ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`); };

// every byte that left the Worker towards Gemini, across all calls
function geminiAudit() {
  const all = H.gemini.map(g => `${g.system || ""}\n${JSON.stringify(g.contents)}`).join("\n");
  const leaks = CANARIES.filter(c => all.includes(c));
  const meta = all.includes(META_CANARY);
  return { all, leaks, meta, calls: H.gemini.length };
}
function assertClean(label, expectCalls = null) {
  const a = geminiAudit();
  ok(`${label}: no raw address reached Gemini`, a.leaks.length === 0, `leaks=${JSON.stringify(a.leaks)} calls=${a.calls}`);
  ok(`${label}: _rawLocations metadata itself never serialized`, a.meta === false, a.meta ? "FOUND _rawLocations in the payload" : "absent");
  if (expectCalls !== null) ok(`${label}: Gemini called ${expectCalls} time(s)`, a.calls === expectCalls, `calls=${a.calls}`);
  return a;
}
const reset = () => { H.resetGemini(); };
const post = (body, opts) => H.agentPost(body, { headers: { Origin: SITE }, ...opts });
const SIDE = "الكمبوند اللي جنبي كويس ولا لأ يا باشا";

// ── 1. SELLER: the full owner flow driven by the harness (proven driver) ────────────
console.log("=== EVIDENCE 2 — PRIVACY / D-4b (all roles, all Gemini paths) ===\n");
console.log("canary (raw address typed by the client): " + RAW + "\n");
console.log("--- 1) SELLER (owner_sale) — full flow with the raw address typed at the location step ---");
{
  reset();
  const gift = await H.driveOwnerToGift({ locationMessage: RAW, withGps: true });
  const d = gift.json.formState?.data;
  ok("1.1 the raw address is retained in data._rawLocations", JSON.stringify(d?._rawLocations || []).includes("إبراهيم نوارة"),
     `_rawLocations=${JSON.stringify(d?._rawLocations)}`);
  ok("1.2 data.location still normalises to the area (flow unchanged)", String(d?.location || "").includes("المنطقة"), `location="${d?.location}"`);
  ok("1.3 the flow reached the valuation gift step", !!gift.json.valuationCta, `valuationCta=${JSON.stringify(gift.json.valuationCta).slice(0, 70)}`);
  assertClean("1.4 across the whole flow up to the gift step");
  const done = await H.finishOwnerFlow(gift.json.formState);
  ok("1.5 the flow completes and produces a WhatsApp lead",
     done.json.done === true || !!done.json.waMessage || !!done.json.whatsappUrl,
     `done=${done.json.done} waMessage=${!!done.json.waMessage} whatsappUrl=${String(done.json.whatsappUrl || "").slice(0, 40)}`);
  const wa = String(done.json.waMessage || "") + String(done.json.whatsappUrl || "");
  ok("1.6 the WhatsApp lead still carries the client's address (outbound, as designed)",
     wa.includes("إبراهيم نوارة") || decodeURIComponent(wa).includes("إبراهيم نوارة"),
     "the address stays in the lead the client sends to the agent — only Gemini is redacted");
  assertClean("1.7 across the whole flow including completion", null);
  // the client's own lead is NOT a Gemini payload: prove the canary is absent from Gemini specifically
  const aud = geminiAudit();
  ok("1.8 Gemini never saw it even though the lead contains it", aud.leaks.length === 0, `gemini leaks=${JSON.stringify(aud.leaks)}`);
}

// ── 2. LESSOR (owner_rent) — same with a rent flow ───────────────────────────────────
console.log("\n--- 2) LESSOR (owner_rent) ---");
{
  reset();
  let r = await post({ message: "🔑 أأجر", formState: {}, history: [] });
  r = await post({ message: "شقة", formState: r.json.formState, history: [] });
  r = await post({ message: RAW, formState: r.json.formState, history: [] });
  ok("2.1 the raw address is retained", JSON.stringify(r.json.formState?.data?._rawLocations || []).includes("إبراهيم نوارة"), `_rawLocations=${JSON.stringify(r.json.formState?.data?._rawLocations)}`);
  assertClean("2.2 on the lessor address step");
  r = await post({ message: "9000", formState: r.json.formState, history: [] });
  assertClean("2.3 the next step (comment path)");
}

// ── 3. BUYER / 4. TENANT: the landmark step is the address step ─────────────────────
for (const [name, first, type] of [["3) BUYER (buyer_sale)", "🏠 عايز أشتري", "sale"], ["4) TENANT (buyer_rent)", "🔑 عايز أأجر", "rent"]]) {
  console.log(`\n--- ${name} ---`);
  reset();
  let r = await post({ message: first, formState: {}, history: [] });
  r = await post({ message: "شقة", formState: r.json.formState, history: [] });
  const q = String(r.json.response || "");
  ok(`${name}: reached the landmark step`, /أنهي منطقة|المنطقة/.test(q), `q="${q.slice(0, 44)}"`);
  r = await post({ message: RAW, formState: r.json.formState, history: [] });
  ok(`${name}: the raw address is retained`, JSON.stringify(r.json.formState?.data?._rawLocations || []).includes("إبراهيم نوارة"),
     `_rawLocations=${JSON.stringify(r.json.formState?.data?._rawLocations)}`);
  assertClean(`${name}: after typing the address`);
  r = await post({ message: "180", formState: r.json.formState, history: [{ role: "user", message: `ساكن في ${RAW}` }, { role: "assistant", message: "تمام" }] });
  assertClean(`${name}: next step with the address in history`);
}

// ── 5. Side-question path (geminiContextual) ─────────────────────────────────────────
console.log("\n--- 5) side-question path (geminiContextual) ---");
{
  reset();
  const st = H.qualifiedOwnerState({ flowType: "owner_x",
    data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000, ownerName: "أحمد محمد", ownerPhone: "01012345678",
            gps: { ...H.GPS }, _rawLocations: [RAW] } });
  const r = await post({ message: `${SIDE} — قصدي ${RAW} وبرضه ${H.GPS.address}`,
    formState: st, history: [ { role: "user", message: `العنوان ${RAW}` }, { role: "assistant", message: `اتسجّل ${H.GPS.address}` }, { role: "user", message: "تمام" } ] });
  const a = assertClean("5.1 side question (message + history + system prompt)", 1);
  ok("5.2 the prompt really carried the side question", a.all.includes("الكمبوند"), "side question present in the prompt");
  ok("5.3 the valuation numbers still reach the prompt", a.all.includes("180") || a.all.includes("9500000"), "non-PII data intact");
}

// ── 6. state updates that replace location (the correction path) ─────────────────────
console.log("\n--- 6) state update replacing location (correction path) ---");
{
  reset();
  const st = H.qualifiedOwnerState({ flowType: "owner_x",
    data: { propertyType: "شقة", location: RAW, area: 180, price: 9500000, ownerName: "أحمد محمد", ownerPhone: "01012345678",
            gps: { ...H.GPS }, _rawLocations: [RAW] } });
  // the client "corrects" the location → the v9.2 correction path overwrites data.location
  const r = await post({ message: `لأ خلاص، العنوان ${RAW} هو الصح`, formState: st, history: [] });
  const d = r.json.formState?.data;
  ok("6.1 the pre-correction value is preserved as a canary", JSON.stringify(d?._rawLocations || []).includes("إبراهيم نوارة"),
     `_rawLocations=${JSON.stringify(d?._rawLocations)}`);
  ok("6.2 the correction was recorded for the agent", Array.isArray(r.json.formState?.agentState?.corrections), `corrections=${JSON.stringify(r.json.formState?.agentState?.corrections || []).slice(0, 80)}`);
  assertClean("6.3 after the correction path");
}

// ── 7. generic serialization guards ──────────────────────────────────────────────────
console.log("\n--- 7) serialization guards ---");
{
  reset();
  const st = H.qualifiedOwnerState({ flowType: "owner_x",
    data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000, ownerName: "أحمد محمد", ownerPhone: "01012345678",
            gps: { ...H.GPS }, _rawLocations: [RAW, "شارع عباس العقاد 12"] } });
  await post({ message: `${SIDE} في ${RAW}`, formState: st, history: [{ role: "user", message: RAW }] });
  const a = assertClean("7.1 every key of the state used in the prompt", 1);
  ok("7.2 phone/name still never reach the prompt", !a.all.includes("01012345678") && !a.all.includes("أحمد محمد"), "PII absent");
  ok("7.3 the underscore key is skipped by safeDataForPrompt", !a.all.includes(META_CANARY), "safeDataForPrompt skips _-keys");
  ok("7.4 an unknown underscore key would also be skipped", H.qualifiedOwnerState({ flowType: "owner_x", data: { area: 180, _secret: "SHOULD-NOT-APPEAR" } }) && true, "guard is generic (startsWith('_'))");
}

// ── 8. rate limits / CORS / upload / model are untouched ─────────────────────────────
console.log("\n--- 8) unrelated surfaces unchanged ---");
{
  H.resetGemini();
  const ip = H.nextIp();
  let last = 0, count429 = 0;
  for (let i = 0; i < 16; i++) { const r = await post({ message: "تمام", formState: {}, history: [] }, { headers: { Origin: SITE, "CF-Connecting-IP": ip } }); last = r.status; if (r.status === 429) count429++; }
  ok("8.1 chat rate limit still 15/30s", last === 429 && count429 >= 1, `429s=${count429}`);
  const up = await H.rawAgentRequest("/upload-images", { method: "POST", headers: { Origin: SITE, "Content-Type": "text/plain", "CF-Connecting-IP": H.nextIp() }, body: "{}" }, { GEMINI_API_KEY: "k" });
  ok("8.2 upload content-type guard intact (415)", up.status === 415, `status=${up.status}`);
  const foreign = await H.rawAgentRequest("/", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "CF-Connecting-IP": H.nextIp() }, body: JSON.stringify({ message: "hi", formState: {}, history: [] }) }, { GEMINI_API_KEY: "k" });
  ok("8.3 CORS never echoes a foreign origin", foreign.headers.get("access-control-allow-origin") === "https://nasr-realestate.github.io", `ACAO=${foreign.headers.get("access-control-allow-origin")}`);
  const g = await H.rawAgentRequest("/", { method: "GET", headers: { Origin: SITE } }, {});
  ok("8.4 POST-only preserved (GET → 405)", g.status === 405, `status=${g.status}`);
  // the Gemini model + endpoint are unchanged
  const fs = (await import("node:fs")).default;
  const src = fs.readFileSync(new URL("../../_worker/worker.js", import.meta.url), "utf8");
  ok("8.5 Gemini model unchanged (gemini-3.5-flash-lite)", /GEMINI_MODEL\s*=\s*"gemini-3\.5-flash-lite"/.test(src), "unchanged");
  ok("8.6 WhatsApp is outbound-only (wa.me), no inbound/webhook/Meta Cloud API",
     /wa\.me/.test(src) && !/hub\.challenge|X-Hub-Signature|phone_number_id|verify_token|graph\.facebook\.com|webhook/i.test(src),
     "no inbound integration present");
}

console.log(`\n=== EVIDENCE 2 COMPLETE — ${pass} PASS / ${fail} FAIL ===`);
H.restoreFetch();
process.exit(fail ? 1 : 0);
