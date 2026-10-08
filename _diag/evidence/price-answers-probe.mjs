// Probe: what the customer can type at a money question, and what the worker does with it.
// Read-only diagnostic — prints the price/budget the worker stored and whether it asked a
// clarifying question. Used by run-input-logic-evidence.sh; not a test.
import * as H from "../../_worker/tests/_agent-harness.mjs";

H.installFetchMock();
const post = (m, fs) => H.agentPost({ message: m, formState: fs, history: [] });
const line = (s, n = 44) => String(s || "").split("\n")[0].slice(0, n);

async function atOwnerPrice() {
  let r = await post("💰 أبيع", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "شارع عباس العقاد المنطقة السادسة", "180"]) { r = await post(m, fs); fs = r.json.formState; }
  return fs;
}
async function atBuyerBudget() {
  let r = await post("🏠 عايز أشتري", {});
  let fs = r.json.formState;
  for (const m of ["شقة", "المنطقة السادسة", "150"]) { r = await post(m, fs); fs = r.json.formState; }
  return fs;
}

const OWNER = [
  "5 مليون", "5م", "مليونين", "مليون", "5.5 مليون", "5,000,000", "٥ مليون",
  "3 مليون و200", "5 مليون و300 ألف", "9500000", "9,500,000", "٩٥٠٠٠٠٠", "500 ألف", "نص مليون",
  "3 غرف 2 حمام 180 متر 5 مليون", "شقة 180 متر 5 مليون، كلمني 01512345678",
  "3.5 او 4 مليون", "5000000 أو 5500000", "7م و 8م", "1200000 1500000", "من 3 ل 4 مليون",
  "مليونين وخمسين ألف", "01512345678", "1500000000", "+966501234567", "مش عارف",
];
console.log("at «السعر المطلوب كام؟» (owner, sale):");
for (const msg of OWNER) {
  const r = await post(msg, await atOwnerPrice());
  const p = r.json.formState?.data?.price;
  const clarify = /أكتر من رقم|رقم موبايل مش|بالأرقام بالظبط/.test(String(r.json.response || ""));
  console.log(`  ${JSON.stringify(msg).padEnd(44)} → price=${String(p ?? "(not stored)").padEnd(12)} ${clarify ? "clarify: " + line(r.json.response) : ""}`);
}
console.log("at «ميزانيتك كام؟» (buyer, sale):");
for (const msg of ["3 مليون", "3.5 أو 4 مليون", "3000000 أو 3500000", "01512345678"]) {
  const r = await post(msg, await atBuyerBudget());
  const b = r.json.formState?.data?.budget;
  const clarify = /أكتر من رقم|رقم موبايل مش|بالأرقام بالظبط/.test(String(r.json.response || ""));
  console.log(`  ${JSON.stringify(msg).padEnd(44)} → budget=${String(b ?? "(not stored)").padEnd(12)} ${clarify ? "clarify: " + line(r.json.response) : ""}`);
}
H.restoreFetch();
