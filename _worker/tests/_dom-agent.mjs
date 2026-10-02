// Minimal DOM + sandbox for running agent.html's inline script under node:vm — helper module, not a test file.
//
// من غير jsdom ولا أي dependency: العناصر stubs بتتبّع الأبناء والـclasses والـlisteners، والـinnerHTML نص بس
// (اختبارات XSS بتفحص النص نفسه). requestAnimationFrame متزامن عشان اختبارات التمرير تبقى حتمية.
import fs from "node:fs";
import vm from "node:vm";

export const agentHtml = fs.readFileSync(new URL("../../agent.html", import.meta.url), "utf8");
export const agentStyle = (agentHtml.match(/<style>([\s\S]*?)<\/style>/) || [])[1] || "";
const mainScript = [...agentHtml.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]).find(s => s.includes("const WORKER_URL"));
if (!mainScript) throw new Error("agent.html main inline script not found");

function matches(el, group) {
  const m = group.match(/^([a-z0-9]*)((?:\.[\w-]+)*)$/i);
  if (!m) return false;
  if (m[1] && el.tagName.toLowerCase() !== m[1].toLowerCase()) return false;
  return m[2].split(".").filter(Boolean).every(c => el._classes.has(c));
}

class El {
  constructor(tag, id = "") {
    this.tagName = String(tag).toUpperCase();
    this.id = id;
    this.children = [];
    this.parent = null;
    this._classes = new Set();
    this.style = { setProperty(k, v) { this[k] = String(v); }, removeProperty(k) { delete this[k]; } };
    this.attrs = {};
    this.listeners = {};
    this.dataset = {};
    this.innerHTML = "";
    this.textContent = "";
    this.value = "";
    this.disabled = false;
    this.href = "";
    this.onclick = null;
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    const self = this;
    this.classList = {
      add: (...c) => c.forEach(x => self._classes.add(x)),
      remove: (...c) => c.forEach(x => self._classes.delete(x)),
      toggle: (c, force) => {
        const on = force === undefined ? !self._classes.has(c) : !!force;
        if (on) self._classes.add(c); else self._classes.delete(c);
        return on;
      },
      contains: c => self._classes.has(c),
    };
  }
  get className() { return [...this._classes].join(" "); }
  set className(v) { this._classes = new Set(String(v).split(/\s+/).filter(Boolean)); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === "class") this.className = v; }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  dispatch(type, ev = {}) { (this.listeners[type] || []).forEach(fn => fn(ev)); }
  appendChild(c) { if (c.parent) c.parent.removeChild(c); c.parent = this; this.children.push(c); return c; }
  insertBefore(c, ref) {
    if (c.parent) c.parent.removeChild(c);
    c.parent = this;
    const i = ref ? this.children.indexOf(ref) : -1;
    if (i < 0) this.children.push(c); else this.children.splice(i, 0, c);
    return c;
  }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) this.children.splice(i, 1); c.parent = null; }
  remove() { if (this.parent) this.parent.removeChild(this); }
  querySelectorAll(sel) {
    const groups = String(sel).split(",").map(s => s.trim()).filter(Boolean);
    const out = [];
    const walk = n => { for (const c of n.children) { if (groups.some(g => matches(c, g))) out.push(c); walk(c); } };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  focus() {}
  scrollIntoView() {}
}

function makeStorage(initial = {}) {
  const m = new Map(Object.entries(initial));
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    _map: m,
  };
}

// يشغّل السكربت الرئيسي في agent.html. search = query string للصفحة (مثلًا "?return=valuation&estimate=…")،
// session/local = محتوى sessionStorage/localStorage قبل التحميل (القيم نصوص).
// runTimers: لما الاختبار بيمرّ على ردود Worker حقيقية (فيها typingDelay) الصفحة بتستنى setTimeout — فبننفّذها فورًا بدل الانتظار.
export function bootAgent({ search = "", session = {}, local = {}, fetchImpl, runTimers = false, visualViewport } = {}) {
  const els = new Map();
  const timers = [];
  const errors = [];
  const base = "https://nasr-realestate.github.io";
  const location = { pathname: "/agent.html", search, hash: "", host: "nasr-realestate.github.io", origin: base };
  Object.defineProperty(location, "href", { get() { return `${base}${location.pathname}${location.search}${location.hash}`; } });
  const history = {
    length: 1,
    replaceState(_s, _t, url) {
      const u = new URL(url, base);
      location.pathname = u.pathname; location.search = u.search; location.hash = u.hash;
    },
    back() {},
  };
  const doc = {
    getElementById(id) { if (!els.has(id)) els.set(id, new El("div", id)); return els.get(id); },
    createElement: tag => new El(tag),
    querySelectorAll: () => [],
    querySelector: () => null,
    addEventListener() {},
    body: new El("body"),
    documentElement: new El("html"),
  };
  const win = {
    location, history, addEventListener() {}, removeEventListener() {}, scrollTo() {}, scrollY: 0,
    innerHeight: 800, open() {}, document: doc,
  };
  if (visualViewport) win.visualViewport = visualViewport; // اختياري: محاكاة لوحة مفاتيح الموبايل
  const sessionStorage = makeStorage(session);
  const localStorage = makeStorage(local);
  const ctx = vm.createContext({
    window: win, document: doc, location, history, navigator: {}, sessionStorage, localStorage,
    URL, URLSearchParams, console: { log() {}, warn() {}, error: (...a) => errors.push(a.join(" ")), info() {}, debug() {} },
    fetch: fetchImpl || (async () => ({ ok: true, json: async () => ({}) })),
    requestAnimationFrame: cb => { cb(); return 0; }, // متزامن، وبيرجّع 0 = «مفيش frame معلّق» (الصفحة بتستخدم `if (!raf) raf = requestAnimationFrame(...)`)
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); if (runTimers) setImmediate(fn); return timers.length; },
    clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(mainScript, ctx);
  return {
    ctx, els, doc, win, location, sessionStorage, localStorage, timers, errors,
    run: code => vm.runInContext(code, ctx),
    el: id => doc.getElementById(id),
    get chatArea() { return doc.getElementById("chatArea"); },
    get scrollBtn() { return doc.getElementById("scrollBtn"); },
    // آخر فقاعات الشات (نصوص innerHTML) — لاختبارات الـXSS/البانر
    messages: () => doc.getElementById("chatArea").children.filter(c => c._classes.has("msg")),
  };
}
