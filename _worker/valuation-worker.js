// ═══════════════════════════════════════════════════════════════════════════
// سمسار طلبك — Valuation Worker
// إعادة بناء كاملة من الصفر
//
// Database binding:
//   DB → nasr-market-db
//
// Main table:
//   price_snapshots
//
// Supporting table:
//   areas
//
// API Contract:
//   d1-price-snapshots-v2
//
// قواعد التقييم:
//   1) Median هو المؤشر المركزي.
//   2) P25 → P75 هو النطاق الأساسي.
//   3) Min / Max حدود مرصودة للعينة وليست نطاق السوق الأساسي.
//   4) Confidence موحد:
//        >= 30  → high
//        10-29  → medium
//        < 10   → low
//   5) جميع المصادر تدخل في نفس نظام التقييم.
//   6) أسعار البيانات الحالية هي أسعار طلب، وليست أسعار إتمام.
//   7) لا يتم اختراع قيمة عند عدم وجود Snapshot مناسب.
// ═══════════════════════════════════════════════════════════════════════════

const WORKER_VERSION = "v6.0";
const API_CONTRACT = "d1-price-snapshots-v2";
const SERVICE_NAME = "nasr-valuation";

const DEFAULT_ALLOWED_ORIGINS = [
  "https://nasr-realestate.github.io",
];

const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_ROWS = 1000;

const SNAPSHOT_TABLE = "price_snapshots";
const AREA_TABLE = "areas";

const WHOLE_CITY_AREA_ID = 1;
const WHOLE_CITY_NAME = "مدينة نصر (ككل)";

const SOURCE_NAMES = {
  8: "Manus Verified",
  9: "سمسار طلبك",
};

const AR_DIGITS = {
  "٠": "0",
  "١": "1",
  "٢": "2",
  "٣": "3",
  "٤": "4",
  "٥": "5",
  "٦": "6",
  "٧": "7",
  "٨": "8",
  "٩": "9",
};

// ═══════════════════════════════════════════════════════════════════════════
// General helpers
// ═══════════════════════════════════════════════════════════════════════════

function normalizeArabic(value) {
  return String(value ?? "")
    .trim()
    .replace(/[إأآٱ]/g, "ا")
    .replace(/ى/g, "ي")
    .replace(/ة/g, "ه")
    .replace(/ـ/g, "")
    .replace(/\s+/g, " ");
}

function compactArabic(value) {
  return normalizeArabic(value)
    .replace(/[()\[\]{}]/g, " ")
    .replace(/[،,؛;:_\-–—/\\]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function keyArabic(value) {
  return compactArabic(value)
    .replace(/\s/g, "")
    .toLowerCase();
}

function toEnglishDigits(value) {
  return String(value ?? "").replace(
    /[٠-٩]/g,
    digit => AR_DIGITS[digit] ?? digit
  );
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const normalized = toEnglishDigits(value)
    .replace(/[٬,]/g, "")
    .trim();

  const number = Number(normalized);

  return Number.isFinite(number) ? number : null;
}

function parseAreaSize(value) {
  const size = numericValue(
    String(value ?? "")
      .replace(/[ممس²]/g, "")
      .replace(/m2/gi, "")
      .replace(/m²/gi, "")
  );

  return size ?? 0;
}

function roundNumber(value, decimals = 2) {
  if (!Number.isFinite(value)) return null;

  const factor = 10 ** decimals;

  return Math.round((value + Number.EPSILON) * factor) / factor;
}

function roundMoney(value) {
  return roundNumber(value, 0);
}

function safeString(value) {
  return String(value ?? "").trim();
}

function firstNonEmpty(...values) {
  for (const value of values) {
    if (value !== null && value !== undefined && String(value).trim() !== "") {
      return value;
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Property / transaction normalization
// ═══════════════════════════════════════════════════════════════════════════

function normalizePropertyType(value) {
  const key = keyArabic(value);

  if (!key) return null;

  // Duplex first because some descriptions may contain apartment language.
  if (
    key.includes("duplex") ||
    key.includes("دوبلكس") ||
    key.includes("دوبلكس")
  ) {
    return "duplex";
  }

  if (
    key.includes("villa") ||
    key.includes("فيلا") ||
    key.includes("فيللا")
  ) {
    return "villa";
  }

  if (
    key.includes("roof") ||
    key.includes("روف")
  ) {
    return "roof";
  }

  if (
    key.includes("shop") ||
    key.includes("store") ||
    key.includes("محل") ||
    key.includes("تجاري")
  ) {
    return "shop";
  }

  if (
    key.includes("office") ||
    key.includes("اداري") ||
    key.includes("إداري") ||
    key.includes("مكتب") ||
    key.includes("مقر")
  ) {
    return "office";
  }

  if (
    key.includes("warehouse") ||
    key.includes("مخزن") ||
    key.includes("مستودع")
  ) {
    return "warehouse";
  }

  if (
    key.includes("apartment") ||
    key.includes("flat") ||
    key.includes("شقه") ||
    key.includes("شقة")
  ) {
    return "apartment";
  }

  return null;
}

function normalizeTransaction(value) {
  const key = keyArabic(value);

  if (!key) return null;

  if (
    key.includes("sale") ||
    key.includes("sell") ||
    key.includes("بيع")
  ) {
    return "sale";
  }

  if (
    key.includes("rent") ||
    key.includes("rental") ||
    key.includes("ايجار") ||
    key.includes("إيجار") ||
    key.includes("تاجير") ||
    key.includes("تأجير")
  ) {
    return "rent";
  }

  return null;
}

function normalizeRentCondition(value) {
  if (value === true) return "furnished";
  if (value === false) return "unfurnished";

  const key = keyArabic(value);

  if (!key) return null;

  if (
    key.includes("furnished") ||
    key.includes("مفروش") ||
    key === "furnished"
  ) {
    return "furnished";
  }

  if (
    key.includes("unfurnished") ||
    key.includes("غيرمفروش") ||
    key.includes("غير مفروش") ||
    key.includes("فاضي") ||
    key.includes("فارغ")
  ) {
    return "unfurnished";
  }

  if (
    key === "all" ||
    key.includes("كله") ||
    key.includes("الكل") ||
    key.includes("عام") ||
    key.includes("allconditions")
  ) {
    return "all";
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Confidence
// ═══════════════════════════════════════════════════════════════════════════

function confidenceFromSampleCount(sampleCount, storedConfidence = null) {
  const count = numericValue(sampleCount);

  if (count !== null && count >= 30) {
    return "high";
  }

  if (count !== null && count >= 10) {
    return "medium";
  }

  if (count !== null && count > 0) {
    return "low";
  }

  const stored = keyArabic(storedConfidence);

  if (
    stored === "high" ||
    stored === "medium" ||
    stored === "low"
  ) {
    return stored;
  }

  return "unknown";
}

// ═══════════════════════════════════════════════════════════════════════════
// CORS
// ═══════════════════════════════════════════════════════════════════════════

function allowedOrigins(env) {
  const extra = String(env?.ALLOWED_ORIGINS || "")
    .split(",")
    .map(origin => origin.trim())
    .filter(Boolean);

  return [
    ...new Set([
      ...DEFAULT_ALLOWED_ORIGINS,
      ...extra,
    ]),
  ];
}

function corsHeaders(request, env) {
  const origin = request?.headers?.get("Origin") || "";
  const allowed = allowedOrigins(env);

  const responseOrigin =
    allowed.includes(origin)
      ? origin
      : DEFAULT_ALLOWED_ORIGINS[0];

  return {
    "Access-Control-Allow-Origin": responseOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "X-Content-Type-Options": "nosniff",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(cors, body, status = 200) {
  return new Response(
    JSON.stringify(body),
    {
      status,
      headers: {
        ...cors,
        "Content-Type": "application/json; charset=utf-8",
      },
    }
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Database helpers
// ═══════════════════════════════════════════════════════════════════════════

async function loadRows(db, table, limit = MAX_ROWS) {
  if (!db) {
    throw new Error("D1 binding DB is missing.");
  }

  const safeLimit = Math.min(
    Math.max(Number(limit) || MAX_ROWS, 1),
    MAX_ROWS
  );

  const result = await db
    .prepare(`SELECT * FROM ${table} LIMIT ?`)
    .bind(safeLimit)
    .all();

  return Array.isArray(result?.results)
    ? result.results
    : [];
}

async function loadAreas(db) {
  return loadRows(db, AREA_TABLE, MAX_ROWS);
}

async function loadSnapshots(db) {
  return loadRows(db, SNAPSHOT_TABLE, MAX_ROWS);
}

// ═══════════════════════════════════════════════════════════════════════════
// Area handling
// ═══════════════════════════════════════════════════════════════════════════

function isWholeCityRequest(value) {
  const key = keyArabic(value);

  if (!key) return false;

  const aliases = [
    keyArabic(WHOLE_CITY_NAME),
    keyArabic("مدينة نصر"),
    keyArabic("مدينه نصر"),
    keyArabic("Nasr City"),
    keyArabic("NasrCity"),
    keyArabic("whole city"),
    keyArabic("all nasr city"),
  ];

  return aliases.includes(key);
}

function areaIdOf(row) {
  return numericValue(row?.id ?? row?.area_id);
}

function areaNameOf(row) {
  return safeString(
    firstNonEmpty(
      row?.name_ar,
      row?.name,
      row?.area_name_ar
    )
  );
}

function findArea(areas, requestedArea) {
  if (isWholeCityRequest(requestedArea)) {
    const city =
      areas.find(area => areaIdOf(area) === WHOLE_CITY_AREA_ID) ||
      {
        id: WHOLE_CITY_AREA_ID,
        name_ar: "مدينة نصر",
        name_en: "Nasr City",
      };

    return {
      ok: true,
      wholeCity: true,
      id: WHOLE_CITY_AREA_ID,
      name: areaNameOf(city) || "مدينة نصر",
    };
  }

  const requestedKey = keyArabic(requestedArea);

  if (!requestedKey) {
    return {
      ok: false,
      reason: "area_not_found",
    };
  }

  const found = areas.find(area => {
    const id = areaIdOf(area);
    const nameAr = keyArabic(areaNameOf(area));
    const nameEn = keyArabic(area?.name_en);

    return (
      requestedKey === nameAr ||
      requestedKey === nameEn ||
      String(id) === requestedKey
    );
  });

  if (!found) {
    return {
      ok: false,
      reason: "area_not_found",
    };
  }

  return {
    ok: true,
    wholeCity: false,
    id: areaIdOf(found),
    name: areaNameOf(found),
  };
}

function listAreaNames(areas) {
  const output = [];

  if (
    areas.some(area => areaIdOf(area) === WHOLE_CITY_AREA_ID)
  ) {
    output.push({
      id: WHOLE_CITY_AREA_ID,
      name: WHOLE_CITY_NAME,
      name_ar: "مدينة نصر",
      name_en: "Nasr City",
      scope: "city",
    });
  }

  for (const area of areas) {
    const id = areaIdOf(area);

    if (!id || id === WHOLE_CITY_AREA_ID) {
      continue;
    }

    output.push({
      id,
      name: areaNameOf(area),
      name_ar: areaNameOf(area),
      name_en: safeString(area?.name_en),
      scope: safeString(
        firstNonEmpty(
          area?.level,
          area?.area_type,
          "area"
        )
      ),
    });
  }

  return output;
}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot helpers
// ═══════════════════════════════════════════════════════════════════════════

function snapshotAreaId(row) {
  return numericValue(
    firstNonEmpty(
      row?.area_id,
      row?.areaId
    )
  );
}

function snapshotPropertyType(row) {
  return normalizePropertyType(
    firstNonEmpty(
      row?.property_type,
      row?.propertyType
    )
  );
}

function snapshotTransaction(row) {
  return normalizeTransaction(
    firstNonEmpty(
      row?.transaction_type,
      row?.transaction,
      row?.transactionType
    )
  );
}

function snapshotCondition(row) {
  const raw = firstNonEmpty(
    row?.condition_type,
    row?.rent_condition,
    row?.rental_condition,
    row?.furnishing,
    row?.furnished_status,
    row?.condition
  );

  return normalizeRentCondition(raw);
}

function snapshotSourceId(row) {
  const id = numericValue(
    firstNonEmpty(
      row?.source_id,
      row?.sourceId
    )
  );

  return id;
}

function snapshotSourceName(row) {
  const sourceId = snapshotSourceId(row);

  return safeString(
    firstNonEmpty(
      row?.source_name,
      SOURCE_NAMES[sourceId],
      sourceId ? `Source ${sourceId}` : null
    )
  );
}

function snapshotPeriod(row) {
  return safeString(
    firstNonEmpty(
      row?.period,
      row?.calculated_at,
      row?.observed_at
    )
  );
}

function snapshotDateValue(row) {
  const candidates = [
    row?.calculated_at,
    row?.observed_at,
    row?.period,
  ];

  for (const candidate of candidates) {
    const timestamp = Date.parse(String(candidate ?? ""));

    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  const period = String(row?.period ?? "");

  const match = period.match(/^(\d{4})-(\d{1,2})$/);

  if (match) {
    return Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      1
    );
  }

  return 0;
}

function snapshotNumber(row, field) {
  return numericValue(row?.[field]);
}

function snapshotSampleCount(row) {
  return numericValue(row?.sample_count);
}

function snapshotVerified(row) {
  const value = row?.source_verified;

  if (value === true || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === 0 || value === "0") {
    return false;
  }

  return null;
}

function snapshotPriceVerified(row) {
  const value = row?.price_verified;

  if (value === true || value === 1 || value === "1") {
    return true;
  }

  if (value === false || value === 0 || value === "0") {
    return false;
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Snapshot matching
// ═══════════════════════════════════════════════════════════════════════════

function conditionRank(snapshotConditionValue, requestedCondition) {
  if (!requestedCondition) {
    return snapshotConditionValue === "all" ? 1 : 0;
  }

  if (snapshotConditionValue === requestedCondition) {
    return 0;
  }

  if (snapshotConditionValue === "all") {
    return 1;
  }

  return 99;
}

function sourceRank(sourceId) {
  // Source priority is only a tie-breaker.
  // It does NOT alter the valuation formula.
  if (sourceId === 9) return 1;
  if (sourceId === 8) return 2;
  return 50;
}

function snapshotSelectionScore(row, requestedCondition) {
  const condition = snapshotCondition(row);
  const conditionScore = conditionRank(
    condition,
    requestedCondition
  );

  if (conditionScore >= 99) {
    return null;
  }

  const sampleCount = snapshotSampleCount(row) ?? 0;

  const confidence =
    confidenceFromSampleCount(
      sampleCount,
      row?.confidence
    );

  const confidenceScore =
    confidence === "high"
      ? 0
      : confidence === "medium"
        ? 1
        : confidence === "low"
          ? 2
          : 3;

  const sourceVerified =
    snapshotVerified(row) === true ? 0 : 1;

  const priceVerified =
    snapshotPriceVerified(row) === true ? 0 : 1;

  return [
    conditionScore,
    confidenceScore,
    sourceVerified,
    priceVerified,
    sourceRank(snapshotSourceId(row)),
    -sampleCount,
    -snapshotDateValue(row),
  ];
}

function compareScores(a, b) {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const av = a[i] ?? 0;
    const bv = b[i] ?? 0;

    if (av < bv) return -1;
    if (av > bv) return 1;
  }

  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// Market snapshot
// ═══════════════════════════════════════════════════════════════════════════

async function getMarketSnapshot(db, query = {}) {
  try {
    const areas = await loadAreas(db);
    const snapshots = await loadSnapshots(db);

    const areaResult = findArea(
      areas,
      query.area
    );

    if (!areaResult.ok) {
      return {
        ok: false,
        reason: "area_not_found",
        available_areas: listAreaNames(areas),
      };
    }

    const propertyType =
      normalizePropertyType(query.propertyType);

    const transaction =
      normalizeTransaction(query.areaType ?? query.transaction);

    const requestedCondition =
      transaction === "rent"
        ? normalizeRentCondition(
            query.rentCondition ??
            query.furnished
          )
        : null;

    if (!propertyType || !transaction) {
      return {
        ok: false,
        reason: "unsupported_type",
      };
    }

    let matches = snapshots.filter(row => {
      const rowAreaId = snapshotAreaId(row);
      const rowType = snapshotPropertyType(row);
      const rowTransaction = snapshotTransaction(row);

      if (areaResult.wholeCity) {
        if (rowAreaId !== WHOLE_CITY_AREA_ID) {
          return false;
        }
      } else if (rowAreaId !== areaResult.id) {
        return false;
      }

      if (rowType !== propertyType) {
        return false;
      }

      if (rowTransaction !== transaction) {
        return false;
      }

      if (transaction === "rent") {
        const rowCondition = snapshotCondition(row);

        // An aggregate "all" snapshot can be used as fallback.
        if (
          requestedCondition &&
          requestedCondition !== "all" &&
          rowCondition !== requestedCondition &&
          rowCondition !== "all"
        ) {
          return false;
        }
      }

      return true;
    });

    if (!matches.length) {
      return {
        ok: false,
        reason: "market_unavailable",
      };
    }

    const scored = matches
      .map(row => ({
        row,
        score: snapshotSelectionScore(
          row,
          requestedCondition
        ),
      }))
      .filter(item => item.score !== null)
      .sort((a, b) =>
        compareScores(a.score, b.score)
      );

    if (!scored.length) {
      return {
        ok: false,
        reason: "market_unavailable",
      };
    }

    const selected = scored[0].row;

    const median = snapshotNumber(
      selected,
      "median_price_m2"
    );

    const p25 = snapshotNumber(
      selected,
      "p25_price_m2"
    );

    const p75 = snapshotNumber(
      selected,
      "p75_price_m2"
    );

    const minimum = snapshotNumber(
      selected,
      "min_price_m2"
    );

    const maximum = snapshotNumber(
      selected,
      "max_price_m2"
    );

    /*
     * Median is mandatory for a valid valuation.
     *
     * We deliberately do not fall back to avg_price_m2.
     * The agreed valuation model uses the median as its
     * central asking-price indicator.
     */
    if (
      median === null ||
      median <= 0
    ) {
      return {
        ok: false,
        reason: "market_unavailable",
      };
    }

    if (
      p25 === null ||
      p75 === null ||
      p25 <= 0 ||
      p75 <= 0
    ) {
      return {
        ok: false,
        reason: "market_unavailable",
      };
    }

    const sampleCount =
      snapshotSampleCount(selected);

    return {
      ok: true,

      area_found: areaResult.name,
      area_id: areaResult.id,
      area_scope: areaResult.wholeCity
        ? "city"
        : "area",

      property_type: propertyType,
      transaction,

      rent_condition:
        transaction === "rent"
          ? (
              snapshotCondition(selected) ||
              requestedCondition ||
              "all"
            )
          : null,

      requested_rent_condition:
        requestedCondition,

      condition_scope:
        transaction === "rent"
          ? (
              snapshotCondition(selected) === "all"
                ? "all"
                : "specific"
            )
          : null,

      price_basis: "median_price_m2",

      median_price_m2: median,
      p25_price_m2: p25,
      p75_price_m2: p75,

      min_price_m2: minimum,
      max_price_m2: maximum,

      sample_count: sampleCount,

      confidence:
        confidenceFromSampleCount(
          sampleCount,
          selected?.confidence
        ),

      period: safeString(selected?.period),

      calculated_at:
        safeString(selected?.calculated_at),

      updated_at:
        safeString(
          firstNonEmpty(
            selected?.calculated_at,
            selected?.observed_at
          )
        ),

      source_id:
        snapshotSourceId(selected),

      source_name:
        snapshotSourceName(selected),

      source_url:
        safeString(selected?.source_url),

      source_verified:
        snapshotVerified(selected),

      price_verified:
        snapshotPriceVerified(selected),

      data_source:
        snapshotSourceName(selected) ||
        "price_snapshots",

      snapshot_id:
        numericValue(selected?.id),

      snapshot_notes:
        safeString(selected?.notes),

      raw_snapshot: undefined,
    };
  } catch (error) {
    return {
      ok: false,
      reason: "market_unavailable",
      internal_error: String(
        error?.message || error
      ),
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// Valuation
// ═══════════════════════════════════════════════════════════════════════════

function calculateMarketTotals(snapshot, size) {
  if (!snapshot?.ok) {
    return null;
  }

  const median =
    numericValue(snapshot.median_price_m2);

  const p25 =
    numericValue(snapshot.p25_price_m2);

  const p75 =
    numericValue(snapshot.p75_price_m2);

  const minimum =
    numericValue(snapshot.min_price_m2);

  const maximum =
    numericValue(snapshot.max_price_m2);

  if (
    median === null ||
    median <= 0 ||
    p25 === null ||
    p25 <= 0 ||
    p75 === null ||
    p75 <= 0 ||
    !Number.isFinite(size) ||
    size <= 0
  ) {
    return null;
  }

  return {
    estimate: roundMoney(
      median * size
    ),

    price_per_meter:
      roundNumber(median, 2),

    price_per_m2_range: {
      low: roundNumber(p25, 2),
      high: roundNumber(p75, 2),
    },

    range: {
      low: roundMoney(p25 * size),
      high: roundMoney(p75 * size),
    },

    market_bounds: {
      min_price_per_m2:
        minimum !== null
          ? roundNumber(minimum, 2)
          : null,

      max_price_per_m2:
        maximum !== null
          ? roundNumber(maximum, 2)
          : null,

      min_value:
        minimum !== null
          ? roundMoney(minimum * size)
          : null,

      max_value:
        maximum !== null
          ? roundMoney(maximum * size)
          : null,
    },
  };
}

function calculateValuation(snapshot, size) {
  const totals =
    calculateMarketTotals(
      snapshot,
      size
    );

  if (!totals) {
    return null;
  }

  return {
    ...totals,

    api_contract:
      API_CONTRACT,

    source_table:
      SNAPSHOT_TABLE,

    version:
      WORKER_VERSION,

    area_found:
      snapshot.area_found,

    area_id:
      snapshot.area_id,

    area_scope:
      snapshot.area_scope,

    property_type:
      snapshot.property_type,

    transaction:
      snapshot.transaction,

    rent_condition:
      snapshot.rent_condition,

    requested_rent_condition:
      snapshot.requested_rent_condition,

    condition_scope:
      snapshot.condition_scope,

    price_basis:
      snapshot.price_basis,

    confidence:
      snapshot.confidence || "unknown",

    sample_count:
      snapshot.sample_count,

    period:
      snapshot.period,

    calculated_at:
      snapshot.calculated_at,

    updated_at:
      snapshot.updated_at,

    snapshot_id:
      snapshot.snapshot_id,

    source_id:
      snapshot.source_id,

    source_name:
      snapshot.source_name,

    source_url:
      snapshot.source_url,

    source_verified:
      snapshot.source_verified,

    price_verified:
      snapshot.price_verified,

    data_source:
      snapshot.data_source,

    notes:
      snapshot.snapshot_notes,

    disclaimer:
      "هذا مؤشر استرشادي مبني على أسعار الطلب المتاحة في عينة السوق، وليس إثباتًا لسعر إتمام البيع أو الإيجار. القيمة المركزية محسوبة من الوسيط، والنطاق الأساسي من P25 إلى P75. حدود Min/Max تمثل الحدود المرصودة في العينة وليست نطاقًا أساسيًا للسوق.",
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// Errors
// ═══════════════════════════════════════════════════════════════════════════

function errorForSnapshot(result) {
  if (
    result.reason === "area_not_found"
  ) {
    return {
      status: 400,
      body: {
        code: "AREA_NOT_FOUND",
        error:
          "المنطقة غير معروفة في بيانات السوق الحالية. اختر اسم المنطقة كما يظهر في القائمة.",
        available_areas:
          result.available_areas || [],
      },
    };
  }

  if (
    result.reason === "unsupported_type"
  ) {
    return {
      status: 422,
      body: {
        code:
          "UNSUPPORTED_PROPERTY_TYPE",
        error:
          "نوع العقار أو العملية غير مدعوم في بيانات السوق الحالية، ولن نستخدم نوعًا آخر كبديل.",
      },
    };
  }

  if (
    result.reason === "market_unavailable"
  ) {
    return {
      status: 503,
      body: {
        code:
          "MARKET_UNAVAILABLE",
        error:
          "لا توجد لقطة سوقية صالحة مطابقة للطلب حاليًا.",
      },
    };
  }

  return {
    status: 422,
    body: {
      code:
        "INSUFFICIENT_MARKET_DATA",
      error:
        "لا توجد بيانات سوقية كافية تطابق المنطقة ونوع العقار والعملية وحالة التأثيث عند انطباقها؛ لن نخمن رقمًا.",
    },
  };
}

function marketUnavailableResponse(cors) {
  return jsonResponse(
    cors,
    {
      service:
        SERVICE_NAME,

      status:
        "unavailable",

      version:
        WORKER_VERSION,

      api_contract:
        API_CONTRACT,

      error:
        "تعذر الوصول إلى بيانات السوق حاليًا.",

      available_areas: [],
    },
    503
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// Request validation
// ═══════════════════════════════════════════════════════════════════════════

function parsePayload(payload) {
  const area =
    safeString(
      payload?.area
    ).slice(0, 100);

  const areaType =
    normalizeTransaction(
      payload?.areaType ??
      payload?.transaction
    );

  const requestedType =
    safeString(
      payload?.propertyType
    ).slice(0, 80);

  const propertyType =
    normalizePropertyType(
      requestedType
    );

  const size =
    parseAreaSize(
      payload?.size
    );

  const rentCondition =
    payload?.rentCondition ??
    payload?.furnished;

  return {
    area,
    areaType,
    requestedType,
    propertyType,
    size,
    rentCondition,
  };
}

function validatePayload(input) {
  if (!input.area) {
    return {
      code: "AREA_REQUIRED",
      error: "اختر المنطقة أولًا.",
      status: 400,
    };
  }

  if (!input.areaType) {
    return {
      code:
        "TRANSACTION_REQUIRED",
      error:
        "اختر نوع العملية (بيع أو إيجار).",
      status: 400,
    };
  }

  if (!input.requestedType) {
    return {
      code:
        "PROPERTY_TYPE_REQUIRED",
      error:
        "اختر نوع العقار أولًا.",
      status: 400,
    };
  }

  if (!input.propertyType) {
    return {
      code:
        "UNSUPPORTED_PROPERTY_TYPE",
      error:
        "نوع العقار غير مدعوم في بيانات السوق الحالية.",
      status: 422,
    };
  }

  if (
    !Number.isFinite(input.size) ||
    input.size < 20 ||
    input.size > 100000
  ) {
    return {
      code:
        "INVALID_AREA_SIZE",
      error:
        "المساحة غير صالحة. يجب أن تكون بين 20 و100000 م².",
      status: 400,
    };
  }

  if (
    input.areaType === "rent" &&
    input.rentCondition !== undefined &&
    input.rentCondition !== null &&
    input.rentCondition !== ""
  ) {
    const condition =
      normalizeRentCondition(
        input.rentCondition
      );

    if (!condition) {
      return {
        code:
          "INVALID_RENT_CONDITION",
        error:
          "حالة التأثيث غير معروفة.",
        status: 400,
      };
    }
  }

  return null;
}

// ═══════════════════════════════════════════════════════════════════════════
// Main API
// ═══════════════════════════════════════════════════════════════════════════

export default {
  async fetch(request, env) {
    const cors =
      corsHeaders(
        request,
        env
      );

    // ─────────────────────────────────────────────────────────────────────
    // CORS preflight
    // ─────────────────────────────────────────────────────────────────────

    if (
      request.method ===
      "OPTIONS"
    ) {
      return new Response(
        null,
        {
          status: 204,
          headers: cors,
        }
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // GET
    //
    // Used for health check + available areas.
    // ─────────────────────────────────────────────────────────────────────

    if (
      request.method ===
      "GET"
    ) {
      try {
        const areas =
          await loadAreas(
            env?.DB
          );

        const availableAreas =
          listAreaNames(
            areas
          );

        return jsonResponse(
          cors,
          {
            service:
              SERVICE_NAME,

            status:
              "running",

            version:
              WORKER_VERSION,

            api_contract:
              API_CONTRACT,

            source_table:
              SNAPSHOT_TABLE,

            data_source:
              "price_snapshots",

            areas:
              availableAreas.length,

            available_areas:
              availableAreas,

            valuation_method: {
              central_indicator:
                "median_price_m2",

              core_range:
                "p25_price_m2_to_p75_price_m2",

              observed_bounds:
                "min_price_m2_to_max_price_m2",

              confidence: {
                high:
                  "sample_count >= 30",

                medium:
                  "sample_count >= 10 and sample_count < 30",

                low:
                  "sample_count < 10",
              },

              price_type:
                "asking_prices",
            },

            sources: [
              {
                id: 9,
                name:
                  SOURCE_NAMES[9],
                role:
                  "market_source",
              },
              {
                id: 8,
                name:
                  SOURCE_NAMES[8],
                role:
                  "market_source",
              },
            ],
          }
        );
      } catch {
        return marketUnavailableResponse(
          cors
        );
      }
    }

    // ─────────────────────────────────────────────────────────────────────
    // Only GET / POST are supported.
    // ─────────────────────────────────────────────────────────────────────

    if (
      request.method !==
      "POST"
    ) {
      return jsonResponse(
        cors,
        {
          code:
            "METHOD_NOT_ALLOWED",
          error:
            "Method not allowed",
        },
        405
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Request size protection
    // ─────────────────────────────────────────────────────────────────────

    const declaredLength =
      Number(
        request.headers.get(
          "Content-Length"
        ) || 0
      );

    if (
      declaredLength >
      MAX_REQUEST_BYTES
    ) {
      return jsonResponse(
        cors,
        {
          code:
            "REQUEST_TOO_LARGE",
          error:
            "حجم الطلب أكبر من المسموح.",
        },
        413
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // JSON body
    // ─────────────────────────────────────────────────────────────────────

    let payload;

    try {
      payload =
        await request.json();
    } catch {
      return jsonResponse(
        cors,
        {
          code:
            "INVALID_JSON",
          error:
            "طلب غير صالح (JSON).",
        },
        400
      );
    }

    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload)
    ) {
      return jsonResponse(
        cors,
        {
          code:
            "INVALID_PAYLOAD",
          error:
            "بيانات الطلب غير صالحة.",
        },
        400
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Normalize request
    // ─────────────────────────────────────────────────────────────────────

    const input =
      parsePayload(
        payload
      );

    const validationError =
      validatePayload(
        input
      );

    if (validationError) {
      return jsonResponse(
        cors,
        {
          code:
            validationError.code,

          error:
            validationError.error,
        },
        validationError.status
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Read market snapshot
    // ─────────────────────────────────────────────────────────────────────

    const snapshot =
      await getMarketSnapshot(
        env?.DB,
        {
          area:
            input.area,

          areaType:
            input.areaType,

          transaction:
            input.areaType,

          propertyType:
            input.propertyType,

          rentCondition:
            input.rentCondition,

          furnished:
            typeof payload?.furnished ===
            "boolean"
              ? payload.furnished
              : undefined,
        }
      );

    if (!snapshot.ok) {
      const failure =
        errorForSnapshot(
          snapshot
        );

      return jsonResponse(
        cors,
        failure.body,
        failure.status
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Calculate valuation
    // ─────────────────────────────────────────────────────────────────────

    const result =
      calculateValuation(
        snapshot,
        input.size
      );

    if (!result) {
      return jsonResponse(
        cors,
        {
          code:
            "INSUFFICIENT_MARKET_DATA",

          error:
            "لا توجد بيانات سوقية كافية لإتمام التقييم.",
        },
        422
      );
    }

    // ─────────────────────────────────────────────────────────────────────
    // Final response
    // ─────────────────────────────────────────────────────────────────────

    return jsonResponse(
      cors,
      {
        service:
          SERVICE_NAME,

        status:
          "success",

        ...result,
      }
    );
  },
};
