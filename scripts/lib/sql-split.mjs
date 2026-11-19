/**
 * scripts/lib/sql-split.mjs
 * تقسيم ملف SQL إلى جمل منفصلة — للـworkflow الذي ينفّذ مسوّدة على D1.
 *
 * العيب الذي وُلد منه (مقيس، run 44204766837): التقسيم كان بـ
 *   awk 'BEGIN{RS=";"}'
 * وهو يكسر عند كل ';' حتى داخل جملة متعددة الأسطر. النتيجة: كل INSERT
 * انقسم إلى ثلاثة أجزاء (INSERT… / SELECT… / WHERE…) — 13 جملة بدل 4،
 * وتنفيذها منفصلة كان سيولّد SQL مكسورًا على قاعدة الإنتاج.
 *
 * القاعدة الصحيحة: الجملة تنتهي عند ';' في آخر السطر فقط.
 */
// يقسّم ملف SQL إلى جمل عند ';' في نهاية السطر، مع تجاهل التعليقات.
// الأوامر متعددة الأسطر (INSERT ... SELECT ... WHERE) تبقى جملة واحدة.
export function splitStatements(sql) {
  const out = [];
  let buf = [];
  for (const raw of sql.split('\n')) {
    // trimEnd بدل /\s+$/ — الأخير يُلام على super-linear backtracking
    const line = raw.trimEnd();
    if (line.trimStart().startsWith('--')) continue;
    if (!line.trim()) continue;
    buf.push(line);
    if (line.endsWith(';')) {
      const stmt = buf.join('\n').replace(/;$/, '').trim();
      if (stmt) out.push(stmt);
      buf = [];
    }
  }
  if (buf.length) {
    const stmt = buf.join('\n').trim();
    if (stmt) out.push(stmt);
  }
  return out;
}
