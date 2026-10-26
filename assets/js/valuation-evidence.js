/* Evidence, not a professional appraisal. Pure policy reused by result/share/handoff. */
(function (root) {
  'use strict';
  function scopeKey(v) {
    // «مدينة نصر (ككل)» and «مدينة نصر» are the same scope; text after «(» is a qualifier.
    return String(v || '').split('(')[0].replace(/[\u064B-\u0652\u0640]/g, '').replace(/[أإآ]/g, 'ا')
      .replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/\s+/g, ' ').trim();
  }
  function evidence(data, inputs, now) {
    var actual = String(data.area_found || '').trim();
    var requested = String(data.requested_area || inputs.area || '').trim();
    var fallback = data.fallback_used === true || !actual || scopeKey(actual) !== scopeKey(requested);
    var stamp = String(data.calculated_at || data.updated_at || '').trim();
    var at = stamp ? Date.parse(stamp) : NaN;
    var age = (Number(now == null ? Date.now() : now) - at) / 86400000;
    var stale = !Number.isFinite(age) || age < 0 || age > 90;
    var count = data.sample_count == null || data.sample_count === '' ? null : Number(data.sample_count);
    if (!Number.isFinite(count) || count < 0 || !Number.isInteger(count)) count = null;
    var limited = fallback || stale || count == null || count < 5;
    var confidence = limited ? (['high', 'medium', 'low'].includes(data.confidence) ? 'low' : 'unknown') : ['high', 'medium', 'low'].includes(data.confidence) ? data.confidence : 'unknown';
    var reasons = [];
    if (fallback) reasons.push('النطاق الفعلي ' + (actual || 'غير موثق') + '، وليس عينة مستقلة مؤكدة لـ«' + requested + '»');
    if (stale) reasons.push('تاريخ اللقطة غير حديث أو غير موثق');
    if (count == null || count < 5) reasons.push('العينة قليلة أو عددها غير موثق');
    var note = String(data.notes || data.snapshot_notes || '').trim();
    // A seeded/test note is not evidence describing a larger real sample.
    if (/اختبار|تجريب|snapshot\s*(?:واحد|1)/i.test(note)) note = 'ملاحظة داخلية غير معتمدة لوصف العينة؛ اعتمد العدد والتاريخ والنطاق المعلنين.';
    return { actual: actual || 'نطاق غير موثق', requested: requested, fallback: fallback, stale: stale, count: count, timestamp: stamp || null, confidence: confidence, limited: limited, reasons: reasons, note: note };
  }
  root.NasrValuationEvidence = { assess: evidence };
})(typeof globalThis !== 'undefined' ? globalThis : this);
