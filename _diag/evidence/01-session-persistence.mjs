// EVIDENCE SUITE 1 — Session persistence (real execution through agent.html's own code).
// Not a repo test: it is an evidence script. It boots the real inline script of agent.html in
// the node:vm DOM sandbox and drives the real functions (sendMsg/loadState/saveState/handoff).
// It asserts nothing about the design — only that a client session survives what the owner requires.
import { bootAgent } from "../../_worker/tests/_dom-agent.mjs";

const BASE = "https://nasr-realestate.github.io";
const KEY = "simsar_wa_v92";
const RETURN_QS = "?return=valuation&estimate=9360000&confidence=high&samples=41&perMeter=52000&p25=46000&p75=58000&basis=median_price_m2&area="
  + encodeURIComponent("المنطقة السادسة") + "&size=180&areaType=sale";

const ok = (label, cond, extra = "") => console.log(`${cond ? "PASS" : "FAIL"} | ${label}${extra ? " | " + extra : ""}`);
const enc = s => encodeURIComponent(String(s));

// a Worker reply shaped like the live v92 Worker's reply for an active owner flow
const workerReply = (over = {}) => ({
  response: "العقار فين بالضبط؟ اكتب الشارع والمنطقة.",
  formState: {
    active: true, lifecycle: "active", type: "sale", stepIndex: 1, flowType: "owner", awaitingQ: true,
    imageUrls: [], _version: "v92",
    data: { propertyType: "شقة", location: "المنطقة السادسة - شارع عباس العقاد", area: 180, price: 9500000,
            ownerName: "أحمد محمد", ownerPhone: "01012345678", gps: { lat: 30.1, lng: 31.2, address: "secret street" } },
    ...over,
  },
  options: ["🏠 شقة", "🏡 فيلا"], typingDelay: 0, canShareWhatsapp: true,
  waMessage: "طلب من الموقع", whatsappUrl: "https://wa.me/201147758857?text=x",
  valuationCta: { intent: "seller", area: "المنطقة السادسة", size: 180, propertyType: "شقة", areaType: "sale" },
});
const fetchOk = (json, calls) => async (url, init) => {
  if (calls) calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: true, status: 200, json: async () => json };
};
const send = async (a, text) => { a.el("msgInput").value = text; await a.run("sendMsg()"); };

console.log("=== EVIDENCE 1 — SESSION PERSISTENCE (agent.html inline script, node:vm) ===\n");

// ── 1. role + step + data + valuationResult are persisted ────────────────────────────
{
  const a = bootAgent({ search: "", fetchImpl: fetchOk(workerReply()) });
  a.run(`state.valuationResult = { estimate: 9360000, confidence: "high", samples: 41, perMeter: 52000, p25: 46000, p75: 58000, basis: "median_price_m2", area: "المنطقة السادسة", size: 180, areaType: "sale", savedAt: Date.now() };`);
  await send(a, "💰 أبيع");
  const raw = a.sessionStorage.getItem(KEY);
  const saved = JSON.parse(raw);
  ok("1.1 role/flowType persisted (flowType=owner)", saved.formState?.flowType === "owner", `flowType=${saved.formState?.flowType}`);
  ok("1.2 step persisted (stepIndex=1)", saved.formState?.stepIndex === 1, `stepIndex=${saved.formState?.stepIndex}`);
  ok("1.3 collected data persisted", saved.formState?.data?.propertyType === "شقة" && saved.formState?.data?.area === 180,
     `propertyType=${saved.formState?.data?.propertyType} area=${saved.formState?.data?.area}`);
  ok("1.4 valuationResult persisted", saved.valuationResult?.estimate === 9360000, `estimate=${saved.valuationResult?.estimate}`);
  ok("1.5 GPS never written to storage", !raw.includes("secret street") && !raw.includes('"gps"'), "saveState strips gps");
  ok("1.6 history persisted", Array.isArray(saved.history) && saved.history.length >= 2, `history=${saved.history?.length}`);
}

// ── 2. survives closing the page and reopening it ────────────────────────────────────
{
  const a1 = bootAgent({ fetchImpl: fetchOk(workerReply()) });
  await send(a1, "💰 أبيع");
  const session = a1.sessionStorage.getItem(KEY);
  const a2 = bootAgent({ session: { [KEY]: session }, fetchImpl: fetchOk(workerReply()) });
  ok("2.1 reopened page restores flowType", a2.run("state.formState.flowType") === "owner", `flowType=${a2.run("state.formState.flowType")}`);
  ok("2.2 reopened page restores stepIndex", a2.run("state.formState.stepIndex") === 1, `stepIndex=${a2.run("state.formState.stepIndex")}`);
  ok("2.3 reopened page restores data", a2.run("state.formState.data?.area") === 180, `area=${a2.run("state.formState.data?.area")}`);
  ok("2.4 client is NOT sent back to the start", a2.run("state.formState.stepIndex") !== 0, "stepIndex stayed at 1");
  ok("2.5 no console errors on restore", a2.errors.length === 0, `errors=${JSON.stringify(a2.errors)}`);
}

// ── 3. survives a pause, then a return ───────────────────────────────────────────────
{
  const a1 = bootAgent({ fetchImpl: fetchOk(workerReply()) });
  a1.run(`state.valuationResult = { estimate: 9360000, confidence: "high", samples: 41, area: "المنطقة السادسة", size: 180, areaType: "sale", savedAt: Date.now() - 3600 * 1000 };`);
  await send(a1, "💰 أبيع");
  const session = a1.sessionStorage.getItem(KEY);
  const a2 = bootAgent({ session: { [KEY]: session }, fetchImpl: fetchOk(workerReply()) });
  ok("3.1 a 1-hour pause keeps the flow", a2.run("state.formState.stepIndex") === 1, `stepIndex=${a2.run("state.formState.stepIndex")}`);
  ok("3.2 a fresh valuation (<24h) survives the pause", a2.run("state.valuationResult.estimate") === 9360000, `estimate=${a2.run("state.valuationResult.estimate")}`);
  const stale = JSON.parse(session); stale.valuationResult.savedAt = Date.now() - 25 * 3600 * 1000;
  const a3 = bootAgent({ session: { [KEY]: JSON.stringify(stale) }, fetchImpl: fetchOk(workerReply()) });
  ok("3.3 a >24h valuation is dropped, the flow is kept", a3.run("state.valuationResult") === null && a3.run("state.formState.stepIndex") === 1,
     `valuationResult=${a3.run("state.valuationResult")} stepIndex=${a3.run("state.formState.stepIndex")}`);
}

// ── 4. an old v87 session cannot poison a new v92 session ────────────────────────────
{
  const v87 = JSON.stringify({ formState: { _version: "v87", active: true, flowType: "owner", stepIndex: 5, data: { area: 999 } },
                               history: [{ role: "assistant", message: "قديم" }], valuationResult: { estimate: 111, savedAt: Date.now() } });
  const a = bootAgent({ session: { [KEY]: v87 }, fetchImpl: fetchOk(workerReply()) });
  ok("4.1 an old v87 session is rejected (cleared from storage)", a.sessionStorage.getItem(KEY) === null, `stored=${a.sessionStorage.getItem(KEY)}`);
  ok("4.2 the stale stepIndex does not leak in", a.run("state.formState.stepIndex") !== 5, `stepIndex=${a.run("state.formState.stepIndex")}`);
  ok("4.3 the stale valuation does not leak in", a.run("state.valuationResult") === null, `valuationResult=${a.run("state.valuationResult")}`);
  ok("4.4 no console errors while rejecting it", a.errors.length === 0, `errors=${JSON.stringify(a.errors)}`);
  // a fresh v92 session is untouched by the above (separate boot)
  const good = JSON.stringify({ formState: { _version: "v92", active: true, flowType: "owner", stepIndex: 3, data: { area: 180 } },
                                history: [{ role: "assistant", message: "جديد" }], valuationResult: { estimate: 9360000, savedAt: Date.now() } });
  const b = bootAgent({ session: { [KEY]: good }, fetchImpl: fetchOk(workerReply()) });
  ok("4.5 a v92 session loads intact", b.run("state.formState.stepIndex") === 3 && b.run("state.valuationResult.estimate") === 9360000,
     `stepIndex=${b.run("state.formState.stepIndex")} estimate=${b.run("state.valuationResult.estimate")}`);
  ok("4.6 the page stamps the current version on load", b.run("state.formState._version") === "v92", `_version=${b.run("state.formState._version")}`);
}

// ── 5. the valuation handoff keeps valuationResult ───────────────────────────────────
{
  const calls = [];
  const a1 = bootAgent({ fetchImpl: fetchOk(workerReply(), calls) });
  a1.run(`state.formState = { _version: "v92", active: true, flowType: "owner", type: "sale", stepIndex: 27,
           data: { location: "شارع س", area: 180, gps: { lat: 30.1, lng: 31.2, address: "secret street" } } };
           state.history.push({ role: "user", message: "💰 أبيع" });
           state.valuationCta = { intent: "seller", area: "المنطقة السادسة", size: 180, propertyType: "شقة", areaType: "sale" };
           renderValuationCta(state.valuationCta); saveState();`);
  const link = a1.chatArea.querySelector(".valuation-link");
  ok("5.1 the 💎 CTA link exists", !!link, link ? `href=${link.href.slice(0, 60)}…` : "no link");
  link.dispatch("click");
  const savedCtx = a1.sessionStorage.getItem("simsar_return_session");
  ok("5.2 the handoff context is saved", !!savedCtx, savedCtx ? `${savedCtx.length} bytes` : "none");
  ok("5.3 the handoff never carries GPS/address", !String(savedCtx).includes("secret street") && !String(savedCtx).includes('"gps"'), "stripped");

  const a2 = bootAgent({ search: RETURN_QS, session: { simsar_return_session: savedCtx }, fetchImpl: fetchOk(workerReply(), calls) });
  ok("5.4 the flow is restored after the round trip", a2.run("state.formState.flowType") === "owner" && a2.run("state.formState.stepIndex") === 27,
     `flowType=${a2.run("state.formState.flowType")} stepIndex=${a2.run("state.formState.stepIndex")}`);
  ok("5.5 the returned valuationResult is present", a2.run("state.valuationResult.estimate") === 9360000, `estimate=${a2.run("state.valuationResult.estimate")}`);
  ok("5.6 the 💎 button is back", !!a2.chatArea.querySelector(".valuation-link"), "rendered again");
  ok("5.7 the handoff context is consumed (single use)", a2.sessionStorage.getItem("simsar_return_session") === null, "removed");
  ok("5.8 history survived the round trip", a2.run("state.history.length") >= 2, `history=${a2.run("state.history.length")}`);
  ok("5.9 the URL is cleaned", !a2.location.search.includes("return=valuation"), `search="${a2.location.search}"`);

  const before = calls.length;
  await send(a2, "تمام");
  const last = calls[calls.length - 1];
  ok("5.10 the valuationResult is sent exactly once", before < calls.length && last?.body?.valuationResult?.estimate === 9360000,
     `valuationResult.estimate=${last?.body?.valuationResult?.estimate}`);
  ok("5.11 the second message does not resend it", (await (async () => { await send(a2, "طيب"); return calls[calls.length - 1]?.body?.valuationResult; })()) === null,
     "second send carries null");
  ok("5.12 the page sends formState._version=v92 to the Worker", last?.body?.formState?._version === "v92", `_version=${last?.body?.formState?._version}`);
  ok("5.13 the page sends WORKER_URL = royal-snow-ea32", String(last?.url).includes("royal-snow-ea32.footcai-555.workers.dev"), String(last?.url));
}

console.log("\n=== EVIDENCE 1 COMPLETE ===");
