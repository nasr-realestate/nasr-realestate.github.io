// EVIDENCE SUITE 4 — Differential regression proof.
// Runs the SAME battery against the pre-patch worker (6220d90^) and the patched worker (6220d90)
// and diffs the observable responses. The only tolerated difference is the D-4b addition itself
// (data._rawLocations). Anything else differing is a real regression.
// Usage: node 04-differential.mjs <beforeWorker.js> <afterWorker.js>   (each in its own dir with tests/)
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [beforePath, afterPath] = process.argv.slice(2);
const ROOT = new URL("../../", import.meta.url).pathname;
const HARNESS = path.join(ROOT, "_worker/tests");

// The battery: roles, routing, matching, valuation handoff, persona, WA, limits, privacy cues.
const BATTERY = `
import * as H from "./_agent-harness.mjs";
H.installFetchMock();
const SITE = "https://nasr-realestate.github.io";
const RAW = "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة";
const out = [];
const TS = new Set(["at","savedAt","_savedAt","typingDelay","startedAt","observedAt","timestamp"]);
const strip = o => {                        // remove volatile values (clocks) so only behaviour is compared
  if (Array.isArray(o)) return o.map(strip);
  if (o && typeof o === "object") { const r = {}; for (const [k,v] of Object.entries(o)) { if (TS.has(k)) continue; r[k] = strip(v); } return r; }
  return o;
};
const clean = j => {                       // strip the D-4b addition; everything else must match
  const c = strip(JSON.parse(JSON.stringify(j)));
  const delRaw = o => {                     // the D-4b addition is the *intended* difference
    if (Array.isArray(o)) return o.map(delRaw);
    if (o && typeof o === "object") { const r = {}; for (const [k,v] of Object.entries(o)) { if (k === "_rawLocations") continue; r[k] = delRaw(v); } return r; }
    return o;
  };
  return delRaw(c);
};
const rec = async (label, body, opts) => {
  const r = await H.agentPost(body, { headers: { Origin: SITE }, ...(opts || {}) });
  out.push({ label, status: r.status, body: clean(r.json) });
};
// 1) role routing
for (const m of ["🏠 عايز أشتري","🔑 عايز أأجر","💰 أبيع","🔑 أأجر","عندي شقة وعايز أعرف سعرها","عايز شقة في مدينة نصر بـ 3 مليون"])
  await rec("route: " + m, { message: m, formState: {}, history: [] });
// 2) identity / off-topic / office
for (const m of ["انت مين؟","السلام عليكم","الجو حلو النهاردة","فين المكتب؟"])
  await rec("smalltalk: " + m, { message: m, formState: {}, history: [] });
// 3) matching + valuation handoff with a real owner state
const owner = H.qualifiedOwnerState();
await rec("handoff: valuation announced", { message: H.SEND_NOW, formState: owner, history: [], valuationResult: H.goodValuation() });
await rec("handoff: no active flow", { message: "السلام عليكم", formState: {}, history: [], valuationResult: H.goodValuation() });
await rec("handoff: tampered", { message: H.SEND_NOW, formState: owner, history: [], valuationResult: { estimate: "١٢٣", confidence: "high", samples: "x" } });
// 4) the full owner flow with a raw address typed at the location step (D-4b scenario)
const gift = await H.driveOwnerToGift({ locationMessage: RAW, withGps: true });
out.push({ label: "flow: up to the gift step", status: gift.status, body: { response: gift.json.response, formState: gift.json.formState, valuationCta: gift.json.valuationCta, options: gift.json.options } });
let fs2 = gift.json.formState, last = gift.json;
for (const m of ["تمام","أحمد","01512345678","⏭ تخطي (بدون صور)"]) {
  const r = await H.agentPost({ message: m, formState: fs2, history: [] }); fs2 = r.json.formState; last = r.json;
}
out.push({ label: "flow: completion", status: 200, body: { done: last.done, canShareWhatsapp: last.canShareWhatsapp, waMessage: last.waMessage, whatsappUrl: last.whatsappUrl, data: last.formState?.data, formState: last.formState } });
// 5) side question (Gemini path) — prompts must match except for the redaction
await rec("side question", { message: "الكمبوند اللي جنبي كويس ولا لأ يا باشا", formState: H.qualifiedOwnerState({ flowType: "owner_x", data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000, gps: { ...H.GPS } } }), history: [] });
// 6) limits + transport
await rec("GET /", {});
const up = await H.rawAgentRequest("/upload-images", { method: "POST", headers: { Origin: SITE, "Content-Type": "text/plain", "CF-Connecting-IP": H.nextIp() }, body: "{}" }, { GEMINI_API_KEY: "k" });
out.push({ label: "upload 415", status: up.status, body: await up.text() });
const big = await H.rawAgentRequest("/", { method: "POST", headers: { Origin: SITE, "Content-Type": "application/json", "CF-Connecting-IP": H.nextIp(), "Content-Length": String(300 * 1024) }, body: "{}" }, { GEMINI_API_KEY: "k" });
out.push({ label: "oversize 413", status: big.status, body: await big.text() });
const rl = []; for (let i = 0; i < 16; i++) { const r = await H.agentPost({ message: "تمام", formState: {}, history: [] }, { headers: { Origin: SITE, "CF-Connecting-IP": "fixed-ip" } }); rl.push(r.status); }
out.push({ label: "rate limit sequence", status: 200, body: rl });
const foreign = await H.rawAgentRequest("/", { method: "POST", headers: { Origin: "https://evil.example", "Content-Type": "application/json", "CF-Connecting-IP": H.nextIp() }, body: JSON.stringify({ message: "hi", formState: {}, history: [] }) }, { GEMINI_API_KEY: "k" });
out.push({ label: "CORS foreign", status: foreign.status, body: foreign.headers.get("access-control-allow-origin") });
// 6b) THE D-4b SCENARIO: the raw address sits in the history, then a side question reaches Gemini
H.resetGemini();
const rawHistory = [{ role: "user", message: "أنا ساكن في " + RAW + " وعايز أعرف المنطقة" }, { role: "assistant", message: "تمام" }];
const d4b = await H.agentPost(
  { message: "المنطقة دي كويسة للاستثمار؟", formState: H.qualifiedOwnerState({ flowType: "owner_sale", data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000 } }), history: rawHistory },
  { headers: { Origin: SITE } });
const payloads = H.gemini.map(g => String(g.system || "") + " " + JSON.stringify(g.contents)).join(" ;; ");
out.push({ label: "D-4b: side question with the raw address in the history", status: d4b.status, body: {
  verdict: payloads.includes("إبراهيم نوارة") ? "RAW_ADDRESS_SENT_TO_GEMINI" : "scrubbed",
  geminiCalls: H.gemini.length,
  alsoInSystemPrompt: H.gemini.some(g => String(g.system || "").includes("إبراهيم نوارة")),
  awareOfAreaName: payloads.includes("المنطقة السادسة"),
} });

// 7) the Gemini payloads themselves (system prompt + contents) for the address scenarios
out.push({ label: "gemini payloads", status: 200, body: H.gemini.map(g => ({ system: g.system, contents: g.contents })) });
H.restoreFetch();
console.log(JSON.stringify(out, null, 1));
`;

function runWith(workerPath, tag) {
  const dir = fs.mkdtempSync(`/tmp/diff-${tag}-`);
  fs.copyFileSync(workerPath, path.join(dir, "worker.js"));
  fs.mkdirSync(path.join(dir, "tests"));
  for (const f of fs.readdirSync(HARNESS)) fs.copyFileSync(path.join(HARNESS, f), path.join(dir, "tests", f));
  const script = path.join(dir, "battery.mjs");
  fs.writeFileSync(script, BATTERY.replace('from "./_agent-harness.mjs"', 'from "./tests/_agent-harness.mjs"'));
  const r = spawnSync("node", [script], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) { console.error(`battery failed for ${tag}:\n${r.stderr}`); process.exit(1); }
  fs.writeFileSync(`/tmp/diff-${tag}.json`, r.stdout);
  return JSON.parse(r.stdout);
}

const before = runWith(beforePath, "before");
const after = runWith(afterPath, "after");
console.log("=== EVIDENCE 4 — DIFFERENTIAL REGRESSION PROOF (6220d90^ vs 6220d90) ===\n");
console.log(`battery cases: ${before.length} vs ${after.length}\n`);

const INTENDED = [{ label: "D-4b: side question with the raw address in the history", before: "RAW_ADDRESS_SENT_TO_GEMINI", after: "scrubbed" }];
let diffs = 0, same = 0, tolerated = 0;
for (let i = 0; i < Math.max(before.length, after.length); i++) {
  const b = before[i], a = after[i];
  const label = a?.label ?? b?.label ?? `#${i}`;
  const jb = JSON.stringify(b, null, 1), ja = JSON.stringify(a, null, 1);
  const intend = INTENDED.find(x => x.label === label);
  if (jb === ja) { same++; console.log(`IDENTICAL  | ${label}`); continue; }
  if (intend && b?.body?.verdict === intend.before && a?.body?.verdict === intend.after) {
    tolerated++;
    console.log(`FIXED      | ${label}`);
    console.log(`             before: ${intend.before}  →  after: ${intend.after}   (${JSON.stringify(a.body)})`);
    continue;
  }
  diffs++;
  console.log(`DIFFERS   | ${label}`);
  const lb = jb.split("\n"), la = ja.split("\n");
  for (let k = 0; k < Math.max(lb.length, la.length); k++) if (lb[k] !== la[k]) {
    console.log(`    before: ${String(lb[k]).slice(0, 150)}`);
    console.log(`    after : ${String(la[k]).slice(0, 150)}`);
  }
}
console.log(`\nidentical: ${same} | intended D-4b fix: ${tolerated} | unexplained differences: ${diffs}`);
console.log(diffs === 0 ? "\n=== EVIDENCE 4 COMPLETE — ZERO REGRESSIONS ===" : `\n=== EVIDENCE 4 — ${diffs} DIFFERENCE(S) TO REVIEW ===`);
process.exit(diffs ? 1 : 0);
