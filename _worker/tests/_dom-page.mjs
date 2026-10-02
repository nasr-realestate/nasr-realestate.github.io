// Minimal browser stubs for running tools/valuation.html's inline script under node:vm — helper module, not a test file.
//
// من غير jsdom ولا أي dependency. العناصر بتتصنع عند أول getElementById وبتسجّل الـclasses/الأبناء/الخصائص،
// و fetch / localStorage / clipboard / setTimeout قابلة للمراقبة (toasts و timers و opened و clipboard).
import fs from "node:fs";
import vm from "node:vm";

export const valuationHtml = fs.readFileSync(new URL("../../tools/valuation.html", import.meta.url), "utf8");
export const inlineScript = valuationHtml.split("<script>")[1]?.split("</script>")[0];
if (!inlineScript) throw new Error("tools/valuation.html must contain its inline script");

// الـ<select> بتتبني من الـHTML الحقيقي (خياراتها وقيمتها الافتراضية: أول خيار أو اللي عليه selected) — زي المتصفح بالظبط
const SELECTS = new Map();
for (const m of valuationHtml.matchAll(/<select id="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) {
  const options = [...m[2].matchAll(/<option\b([^>]*)>/g)].map(o => ({
    value: (o[1].match(/value="([^"]*)"/) || [])[1] ?? "",
    selected: /\bselected\b/.test(o[1]),
  }));
  SELECTS.set(m[1], { options, value: (options.find(o => o.selected) || options[0] || {}).value ?? "" });
}

function makeStorage() {
  const m = new Map();
  return {
    getItem: k => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { m.set(k, String(v)); },
    removeItem: k => { m.delete(k); },
    clear: () => m.clear(),
    _map: m,
  };
}

function makeElement(id, tag = "div") {
  const classes = new Set();
  return {
    id, tagName: String(tag).toUpperCase(), value: SELECTS.get(id)?.value ?? "", textContent: "", innerHTML: "", className: "", href: "", disabled: false,
    style: {}, attrs: {}, children: [],
    options: (SELECTS.get(id)?.options || []).map(o => ({ value: o.value })),
    classList: {
      add: (...c) => c.forEach(x => classes.add(x)),
      remove: (...c) => c.forEach(x => classes.delete(x)),
      toggle: (c, force) => { const on = force === undefined ? !classes.has(c) : !!force; if (on) classes.add(c); else classes.delete(c); return on; },
      contains: c => classes.has(c),
    },
    querySelectorAll() { return []; },
    querySelector() { return { innerHTML: "", textContent: "" }; },
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    replaceChildren(...c) { this.children = c; },
    addEventListener() {},
    scrollIntoView() {}, select() {}, remove() {},
  };
}

// نص العنصر وأبنائه (لفحص الكروت اللي بتتبني بـcreateElement)
export function textOf(el) {
  return [el.textContent || "", ...(el.children || []).map(textOf)].join(" ").replace(/\s+/g, " ").trim();
}

export function createPageContext({ search = "", fetchImpl } = {}) {
  const elements = new Map();
  const toasts = [];            // العناصر اللي اتضافت لـ<body> (toast)
  const timers = [];            // { fn, ms } لكل setTimeout
  const opened = [];            // window.open(...)
  const clipboard = [];
  const domReady = [];
  const localStorage = makeStorage();
  const sessionStorage = makeStorage();
  const getElementById = id => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };
  const location = { origin: "https://nasr-realestate.github.io", href: "https://nasr-realestate.github.io/tools/valuation.html", search };
  const window = {
    location, history: { replaceState() {} }, scrollTo() {}, prompt() {},
    open: (...args) => { opened.push(args); },
  };
  const document = {
    getElementById,
    createElement: tag => makeElement("", tag),
    addEventListener: (type, fn) => { if (type === "DOMContentLoaded") domReady.push(fn); },
    querySelectorAll() { return []; },
    body: { appendChild: el => { toasts.push(el); } },
  };
  const context = vm.createContext({
    document, window, location, URL, URLSearchParams, console: { log() {}, warn() {}, error() {}, info() {} },
    navigator: { clipboard: { writeText: async text => { clipboard.push(text); } } },
    localStorage, sessionStorage, confirm: () => true,
    fetch: fetchImpl || (async () => new Response(JSON.stringify({ properties: [] }), { status: 200 })),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimeout() {},
    setInterval: () => 1, clearInterval() {},
  });
  vm.runInContext(inlineScript, context);
  return {
    context, elements, getElementById, window, document, toasts, timers, opened, clipboard, localStorage, sessionStorage, domReady,
    el: getElementById,
    run: code => vm.runInContext(code, context),
    boot: () => Promise.all(domReady.map(fn => fn())),
  };
}

// ينتظر شرط يتحقق (الـWorkers الحقيقية بترجّع Promises على أكتر من tick) — بيفشل بوضوح لو ما اتحققش
export async function waitFor(condition, { tries = 300, label = "condition" } = {}) {
  for (let i = 0; i < tries; i += 1) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  throw new Error(`waitFor timed out: ${label}`);
}
