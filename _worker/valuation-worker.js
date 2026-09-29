// سمسار طلبك — Valuation Worker v4.0 (Cloudflare D1)
// Source of truth: DB binding -> price_snapshots. No market-data.json fallback.
// Public endpoint: https://noisy-bush-fd84.footcai-555.workers.dev
// Page: https://nasr-realestate.github.io/tools/valuation.html

import { calculateMarketTotals, getMarketSnapshot, listMarketAreas, normalizePropertyType, normalizeTransaction } from "./market-data.js";

const WORKER_VERSION = "v4.0";
const API_CONTRACT = "d1-price-snapshots-v1";
const SERVICE_NAME = "nasr-valuation";
const DEFAULT_ALLOWED_ORIGINS = ["https://nasr-realestate.github.io"];
const MAX_REQUEST_BYTES = 16 * 1024;

function allowedOrigins(env) {
  const extra = String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);
  return [...new Set([...DEFAULT_ALLOWED_ORIGINS, ...extra])];
}

function corsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const allowed = allowedOrigins(env);
  return {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : DEFAULT_ALLOWED_ORIGINS[0],
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(cors, body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}

function toEnglishDigits(value) {
  const map = { "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4", "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9" };
  return String(value ?? "").replace(/[٠-٩]/g, digit => map[digit]);
}

function parseAreaSize(value) {
  if (typeof value === "number") return value;
  const normalized = toEnglishDigits(value).replace(/[٬,\s]/g, "").replace(/[^\d.]/g, "");
  const size = Number(normalized);
  return Number.isFinite(size) ? size : 0;
}

export function calculateValuation(snapshot, size) {
  const totals = calculateMarketTotals(snapshot, size);
  if (!totals) return null;
  return {
    ...totals,
    api_contract: API_CONTRACT,
    source_table: "price_snapshots",
    version: WORKER_VERSION,
    area_found: snapshot.area_found,
    property_type: snapshot.property_type,
    transaction: snapshot.transaction,
    rent_condition: snapshot.rent_condition,
    price_basis: snapshot.price_basis,
    confidence: snapshot.confidence || "unknown",
    sample_count: snapshot.sample_count,
    period: snapshot.period,
    updated_at: snapshot.updated_at,
    data_source: snapshot.data_source || "price_snapshots",
    disclaimer: "مؤشر استرشادي مبني على بيانات السوق المتاحة (أسعار طلب)، وليس إثباتًا لسعر إتمام البيع أو الإيجار. التشطيب والدور والعمر معلومات وصفية ولا تغيّر الحساب لعدم وجود معامل موثق لها في بيانات العينة.",
  };
}

function errorForSnapshot(result) {
  if (result.reason === "area_not_found") {
    return {
      status: 400,
      body: {
        code: "AREA_NOT_FOUND",
        error: "المنطقة غير معروفة في بيانات السوق الحالية. اختر اسم المنطقة كما يظهر في القائمة.",
        available_areas: result.available_areas || [],
      },
    };
  }
  if (result.reason === "unsupported_type") {
    return {
      status: 422,
      body: {
        code: "UNSUPPORTED_PROPERTY_TYPE",
        error: "نوع العقار أو العملية غير مدعوم في بيانات السوق الحالية، ولن نستخدم متوسط نوع آخر كبديل.",
      },
    };
  }
  if (result.reason === "market_unavailable") {
    return {
      status: 503,
      body: {
        code: "MARKET_UNAVAILABLE",
        error: "تعذر الوصول إلى بيانات السوق حاليًا. حاول مرة أخرى لاحقًا.",
      },
    };
  }
  return {
    status: 422,
    body: {
      code: "INSUFFICIENT_MARKET_DATA",
      error: "لا توجد لقطة سوقية كافية تطابق المنطقة ونوع العقار والعملية وحالة التأثيث عند انطباقها؛ لن نخمن رقمًا.",
    },
  };
}

function marketUnavailableResponse(cors) {
  return jsonResponse(cors, {
    service: SERVICE_NAME,
    status: "unavailable",
    version: WORKER_VERSION,
    error: "تعذر الوصول إلى بيانات السوق حاليًا.",
    available_areas: [],
  }, 503);
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    if (request.method === "GET") {
      try {
        const areas = await listMarketAreas(env?.DB);
        return jsonResponse(cors, {
          service: SERVICE_NAME,
          status: "running",
          version: WORKER_VERSION,
          api_contract: API_CONTRACT,
          areas: areas.length,
          available_areas: areas,
          data_source: "price_snapshots",
          source_table: "price_snapshots",
        });
      } catch {
        return marketUnavailableResponse(cors);
      }
    }

    if (request.method !== "POST") {
      return jsonResponse(cors, { error: "Method not allowed" }, 405);
    }

    const declaredLength = Number(request.headers.get("Content-Length") || 0);
    if (declaredLength > MAX_REQUEST_BYTES) {
      return jsonResponse(cors, { error: "حجم الطلب أكبر من المسموح." }, 413);
    }

    let payload;
    try {
      payload = await request.json();
    } catch {
      return jsonResponse(cors, { error: "طلب غير صالح (JSON)." }, 400);
    }

    const area = String(payload?.area || "").trim().slice(0, 100);
    const areaType = normalizeTransaction(payload?.areaType || payload?.transaction);
    const requestedType = String(payload?.propertyType || "").trim().slice(0, 80);
    const propertyType = normalizePropertyType(requestedType);
    const size = parseAreaSize(payload?.size);

    if (!area) return jsonResponse(cors, { code: "AREA_REQUIRED", error: "اختر المنطقة أولًا." }, 400);
    if (!areaType) return jsonResponse(cors, { code: "TRANSACTION_REQUIRED", error: "اختر نوع العملية (بيع أو إيجار)." }, 400);
    if (!requestedType) {
      return jsonResponse(cors, { code: "PROPERTY_TYPE_REQUIRED", error: "اختر نوع العقار أولًا." }, 400);
    }
    if (!propertyType) {
      return jsonResponse(cors, {
        code: "UNSUPPORTED_PROPERTY_TYPE",
        error: "نوع العقار غير مدعوم في بيانات السوق الحالية.",
      }, 422);
    }
    if (!Number.isFinite(size) || size < 20 || size > 100000) {
      return jsonResponse(cors, { code: "INVALID_AREA_SIZE", error: "المساحة غير صالحة (الحد الأدنى 20 م²)." }, 400);
    }

    const rentCondition = payload?.rentCondition ?? payload?.furnished;
    const snapshot = await getMarketSnapshot(env?.DB, {
      area,
      areaType,
      propertyType,
      rentCondition,
      // Older clients send a boolean furnished field. It remains supported.
      furnished: typeof payload?.furnished === "boolean" ? payload.furnished : undefined,
    });

    if (!snapshot.ok) {
      const failure = errorForSnapshot(snapshot);
      return jsonResponse(cors, failure.body, failure.status);
    }

    const result = calculateValuation(snapshot, size);
    if (!result) {
      return jsonResponse(cors, {
        code: "INSUFFICIENT_MARKET_DATA",
        error: "لا توجد بيانات سوقية كافية لإتمام التقييم.",
      }, 422);
    }

    return jsonResponse(cors, result);
  },
};
