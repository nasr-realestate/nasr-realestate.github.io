// Pure Arabic WhatsApp link & professional message templates for Tarek Tantawy (سمسار طلبك).

const PUBLIC_SITE_ORIGIN = 'https://nasr-realestate.github.io';

const TRACK_DEFAULT_PROP = {
  sale_apt: 'الشقة',
  furnished_apt: 'الشقة المفروشة',
  new_rent_apt: 'الشقة',
  admin_hq: 'الوحدة الإدارية/التجارية',
  transient: 'العقار المطلوب',
};

const GENERIC_CLIENT_STARTS_RE = /^(?:باحث|مطلوب|يشتري|يدير|نعم(?:\s|$)|أكثر|اكثر|شقة|شقه|محل|مقر|عميل|سؤال|بدون|عقار)/u;

const SALUTATION_STOP_WORDS = new Set([
  'شقه', 'شقة', 'شقتين', 'مفروش', 'مفروشة', 'مفروشه', 'للبيع', 'بيع', 'للايجار', 'للإيجار',
  'ايجار', 'إيجار', 'قانون', 'مطلوب', 'تبحث', 'يبحث', 'بحث', 'بيدور', 'سؤال', 'عندها', 'عنده',
  'عندى', 'عندي', 'عايز', 'عاوز', 'اريد', 'أريد', 'انا', 'أنا', 'يمتلك', 'محل', 'محلات', 'مقر',
  'دور', 'عمارات', 'عمارة', 'عماره', 'برج', 'ابراج', 'أبراج', 'كمبوند', 'كومباوند', 'شارع', 'ش',
  'حي', 'الحي', 'في', 'فى', 'اخر', 'آخر', 'امام', 'أمام', 'خلف', 'بجوار', 'قرب', 'فوق', 'تحت',
  'مساحه', 'مساحة', 'متر', 'مليون', 'الف', 'ألف', 'كاش', 'تقسيط', 'بالتقسيط', 'تم', 'كانت', 'كان',
  'هل', 'سوبر', 'طوب', 'ارضي', 'أرضي', 'اول', 'أول', 'تاني', 'ثاني', 'ثالث', 'رابع', 'خامس',
  'سادس', 'سابع', 'ثامن', 'تاسع', 'عاشر', 'عنوان', 'مدينه', 'مدينة', 'مصر', 'زهراء', 'رابعه',
  'رابعة', 'ارض', 'أرض', 'جسر', 'مكرم', 'عباس', 'النحاس', 'المقريفي', 'السنهوري', 'السنهورى',
  'السلاب', 'كابول', 'اطلس', 'أطلس', 'الفرسان', 'المروه', 'المروة', 'الواحه', 'الواحة', 'السراج',
  'الاستاد', 'الحديقة', 'الحديقه', 'الطفل', 'التوحيد', 'رنين', 'ايديال', 'إيديال', 'ليبيا',
  'سودان', 'علاج', 'المحامي', 'السفير',
]);

const INTL_PREFIXES = ['971', '966', '965', '974', '973', '968', '962', '961', '249', '218'];

export function prettyPhoneFormat(value) {
  const digits = String(value || '').replaceAll(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('20') && digits.length >= 11) return `+20 ${digits.slice(2)}`;
  for (const code of INTL_PREFIXES) {
    if (digits.startsWith(code) && digits.length > code.length + 5) {
      return `+${code} ${digits.slice(code.length)}`;
    }
  }
  return `+${digits}`;
}

export function whatsappHref(phoneKey, messageText = '') {
  const digits = String(phoneKey || '').replaceAll(/\D/g, '');
  const msg = String(messageText || '').trim();
  const base = digits ? `https://wa.me/${digits}` : 'https://wa.me/';
  return msg ? `${base}?text=${encodeURIComponent(msg)}` : base;
}

function formatHonorificSalutation(kept) {
  const first = kept[0];
  if (first === 'د' || first === 'دكتور') {
    const rest = kept.slice(1, 3).join(' ');
    return rest ? `د. ${rest}` : 'يا دكتور';
  }
  if (first === 'م' || first === 'مهندس') {
    const rest = kept.slice(1, 3).join(' ');
    return rest ? `م. ${rest}` : 'يا بشمهندس';
  }
  if (first === 'اللواء' || first === 'لواء') {
    const rest = kept.slice(1, 3).join(' ');
    return rest ? `سيادة اللواء ${rest}` : 'سيادة اللواء';
  }
  if (['ام', 'أم', 'ابو', 'أبو', 'آل', 'مدام', 'الحاج', 'حاج'].includes(first)) {
    return `أ/ ${kept.slice(0, 3).join(' ')}`;
  }
  return `أ/ ${kept.slice(0, 2).join(' ')}`;
}

export function extractClientSalutation(rawName) {
  const stripped = String(rawName || '')
    .replace(/^[\u200e\u200f\s]*دردشة في واتساب مع\s*/u, '')
    .replaceAll(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\uFE0F\u200D\u200E\u200F\u202A-\u202E\u2066-\u2069]/gu, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
  if (!stripped || GENERIC_CLIENT_STARTS_RE.test(stripped)) return 'يا فندم';

  const beforePunct = stripped.split(/[،,/\n\-–—؟?0-9\u0660-\u0669.]/u)[0].trim();
  if (!beforePunct || GENERIC_CLIENT_STARTS_RE.test(beforePunct)) return 'يا فندم';

  const kept = [];
  for (const tok of beforePunct.split(/\s+/u)) {
    if (!tok || SALUTATION_STOP_WORDS.has(tok)) break;
    kept.push(tok);
    if (kept.length >= 3) break;
  }
  return kept.length ? formatHonorificSalutation(kept) : 'يا فندم';
}

export function formatUnitBriefForMessage(contextInfo = {}) {
  const propRaw = String(contextInfo.propertyType || '').trim();
  const baseProp = propRaw || TRACK_DEFAULT_PROP[contextInfo.track] || 'الوحدة';
  const sizeVal = Number(contextInfo.sizeMax || contextInfo.sizeMin || 0);
  if (Number.isFinite(sizeVal) && sizeVal > 0) {
    return `${baseProp} (${sizeVal} م²)`;
  }
  return baseProp;
}

function buildOwnerTemplates(sal, unit, area, intent, siteUrl) {
  const availMsg = intent === 'lease'
    ? `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك (عقارات مدينة نصر ومصر الجديدة). بخصوص ${unit} في ${area}، هل ما زالت متاحة حاليًا للإيجار ومتى أقرب موعد مناسب للمعاينة والتنفيذ؟`
    : `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك (عقارات مدينة نصر ومصر الجديدة). بخصوص ${unit} في ${area}، أود التأكد هل ما زالت متاحة للبيع حاليًا وبنفس السعر المطلوب لترشيحها لعميل جاد؟`;

  const fourthTemplate = siteUrl
    ? {
      id: 'site_link',
      label: '🌐 إرسال رابط الإعلان',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. تم تجهيز ونشر صفحة عرض وحدتكم في ${area} عبر موقعنا الرسمي لاطلاع العملاء الجادين:\n${siteUrl}\nوسنتابع مع حضرتك طلبات المعاينة أولًا بأول.`,
    }
    : {
      id: 'negotiate',
      label: '🤝 تأكيد السعر النهائي',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. بخصوص ${unit} في ${area}، نراجع حاليًا العروض الجاهزة للتنفيذ الفوري، فما أفضل سعر نهائي يمكن التحرك عليه مع عميل جاد؟`,
    };

  return [
    { id: 'availability', label: '🔄 تأكيد الإتاحة والسعر', text: availMsg },
    {
      id: 'viewing',
      label: '📅 تنسيق موعد معاينة',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. لدينا عميل جاد مهتم بـ ${unit} في ${area}، ونرغب في تنسيق موعد معاينة مناسب لحضرتك اليوم أو غدًا. ما التوقيت الأنسب لك؟`,
    },
    {
      id: 'media',
      label: '📸 استكمال الصور والتفاصيل',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. لتنشيط تسويق ${unit} في ${area} وعرضها على العملاء الجاهزين للتنفيذ، يرجى إرسال أحدث صور واضحة أو فيديو للوحدة مع تأكيد السعر النهائي.`,
    },
    fourthTemplate,
  ];
}

function buildSeekerTemplates(sal, unit, area, siteUrl) {
  const firstMsg = siteUrl
    ? `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. بخصوص طلب حضرتك (${unit} في ${area})، تتوفر لدينا فرصة مميزة مطابقة لطلبك يمكنك استعراض تفاصيلها وصورها من هنا:\n${siteUrl}\nأبلغني لو مناسبة لترتيب معاينة على الطبيعة.`
    : `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك (عقارات مدينة نصر ومصر الجديدة). بخصوص طلب حضرتك (${unit} في ${area})، تتوفر لدينا خيارات محدثة قريبة من مواصفاتك، هل ما زال البحث قائمًا لنرسل لك التفاصيل ونرتب معاينة؟`;

  return [
    { id: 'match_followup', label: '🎯 ترشيح عرض مطابق', text: firstMsg },
    {
      id: 'viewing',
      label: '📅 تحديد موعد معاينة',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. ننسق حاليًا مواعيد المعاينات الميدانية للعروض المناسبة لطلبك (${unit} في ${area})، ما التوقيت الأنسب لحضرتك اليوم أو غدًا؟`,
    },
    {
      id: 'qualify',
      label: '📋 تحديث المواصفات والميزانية',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. لحصر أدق العروض المتاحة حاليًا لطلبك في ${area} وتوفير وقتك، هل ما زالت نفس المساحة والميزانية محددة للتنفيذ الفوري أم طرأ عليها أي تعديل؟`,
    },
    {
      id: 'catalog',
      label: '🌐 عروض موقع سمسار طلبك',
      text: `السلام عليكم ${sal}، معك طارق طنطاوي — سمسار طلبك. يمكنك أيضًا استعراض أحدث العقارات الموثقة بالصور والأسعار في مدينة نصر ومصر الجديدة عبر موقعنا الرسمي:\n${PUBLIC_SITE_ORIGIN}/\nوأبلغني بأي وحدة تناسبك لترتيب معاينتها فورًا.`,
    },
  ];
}

export function buildWhatsappTemplates(contextInfo = {}) {
  const sal = extractClientSalutation(contextInfo.name);
  const area = String(contextInfo.areaLabel || '').trim() || 'مدينة نصر';
  const unit = formatUnitBriefForMessage(contextInfo);
  const intent = String(contextInfo.intent || 'sell');
  const siteUrl = String(contextInfo.siteUrl || '').trim();

  if (intent === 'buy' || intent === 'rent') {
    return buildSeekerTemplates(sal, unit, area, siteUrl);
  }
  return buildOwnerTemplates(sal, unit, area, intent, siteUrl);
}

export function buildReadyFollowupMessage(name, intent, areaLabel, extra = {}) {
  const templates = buildWhatsappTemplates({ name, intent, areaLabel, ...extra });
  return templates[0].text;
}
