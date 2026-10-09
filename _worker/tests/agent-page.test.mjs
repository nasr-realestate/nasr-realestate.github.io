// agent.html — the page's inline script under node:vm with a tiny DOM (see _dom-agent.mjs).
//   T1.1 داكن دايمًا · T1.1b هوية كحلي داكن + ذهبي · T1.2 مصادر الصور + noopener · T1.3 سقف history · T1.4 تسمية الأساس · T1.5 هوية الوكيل
//   + الرجوع من التقييم، زر 💎، الخصوصية (GPS)، والتمرير الذكي.
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
  assert.doesNotMatch(styleNoComments.replace(/:not\(\.valuation-link\)/g, ""), /valuation-link/, "the gold 💎 button keeps its own style.css colours");
  // القاعدة الداكنة الأساسية مالهاش ألوان جديدة: كل لون hex فيها موجود في كتلة style.css الداكنة
  const hexes = text => new Set((text.match(/#[0-9a-f]{3,8}\b/gi) || []).map(h => h.toLowerCase()));
  const darkText = wanted.map(r => r.body).join(" ");
  for (const rule of have.filter(r => /--bg-app|wa-dialog|chat-area \{ background-color|privacy-warn/.test(r.selector + r.body))) {
    for (const hex of hexes(rule.body)) assert.ok(hexes(darkText).has(hex), `new colour ${hex} in ${rule.selector}`);
  }
});

// ───────── T1.1b: هوية طارق طنطاوي (كحلي داكن + ذهبي) ─────────
// كتلة الهوية بتتعرّف بعلامتها في agent.html، وكل اختبارات الألوان بتقصّها من الستايل.
const IDENTITY_MARK = "🟡 هوية طارق طنطاوي";
function identityLayerOf(css) {
  const at = css.indexOf(IDENTITY_MARK);
  assert.ok(at > 0, "agent.html must carry the navy+gold identity layer");
  return css.slice(at);
}

test("T1.1b: the chrome wears the navy+gold identity — no WhatsApp wallpaper, ticks or greens left behind", () => {
  const identity = identityLayerOf(agentStyle);
  // مفيش أي لون من لوحة واتساب جوه كتلة الهوية (لا الأخضر ولا التركواز ولا كحلي الشات بتاعهم)
  assert.doesNotMatch(identity, /#25d366|#00a884|#128c7e|#075e54|#005c4b|#53bdeb|#0b141a|#efeae2|#d9fdd3|#202c33|#e9edef|#8696a0/i,
    "the identity layer must not re-use the WhatsApp palette");
  assert.doesNotMatch(identity, /rgba?\(\s*(0,\s*168,\s*132|37,\s*211,\s*102|7,\s*94,\s*84|18,\s*140,\s*126|30,\s*45,\s*61)/i);

  const rules = cssRules(agentStyle);
  const bodyOf = selector => {
    const body = effectiveOf(rules, selector);
    assert.ok(body, `agent.html must style ${selector}`);
    return body;
  };
  const allOf = selector => effectiveOf(rules, selector);

  // لوحة الهوية معرّفة بألوان حرفية في agent.html
  for (const token of ["--brand-bg", "--brand-panel", "--brand-in", "--brand-out", "--brand-accent", "--brand-text", "--brand-sub"]) {
    assert.match(identity, new RegExp(`${token}:\\s*#[0-9a-f]{6}`, "i"), `${token} must be declared`);
  }
  // خلفية الشات: كحلي + نقشة النقاط الجديدة (مش نقشة واتساب)
  assert.match(identity, /--brand-wallpaper:\s*url\("data:image\/svg\+xml/);
  assert.match(bodyOf("body.page-agent .chat-area"), /background-color:\s*var\(--brand-bg\)/);
  assert.match(bodyOf("body.page-agent .chat-area"), /background-image:\s*var\(--brand-wallpaper\)/);
  // الهيدر والفقاعات
  assert.match(bodyOf("body.page-agent .header"), /background:\s*var\(--brand-panel\)/);
  assert.match(bodyOf("body.page-agent .msg-bot"), /background:\s*var\(--brand-in\)/);
  assert.match(bodyOf("body.page-agent .msg-user"), /background:\s*var\(--brand-out\)/);
  // علامة القراءة: SVG واتساب مخفية و✓ ذهبية مكانها
  assert.match(bodyOf("body.page-agent .msg-user .msg-ticks svg"), /visibility:\s*hidden/);
  assert.match(bodyOf("body.page-agent .msg-user .msg-ticks::after"), /content:\s*"✓"/);
  assert.match(bodyOf("body.page-agent .msg-user .msg-ticks::after"), /color:\s*var\(--brand-accent\)/);
  // بقية الأسطح: التوكنات مربوطة على الهوية والأخضر/التركواز الحرفي اتشال
  assert.match(allOf("body.page-agent"), /--bg-app:\s*var\(--brand-bg\)/);
  assert.match(allOf("body.page-agent"), /--accent:\s*var\(--brand-accent\)/);
  assert.match(allOf("body.page-agent"), /--text-primary:\s*var\(--brand-text\)/);
  assert.match(bodyOf("body.page-agent .status-dot"), /background:\s*var\(--brand-accent\)/);
  assert.match(bodyOf("body.page-agent .menu-glass-item:hover"), /rgba\(201,\s*169,\s*97/);
  assert.match(bodyOf("body.page-agent .input-glass:focus-within"), /rgba\(201,\s*169,\s*97/);
  assert.match(bodyOf("body.page-agent .privacy-overlay"), /background:\s*rgba\(9,\s*13,\s*17/);
  assert.match(bodyOf("body.page-agent .privacy-badge"), /rgba\(201,\s*169,\s*97/);
  assert.match(bodyOf("body.page-agent .wa-dialog-btn.cancel"), /color:\s*var\(--brand-accent\)/);
  assert.match(bodyOf("body.page-agent .gallery-spinner"), /border-top-color:\s*var\(--brand-accent\)/);
  // منتقي الموقع: الحقول والقوايم البيضاء بقت على لوحة الهوية (كان نص فاتح على أبيض)
  assert.match(bodyOf("body.page-agent .nm-pk-input"), /background:\s*var\(--brand-panel\)/);
  assert.match(bodyOf("body.page-agent .nm-pk-results"), /background:\s*var\(--brand-panel\)/);
  assert.match(bodyOf("body.page-agent .nm-pk-confirm"), /background:\s*var\(--brand-accent\)/);
  // ⚠️ كارت واتساب الحقيقي مستثنى عن قصد: لسه بأخضر واتساب الرسمي في style.css
  assert.ok(!identity.includes("wa-glass-card") && !identity.includes(".wa-icon"), "the real WhatsApp card keeps its official colours in style.css");
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
test("T1.3: stored history messages are capped at 1000 characters, so one huge paste can't break every later request", async () => {
  const calls = [];
  const a = bootAgent({ fetchImpl: fetchOk({ response: "تمام", formState: { _version: "v92" } }, calls) });
  await send(a, "ك".repeat(5000));
  const mine = a.run("state.history").filter(m => m.role === "user");
  assert.equal(mine.length, 1);
  assert.equal(mine[0].message.length, 1000);
  assert.ok(calls[0].body.history.every(m => m.message.length <= 1000), "the request carries the capped history");
  assert.ok(JSON.parse(a.sessionStorage.getItem("simsar_wa_v92")).history.every(m => m.message.length <= 1000), "so does the saved session");
  for (let i = 0; i < 25; i += 1) await send(a, `رسالة ${i}`);
  assert.ok(calls.at(-1).body.history.length <= 20, "only the last 20 messages are sent");
  assert.equal(calls.at(-1).body.message, "رسالة 24");
});

// ───────── T1.4: الرجوع من التقييم ─────────
test("T1.4: coming back from the valuation tool shows the Worker's numbers with the basis label, then cleans the URL", () => {
  const a = bootAgent({ search: RETURN_QS });
  const banner = a.messages().at(-1).innerHTML;
  assert.match(banner, /💎 رجعت من التقييم/);
  assert.match(banner, /📍 المنطقة السادسة • 180 م²/);
  assert.match(banner, /<strong>9,360,000 ج\.م<\/strong>/);
  assert.match(banner, /📊 النطاق \(P25–P75\): 46,000 – 58,000 ج\.م\/م²/);
  assert.match(banner, /📏 سعر المتر \(الوسيط\): 52,000 ج\.م\/م²/);
  assert.match(banner, /🎯 الثقة: عالية \(41 عينة\)/);
  assert.match(banner, /نكمّل من النقطة اللي وقفنا عندها؟/);
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
  const a = bootAgent({ search: RETURN_QS, fetchImpl: fetchOk({ response: "تمام", formState: { _version: "v92" } }, calls) });
  await send(a, "رجعت");
  assert.equal(calls[0].body.valuationResult.estimate, 9360000);
  assert.equal(calls[0].body.valuationResult.priceBasis, "median_price_m2");
  await send(a, "تاني");
  assert.equal(calls[1].body.valuationResult, null);
});

test("the chat is restored after the valuation round trip; the GPS pin is never written to storage", () => {
  const a1 = bootAgent();
  a1.run(`state.formState = { _version: "v92", active: true, flowType: "owner", type: "sale", stepIndex: 27,
    data: { location: "شارع س", area: 180, gps: { lat: 30.1, lng: 31.2, address: "secret street" } } };
    state.history.push({ role: "user", message: "💰 أبيع" });
    state.valuationCta = { intent: "seller", area: "المنطقة السادسة", size: 180, propertyType: "شقة", areaType: "sale" };
    renderValuationCta(state.valuationCta); saveState();`);
  assert.ok(!a1.sessionStorage.getItem("simsar_wa_v92").includes("secret street"), "saveState strips the GPS");
  a1.chatArea.querySelector(".valuation-link").dispatch("click");
  const saved = a1.sessionStorage.getItem("simsar_return_session");
  assert.ok(saved && !saved.includes("secret street") && !saved.includes('"gps"'), "saveReturnContext strips the GPS");

  const a2 = bootAgent({ search: RETURN_QS, session: { simsar_return_session: saved } });
  assert.equal(a2.run("state.formState.flowType"), "owner");
  assert.equal(a2.run("state.formState.stepIndex"), 27);
  assert.ok(a2.run("state.history.length") >= 2);
  assert.ok(a2.chatArea.querySelector(".valuation-link"), "the 💎 button is back");
  assert.equal(a2.sessionStorage.getItem("simsar_return_session"), null, "the saved context is consumed");
  assert.equal(a2.run("state.valuationResult.estimate"), 9360000);
  assert.equal(a2.run("state.formState._version"), "v92");
});

test("stored sessions: a stale valuation (24h) and an old form version are dropped", () => {
  const stored = (over, savedAt) => JSON.stringify({ formState: { _version: "v92" }, history: [{ role: "assistant", message: "أهلاً" }], valuationResult: { estimate: 9360000, savedAt }, ...over });
  const stale = bootAgent({ session: { simsar_wa_v92: stored({}, Date.now() - 25 * 3600 * 1000) } });
  assert.equal(stale.run("state.valuationResult"), null);
  const fresh = bootAgent({ session: { simsar_wa_v92: stored({}, Date.now() - 3600 * 1000) } });
  assert.equal(fresh.run("state.valuationResult.estimate"), 9360000);
  const old = bootAgent({ session: { simsar_wa_v92: stored({ formState: { _version: "v80" } }, Date.now()) } });
  assert.equal(old.run("state.valuationResult"), null);
  assert.match(old.messages()[0].innerHTML, /أنا وكيل طارق طنطاوي الذكي/, "an old form version starts a clean conversation");
});

// ───────── T1.5: الهوية ─────────
test("T1.5: the page says it is the agent, not Tarek — greeting, header status and the typing reset", () => {
  assert.match(agentHtml, /<span id="statusText">وكيل ذكي • متصل الآن<\/span>/);
  assert.doesNotMatch(agentHtml, /أنا طارق|معاك طارق/, "no remaining line where the bot claims to be the person");
  const a = bootAgent();
  const greeting = a.messages()[0].innerHTML;
  assert.match(greeting, /أنا وكيل طارق طنطاوي الذكي — سمسار مدينة نصر\./);
  assert.doesNotMatch(greeting, /أنا طارق طنطاوي/);
  assert.match(greeting, /🏆 طارق: Google Local Guide 7 \| 16\.3 مليون مشاهدة/);
  assert.equal(a.run("STATUS_ONLINE"), "وكيل ذكي • متصل الآن");
  a.run("setTyping(true)");
  assert.equal(a.el("statusText").textContent, "يكتب...");
  a.run("setTyping(false)");
  assert.equal(a.el("statusText").textContent, "وكيل ذكي • متصل الآن", "after typing the header goes back to the disclosure text");
  assert.deepEqual(a.chatArea.querySelectorAll(".btn-glass").map(b => b.textContent), ["🔍 أشتري", "🏠 أستأجر", "💰 أبيع", "🔑 أأجر"]);
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

test("the 💎 button is one link, replaced on every reply and removed when the Worker sends no CTA", async () => {
  const calls = [];
  let reply = { response: "قيّم عقارك", formState: { _version: "v92" }, valuationCta: SELLER_CTA, options: ["تخطي السؤال ⏭", "⬅️ رجوع", "إلغاء التسجيل ✕"] };
  const a = bootAgent({ fetchImpl: async (u, i) => fetchOk(reply, calls)(u, i) });
  await send(a, "كمّل");
  let links = a.chatArea.querySelectorAll(".valuation-link");
  assert.equal(links.length, 1);
  assert.equal(links[0].textContent, "💎 قيّم عقارك");
  assert.equal(links[0].href, a.run(`buildValuationHref(${JSON.stringify(SELLER_CTA)})`));
  assert.equal(a.chatArea.querySelectorAll(".valuation-cta-rack").length, 1);
  assert.deepEqual(a.chatArea.querySelectorAll(".btn-glass").filter(b => !b._classes.has("valuation-link")).map(b => b.textContent), ["تخطي السؤال ⏭", "⬅️ رجوع", "إلغاء التسجيل ✕"]);
  assert.equal(a.run("state.valuationCta.intent"), "seller");

  await send(a, "تاني"); // نفس الرد: مفيش تكرار
  assert.equal(a.chatArea.querySelectorAll(".valuation-link").length, 1);

  reply = { response: "اسم حضرتك إيه؟", formState: { _version: "v92" } };
  await send(a, "تخطي السؤال ⏭");
  assert.equal(a.chatArea.querySelectorAll(".valuation-link").length, 0, "the button disappears once the gift step is over");
  assert.equal(a.run("state.valuationCta"), null);
  a.run("renderValuationCta('x'); renderValuationCta(null)");
  assert.equal(a.chatArea.querySelectorAll(".valuation-link").length, 0);
});

test("a failed or unreachable Worker shows a clear message and unlocks the input", async () => {
  const bad = bootAgent({ fetchImpl: fetchOk({}, [], 500) });
  await send(bad, "مرحبا");
  assert.match(bad.messages().at(-1).innerHTML, /حصل خطأ مؤقت\. جرّب تاني\./);
  assert.equal(bad.run("isSending"), false);
  assert.equal(bad.el("sendBtn").disabled, false);
  const down = bootAgent({ fetchImpl: async () => { throw new TypeError("offline"); } });
  await send(down, "مرحبا");
  assert.match(down.messages().at(-1).innerHTML, /تعذّر الاتصال بالخادم/);
  assert.equal(down.run("isSending"), false);
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
test("on-screen keyboard: #app follows the visual viewport only when ≥80px is hidden, stays out of the way while zoomed, and is restored on close", () => {
  const vv = { height: 800, offsetTop: 0, scale: 1, listeners: {}, addEventListener(type, fn) { this.listeners[type] = fn; } };
  const a = bootAgent({ visualViewport: vv });
  const root = a.doc.documentElement;
  assert.ok(vv.listeners.resize && vv.listeners.scroll, "the page listens to visualViewport resize and scroll");
  vv.height = 740; vv.listeners.resize();                      // شريط المتصفح (أقل من 80px) مش كيبورد
  assert.equal(root.classList.contains("vv-keyboard"), false);
  vv.height = 450; vv.listeners.resize();                      // الكيبورد فتح
  assert.equal(root.classList.contains("vv-keyboard"), true);
  assert.equal(root.style["--vv-h"], "450px");
  assert.equal(root.style["--vv-tf"], "none");
  vv.offsetTop = 30; vv.listeners.scroll();                    // المتصفح عمل pan للـvisual viewport
  assert.equal(root.style["--vv-tf"], "translateY(30px)");
  vv.scale = 1.5; vv.listeners.resize();                       // pinch-zoom من المستخدم: ما نتدخلش
  assert.equal(root.classList.contains("vv-keyboard"), false);
  assert.equal("--vv-h" in root.style, false);
  vv.scale = 1; vv.height = 800; vv.offsetTop = 0; vv.listeners.resize(); // الكيبورد اتقفل
  assert.equal(root.classList.contains("vv-keyboard"), false);
  assert.equal("--vv-h" in root.style || "--vv-tf" in root.style, false);

  // الـCSS اللي بيستهلك المتغيرات + قفل الواجهة على ارتفاع الشاشة (الشات هو الوحيد اللي بيتحرك)
  assert.match(agentStyle, /html\.vv-keyboard body\.page-agent #app\s*\{[^}]*height:\s*var\(--vv-h\)[^}]*transform:\s*var\(--vv-tf, none\)/);
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
