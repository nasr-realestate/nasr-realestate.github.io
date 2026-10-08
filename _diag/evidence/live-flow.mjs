// Drives the LIVE production Worker over real HTTPS and prints the conversation + the lead.
// Read-only with respect to Cloudflare: it only POSTs chat messages like a real visitor.
// Usage: node live-flow.mjs [workerUrl]
const URL_BASE = process.argv[2] || "https://royal-snow-ea32.footcai-555.workers.dev/";
const SITE = "https://nasr-realestate.github.io";
const RAW = "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة";

const t = (s, n = 78) => String(s || "").replace(/\n/g, " ").slice(0, n);
let diagShown = false;
async function chat(body, { attempts = 3, withIp = false } = {}) {
  let last = null;
  for (let a = 0; a < attempts; a++) {
    const headers = { "Content-Type": "application/json" };
    if (withIp) headers["CF-Connecting-IP"] = `1.2.3.${(a % 200) + 10}`;
    const r = await fetch(URL_BASE, { method: "POST", headers, body: JSON.stringify(body) });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (json) return { status: r.status, json, headers: r.headers };
    last = { status: r.status, text, headers: r.headers };
    if (!diagShown) {
      diagShown = true;
      console.log("!! non-JSON response — diagnostics:");
      console.log(`   status      = ${r.status}`);
      console.log(`   content-type= ${r.headers.get("content-type")}`);
      console.log(`   cf-ray      = ${r.headers.get("cf-ray")}`);
      console.log(`   server      = ${r.headers.get("server")}`);
      console.log(`   body[0:160] = ${JSON.stringify(text.slice(0, 160))}`);
      console.log(`   attempt     = ${a + 1} of ${attempts}`);
      console.log(`   (retrying with backoff)\n`);
    }
    await new Promise(res => setTimeout(res, 1500 * (a + 1)));
  }
  return { status: last?.status ?? 0, json: null, failed: true, headers: last?.headers };
}
console.log("=== LIVE PRODUCTION FLOW — " + URL_BASE + " ===\n");
let r = await chat({ message: "💰 أبيع", formState: {}, history: [] });
console.log(`1) "💰 أبيع"            → ${r.status} | ${t(r.json?.response ?? "(non-JSON: " + r.status + ")")}`);
let fs = r.json.formState;

r = await chat({ message: "شقة", formState: fs, history: [] });
console.log(`2) "شقة"                → ${r.status} | ${t(r.json.response)}`);
fs = r.json.formState;

r = await chat({ message: RAW, formState: fs, history: [] });
console.log(`3) "<raw address>"      → ${r.status} | ${t(r.json.response)}`);
console.log(`   live data.location      = ${JSON.stringify(r.json.formState?.data?.location)}`);
console.log(`   live data._rawLocations = ${JSON.stringify(r.json.formState?.data?._rawLocations ?? null)}   ← created by the new patch only`);
fs = r.json.formState;

const ANSWERS = [
  [/المساحة كام/, "180"],
  [/السعر المطلوب|الإيجار الشهري/, "9500000"],
  [/عدد الغرف/, "3"],
  [/عدد الحمامات/, "2"],
  [/الدور الكام/, "ثالث"],
  [/التشطيب/, "سوبر لوكس"],
  [/هدية مننا|قيّم عقارك|💎/, "تمام"],
  [/اسم حضرتك/, "أحمد"],
  [/رقم الموبايل/, "01512345678"],
  [/صور/, "⏭ تخطي (بدون صور)"],
  [/تفاصيل مهمة/, "لا"],
];
let i = 0, last = r.json;
for (i = 0; i < 14 && !last.done; i++) {
  const q = String(last.response || "");
  const hit = ANSWERS.find(([re]) => re.test(q));
  if (!hit) { console.log(`   !! no scripted answer for: "${t(q, 60)}"`); break; }
  if (r.failed) { console.log("   !! the endpoint stopped answering JSON — aborting"); break; }
  const sent = hit[1];
  const priceBefore = fs?.data?.price;
  r = await chat({ message: sent, formState: fs, history: [] });
  fs = r.json.formState; last = r.json;
  const priceAfter = fs?.data?.price;
  const flag = priceAfter !== priceBefore ? `   ⚠ price CHANGED ${priceBefore} → ${priceAfter}` : "";
  console.log(`4.${i}) sent "${t(sent, 18)}" → ${r.status} | step=${fs?.stepIndex} done=${last.done}${flag}`);
}
console.log(`\nFINAL: done=${last.done} | waMessage=${!!last.waMessage} | canShareWhatsapp=${last.canShareWhatsapp}`);
console.log(`final data.price = ${fs?.data?.price} | data.area = ${fs?.data?.area} | ownerPhone = ${fs?.data?.ownerPhone}`);
const wa = String(last.waMessage || "");
if (wa) {
  console.log("\n--- the lead the client sends on WhatsApp ---");
  for (const line of wa.split("\n")) if (line.trim()) console.log("   " + line);
  const expected = 9500000;
  const priceLine = (wa.match(/السعر المطلوب:.*/) || [""])[0];
  console.log(`\nLEAD PRICE CHECK: expected ${expected.toLocaleString("en-US")} | found in lead: "${priceLine.trim()}"`);
}
