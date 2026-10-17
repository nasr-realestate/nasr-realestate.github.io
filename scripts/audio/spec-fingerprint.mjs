/**
 * ═══════════════════════════════════════════════════════════════════
 *  scripts/audio/spec-fingerprint.mjs — بصمة إعدادات الصوت
 * ───────────────────────────────────────────────────────────────────
 *  وحدة مشتركة يستوردها:
 *    • scripts/audio/verify-voice-identity.mjs  (بوابة CI)
 *    • scripts/tests/voice-identity.test.mjs    (الاختبارات)
 *  الغرض: مصدر واحد لحساب البصمة، فلا تختلف بوابة عن اختبار.
 *
 *  البصمة تغطي الأقسام التي لو تغيّرت صمتًا لتغيّر صوت الإعلانات:
 *    encoding · id3 · engine (عدا حقل consequence النصي التفسيري)
 *  ولا تغطي أقسام التوثيق (reference/language/script/identityBand/governance)
 *  حتى لا يسقط CI عند إضافة معلومة توضيحية.
 * ═══════════════════════════════════════════════════════════════════
 */
import crypto from 'node:crypto';

/** تسلسل قياسي: ترتيب مفاتيخ ثابت + JSON مضغوط + بلا تبعية لترتيب الإدخال. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** أقسام المواصفة المشمولة بالبصمة. */
export function fingerprintPayload(spec) {
  return {
    encoding: spec.encoding,
    id3: spec.id3,
    engine: Object.fromEntries(Object.entries(spec.engine || {}).filter(([k]) => k !== 'consequence')),
  };
}

/** بصمة SHA-256 لإعدادات الصوت في المواصفة المركزية. */
export function specFingerprint(spec) {
  return crypto.createHash('sha256').update(canonical(fingerprintPayload(spec))).digest('hex');
}
