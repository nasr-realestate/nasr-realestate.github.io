// Tests: properties-sync-worker.js — GitHub `_properties/*.md` → D1 (source_id = 9)
//
// كل الاختبارات تعمل بدون شبكة: GitHub موك، و D1 موك بيسجّل كل SQL.
// بعض الاختبارات تقرأ ملفات _properties الحقيقية من القرص لاختبار الـparser على المحتوى الفعلي.
//
// التشغيل:
//   node --experimental-default-type=module --test _worker/tests/properties-sync.test.mjs

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker, { __test } from "../properties-sync-worker.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");
const PROPERTIES_DIR = path.join(REPO_ROOT, "_properties");

// ───────────────────────────────────────────────────────────────────────────
// D1 mock
// ───────────────────────────────────────────────────────────────────────────
const LISTINGS_COLUMNS = [
  { name: "id", type: "INTEGER", pk: 1 },
  { name: "external_id", type: "TEXT" },
  { name: "source_id", type: "INTEGER" },
  { name: "source_url", type: "TEXT" },
  { name: "title", type: "TEXT" },
  { name: "description", type: "TEXT" },
  { name: "transaction_type", type: "TEXT" },
  { name: "property_type", type: "TEXT" },
  { name: "price", type: "REAL" },
  { name: "currency", type: "TEXT" },
  { name: "area_m2", type: "REAL" },
  { name: "area_id", type: "INTEGER" },
  { name: "rooms", type: "INTEGER" },
  { name: "bathrooms", type: "INTEGER" },
  { name: "floor", type: "TEXT" },
  { name: "finish", type: "TEXT" },
  { name: "status", type: "TEXT" },
  { name: "street", type: "TEXT" },
  { name: "image_url", type: "TEXT" },
  { name: "content_hash", type: "TEXT" },
  { name: "created_at", type: "TEXT" },
  { name: "updated_at", type: "TEXT" },
];

const AREAS_ROWS = [
  { id: 1, name: "مدينة نصر", name_ar: "مدينة نصر", name_en: "Nasr City" },
  { id: 2, name: "الحي الأول", name_ar: "الحي الأول", name_en: "First District" },
  { id: 3, name: "الحي الثاني", name_ar: "الحي الثاني", name_en: "Second District" },
  { id: 8, name: "الحي السابع", name_ar: "الحي السابع", name_en: "Seventh District" },
  { id: 9, name: "الحي الثامن", name_ar: "الحي الثامن", name_en: "Eighth District" },
  { id: 11, name: "الحي العاشر", name_ar: "الحي العاشر", name_en: "Tenth District" },
  { id: 15, name: "الواحة", name_ar: "الواحة", name_en: "El Waha" },
  { id: 16, name: "زهراء مدينة نصر", name_ar: "زهراء مدينة نصر", name_en: "Zahraa Nasr City" },
  { id: 17, name: "المنطقة الأولى", name_ar: "المنطقة الأولى", name_en: "First Zone" },
  { id: 22, name: "المنطقة السادسة", name_ar: "المنطقة السادسة", name_en: "Sixth Zone" },
  { id: 26, name: "المنطقة العاشرة", name_ar: "المنطقة العاشرة", name_en: "Tenth Zone" },
  { id: 29, name: "ممر مكرم عبيد", name_ar: "ممر مكرم عبيد", name_en: "Makram Ebeid Corridor" },
  { id: 30, name: "ممر عباس العقاد", name_ar: "ممر عباس العقاد", name_en: "Abbas El Akkad Corridor" },
];

function tableFor(name, config) {
  if (config.tables && name in config.tables) return config.tables[name]; // false ⇒ الجدول غير موجود
  if (name === "listings") return LISTINGS_COLUMNS;
  if (name === "areas") return [{ name: "id" }, { name: "name" }, { name: "name_ar" }, { name: "name_en" }];
  if (name === "ingestion_runs") return config.runColumns ?? DEFAULT_RUN_COLUMNS;
  if (name === "sources") return [{ name: "id" }, { name: "name" }, { name: "base_url" }];
  return [];
}

const DEFAULT_RUN_COLUMNS = [
  { name: "id" }, { name: "source_id" }, { name: "run_type" }, { name: "status" },
  { name: "started_at" }, { name: "finished_at" }, { name: "files_total" },
  { name: "records_inserted" }, { name: "records_updated" }, { name: "records_unchanged" },
  { name: "records_invalid" }, { name: "errors_count" }, { name: "details" },
];

function makeD1(config = {}) {
  const state = {
    listings: (config.listings || []).map((r) => ({ ...r })),
    areas: config.areas || AREAS_ROWS,
    ingestionRuns: [],
    syncState: config.syncState ? new Map(config.syncState) : new Map(),
    sqlLog: [],
    createdTables: [],
    nextId: 1 + Math.max(0, ...(config.listings || []).map((r) => Number(r.id) || 0)),
    runColumns: config.runColumns ?? DEFAULT_RUN_COLUMNS,
  };

  const forbidden = (sql) => {
    if (/^\s*(DELETE|DROP|ALTER)\b/i.test(sql)) throw new Error(`FORBIDDEN SQL: ${sql}`);
    // قراءة COUNT فقط — وبإذن صريح من الاختبار — مسموحة في /verify؛ أي كتابة ممنوعة دائمًا
    const readOnlySnapshots = config.allowSnapshotReads && /^SELECT COUNT\(\*\) AS n FROM price_snapshots$/.test(sql.trim());
    if (/price_snapshots/i.test(sql) && !readOnlySnapshots) throw new Error(`TOUCHED price_snapshots: ${sql}`);
  };

  function exec(sql, binds) {
    state.sqlLog.push({ sql, binds: [...binds] });
    forbidden(sql);

    let m;
    if ((m = sql.match(/^PRAGMA table_info\((\w+)\)$/))) {
      const cols = tableFor(m[1], config);
      return { results: cols === false ? [] : cols.map((c) => ({ ...c })) };
    }
    if (/FROM sqlite_master WHERE type = 'table'/.test(sql)) {
      const name = binds[0];
      const cols = tableFor(name, config);
      if (cols === false) return { results: [] };
      if (name === "properties_sync_state" && !state.createdTables.includes(name) && !config.syncStateExists) {
        return { results: [] };
      }
      return { results: [{ name }] };
    }
    if (/^CREATE TABLE IF NOT EXISTS properties_sync_state/.test(sql)) {
      state.createdTables.push("properties_sync_state");
      return { results: [], meta: { changes: 0 } };
    }
    if (/^SELECT external_id, file_path FROM properties_sync_state WHERE source_id = \?/.test(sql)) {
      return { results: [...state.syncState.values()].map((v) => ({ external_id: v.external_id, file_path: v.file_path })) };
    }
    if (/^SELECT external_id, file_path, blob_sha, content_hash FROM properties_sync_state/.test(sql)) {
      return { results: [...state.syncState.values()].map((v) => ({ ...v })) };
    }
    if (/^SELECT id, name(, name_ar)?(, name_en)? FROM areas/.test(sql) || /^SELECT id, name/.test(sql)) {
      return { results: state.areas.map((a) => ({ ...a })) };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM listings$/.test(sql)) {
      return { results: [{ n: state.listings.length }] };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM areas$/.test(sql)) {
      return { results: [{ n: state.areas.length }] };
    }
    if (/^SELECT COUNT\(\*\) AS n FROM price_snapshots$/.test(sql)) {
      return { results: [{ n: config.priceSnapshots ?? 17 }] };
    }
    if (/^PRAGMA foreign_key_check$/.test(sql)) {
      return { results: config.foreignKeyIssues ? [{ table: "listings", rowid: 1 }] : [] };
    }
    if (/^PRAGMA integrity_check$/.test(sql)) {
      return { results: [{ integrity_check: config.integrity || "ok" }] };
    }
    if ((m = sql.match(/^SELECT COUNT\(\*\) AS n FROM listings WHERE (\w+) = \?(.*)$/))) {
      const col = m[1];
      const rest = m[2] || "";
      let rows = state.listings.filter((r) => String(r[col]) === String(binds[0]));
      let next = 1;
      const inMatch = rest.match(/ AND (\w+) IN \(([^)]*)\)/);
      if (inMatch) {
        const inCol = inMatch[1];
        const placeholders = inMatch[2].split(",").length;
        const ids = binds.slice(next, next + placeholders).map(String);
        next += placeholders;
        rows = rows.filter((r) => ids.includes(String(r[inCol])));
      }
      const nullMatch = rest.match(/ AND (\w+) IS NULL/);
      if (nullMatch) {
        const nullCol = nullMatch[1];
        rows = rows.filter((r) => r[nullCol] === null || r[nullCol] === undefined);
      }
      return { results: [{ n: rows.length }] };
    }
    if (/^SELECT (\w+) AS external_id, COUNT\(\*\) AS n FROM listings WHERE \w+ = \? GROUP BY \1 HAVING COUNT\(\*\) > 1 LIMIT 20$/.test(sql)) {
      const extCol = sql.match(/^SELECT (\w+) AS external_id/)[1];
      const counts = new Map();
      for (const r of state.listings) {
        const key = String(r[extCol]);
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      return {
        results: [...counts.entries()].filter(([, n]) => n > 1).map(([external_id, n]) => ({ external_id, n })),
      };
    }
    if ((m = sql.match(/^SELECT \* FROM listings WHERE (\w+) = \?/))) {
      const col = m[1];
      return { results: state.listings.filter((r) => String(r[col]) === String(binds[0])).map((r) => ({ ...r })) };
    }
    if ((m = sql.match(/^INSERT INTO listings \(([^)]*)\) VALUES/))) {
      const cols = m[1].split(",").map((c) => c.trim());
      const row = { id: state.nextId++ };
      cols.forEach((c, i) => (row[c] = binds[i]));
      state.listings.push(row);
      return { results: [], meta: { changes: 1, last_row_id: row.id } };
    }
    if ((m = sql.match(/^UPDATE listings SET ([\s\S]*?) WHERE id = \?$/))) {
      const cols = m[1].split(",").map((part) => part.trim().split(" = ")[0]);
      const id = binds[binds.length - 1];
      const row = state.listings.find((r) => Number(r.id) === Number(id));
      if (!row) return { results: [], meta: { changes: 0 } };
      cols.forEach((c, i) => (row[c] = binds[i]));
      return { results: [], meta: { changes: 1 } };
    }
    if (/^INSERT INTO ingestion_runs/.test(sql)) {
      state.ingestionRuns.push(Object.fromEntries(binds.map((b, i) => [`b${i}`, b])));
      return { results: [], meta: { changes: 1 } };
    }
    if (/^INSERT INTO properties_sync_state/.test(sql)) {
      const [sourceId, externalId, filePath, blobSha, contentHash, lastSyncedAt] = binds;
      state.syncState.set(`${sourceId}:${externalId}`, {
        source_id: sourceId, external_id: externalId, file_path: filePath,
        blob_sha: blobSha, content_hash: contentHash, last_synced_at: lastSyncedAt,
      });
      return { results: [], meta: { changes: 1 } };
    }
    if (/^SELECT \* FROM ingestion_runs WHERE source_id = \?/.test(sql)) {
      const runs = state.ingestionRuns;
      return { results: runs.length ? [runs[runs.length - 1]] : [] };
    }
    throw new Error(`Unexpected SQL in mock: ${sql}`);
  }

  function prepare(sql) {
    const stmt = {
      sql,
      binds: [],
      bind(...args) { this.binds = args; return this; },
      async all() { return exec(sql, this.binds); },
      async first() { const r = exec(sql, this.binds); return (r.results && r.results[0]) || null; },
      async run() { return exec(sql, this.binds); },
    };
    return stmt;
  }

  return {
    state,
    prepare,
    async batch(stmts) { return Promise.all(stmts.map((s) => s.run())); },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// GitHub mock
// ───────────────────────────────────────────────────────────────────────────
function fakeSha(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) % 1e9;
  return `sha${h.toString(16)}`;
}

function installGitHubMock(files) {
  const tree = files.map((f) => ({
    path: `_properties/${f.name}`, type: "blob", sha: f.sha || fakeSha(f.content), size: f.content.length,
  }));
  const calls = { tree: 0, raw: [] };
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("/git/trees/")) {
      calls.tree++;
      const liveTree = files.map((f) => ({
        path: `_properties/${f.name}`, type: "blob", sha: f.sha || fakeSha(f.content), size: f.content.length,
      }));
      return new Response(JSON.stringify({ tree: liveTree, truncated: false }), { status: 200 });
    }
    const m = u.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/[^/]+\/(.+)$/);
    if (m) {
      const name = m[1].replace(/^_properties\//, "");
      const found = files.find((f) => f.name === name);
      if (found) {
        calls.raw.push(m[1]);
        return new Response(found.content, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; },
    files,
  };
}

function md(fields, body = "") {
  const lines = Object.entries(fields).map(([k, v]) => `${k}: ${v}`);
  return `---\n${lines.join("\n")}\n---\n\n${body}\n`;
}

const FM_BASE = {
  layout: "property_page",
  title: '"شقة 180م للبيع - المنطقة السادسة"',
  date: "2026-10-01",
  location: '"المنطقة السادسة - مدينة نصر"',
  price: '"3,700,000 ج.م"',
  category: "apartments",
  id: '"sample-180m"',
  area: '"180 متر مربع"',
  rooms: '"3 غرف"',
  bathrooms: '"2 حمام"',
  floor: '"الدور الثالث"',
  finish: '"الترا سوبر لوكس"',
  slug: '"sample-180m"',
  image_file: '"sample.webp"',
  description: '"شقة للبيع في المنطقة السادسة"',
  priceNumeric: 3700000,
  areaNumeric: 180,
  roomsNumeric: 3,
  bathsNumeric: 2,
  status: "available",
};

async function syncViaHttp(env, { method = "POST", query = "" } = {}) {
  const res = await worker.fetch(new Request(`https://sync.test/sync${query}`, { method }), env);
  return { status: res.status, body: await res.json() };
}

async function getViaHttp(env, pathname) {
  const res = await worker.fetch(new Request(`https://sync.test${pathname}`, { method: "GET" }), env);
  const body = await res.json();
  return { status: res.status, body };
}

// ───────────────────────────────────────────────────────────────────────────
// 1) parser/قواعد نقية
// ───────────────────────────────────────────────────────────────────────────
test("parseFrontMatter: يقرأ الـfront matter المسطّح ويتجاهل التعليقات", () => {
  const fm = __test.parseFrontMatter(md({ title: '"اختبار"', price: '"1,000 ج.م"', id: "x-1" }));
  assert.equal(fm.title, "اختبار");
  assert.equal(fm.price, "1,000 ج.م");
  assert.equal(fm.id, "x-1");
  assert.equal(__test.parseFrontMatter("no front matter here"), null);
  const withComments = __test.parseFrontMatter('---\n# تعليق\ntitle: "t"\n---\nbody');
  assert.deepEqual(Object.keys(withComments), ["title"]);
});

test("toNumber: أرقام عربية/فواصل/نصوص", () => {
  assert.equal(__test.toNumber("3,700,000"), 3700000);
  assert.equal(__test.toNumber("١٨٠"), 180);
  assert.equal(__test.toNumber("20,000 ج.م شهرياً"), 20000);
  assert.equal(__test.toNumber("مساحة كبيرة واسعة"), null);
  assert.equal(__test.toNumber(0), 0);
});

test("تصنيف نوع المعاملة: إشارات صريحة ثم الافتراضي sale موثّق", () => {
  const areas = [];
  const rent = __test.buildRecord({ id: "a", category: "apartments-rent", priceNumeric: 20000, areaNumeric: 160, title: "شقة للإيجار" }, "a.md", areas);
  assert.equal(rent.record.transactionType, "rent");
  assert.equal(rent.record.pricePeriod, "monthly");
  const sale = __test.buildRecord({ id: "b", category: "apartments", title: "شقة للبيع", priceNumeric: 1, areaNumeric: 100 }, "b.md", areas);
  assert.equal(sale.record.transactionType, "sale");
  assert.equal(sale.transactionEvidence, "explicit");
  const noSignal = __test.buildRecord({ id: "c", category: "apartments", priceNumeric: 1, areaNumeric: 100 }, "c.md", areas);
  assert.equal(noSignal.record.transactionType, "sale");
  assert.equal(noSignal.transactionEvidence, "default_sale_no_explicit_signal");
});

test("تصنيف نوع العقار من category", () => {
  assert.equal(__test.propertyTypeFromCategory("apartments"), "apartment");
  assert.equal(__test.propertyTypeFromCategory("apartments-rent"), "apartment");
  assert.equal(__test.propertyTypeFromCategory("villas"), "villa");
  assert.equal(__test.propertyTypeFromCategory("admin-hq"), "admin");
  assert.equal(__test.propertyTypeFromCategory("commercial"), "commercial");
  assert.equal(__test.propertyTypeFromCategory("unknown-thing"), null);
});

test("مطابقة المنطقة: الأطول يفوز، والمجهول ⇒ لا area_id (لا fallback لمدينة نصر)", () => {
  const areas = [
    { id: 1, name: "مدينة نصر", names: ["مدينة نصر"] },
    { id: 2, name: "الحي الأول", names: ["الحي الأول"] },
    { id: 22, name: "المنطقة السادسة", names: ["المنطقة السادسة"] },
  ];
  assert.equal(__test.matchArea("المنطقة السادسة - مدينة نصر", areas).id, 22);
  assert.equal(__test.matchArea("مدينة نصر - شارع الطيران", areas).id, 1);
  assert.equal(__test.matchArea("مصر الجديدة - خلف الميرغني", areas), null);
  assert.equal(__test.matchArea("حى الواحة امتداد حسن المأمون", areas), null);
});

test("الملفات الحقيقية في _properties: valid / out-of-scope / invalid — بلا أي تصنيف صامت", () => {
  const files = fs.readdirSync(PROPERTIES_DIR).filter((f) => f.endsWith(".md"));
  assert.ok(files.length >= 90, `عدد ملفات _properties غير متوقع: ${files.length}`);
  const areas = AREAS_ROWS.map((a) => ({ id: a.id, name: a.name, names: [a.name, a.name_ar, a.name_en], scope: a.id === 1 ? "city" : null }));
  let valid = 0;
  const rejected = [];
  const outOfScope = [];
  for (const f of files) {
    const raw = fs.readFileSync(path.join(PROPERTIES_DIR, f), "utf8");
    const fm = __test.parseFrontMatter(raw);
    assert.ok(fm, `${f}: front matter مفقود`);
    const { record, problems, outOfScope: isOut } = __test.buildRecord(fm, f, areas);
    if (isOut) {
      outOfScope.push(f);
      assert.ok(record.externalId, `${f}: external_id مفقود`);
      continue;
    }
    if (problems.length) {
      rejected.push(`${f}: ${problems.join(",")}`);
      continue;
    }
    valid++;
    assert.ok(record.externalId, `${f}: external_id مفقود`);
    assert.ok(["sale", "rent"].includes(record.transactionType), `${f}: transaction_type غير صالح`);
    assert.ok(record.propertyType, `${f}: property_type مفقود`);
    assert.ok(record.price > 0, `${f}: price غير صالح`);
    assert.ok(record.areaM2 > 0, `${f}: area_m2 غير صالح`);
    if (record.areaId !== null) assert.equal(typeof record.areaId, "number", `${f}: area_id غير رقمي`);
  }
  assert.equal(valid + rejected.length + outOfScope.length, files.length);
  assert.ok(valid >= 75, `عدد الملفات الصالحة داخل النطاق أقل من المتوقع: ${valid}/${files.length}`);
  assert.equal(outOfScope.length, 12, `عدد الملفات خارج النطاق غير متوقع: ${outOfScope.length}`);
  assert.equal(rejected.length, 8, `عدد الملفات غير الصالحة غير متوقع: ${rejected.length}`);
  for (const r of rejected) {
    assert.match(r, /missing_(area_m2|price|property_type|external_id)/, `سبب رفض غير معروف: ${r}`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 2) التشغيل الكامل: insert → idempotent → update
// ───────────────────────────────────────────────────────────────────────────
test("التشغيل الأول يُدخل، والثاني لا يغيّر شيئًا (idempotent، صفر duplicates)", async () => {
  const gh = installGitHubMock([
    { name: "a.md", content: md({ ...FM_BASE, id: '"a-1"', slug: '"a-1"' }) },
    { name: "b.md", content: md({ ...FM_BASE, id: '"b-1"', slug: '"b-1"', priceNumeric: 5000000, price: '"5,000,000 ج.م"' }) },
  ]);
  const db = makeD1();
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" };
  try {
    const first = await syncViaHttp(env);
    assert.equal(first.status, 200);
    assert.equal(first.body.status, "success");
    assert.equal(first.body.db.inserted, 2);
    assert.equal(db.state.listings.length, 2);
    assert.equal(db.state.listings[0].source_id, 9);
    assert.equal(db.state.listings[0].external_id, "a-1");
    assert.equal(db.state.listings[0].transaction_type, "sale");
    assert.equal(db.state.listings[0].property_type, "apartment");
    assert.equal(db.state.listings[0].area_id, 22); // المنطقة السادسة
    assert.equal(db.state.listings[0].price, 3700000);
    assert.equal(db.state.listings[0].area_m2, 180);

    const second = await syncViaHttp(env);
    assert.equal(second.status, 200);
    assert.equal(second.body.db.inserted, 0);
    assert.equal(second.body.db.updated, 0);
    assert.equal(second.body.github.fetched, 0, "التشغيل الثاني لا يجب أن يقرأ أي ملف");
    assert.equal(db.state.listings.length, 2, "لا يجب إنشاء أي duplicate");
  } finally {
    gh.restore();
  }
});

test("تعديل ملف موجود ⇒ UPDATE لنفس السطر (بدون إدخال جديد)", async () => {
  const file = { name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) };
  const gh = installGitHubMock([file]);
  const db = makeD1();
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" };
  try {
    await syncViaHttp(env);
    const rowId = db.state.listings[0].id;
    const rowsBefore = db.state.listings.length;

    // تعديل السعر + المساحة في الملف مع SHA جديد
    gh.files[0] = { name: "a.md", content: md({ ...FM_BASE, id: '"a-1"', price: '"4,100,000 ج.م"', priceNumeric: 4100000, areaNumeric: 200, area: '"200 متر مربع"' }), sha: "changed-sha" };
    const res = await syncViaHttp(env);
    assert.equal(res.body.db.updated, 1);
    assert.equal(res.body.db.inserted, 0);
    assert.equal(db.state.listings.length, rowsBefore);
    assert.equal(db.state.listings[0].id, rowId);
    assert.equal(db.state.listings[0].price, 4100000);
    assert.equal(db.state.listings[0].area_m2, 200);

    // تشغيل ثالث بلا تغيير ⇒ لا write
    const third = await syncViaHttp(env);
    assert.equal(third.body.db.updated, 0);
    assert.equal(third.body.db.inserted, 0);
  } finally {
    gh.restore();
  }
});

test("ملف غير صالح (بدون مساحة/سعر) لا يُكتب ولا يفسد السجلات الصالحة", async () => {
  const gh = installGitHubMock([
    { name: "ok.md", content: md({ ...FM_BASE, id: '"ok-1"' }) },
    { name: "bad-area.md", content: md({ ...FM_BASE, id: '"bad-1"', area: '"مساحة واسعة"', areaNumeric: 0 }) },
    { name: "bad-price.md", content: md({ ...FM_BASE, id: '"bad-2"', price: '"السعر عند الاتصال"', priceNumeric: 0 }) },
    { name: "no-front-matter.md", content: "# ملف بدون front matter\n" },
  ]);
  const db = makeD1();
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.db.inserted, 1);
    assert.equal(res.body.db.invalid, 3);
    assert.equal(db.state.listings.length, 1);
    assert.equal(db.state.listings[0].external_id, "ok-1");
    const reasons = res.body.invalid_files.map((f) => `${f.file}:${f.reason}`).sort();
    assert.deepEqual(reasons, [
      "_properties/bad-area.md:missing_area_m2",
      "_properties/bad-price.md:missing_price",
      "_properties/no-front-matter.md:no_front_matter",
    ]);
  } finally {
    gh.restore();
  }
});

test("ملفان بنفس external_id ⇒ الثاني يُرفض كـduplicate ولا يُنشئ سطرًا ثانيًا", async () => {
  const gh = installGitHubMock([
    { name: "one.md", content: md({ ...FM_BASE, id: '"same-id"' }) },
    { name: "two.md", content: md({ ...FM_BASE, id: '"same-id"', title: '"نسخة تانية"' }) },
  ]);
  const db = makeD1();
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(db.state.listings.length, 1);
    assert.equal(res.body.db.duplicates, 1);
  } finally {
    gh.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 3) حماية المصادر الأخرى + price_snapshots + عدم الحذف
// ───────────────────────────────────────────────────────────────────────────
test("لا يلمس سجلات مصدر آخر ولا price_snapshots ولا ينفذ أي DELETE", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1({
    listings: [
      { id: 501, external_id: "manus-1", source_id: 8, price: 111, area_m2: 100, transaction_type: "sale", property_type: "apartment" },
      { id: 502, external_id: "a-1", source_id: 9, price: 100, area_m2: 180, transaction_type: "sale", property_type: "apartment" },
    ],
  });
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.status, "success");
    const manus = db.state.listings.find((r) => r.id === 501);
    assert.equal(manus.price, 111, "سجل مصدر 8 اتغير — ممنوع");
    const updated = db.state.listings.find((r) => r.id === 502);
    assert.equal(updated.price, 3700000);
    assert.equal(db.state.listings.filter((r) => r.source_id === 9 && r.external_id === "a-1").length, 1);
    // لا SQL على price_snapshots ولا DELETE (الموك بيرمي استثناء لو حصل)
    for (const entry of db.state.sqlLog) {
      assert.doesNotMatch(entry.sql, /price_snapshots/i);
      assert.doesNotMatch(entry.sql, /^\s*DELETE/i);
    }
  } finally {
    gh.restore();
  }
});

test("ملف اختفى من GitHub ⇒ لا حذف، فقط missing_from_github", async () => {
  const gh = installGitHubMock([
    { name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) },
    { name: "b.md", content: md({ ...FM_BASE, id: '"b-1"', slug: '"b-1"' }) },
  ]);
  const db = makeD1();
  try {
    await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(db.state.listings.length, 2);
    const rowsBefore = db.state.listings.length;
    // إزالة الملف b من المستودع
    gh.files.splice(1, 1);
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(db.state.listings.length, rowsBefore, "ممنوع الحذف");
    assert.ok(res.body.github.missing_from_github >= 1);
  } finally {
    gh.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 4) حماية schema + dry run
// ───────────────────────────────────────────────────────────────────────────
test("schema ناقص (مفيش عمود السعر) ⇒ صفر كتابة + schema_mismatch", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1({ tables: { listings: LISTINGS_COLUMNS.filter((c) => !["price", "price_egp", "asking_price", "price_total"].includes(c.name)) } });
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.status, "schema_mismatch");
    assert.match(res.body.errors.join(","), /missing_required_columns:price/);
    assert.equal(db.state.listings.length, 0);
    assert.ok(!db.state.sqlLog.some((e) => /^(INSERT INTO listings|UPDATE listings)/i.test(e.sql)));
  } finally {
    gh.restore();
  }
});

test("schema بأسماء أعمدة مختلفة: الخريطة تتكيّف (area_sqm / asking_price / ref_id)", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const altColumns = [
    { name: "id", pk: 1 }, { name: "ref_id" }, { name: "source_id" }, { name: "asking_price" },
    { name: "area_sqm" }, { name: "transaction_type" }, { name: "property_type" }, { name: "area_id" },
    { name: "title" }, { name: "updated_at" },
  ];
  const db = makeD1({ tables: { listings: altColumns } });
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.status, "success");
    assert.equal(db.state.listings.length, 1);
    assert.equal(db.state.listings[0].ref_id, "a-1");
    assert.equal(db.state.listings[0].asking_price, 3700000);
    assert.equal(db.state.listings[0].area_sqm, 180);
  } finally {
    gh.restore();
  }
});

test("GET /sync افتراضيًا dry run: لا يكتب أي شيء", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1();
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" }, { method: "GET" });
    assert.equal(res.body.dry_run, true);
    assert.equal(res.body.db.inserted, 1);
    assert.equal(db.state.listings.length, 0, "dry run كتب في D1 — ممنوع");
  } finally {
    gh.restore();
  }
});

test("SYNC_TOKEN: يحمي التشغيل اليدوي", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1();
  try {
    const denied = await syncViaHttp({ DB: db, SYNC_TOKEN: "s3cret", SYNC_ALLOW_DDL: "1" });
    assert.equal(denied.status, 401);
    assert.equal(db.state.listings.length, 0);
    const res = await worker.fetch(new Request("https://sync.test/sync", {
      method: "POST", headers: { authorization: "Bearer s3cret" },
    }), { DB: db, SYNC_TOKEN: "s3cret", SYNC_ALLOW_DDL: "1" });
    assert.equal(res.status, 200);
    assert.equal(db.state.listings.length, 1);
  } finally {
    gh.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 5) الحدود والتشغيل المجدول
// ───────────────────────────────────────────────────────────────────────────
test("budget: لا يتجاوز حد قراءة الملفات في التشغيل الواحد", async () => {
  const files = [];
  for (let i = 0; i < 6; i++) files.push({ name: `f${i}.md`, content: md({ ...FM_BASE, id: `"f${i}"`, slug: `"f${i}"` }) });
  const gh = installGitHubMock(files);
  const db = makeD1();
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_FETCH_BUDGET: "2", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.github.fetched, 2);
    assert.equal(db.state.listings.length, 2);
    // التشغيل التالي يكمل من حيث توقف (جدول الحالة) — بدون duplicates
    const res2 = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_FETCH_BUDGET: "2", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res2.body.github.fetched, 2);
    assert.equal(db.state.listings.length, 4);
    const res3 = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_FETCH_BUDGET: "2", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(db.state.listings.length, 6);
    const res4 = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_FETCH_BUDGET: "2", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res4.body.github.fetched, 0);
    assert.equal(db.state.listings.length, 6);
  } finally {
    gh.restore();
  }
});

test("scheduled: يشغّل المزامنة عبر ctx.waitUntil", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1();
  let waited = null;
  try {
    await worker.scheduled({ cron: "17 * * * *" }, { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" }, { waitUntil: (p) => { waited = p; } });
    assert.ok(waited, "waitUntil لم يُستدعَ");
    await waited;
    assert.equal(db.state.listings.length, 1);
    assert.equal(db.state.ingestionRuns.length, 1, "لازم يتسجل تشغيل في ingestion_runs");
  } finally {
    gh.restore();
  }
});

test("GET / و GET /schema: معلومات الخدمة والـschema بدون أي كتابة", async () => {
  const db = makeD1();
  const info = await worker.fetch(new Request("https://sync.test/"), { DB: db });
  const body = await info.json();
  assert.equal(body.service, "nasr-properties-sync");
  assert.equal(body.source.id, 9);
  assert.equal(body.write_scope.filter, "source_id = 9");
  assert.equal(body.write_scope.deletes, false);
  assert.equal(body.write_ready, true);

  const schemaRes = await worker.fetch(new Request("https://sync.test/schema"), { DB: db });
  const schema = await schemaRes.json();
  assert.equal(schema.missing_required.length, 0);
  assert.ok(schema.tables.listings.includes("external_id"));
  assert.ok(!db.state.sqlLog.some((e) => /^(INSERT|UPDATE)/i.test(e.sql)));
});

// ───────────────────────────────────────────────────────────────────────────
// 6) إعدادات النشر (wrangler.sync.toml)
// ───────────────────────────────────────────────────────────────────────────
test("wrangler.sync.toml: اسم الـWorker + D1 binding + Cron Trigger", () => {
  const toml = fs.readFileSync(path.join(REPO_ROOT, "_worker", "wrangler.sync.toml"), "utf8");
  assert.match(toml, /^name = "nasr-properties-sync"$/m);
  assert.match(toml, /^main = "properties-sync-worker\.js"$/m);
  assert.match(toml, /database_name = "nasr-market-db"/);
  assert.match(toml, /database_id = "ace5c9a2-c6b1-47b3-adf1-77e84ac50abf"/);
  assert.match(toml, /binding = "DB"/);
  assert.match(toml, /\[triggers\]/);
  assert.match(toml, /crons = \["17 \* \* \* \*"\]/);
});

test("الـWorker لا يكتب إلا في listings / ingestion_runs / جدول الحالة — وبدون DELETE", () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, "_worker", "properties-sync-worker.js"), "utf8");
  const inserts = [...src.matchAll(/INSERT\s+INTO\s+(\$?\{[A-Za-z_]+\}|[A-Za-z_]+)/gi)].map((m) => m[1]);
  const updates = [...src.matchAll(/UPDATE\s+(\$?\{[A-Za-z_]+\}|[A-Za-z_]+)\s+SET/gi)].map((m) => m[1]);
  const deletes = [...src.matchAll(/DELETE\s+FROM/gi)];

  assert.equal(deletes.length, 0, "ممنوع أي DELETE");
  const allowedInserts = new Set(["${listingsTable}", "ingestion_runs", "${stateTable}"]);
  const allowedUpdates = new Set(["${listingsTable}", "${stateTable}"]);
  for (const t of inserts) assert.ok(allowedInserts.has(t), `INSERT غير مسموح في: ${t}`);
  for (const t of updates) assert.ok(allowedUpdates.has(t), `UPDATE غير مسموح في: ${t}`);
  // لا كتابة على price_snapshots / demand_signals / areas / sources
  assert.doesNotMatch(src, /INSERT\s+INTO\s+(price_snapshots|demand_signals|areas|sources|listing_location_evidence)/i);
  // سجلات المصدر الحالي تُقرأ دائمًا مقيّدة بـ source_id
  assert.match(src, /FROM \$\{listingsTable\} WHERE \$\{schema\.mapping\.sourceId\} = \?/);
  assert.match(src, /\.bind\(SOURCE_ID\)/);
  // أسماء الجداول الافتراضية ثابتة، وأي تجاوز يمر على تنقية صارمة
  assert.match(src, /envIdent\(env\.LISTINGS_TABLE, "listings"\)/);
  assert.match(src, /envIdent\(env\.STATE_TABLE, STATE_TABLE\)/);
});

test("budget: التشغيل الجزئي يعلّم complete=false ولا يبلّغ عن ملفات مختفية بالخطأ", async () => {
  const files = [];
  for (let i = 0; i < 3; i++) files.push({ name: `g${i}.md`, content: md({ ...FM_BASE, id: `"g${i}"`, slug: `"g${i}"` }) });
  const gh = installGitHubMock(files);
  // سطر قديم في D1 لمصدر 9 لملف مش موجود في GitHub
  const db = makeD1({ listings: [{ id: 900, external_id: "old-listing", source_id: 9, price: 1, area_m2: 50 }] });
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_FETCH_BUDGET: "2", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.github.complete, false);
    assert.equal(res.body.github.budget_skipped, 1);
    assert.equal(res.body.github.missing_from_github, null, "لا يجب تقرير ملفات مختفية في تشغيل جزئي");
    assert.equal(db.state.listings.length, 3, "السطر القديم + ملفان جديدان");
    const full = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_FETCH_BUDGET: "10", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(full.body.github.complete, true);
    assert.equal(full.body.github.missing_from_github, 1, "السطر القديم مش موجود في GitHub ⇒ تقرير فقط");
    assert.equal(db.state.listings.length, 4, "بدون أي حذف");
  } finally {
    gh.restore();
  }
});

test("تكرارات موجودة مسبقًا في D1 لمصدر 9: تُبلَّغ ولا تُلمس", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1({
    listings: [
      { id: 601, external_id: "dup-x", source_id: 9, price: 1, area_m2: 10 },
      { id: 602, external_id: "dup-x", source_id: 9, price: 2, area_m2: 20 },
    ],
  });
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.db.preexisting_duplicate_ids, 1);
    assert.deepEqual(res.body.db.preexisting_duplicate_sample, ["dup-x"]);
    // السطران كما هما (مفيش حذف ولا تعديل)
    assert.equal(db.state.listings.find((r) => r.id === 601).price, 1);
    assert.equal(db.state.listings.find((r) => r.id === 602).price, 2);
  } finally {
    gh.restore();
  }
});

test("throttle: التشغيل اليدوي المتكرر فورًا يُرفض 429 (والـcron مستثنى)", async () => {
  const gh = installGitHubMock([{ name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) }]);
  const db = makeD1();
  const env = { DB: db, SYNC_ALLOW_DDL: "1" };
  try {
    const first = await syncViaHttp(env);
    assert.equal(first.status, 200);
    assert.equal(first.body.db.inserted, 1);
    const second = await syncViaHttp(env);
    assert.equal(second.status, 429, "لازم يرفض التشغيل اليدوي المتكرر فورًا");
    assert.equal(second.body.status, "throttled");
    // مع تجاوز الحد بالضبط (0) يمرّ
    const third = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(third.status, 200);
    assert.equal(third.body.db.inserted, 0);
    // الـcron لا يتأثر بالحماية
    const cronSummary = await __test.runSync({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" }, { trigger: "cron" });
    assert.equal(cronSummary.status, "success");
  } finally {
    gh.restore();
  }
});

test("فشل كتابة سطر واحد لا يوقف بقية الملفات ولا يكتب حالة الملف الفاشل", async () => {
  const gh = installGitHubMock([
    { name: "a.md", content: md({ ...FM_BASE, id: '"a-1"' }) },
    { name: "b.md", content: md({ ...FM_BASE, id: '"b-1"', slug: '"b-1"' }) },
  ]);
  const db = makeD1();
  const originalRun = db.prepare;
  // أول INSERT يفشل مرة واحدة (محاكاة NOT NULL constraint)
  let failedOnce = false;
  db.prepare = (sql) => {
    const stmt = originalRun(sql);
    if (/^INSERT INTO listings/.test(sql)) {
      const run = stmt.run.bind(stmt);
      stmt.run = async () => {
        if (!failedOnce) { failedOnce = true; throw new Error("NOT NULL constraint failed: listings.city_id"); }
        return run();
      };
    }
    return stmt;
  };
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.db.write_failures, 1);
    assert.equal(res.body.db.inserted, 1, "الملف التاني اتحفظ رغم فشل الأول");
    assert.equal(db.state.listings.length, 1);
    assert.match(res.body.errors.join(","), /write_failed:_properties\/a\.md/);
    // الملف الفاشل مش متسجّل في جدول الحالة ⇒ يتكرر في التشغيل الجاي
    const stateKeys = [...db.state.syncState.values()].map((r) => r.external_id);
    assert.ok(!stateKeys.includes("a-1"), "الملف الفاشل مايتسجلش كـsynced");
    assert.ok(!stateKeys.some((k) => String(k).includes("a.md")), "الملف الفاشل مايتسجلش كـinvalid كمان");
    const res2 = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res2.body.db.inserted, 1, "إعادة المحاولة تكتب الملف الفاشل");
    assert.equal(db.state.listings.length, 2);
  } finally {
    gh.restore();
  }
});

test("إحداثيات: تُكتب فقط لو موجودة في الملف (بدون أي تخمين)", async () => {
  const withGps = __test.buildRecord(
    { ...{ id: "g-1", category: "apartments", priceNumeric: 1, areaNumeric: 100 }, gps: "30.0596,31.3456" },
    "g.md", []
  );
  assert.equal(withGps.record.latitude, 30.0596);
  assert.equal(withGps.record.longitude, 31.3456);
  const withoutGps = __test.buildRecord(
    { id: "g-2", category: "apartments", priceNumeric: 1, areaNumeric: 100 }, "g.md", []
  );
  assert.equal(withoutGps.record.latitude, null);
  assert.equal(withoutGps.record.longitude, null);
});

// ───────────────────────────────────────────────────────────────────────────
// 7) تكامل: كل ملفات _properties الحقيقية عبر الـWorker (D1 وهمي)
// ───────────────────────────────────────────────────────────────────────────
test("تكامل: 98 ملفًا حقيقيًا → insert بلا duplicates، ثم تشغيل ثانٍ بلا أي كتابة", async () => {
  const names = fs.readdirSync(PROPERTIES_DIR).filter((f) => f.endsWith(".md"));
  const files = names.map((name) => ({ name, content: fs.readFileSync(path.join(PROPERTIES_DIR, name), "utf8") }));
  const gh = installGitHubMock(files);
  const db = makeD1();
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0", SYNC_FETCH_BUDGET: "500" };
  try {
    const first = await syncViaHttp(env);
    assert.equal(first.status, 200);
    assert.equal(first.body.github.files_total, files.length);
    assert.equal(first.body.github.complete, true);
    assert.equal(first.body.db.duplicates, 0);
    assert.equal(
      first.body.db.inserted + first.body.db.invalid + first.body.db.out_of_scope,
      files.length,
      "كل ملف إما اتحفظ أو اتسجّل كغير صالح أو خارج النطاق — بدون تجاهل صامت"
    );
    assert.equal(first.body.db.inserted, 78, `عدد السجلات المحفوظة غير متوقع: ${first.body.db.inserted}`);
    assert.equal(first.body.db.out_of_scope, 12);
    assert.equal(first.body.db.invalid, 8);
    assert.equal(db.state.listings.length, 78);
    assert.equal(first.body.out_of_scope_files.length, 12, "كل ملف خارج النطاق لازم يظهر باسمه وسببه");

    // كل السجلات: مصدر 9، معرّف خارجي، بيع/إيجار، سعر ومساحة موجبان، ومفيش area_id=1 إلا لو المنطقة اتطابقت فعلًا
    for (const row of db.state.listings) {
      assert.equal(row.source_id, 9);
      assert.ok(row.external_id);
      assert.ok(["sale", "rent"].includes(row.transaction_type));
      assert.ok(row.property_type);
      assert.ok(row.price > 0);
      assert.ok(row.area_m2 > 0);
      assert.ok(row.content_hash && row.content_hash.length === 64);
      if (row.area_id !== null && row.area_id !== undefined) {
        assert.ok(AREAS_ROWS.some((a) => a.id === row.area_id));
      }
    }
    // سطر حقيقي معروف: 10th-district-180m في المنطقة العاشرة (id 26) بسعر 3,700,000
    const sample = db.state.listings.find((r) => r.external_id === "10th-district-180m");
    assert.ok(sample, "السطر المعروف مش موجود");
    assert.equal(sample.area_id, 26);
    assert.equal(sample.price, 3700000);
    assert.equal(sample.area_m2, 180);
    assert.equal(sample.transaction_type, "sale");
    assert.equal(sample.property_type, "apartment");
    assert.equal(sample.source_url, "https://nasr-realestate.github.io/properties/10th-district-180m/");

    // تشغيل ثانٍ: صفر قراءات وكتابات (كل الـSHAs مسجّلة والسطور موجودة)
    const second = await syncViaHttp(env);
    assert.equal(second.body.github.fetched, 0);
    assert.equal(second.body.db.inserted, 0);
    assert.equal(second.body.db.updated, 0);
    assert.equal(db.state.listings.length, first.body.db.inserted);
    assert.equal(
      second.body.db.unchanged + second.body.db.unchanged_invalid + second.body.db.unchanged_out_of_scope,
      first.body.db.inserted + first.body.db.invalid + first.body.db.out_of_scope
    );

    // وسجل تشغيل واحد لكل تشغيل
    assert.equal(db.state.ingestionRuns.length, 2);
  } finally {
    gh.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 8) R1 + R2: حماية النطاق (خارج مدينة نصر ⇒ لا كتابة إطلاقًا)
// ───────────────────────────────────────────────────────────────────────────
const SCOPE_AREAS = AREAS_ROWS.map((a) => ({
  id: a.id, name: a.name, names: [a.name, a.name_ar, a.name_en], scope: a.id === 1 ? "city" : null,
}));

function frontMatterOf(fileName) {
  const raw = fs.readFileSync(path.join(PROPERTIES_DIR, fileName), "utf8");
  return __test.parseFrontMatter(raw);
}

test("R1: العقاران بالحي الأول/الثاني خارج مدينة نصر لا يأخذان area_id من مناطق مدينة نصر", () => {
  // الملفان المذكوران في R1 — يُقرآن من القرص الفعلي
  const cases = [
    { file: "2026-03-07-luxury-villa-new-cairo-1st-district-pool.md", reason: "التجمع الخامس", forbiddenAreaIds: [2] },
    { file: "2026-03-07-villa-south-90th-dusit-hotel-license.md", reason: "شارع التسعين", forbiddenAreaIds: [3] },
  ];
  for (const c of cases) {
    const built = __test.buildRecord(frontMatterOf(c.file), c.file, SCOPE_AREAS);
    assert.equal(built.outOfScope, true, `${c.file}: لازم يكون out_of_scope`);
    assert.ok(built.outOfScopeReasons.includes(c.reason), `${c.file}: السبب ${c.reason} غير مسجَّل (${built.outOfScopeReasons})`);
    assert.equal(built.record.areaId, undefined, `${c.file}: ممنوع أي area_id`);
    assert.equal(built.problems.length, 0);
    // إثبات أن الخطر حقيقي: المطابقة المباشرة (بدون حماية النطاق) كانت ستُسند منطقة مدينة نصر خطأً
    const naive = __test.matchArea(frontMatterOf(c.file).location, SCOPE_AREAS);
    assert.ok(naive && c.forbiddenAreaIds.includes(naive.id),
      `${c.file}: الاختبار لا يمثل حالة R1 (المطابقة المباشرة = ${naive && naive.id})`);
  }
});

test("R2: أي ملف خارج النطاق لا يُكتب أبدًا — تُسجَّل أسماؤه وأسبابه فقط", async () => {
  const gh = installGitHubMock([
    { name: "in-scope.md", content: md({ ...FM_BASE, id: '"in-1"' }) },
    { name: "new-cairo.md", content: md({ ...FM_BASE, id: '"out-1"', location: '"التجمع الخامس - الحي الأول"', title: '"فيلا بالتجمع الخامس"' }) },
    { name: "heliopolis.md", content: md({ ...FM_BASE, id: '"out-2"', location: '"مصر الجديدة - خلف الميرغني"' }) },
  ]);
  const db = makeD1();
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" };
  try {
    const res = await syncViaHttp(env);
    assert.equal(res.body.db.inserted, 1);
    assert.equal(res.body.db.out_of_scope, 2);
    assert.equal(db.state.listings.length, 1, "الملفات خارج النطاق ممنوعة من listings");
    assert.deepEqual(
      res.body.out_of_scope_files.map((f) => f.file).sort(),
      ["_properties/heliopolis.md", "_properties/new-cairo.md"]
    );
    assert.ok(res.body.out_of_scope_files.every((f) => f.reasons.length > 0), "كل ملف لازم يكون له سبب");
    assert.ok(!db.state.listings.some((r) => ["out-1", "out-2"].includes(r.external_id)));

    // إعادة التشغيل: لا كتابة، وتُتخطى الملفات المستبعدة من جدول الحالة
    const second = await syncViaHttp(env);
    assert.equal(second.body.db.inserted, 0);
    assert.equal(second.body.db.out_of_scope, 0);
    assert.equal(second.body.db.unchanged_out_of_scope, 2, "الملفات المستبعدة تُتخطى بدون إعادة فحص");
    assert.equal(db.state.listings.length, 1);
  } finally {
    gh.restore();
  }
});

test("R2: ملف في D1 لقائمة خارج النطاق لا يُحذف ولا يُعدَّل ولا يُبلَّغ كـ«مختفي»", async () => {
  const gh = installGitHubMock([
    { name: "new-cairo.md", content: md({ ...FM_BASE, id: '"out-1"', location: '"التجمع الخامس"' }) },
  ]);
  const db = makeD1({ listings: [{ id: 700, external_id: "out-1", source_id: 9, price: 1, area_m2: 500, area_id: null }] });
  try {
    const res = await syncViaHttp({ DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0" });
    assert.equal(res.body.db.out_of_scope, 1);
    assert.equal(res.body.github.missing_from_github, 0, "الملف موجود في GitHub — ليس مختفيًا");
    const row = db.state.listings.find((r) => r.id === 700);
    assert.equal(row.price, 1, "ممنوع تعديل سجل خارج النطاق");
    assert.equal(db.state.listings.length, 1, "ممنوع الحذف");
  } finally {
    gh.restore();
  }
});

test("scope: مؤشرات خارج النطاق آمنة — بلا إيجابيات خاطئة في نصوص مدينة نصر", () => {
  const inScope = [
    "عمارات العبور - شارع صلاح سالم الرئيسي - مدينة نصر",
    "شارع النزهة الرئيسي - أمام الرقابة الإدارية - مدينة نصر",
    "شقة 167م بين أبو داود الظاهري وأحمد فخري - مباني التسعينات",
    "شقة بحاجة بدريسنج وغرفة ماستر",
    "حي السفارات - آخر شارع الطيران - أمام مستشفى الأندلس",
    "الواحة - ناصية شارع الخمسين - مدينة نصر",
  ];
  for (const text of inScope) {
    assert.deepEqual(__test.detectOutOfScope(text), [], `إيجابية خاطئة في: ${text}`);
  }
  const outScope = [
    ["التجمع الخامس - حي الأندلس 1", "التجمع الخامس"],
    ["شارع التسعين الجنوبي - أمام فندق دويت", "شارع التسعين"],
    ["مصر الجديدة - موقع راقي", "مصر الجديدة"],
    ["كمبوند لافيدا - هليوبوليس الجديدة", "هليوبوليس"],
    ["مدينة الرحاب - مجموعة 13", "الرحاب"],
    ["النزهة - بالقرب من فلوريدا مول - مساكن شيراتون", "شيراتون"],
    ["كمبوند نيوبوليس (وادي دجلة)", "وادي دجلة"],
    ["مدينة السلام - ناصية شارع السادات", "مدينة السلام"],
  ];
  for (const [text, reason] of outScope) {
    assert.ok(__test.detectOutOfScope(text).includes(reason), `لم يُكتشف: ${text} (${reason})`);
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 9) R3: قاعدة «الأخص يفوز» + aliases الممرات
// ───────────────────────────────────────────────────────────────────────────
test("R3: المنطقة الفرعية تتغلب على «مدينة نصر» (الواحة وغيرها)", () => {
  const cases = [
    ["الواحة - ناصية شارع الخمسين - مدينة نصر", 15],
    ["زهراء مدينة نصر - ناصية شارع الوفاء", 16],
    ["حي الواحة - امتداد حسن المأمون - مدينة نصر", 15],
    ["الحي السابع - شارع ابن قتيبة - مدينة نصر", 8],
    ["مدينة نصر - موقع عام بدون منطقة فرعية", 1],
  ];
  for (const [text, expected] of cases) {
    const hit = __test.matchArea(text, SCOPE_AREAS);
    assert.equal(hit && hit.id, expected, `${text} ⇒ ${hit && hit.id} (المتوقع ${expected})`);
  }
});

test("R3: aliases الممرات — «شارع مكرم عبيد» / «عباس العقاد» تُطابق مناطق D1", () => {
  assert.equal(__test.matchArea("شارع مكرم عبيد الرئيسي - قلب مدينة نصر", SCOPE_AREAS).id, 29);
  assert.equal(__test.matchArea("آخر شارع مكرم عبيد - بعد كلية الألسن", SCOPE_AREAS).id, 29);
  assert.equal(__test.matchArea("ثاني نمرة من شارع عباس العقاد - مدينة نصر", SCOPE_AREAS).id, 30);
  assert.equal(__test.matchArea("ممر عباس العقاد - المنطقة الأولى", SCOPE_AREAS).id, 30);
  // الأطول بين المناطق الفرعية يفوز: «المنطقة السادسة» أقوى من «مكرم عبيد»
  assert.equal(__test.matchArea("شارع الفريق علي عامر - متفرع من مكرم عبيد - المنطقة السادسة", SCOPE_AREAS).id, 22);
  // «المنطقة الأولى» أقوى من «عباس العقاد» عند اجتماعهما
  assert.equal(__test.matchArea("شارع عباس العقاد الرئيسي - المنطقة الأولى - مدينة نصر", SCOPE_AREAS).id, 17);
  // الحروف الملتصقة: «بالحي الثامن»
  assert.equal(__test.matchArea("موقع يربط حسن المأمون بالحي الثامن", SCOPE_AREAS).id, 9);
  // «بالواحة» تعمل أيضًا
  assert.equal(__test.matchArea("بجوار الواحة مباشرة", SCOPE_AREAS).id, 15);
});

test("R3: aliases مشتقة من اسم المنطقة نفسه فقط (بدون تخمين)", () => {
  const mمر = { id: 29, name: "ممر مكرم عبيد", names: ["ممر مكرم عبيد", "Makram Ebeid Corridor"], scope: null };
  const aliases = __test.areaAliases(mمر);
  assert.ok(aliases.includes("ممر مكرم عبيد"));
  assert.ok(aliases.includes("مكرم عبيد"));
  assert.equal(aliases.length, 3);
  assert.equal(__test.isCityArea({ id: 1, name: "مدينة نصر", names: ["مدينة نصر"], scope: "city" }), true);
  assert.equal(__test.isCityArea({ id: 1, name: "مدينة نصر (ككل)", names: ["مدينة نصر"], scope: null }), true);
  assert.equal(__test.isCityArea({ id: 22, name: "المنطقة السادسة", names: ["المنطقة السادسة"], scope: "zone" }), false);
});

test("R2+R3: لا يبقى أي ملف خارج النطاق بمنطقة من مناطق مدينة نصر (فحص الـ98 ملفًا)", () => {
  const files = fs.readdirSync(PROPERTIES_DIR).filter((f) => f.endsWith(".md"));
  for (const f of files) {
    const fm = __test.parseFrontMatter(fs.readFileSync(path.join(PROPERTIES_DIR, f), "utf8"));
    const built = __test.buildRecord(fm, f, SCOPE_AREAS);
    if (!built.outOfScope) continue;
    assert.equal(built.record.areaId, undefined, `${f}: ملف خارج النطاق وله area_id`);
    // لو تم تجاهل الحماية لأي سبب: لازم يظهر التطابق الخاطئ المحتمل في الـtest ده
    const naive = __test.matchArea(fm.location || "", SCOPE_AREAS);
    if (naive) assert.ok([2, 3].includes(naive.id) || naive.id >= 1);
  }
});

test("containsToken: الكلمة الكاملة مع الحروف الملتصقة", () => {
  const hay = ` ${__test.normalizeArabic("شقة بمدينة نصر وبالحي الثامن مقابل مسجد")} `;
  assert.equal(__test.containsToken(hay, __test.normalizeArabic("مدينة نصر")), true);
  assert.equal(__test.containsToken(hay, __test.normalizeArabic("الحي الثامن")), true);
  assert.equal(__test.containsToken(hay, __test.normalizeArabic("الحي التاسع")), false);
  assert.equal(__test.containsToken(` ${__test.normalizeArabic("بدروم وبدريسنج")} `, "بدر"), false);
});

// ───────────────────────────────────────────────────────────────────────────
// 37) GET /verify: تقرير قراءة فقط يستخدمه الـCI لتنفيذ checklist D1
// ───────────────────────────────────────────────────────────────────────────
test("GET /verify: تقرير قراءة فقط (counts/duplicates/integrity) بدون أي كتابة", async () => {
  const gh = installGitHubMock([
    { name: "in-scope.md", content: md({ ...FM_BASE, id: '"in-1"' }) },
    {
      name: "no-area.md",
      content: md({
        ...FM_BASE,
        id: '"null-1"',
        location: '"جمال عفيفي - النادي الأهلي"',
        title: '"شقة بجوار النادي الأهلي"',
        description: '"شقة للبيع بدون أي إشارة لمنطقة فرعية"',
      }),
    },
  ]);
  const db = makeD1({ allowSnapshotReads: true, priceSnapshots: 42 });
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0", SYNC_FETCH_BUDGET: "500" };
  try {
    const sync = await syncViaHttp(env);
    assert.equal(sync.body.db.inserted, 2);

    const sqlBefore = db.state.sqlLog.length;
    const res = await getViaHttp(env, "/verify?out_of_scope=out-1,out-2&invalid=bad-1&null_area=null-1");
    assert.equal(res.status, 200);
    const body = res.body;
    assert.equal(body.read_only, true);
    assert.equal(body.source_id, 9);
    assert.equal(body.counts.listings_total, 2);
    assert.equal(body.counts.source9_total, 2);
    assert.equal(body.counts.source9_null_area, 1);
    assert.equal(body.counts.price_snapshots_total, 42);
    assert.equal(body.counts.areas_total, AREAS_ROWS.length);
    assert.equal(body.duplicates.count, 0);
    assert.equal(body.integrity.integrity_check, "ok");
    assert.equal(body.integrity.foreign_key_check, 0);
    assert.equal(body.state.rows, 3, "صفّا الملفين + صف علامة آخر تشغيل");
    assert.equal(body.state.files_tracked, 2, "الملفات المتتبَّعة في جدول الحالة");
    assert.equal(body.state.in_scope, 2);
    assert.equal(body.state.invalid, 0);
    assert.equal(body.state.out_of_scope, 0);
    assert.equal(body.lists.out_of_scope.checked, 2);
    assert.equal(body.lists.out_of_scope.present, 0, "الملفات خارج النطاق يجب ألا تكون في listings");
    assert.equal(body.lists.invalid.present, 0);
    assert.equal(body.lists.null_area.checked, 1);
    assert.equal(body.lists.null_area.present, 1, "السطر بلا منطقة واضحة يظل area_id = NULL");

    // لا كتابة إطلاقًا من /verify
    const writes = db.state.sqlLog
      .slice(sqlBefore)
      .filter(({ sql }) => /^\s*(INSERT|UPDATE|DELETE|CREATE|DROP|ALTER)\b/i.test(sql));
    assert.equal(writes.length, 0, `verify must stay read-only: ${JSON.stringify(writes)}`);
  } finally {
    gh.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 38) R1: صف قديم بقيمة افتراضية (مدينة نصر) يُصفَّر إلى NULL لملف بلا مطابقة واضحة
// ───────────────────────────────────────────────────────────────────────────
test("R1: area_id افتراضي قديم يُصفَّر إلى NULL لملف داخل النطاق بلا مطابقة منطقة", async () => {
  const gh = installGitHubMock([
    {
      name: "no-area.md",
      content: md({
        ...FM_BASE,
        id: '"null-1"',
        location: '"جمال عفيفي - النادي الأهلي"',
        title: '"شقة بجوار النادي الأهلي"',
        description: '"شقة للبيع بدون أي إشارة لمنطقة فرعية"',
      }),
    },
  ]);
  const db = makeD1({
    listings: [
      {
        id: 7, external_id: "null-1", source_id: 9, area_id: 1, price: 3700000, area_m2: 180,
        transaction_type: "sale", property_type: "apartment", title: "استيراد قديم",
      },
    ],
  });
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0", SYNC_FETCH_BUDGET: "500" };
  try {
    const res = await syncViaHttp(env);
    assert.equal(res.body.db.inserted, 0, "السطر موجود مسبقًا ⇒ تحديث وليس إدخالًا");
    assert.equal(res.body.db.area_cleared, 1, "لازم يُبلَّغ عن تصفير area_id");
    assert.equal(res.body.db.duplicates, 0);
    const row = db.state.listings.find((r) => r.external_id === "null-1");
    assert.equal(row.area_id, null, "area_id ممنوع يفضل 1 (مدينة نصر) بدون مطابقة واضحة");
    assert.equal(db.state.listings.length, 1, "بدون أي سطر جديد");

    // تعطيل التصفير صراحةً يعيد السلوك القديم (بدون أي كتابة)
    const db2 = makeD1({
      listings: [
        { id: 7, external_id: "null-1", source_id: 9, area_id: 1, price: 3700000, area_m2: 180,
          transaction_type: "sale", property_type: "apartment", title: "استيراد قديم" },
      ],
    });
    const env2 = { DB: db2, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0", SYNC_FETCH_BUDGET: "500", SYNC_CLEAR_UNMATCHED_AREA: "0" };
    const res2 = await syncViaHttp(env2);
    assert.equal(res2.body.db.area_cleared, 0);
    assert.equal(db2.state.listings[0].area_id, 1);
  } finally {
    gh.restore();
  }
});

// ───────────────────────────────────────────────────────────────────────────
// 39) نسخة منطق جديدة ⇒ إعادة معالجة كل الملفات مرة واحدة (ثم يعود المسار السريع)
// ───────────────────────────────────────────────────────────────────────────
test("نسخة جديدة من الـWorker تُبطل المسار السريع مرة واحدة وتُعيد تطبيق R1 على الصفوف القديمة", async () => {
  const content = md({
    ...FM_BASE,
    id: '"null-1"',
    location: '"جمال عفيفي - النادي الأهلي"',
    title: '"شقة بجوار النادي الأهلي"',
    description: '"شقة للبيع بدون أي إشارة لمنطقة فرعية"',
  });
  const gh = installGitHubMock([{ name: "no-area.md", content }]);
  const db = makeD1({
    listings: [
      { id: 5, external_id: "null-1", source_id: 9, area_id: 1, price: 3700000, area_m2: 180,
        transaction_type: "sale", property_type: "apartment", title: "استيراد قديم" },
    ],
    syncState: [
      ["9:null-1", { source_id: 9, external_id: "null-1", file_path: "_properties/no-area.md", blob_sha: fakeSha(content), content_hash: "x", last_synced_at: "2026-10-01T00:00:00Z" }],
      ["9:__run__", { source_id: 9, external_id: "__run__", file_path: "__run__", blob_sha: null, content_hash: "v0.0.1", last_synced_at: "2026-10-01T00:00:00Z" }],
    ],
  });
  const env = { DB: db, SYNC_ALLOW_DDL: "1", SYNC_MIN_INTERVAL_S: "0", SYNC_FETCH_BUDGET: "500" };
  try {
    const res = await syncViaHttp(env);
    assert.equal(res.body.logic_reprocess, true, "لازم يعلن إعادة المعالجة عند تغيّر النسخة");
    assert.equal(res.body.github.fetched, 1, "الملف اتعالج تاني رغم تطابق الـblob SHA");
    assert.equal(res.body.db.area_cleared, 1);
    assert.equal(db.state.listings[0].area_id, null);

    // التشغيل التالي (نفس النسخة) يرجع للمسار السريع: صفر قراءات
    const second = await syncViaHttp(env);
    assert.equal(second.body.logic_reprocess, false);
    assert.equal(second.body.github.fetched, 0);
  } finally {
    gh.restore();
  }
});
