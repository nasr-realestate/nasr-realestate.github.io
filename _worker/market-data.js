// Shared, read-only access to the market snapshots in Cloudflare D1.
// Listings are intentionally not read here; the agent keeps using ai-feed.json.

const SNAPSHOT_TABLE = "price_snapshots";
const AREA_TABLE = "areas";
const MAX_ROWS = 1000;

const AREA_NAME_COLUMNS = [
  "name_ar", "area_name_ar", "name", "area_name", "label_ar", "label", "title_ar", "title",
];
const AREA_ID_COLUMNS = ["id", "area_id", "uuid", "slug"];
const SNAPSHOT_AREA_COLUMNS = [
  "area_name_ar", "area_name", "district_name", "neighborhood_name", "zone_name",
  "area", "district", "neighborhood", "zone", "location", "area_id", "district_id", "zone_id",
];
const PROPERTY_TYPE_COLUMNS = [
  "property_type", "property_type_ar", "asset_type", "unit_type", "property_category", "category",
];
const TRANSACTION_COLUMNS = [
  "transaction_type", "transaction", "listing_type", "market_type", "operation", "purpose",
];
const RENT_CONDITION_COLUMNS = [
  "rent_condition", "rental_condition", "furnishing", "furnished_status", "furnished", "condition",
];
const SAMPLE_COUNT_COLUMNS = ["sample_count", "samples_count", "sample_size", "samples", "observations", "n"];
const SOURCE_COLUMNS = ["data_source", "source_name", "source"];
const PERIOD_COLUMNS = ["period", "period_label", "snapshot_period", "data_period"];
const PERIOD_START_COLUMNS = ["period_start", "start_date", "date_from"];
const PERIOD_END_COLUMNS = ["period_end", "end_date", "date_to"];
const UPDATED_COLUMNS = ["updated_at", "snapshot_date", "captured_at", "created_at"];
const CONFIDENCE_COLUMNS = ["confidence", "confidence_level"];

// These are explicit equivalences only. In particular, "المنطقة الأولى"
// is deliberately not an alias for "الحي الأول".
const AREA_ALIAS_GROUPS = [
  ["حي السفارات", "الحي الدبلوماسي"],
  ["ممر مكرم عبيد", "مكرم عبيد", "شارع مكرم عبيد"],
  ["ممر عباس العقاد", "عباس العقاد", "شارع عباس العقاد"],
  ["رابعة العدوية", "رابعة", "الرابعة العدوية"],
  ["الواحة", "حي الواحة"],
];

const AR_DIGITS = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
};

export function normalizeArabic(value) {
  return String(value ?? "")
    .replace(/[٠-٩]/g, digit => AR_DIGITS[digit])
    .replace(/[أإآٱ]/g, "ا")
    .replace(/ة/g, "ه")
    .replace(/ى/g, "ي")
    .replace(/[ًٌٍَُِّْـ]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .toLowerCase();
}

function compactArea(value) {
  return normalizeArabic(value).replace(/\s+/g, "");
}

function areaAliasKey(value) {
  const key = compactArea(value);
  for (const group of AREA_ALIAS_GROUPS) {
    if (group.some(alias => compactArea(alias) === key)) return compactArea(group[0]);
  }
  return key;
}

export function areasEquivalent(left, right) {
  return !!compactArea(left) && areaAliasKey(left) === areaAliasKey(right);
}

export function findAreaName(names, value) {
  const list = (Array.isArray(names) ? names : [])
    .map(name => String(name ?? "").trim())
    .filter(Boolean);
  const target = compactArea(value);
  if (!target) return null;

  const exact = list.find(name => compactArea(name) === target);
  if (exact) return exact;

  const aliasKey = areaAliasKey(value);
  return list.find(name => areaAliasKey(name) === aliasKey) || null;
}

export function findAreaMention(text, names) {
  const haystack = ` ${normalizeArabic(text)} `;
  const candidates = (Array.isArray(names) ? names : [])
    .map(name => String(name ?? "").trim())
    .filter(Boolean)
    .sort((left, right) => normalizeArabic(right).length - normalizeArabic(left).length);

  for (const name of candidates) {
    const needle = ` ${normalizeArabic(name)} `;
    if (needle.trim() && haystack.includes(needle)) return name;
  }

  for (const group of AREA_ALIAS_GROUPS) {
    const alias = group
      .filter(item => normalizeArabic(item).length >= 5)
      .sort((left, right) => normalizeArabic(right).length - normalizeArabic(left).length)
      .find(item => ` ${normalizeArabic(text)} `.includes(` ${normalizeArabic(item)} `));
    if (!alias) continue;
    const match = candidates.find(name => group.some(item => compactArea(item) === compactArea(name)));
    if (match) return match;
  }
  return null;
}

export function normalizePropertyType(value) {
  const text = normalizeArabic(value).replace(/\s+/g, "");
  if (!text) return null;
  if (text.includes("دوبلكس") || text.includes("duplex")) return "duplex";
  if (text.includes("شقه") || text.includes("شقتي") || text.includes("شقتنا") || text.includes("شقق") || text.includes("apartment") || text.includes("flat")) return "apartment";
  if (text.includes("فيلا") || text.includes("villa")) return "villa";
  if (text.includes("روف") || text.includes("roof") || text.includes("penthouse")) return "roof";
  if (text.includes("محل") || text.includes("shop") || text.includes("retail")) return "shop";
  if (text.includes("مكتب") || text.includes("office")) return "office";
  if (text.includes("مخزن") || text.includes("مستودع") || text.includes("warehouse") || text.includes("storage")) return "warehouse";
  return null;
}

export function normalizeTransaction(value) {
  const text = normalizeArabic(value).replace(/\s+/g, "");
  if (!text) return null;
  if (text.includes("بيع") || text.includes("sale") || text.includes("sell") || text.includes("تمليك")) return "sale";
  if (text.includes("ايجار") || text.includes("اجار") || text.includes("rent") || text.includes("lease") || text.includes("تاجير")) return "rent";
  return null;
}

export function normalizeRentCondition(value) {
  if (value === true || value === 1) return "furnished";
  if (value === false || value === 0) return "unfurnished";
  const text = normalizeArabic(value).replace(/\s+/g, "");
  if (!text) return null;
  if (["furnished", "furn", "مفروش", "مؤثث", "نعم", "yes", "true", "1"].includes(text)) return "furnished";
  if (["unfurnished", "empty", "غيرمفروش", "فاضي", "بدونفرش", "لا", "no", "false", "0"].includes(text)) return "unfurnished";
  if (["unknown", "unspecified", "غيرمحدد", "غيرمعروف", "مجهول", "unknowncondition"].includes(text)) return "unknown";
  return null;
}

function lowerColumnMap(columns) {
  return new Map((columns || []).map(name => [String(name).toLowerCase(), String(name)]));
}

function findColumn(columns, candidates) {
  const map = lowerColumnMap(columns);
  for (const candidate of candidates) {
    const found = map.get(candidate.toLowerCase());
    if (found) return found;
  }
  return null;
}

function valueFor(row, column) {
  if (!row || !column) return null;
  return row[column] ?? null;
}

function firstValue(row, columns, candidates) {
  const column = findColumn(columns, candidates);
  return column ? valueFor(row, column) : null;
}

function allRows(result) {
  if (Array.isArray(result)) return result;
  return Array.isArray(result?.results) ? result.results : [];
}

async function tableColumns(db, tableName) {
  try {
    const result = await db.prepare(`PRAGMA table_info('${tableName}')`).all();
    return allRows(result).map(column => String(column.name || "")).filter(Boolean);
  } catch {
    return [];
  }
}

async function tableRows(db, tableName) {
  const result = await db.prepare(`SELECT * FROM "${tableName}" LIMIT ${MAX_ROWS}`).all();
  return allRows(result);
}

function makeAreaRecords(rows, columns) {
  const nameColumn = findColumn(columns, AREA_NAME_COLUMNS);
  const idColumn = findColumn(columns, AREA_ID_COLUMNS);
  if (!nameColumn) return [];
  return rows
    .map(row => ({
      name: String(valueFor(row, nameColumn) ?? "").trim(),
      id: idColumn ? valueFor(row, idColumn) : null,
    }))
    .filter(area => area.name);
}

function areaNameForSnapshot(row, columns, areas, areaIdColumn) {
  const directValue = firstValue(row, columns, SNAPSHOT_AREA_COLUMNS);
  if (directValue !== null && directValue !== undefined && String(directValue).trim()) {
    const directText = String(directValue).trim();
    const byId = areas.find(area => area.id !== null && String(area.id) === directText);
    if (byId) return byId.name;
    const byName = findAreaName(areas.map(area => area.name), directText);
    return byName || directText;
  }

  if (areaIdColumn) {
    const id = valueFor(row, areaIdColumn);
    const linked = areas.find(area => area.id !== null && String(area.id) === String(id));
    if (linked) return linked.name;
  }
  return null;
}

function distinctSnapshotAreaNames(rows, columns, areas) {
  const areaColumn = findColumn(columns, SNAPSHOT_AREA_COLUMNS);
  const areaIdColumn = findColumn(columns, ["area_id", "district_id", "zone_id"]);
  const names = [];
  for (const row of rows) {
    const name = areaNameForSnapshot(row, columns, areas, areaColumn || areaIdColumn);
    if (name && !names.some(existing => compactArea(existing) === compactArea(name))) names.push(name);
  }
  return names;
}

async function loadMarketRows(db) {
  if (!db || typeof db.prepare !== "function") throw new Error("Market data is unavailable");

  const [snapshotColumns, areaColumns] = await Promise.all([
    tableColumns(db, SNAPSHOT_TABLE),
    tableColumns(db, AREA_TABLE),
  ]);
  if (!snapshotColumns.length) throw new Error("Market snapshot schema is unavailable");

  const [snapshotRows, rawAreaRows] = await Promise.all([
    tableRows(db, SNAPSHOT_TABLE),
    areaColumns.length ? tableRows(db, AREA_TABLE).catch(() => []) : Promise.resolve([]),
  ]);
  const areas = makeAreaRecords(rawAreaRows, areaColumns);

  return {
    snapshotColumns,
    snapshotRows,
    areas,
    availableAreas: areas.length
      ? areas.map(area => area.name)
      : distinctSnapshotAreaNames(snapshotRows, snapshotColumns, areas),
  };
}

function numericValue(value) {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (value === null || value === undefined || value === "") return null;
  const normalized = String(value)
    .replace(/[٠-٩]/g, digit => AR_DIGITS[digit])
    .replace(/[٬,\s]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function classifySnapshot(row, columns) {
  const typeValue = firstValue(row, columns, PROPERTY_TYPE_COLUMNS);
  const transactionValue = firstValue(row, columns, TRANSACTION_COLUMNS);
  const combined = [typeValue, transactionValue].filter(value => value !== null && value !== undefined).join(" ");
  return {
    propertyType: normalizePropertyType(typeValue) || normalizePropertyType(combined),
    transaction: normalizeTransaction(transactionValue) || normalizeTransaction(combined),
  };
}

function snapshotCondition(row, columns) {
  const conditionColumn = findColumn(columns, RENT_CONDITION_COLUMNS);
  return (conditionColumn ? normalizeRentCondition(valueFor(row, conditionColumn)) : null) || "unknown";
}

function snapshotSortValue(row, columns) {
  const dated = firstValue(row, columns, [
    ...PERIOD_END_COLUMNS, ...UPDATED_COLUMNS, ...PERIOD_COLUMNS, ...PERIOD_START_COLUMNS,
  ]);
  if (dated !== null && dated !== undefined && String(dated).trim()) return String(dated);
  const id = firstValue(row, columns, ["id", "snapshot_id"]);
  return id === null || id === undefined ? "" : String(id).padStart(20, "0");
}

function confidenceFrom(row, columns, sampleCount) {
  const stored = normalizeArabic(firstValue(row, columns, CONFIDENCE_COLUMNS) ?? "").replace(/\s+/g, "");
  if (["high", "عالي", "عالية", "مرتفع", "مرتفعة"].includes(stored)) return "high";
  if (["medium", "متوسط", "متوسطة"].includes(stored)) return "medium";
  if (["low", "منخفض", "منخفضة", "ضعيف", "ضعيفة"].includes(stored)) return "low";

  if (sampleCount === null || sampleCount <= 0) return "unknown";
  if (sampleCount >= 10) return "high";
  if (sampleCount >= 5) return "medium";
  return "low";
}

function cleanPublicText(value, fallback = "") {
  const text = String(value ?? "").replace(/[\u0000-\u001F\u007F]/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 160) : fallback;
}

function snapshotPeriod(row, columns) {
  const direct = firstValue(row, columns, PERIOD_COLUMNS);
  if (direct !== null && direct !== undefined && String(direct).trim()) {
    return cleanPublicText(direct);
  }
  const start = firstValue(row, columns, PERIOD_START_COLUMNS);
  const end = firstValue(row, columns, PERIOD_END_COLUMNS);
  if (start && end) return `${cleanPublicText(start)} – ${cleanPublicText(end)}`;
  if (start || end) return cleanPublicText(start || end);
  return null;
}

export async function listMarketAreas(db) {
  const data = await loadMarketRows(db);
  return data.availableAreas;
}

function roundMarketAmount(amount) {
  return Math.round(amount);
}

export function calculateMarketTotals(snapshot, size) {
  if (!snapshot?.ok || !Number.isFinite(size) || size < 20) return null;
  const minimum = snapshot.min_price_m2;
  const maximum = snapshot.max_price_m2;
  const hasRange = Number.isFinite(minimum) && minimum > 0 && Number.isFinite(maximum) && maximum >= minimum;
  return {
    estimate: roundMarketAmount(snapshot.price_per_meter * size),
    range: {
      low: hasRange ? roundMarketAmount(minimum * size) : null,
      high: hasRange ? roundMarketAmount(maximum * size) : null,
    },
    price_per_meter: snapshot.price_per_meter,
    price_per_m2_range: {
      low: hasRange ? minimum : null,
      high: hasRange ? maximum : null,
    },
  };
}

export async function getMarketSnapshot(db, query = {}) {
  let data;
  try {
    data = await loadMarketRows(db);
  } catch {
    return { ok: false, reason: "market_unavailable" };
  }

  const area = findAreaName(data.availableAreas, query.area);
  if (!area) return { ok: false, reason: "area_not_found", available_areas: data.availableAreas };

  const propertyType = normalizePropertyType(query.propertyType);
  const transaction = normalizeTransaction(query.areaType ?? query.transaction);
  if (!propertyType || !transaction) {
    return { ok: false, reason: "unsupported_type", area_found: area, available_areas: data.availableAreas };
  }

  // The normalized type and operation must match the same snapshot row exactly.
  // Never substitute apartment data for villa/roof/shop/office/warehouse or duplex rent.
  const rentCondition = transaction === "rent"
    ? normalizeRentCondition(query.rentCondition ?? query.furnished) || "unknown"
    : null;

  const areaColumn = findColumn(data.snapshotColumns, SNAPSHOT_AREA_COLUMNS);
  const areaIdColumn = findColumn(data.snapshotColumns, ["area_id", "district_id", "zone_id"]);
  const matches = data.snapshotRows.filter(row => {
    const rowArea = areaNameForSnapshot(row, data.snapshotColumns, data.areas, areaColumn || areaIdColumn);
    if (!rowArea || !areasEquivalent(rowArea, area)) return false;
    const category = classifySnapshot(row, data.snapshotColumns);
    if (category.propertyType !== propertyType || category.transaction !== transaction) return false;
    if (transaction === "rent" && snapshotCondition(row, data.snapshotColumns) !== rentCondition) return false;
    return true;
  });

  matches.sort((left, right) => snapshotSortValue(right, data.snapshotColumns).localeCompare(snapshotSortValue(left, data.snapshotColumns)));
  const row = matches[0];
  if (!row) return { ok: false, reason: "insufficient_data", area_found: area, property_type: propertyType, transaction, rent_condition: rentCondition };

  const avgColumn = findColumn(data.snapshotColumns, ["avg_price_m2"]);
  const medianColumn = findColumn(data.snapshotColumns, ["median_price_m2"]);
  const avg = numericValue(valueFor(row, avgColumn));
  const median = numericValue(valueFor(row, medianColumn));
  const pricePerMeter = avg > 0 ? avg : (median > 0 ? median : null);
  if (!pricePerMeter) {
    return { ok: false, reason: "insufficient_data", area_found: area, property_type: propertyType, transaction, rent_condition: rentCondition };
  }

  const sampleCount = numericValue(firstValue(row, data.snapshotColumns, SAMPLE_COUNT_COLUMNS));
  if (sampleCount !== null && sampleCount <= 0) {
    return { ok: false, reason: "insufficient_data", area_found: area, property_type: propertyType, transaction, rent_condition: rentCondition };
  }

  const minimum = numericValue(firstValue(row, data.snapshotColumns, ["min_price_m2"]));
  const maximum = numericValue(firstValue(row, data.snapshotColumns, ["max_price_m2"]));
  const source = cleanPublicText(firstValue(row, data.snapshotColumns, SOURCE_COLUMNS), SNAPSHOT_TABLE);
  const updatedAt = firstValue(row, data.snapshotColumns, UPDATED_COLUMNS);

  return {
    ok: true,
    area_found: area,
    property_type: propertyType,
    transaction,
    rent_condition: rentCondition,
    price_per_meter: pricePerMeter,
    price_basis: avg > 0 ? "avg_price_m2" : "median_price_m2",
    min_price_m2: minimum,
    max_price_m2: maximum,
    sample_count: sampleCount,
    confidence: confidenceFrom(row, data.snapshotColumns, sampleCount),
    data_source: source,
    period: snapshotPeriod(row, data.snapshotColumns),
    updated_at: updatedAt === null || updatedAt === undefined ? null : cleanPublicText(updatedAt),
  };
}
