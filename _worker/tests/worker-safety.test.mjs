// Agent Worker (_worker/worker.js) — privacy / validation / abuse-limit safety net.
//   D-1 valuationResult صارم · D-2 صياغة الإعلان · D-4+D-4b لا GPS ولا عنوان لـ Gemini · D-5 إخفاء الأرقام الشخصية · D-6 حدود الحجم والرفع
// بنجرّب الـWorker من برّه (fetch handler الحقيقي) وبنلتقط كل طلب رايح لـ Gemini من fetch وهمي.
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chunkedJsonBody } from "./_fixtures.mjs";
import * as H from "./_agent-harness.mjs";

before(() => H.installFetchMock());
after(() => H.restoreFetch());

const enc = new TextEncoder();
const OVERHEAD = enc.encode('{"message":"hi","pad":"').length + 2;   // بادئة + لاحقة جسم chunkedJsonBody
const asciiDigits = s => String(s).replace(/[٠-٩۰-۹]/g, d => String(d.charCodeAt(0) >= 0x06F0 ? d.charCodeAt(0) - 0x06F0 : d.charCodeAt(0) - 0x0660));

function post(path, body, { ip = H.nextIp(), headers = {}, env } = {}) {
  return H.rawAgentRequest(path, {
    method: "POST",
    headers: { Origin: H.ORIGIN, "Content-Type": "application/json", "CF-Connecting-IP": ip, ...headers },
    body,
    ...(typeof body === "string" ? {} : { duplex: "half" }),
  }, env);
}
// حالة مالك «سياقية»: flowType غير معروف ⇒ الرسالة بتروح لـ geminiContextual (مسار السؤال الجانبي)
const contextualState = over => H.qualifiedOwnerState({
  flowType: "owner_x",
  data: {
    propertyType: "شقة", location: H.ADDRESS, area: 180, price: 9500000, ownerName: "أحمد محمد", ownerPhone: "01012345678",
    gps: { ...H.GPS }, ...(over || {}),
  },
});
const SIDE_Q = "الكمبوند اللي جنبي كويس ولا لأ يا باشا";

// ───────────── D-6: الأحجام ─────────────
test("D-6: the chat body cap is exactly 256KB and is counted on the wire (chunked bodies included)", async () => {
  const LIMIT = 256 * 1024;
  const exact = await post("/", chunkedJsonBody(LIMIT - OVERHEAD));
  assert.equal(exact.status, 200, "exactly 256KB is accepted");
  const over = await post("/", chunkedJsonBody(LIMIT - OVERHEAD + 1));
  assert.equal(over.status, 413, "256KB + 1 byte is rejected even without a Content-Length");
  assert.match((await over.json()).response, /الرسالة كبيرة/);
  const declared = await post("/", "{}", { headers: { "Content-Length": String(LIMIT + 1) } });
  assert.equal(declared.status, 413, "a declared oversize body is refused before it is read");
  assert.equal((await declared.json()).error, "Payload too large");
  const ok = await H.agentPost({ message: "السلام عليكم", formState: {}, history: [] });
  assert.equal(ok.status, 200, "normal requests are untouched");
});

test("D-6: /upload-images needs a JSON content type and caps the body at exactly 12MB", async () => {
  const LIMIT = 12 * 1024 * 1024;
  const up = (body, headers = {}) => post("/upload-images", body, { headers, env: {} });
  assert.equal((await up("{}", { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await up("{}", { "Content-Type": "" })).status, 415);
  const json = await up(JSON.stringify({ images: [] }), { "Content-Type": "application/json; charset=utf-8" });
  assert.notEqual(json.status, 415, "JSON with a charset is still JSON");
  const over = await up(chunkedJsonBody(LIMIT - OVERHEAD + 1, 256 * 1024));
  assert.equal(over.status, 413);
  const exact = await up(chunkedJsonBody(LIMIT - OVERHEAD, 256 * 1024));
  assert.notEqual(exact.status, 413, "exactly 12MB is allowed through to validation");
  const declared = await up("{}", { "Content-Length": String(LIMIT + 1) });
  assert.equal(declared.status, 413);
});

test("D-6: a single image is capped at 6MB, at most 5 images per request, and only real base64 is forwarded", async () => {
  const env = { IMGBB_API_KEY: "test-key" };
  const send = images => post("/upload-images", JSON.stringify({ images }), { env });
  H.resetGemini();
  const good = "A".repeat(200);
  const ok = await send([good, `data:image/png;base64,${good}`]);
  assert.equal(ok.status, 200);
  const okBody = await ok.json();
  assert.equal(okBody.urls.length, 2);
  assert.ok(okBody.urls.every(u => u.startsWith("https://")));
  assert.equal(H.imgbb.length, 2);

  H.resetGemini();
  const tooBig = "A".repeat(Math.ceil((6 * 1024 * 1024 + 8) * 4 / 3));
  const big = await send([tooBig]);
  assert.equal(big.status, 400);
  assert.equal((await big.json()).error, "Invalid image data");
  assert.equal(H.imgbb.length, 0, "an oversized image never reaches imgbb");

  const junk = await send(["not base64!!", 42, null, "data:text/html;base64,AAAA"]);
  assert.equal(junk.status, 400);
  assert.equal(H.imgbb.length, 0);

  const six = await send(Array.from({ length: 6 }, () => good));
  assert.equal(six.status, 400);
  assert.equal((await six.json()).error, "Max 5");
});

test("D-6: uploads are limited to 4 per minute and 20 per hour per IP", async () => {
  const send = ip => post("/upload-images", JSON.stringify({ images: [] }), { ip, env: {} }).then(r => r.status);
  const burst = [];
  for (let i = 0; i < 5; i += 1) burst.push(await send("upload-ip-A"));
  assert.deepEqual(burst.map(s => s === 429), [false, false, false, false, true], "the 5th upload inside a minute is refused");
  assert.notEqual(await send("upload-ip-B"), 429, "limits are per IP");

  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const statuses = [];
    for (let i = 0; i < 21; i += 1) {
      if (i > 0 && i % 4 === 0) clock += 61 * 1000;            // كل 4 طلبات نفتح نافذة الدقيقة من جديد
      statuses.push(await send("upload-ip-C"));
    }
    assert.ok(statuses.slice(0, 20).every(s => s !== 429), "20 uploads spread over several minutes are fine");
    assert.equal(statuses[20], 429, "the 21st within the hour is refused although the minute window is clear");
    clock += 60 * 60 * 1000 + 1000;
    assert.notEqual(await send("upload-ip-C"), 429, "the hourly window slides");
  } finally {
    Date.now = realNow;
  }
});

test("chat rate limit is unchanged: 15 messages / 30s per IP, then 429", async () => {
  const codes = [];
  for (let i = 0; i < 17; i += 1) codes.push((await H.agentPost({ message: "", formState: {}, history: [] }, { ip: "chat-rate-ip" })).status);
  assert.deepEqual(codes.slice(0, 15).filter(s => s !== 200), []);
  assert.deepEqual(codes.slice(15), [429, 429]);
});

// ───────────── D-5: الأرقام الشخصية ─────────────
const PHONES = [
  "01012345678", "٠١٠١٢٣٤٥٦٧٨", "۰۱۰۱۲۳۴۵۶۷۸", "010 1234 5678", "010-1234-5678", "010.1234.5678",
  "+20 100 123 4567", "+201001234567", "00201001234567", "(010) 1234 5678", "01112345678", "01212345678", "01512345678",
];
const NATIONAL_IDS = ["29901011234567", "٢٩٩٠١٠١١٢٣٤٥٦٧"];

test("D-5: Egyptian mobiles (any format, Arabic/Persian digits) and 14-digit IDs never reach Gemini — message, history or prompt", async () => {
  for (const form of [...PHONES, ...NATIONAL_IDS]) {
    H.resetGemini();
    const r = await H.agentPost({
      message: `${SIDE_Q} ${form}`,
      formState: contextualState(),
      history: [{ role: "user", message: `تليفوني ${form}` }, { role: "assistant", message: "تمام" }, { role: "user", message: "ماشي" }],
    });
    assert.equal(r.status, 200, form);
    assert.equal(H.gemini.length, 1, `${form}: the side question goes to Gemini once`);
    const raw = H.geminiText();
    const digits = asciiDigits(form).replace(/\D/g, "");
    assert.ok(!raw.includes(form), `${form} leaked as written`);
    assert.ok(!asciiDigits(raw).replace(/[\s.\-()+]/g, "").includes(digits), `${form} leaked as digits`);
    assert.match(raw, /\[رقم\]/, `${form} must be replaced by the placeholder`);
  }
  // بيانات العميل نفسها (اسم + موبايل) مش بتدخل الـprompt أصلًا
  H.resetGemini();
  await H.agentPost({ message: SIDE_Q + " يا ريس", formState: contextualState(), history: [] });
  assert.ok(!H.geminiText().includes("01012345678"));
  assert.ok(!H.geminiText().includes("أحمد محمد"));
});

test("D-5: ordinary numbers (size, price, floor) are left alone", async () => {
  H.resetGemini();
  await H.agentPost({ message: `${SIDE_Q} المساحة 180 متر والمطلوب 9500000 جنيه والدور 3`, formState: contextualState(), history: [] });
  const raw = H.geminiText();
  assert.ok(raw.includes("180 متر") && raw.includes("9500000"), "numbers survive");
  assert.ok(!raw.includes("[رقم]"));
});

// ───────────── D-4 + D-4b: GPS والعنوان ─────────────
test("D-4: a full owner flow (map pin + typed address, then name and phone) never sends the address, GPS or phone to Gemini", async () => {
  H.resetGemini();
  const gift = await H.driveOwnerToGift({});
  assert.equal(H.gemini.length, 0, "location/landmark answers are never handed to Gemini for a comment");
  await H.finishOwnerFlow(gift.json.formState, { phone: "01512345678" });
  const raw = H.geminiText();
  for (const secret of [...H.SENSITIVE, "01512345678", "1512345678"]) assert.ok(!raw.includes(secret), `leaked: ${secret}`);

  // نفس المسار لو الإجابة هي عنوان الخريطة الإنجليزي نفسه
  H.resetGemini();
  await H.driveOwnerToGift({ locationMessage: H.GPS.address });
  assert.equal(H.gemini.length, 0);
  for (const secret of H.SENSITIVE) assert.ok(!H.geminiText().includes(secret), `leaked: ${secret}`);
});

test("D-4b: known addresses are scrubbed from side questions and history (typed address and map address)", async () => {
  H.resetGemini();
  const r = await H.agentPost({
    message: `${SIDE_Q} — قصدي ${H.ADDRESS} وبرضه ${H.GPS.address}`,
    formState: contextualState(),
    history: [
      { role: "user", message: `العنوان ${H.ADDRESS}` },
      { role: "assistant", message: `اتسجّل ${H.GPS.address}` },
      { role: "user", message: "تمام" },
    ],
  });
  assert.equal(r.status, 200);
  assert.equal(H.gemini.length, 1);
  const raw = H.geminiText();
  for (const secret of H.SENSITIVE) assert.ok(!raw.includes(secret), `leaked: ${secret}`);
  assert.match(raw, /\[عنوان\]/);
});

test("D-4: the valuation enters the prompt as numbers/enums only — never the area text the client typed", async () => {
  H.resetGemini();
  const valuation = { ...H.goodValuation(), area: H.ADDRESS };
  await H.agentPost({ message: SIDE_Q, formState: contextualState({ valuation }), history: [] });
  assert.equal(H.gemini.length, 1);
  const system = H.gemini[0].system;
  assert.match(system, /"valuation":\{"estimate":9360000,"perMeter":52000,"p25":46000,"p75":58000,"confidence":"high","samples":41,"areaType":"sale"\}/);
  assert.ok(!system.includes("نوارة") && !system.includes("العزبي"));
  assert.ok(!system.includes("median_price_m2"), "text fields of the valuation are not forwarded");
  assert.ok(!system.includes("ownerPhone") && !system.includes("gps") && !system.includes("location"));
});

// ───────────── D-1: valuationResult صارم ─────────────
const stored = async v => (await H.completeWithValuation(v)).json.formState?.data?.valuation;
const announced = async v => /تقييم عقارك/.test((await H.completeWithValuation(v)).json.response);

test("D-1: tampered valuationResult values never become a valuation (no coercion, no fake announcement)", async () => {
  const good = H.goodValuation();
  const rejected = [
    ["estimate: true", { ...good, estimate: true }],
    ["estimate: '9,360,000'", { ...good, estimate: "9,360,000" }],
    ["estimate: '1e7'", { ...good, estimate: "1e7" }],
    ["estimate: '0x10'", { ...good, estimate: "0x10" }],
    ["estimate: ' 9360000 '", { ...good, estimate: " 9360000 " }],
    ["estimate: [9360000]", { ...good, estimate: [9360000] }],
    ["estimate: {}", { ...good, estimate: {} }],
    ["estimate: null", { ...good, estimate: null }],
    ["estimate missing", (({ estimate, ...rest }) => rest)(good)],
    ["estimate: 0", { ...good, estimate: 0 }],
    ["estimate: -5", { ...good, estimate: -5 }],
    ["estimate: 1e13", { ...good, estimate: 1e13 }],
    ["estimate far from perMeter×size", { ...good, estimate: 1 }],
    ["estimate 10× perMeter×size", { ...good, estimate: 93600000 }],
    ["array payload", [good]],
    ["string payload", "9360000"],
    ["number payload", 9360000],
  ];
  for (const [label, value] of rejected) {
    assert.equal(await stored(value), undefined, `${label} must be rejected`);
    assert.equal(await announced(value), false, `${label} must not be announced`);
  }
});

test("D-1: valid payloads pass (numeric strings and Arabic digits included) and are normalised field by field", async () => {
  for (const estimate of [9360000, "9360000", "٩٣٦٠٠٠٠", 9360000.4]) {
    const v = await stored({ ...H.goodValuation(), estimate });
    assert.equal(v?.estimate, 9360000, `estimate ${JSON.stringify(estimate)}`);
  }
  const clean = await stored({
    ...H.goodValuation(), confidence: "super", samples: "x", p25: {}, p75: [], priceBasis: "evil", areaType: "x",
    area: "<b>المنطقة</b>  01012345678\u0000", extra: "dropped", savedAt: 1,
  });
  assert.equal(clean.confidence, "unknown");
  assert.equal(clean.samples, 0, "a wrong type on an optional field becomes 0");
  assert.equal(clean.p25, 0);
  assert.equal(clean.p75, 0, "an unusable range is dropped as a pair");
  assert.equal(clean.priceBasis, "");
  assert.equal(clean.areaType, "");
  assert.ok(!/[<>\u0000]/.test(clean.area) && !clean.area.includes("01012345678") && clean.area.includes("[رقم]"), clean.area);
  assert.equal("extra" in clean, false, "unknown keys are dropped");
  assert.deepEqual(Object.keys(clean).sort(), ["area", "areaType", "confidence", "estimate", "p25", "p75", "perMeter", "priceBasis", "samples", "savedAt", "size"]);
  assert.ok(Math.abs(Date.now() - clean.savedAt) < 10_000, "savedAt is the server's clock — the client's value is ignored");
  const longArea = await stored({ ...H.goodValuation(), area: "م".repeat(300) });
  assert.equal(longArea.area.length, 80);
  const tinySize = await stored({ ...H.goodValuation(), size: 5 });
  assert.equal(tinySize.size, 0, "an out-of-range size is dropped (the estimate stays)");
});

test("D-1: the consistency check tolerates rounding (0.51×size+1) but nothing more", async () => {
  // size 180 × perMeter 52000 = 9,360,000 → tolerance 92.8
  assert.equal((await stored({ ...H.goodValuation(), estimate: 9360092 }))?.estimate, 9360092);
  assert.equal((await stored({ ...H.goodValuation(), estimate: 9360093 })), undefined);
  assert.equal((await stored({ ...H.goodValuation(), estimate: 9359908 }))?.estimate, 9359908);
  assert.equal((await stored({ ...H.goodValuation(), estimate: 9359907 })), undefined);
  // مفيش perMeter/size ⇒ مفيش فحص اتساق (والرقم نفسه لسه لازم يكون صالح)
  assert.equal((await stored({ estimate: 5000000, confidence: "low" }))?.estimate, 5000000);
});

test("D-1: a valuationResult can't be injected without an active flow", async () => {
  const r = await H.agentPost({ message: "السلام عليكم", formState: {}, history: [], valuationResult: H.goodValuation() });
  assert.equal(r.status, 200);
  assert.equal(r.json.formState?.data?.valuation, undefined);
  assert.doesNotMatch(r.json.response || "", /تقييم عقارك/);
});

// ───────────── D-2: الإعلان ─────────────
const gift = (opts) => H.driveOwnerToGift(opts);
const back = (g, valuationResult, message = "رجعت من التقييم") => H.agentPost({ message, formState: g.json.formState, history: [], valuationResult });

test("D-2: the announcement layout is fixed and the status line follows the confidence", async () => {
  const cases = [
    ["high", "🟢 عينة قوية — مؤشر موثوق نسبيًا", "عالية", "(41 عينة)"],
    ["medium", "🟡 عينة متوسطة — استرشادي", "متوسطة", "(41 عينة)"],
    ["low", "🔴 عينة محدودة — استرشادي فقط", "منخفضة", "(41 عينة)"],
    ["unknown", "⚪ الثقة غير محددة — مؤشر عام فقط", "غير محددة", "(41 عينة)"],
  ];
  for (const [confidence, status, label, samples] of cases) {
    const r = await back(await gift(), H.goodValuation({ confidence }));
    const text = r.json.response;
    const expectedOrder = [
      "تمام، شفت نتيجة التقييم 👌", "💎 *تقييم عقارك للبيع:*", "📍 المنطقة: المنطقة السادسة • 180 م²", "💰 السعر التقديري: 9,360,000 ج.م",
      "📊 النطاق الأساسي: 8,280,000 – 10,440,000 ج.م", "📏 سعر المتر (الوسيط): 52,000 ج.م/م²", "↕️ نطاق المتر (P25–P75): 46,000 – 58,000 ج.م/م²",
      `🎯 الثقة: ${label} ${samples}`, status, "ده مؤشر استرشادي من بيانات مدينة نصر، مش سعر إتمام مؤكد.", "نكمّل التسجيل؟", "اسم حضرتك إيه؟",
    ];
    let from = 0;
    for (const piece of expectedOrder) {
      const at = text.indexOf(piece, from);
      assert.ok(at >= 0, `${confidence}: «${piece}» missing or out of order`);
      from = at + piece.length;
    }
    for (const [other, otherStatus] of cases) if (other !== confidence) assert.ok(!text.includes(otherStatus), `${confidence} must not show the ${other} status`);
  }
});

test("D-2: rent valuations say «للإيجار» and «/ شهريًا»; the announcement is shown once", async () => {
  const g = await gift({ rent: true });
  const r = await back(g, H.goodValuation({ areaType: "rent", estimate: 62400, perMeter: 520, p25: 450, p75: 610, size: 120, confidence: "medium", samples: 19 }));
  const text = r.json.response;
  assert.match(text, /💎 \*تقييم عقارك للإيجار:\*/);
  assert.match(text, /💰 الإيجار التقديري: 62,400 ج\.م \/ شهريًا/);
  assert.match(text, /📊 النطاق الأساسي: 54,000 – 73,200 ج\.م \/ شهريًا/);
  assert.match(text, /📏 سعر المتر \(الوسيط\): 520 ج\.م\/م² \/ شهريًا/);
  assert.doesNotMatch(text, /للبيع/);
  assert.equal(r.json.formState.data._valuationShown, true);
  const next = await H.agentPost({ message: "أحمد", formState: r.json.formState, history: [] });
  assert.doesNotMatch(next.json.response, /تقييم عقارك/, "the announcement is not repeated on the next step");
});

test("D-2: missing optional fields drop their lines instead of showing zeros", async () => {
  const r = await back(await gift(), { estimate: 5000000, confidence: "low" });
  const text = r.json.response;
  assert.match(text, /💰 السعر التقديري: 5,000,000 ج\.م/);
  assert.match(text, /🔴 عينة محدودة/);
  assert.doesNotMatch(text, /📍 المنطقة|📏|↕️|📊|عينة\)/);
});
