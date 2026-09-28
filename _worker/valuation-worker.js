// ============================================================
// سمسار طلبك — Valuation Worker v2.0
// الخدمة المنشورة: noisy-bush-fd84.footcai-555.workers.dev
// الصفحة: /tools/valuation.html
// البيانات: /assets/data/market-data.json
// ------------------------------------------------------------
// عقد الـ JSON (ممنوع كسره):
//   POST {area, areaType, propertyType, size, finishing, floor, age, furnished}
//   ← 200 {estimate, range{low,high}, price_per_meter, area_found, confidence, disclaimer}
//   ← 400 {error}
//   GET  → {service, status, areas, available_areas, version}
// ------------------------------------------------------------
// v2.0 — بيقرأ market-data.json مباشرة (20 منطقة)
// ============================================================

const WORKER_VERSION = "v2.0";
const SERVICE_NAME = "nasr-valuation";
const MARKET_DATA_URL = "https://nasr-realestate.github.io/assets/data/market-data.json";
const CACHE_TTL_MS = 60 * 60 * 1000; // ساعة

const DEFAULT_ALLOWED_ORIGINS = [
  "https://nasr-realestate.github.io",
];

let cache = { at: 0, data: null };

// ═══ جلب market-data.json ═══
async function getMarketData() {
  const now = Date.now();
  if (cache.data && (now - cache.at) < CACHE_TTL_MS) return cache.data;
  const r = await fetch(MARKET_DATA_URL, {
    headers: { "Accept": "application/json" },
    cf: { cacheTtl: 3600, cacheEverything: true }
  });
  if (!r.ok) throw new Error(`Market data HTTP ${r.status}`);
  const data = await r.json();
  if (!data || !Array.isArray(data.areas)) throw new Error("Invalid market data");
  cache = { at: now, data };
  return data;
}

// ═══ Helpers ═══
const AR_MAP = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
const toEn = s => String(s || "").replace(/[٠-٩]/g, d => AR_MAP[d]);
const normAr = s => toEn(s).replace(/[أإآ]/g, "ا").replace(/ة/g, "ه").replace(/ى/g, "ي").replace(/ـ/g, "").trim();

function findArea(marketData, name) {
  const n = normAr(name);
  if (!n) return null;
  for (const a of marketData.areas) {
    if (normAr(a.name) === n) return a;
    if (a.name_en && normAr(a.name_en) === n) return a;
  }
  for (const a of marketData.areas) {
    const an = normAr(a.name);
    if (an.includes(n) || n.includes(an)) return a;
  }
  for (const a of marketData.areas) {
    for (const street of (a.main_streets || [])) {
      if (normAr(street).includes(n)) return a;
    }
  }
  return null;
}

function getFinishFactor(finishing, marketData) {
  if (!finishing) return 1;
  const adj = marketData.adjustments?.finishing || {};
  const t = normAr(finishing);
  if (t.includes("الترا")) return adj.ultra_lux?.factor || 1.20;
  if (t.includes("سوبر")) return adj.super_lux?.factor || 1.00;
  if (t.includes("نصف") || t.includes("نص")) return adj.half_finished?.factor || 0.78;
  if (t.includes("طوب")) return adj.red_brick?.factor || 0.68;
  return 1;
}

function getFloorFactor(floor, marketData) {
  if (!floor) return 1;
  const adj = marketData.adjustments?.floor || {};
  const t = normAr(floor);
  if (t.includes("ارضي") && t.includes("حديقه")) return adj.ground_with_garden?.factor || 1.08;
  if (t.includes("ارضي")) return adj.ground_no_garden?.factor || 0.90;
  if (t.includes("خامس") || t.includes("سادس") || t.includes("اخير")) {
    return adj.high_with_elevator?.factor || 1.03;
  }
  return adj.middle?.factor || 1.00;
}

function getAgeFactor(age, marketData) {
  if (!age) return 1;
  const adj = marketData.adjustments?.age || {};
  const map = { new: "new", medium: "medium", old: "old", very_old: "very_old" };
  return adj[map[age]]?.factor || 1.00;
}

// ═══ تحديد السعر الأساسي حسب النوع ═══
function getBasePrice(areaData, areaType, propertyType, furnished) {
  // ═ تجاري/إداري (بيع) ═
  if (areaType === "sale" && propertyType === "محل تجاري") {
    return areaData.commercial_sale?.avg || 0;
  }
  if (areaType === "sale" && propertyType === "مكتب إداري") {
    return areaData.office_sale?.avg || 0;
  }

  // ═ تجاري/إداري (إيجار) ═
  if (areaType === "rent" && propertyType === "محل تجاري") {
    return areaData.rent?.commercial?.avg || 0;
  }
  if (areaType === "rent" && propertyType === "مكتب إداري") {
    return areaData.rent?.office?.avg || 0;
  }

  // ═ سكني — إيجار ═
  if (areaType === "rent") {
    if (furnished) return areaData.rent?.furnished?.avg || 0;
    return areaData.rent?.unfurnished?.avg || 0;
  }

  // ═ سكني — بيع ═
  const typeMap = {
    "شقة": "apartment",
    "فيلا": "villa",
    "دوبلكس": "duplex",
    "روف": "roof",
  };
  const key = typeMap[propertyType] || "apartment";
  return areaData.sale?.[key]?.avg || 0;
}

function getConfidence(areaData, areaType, propertyType, furnished) {
  const typeMap = { "شقة": "apartment", "فيلا": "villa", "دوبلكس": "duplex", "روف": "roof" };
  if (areaType === "sale" && propertyType === "محل تجاري") return areaData.commercial_sale?.confidence || "low";
  if (areaType === "sale" && propertyType === "مكتب إداري") return areaData.office_sale?.confidence || "low";
  if (areaType === "rent" && propertyType === "محل تجاري") return areaData.rent?.commercial?.confidence || "low";
  if (areaType === "rent" && propertyType === "مكتب إداري") return areaData.rent?.office?.confidence || "low";
  if (areaType === "rent") {
    if (furnished) return areaData.rent?.furnished?.confidence || "low";
    return areaData.rent?.unfurnished?.confidence || "low";
  }
  const key = typeMap[propertyType] || "apartment";
  return areaData.sale?.[key]?.confidence || "low";
}

function getPropertyTypeMultiplier(propertyType, marketData) {
  if (!propertyType) return 1.0;
  const map = marketData.property_type_multipliers || {};
  for (const [k, v] of Object.entries(map)) {
    if (normAr(k) === normAr(propertyType)) return v;
  }
  return 1.0;
}

// ═══ التقييم ═══
async function valuate(p, marketData) {
  const area = findArea(marketData, p.area);
  if (!area) {
    return {
      error: "المنطقة غير مدعومة حاليًا",
      available_areas: marketData.areas.map(a => a.name)
    };
  }

  const size = parseFloat(toEn(p.size));
  if (!size || size < 20 || size > 100000) return { error: "مساحة غير صالحة" };

  const areaType = p.areaType === "rent" ? "rent" : "sale";
  const propertyType = p.propertyType || "شقة";
  const furnished = !!p.furnished;

  const base = getBasePrice(area, areaType, propertyType, furnished);
  if (!base) return { error: "لا توجد بيانات كافية لهذا النوع في المنطقة دي" };

  const finishF = getFinishFactor(p.finishing, marketData);
  const floorF = getFloorFactor(p.floor, marketData);
  const ageF = getAgeFactor(p.age, marketData);
  const ptMult = getPropertyTypeMultiplier(propertyType, marketData);

  const perMeter = Math.round(base * finishF * floorF * ageF * ptMult);
  const raw = perMeter * size;

  const estimate = areaType === "rent"
    ? Math.round(raw / 100) * 100
    : Math.round(raw / 1000) * 1000;

  const confidence = getConfidence(area, areaType, propertyType, furnished);
  const rangeMult = confidence === "high" ? 0.95
                  : confidence === "medium" ? 0.90
                  : 0.85;

  return {
    estimate,
    range: {
      low: Math.round(estimate * rangeMult / 1000) * 1000,
      high: Math.round(estimate * (2 - rangeMult) / 1000) * 1000,
    },
    price_per_meter: perMeter,
    area_found: area.name,
    area_level: area.level_ar || area.level,
    confidence,
    data_source: area.data_source || "Gemini (estimate)",
    verified: area.verified || false,
    adjustments: {
      finishing: finishF,
      floor: floorF,
      age: ageF,
      property_type: ptMult,
    },
    disclaimer: "التقييم تقديري ومرجعي — يُستخدم كأساس للتفاوض لا كسعر رسمي.",
  };
}

// ═══ CORS ═══
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
    "X-Content-Type-Options": "nosniff",
  };
}

const jsonRes = (cors, obj, s = 200) =>
  new Response(JSON.stringify(obj), { status: s, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

// ═══ ENTRY ═══
export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    if (request.method === "GET") {
      try {
        const marketData = await getMarketData();
        return jsonRes(cors, {
          service: SERVICE_NAME,
          status: "running",
          version: WORKER_VERSION,
          areas: marketData.areas.length,
          available_areas: marketData.areas.map(a => a.name),
          last_updated: marketData.last_updated,
        });
      } catch (err) {
        return jsonRes(cors, { error: err.message }, 500);
      }
    }

    if (request.method === "POST") {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonRes(cors, { error: "طلب غير صالح (JSON)" }, 400);
      }

      try {
        const marketData = await getMarketData();
        const out = await valuate(body || {}, marketData);
        if (out.error) return jsonRes(cors, out, 400);
        return jsonRes(cors, out, 200);
      } catch (err) {
        return jsonRes(cors, { error: "خطأ في التقييم: " + err.message }, 500);
      }
    }

    return jsonRes(cors, { error: "Method not allowed" }, 405);
  },
};

// ============================================================
// النشر:
//   1. انسخ الكود ده
//   2. Cloudflare → Workers → noisy-bush-fd84 → Edit code
//   3. الصق → Deploy
//   4. اختبر: curl "https://noisy-bush-fd84.footcai-555.workers.dev"
// ============================================================
