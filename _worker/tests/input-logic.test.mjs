// Input-logic regression suite — the price/phone defect, natural number forms, ambiguity,
// and the name-step validation.
//
//   A. phone/price confusion (the reported production defect)
//   B. natural ways customers write amounts
//   C. two numbers in one message → never guess
//   D. one message carrying several facts → each value to its own field
//   E. number kinds are not confused (phone / price / area / year / floor)
//   F. the name step: what is accepted, what is rejected, and what is never claimed
//
// The Worker is exercised from the outside through its real fetch handler.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import * as H from "./_agent-harness.mjs";

before(() => H.installFetchMock());
after(() => H.restoreFetch());

const ORIGIN = { Origin: H.ORIGIN };
const post = (m, fs, extra) => H.agentPost({ message: m, formState: fs, history: [], ...(extra || {}) });
const firstLine = r => String(r.json.response || "").split("\n")[0].trim();
const isClarify = r => /أكتر من رقم|رقم موبايل مش|بالأرقام بالظبط/.test(String(r.json.response || ""));   // توضيح قصير مباشر

// ── drivers ───────────────────────────────────────────────────────────────────────────
async function driveOwnerToPriceStep() {
  let r = await post("💰 أبيع", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "شارع عباس العقاد المنطقة السادسة", "180"]) {
    r = await post(m, fs); fs = r.json.formState;
  }
  assert.match(String(r.json.response), /السعر/, "driver must stop on the price question");
  return fs;
}
async function driveOwnerToNameStep(saleAnswer = "9500000") {
  let r = await post("💰 أبيع", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "شارع عباس العقاد المنطقة السادسة", "180", saleAnswer, "3", "2", "ثالث", "سوبر لوكس", "لا", "تمام"]) {
    r = await post(m, fs); fs = r.json.formState;
    if (/اسم حضرتك/.test(String(r.json.response || ""))) return fs;
  }
  assert.fail("driver never reached the owner name step");
}
async function driveBuyerToNameStep() {
  let r = await post("🏠 عايز أشتري", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "المنطقة السادسة", "150", "3000000", "3", "2"]) {
    r = await post(m, fs); fs = r.json.formState;
    if (/اسم حضرتك/.test(String(r.json.response || ""))) return fs;
  }
  assert.fail("driver never reached the buyer name step");
}

// ═════════════════ A. phone/price confusion (the reported defect) ═════════════════
test("A-1: a correct price and a later phone answer keep the price untouched (the reported defect)", async () => {
  let fs = await driveOwnerToNameStep("9500000");
  assert.equal(fs.data.price, 9500000, "the price was stored");
  const ownerPhoneStep = { ...fs, stepIndex: fs.stepIndex + 1 };          // the phone question follows the name
  const name = await post("أحمد علي", fs);
  const r = await post("01512345678", name.json.formState);
  assert.equal(r.status, 200);
  assert.equal(r.json.formState.data.price, 9500000, "the phone must never replace the price");
  assert.equal(r.json.formState.data.ownerPhone, "01512345678", "the phone is stored in the phone field");
  assert.ok(!(r.json.formState.agentState?.corrections || []).some(c => c.field === "price"), "no phantom price correction was recorded");
});

test("A-2: at the price question a phone number is refused, never stored as a price", async () => {
  const fs = await driveOwnerToPriceStep();
  const r = await post("01512345678", fs);
  const d = r.json.formState.data;
  assert.ok(d.price === undefined || d.price === null, `price must stay empty, got ${d.price}`);
  assert.equal(r.json.formState.stepIndex, fs.stepIndex, "the flow stays on the price question");
  assert.match(String(r.json.response), /موبايل|رقم صحيح|السعر/, "it asks again about the price");
});

test("A-3: a bare big number in an unrelated message never overwrites a stored price", async () => {
  let fs = await driveOwnerToNameStep("9500000");
  // an 11-digit run inside an unrelated sentence at the name step
  const r = await post("رقمي 01098765432 لو حبيت", fs);
  assert.equal(r.json.formState.data.price, 9500000, "price untouched");
  assert.equal(r.json.formState.data.budget, undefined);
});

test("A-4: a buyer's budget survives a later phone answer", async () => {
  let fs = await driveBuyerToNameStep();
  assert.equal(fs.data.budget, 3000000, "the budget was stored");
  const name = await post("أحمد علي", fs);
  const r = await post("01123456789", name.json.formState);
  assert.equal(r.json.formState.data.budget, 3000000, "the phone must never replace the budget");
  assert.equal(r.json.formState.data.buyerPhone, "01123456789");
});

// ═════════════════ B. natural ways customers write amounts ═════════════════
test("B-1: the common Arabic/English amount forms are understood at the price question", async () => {
  const cases = [
    ["5 مليون", 5000000],
    ["5م", 5000000],
    ["مليونين", 2000000],
    ["مليون", 1000000],
    ["5.5 مليون", 5500000],
    ["5,000,000", 5000000],
    ["٥ مليون", 5000000],
    ["3 مليون و200", 3200000],
    ["5 مليون و300 ألف", 5300000],
    ["6 مليون جنيه", 6000000],
  ];
  for (const [msg, want] of cases) {
    const fs = await driveOwnerToPriceStep();
    const r = await post(msg, fs);
    assert.equal(r.json.formState.data.price, want, `"${msg}" → expected ${want}`);
  }
});

test("B-2: a plain number with spaces and Arabic digits is understood too", async () => {
  for (const [msg, want] of [["9,500,000", 9500000], ["٩٥٠٠٠٠٠", 9500000], ["9500000", 9500000]]) {
    const fs = await driveOwnerToPriceStep();
    const r = await post(msg, fs);
    assert.equal(r.json.formState.data.price, want, `"${msg}" → expected ${want}`);
  }
});

test("B-4: a rent amount below the sale threshold is accepted, and a monthly figure in words too", async () => {
  const drive = async () => {
    let r = await post("🔑 أأجر", {});
    let fs = r.json.formState;
    for (const m of ["شقة", "شارع عباس العقاد", "120"]) { r = await post(m, fs); fs = r.json.formState; }
    assert.match(String(r.json.response), /الإيجار الشهري/, "the driver stops on the rent question");
    return fs;
  };
  for (const [msg, want] of [["9000", 9000], ["ألفين", 2000], ["7500 جنيه", 7500]]) {
    const r = await post(msg, await drive());
    assert.equal(r.json.formState.data.price, want, `"${msg}" → expected ${want}`);
  }
});

test("B-3: the buyer's budget question understands the same forms", async () => {
  let r = await post("🏠 عايز أشتري", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "المنطقة السادسة", "150"]) { r = await post(m, fs); fs = r.json.formState; }
  assert.match(String(r.json.response), /ميزانيتك/, "the driver stops on the budget question");
  const r2 = await post("4 ملايين".replace("ملايين", "مليون"), fs);
  assert.equal(r2.json.formState.data.budget, 4000000);
});

// ═════════════════ C. two numbers in one message → never guess ═════════════════
test("C-1: an explicit choice/range is never collapsed into one invented number", async () => {
  const cases = ["3.5 او 4 مليون", "5000000 أو 5500000", "7م و 8م", "1200000 1500000", "من 3 ل 4 مليون", "5 مليون أو 5.5 مليون", "مليونين وخمسين ألف"];
  for (const msg of cases) {
    const fs = await driveOwnerToPriceStep();
    const r = await post(msg, fs);
    assert.ok(r.json.formState.data.price === undefined || r.json.formState.data.price === null,
      `"${msg}" must not invent a price, got ${r.json.formState.data.price}`);
    assert.ok(isClarify(r), `"${msg}" must ask a short clarifying question, got: ${firstLine(r)}`);
    assert.equal(r.json.formState.stepIndex, fs.stepIndex, "the flow stays on the price question");
  }
});

test("C-2: an ambiguous answer never overwrites an already stored price", async () => {
  let fs = await driveOwnerToNameStep("9500000");
  const r = await post("لأ هو 3.5 أو 4 مليون", fs);
  assert.equal(r.json.formState.data.price, 9500000, "the stored price is preserved");
});

test("C-3: the same rule applies at the buyer's budget question", async () => {
  let r = await post("🏠 عايز أشتري", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "المنطقة السادسة", "150"]) { r = await post(m, fs); fs = r.json.formState; }
  assert.match(String(r.json.response), /ميزانيتك/, "the driver stops on the budget question");
  const ambiguous = await post("3000000 أو 3500000", fs);
  assert.ok(!ambiguous.json.formState.data.budget, "no random pick from a choice of two");
  assert.ok(isClarify(ambiguous), `a clarifying question is asked, got: ${firstLine(ambiguous)}`);
  assert.equal(ambiguous.json.formState.stepIndex, fs.stepIndex, "still on the budget question");
  // and a clear single answer is accepted right after the clarification
  const clear = await post("3 مليون", ambiguous.json.formState);
  assert.equal(clear.json.formState.data.budget, 3000000, "a clear answer passes after the clarification");
});

// ═════════════════ D. one message, several facts ═════════════════
test("D-1: «3 غرف 2 حمام 180 متر 5 مليون» lands in the right fields", async () => {
  const fs = await driveOwnerToPriceStep();
  const r = await post("3 غرف 2 حمام 180 متر 5 مليون", fs);
  const d = r.json.formState.data;
  assert.equal(d.rooms, "3", "rooms");
  assert.equal(d.baths, "2", "baths");
  assert.equal(d.area, 180, "area");
  assert.equal(d.price, 5000000, "price");
});

test("D-2: a bundle with a phone number does not turn the phone into a price", async () => {
  const fs = await driveOwnerToPriceStep();
  const r = await post("شقة 180 متر 5 مليون، كلمني 01512345678", fs);
  const d = r.json.formState.data;
  assert.equal(d.price, 5000000, "the explicit price wins");
  assert.notEqual(String(d.price), "1512345678", "the phone never becomes the price");
});

// ═════════════════ E. number kinds are not confused ═════════════════
test("E-1: an implausible area (a price typed at the area question) is refused", async () => {
  let r = await post("💰 أبيع", {}); let fs = r.json.formState;
  for (const m of ["شقة", "شارع عباس العقاد"]) { r = await post(m, fs); fs = r.json.formState; }
  assert.match(String(r.json.response), /المساحة/, "the driver stops on the area question");
  const r2 = await post("9500000", fs);
  assert.equal(r2.json.formState.data.area ?? null, null, "a 7-digit number is not an area");
  assert.match(String(r2.json.response), /المساحة/, "the question is repeated");
});

test("E-2: a phone number at the area question is refused", async () => {
  let r = await post("💰 أبيع", {}); let fs = r.json.formState;
  for (const m of ["شقة", "شارع عباس العقاد"]) { r = await post(m, fs); fs = r.json.formState; }
  const r2 = await post("01012345678", fs);
  assert.equal(r2.json.formState.data.area ?? null, null, "a phone is not an area");
});

test("E-3: a year-like number is not a price and not a correction", async () => {
  let fs = await driveOwnerToNameStep("9500000");
  const r = await post("العمارة اتبنت سنة 2015", fs);
  assert.equal(r.json.formState.data.price, 9500000, "the price is untouched");
  assert.notEqual(r.json.formState.data.buildingYear, 2015);
});

// ═════════════════ F. the name step ═════════════════
test("F-1: names that look like person names are accepted (including single and unusual ones)", async () => {
  const cases = [
    ["طارق طنطاوي", "طارق طنطاوي"],
    ["محمد", "محمد"],
    ["أحمد علي", "أحمد علي"],
    ["عبد الرحمن", "عبد الرحمن"],
    ["م. أحمد علي", "أحمد علي"],
    ["اسمي أحمد علي", "أحمد علي"],
    ["Ahmed Ali", "Ahmed Ali"],
    ["لا، قصدي أحمد علي", "أحمد علي"],
  ];
  for (const [msg, want] of cases) {
    const fs = await driveOwnerToNameStep();
    const r = await post(msg, fs);
    assert.equal(r.json.formState.data.ownerName, want, `"${msg}" → "${want}"`);
  }
});

test("F-2: phones, amounts, addresses, digits and random answers are not saved as a name", async () => {
  const rejected = ["01123456789", "5 مليون", "مدينة نصر شارع مكرم عبيد", "12345", "تمام تمام", "asdf", "شقة 180 متر"];
  for (const msg of rejected) {
    const fs = await driveOwnerToNameStep();
    const r = await post(msg, fs);
    const d = r.json.formState.data || {};
    assert.ok(!d.ownerName, `"${msg}" must not be saved as a name (got ${JSON.stringify(d.ownerName)})`);
    assert.ok(/اسم حضرتك|ولا يهمك|معلش/.test(String(r.json.response)), `"${msg}" is answered with a natural re-ask`);
  }
});

test("F-3: the saved name survives a session round-trip and is not replaced by a later number", async () => {
  let fs = await driveOwnerToNameStep();
  let r = await post("أحمد علي", fs);
  assert.equal(r.json.formState.data.ownerName, "أحمد علي");
  // the page stores the state and sends it back on the next message (a session round-trip)
  const roundTripped = JSON.parse(JSON.stringify(r.json.formState));
  const r2 = await post("01512345678", roundTripped);
  assert.equal(r2.json.formState.data.ownerName, "أحمد علي", "the name survives and is not stolen by the phone");
  assert.equal(r2.json.formState.data.ownerPhone, "01512345678");
  assert.equal(r2.json.formState.data.price, 9500000, "and the price is still intact");
});

test("F-4: a corrected name replaces the old one", async () => {
  let fs = await driveOwnerToNameStep();
  let r = await post("أحمد علي", fs);
  r = await post("⬅️ رجوع", r.json.formState);
  assert.match(String(r.json.response), /اسم حضرتك/, "back returns to the name question");
  const r2 = await post("أحمد محمد", r.json.formState);
  assert.equal(r2.json.formState.data.ownerName, "أحمد محمد");
});

test("F-5: the buyer's name is stored in buyerName (not in notes) and validated", async () => {
  let fs = await driveBuyerToNameStep();
  let r = await post("أحمد علي", fs);
  assert.equal(r.json.formState.data.buyerName, "أحمد علي", "the buyer's name is captured");
  assert.ok(!r.json.formState.data.notes || !String(r.json.formState.data.notes).includes("أحمد علي"), "the name is not pushed into notes");
  // a rejected answer at the buyer's name step
  fs = await driveBuyerToNameStep();
  r = await post("01123456789", fs);
  assert.ok(!r.json.formState.data.buyerName, "a phone is not a buyer name");
});

test("F-6: the name never reaches Gemini and no identity claim is made", async () => {
  H.resetGemini();
  let fs = await driveOwnerToNameStep();
  let r = await post("طارق طنطاوي", fs);
  r = await post("01512345678", r.json.formState);
  r = await post("⏭ تخطي (بدون صور)", r.json.formState);
  const all = (H.gemini || []).map(g => `${g.system || ""} ${JSON.stringify(g.contents)}`).join("\n");
  assert.ok(!all.includes("طارق طنطاوي"), "the name is not forwarded to Gemini");
  assert.ok(!/verified|مؤكد الهوية|identity confirmed/i.test(all), "no identity-verified claim is made");
  assert.equal(r.json.formState.data.ownerName, "طارق طنطاوي", "the name stays only in the client state and the lead");
});

// ═════════════════ G. the old paths still behave ═════════════════
test("G-1: the explicit money forms still seed a brand-new flow and the bare number does not", async () => {
  const withAmount = await post("عندي شقة في مدينة نصر بـ 3 مليون", {});
  assert.equal(withAmount.json.formState.data?.price, 3000000, "an explicit first message seeds the price");
  const ambiguous = await post("عندي شقة في مدينة نصر بـ 3 مليون أو 4 مليون", {});
  assert.ok(!ambiguous.json.formState.data?.price, "an ambiguous first message does not seed a price");
});

test("G-2: rooms/baths/area keep flowing from a plain answer", async () => {
  let r = await post("💰 أبيع", {}); let fs = r.json.formState;
  for (const [m, key, want] of [["شقة", "propertyType", "شقة"], ["شارع عباس العقاد", "location", "عباس العقاد"], ["180", "area", 180], ["9500000", "price", 9500000]]) {
    r = await post(m, fs); fs = r.json.formState;
    assert.equal(fs.data[key], want, `${key} after "${m}"`);
  }
});
