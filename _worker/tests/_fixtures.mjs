// Shared test fixtures (helper module — NOT a test file; node --test only runs *.test.mjs).
//
// ⚠️ كل الأرقام هنا مخترعة للاختبار فقط: مش بيانات D1 الحقيقية ومش بتتنشر
//    (_worker/ مستبعد من بناء Jekyll في _config.yml). الغرض اختبار منطق الـWorker مش قيم السوق.

// قائمة المناطق الحيّة (GET /areas على Worker التقييم المنشور: 31 منطقة، id 1 = مدينة نصر ككل).
export const AREA_NAMES = [
  "مدينة نصر", "الحي الأول", "الحي الثاني", "الحي الثالث", "الحي الرابع", "الحي الخامس",
  "الحي السادس", "الحي السابع", "الحي الثامن", "الحي التاسع", "الحي العاشر", "الحي الحادي عشر",
  "الحي الثاني عشر", "الحي الدبلوماسي", "الواحة", "زهراء مدينة نصر", "المنطقة الأولى",
  "المنطقة الثانية", "المنطقة الثالثة", "المنطقة الرابعة", "المنطقة الخامسة", "المنطقة السادسة",
  "المنطقة السابعة", "المنطقة الثامنة", "المنطقة التاسعة", "المنطقة العاشرة", "المنطقة الحادية عشرة",
  "المنطقة الثانية عشرة", "ممر مكرم عبيد", "ممر عباس العقاد", "رابعة العدوية",
];
export const AREAS = AREA_NAMES.map((name_ar, i) => ({ id: i + 1, name_ar, name_en: "", level: "x" }));
export const AREA_ID = Object.fromEntries(AREAS.map(a => [a.name_ar, a.id]));
// المناطق ذات الأولوية في القائمة (C-4): السادسة 22 · الثامنة 24 · التاسعة 25 · الحي العاشر 11 · المدينة ككل 1
export const ID = { city: 1, hayy1: 2, hayy10: 11, zone1: 17, zone6: 22, zone8: 24, zone9: 25, makram: 29 };

let snapshotSeq = 0;
export function snap(areaId, o = {}) {
  return {
    id: ++snapshotSeq,
    area_id: areaId,
    property_type: o.type ?? "apartment",
    transaction_type: o.tx ?? "sale",
    condition_type: o.cond ?? null,
    median_price_m2: o.median ?? null,
    p25_price_m2: o.p25 ?? null,
    p75_price_m2: o.p75 ?? null,
    min_price_m2: o.min ?? 30000,
    max_price_m2: o.max ?? 70000,
    sample_count: o.n ?? 41,
    confidence: null,
    period: o.period ?? "2026-09",
    calculated_at: "2026-09-30T00:00:00Z",
    source_id: 8,
    source_verified: 1,
    price_verified: 1,
    notes: "",
    ...(o.extra || {}),
  };
}

// لقطات افتراضية: بيع شقق للمناطق ذات الأولوية + المدينة ككل، وإيجار شقق (مفروش / غير مفروش / الكل)، ومحل للمدينة ككل فقط.
export function defaultRows() {
  return [
    snap(ID.zone6, { median: 52000, p25: 46000, p75: 58000, min: 38000, max: 70000, n: 41 }),
    snap(ID.zone8, { median: 47000, p25: 42000, p75: 52000, min: 35000, max: 61000, n: 33 }),
    snap(ID.zone9, { median: 45500, p25: 40000, p75: 50000, min: 33000, max: 60000, n: 12 }),
    snap(ID.hayy10, { median: 43000, p25: 38000, p75: 48000, min: 30000, max: 56000, n: 8 }),
    snap(ID.zone1, { median: 50000, p25: 45000, p75: 55000, min: 40000, max: 65000, n: 12 }),
    snap(ID.hayy1, { median: 38000, p25: 34000, p75: 42000, min: 30000, max: 48000, n: 9 }),
    snap(ID.city, { median: 44000, p25: 39000, p75: 50000, min: 31000, max: 64000, n: 220 }),
    snap(ID.zone6, { tx: "rent", cond: "furnished", median: 520, p25: 450, p75: 610, min: 380, max: 800, n: 19 }),
    snap(ID.zone6, { tx: "rent", cond: "unfurnished", median: 260, p25: 220, p75: 300, min: 180, max: 380, n: 14 }),
    snap(ID.city, { tx: "rent", cond: "all", median: 310, p25: 250, p75: 380, min: 200, max: 600, n: 140 }),
    snap(ID.city, { type: "shop", median: 90000, p25: 70000, p75: 120000, min: 50000, max: 180000, n: 25 }),
  ];
}

// D1 وهمي: prepare(sql).bind(...).all() — بيسجّل كل SQL، وبيفهم WHERE area_id IN (…) (E-4).
export function makeDb({ areas = AREAS, rows = defaultRows(), failWhere = false, emptyWhere = false, failAll = false } = {}) {
  const log = [];
  return {
    log,
    prepare(sql) {
      return {
        _binds: [],
        bind(...args) { this._binds = args; return this; },
        async all() {
          log.push({ sql, binds: this._binds });
          if (failAll) throw new Error("D1 unavailable");
          // LIMIT ? هو آخر bind (زي ما بيعمل الـWorker) — بنحاكيه عشان نختبر القطع الصامت عند 1000 صف
          const limit = Number(this._binds[this._binds.length - 1]) || Infinity;
          if (/FROM\s+areas/i.test(sql)) return { results: areas.slice(0, limit) };
          if (/FROM\s+price_snapshots/i.test(sql)) {
            const m = sql.match(/WHERE\s+area_id\s+IN\s*\(([^)]*)\)/i);
            if (m) {
              if (failWhere) throw new Error("D1_ERROR: no such column: area_id");
              if (emptyWhere) return { results: [] };
              const ids = this._binds.slice(0, m[1].split(",").length);
              return { results: rows.filter(r => ids.includes(r.area_id)).slice(0, limit) };
            }
            return { results: rows.slice(0, limit) };
          }
          throw new Error(`Unexpected D1 statement: ${sql}`);
        },
      };
    },
  };
}
export const brokenDb = { prepare() { throw new Error("D1 unavailable"); } };

// POST /api على Worker التقييم (body كائن أو نص خام)
export async function valuationPost(worker, body, env, init = {}) {
  const response = await worker.fetch(new Request("https://worker.test/api", {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "https://nasr-realestate.github.io", ...(init.headers || {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
    ...(init.extra || {}),
  }), env);
  return { status: response.status, body: await response.json() };
}

// جسم chunked بلا Content-Length (بيتخطى فحص الـheader): بيبعت JSON صالح شكلًا وفيه حشو بالحجم المطلوب.
export function chunkedJsonBody(totalBytes, chunk = 64 * 1024) {
  const enc = new TextEncoder();
  let sent = -1;
  return new ReadableStream({
    pull(controller) {
      if (sent === -1) { controller.enqueue(enc.encode('{"message":"hi","pad":"')); sent = 0; return; }
      if (sent < totalBytes) {
        const k = Math.min(chunk, totalBytes - sent);
        controller.enqueue(enc.encode("a".repeat(k)));
        sent += k;
        return;
      }
      controller.enqueue(enc.encode('"}'));
      controller.close();
      sent = Infinity;
    },
  });
}

// نفس دوال التقريب في Worker التقييم (roundNumber/roundMoney) — لاختبار حدود فحص الاتساق.
export const roundNumber = (v, d = 2) => Math.round((v + Number.EPSILON) * 10 ** d) / 10 ** d;
export const roundMoney = v => roundNumber(v, 0);
