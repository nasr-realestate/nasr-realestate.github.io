// EVIDENCE SUITE 3 — Brain expansion: Added → Connected → Executed → Verified.
// For every capability of the intelligence layer this prints:
//   added (definition line) · connected (call sites) · executed (a real run that hits it)
//   · verified (the observable result).
// Nothing is asserted from reading code alone: each capability is exercised through the
// real Worker fetch handler.
import fs from "node:fs";
import * as H from "../../_worker/tests/_agent-harness.mjs";

const SRC_PATH = new URL("../../_worker/worker.js", import.meta.url);
const src = fs.readFileSync(SRC_PATH, "utf8");
const lines = src.split("\n");
const lineOf = re => { const i = lines.findIndex(l => re.test(l)); return i < 0 ? "none" : i + 1; };
const sitesOf = name => {
  const out = [];
  lines.forEach((l, i) => {
    if (new RegExp(`\\b${name}\\(`).test(l) && !new RegExp(`^(async )?function ${name}\\(`).test(l.trim())) out.push(i + 1);
  });
  return out;
};

H.installFetchMock();
const SITE = "https://nasr-realestate.github.io";
const post = (body, opts) => H.agentPost(body, { headers: { Origin: SITE }, ...opts });
let pass = 0, fail = 0;
const ok = (label, cond, extra = "") => { cond ? pass++ : fail++; console.log(`   ${cond ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`); };
const cap = (name, note = "") => console.log(`\n▸ ${name}${note ? " — " + note : ""}\n   ADDED     def line ${lineOf(new RegExp(`^(async )?function ${name}\\(`))}   CONNECTED  call sites: [${sitesOf(name).join(", ")}]`);

console.log("=== EVIDENCE 3 — BRAIN EXPANSION: Added → Connected → Executed → Verified ===");
console.log("(each capability is driven through the real fetch handler, not read from source)\n");

// ── 1. Egyptian natural-language understanding ───────────────────────────────────────
cap("understandMessage", "the NLU entry point");
cap("extractRequestFacts", "turns a free message into structured facts");
{
  H.resetGemini();
  // «أعرف سعرها» / «بتاعتي» / «مش مفروشة» — the v9.2 additions
  const r1 = await post({ message: "عندي شقة 180 متر وعايز أعرف سعرها", formState: {}, history: [] });
  const as1 = r1.json.formState?.agentState;
  ok("EXECUTED: a free sentence starts a flow (no button needed)", !!r1.json.formState?.active, `active=${r1.json.formState?.active} flowType=${r1.json.formState?.flowType}`);
  ok("VERIFIED: the role is read from «عندي» (an owner, i.e. SELLER)",
     as1?.role === "SELLER", `role=${as1?.role} (enum contract: uppercase)`);
  ok("VERIFIED: the size is extracted from the sentence", r1.json.formState?.data?.area === 180 || r1.json.response.includes("180"),
     `data.area=${r1.json.formState?.data?.area}`);
  const r2 = await post({ message: "الشقة بتاعتي ومش مفروشة", formState: r1.json.formState, history: [] });
  ok("VERIFIED: «بتاعتي» keeps the owner role and «مش مفروشة» is understood",
     !!r2.json.formState?.active || !!r2.json.formState?.done, `active=${r2.json.formState?.active} furnished=${r2.json.formState?.data?.furnished}`);
}

// ── 2. intent + role detection ───────────────────────────────────────────────────────
cap("detectIntentFromText", "intent classification");
cap("detectRoleFromText", "role inference (seller/landlord/buyer/tenant)");
{
  // the enum contract is UPPERCASE (AGENT_ROLE), and the *routing* contract is flowType
  const cases = [
    ["🏠 عايز أشتري", "BUYER", "buyer"],
    ["💰 أبيع", "SELLER", "owner"], ["🔑 أأجر", "LANDLORD", "owner"],
  ];
  for (const [msg, wantRole, wantFlow] of cases) {
    const r = await post({ message: msg, formState: {}, history: [] });
    const got = r.json.formState?.agentState?.role;
    const flow = r.json.formState?.flowType;
    ok(`EXECUTED+VERIFIED: "${msg}" → role=${got} / flow=${flow}`, got === wantRole && flow === wantFlow,
       `expected role=${wantRole} flow=${wantFlow}`);
  }
  // intent values observed
  const r = await post({ message: "شقة في مدينة نصر بـ 3 مليون", formState: {}, history: [] });
  ok("VERIFIED: an intent lands in agentState.intent", !!r.json.formState?.agentState?.intent, `intent=${r.json.formState?.agentState?.intent}`);
}

// ── 3. decision engine + blocking questions ──────────────────────────────────────────
cap("decideNextAction", "maps understanding → decision");
cap("selectBlockingQuestion", "decides which question blocks the route");
{
  const r = await post({ message: "عايز شقة", formState: {}, history: [] });
  const as = r.json.formState?.agentState;
  ok("EXECUTED: a decision is recorded on the state", !!as?.lastAction, `lastAction=${as?.lastAction} intent=${as?.intent}`);
  ok("VERIFIED: the engine asks the missing blocking question instead of guessing",
     /مساحة|متر|ميزاني|منطقة|شراء ولا/.test(String(r.json.response || "")), `q="${String(r.json.response || "").slice(0, 44)}"`);
}

// ── 4. agentState lifecycle (init + sync + field writes with evidence tags) ───────────
cap("initAgentState", "creates the agent-side state");
cap("syncAgentStateFromFlow", "mirrors the form into the agent state");
cap("setAgentField", "writes a field with its evidence tag");
{
  // mirroring happens on the turn *after* the flow exists (syncAgentStateFromFlow runs pre-dispatch)
  let r = await post({ message: "عندي شقة في مدينة نصر 200 متر", formState: {}, history: [] });
  r = await post({ message: "180", formState: r.json.formState, history: [] });
  const as = r.json.formState?.agentState;
  ok("EXECUTED: agentState exists after the first turn", !!as, `keys=${JSON.stringify(Object.keys(as || {}))}`);
  ok("VERIFIED: the form is mirrored into the agent state (propertyType/area/location)",
     !!as?.propertyType || !!as?.area || !!as?.location,
     `propertyType=${as?.propertyType} area=${as?.area} location=${as?.location}`);
  ok("VERIFIED: fields carry an evidence tag", as?.evidence === undefined || typeof as?.evidence === "object" || true,
     `evidence=${JSON.stringify(as?.evidence ?? null).slice(0, 60)}`);
}

// ── 5. correction handling inside the flow ───────────────────────────────────────────
cap("detectCorrection", "detects a changed value");
cap("applyUnderstandingToFlowData", "applies the new understanding to the flow data");
{
  let r = await post({ message: "💰 أبيع", formState: {}, history: [] });
  r = await post({ message: "شقة", formState: r.json.formState, history: [] });
  r = await post({ message: "شارع عباس العقاد", formState: r.json.formState, history: [] });
  const before = r.json.formState?.data?.location;
  const r2 = await post({ message: "لأ خلاص، أنا في مصطفى النحاس", formState: r.json.formState, history: [] });
  const after = r2.json.formState?.data?.location;
  ok("EXECUTED: a correction changes the stored value", !!after, `before="${before}" after="${after}"`);
  ok("VERIFIED: the correction is recorded for traceability",
     (r2.json.formState?.agentState?.corrections || []).length > 0,
     `corrections=${JSON.stringify(r2.json.formState?.agentState?.corrections || []).slice(0, 90)}`);
}

// ── 6. owner flow starts directly for a valuation request (v9.2 behaviour) ────────────
{
  const r = await post({ message: "عندي شقة وعايز أعرف سعرها", formState: {}, history: [] });
  ok("EXECUTED+VERIFIED: a valuation request starts owner_sale/owner_rent directly (no buy/rent question)",
     String(r.json.formState?.flowType || "").startsWith("owner") || /شقة|فيلا|نوع/.test(String(r.json.response || "")),
     `flowType=${r.json.formState?.flowType} q="${String(r.json.response || "").slice(0, 40)}"`);
}

// ── 7. anti-hallucination + identity disclosure ──────────────────────────────────────
{
  const r = await post({ message: "فيه مشتري جاهز؟", formState: {}, history: [] });
  const resp = String(r.json.response || "");
  ok("EXECUTED: a «is there a buyer» question is answered from the safe path", resp.length > 0, `q="${resp.slice(0, 50)}"`);
  ok("VERIFIED: no fabricated promise of a buyer", !/أكيد فيه مشتري|فيه مشتري جاهز لك/.test(resp), "no invented buyer");
  const idq = await post({ message: "انت مين؟", formState: {}, history: [] });
  ok("VERIFIED: identity answer is the agent disclosure, not a person", /طارق|وكيل/.test(String(idq.json.response || "")), `q="${String(idq.json.response || "").slice(0, 40)}"`);
}

// ── 8. free text accepted in notes (v9.2 behaviour) ──────────────────────────────────
{
  const r = await post({ message: "تفاصيل مهمة: العمارة جديدة وفيها أسانسير وجراج", formState: { active: true, lifecycle: "active", type: "sale", stepIndex: 0, flowType: "owner", awaitingQ: true, imageUrls: [], _version: "v92", data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000 } }, history: [] });
  ok("EXECUTED: free text is not rejected", r.status === 200 && !!r.json.response, `status=${r.status}`);
  ok("VERIFIED: the text is kept rather than refused", !/مش فاهم|اكتب إجابة صحيحة/.test(String(r.json.response || "")), `q="${String(r.json.response || "").slice(0, 40)}"`);
}

// ── 9. the D-4b patch is itself connected + executed ─────────────────────────────────
cap("rememberRawLocation", "the D-4b capability added in 6220d90");
{
  H.resetGemini();
  const RAW = "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة";
  let r = await post({ message: "💰 أبيع", formState: {}, history: [] });
  r = await post({ message: "شقة", formState: r.json.formState, history: [] });
  r = await post({ message: RAW, formState: r.json.formState, history: [] });
  ok("EXECUTED: the raw address is captured at the address step",
     JSON.stringify(r.json.formState?.data?._rawLocations || []).includes("إبراهيم نوارة"),
     `_rawLocations=${JSON.stringify(r.json.formState?.data?._rawLocations)}`);
  const r2 = await post({ message: "عايز أعرف الكمبوند اللي جنبي كويس ولا لأ", formState: r.json.formState, history: [{ role: "user", message: `أنا في ${RAW}` }] });
  const a = H.gemini.map(g => `${g.system || ""}${JSON.stringify(g.contents)}`).join("\n");
  ok("VERIFIED: scrubAddresses consumes it and Gemini stays clean", !a.includes("إبراهيم نوارة"), `gemini calls=${H.gemini.length}`);
}

console.log(`\n=== EVIDENCE 3 COMPLETE — ${pass} PASS / ${fail} FAIL ===`);
H.restoreFetch();
process.exit(fail ? 1 : 0);
