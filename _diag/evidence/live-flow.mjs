// Drives the LIVE production Worker over real HTTPS and prints the conversation + the lead.
// Read-only with respect to Cloudflare: it only POSTs chat messages like a real visitor.
// Usage: node live-flow.mjs [workerUrl]
const URL_BASE = process.argv[2] || "https://royal-snow-ea32.footcai-555.workers.dev/";
const SITE = "https://nasr-realestate.github.io";
const RAW = "شارع إبراهيم نوارة بجوار صيدلية العزبي المنطقة السادسة";

const t = (s, n = 78) => String(s || "").replace(/\n/g, " ").slice(0, n);
async function chat(body) {
  const r = await fetch(URL_BASE, {
    method: "POST",
    headers: { Origin: SITE, "Content-Type": "application/json", "CF-Connecting-IP": `live-${Math.random().toString(36).slice(2, 10)}` },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: await r.json() };
}

console.log("=== LIVE PRODUCTION FLOW — " + URL_BASE + " ===\n");
let r = await chat({ message: "💰 أبيع", formState: {}, history: [] });
console.log(`1) "💰 أبيع"            → ${r.status} | ${t(r.json.response)}`);
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
