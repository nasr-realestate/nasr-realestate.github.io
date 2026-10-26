// agent.html — the page's inline script under node:vm with a tiny DOM (see _dom-agent.mjs).
//   T1.1 داكن دايمًا · T1.1b هوية أسود + أخضر الشعار · T1.2 مصادر الصور + noopener · T1.3 سقف history (آخر 10 لـGemini) · T1.4 تسمية الأساس · T1.5 هوية المساعد
//   + الرجوع من التقييم، زر 💎، الخصوصية (ذاكرة الصفحة فقط)، والتمرير الذكي.
//   2026-10-27: الصفحة بقت «Gemini أولًا» (POST /chat) — الاختبارات اللي كانت بتفترض مسار formState القديم
//   (أزرار الخدمات الأربعة، شريط التقدم، حفظ المحادثة في sessionStorage) اتعادت كتابتها للعقد الجديد.
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";
import { agentHtml, agentStyle, bootAgent } from "./_dom-agent.mjs";
import { valuationHtml } from "./_dom-page.mjs";

const BASE = "https://nasr-realestate.github.io";
const RETURN_QS = "?return=valuation&estimate=9360000&confidence=high&samples=41&perMeter=52000&p25=46000&p75=58000&basis=median_price_m2&area="
  + encodeURIComponent("المنطقة السادسة") + "&size=180&areaType=sale";
const fetchOk = (json, calls = [], status = 200) => async (url, init) => {
  calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
  return { ok: status === 200, status, json: async () => json };
};
async function send(a, text) { a.el("msgInput").value = text; await a.run("sendMsg()"); }
const CONSENT = { simsar_gemini_consent_v1: "gemini-v1" };
// رد /chat صالح (نفس شكل الـWorker v10)
const chatReply = (reply, over = {}) => ({ ok: true, v: 1, reply, intent: "unclear", state: { v: 1, role: null }, changes: [], changeNote: null, summary: [],
  ask: null, askOptional: false, clarify: null, quickReplies: [], results: null, comparables: null, focus: null, contact: false, notices: [],
  grounding: { removed: 0, replaced: false }, dataAt: "2026-10-26", provider: { name: "gemini", model: "test-model" }, now: { date: "2026-10-27", time: "12:00", timeZone: "Africa/Cairo" }, ...over });
const params = href => Object.fromEntries(new URL(href, BASE).searchParams);

// ───────── T1.1: داكن دايمًا ─────────
// الستايل الفعّال لمحدد: آخر إعلان لكل خاصية بترتيب المصدر (الـcascade) — مش آخر بلوك بس ولا أي بلوك متلغي
function effectiveOf(rules, selector) {
  const decl = new Map();
  for (const r of rules) {
    if (r.selector !== selector) continue;
    for (const d of r.body.split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decl.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
    }
  }
  return [...decl].map(([k, v]) => `${k}: ${v}`).join("; ");
}
function cssRules(text) {
  const clean = text.replace(/\/\*[\s\S]*?\*\//g, "");
  return [...clean.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(m => ({
    selector: m[1].replace(/\s+/g, " ").trim(),
    body: m[2].split(";").map(s => s.replace(/\s+/g, " ").trim()).filter(Boolean).join("; "),
  }));
}
function darkMediaRules(css) {
  const rules = [];
  const open = /@media \(prefers-color-scheme: dark\)\s*\{/g;
  let m;
  while ((m = open.exec(css))) {
    let depth = 1; let i = open.lastIndex;
    while (i < css.length && depth) { if (css[i] === "{") depth += 1; else if (css[i] === "}") depth -= 1; i += 1; }
    const inner = css.slice(open.lastIndex, i - 1);
    if (inner.includes("page-agent")) rules.push(...cssRules(inner));
  }
  return rules;
}

test("T1.1: the agent page is always dark — same palette as style.css, nothing conditional on the device setting", () => {
  assert.match(agentStyle, /:root\s*\{\s*color-scheme:\s*dark;/);
  const styleNoComments = agentStyle.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(styleNoComments, /only light|color-scheme:\s*light|prefers-color-scheme/, "the palette is not conditional on the device setting");
  const css = fs.readFileSync(new URL("../../assets/css/style.css", import.meta.url), "utf8");
  const wanted = darkMediaRules(css);
  assert.ok(wanted.length >= 10, "style.css still defines the agent's dark rules");
  const have = cssRules(agentStyle);
  for (const rule of wanted) {
    assert.ok(have.some(h => h.selector === rule.selector && h.body === rule.body), `agent.html must carry (unconditionally): ${rule.selector}`);
  }
  // زر 💎 مستثنى صراحةً من قواعد الهوية (:not(.valuation-link)) ومالوش قاعدة خاصة بيه هنا
  assert.doesNotMatch(styleNoComments.replace(/:not\(\.valuation-link\)/g, ""), /valuation-link/, "the 💎 button keeps its shared style.css treatment");
  // القاعدة الداكنة الأساسية مالهاش ألوان جديدة: كل لون hex فيها موجود في كتلة style.css الداكنة
  const hexes = text => new Set((text.match(/#[0-9a-f]{3,8}\b/gi) || []).map(h => h.toLowerCase()));
  const darkText = wanted.map(r => r.body).join(" ");
  for (const rule of have.filter(r => /--bg-app|wa-dialog|chat-area \{ background-color|privacy-warn/.test(r.selector + r.body))) {
    for (const hex of hexes(rule.body)) assert.ok(hexes(darkText).has(hex), `new colour ${hex} in ${rule.selector}`);
  }
});

// ───────── T1.1b: هوية سمسار طلبك (أسود + أخضر الشعار) ─────────
const IDENTITY_MARK = "🟢 هوية سمسار طلبك — أسود وأخضر";
function identityLayerOf(css) {
  const at = css.indexOf(IDENTITY_MARK);
  assert.ok(at > 0, "agent.html must carry the logo-matched black/green identity layer");
  return css.slice(at);
}

test("T1.1b: the agent screen shares the logo's black/green identity without WhatsApp imitation", () => {
  const identity = identityLayerOf(agentStyle);
  assert.doesNotMatch(identity, /#25d366|#00a884|#128c7e|#075e54|#005c4b|#53bdeb|#0b141a|#efeae2|#d9fdd3|#202c33|#e9edef|#8696a0|#c9a961|#e6cf95|#0b1220|#101a29/i,
    "the agent chrome must not mix WhatsApp, old navy, or old-gold brand tokens");
  assert.doesNotMatch(identity, /rgba?\(\s*(0,\s*168,\s*132|37,\s*211,\s*102|7,\s*94,\s*84|18,\s*140,\s*126|30,\s*45,\s*61|201,\s*169,\s*97)/i);

  const rules = cssRules(agentStyle);
  const bodyOf = selector => {
    const body = effectiveOf(rules, selector);
    assert.ok(body, `agent.html must style ${selector}`);
    return body;
  };
  const allOf = selector => effectiveOf(rules, selector);
  for (const token of ["--brand-bg", "--brand-panel", "--brand-in", "--brand-out", "--brand-accent", "--brand-text", "--brand-sub"]) {
    assert.match(identity, new RegExp(`${token}:\\s*#[0-9a-f]{6}`, "i"), `${token} must be declared`);
  }
  assert.match(identity, /--brand-bg:\s*#050505/i);
  assert.match(identity, /--brand-accent:\s*#42c541/i);
  assert.match(identity, /--brand-out:\s*#1f7a2e/i);
  assert.match(identity, /--brand-wallpaper:\s*none/i);
  assert.match(bodyOf("body.page-agent .chat-area"), /background-color:\s*var\(--brand-bg\)/);
  assert.match(bodyOf("body.page-agent .chat-area"), /background-image:\s*var\(--brand-wallpaper\)/);
  assert.match(bodyOf("body.page-agent .header"), /background:\s*var\(--brand-panel\)/);
  assert.match(bodyOf("body.page-agent .msg-bot"), /background:\s*var\(--brand-in\)/);
  assert.match(bodyOf("body.page-agent .msg-user"), /background:\s*var\(--brand-out\)/);
  assert.match(bodyOf("body.page-agent .msg-user .msg-ticks::after"), /color:\s*var\(--brand-accent\)/);
  assert.match(allOf("body.page-agent"), /--bg-app:\s*var\(--brand-bg\)/);
  assert.match(allOf("body.page-agent"), /--accent:\s*var\(--brand-accent\)/);
  assert.match(bodyOf("body.page-agent .status-dot"), /background:\s*var\(--brand-accent\)/);
  assert.match(bodyOf("body.page-agent .menu-glass-item:hover"), /rgba\(66,\s*197,\s*65/);
  assert.match(bodyOf("body.page-agent .input-glass:focus-within"), /rgba\(66,\s*197,\s*65/);
  assert.match(bodyOf("body.page-agent .privacy-overlay"), /background:\s*rgba\(9, 13, 17/);
  assert.match(bodyOf("body.page-agent .privacy-badge"), /rgba\(66,\s*197,\s*65/);
  assert.match(bodyOf("body.page-agent .wa-dialog-btn.cancel"), /color:\s*var\(--brand-accent\)/);
  assert.match(bodyOf("body.page-agent .gallery-spinner"), /border-top-color:\s*var\(--brand-accent\)/);
  assert.match(bodyOf("body.page-agent .nm-pk-input"), /background:\s*var\(--brand-panel\)/);
  assert.match(bodyOf("body.page-agent .nm-pk-results"), /background:\s*var\(--brand-panel\)/);
  assert.match(bodyOf("body.page-agent .nm-pk-confirm"), /background:\s*var\(--brand-accent\)/);
  assert.doesNotMatch(identity, /wa-glass-card|\.wa-icon/, "the actual WhatsApp CTA retains its official service colours");
});

test("the conversation is the start screen: one welcome, free typing right away, three optional chips — no service grid, progress bar or uploads", () => {
  const a = bootAgent();
  const first = a.messages();
  assert.equal(first.length, 1, "a single welcome message");
  assert.match(first[0].innerHTML, /أهلًا! بتدور على عقار، عندك عقار للبيع أو الإيجار، ولا عندك سؤال؟ اكتب براحتك\./);
  assert.deepEqual(a.el("actionRail").querySelectorAll(".chip").map(b => b.textContent), ["أبحث عن عقار", "أعرض عقاري", "عندي سؤال"]);
  assert.equal(a.el("msgInput").disabled, false, "free typing is available immediately");
  assert.match(agentHtml, /<div id="app" class="is-session">/);
  for (const gone of [/id="homeView"/, /id="serviceGrid"/, /id="progressTrack"/, /id="fileInput"/, /upload-images/, /SERVICE_LANES/, /formState/]) {
    assert.doesNotMatch(agentHtml, gone, `legacy element removed: ${gone}`);
  }
  assert.equal(a.el("privacyOverlay").classList.contains("show"), false, "no modal before the visitor writes anything");
});

test("agent layout always keeps the header and input dock fixed around the scrollable chat", () => {
  const rules = cssRules(agentStyle);
  // الـcascade بيطبّق كل الإعلانات اللي لنفس المحدد (مش آخر بلوك بس): bottom-dock مثلاً بيكسب flex من البلوك الأول
  // والـpadding من بلوك لاحق — فنقرأ كل الإعلانات للمحدد ونتأكد إنها موجودة
  const bodyOf = selector => {
    const body = effectiveOf(rules, selector);
    assert.ok(body, `agent.html must define ${selector}`);
    return body;
  };
  assert.match(bodyOf("body.page-agent #app"), /display: flex/);
  assert.match(bodyOf("body.page-agent #app"), /flex-direction: column/);
  assert.match(bodyOf("body.page-agent #app > .header"), /flex: 0 0 auto/);
  assert.match(bodyOf("body.page-agent #app > .chat-area"), /flex: 1 1 auto/);
  assert.match(bodyOf("body.page-agent #app > .chat-area"), /min-height: 0/);
  assert.match(bodyOf("body.page-agent #app > .bottom-dock"), /flex: 0 0 auto/);
});

// ───────── T1.2: مصادر الصور ─────────
test("T1.2: image sources are allow-listed (https / blob / data:image) and open with noopener", () => {
  const a = bootAgent();
  a.run(`renderMsg("", "user", ["javascript:alert(1)", "https://x.test/a.png", "data:image/png;base64,AAAA", "blob:https://nasr-realestate.github.io/0b1c",
    "http://insecure.test/a.png", "data:text/html;base64,PHNjcmlwdD4=", "data:image/svg+xml;base64,AAAA", "x\\" onerror=\\"window.__pwn=1", "//evil.test/a.png", "", null])`);
  const html = a.messages().at(-1).innerHTML;
  const sources = [...html.matchAll(/<img src="([^"]*)"/g)].map(m => m[1]);
  assert.deepEqual(sources, ["https://x.test/a.png", "data:image/png;base64,AAAA", "blob:https://nasr-realestate.github.io/0b1c"]);
  assert.doesNotMatch(html, /javascript:|onerror=|insecure\.test|text\/html|svg\+xml|evil\.test/);
  assert.equal((html.match(/window\.open\(this\.src,'_blank','noopener'\)/g) || []).length, 3, "every image opens with noopener");
  assert.doesNotMatch(html, /window\.open\(this\.src\)/);
  // رسالة نص بس + نص مع صور محجوبة: مفيش <div class="msg-imgs"> فاضي بيتحط
  a.run(`renderMsg("صورة", "user", ["javascript:alert(1)"])`);
  assert.doesNotMatch(a.messages().at(-1).innerHTML, /<img/);
});

test("messages are HTML-escaped; links stop at the first quote and open with noopener", () => {
  const a = bootAgent();
  const out = a.run(`formatMsg('<img src=x onerror=alert(1)> *bold* https://a.test/x"onmouseover="alert(1) <script>alert(2)</script>')`);
  assert.ok(!out.includes("<img") && !out.includes("<script"), out);
  assert.match(out, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(out, /<strong>bold<\/strong>/);
  assert.match(out, /<a href="https:\/\/a\.test\/x" target="_blank" rel="noopener">https:\/\/a\.test\/x<\/a>"onmouseover=/, "the link cannot break out of href");
  a.run(`renderMsg('<b>x</b>', 'user')`);
  assert.match(a.messages().at(-1).innerHTML, /&lt;b&gt;x&lt;\/b&gt;/);
});

// ───────── T1.3: سقف history ─────────
test("T1.3: messages are capped at 1000 characters and only the last 10 history entries travel to Gemini — nothing is written to storage", async () => {
  const calls = [];
  const a = bootAgent({ local: CONSENT, fetchImpl: fetchOk(chatReply("تمام"), calls) });
  await send(a, "ك".repeat(5000));
  assert.equal(calls[0].body.message.length, 1000);
  assert.equal(calls[0].url, "https://royal-snow-ea32.footcai-555.workers.dev/chat");
  for (let i = 0; i < 25; i += 1) await send(a, `رسالة ${i}`);
  assert.ok(calls.at(-1).body.history.length <= 10, "only the last 10 messages are sent");
  assert.equal(calls.at(-1).body.message, "رسالة 24");
  assert.ok(calls.at(-1).body.history.every(m => typeof m.text === "string" && m.text.length <= 1000));
  assert.equal(a.sessionStorage._map.size, 0, "the conversation is never written to sessionStorage");
  assert.deepEqual([...a.localStorage._map.keys()], ["simsar_gemini_consent_v1"], "localStorage holds only the consent flag");
});

// ───────── T1.4: الرجوع من التقييم ─────────
test("T1.4: coming back from the valuation tool shows the Worker's numbers with the basis label, then cleans the URL", () => {
  const a = bootAgent({ search: RETURN_QS });
  const banner = a.messages().at(-1).innerHTML;
  assert.match(banner, /💎 رجعت من أداة التقييم/);
  assert.match(banner, /📍 المنطقة السادسة • 180 م²/);
  assert.match(banner, /<strong>9,360,000 ج\.م<\/strong>/);
  assert.match(banner, /📊 النطاق \(P25–P75\): 46,000 – 58,000 ج\.م\/م²/);
  assert.match(banner, /📏 سعر المتر \(الوسيط\): 52,000 ج\.م\/م²/);
  assert.match(banner, /🎯 الثقة: عالية \(41 عينة\)/);
  assert.match(banner, /اكتب طلبك أو سؤالك وهنكمل\./);
  assert.match(banner, /مؤشر استرشادي من أداة الموقع — مش تقييم مهني\./);
  assert.equal(a.location.search, "", "the hand-off parameters are removed from the address bar");
  const v = a.run("state.valuationResult");
  assert.deepEqual({ ...v, savedAt: 0 }, { estimate: 9360000, confidence: "high", samples: 41, perMeter: 52000, p25: 46000, p75: 58000, priceBasis: "median_price_m2", area: "المنطقة السادسة", size: 180, areaType: "sale", savedAt: 0 });
  assert.ok(Math.abs(Date.now() - v.savedAt) < 10_000);

  const rent = bootAgent({ search: "?return=valuation&estimate=62400&perMeter=520&basis=avg_price_m2&area=" + encodeURIComponent("المنطقة الثامنة") + "&size=120&areaType=rent" });
  const rentBanner = rent.messages().at(-1).innerHTML;
  assert.match(rentBanner, /<strong>62,400 ج\.م \/ شهريًا<\/strong>/);
  assert.match(rentBanner, /📏 سعر المتر \(المتوسط\): 520/);
  assert.doesNotMatch(rentBanner, /P25/, "no P25–P75 line without p25/p75");
  assert.match(rentBanner, /🎯 الثقة: غير محددة/);
});

test("T1.4: hostile or broken hand-off parameters are neutralised", () => {
  const banner = search => bootAgent({ search }).messages().at(-1).innerHTML;
  for (const qs of ["?return=valuation&estimate=abc", "?return=valuation&estimate=-5", "?return=valuation&estimate=0", "?return=valuation"]) {
    const a = bootAgent({ search: qs });
    assert.match(a.messages().at(-1).innerHTML, /تمام، رجعت 👋/, qs);
    assert.equal(a.run("state.valuationResult"), null, `${qs} must not create a valuation`);
  }
  const notReturning = bootAgent({ search: "?estimate=9360000&area=x" });
  assert.equal(notReturning.run("state.valuationResult"), null, "parameters without return=valuation are ignored");
  assert.ok(!notReturning.messages().some(m => /رجعت/.test(m.innerHTML)));

  assert.match(banner("?return=valuation&estimate=9360000&confidence=evil"), /🎯 الثقة: غير محددة/);
  const noBasis = banner("?return=valuation&estimate=9360000&perMeter=52000&basis=evil");
  assert.match(noBasis, /📏 سعر المتر: 52,000/);
  assert.doesNotMatch(noBasis, /\(الوسيط\)|\(المتوسط\)/);
  const xss = banner("?return=valuation&estimate=9360000&area=" + encodeURIComponent("<img src=x onerror=alert(1)>"));
  assert.doesNotMatch(xss, /<img/);
  assert.match(xss, /&lt;img src=x onerror=alert\(1\)&gt;/);
  const junk = banner("?return=valuation&estimate=9360000&samples=-3&p25=-1&p75=abc&perMeter=NaN&size=0");
  assert.doesNotMatch(junk, /عينة|P25|📏| م²/);
  const longArea = bootAgent({ search: "?return=valuation&estimate=9360000&area=" + "م".repeat(300) });
  assert.equal(longArea.run("state.valuationResult.area.length"), 100);
});

test("the returned valuation is sent to the Worker exactly once, with the next message", async () => {
  const calls = [];
  const a = bootAgent({ search: RETURN_QS, local: CONSENT, fetchImpl: fetchOk(chatReply("تمام"), calls) });
  await send(a, "رجعت");
  assert.equal(calls[0].body.valuation.estimate, 9360000);
  assert.equal(calls[0].body.valuation.priceBasis, "median_price_m2");
  await send(a, "تاني");
  assert.equal(calls[1].body.valuation, undefined);
});

test("the valuation round trip keeps only the structured summary (no chat text) and consumes it on return", async () => {
  const ownerState = { v: 1, role: "owner", operation: "sell", propertyType: "apartment", location: "المنطقة السادسة", area: { value: 180, mode: "exact" }, price: { value: 9500000, mode: "exact", kind: "total" } };
  const summary = [{ field: "operation", name: "العملية", label: "بيع", removable: false }, { field: "location", name: "المنطقة", label: "المنطقة السادسة", removable: true }];
  const a1 = bootAgent({ local: CONSENT, fetchImpl: fetchOk(chatReply("تمام، الملخص جاهز.", { state: ownerState, summary })) });
  await send(a1, "عندي شقة للبيع في المنطقة السادسة 180 متر وطالب 9.5 مليون — رقمي سري جدا");
  const link = a1.el("valuationSlot").querySelector(".valuation-link");
  assert.ok(link, "the 💎 link appears once the owner's core details are known");
  link.dispatch("click");
  const saved = a1.sessionStorage.getItem("simsar_return_session");
  assert.ok(saved);
  assert.doesNotMatch(saved, /رقمي سري|عندي شقة/, "no chat text is stored for the round trip");
  assert.equal(JSON.parse(saved).chat.price.value, 9500000);

  const a2 = bootAgent({ search: RETURN_QS, session: { simsar_return_session: saved } });
  assert.equal(a2.run("state.chat.role"), "owner");
  assert.equal(a2.run("state.history.length"), 0, "the transcript is not revived");
  assert.equal(a2.el("summaryBar").hidden, false, "the editable summary is back");
  assert.match(a2.el("summaryLine").textContent, /بيع · المنطقة السادسة/);
  assert.equal(a2.sessionStorage.getItem("simsar_return_session"), null, "the saved context is consumed");
  assert.equal(a2.run("state.valuationResult.estimate"), 9360000);
});

test("legacy stored transcripts (simsar_wa_v92) are deleted on load and never revived", () => {
  const stored = JSON.stringify({ formState: { _version: "v92" }, history: [{ role: "user", message: "رسالة قديمة سرية" }] });
  const a = bootAgent({ session: { simsar_wa_v92: stored, simsar_agent_mode: "cloud" } });
  assert.equal(a.sessionStorage.getItem("simsar_wa_v92"), null);
  assert.equal(a.sessionStorage.getItem("simsar_agent_mode"), null);
  assert.ok(a.messages().every(m => !/رسالة قديمة سرية/.test(m.innerHTML)));
  assert.match(a.messages()[0].innerHTML, /أهلًا! بتدور على عقار/);
});

// ───────── T1.5: الهوية ─────────
test("T1.5: the page says it is an assistant powered by Gemini, not Tarek — header status, welcome and the typing reset", () => {
  assert.match(agentHtml, /<span id="statusText">مساعد ذكي بـGemini • جاهز<\/span>/);
  assert.doesNotMatch(agentHtml, /أنا طارق|معاك طارق/, "no remaining line where the bot claims to be the person");
  assert.match(agentHtml, /المساعد الذكي في الصفحة دي مش طارق نفسه/);
  const a = bootAgent();
  assert.doesNotMatch(a.messages()[0].innerHTML, /أنا طارق/);
  assert.match(agentHtml, /<span class="ag-stat-num">17M\+<\/span>/, "Google Maps profile modal shows the updated 17M+ views claim");
  assert.equal(a.run("STATUS_ONLINE"), "مساعد ذكي بـGemini • جاهز");
  a.run("setTyping(true)");
  assert.equal(a.el("statusText").textContent, "Gemini بيكتب…");
  a.run("setTyping(false)");
  assert.equal(a.el("statusText").textContent, "مساعد ذكي بـGemini • جاهز", "after typing the header goes back to the disclosure text");
  assert.equal(a.chatArea.querySelectorAll(".chip").length, 0, "quick replies never live inside the scroll area");
});

// ───────── زر 💎 ─────────
const SELLER_CTA = {
  intent: "seller", area: "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة", size: 180, propertyType: "شقة", areaType: "sale",
  rentCondition: null, price: 9500000, floor: "ثالث", finishing: "سوبر لوكس",
};
test("the 💎 link carries the owner's data to the tool: slugs when known, free text otherwise, nothing unsafe or out of range", () => {
  const a = bootAgent();
  const href = ctx => a.run(`buildValuationHref(${JSON.stringify(ctx)})`);
  assert.deepEqual(params(href(SELLER_CTA)), {
    from: "agent", journey: "seller", area: SELLER_CTA.area, size: "180", type: "apartment", deal: "sale", floor: "3", price: "9500000",
  });
  assert.match(href(SELLER_CTA), /^\/tools\/valuation\.html\?from=agent&journey=seller&/);
  assert.deepEqual(params(href({ ...SELLER_CTA, area: "المنطقة السادسة" })).area, "6th-district", "a known area travels as its slug");
  const rent = params(href({ intent: "seller", area: "المنطقة الثامنة", size: 120, propertyType: "شقة", areaType: "rent", rentCondition: "furnished", price: 9000, floor: "أرضي", finishing: "نصف تشطيب" }));
  assert.deepEqual(rent, { from: "agent", journey: "seller", area: "8th-district", size: "120", type: "apartment", deal: "rent", furnished: "yes", finish: "semi-finished", price: "9000" });
  assert.equal(params(href({ ...SELLER_CTA, areaType: "rent", rentCondition: "unfurnished" })).furnished, "no");
  assert.equal("furnished" in params(href({ ...SELLER_CTA, areaType: "rent", rentCondition: null })), false, "an unknown furnishing is not sent");
  assert.equal("furnished" in params(href({ ...SELLER_CTA, areaType: "sale", rentCondition: "furnished" })), false, "sale never carries furnishing");
  assert.equal(params(href({ ...SELLER_CTA, floor: "ثامن" })).floor, "5plus");
  for (const floor of ["أخير", "بدروم", "", null]) assert.equal("floor" in params(href({ ...SELLER_CTA, floor })), false, `floor ${floor}`);
  for (const size of [5, 200000, "x", null, NaN]) assert.equal("size" in params(href({ ...SELLER_CTA, size })), false, `size ${size}`);
  assert.equal(params(href({ ...SELLER_CTA, size: 20 })).size, "20");
  assert.equal(params(href({ ...SELLER_CTA, size: 100000 })).size, "100000");
  for (const price of [0, -5, 1e13, "x", null]) assert.equal("price" in params(href({ ...SELLER_CTA, price })), false, `price ${price}`);
  assert.equal(params(href({ ...SELLER_CTA, area: "م".repeat(300) })).area.length, 100);
  assert.equal(params(href({ ...SELLER_CTA, intent: "valuation" })).journey, "valuation");
  assert.equal(params(href({ ...SELLER_CTA, propertyType: "قصر" })).type, "قصر", "an unknown type is passed as text, never swapped for apartment");
  assert.equal(params(href({ ...SELLER_CTA, age: "new" })).age, "new");
  for (const age of ["medium", "x", ""]) assert.equal("age" in params(href({ ...SELLER_CTA, age })), false);
  assert.equal("finish" in params(href(SELLER_CTA)), false, "the default finishing is not sent");
  assert.equal("deal" in params(href({ ...SELLER_CTA, areaType: "bogus" })), false);
});

test("the 💎 button is one link, shown only once an owner's core details are known, and removed otherwise", async () => {
  const owner = { v: 1, role: "owner", operation: "sell", propertyType: "apartment", location: "المنطقة السادسة", area: { value: 180, mode: "exact" }, price: { value: 9500000, mode: "exact", kind: "total" }, floor: "ثالث" };
  let reply = chatReply("تمام.", { state: owner, summary: [{ field: "operation", name: "العملية", label: "بيع" }] });
  const a = bootAgent({ local: CONSENT, fetchImpl: async () => ({ ok: true, status: 200, json: async () => reply }) });
  await send(a, "كمّل");
  let links = a.el("valuationSlot").querySelectorAll(".valuation-link");
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, "💎 قيّم عقارك");
  assert.deepEqual(params(links[0].href), { from: "agent", journey: "seller", area: "6th-district", size: "180", type: "apartment", deal: "sale", floor: "3", price: "9500000" });
  await send(a, "تاني");
  assert.equal(a.el("valuationSlot").querySelectorAll(".valuation-link").length, 1, "no duplicates");
  reply = chatReply("تمام.", { state: { v: 1, role: "seeker", operation: "buy" } });
  await send(a, "لا أنا بدور");
  assert.equal(a.el("valuationSlot").querySelectorAll(".valuation-link").length, 0, "seekers get no 💎 link");
  a.run("renderValuationCta('x'); renderValuationCta(null)");
  assert.equal(a.el("valuationSlot").querySelectorAll(".valuation-link").length, 0);
});

test("a failed or unreachable Worker shows a clear message, preserves the draft, and unlocks the input — never a fabricated reply", async () => {
  const bad = bootAgent({ local: CONSENT, fetchImpl: fetchOk({}, [], 500) });
  await send(bad, "مرحبا");
  assert.match(bad.messages().at(-1).innerHTML, /حصل خطأ مؤقت \(HTTP 500\)/);
  assert.equal(bad.el("msgInput").value, "مرحبا");
  assert.equal(bad.run("state.history.length"), 0, "failed sends don't pollute history");
  assert.equal(bad.run("isSending"), false);
  assert.equal(bad.el("sendBtn").disabled, false);
  assert.equal(bad.el("typingBubble").classList.contains("active"), false, "the typing indicator never sticks");

  let offlineAttempts = 0;
  const offline = bootAgent({ local: CONSENT, onLine: false, fetchImpl: async () => { offlineAttempts += 1; throw new TypeError("offline"); } });
  await send(offline, "مرحبا");
  assert.equal(offlineAttempts, 1, "don't retry when the browser reports offline");
  assert.match(offline.messages().at(-1).innerHTML, /الإنترنت عندك مفصول/);
  assert.equal(offline.el("msgInput").value, "مرحبا");

  const limited = bootAgent({ local: CONSENT, fetchImpl: fetchOk({}, [], 429) });
  await send(limited, "مرحبا");
  assert.match(limited.messages().at(-1).innerHTML, /بتبعت رسايل كتير ورا بعض/);
  assert.equal(limited.el("msgInput").value, "مرحبا");

  const down = bootAgent({ local: CONSENT, runTimers: true, fetchImpl: async () => { throw new TypeError("offline"); } });
  await send(down, "مرحبا");
  assert.match(down.messages().at(-1).innerHTML, /تعذّر الاتصال بخادم المساعد/);
  assert.equal(down.run("isSending"), false);
  assert.equal(down.run("isLocalMode()"), false, "no silent switch to the local search");
});

test("a transient Worker network failure is retried once with the same payload", async () => {
  let attempts = 0;
  const bodies = [];
  const recovered = bootAgent({
    local: CONSENT,
    runTimers: true,
    fetchImpl: async (_url, init) => {
      attempts += 1;
      bodies.push(JSON.parse(init.body));
      if (attempts === 1) throw new TypeError("temporary network failure");
      return { ok: true, status: 200, json: async () => chatReply("تمام") };
    },
  });
  await send(recovered, "عايز أشتري");
  assert.equal(attempts, 2);
  assert.deepEqual(bodies[0], bodies[1], "the retry must reuse the original message and conversation state");
  assert.equal(recovered.run("state.history.filter(m => m.role === 'user').length"), 1);
  assert.ok(recovered.messages().some(m => /تمام/.test(m.innerHTML) && m._classes.has("msg-ai")));
  assert.equal(recovered.el("msgInput").value, "");
});

test("a Worker request that hangs is aborted and the typed message remains available", async () => {
  class TestAbortController {
    constructor() {
      this.signal = {
        aborted: false,
        listeners: [],
        addEventListener(type, listener) { if (type === "abort") this.listeners.push(listener); },
      };
    }
    abort() {
      if (this.signal.aborted) return;
      this.signal.aborted = true;
      this.signal.listeners.forEach(listener => listener());
    }
  }
  let attempts = 0;
  const slow = bootAgent({
    local: CONSENT,
    runTimers: true,
    AbortControllerImpl: TestAbortController,
    fetchImpl: (_url, init) => {
      attempts += 1;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("aborted"); error.name = "AbortError"; reject(error);
        });
      });
    },
  });
  await send(slow, "عايز أشتري");
  assert.equal(attempts, 1, "a timed-out request is not automatically duplicated");
  assert.match(slow.messages().at(-1).innerHTML, /الرد اتأخر عن المعتاد/);
  assert.equal(slow.el("msgInput").value, "عايز أشتري");
  assert.equal(slow.run("isSending"), false);
  assert.equal(slow.el("typingBubble").classList.contains("active"), false);
});

// ───────── التمرير الذكي ─────────
test("smart scroll: a reply doesn't yank a reader who scrolled up, but your own message always scrolls down", () => {
  const a = bootAgent();
  const chat = a.chatArea;
  chat.scrollHeight = 2000; chat.clientHeight = 500; chat.scrollTop = 0;
  chat.dispatch("scroll");
  assert.equal(a.scrollBtn._classes.has("show"), true, "the «للأسفل» button appears when reading above");
  a.run(`renderMsg("رد البوت", "bot")`);
  assert.equal(chat.scrollTop, 0, "bot replies leave a reader alone");
  assert.equal(a.scrollBtn._classes.has("show"), true);
  a.run(`renderMsg("رسالتي", "user")`);
  assert.equal(chat.scrollTop, chat.scrollHeight, "the user's own message always scrolls down");
  assert.equal(a.scrollBtn._classes.has("show"), false);
  chat.scrollTop = 1450;
  chat.dispatch("scroll");
  a.run(`renderMsg("رد تاني", "bot")`);
  assert.equal(chat.scrollTop, chat.scrollHeight, "near the bottom (<80px) the chat follows");
});

// ───────── لوحة مفاتيح الموبايل (حالة 15) ─────────
test("on-screen keyboard: the shell tracks the visible area (visualViewport) instead of 100dvh alone, stays out of the way while zoomed, and is restored on close", () => {
  const vv = { height: 800, offsetTop: 0, scale: 1, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const a = bootAgent({ visualViewport: vv });
  const root = a.doc.documentElement;
  assert.ok(vv.listeners.resize && vv.listeners.scroll, "the page listens to visualViewport resize and scroll");
  // الحالة العادية: المساحة الظاهرة = الصفحة → مفيش أي تدخّل (100dvh هي الحاكمة)
  assert.equal(root.classList.contains("vv-active"), false);
  assert.equal("--vv-h" in root.style, false);
  vv.height = 740; vv.listeners.resize();                      // شريط متصفح (60px): أقل من حدّ الكيبورد
  assert.equal(root.classList.contains("vv-active"), false, "browser chrome alone never triggers the override");
  vv.height = 450; vv.listeners.resize();                      // الكيبورد فتح: المساحة الظاهرة 450 من 800
  assert.equal(root.classList.contains("vv-active"), true);
  assert.equal(root.style["--vv-h"], "450px", "the shell shrinks to what is actually visible");
  assert.equal(root.style["--vv-top"], "0px");
  vv.offsetTop = 220; vv.listeners.scroll();                   // المتصفح زحزح النافذة الظاهرة فوق
  assert.equal(root.style["--vv-top"], "220px", "the shell follows the browser's own shift");
  vv.scale = 1.5; vv.listeners.resize();                       // pinch-zoom من المستخدم: ما نتدخلش
  assert.equal(root.classList.contains("vv-active"), false);
  assert.equal("--vv-h" in root.style, false);
  vv.scale = 1; vv.height = 800; vv.offsetTop = 0; vv.listeners.resize(); // الكيبورد اتقفل
  assert.equal(root.classList.contains("vv-active"), false);
  assert.equal("--vv-h" in root.style || "--vv-top" in root.style, false);

  // لما المتصفح نفسه يصغّر الصفحة (كروم أندرويد + interactive-widget=resizes-content)
  // المساحة الظاهرة = الصفحة → الصفحة ما بتتدخلش والشغل كله native
  const native = bootAgent({ visualViewport: vv });
  native.doc.documentElement.clientHeight = 460;
  vv.height = 460; vv.offsetTop = 0; vv.listeners.resize();
  assert.equal(native.doc.documentElement.classList.contains("vv-active"), false, "the native path needs no JS override");

  // الـCSS اللي بيستهلك المتغيرات: الصندوق ثابت (fixed) على المساحة الظاهرة، من غير transform
  assert.match(agentStyle, /body\.page-agent #app\s*\{[^}]*inset-block-start:\s*var\(--vv-top,\s*0px\)/);
  assert.match(agentStyle, /html\.vv-active body\.page-agent #app\s*\{[^}]*height:\s*var\(--vv-h,\s*100vh\)/);
  assert.equal(/html\.vv-keyboard/.test(agentStyle), false, "the old transform-based lock is gone");
assert.match(agentStyle, /height:\s*100vh;\s*height:\s*100dvh;/);
  // حقل الكتابة 16px على الأقل: iOS Safari بيعمل zoom تلقائي على أي حقل أصغر من كده (style.css محدده 15.5px)
  const inputRule = effectiveOf(cssRules(agentStyle), "body.page-agent .input-field");
  assert.ok(inputRule, "agent.html overrides the input rule that style.css loads before it");
  assert.match(inputRule, /font-size: 16px/);
});

// ───────── حراسة التحليلات ─────────
// (الأنماط متقسّمة عمدًا عشان grep حراسة التحليلات على الريبو كله يفضل بنفس نتيجته الأصلية: 10 سطور في 4 ملفات)
test("agent.html and the valuation tool carry no tracking of their own; the layout's GTM id is unchanged", () => {
  const tracking = new RegExp([`GTM-[A-Z0-9]{5,}`, `google${"tag"}manager`, `gtag\\(`, `data${"Layer"}`, `\\bG-[A-Z0-9]{8,}\\b`].join("|"));
  for (const [name, text] of [["agent.html", agentHtml], ["tools/valuation.html", valuationHtml]]) {
    assert.doesNotMatch(text, tracking, name);
  }
  const layout = fs.readFileSync(new URL("../../_layouts/default.html", import.meta.url), "utf8");
  assert.ok(layout.includes(["GTM", "5BTRF7NP"].join("-")), "the container id in _layouts/default.html is untouched");
});
