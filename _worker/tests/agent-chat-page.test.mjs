// agent.html (Gemini أولًا) — السكربت الحقيقي للصفحة تحت node:vm، ومعاه الـWorker الحقيقي (/chat) وGemini وهمي.
//   • الموافقة قبل أول رسالة · كل رسالة = طلب /chat واحد = استدعاء Gemini واحد · مفيش طلبات إنشاء/تعديل/رفع
//   • الحالة في ذاكرة الصفحة بس · الملخص قابل للتعديل (والتعديل رسالة لـGemini) · لوحة «من بيانات الموقع»
//   • الأخطاء: رسالة واضحة + إعادة محاولة + بحث محلي باختيارك (مفيش تحويل صامت ولا رد متألف)
//   ⚠️ Gemini هنا mock: الاختبارات دي بتثبت سلوك الصفحة والـWorker، مش جودة ردود Gemini الحقيقي.
import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, beforeEach, test } from "node:test";
import vm from "node:vm";
import agentWorker from "../worker.js";
import { calls, installChatMock, nextIp, onGemini, reply, resetCalls, restoreChatMock } from "./_chat-harness.mjs";
import { bootAgent } from "./_dom-agent.mjs";

// نواة البحث المحلي (نفس الملفات اللي الصفحة بتحمّلها) — للاختيار الصريح «ابحث محليًا»
const coreCtx = vm.createContext({});
for (const p of ["assets/js/catalog-search-core.js", "assets/js/agent-request-core.js"]) {
  vm.runInContext(fs.readFileSync(new URL(`../../${p}`, import.meta.url), "utf8"), coreCtx);
}
const A = coreCtx.NasrAgent;

before(() => installChatMock());
after(() => restoreChatMock());
beforeEach(() => { resetCalls(); onGemini(null); });

const CONSENT = { simsar_gemini_consent_v1: "gemini-v1" };
const CHAT_URL = "https://royal-snow-ea32.footcai-555.workers.dev/chat";
async function send(a, text) { a.el("msgInput").value = text; await a.run("sendMsg()"); }
const chips = a => a.el("actionRail").querySelectorAll(".chip");
const lastAi = a => a.messages().filter(m => m._classes.has("msg-ai")).at(-1);
const lastData = a => a.messages().filter(m => m._classes.has("msg-data")).at(-1);

// الصفحة بتكلم الـWorker الحقيقي؛ أي طلب تاني بيتسجل كـ«غير متوقع»
function workerFetch(log) {
  return async (url, init = {}) => {
    const u = String(url);
    log.push({ url: u, method: init.method || "GET", body: init.body ? JSON.parse(init.body) : null });
    if (u === CHAT_URL) {
      return agentWorker.fetch(new Request("https://agent.test/chat", {
        method: init.method, headers: { "Content-Type": "application/json", Origin: "https://nasr-realestate.github.io", "CF-Connecting-IP": nextIp() }, body: init.body,
      }), { GEMINI_API_KEY: "test-key" });
    }
    throw new Error(`unexpected request from the page: ${u}`);
  };
}
function bootWithWorker(opts = {}) {
  const log = [];
  const opened = [];
  const a = bootAgent({ local: CONSENT, runTimers: true, fetchImpl: workerFetch(log), ...opts });
  a.win.open = (...args) => opened.push(args);
  return { a, log, opened };
}

test("first message: the one-time consent sheet appears before anything is sent; accepting sends the same message once to /chat", async () => {
  const log = [];
  const a = bootAgent({ runTimers: true, fetchImpl: workerFetch(log) });
  onGemini(() => reply("أهلًا بيك! بتدوّر على عقار ولا عندك عقار تعرضه؟", {}, { intent: "greeting" }));
  await send(a, "أهلا");
  assert.equal(a.el("privacyOverlay").classList.contains("show"), true, "consent first");
  assert.equal(log.length, 0, "nothing leaves the browser before consent");
  assert.equal(calls.gemini.length, 0);
  assert.equal(a.messages().length, 1, "the pending message is not rendered as sent");
  await a.run("acceptConsent()");
  assert.equal(a.el("privacyOverlay").classList.contains("show"), false);
  assert.equal(log.length, 1);
  assert.equal(log[0].method, "POST");
  assert.equal(log[0].url, CHAT_URL);
  assert.equal(log[0].body.consent, "gemini-v1");
  assert.equal(log[0].body.message, "أهلا");
  assert.equal(calls.gemini.length, 1);
  assert.match(lastAi(a).innerHTML, /أهلًا بيك!/);
  assert.match(lastAi(a).innerHTML, /class="ai-tag"[^>]*>Gemini</, "the reply is labelled as Gemini's");
  assert.equal(a.localStorage.getItem("simsar_gemini_consent_v1"), "gemini-v1");
  // الموافقة مرة واحدة: الرسالة التانية بتتبعت على طول
  await send(a, "شكرا");
  assert.equal(log.length, 2);
  assert.equal(a.el("privacyOverlay").classList.contains("show"), false);
});

test("declining consent switches to the explicit local search: no Worker, no Gemini, and the header says so", async () => {
  const log = [];
  const a = bootAgent({ extraGlobals: { NasrAgent: A }, fetchImpl: async (url, init = {}) => { log.push({ url: String(url), method: init.method || "GET" }); return new Response("[]"); } });
  a.run("window.NasrAgent = NasrAgent");
  await send(a, "عندي شقة للبيع في عباس العقاد 180 متر بسعر 8 ملايين");
  assert.equal(a.el("privacyOverlay").classList.contains("show"), true);
  await a.run("declineConsentLocal()");
  assert.equal(a.run("isLocalMode()"), true);
  assert.equal(a.el("requestModeBar").hidden, false, "the local-mode bar is visible");
  assert.equal(a.el("statusText").textContent, "بحث محلي • بدون ذكاء اصطناعي");
  assert.ok(log.every(c => c.url !== CHAT_URL && c.method === "GET"), "no POST, never /chat");
  assert.equal(calls.gemini.length, 0);
  assert.ok(a.messages().some(m => /بحث محلي في كتالوج الموقع من غير ذكاء اصطناعي/.test(m.innerHTML)), "the switch is announced, never silent");
  assert.equal(a.localStorage.getItem("simsar_gemini_consent_v1"), null, "declining stores no consent");
  // والرجوع لـGemini اختيار صريح برضه
  a.run("toggleMode()");
  assert.equal(a.run("isLocalMode()"), false);
  assert.equal(a.el("requestModeBar").hidden, true);
});

test("every message — typed, quick-reply chips and summary edits — is exactly one /chat POST and one Gemini call; nothing else is requested or opened", async () => {
  const { a, log, opened } = bootWithWorker();
  const script = [
    reply("تمام! بتدوّر على إيه بالظبط؟", { role: "seeker" }, { intent: "search_buy" }),
    reply("تمام، دي النتائج المطابقة من الموقع تحت. تحب نضيّقها بحتة معينة؟", { role: "seeker", operation: "buy", property_type: "apartment", location: "مدينة نصر", area_value: 180, price_value: 7000000, rooms: 3 }),
    reply("تمام، غيّرت الميزانية إلى 6 ملايين، وباقي المواصفات زي ما هي.", { price_value: 6000000 }),
    reply("تمام، شلت شرط الميزانية.", {}, { intent: "update_details" }),
  ];
  onGemini((call, n) => script[n - 1]);
  await chips(a)[0].onclick();                            // «أبحث عن عقار»
  assert.equal(log.length, 1, "a chip is a normal message to Gemini");
  assert.equal(log[0].body.message, "أبحث عن عقار");
  await send(a, "أنا عايز أشتري شقة 180 متر في مدينة نصر، 3 غرف، بحد أقصى 7 ملايين.");
  assert.equal(a.el("summaryBar").hidden, false);
  assert.equal(a.el("summaryLine").textContent, "شراء · شقة · مدينة نصر · حتى 7 ملايين · 180م · 3 غرف أو أكثر");
  await send(a, "غيّر الميزانية فقط إلى 6 ملايين.");
  assert.equal(a.el("summaryLine").textContent, "شراء · شقة · مدينة نصر · حتى 6 ملايين · 180م · 3 غرف أو أكثر");
  assert.match(lastData(a).innerHTML, /✏️ اتعدّل: الميزانية: حتى 6 ملايين — وباقي المواصفات زي ما هي\./);
  // × على شرط الميزانية = رسالة صريحة لـGemini (مفيش تعديل محلي صامت)
  const priceChip = a.el("summaryChips").children.find(c => /حتى 6 ملايين/.test(c.children[0].textContent));
  await priceChip.children.find(b => b._classes.has("sum-del")).onclick();
  assert.equal(log.length, 4);
  assert.equal(log[3].body.message, "شيل شرط الميزانية");
  assert.equal(a.run("state.chat.price"), null);
  assert.equal(calls.gemini.length, 4, "one Gemini call per message");
  assert.ok(log.every(c => c.url === CHAT_URL && c.method === "POST"), "only /chat — no uploads, no submissions, no other endpoints");
  assert.deepEqual(opened, [], "nothing is opened automatically (WhatsApp included)");
  assert.deepEqual(calls.unexpected, []);
  // الحالة + التاريخ في ذاكرة الصفحة بس
  assert.equal(a.sessionStorage._map.size, 0);
  assert.deepEqual([...a.localStorage._map.keys()], ["simsar_gemini_consent_v1"]);
  assert.ok(log[3].body.history.length <= 10);
  assert.equal(log[3].body.state.price.value, 6000000, "the previous structured state travels with each message");
});

test("✎ on a summary item prepares a correction in the composer instead of changing anything silently", async () => {
  const { a, log } = bootWithWorker();
  onGemini(() => reply("تمام.", { role: "seeker", operation: "buy", property_type: "apartment", location: "مدينة نصر", area_value: 180, price_value: 7000000 }));
  await send(a, "عايز أشتري شقة 180 متر في مدينة نصر بحد أقصى 7 ملايين");
  const area = a.el("summaryChips").children.find(c => c.children[0].textContent === "180م");
  area.children.find(b => b._classes.has("sum-edit")).onclick();
  assert.equal(a.el("msgInput").value, "غيّر المساحة إلى ");
  assert.equal(log.length, 1, "editing alone sends nothing");
  assert.equal(a.run("state.chat.area.value"), 180);
});

test("results are site data in a separate panel: real links, publication date and «needs owner confirmation»; «اسأل عنه» sends the listing id with the next question", async () => {
  const { a, log } = bootWithWorker();
  onGemini(() => reply("تمام، دي النتائج المطابقة من الموقع تحت.", { role: "seeker", operation: "buy", property_type: "apartment", location: "مدينة نصر", area_value: 180, price_value: 7000000, rooms: 3 }));
  await send(a, "أنا عايز أشتري شقة 180 متر في مدينة نصر، 3 غرف، بحد أقصى 7 ملايين.");
  const panel = lastData(a).innerHTML;
  assert.match(panel, /من بيانات الموقع — مش من Gemini/);
  assert.match(panel, /4 عقارات منشورة مطابقة لكل شروطك في مدينة نصر/);
  for (const slug of ["test-sale-180-makram", "test-sale-175-abbas", "test-sale-185-zone7", "test-sale-190-hayy10"]) {
    assert.match(panel, new RegExp(`href="/properties/${slug}/"`));
  }
  assert.doesNotMatch(panel, /test-archive-rehab|test-rent/);
  assert.match(panel, /منشور <bdi dir="ltr">2026-10-20<\/bdi> · التوافر يحتاج تأكيد من المالك/);
  assert.doesNotMatch(lastAi(a).innerHTML, /6,500,000|6\.5 مليون/, "listing details live in the data panel, not in Gemini's text");
  a.run(`askAbout("test-sale-175-abbas")`);
  assert.equal(a.el("msgInput").value, "عندي سؤال عن العقار ده: ");
  onGemini(() => reply("أيوه متاح النهارده!"));
  a.el("msgInput").value = "عندي سؤال عن العقار ده: هل متاح اليوم؟";
  await a.run("sendMsg()");
  assert.equal(log.at(-1).body.focus, "test-sale-175-abbas");
  assert.doesNotMatch(lastAi(a)?.innerHTML || "", /متاح النهارده/, "an availability claim never reaches the screen");
  assert.match(lastData(a).innerHTML, /التوافر يحتاج تأكيد من المالك/);
  await send(a, "طب شكرا");
  assert.equal(log.at(-1).body.focus, undefined, "the focus applies to one message only");
});

test("clarifying questions come with optional quick replies; tapping one sends it to Gemini like any message", async () => {
  const { a, log } = bootWithWorker();
  onGemini(() => reply("تحب نبدأ بالبيع ولا بالإيجار؟", {}, { intent: "unclear", needs_clarification: true }));
  await send(a, "شقة للبيع والإيجار معًا");
  assert.deepEqual(chips(a).map(c => c.textContent), ["بدوّر على شقة للشراء", "بدوّر على شقة للإيجار", "عندي شقة للبيع", "عندي شقة للإيجار"]);
  onGemini(() => reply("تمام! الشقة في أنهي منطقة؟", { role: "owner", operation: "sell" }));
  await chips(a)[2].onclick();
  assert.equal(log[1].body.message, "عندي شقة للبيع");
  assert.equal(a.run("state.chat.operation"), "sell");
});

test("owner: price never re-asked, comparison shown with count/date/caveat, and WhatsApp + 💎 are explicit buttons only", async () => {
  const { a, opened } = bootWithWorker();
  onGemini(() => reply("تمام. الشقة في أنهي منطقة؟", { role: "owner", operation: "sell", property_type: "apartment", area_value: 180, price_value: 8000000 }));
  await send(a, "عندي شقة للبيع، 180 متر، وأطلب 8 ملايين.");
  assert.equal(a.el("waWrapper").classList.contains("show"), false, "no contact action before the core details");
  onGemini(() => reply("حلو. المقارنة الاسترشادية تحت. فيها كام أوضة؟", { location: "المنطقة السابعة" }));
  await send(a, "في المنطقة السابعة");
  const panel = lastData(a).innerHTML;
  assert.match(panel, /مقارنة استرشادية<\/strong> — 3 إعلانات منشورة \(شقق · بيع · المنطقة السابعة\)/);
  assert.match(panel, /وسيط سعر المتر في الإعلانات: <strong>45,000 ج\.م\/م²<\/strong>/);
  assert.match(panel, /سعرك: 44,444 ج\.م\/م² — قريب من الوسيط/);
  assert.match(panel, /البيانات بتاريخ <bdi dir="ltr">2026-10-26<\/bdi>/, "ISO dates are direction-isolated inside Arabic text");
  assert.match(panel, /مش أسعار صفقات مكتملة ولا تقييم مهني/);
  assert.match(panel, /اعرض عقارك رسميًا/);
  assert.equal(a.el("waWrapper").classList.contains("show"), true);
  const wa = decodeURIComponent(a.el("waBtn").href);
  assert.match(wa, /^https:\/\/wa\.me\/201147758857\?text=/);
  assert.match(wa, /عندي عقار: بيع · شقة · المنطقة السابعة · مطلوب 8 ملايين · 180م/);
  assert.ok(a.el("valuationSlot").querySelector(".valuation-link"));
  assert.deepEqual(opened, [], "WhatsApp opens only when the visitor taps the button");
  assert.equal(a.run("state.chat.asked"), "rooms");
});

test("Gemini outage: clear error, no fabricated reply, typing cleared; retry resends the same text; local search only when chosen", async () => {
  const { a, log } = bootWithWorker();
  let down = true;
  onGemini(() => (down ? new Response("{}", { status: 500 }) : reply("تمام! بتدوّر على شقة شراء ولا إيجار؟", { role: "seeker" })));
  await send(a, "عايز شقة");
  const err = a.messages().at(-1);
  assert.ok(err._classes.has("msg-error"));
  assert.match(err.innerHTML, /مساعد Gemini متوقف مؤقتًا/);
  assert.match(err.innerHTML, /جرّب تاني/);
  assert.match(err.innerHTML, /ابحث محليًا بدون ذكاء اصطناعي/);
  assert.equal(a.messages().filter(m => m._classes.has("msg-ai")).length, 0, "no reply bubble is invented");
  assert.equal(a.el("typingBubble").classList.contains("active"), false);
  assert.equal(a.el("msgInput").value, "عايز شقة", "the message is back in the composer");
  assert.equal(a.run("isLocalMode()"), false, "no silent switch");
  assert.ok(a.messages().some(m => m._classes.has("msg-failed")), "the unsent bubble is marked");
  down = false;
  a.el("msgInput").value = "";
  await a.run("retryLast()");
  assert.equal(log.length, 2);
  assert.equal(log[1].body.message, "عايز شقة");
  assert.match(lastAi(a).innerHTML, /بتدوّر على شقة شراء ولا إيجار؟/);
  assert.equal(a.messages().filter(m => m._classes.has("msg-failed")).length, 0, "the failed bubble is replaced by the real send");
});

test("choosing «ابحث محليًا» after an error runs the same text through the local search — and says so", async () => {
  const log = [];
  const a = bootAgent({ local: CONSENT, runTimers: true, extraGlobals: { NasrAgent: A }, fetchImpl: async (url, init = {}) => {
    log.push({ url: String(url), method: init.method || "GET" });
    if (String(url) === CHAT_URL) return new Response(JSON.stringify({ ok: false, error: "gemini_timeout", message: "x" }), { status: 504 });
    return new Response("[]");
  } });
  a.run("window.NasrAgent = NasrAgent");
  await send(a, "عايز شقة للإيجار في عباس العقاد");
  assert.match(a.messages().at(-1).innerHTML, /Gemini اتأخر/);
  await a.run("useLocalForLast()");
  assert.equal(a.run("isLocalMode()"), true);
  assert.ok(a.messages().some(m => /بحث محلي في كتالوج الموقع من غير ذكاء اصطناعي/.test(m.innerHTML)));
  assert.equal(log.filter(c => c.url === CHAT_URL).length, 1, "the local search never calls /chat");
});

test("an old Worker answering /chat with the legacy shape is treated as unavailable — its text is never shown as a Gemini reply", async () => {
  const a = bootAgent({ local: CONSENT, fetchImpl: async () => new Response(JSON.stringify({ response: "رد قديم من المسار القديم", formState: {} }), { status: 200 }) });
  await send(a, "أهلا");
  assert.match(a.messages().at(-1).innerHTML, /خادم المساعد لسه مش متحدّث لنسخة Gemini الجديدة/);
  assert.ok(a.messages().every(m => !/رد قديم من المسار القديم/.test(m.innerHTML)));
});

test("a 412 from the Worker re-opens the consent sheet with the message kept", async () => {
  const a = bootAgent({ local: CONSENT, fetchImpl: async () => new Response(JSON.stringify({ ok: false, error: "consent_required" }), { status: 412 }) });
  await send(a, "عايز شقة");
  assert.equal(a.el("privacyOverlay").classList.contains("show"), true);
  assert.equal(a.localStorage.getItem("simsar_gemini_consent_v1"), null);
  a.run("closeConsent()");
  assert.equal(a.el("msgInput").value, "عايز شقة");
});

test("revoking consent from the menu asks again before the next message", async () => {
  const { a, log } = bootWithWorker();
  onGemini(() => reply("تمام."));
  await send(a, "أهلا");
  assert.equal(log.length, 1);
  a.run("revokeConsent()");
  assert.equal(a.localStorage.getItem("simsar_gemini_consent_v1"), null);
  await send(a, "تاني");
  assert.equal(log.length, 1);
  assert.equal(a.el("privacyOverlay").classList.contains("show"), true);
});

test("hostile content from the network is escaped: reply HTML, card fields and unsafe links never become markup", async () => {
  const evil = {
    ok: true, reply: "<img src=x onerror=alert(1)> أهلا", state: { v: 1 }, summary: [{ field: "location", name: "<b>x</b>", label: "<script>alert(1)</script>", removable: true }],
    results: { count: 1, alternatives: [], cards: [{ slug: "x\" onclick=\"alert(1)", url: "javascript:alert(1)", title: "<img src=x onerror=alert(2)>", price: "<b>1</b>", image: "javascript:alert(3)", availability: { status: "confirmed_on_date", lastConfirmedAt: "<b>" } }] },
    notices: [{ kind: "x", text: "<iframe src=//evil>" }], changeNote: "<svg onload=alert(1)>", provider: { name: "gemini" }, quickReplies: ["<b>chip</b>"],
  };
  const a = bootAgent({ local: CONSENT, fetchImpl: async () => new Response(JSON.stringify(evil), { status: 200 }) });
  await send(a, "أهلا");
  const html = a.messages().map(m => m.innerHTML).join("\n");
  assert.doesNotMatch(html, /<img src=x|<script|<iframe|<svg onload|javascript:|onclick="alert/);
  assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt; أهلا/);
  assert.match(html, /التوافر يحتاج تأكيد من المالك/, "a malformed confirmation date is not trusted");
  assert.equal(a.el("summaryLine").textContent, "<script>alert(1)</script>", "summary text is set as text, not HTML");
  assert.equal(chips(a)[0].textContent, "<b>chip</b>");
});

test("the start state: Gemini mode label, local bar hidden, no transcript restored, composer enabled", () => {
  const a = bootAgent();
  assert.equal(a.el("statusText").textContent, "مساعد ذكي بـGemini • جاهز");
  assert.equal(a.el("requestModeBar").hidden, true);
  assert.equal(a.el("summaryBar").hidden, true, "no summary until there is something to summarise");
  assert.equal(a.run("state.history.length"), 0);
  assert.equal(a.el("sendBtn").disabled, false);
  assert.match(a.el("composerHint").textContent, /الردود من Gemini، والعقارات والأسعار من بيانات الموقع بس/);
});

test("when the Worker blocked Gemini's whole reply, the safe sentence is labelled «فحص الموقع», not «Gemini»", async () => {
  const { a } = bootWithWorker();
  onGemini(() => reply("الدولار النهارده بـ 48.5 جنيه.", {}, { intent: "off_topic" }));
  await send(a, "الدولار بكام؟");
  const bubble = lastAi(a).innerHTML;
  assert.match(bubble, /معنديش معلومة موثقة/);
  assert.match(bubble, />فحص الموقع</);
  assert.doesNotMatch(bubble, />Gemini</);
  assert.match(lastData(a).innerHTML, /اتشال من الرد رقم مش موجود في بيانات الموقع أو في كلامك/);
});
