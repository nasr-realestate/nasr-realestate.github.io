// سلوك التمرير في صفحة المحادثة (agent.html) — «زي واتساب: الجديد يزق القديم لفوق»
//   الشكوى: رد الوكيل يختفي خلف الهيدر والكيبورد مفتوح، وما يظهرش إلا بعد قفل الكيبورد.
//   الاختبارات دي بتتحقق من الإصلاح في السكربت الحقيقي (عبر _dom-agent.mjs / node:vm):
//     • تثبيت القاع مع الكيبورد مفتوح (iOS/أندرويد الحديث + أندرويد القديم بالتركيز)
//     • إعادة التثبيت عند تغيّر مقاس الشات أو زيادة المحتوى أو تحميل صورة
//     • القارئ اللي طالع يقرا ما يتخطَفش (ولا من الرد، ولا من إعادة التثبيت، ولا من المحاولات المتأخرة)
//     • التمرير الآلي نفسه ما يقلبش stickToBottom (كان بيمنع نزول الرسالة الجاية)
import assert from "node:assert/strict";
import { test } from "node:test";
import { bootAgent } from "./_dom-agent.mjs";

// مراقِبات وهمية بتسجّل الـobserve وبتسمح لنا نطلق الحدث يدويًا
function fakeObservers() {
  const seen = { resizeTargets: [], mutationTargets: [] };
  let resizeCb = null;
  let mutationCb = null;
  class ResizeObserver {
    constructor(cb) { resizeCb = cb; }
    observe(el) { seen.resizeTargets.push(el); }
  }
  class MutationObserver {
    constructor(cb) { mutationCb = cb; }
    observe(el, opts) { seen.mutationTargets.push({ el, opts }); }
  }
  return {
    ResizeObserver, MutationObserver, seen,
    fireResize: () => resizeCb && resizeCb([{ target: seen.resizeTargets[0] }], {}),
    fireMutation: () => mutationCb && mutationCb([{ type: "childList" }], {}),
  };
}

// شاشة 500px ومحتوى 2000px — القارئ على القاع لما scrollTop = 1500
function setup(opts = {}) {
  const obs = fakeObservers();
  const a = bootAgent({ extraGlobals: { ResizeObserver: obs.ResizeObserver, MutationObserver: obs.MutationObserver }, ...opts });
  const chat = a.chatArea;
  chat.scrollHeight = 2000;
  chat.clientHeight = 500;
  return { a, chat, obs };
}
const atBottom = (chat) => { chat.scrollTop = chat.scrollHeight - chat.clientHeight; };
const scrolledUp = (chat) => { chat.scrollTop = 0; chat.dispatch("scroll"); };

// ── 1) الكيبورد مفتوح (iOS/أندرويد الحديث): الرد الجديد ينزّل المحادثة للقاع ──────────
test("a bot reply pins the chat to the bottom while the on-screen keyboard is open", () => {
  const { a, chat } = setup();
  a.doc.documentElement.classList.add("vv-keyboard");   // الكيبورد مفتوح
  atBottom(chat); chat.dispatch("scroll");
  chat.scrollHeight = 2400;                              // الرد الجديد زاد المحتوى
  a.run(`renderMsg("رد الوكيل", "bot")`);
  assert.equal(chat.scrollTop, chat.scrollHeight, "the new reply pushes the old messages up");
  assert.equal(a.scrollBtn._classes.has("show"), false, "no «للأسفل» button while following the chat");
});

// ── 2) حتى لو reflow قلّب وضع القارئ غلط، الكيبورد المفتوح يفرض النزول ────────────────
test("with the keyboard open the reply still scrolls down even if a reflow flipped the reader state", () => {
  const { a, chat } = setup();
  a.doc.documentElement.classList.add("vv-keyboard");
  scrolledUp(chat);                                      // scroll وهمي من الـreflow
  assert.equal(a.run("stickToBottom"), false, "the stray scroll flipped the flag (the old bug)");
  chat.scrollHeight = 2400;
  a.run(`renderMsg("رد الوكيل", "bot")`);
  assert.equal(chat.scrollTop, chat.scrollHeight, "the reply is visible without closing the keyboard");
});

// ── 3) أندرويد القديم: مفيش فرق viewport يُقاس — التركيز على حقل الكتابة يكفي ─────────
test("on a touch device with the composer focused, the reply pins even without a measurable viewport change", () => {
  const { a, chat } = setup();
  a.win.matchMedia = () => ({ matches: true });          // جهاز لمس
  a.doc.activeElement = a.el("msgInput");                // الكيبورد مفتوح
  scrolledUp(chat);
  chat.scrollHeight = 2400;
  a.run(`renderMsg("رد الوكيل", "bot")`);
  assert.equal(chat.scrollTop, chat.scrollHeight, "pinned like WhatsApp");

  // سطح مكتب (مؤشر دقيق) + قارئ طالع يقرا → ما نخطَفوش
  const desk = setup();
  desk.a.win.matchMedia = () => ({ matches: false });
  desk.a.doc.activeElement = desk.a.el("msgInput");
  scrolledUp(desk.chat);
  desk.chat.scrollHeight = 2400;
  desk.a.run(`renderMsg("رد الوكيل", "bot")`);
  assert.equal(desk.chat.scrollTop, 0, "a desktop reader who scrolled up is left alone");
});

// ── 4) تغيّر مقاس الشات (كيبورد فتح/قفل) → إعادة تثبيت لو القارئ مع القاع ─────────────
test("resizing the chat area re-pins a reader who is following the conversation", () => {
  const { a, chat, obs } = setup();
  assert.deepEqual(obs.seen.resizeTargets, [chat], "the chat area is observed for size changes");
  atBottom(chat); chat.dispatch("scroll");
  chat.clientHeight = 250;                               // الكيبورد فتح: المساحة قلّت
  obs.fireResize();
  assert.equal(chat.scrollTop, chat.scrollHeight, "the last message stays visible above the keyboard");

  // قارئ طالع يقرا: تغيير المقاس ما يزقّوش للقاع
  scrolledUp(chat);
  chat.clientHeight = 500;
  obs.fireResize();
  assert.equal(chat.scrollTop, 0, "a reader above is never yanked by a resize");
});

// ── 5) محتوى جديد (رسالة/أزرار) أو صورة اتحمّلت → إعادة تثبيت ─────────────────────────
test("added content and loaded images re-pin the chat when the reader is at the bottom", () => {
  const { a, chat, obs } = setup();
  assert.equal(obs.seen.mutationTargets.length, 1, "chat content is observed");
  assert.equal(obs.seen.mutationTargets[0].el, chat);
  assert.equal(obs.seen.mutationTargets[0].opts.childList, true);
  assert.equal(obs.seen.mutationTargets[0].opts.subtree, true);

  atBottom(chat); chat.dispatch("scroll");
  chat.scrollHeight = 2600;                              // رسالة/أزرار جديدة ظهرت تحت
  obs.fireMutation();
  assert.equal(chat.scrollTop, chat.scrollHeight, "content growth keeps us on the last message");

  chat.scrollHeight = 3000;                              // صورة جوه رسالة حمّلت وزوّدت الارتفاع
  chat.dispatch("load");
  assert.equal(chat.scrollTop, chat.scrollHeight, "an image loading mid-conversation keeps us pinned");

  scrolledUp(chat);
  chat.scrollHeight = 3600;
  obs.fireMutation();
  chat.dispatch("load");
  assert.equal(chat.scrollTop, 0, "and never while the reader is scrolling up");
});

// ── 6) المحاولات المتأخرة (60/200/400ms) ما تخطَفش قارئ طلع يقرا في النص ───────────────
test("the delayed re-pins respect a reader who scrolled up in between", () => {
  const { a, chat } = setup({ runTimers: false });
  a.doc.documentElement.classList.add("vv-keyboard");
  atBottom(chat); chat.dispatch("scroll");
  a.run(`renderMsg("رد الوكيل", "bot")`);
  assert.equal(chat.scrollTop, chat.scrollHeight);
  scrolledUp(chat);                                      // القارئ طلع يقرا قبل ما المحاولات تنفذ
  chat.scrollHeight = 2800;
  a.timers.filter((t) => t.ms === 60 || t.ms === 200 || t.ms === 400).forEach((t) => t.fn());
  assert.equal(chat.scrollTop, 0, "late retries must not yank the reader back down");
});

// ── 7) التمرير الآلي نفسه ما يقلبش stickToBottom (كان بيمنع نزول الرسالة الجاية) ──────
test("the page's own pinning does not flip the reader state (deferred frames)", () => {
  const frames = [];
  const obs = fakeObservers();
  const a = bootAgent({
    extraGlobals: {
      ResizeObserver: obs.ResizeObserver, MutationObserver: obs.MutationObserver,
      requestAnimationFrame: (cb) => { frames.push(cb); return frames.length; },
    },
  });
  const chat = a.chatArea;
  chat.scrollHeight = 2000; chat.clientHeight = 500;
  atBottom(chat); chat.dispatch("scroll");
  assert.equal(a.run("stickToBottom"), true);

  chat.scrollHeight = 2400;
  a.run(`renderMsg("رد الوكيل", "bot")`);
  const flush = () => { for (let i = 0; i < 6 && frames.length; i += 1) frames.splice(0).forEach((cb) => cb()); };
  flush();                                               // نفّذ الأطر: التثبيت حصل
  assert.equal(chat.scrollTop, chat.scrollHeight, "pinned");
  assert.equal(a.run("_autoScrolling"), false, "the auto-scroll flag is released after the frames settle");

  // scroll ناتج عن reflow أثناء التثبيت: ما يقلبش الوضع
  a.run(`pinToBottomNow()`);
  assert.equal(a.run("_autoScrolling"), true, "flagged as programmatic while pinning");
  chat.scrollTop = 0;
  chat.dispatch("scroll");
  assert.equal(a.run("stickToBottom"), true, "a programmatic scroll never counts as the reader scrolling up");
  flush();
  chat.dispatch("scroll");
  assert.equal(a.run("stickToBottom"), false, "a real user scroll still counts");
  assert.equal(a.scrollBtn._classes.has("show"), true, "and the «للأسفل» button appears");
});

// ── 8) زر «للأسفل» الصريح يرجّع المتابعة ──────────────────────────────────────────────
test("the «للأسفل» button restores following and hides itself", () => {
  const { a, chat } = setup();
  scrolledUp(chat);
  assert.equal(a.scrollBtn._classes.has("show"), true);
  chat.scrollHeight = 2400;
  a.run(`forceScrollToBottom()`);
  assert.equal(chat.scrollTop, chat.scrollHeight);
  assert.equal(a.scrollBtn._classes.has("show"), false);
  assert.equal(a.run("stickToBottom"), true);
});
