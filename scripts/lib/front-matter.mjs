/**
 * ═══════════════════════════════════════════════════════════════
 *  scripts/lib/front-matter.mjs
 *  قارئ front matter مستقل تمامًا (بلا أي حزمة خارجية)
 * ───────────────────────────────────────────────────────────────
 *  لماذا لا نعتمد على gray-matter أو js-yaml هنا:
 *    خطوة التوليد تعمل داخل .github/workflows/deploy.yml على GitHub
 *    Actions. `package-lock.json` مستثنى من Git في هذا المستودع، ولذلك
 *    `npm ci` يفشل، و`npm install` في مسار النشر يضيف نقطة فشل ومدة
 *    انتظار مقابل شيء واحد فقط: قراءة YAML بسيط.
 *    هذا الملف يقرأ **الشكل الفعلي** المستخدم في _properties و_requests
 *    ويُغطّى باختبار تكافؤ يقارن مخرجاته بـ gray-matter على كل الملفات.
 *
 *  المدعوم (وهو كل ما يوجد فعليًا في المستودع — تم التحقق بالمسح):
 *    • محددات `---` في أول سطر وآخر سطر للـ front matter
 *    • `key: value` — القيم: نص عادي، أو نص بين "..." أو '...'
 *    • أسطر التعليقات التي تبدأ بـ #، والأسطر الفارغة
 *    • قوائم `[a, b]` البسيطة على سطر واحد
 *    • القوائم الكتلية (سطر `key:` ثم أسطر `- عنصر`) — تُستخدم في متطلبات الطلبات
 *    • booleans و null وأرقام (تُحوَّل لأنواعها)
 *
 *  غير المدعوم عن قصد (لا يوجد في المستودع): الكتل المتعددة `|` و`>`
 *  والكائنات المتداخلة والمراسي والعلامات. لو ظهر أي منها لاحقًا،
 *  الاختبار يُسقط البناء ولا يمر خطأ صامت.
 * ═══════════════════════════════════════════════════════════════
 */

const NUMBER_RE = /^-?\d+(\.\d+)?$/;

function unquote(value) {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if (first === '"' && last === '"') return v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    if (first === "'" && last === "'") return v.slice(1, -1).replace(/''/g, "'");
  }
  return v;
}

function coerce(raw) {
  const v = raw.trim();
  if (v === '') return null;
  if (v.startsWith('"') || v.startsWith("'")) return unquote(v);
  if (v === 'true' || v === 'True') return true;
  if (v === 'false' || v === 'False') return false;
  if (v === 'null' || v === '~') return null;
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (inner === '') return [];
    return inner.split(',').map((part) => coerce(part.trim()));
  }
  if (NUMBER_RE.test(v)) return Number(v);
  return v;
}

/** إزالة تعليق في نهاية السطر — فقط حين يكون خارج علامات التنصيص */
function stripTrailingComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '\\' && inDouble) { i += 1; continue; }
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '#' && !inSingle && !inDouble) {
      // تعليق حقيقي = # في بداية السطر أو مسبوقة بمسافة
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

/**
 * يقسّم مستندًا إلى front matter + المحتوى.
 * @param {string} raw
 * @returns {{ data: Record<string, unknown>, content: string, matter: string, hasFrontMatter: boolean }}
 */
export function parseFrontMatter(raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '');
  const lines = text.split('\n');
  const empty = { data: {}, content: text, matter: '', hasFrontMatter: false };

  if (lines.length < 2 || lines[0].trim() !== '---') return empty;

  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '---' || t === '...') { end = i; break; }
  }
  if (end === -1) return empty;

  const matter = lines.slice(1, end).join('\n');
  const content = lines.slice(end + 1).join('\n');
  const data = {};

  // مفتاح قد تكون قيمته قائمة كتلية (`key:` ثم أسطر `- عنصر`) — نتبعه حتى
  // نعرف أين نضيف العناصر. أي مفتاح بقيمة على نفس السطر يُنهي التتبّع.
  let listKey = null;

  for (const rawLine of matter.split('\n')) {
    if (rawLine.trim() === '') continue;
    if (rawLine.trimStart().startsWith('#')) continue;
    if (/^\s/.test(rawLine)) {
      const item = rawLine.trim().match(/^-(?:\s+(.*))?$/);
      if (listKey && item) {
        if (!Array.isArray(data[listKey])) data[listKey] = [];
        data[listKey].push(coerce(stripTrailingComment(item[1] ?? '')));
      }
      // سطر متابعة آخر (كتلة نصية/كائن متداخل) — غير موجود في المستودع
      continue;
    }
    const m = rawLine.match(/^([A-Za-z_][A-Za-z0-9_-]*):(.*)$/);
    if (!m) continue;
    const valueRaw = stripTrailingComment(m[2]);
    if (valueRaw.trim() === '') {
      data[m[1]] = null;
      listKey = m[1];
    } else {
      data[m[1]] = coerce(valueRaw);
      listKey = null;
    }
  }

  return { data, content, matter, hasFrontMatter: true };
}

export default parseFrontMatter;
