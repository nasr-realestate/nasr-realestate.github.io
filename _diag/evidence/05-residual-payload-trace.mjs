// DIAGNOSTIC — RESIDUAL payload trace (read-only, no product code changes).
//
// Question: does a raw address that was typed OUTSIDE the address step (or in a state with no
// `_rawLocations`) actually reach the Gemini request payload?
//
// Method: drive the real Worker through its fetch handler, capture EVERY Gemini request body
// (system prompt + contents), and search for the canary and its distinctive fragments.
// The canary is the one from the task: شارع إبراهيم نوارة بجوار صيدلية العزبي
//
// Roles: SELLER (owner/sale) · LESSOR (owner/rent) · BUYER (buyer/sale) · TENANT (tenant/rent)
// Paths : normal answer at a non-address step · correction · free-text/notes · first message ·
//         side question (the documented synthetic residual case).
import * as H from "../../_worker/tests/_agent-harness.mjs";

const CANARY = "شارع إبراهيم نوارة بجوار صيدلية العزبي";
const FRAGMENTS = [
  ["full", CANARY],
  ["street", "شارع إبراهيم نوارة"],
  ["name", "إبراهيم نوارة"],
  ["name-norm", "إبراهيم نواره"],   // the spelling MASTER_LANDMARKS normalises to
  ["pharmacy", "صيدلية العزبي"],
  ["pharmacy-short", "العزبي"],
  ["next-to", "بجوار"],
  // the second address used in S7/S8 (an address that matches no known landmark)
  ["S7-full", "شارع 15 مايو بجوار مسجد الرحمة"],
  ["S7-street", "15 مايو"],
  ["S7-mosque", "مسجد الرحمة"],
];

H.installFetchMock();
const post = (m, fs, extra) => H.agentPost({ message: m, formState: fs, history: [], ...(extra || {}) });
const line = (s, n = 46) => String(s || "").split("\n")[0].slice(0, n);
let TURN = 0;

// which field of a captured Gemini call carries a fragment
function trace(payload) {
  const hits = [];
  const inText = (text, where) => {
    const t = String(text || "");
    for (const [frag, needle] of FRAGMENTS) {
      const at = t.indexOf(needle);
      if (at !== -1) hits.push({ frag, where, context: t.slice(Math.max(0, at - 34), at + needle.length + 22) });
    }
  };
  inText(payload.system, "system");
  (payload.contents || []).forEach((c, i) => {
    (c.parts || []).forEach(p => inText(p.text, `contents[${i}].${c.role}`));
  });
  return hits;
}
const stateCarries = data => Object.entries(data || {})
  .filter(([k, v]) => k !== "_rawLocations" && typeof v === "string" && FRAGMENTS.some(([, n]) => String(v).includes(n)))
  .map(([k, v]) => `${k}="${v}"`);

async function turn(label, msg, fs, extra) {
  H.resetGemini();
  const r = await post(msg, fs, extra);
  TURN += 1;
  const d = r.json.formState?.data || {};
  const raw = Array.isArray(d._rawLocations) ? d._rawLocations : [];
  const calls = H.gemini.map(g => ({ n: H.gemini.indexOf(g) + 1, hits: trace(g) }));
  const leaked = calls.filter(c => c.hits.some(h => h.frag !== "name-norm"));
  console.log(`\n── turn ${TURN} · ${label}`);
  console.log(`   sent   : "${String(msg).slice(0, 58)}"`);
  console.log(`   reply  : "${line(r.json.response)}"`);
  console.log(`   stored : _rawLocations=${raw.length}${raw.length ? ` ${JSON.stringify(raw)}` : ""}${stateCarries(d).length ? " | " + stateCarries(d).join(" | ") : ""}`);
  console.log(`   gemini : ${H.gemini.length} call(s)${H.gemini.length ? "" : " — nothing sent"}`);
  for (const c of calls) {
    if (!c.hits.length) { console.log(`     call ${c.n}: clean`); continue; }
    for (const h of c.hits) console.log(`     call ${c.n}: ${leaked.includes(c) ? "❌ LEAK" : "◻︎ normalised-name only"} [${h.frag}] in ${h.where} … "${h.context}"`);
  }
  return r.json.formState;
}

// ── the four role drivers up to the step right after the address step ─────────────────
async function ownerTo(role, stopAfter) {
  const open = role === "SELLER" ? "💰 أبيع" : "🔑 أأجر";
  const stepMsgs = [["شقة"], ["شارع عباس العقاد"], ["180"], ["9500000"], ["3"], ["2"]];
  let fs = (await post(open, {})).json.formState;
  let r = null;
  for (const [m] of stepMsgs) { r = await post(m, fs); fs = r.json.formState; if (stopAfter && new RegExp(stopAfter).test(String(r.json.response))) return fs; }
  return fs;
}
async function buyerTo(role, stopAfter) {
  const open = role === "BUYER" ? "🏠 عايز أشتري" : "🔑 عايز أأجر";
  let fs = (await post(open, {})).json.formState;
  let r = null;
  for (const m of ["شقة", "المنطقة السادسة", "150", "3000000"]) { r = await post(m, fs); fs = r.json.formState; if (stopAfter && new RegExp(stopAfter).test(String(r.json.response))) return fs; }
  return fs;
}

console.log("════════════════════════════════════════════════════════════════════");
console.log("RESIDUAL PAYLOAD TRACE — canary:", CANARY);
console.log("════════════════════════════════════════════════════════════════════");

// ── S1. reference: the address typed AT the address step, then a side question (D-4b fix) ──
console.log("\n═══ S1 · reference: canary typed AT the location step, then a side question (the fixed path)");
{
  let fs = (await post("💰 أبيع", {})).json.formState;
  fs = await turn("owner: property type", "شقة", fs);
  fs = await turn("owner: canary typed AT the location step", CANARY, fs, { gps: H.GPS });
  fs = await turn("owner: side question at the area step", "المنطقة دي كويسة للاستثمار؟", fs);
}

// ── S2. the canary typed at a NON-address step (same turn ⇒ comment path) ─────────────
console.log("\n═══ S2 · canary typed at a NON-address step (normal path, same turn)");
for (const [role, open, drive, stepLabel, msg] of [
  ["SELLER", "💰 أبيع", ownerTo, "owner at the rooms step", "3 غرف، العنوان " + CANARY],
  ["LESSOR", "🔑 أأجر", ownerTo, "owner(rent) at the rooms step", "3 غرف، العنوان " + CANARY],
]) {
  let fs = (await post(open, {})).json.formState;
  fs = await turn(`${role}: property type`, "شقة", fs);
  fs = await turn(`${role}: a different address at the location step`, "شارع عباس العقاد", fs);
  fs = await turn(`${role}: area`, "180", fs);
  fs = await turn(`${role}: price`, role === "LESSOR" ? "9000" : "9500000", fs);
  await turn(`${role}: ${stepLabel} — canary inside a longer answer`, msg, fs);
}
{
  let fs = (await post("🏠 عايز أشتري", {})).json.formState;
  fs = await turn("BUYER: property type", "شقة", fs);
  fs = await turn("BUYER: landmark step", "المنطقة السادسة", fs);
  await turn("BUYER: at the area step — canary as the answer", CANARY, fs);
}
{
  let fs = (await post("🔑 عايز أأجر", {})).json.formState;
  fs = await turn("TENANT: property type", "شقة", fs);
  fs = await turn("TENANT: landmark step", "المنطقة السادسة", fs);
  await turn("TENANT: at the area step — canary as the answer", CANARY, fs);
}

// ── S3. correction path: the canary given as a correction at a later step ─────────────
console.log("\n═══ S3 · correction path: canary as a correction at a later step");
{
  let fs = (await post("💰 أبيع", {})).json.formState;
  fs = await turn("owner: property type", "شقة", fs);
  fs = await turn("owner: address at the location step", "شارع عباس العقاد", fs);
  fs = await turn("owner: area", "180", fs);
  await turn("owner: correction at the price step", "لأ، قصدي العنوان " + CANARY, fs);
}

// ── S4. free-text step: the canary lands in notes, then any later Gemini call ─────────
console.log("\n═══ S4 · free-text step: canary stored in notes, then a later Gemini call");
{
  let fs = (await post("💰 أبيع", {})).json.formState;
  for (const m of ["شقة", "شارع عباس العقاد", "180", "9500000", "3", "2", "ثالث", "سوبر لوكس"]) {
    fs = await turn(`owner: walking to the notes step ("${m}")`, m, fs);
  }
  fs = await turn("owner: notes step («في أي تفاصيل مهمة تانية؟») — canary stored in data.notes", CANARY, fs);
  fs = await turn("owner: a longer answer at the next step (a comment carries the data snapshot)",
    "اسمي أحمد وعايز أعرف لو فيه رسوم إضافية", fs);
}

// ── S1b. A/B control: the SAME text at a non-address step, but AFTER it passed the address step ──
console.log("\n═══ S1b · control: the same sentence at the area step, after the canary passed the location step");
{
  let fs = (await post("💰 أبيع", {})).json.formState;
  fs = await turn("control: property type", "شقة", fs);
  fs = await turn("control: canary typed AT the location step", CANARY, fs);
  await turn("control: the same canary repeated at the area step", "هو العنوان " + CANARY + " صح؟", fs);
}

// ── S7. buyer landmark step: an address that matches no known landmark is stored RAW ──
console.log("\n═══ S7 · buyer landmark step with an unmatched raw address (stored as-is in data.landmark)");
{
  const RAW2 = "شارع 15 مايو بجوار مسجد الرحمة";
  let fs = (await post("🏠 عايز أشتري", {})).json.formState;
  fs = await turn("buyer: property type", "شقة", fs);
  fs = await turn("buyer: landmark step — unmatched raw address", RAW2, fs);
  console.log(`   data.landmark now: ${JSON.stringify(fs?.data?.landmark)} | _rawLocations: ${JSON.stringify(fs?.data?._rawLocations || [])}`);
  fs = await turn("buyer: area answer", "150", fs);
  await turn("buyer: a longer answer at the budget step (a comment carries the data snapshot)",
    "ميزانيتي حوالي 3 مليون وعايز مساحة كبيرة", fs);
}

// ── S8. first message with an address that carries no real-estate words and no landmark ──
console.log("\n═══ S8 · first message with an address only (nothing extractable ⇒ first-message Gemini path)");
{
  await turn("first message: greeting + unmatched address", "السلام عليكم، أنا ساكن في شارع 15 مايو بجوار مسجد الرحمة");
}

// ── S5. first message containing the canary (no flow yet) ─────────────────────────────
console.log("\n═══ S5 · the canary in the FIRST message (no flow, no _rawLocations at all)");
{
  await turn("first message with a greeting + the canary", "السلام عليكم، أنا في " + CANARY);
  await turn("first message, address only", CANARY);
  await turn("first message, address + real-estate intent", "عندي شقة في " + CANARY + " وعايز أبيعها");
}

// ── S6. the documented synthetic residual (case 6b of the differential) ───────────────
console.log("\n═══ S6 · documented synthetic case: raw address only in the client history, state has no _rawLocations");
{
  const state = H.qualifiedOwnerState({ flowType: "owner_sale", data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000 } });
  const history = [{ role: "user", message: "أنا ساكن في " + CANARY + " وعايز أعرف المنطقة" }, { role: "assistant", message: "تمام" }];
  H.resetGemini();
  const r = await H.agentPost({ message: "المنطقة دي كويسة للاستثمار؟", formState: state, history });
  console.log(`\n── turn (synthetic) · side question with the canary only in history`);
  console.log(`   reply  : "${line(r.json.response)}"`);
  console.log(`   gemini : ${H.gemini.length} call(s)`);
  H.gemini.forEach((g, i) => {
    const hits = trace(g);
    if (!hits.length) { console.log(`     call ${i + 1}: clean`); return; }
    for (const h of hits) console.log(`     call ${i + 1}: ❌ LEAK [${h.frag}] in ${h.where} … "${h.context}"`);
  });
}

H.restoreFetch();
console.log("\n════════════════════════════════════════════════════════════════════");
