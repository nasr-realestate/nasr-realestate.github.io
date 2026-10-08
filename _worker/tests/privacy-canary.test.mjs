// Privacy-canary suite — the FINAL HTTP payload that would go to Google must never carry
// a raw customer address, whatever field or path it entered through.
//
//   P-1 … P-10: the ten canary scenarios (address step · rooms step · notes · unmatched landmark ·
//               correction · first message with intent · first message without facts · side question
//               with the address only in history · the same address spelled with ه · an address
//               wholly outside MASTER_LANDMARKS)
//   R-1:        the reverse test — an address-free message must reach Gemini natural and undistorted
//   M-1/M-2:    false positives (address-free corpus) and false negatives (unmatched-address corpus)
//
// Every assertion inspects H.gemini[] — the captured request bodies of the real fetch() the Worker
// made — never scrubAddresses() in isolation.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as H from "./_agent-harness.mjs";

before(() => H.installFetchMock());
after(() => H.restoreFetch());

const CANARY = "شارع إبراهيم نوارة بجوار صيدلية العزبي";
const CANARY_H = "شارع إبراهيم نواره بجوار صيدلية العزبي";              // نفس العنوان مكتوب بالهاء
const OUTSIDE = "شارع الترعة البولاقية بجوار كوبري الساحل";              // خارج MASTER_LANDMARKS بالكامل
const OUTSIDE2 = "شارع 15 مايو بجوار مسجد الرحمة";
const FRAGMENTS = [CANARY, "شارع إبراهيم نوارة", "إبراهيم نوارة", "بجوار صيدلية العزبي", "صيدلية العزبي", "العزبي"];
const FRAG_OUTSIDE = [OUTSIDE, "الترعة البولاقية", "كوبري الساحل", "بجوار كوبري"];
const FRAG_OUTSIDE2 = [OUTSIDE2, "15 مايو", "مسجد الرحمة"];

const canon = s => String(s ?? "").replace(/ة/g, "ه").replace(/[أإآٱ]/g, "ا").replace(/ى/g, "ي").replace(/\s+/g, " ").trim();
const post = (m, fs, extra) => H.agentPost({ message: m, formState: fs, history: [], ...(extra || {}) });

// كل جزء نصي في الحمولة الفعلية (system_instruction + contents) — دي الحمولة اللي بتتبعت لـGoogle
function payloadParts(g) {
  const parts = [["system_instruction", String(g.system ?? "")]];
  (g.contents || []).forEach((c, i) => parts.push([`contents[${i}].${c.role}`, (c.parts || []).map(p => String(p?.text ?? "")).join("\n")]));
  return parts;
}
const payloadText = () => H.gemini.flatMap(g => payloadParts(g).map(([, t]) => t)).join("\n");
const payloadChars = () => H.gemini.reduce((n, g) => n + payloadParts(g).reduce((m, [, t]) => m + t.length, 0), 0);
function scan(frags) {
  const hits = [];
  H.gemini.forEach((g, i) => {
    for (const [where, text] of payloadParts(g)) {
      const c = canon(text);
      for (const f of frags) if (c.includes(canon(f))) hits.push({ call: i + 1, where, frag: f, ctx: text.slice(0, 90) });
    }
  });
  return hits;
}

// ── عدّادات القياس (تُطبع في نهاية السويتة) ────────────────────────────────────────────
const MEASURE = { scenarios: [], turns: 0, calls: 0, chars: 0 };
let sc = null;
const scenario = (name, frags = FRAGMENTS) => (sc = { name, frags, hits: [], turns: 0, calls: 0, chars: 0 });
async function turn(msg, fs, extra) {
  H.resetGemini();
  const r = await post(msg, fs, extra);
  const calls = H.gemini.length, chars = payloadChars();
  if (sc) { sc.turns += 1; sc.calls += calls; sc.chars += chars; sc.hits.push(...scan(sc.frags)); }
  MEASURE.turns += 1; MEASURE.calls += calls; MEASURE.chars += chars;
  return { r, fs: r.json.formState };
}
const FAILURES = [];
function finish() {
  MEASURE.scenarios.push({ name: sc.name, turns: sc.turns, calls: sc.calls, chars: sc.chars, hits: sc.hits.length });
  if (sc.hits.length) FAILURES.push(`${sc.name}: raw address in the final payload → ${JSON.stringify(sc.hits.slice(0, 2))}`);
  if (sc.calls < 1) FAILURES.push(`${sc.name}: no Gemini call — the payload was not captured`);
  return sc;
}
// كل السيناريوهات بتتسجّل الأول (عشان القياسات تفضل كاملة حتى في البناء القديم)، والفشل يُعلن في الآخر
function assertClean() {
  const f = FAILURES.splice(0);
  assert.equal(f.length, 0, "privacy canary failures:\n" + f.join("\n"));
}

// مسبار مضمون: الحالة مكتملة (بدون عنوان) + النص في التاريخ + سؤال جانبي ⇒ geminiContextual
const PROBE_Q = "المنطقة دي كويسة للاستثمار؟";
const probeState = () => H.qualifiedOwnerState({ flowType: "owner_sale", data: { propertyType: "شقة", area: 180, price: 9500000, rooms: "3", baths: "2", floor: "ثالث", finishing: "سوبر لوكس" } });
const probeTurn = (text) => turn(PROBE_Q, probeState(), { history: [{ role: "user", message: text }, { role: "assistant", message: "تمام" }] });

// ── drivers (نفس سيناريوهات أداة التشخيص 05) ───────────────────────────────────────────
async function ownerToRooms() {
  let fs = (await turn("💰 أبيع", {})).fs;
  for (const m of ["شقة", "شارع عباس العقاد", "180", "9500000"]) fs = (await turn(m, fs)).fs;
  return fs;                                            // الخطوة الحالية: عدد الغرف
}
async function ownerToNotes(locationText = "شارع عباس العقاد") {
  let fs = (await turn("💰 أبيع", {})).fs;
  for (const m of ["شقة", locationText, "180", "9500000", "3", "2", "ثالث", "سوبر لوكس"]) fs = (await turn(m, fs)).fs;
  return fs;                                            // الخطوة الحالية: التفاصيل المهمة (notes)
}
// مسار حتمي: النص يُكتب في خطوة التفاصيل (notes) ثم نداء لاحق يحمل بيانات الحالة معه
async function notesProbe(text, locationText) {
  const fs = await ownerToNotes(locationText);
  const after = (await turn(text, fs)).fs;
  await turn("ممكن تفاصيل أكتر؟", after);
  return after;
}
async function buyerToLandmark() {
  let fs = (await turn("🏠 عايز أشتري", {})).fs;
  fs = (await turn("شقة", fs)).fs;
  return fs;                                            // الخطوة الحالية: المنطقة/العلامة المميزة
}

test("P-1: the canary typed AT the address step, then a side question", async () => {
  scenario("1 · canary at the address step + side question");
  let fs = (await turn("💰 أبيع", {})).fs;
  fs = (await turn("شقة", fs)).fs;
  fs = (await turn(CANARY, fs, { gps: H.GPS })).fs;
  await turn("المنطقة دي كويسة للاستثمار؟", fs);
  finish();
  assertClean();
});

test("P-2: the canary typed at the rooms step (a non-address step)", async () => {
  scenario("2 · canary at the rooms step");
  const fs = await ownerToRooms();
  await turn("3 غرف، العنوان " + CANARY, fs);
  finish();
  assertClean();
});

test("P-3: the canary stored in notes, then a later comment carries the data", async () => {
  scenario("3 · canary stored in notes");
  let fs = await ownerToNotes();
  fs = (await turn(CANARY, fs)).fs;
  await turn("اسمي أحمد وعايز أعرف لو فيه رسوم إضافية", fs);
  finish();
  assertClean();
});

test("P-4: the canary as an unmatched landmark (stored raw)", async () => {
  scenario("4 · canary as an unmatched landmark");
  let fs = await buyerToLandmark();
  fs = (await turn(CANARY, fs)).fs;
  fs = (await turn("150", fs)).fs;
  await turn("ميزانيتي حوالي 3 مليون وعايز مساحة كبيرة", fs);
  finish();
  assertClean();
});

test("P-5: the canary inside a correction at a later step", async () => {
  scenario("5 · canary inside a correction");
  let fs = (await turn("💰 أبيع", {})).fs;
  fs = (await turn("شقة", fs)).fs;
  fs = (await turn("شارع عباس العقاد", fs)).fs;
  fs = (await turn("180", fs)).fs;
  await turn("لأ، قصدي العنوان " + CANARY, fs);
  finish();
  assertClean();
});

test("P-6: the first message carries the address together with real-estate intent", async () => {
  scenario("6 · first message with intent");
  await turn("عندي شقة في " + CANARY + " وعايز أبيعها", {});
  finish();
  assertClean();
});

test("P-7: the first message carries nothing but the address", async () => {
  scenario("7 · first message without facts");
  const first = await turn("السلام عليكم، أنا ساكن في " + CANARY, {});
  // رسالة أولى بلا حقائق: أي حمولة أُرسلت في نفس الدور يجب أن تكون نظيفة،
  // والدور التالي (سؤال جانبي مع بقاء العنوان في التاريخ) يُلتقط بالحتمية.
  await probeTurn("السلام عليكم، أنا ساكن في " + CANARY);
  assert.ok(first.fs, "the first message must still return a state");
  finish();
  assertClean();
});

test("P-8: the address exists only in the client history (no _rawLocations in state)", async () => {
  scenario("8 · side question with the address only in history");
  const state = H.qualifiedOwnerState({ flowType: "owner_sale", data: { propertyType: "شقة", location: "المنطقة السادسة", area: 180, price: 9500000 } });
  const history = [{ role: "user", message: "أنا ساكن في " + CANARY + " وعايز أعرف المنطقة" }, { role: "assistant", message: "تمام" }];
  await turn("المنطقة دي كويسة للاستثمار؟", state, { history });
  finish();
  assertClean();
});

test("P-9: the same address written with ه instead of ة", async () => {
  scenario("9 · the ه spelling of the same address");
  let fs = (await turn("💰 أبيع", {})).fs;
  fs = (await turn("شقة", fs)).fs;
  fs = (await turn(CANARY, fs)).fs;                                  // الإملاء الأصلي (ة) في خطوة العنوان
  fs = (await turn("هو العنوان " + CANARY_H + " صح؟", fs)).fs;        // إعادة ذكر نفس العنوان مكتوبًا بالهاء
  await turn("المنطقة دي كويسة للاستثمار؟", fs);
  finish();
  assertClean();
});

test("P-10: an address wholly outside MASTER_LANDMARKS (protection is not list-dependent)", async () => {
  scenario("10a · outside the landmark list — buyer landmark step", FRAG_OUTSIDE);
  let fs = await buyerToLandmark();
  fs = (await turn(OUTSIDE, fs)).fs;
  fs = (await turn("150", fs)).fs;
  await turn("ميزانيتي حوالي 3 مليون", fs);
  finish();

  scenario("10b · outside the landmark list — first message", FRAG_OUTSIDE2);
  await turn("السلام عليكم، أنا ساكن في " + OUTSIDE2, {});
  finish();
  assertClean();
});

test("R-1: an address-free message reaches Gemini natural and undistorted", async () => {
  const msg = "ممكن أعرف متوسط الأسعار في مدينة نصر وميزانيتي حوالي 3 مليون";
  scenario("R-1 · reverse test (naturalness)");
  await probeTurn(msg);
  const payload = canon(payloadText());
  assert.ok(payload.includes(canon(msg)), "the message reached Gemini distorted — words were removed");
  assert.ok(!payload.includes("[عنوان]"), "an address-free message had [عنوان] inserted into it");
  finish();
  assertClean();
});

test("M-1: false positives — address-free text keeps its exact words in the payload", async () => {
  const BENIGN = [
    "عايز شقة 3 غرف",
    "ميزانيتي حوالي 3 مليون",
    "ممكن تفاصيل أكتر عن الشقة؟",
    "السعر ده نهائي ولا فيه تفاوض؟",
    "التشطيب إيه؟",
    "محتاج أعرف الرسوم كمان",
    "عايز أعرف المميزات والعيوب",
    "المنطقة هادية؟",
    "ممكن أعرف متوسط الأسعار؟",
    "شكرًا جزيلًا على المساعدة",
  ];
  let fp = 0, captured = 0, unproven = 0;
  const rows = [];
  for (const msg of BENIGN) {
    scenario(`FP · ${msg.slice(0, 30)}`);
    const st = await notesProbe(msg, "مدينة نصر");
    const payload = canon(payloadText());
    if (payload.length) captured += 1;
    const carried = st?.data?.notes === msg;              // النص اتخزن فعلًا وخطوة النداء حملته
    const natural = payload.includes(canon(msg));         // وصل الحمولة كما هو، بلا إخفاء
    if (!carried) unproven += 1;
    if (!natural) fp += 1;
    rows.push(`${natural ? "natural " : "ALTERED "} | ${msg}`);
    sc.hits.length = 0;
    MEASURE.scenarios.push({ name: sc.name, turns: sc.turns, calls: sc.calls, chars: sc.chars, hits: 0 });
  }
  console.log("\n── M-1 · false positives (" + fp + "/" + BENIGN.length + " altered · " + unproven + " unproven · " + captured + " payloads captured) ──");
  for (const r of rows) console.log("   " + r);
  assert.equal(captured, BENIGN.length, "every benign probe must really capture a Gemini payload");
  assert.equal(unproven, 0, "a benign text was never carried to the payload — the probe proves nothing");
  assert.equal(fp, 0, "an address-free text was altered by the address protection");
  assertClean();
});

test("M-2: false negatives — unmatched addresses never reach the payload", async () => {
  const CORPUS = [
    "شارع 15 مايو بجوار مسجد الرحمة",
    "شارع الترعة البولاقية بجوار كوبري الساحل",
    "شارع العروبة بجوار مستشفى هليوبوليس",
    "أنا ساكن في شارع مصطفى النحاس",
    "شقة في شارع عباس العقاد",
    OUTSIDE,
  ];
  let fn = 0, unproven = 0, captured = 0;
  const rows = [];
  for (const addr of CORPUS) {
    scenario(`FN · ${addr.slice(0, 30)}`, [addr]);
    await notesProbe(addr, "مدينة نصر");                  // الحالة نفسها بلا أي عنوان ⇒ أي [عنوان] مصدره النص المُختبر
    const sent = canon(payloadText());
    if (sent.length) captured += 1;
    const leaked = sent.includes(canon(addr));
    const masked = sent.includes("[عنوان]");
    if (leaked) fn += 1;
    if (!masked) unproven += 1;
    rows.push(`${leaked ? "LEAKED   " : masked ? "masked   " : "UNPROVEN "} | ${addr}`);
    sc.hits.length = 0;
    MEASURE.scenarios.push({ name: sc.name, turns: sc.turns, calls: sc.calls, chars: sc.chars, hits: 0 });
  }
  console.log("\n── M-2 · false negatives (" + fn + "/" + CORPUS.length + " leaked · " + unproven + " unproven · " + captured + " payloads captured) ──");
  for (const r of rows) console.log("   " + r);
  assert.equal(captured, CORPUS.length, "every address probe must really capture a Gemini payload");
  assert.equal(unproven, 0, "an address was neither found nor provably masked — the probe proves nothing");
  assert.equal(fn, 0, "an unmatched address reached Gemini unmasked");
  assertClean();
});

test("M-3: payload-size / call-count report", async () => {
  const totalHits = MEASURE.scenarios.reduce((n, s) => n + s.hits, 0);
  console.log("\n── M-3 · measurements (this build) ──");
  console.log(`   turns=${MEASURE.turns}  gemini_calls=${MEASURE.calls}  payload_chars=${MEASURE.chars}  canary_hits=${totalHits}`);
  for (const s of MEASURE.scenarios) console.log(`   · ${s.name} → turns=${s.turns} calls=${s.calls} chars=${s.chars} hits=${s.hits}`);
  assert.equal(totalHits, 0, "no scenario may carry a canary fragment in its final payload");
});
