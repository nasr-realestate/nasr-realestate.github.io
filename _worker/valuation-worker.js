// ============================================================
// سمسار طلبك — Valuation Worker (مرجع الصيانة)
// الخدمة المنشورة: noisy-bush-fd84.footcai-555.workers.dev
// الصفحة: /tools/valuation.html (+ نسخة مطابقة /assets/tools/valuation.html)
// البيانات: /assets/data/market-data.json (لقطة مضمّنة أدناه + تحديث دوري)
// ------------------------------------------------------------
// ⚠️ هذا الملف مرجع للصيانة داخل المستودع — النسخة الفعلية
// منشورة على Cloudflare Workers. عند أي تعديل هنا لازم
// إعادة النشر عبر wrangler (انظر آخر الملف).
//
// عقد الـ JSON (ممنوع كسره — الصفحة تعتمد عليه):
//   POST {area, areaType, propertyType, size, finishing, floor, age, furnished}
//   ← 200 {estimate, range{low,high}, price_per_meter, area_found, confidence, disclaimer}
//   ← 400 {error}
//   GET  → {service, status, areas, available_areas, version}
// ------------------------------------------------------------
// العلاقة مع الوكيل (royal-snow-ea32):
//   • دومينان مختلفان + صفحتان مختلفتان = لا تعارض إطلاقًا
//   • نفس سياسة CORS (القائمة البيضاء أدناه)
// ============================================================

// ═══ CONFIG ═══
const WORKER_VERSION = "v1.2";
const SERVICE_NAME = "nasr-valuation";

// النطاقات المسموح لها — نفس نمط worker.js (الوكيل)
const DEFAULT_ALLOWED_ORIGINS = [
  "https://nasr-realestate.github.io",
];

// ═══ MARKET SNAPSHOT (من market-data.json — حدّثها مع أي تحديث للملف) ═══
// last_updated: 2026-09-27 | areas: 15
const AREAS = [
  { name: "عباس العقاد", sale_avg: 34000, rent_unf: 210, rent_fur: 310, confidence: "high" },
  { name: "مكرم عبيد", sale_avg: 32500, rent_unf: 200, rent_fur: 290, confidence: "high" },
  { name: "المنطقة الأولى", sale_avg: 31000, rent_unf: 195, rent_fur: 280, confidence: "high" },
  { name: "رابعة العدوية", sale_avg: 30000, rent_unf: 190, rent_fur: 275, confidence: "high" },
  { name: "المنطقة الرابعة", sale_avg: 29000, rent_unf: 185, rent_fur: 260, confidence: "high" },
  { name: "المنطقة السادسة", sale_avg: 28500, rent_unf: 180, rent_fur: 250, confidence: "high" },
  { name: "المنطقة الثانية", sale_avg: 28500, rent_unf: 180, rent_fur: 250, confidence: "high" },
  { name: "مصطفى النحاس", sale_avg: 26000, rent_unf: 165, rent_fur: 230, confidence: "high" },
  { name: "المنطقة الثالثة", sale_avg: 24500, rent_unf: 160, rent_fur: 220, confidence: "high" },
  { name: "المنطقة الخامسة", sale_avg: 23500, rent_unf: 150, rent_fur: 210, confidence: "high" },
  { name: "الحي الثامن", sale_avg: 23000, rent_unf: 155, rent_fur: 225, confidence: "high" },
  { name: "المنطقة العاشرة", sale_avg: 21500, rent_unf: 140, rent_fur: 195, confidence: "high" },
  { name: "الحي السابع", sale_avg: 21000, rent_unf: 140, rent_fur: 200, confidence: "high" },
  { name: "حي الواحة", sale_avg: 19500, rent_unf: 130, rent_fur: 185, confidence: "high" },
  { name: "زهراء مدينة نصر", sale_avg: 16500, rent_unf: 110, rent_fur: 155, confidence: "high" },
];

const PT_MULT = {
  "شقة": 1.00, "فيلا": 1.25, "دوبلكس": 1.20, "روف": 0.75,
  "محل تجاري": 1.80, "مكتب إداري": 1.30, "مخزن": 0.65,
};

const FIN_FACTOR = {
  "ألترا سوبر لوكس": 1.18, "سوبر لوكس": 1.00,
  "نصف تشطيب": 0.78, "طوب أحمر": 0.68,
};

const AGE_FACTOR = { new: 1.10, medium: 1.00, old: 0.85 };

const FLOOR_FACTOR = {
  "أرضي": 0.95, "أول": 1.00, "ثاني": 1.00,
  "ثالث": 1.00, "رابع": 1.00, "خامس+": 0.97,
};

const DISCLAIMER = "التقييم تقديري ومرجعي — يُستخدم كأساس للتفاوض لا كسعر رسمي.";

// ═══ HELPERS ═══
const AR_MAP = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const toEn = s => String(s || "").replace(/[٠-٩]/g, d => AR_MAP[d]);
const normAr = s => toEn(s).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ـ/g, "").trim();

function findArea(name) {
  const n = normAr(name);
  return AREAS.find(a => normAr(a.name) === n) || null;
}

function allowedOrigins(env) {
  const extra = String(env?.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  return [...DEFAULT_ALLOWED_ORIGINS, ...extra];
}

function corsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const ok = origin && allowedOrigins(env).includes(origin);
  return {
    "Access-Control-Allow-Origin": ok ? origin : DEFAULT_ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

const jsonRes = (cors, obj, s = 200) =>
  new Response(JSON.stringify(obj), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// ═══ CORE: نفس المعادلة في كل مكان (هنا + التقدير المحلي في الصفحة) ═══
function valuate(p) {
  const area = findArea(p.area);
  if (!area) return { error: "المنطقة غير مدعومة حاليًا" };

  const size = parseFloat(toEn(p.size));
  if (!size || size < 20 || size > 100000) return { error: "مساحة غير صالحة" };

  const isRent = p.areaType === "rent";
  const base = isRent
    ? (p.furnished ? area.rent_fur : area.rent_unf)
    : area.sale_avg;

  const perMeter = Math.round(
    base *
    (PT_MULT[p.propertyType] || 1.0) *
    (FIN_FACTOR[p.finishing] || 1.0) *
    (AGE_FACTOR[p.age] || 1.0) *
    (FLOOR_FACTOR[p.floor] || 1.0)
  );

  const raw = perMeter * size;
  const estimate = isRent
    ? Math.round(raw / 100) * 100
    : Math.round(raw / 1000) * 1000;

  return {
    estimate,
    range: {
      low: Math.round(estimate * 0.9 / 1000) * 1000,
      high: Math.round(estimate * 1.1 / 1000) * 1000,
    },
    price_per_meter: perMeter,
    area_found: area.name,
    confidence: area.confidence || "medium",
    disclaimer: DISCLAIMER,
  };
}

// ═══ ENTRY ═══
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET") {
      return jsonRes(cors, {
        service: SERVICE_NAME,
        status: "running",
        version: WORKER_VERSION,
        areas: AREAS.length,
        available_areas: AREAS.map(a => a.name),
      });
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonRes(cors, { error: "طلب غير صالح (JSON)" }, 400);
      }
      const out = valuate(body || {});
      if (out.error) return jsonRes(cors, out, 400);
      return jsonRes(cors, out, 200);
    }

    return jsonRes(cors, { error: "Method not allowed" }, 405);
  },
};

// ============================================================
// النشر (عند تعديل هذا الملف):
//   cd _worker
//   npx wrangler deploy valuation-worker.js --name noisy-bush-fd84
// ثم تحقق:
//   curl "https://noisy-bush-fd84.footcai-555.workers.dev"
//   → {"service":"nasr-valuation","status":"running","areas":15,...}
// ============================================================
