/* ═══════════════════════════════════════════════════════════════════════
   المُضيف الذكي لسمسار طلبك — «Welcome Nudge» (V2)
   ─────────────────────────────────────────────────────────────────────
   مُضيف عقاري مصري ودود يرافق الزائر بهدوء وبلا إلحاح في ٤ خطوات مرتبة:
     S1 مداعبة وترحيب ← S2 فهم النية ← S3 رسم الطريق ← S4 تحفيز وخلاص.
   • قراءة مريحة (16–20 ثانية) + إيقاف المؤقّت عند اللمس/الماوس/إخفاء التبويب.
   • استمرارية عبر الصفحات، بلا صوت، بلا نافذة معطِّلة، وبلا بيانات شخصية.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var KEY = 'simsar_welcome_nudge_v1';
  var SKEY = 'simsar_welcome_session_v2';
  var ORDER = ['S1', 'S2', 'S3', 'S4'];
  var STAGES = { S1: 1, S2: 2, S3: 3, S4: 4 };
  var INTENTS = { NONE: 0, BUY: 1, RENT: 2, SELL: 3 };

  var FIRST_DELAY = 3200;
  var NEXT_PAGE_DELAY = 3800;
  var S4_PAGE_DELAY = 14000;
  var STEP_GAP = 15000;
  var CLOSE_BREATHER = 35000;
  var RESUME_MIN_TTL = 9000;
  var COMPARE_DELAY = 5500;
  var EXIT_AFTER = 28000;

  var root = document.getElementById('wnNudge');
  if (!root) return;

  var base = (root.getAttribute('data-wn-base') || '/').replace(/\/$/, '');
  var pageKind = root.getAttribute('data-wn-page') || '';
  var waUrl = root.getAttribute('data-wn-wa') || '';

  var HREFS = {
    browse: base + '/properties/',
    buy: base + '/properties/?deal=sale',
    rent: base + '/properties/?deal=rent',
    commercial: base + '/properties/commercial/',
    valuation: base + '/tools/valuation.html',
    add: base + '/add-your-property.html',
    agent: base + '/agent.html'
  };

  /* ─── التخزين الدائم والمؤقت: أرقام محدودة فقط داخل try/catch ────────── */
  function clampInt(val, min, max, fallback) {
    var n = typeof val === 'number' ? Math.floor(val) : fallback;
    return (n < min || n > max || Number.isNaN(n)) ? fallback : n;
  }

  function parseStoredFlag(parsed) {
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.v !== 2) {
      return { v: 2, seen: 0, muted: parsed.muted === 1 ? 1 : 0, stage: 0, intent: 0 };
    }
    return {
      v: 2,
      seen: parsed.seen === 1 ? 1 : 0,
      muted: parsed.muted === 1 ? 1 : 0,
      stage: clampInt(parsed.stage, 0, 4, 0),
      intent: clampInt(parsed.intent, 0, 3, 0)
    };
  }

  function readFlag() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? parseStoredFlag(JSON.parse(raw)) : null;
    } catch (e) { return null; }
  }

  var memFlag = { v: 2, seen: 0, muted: 0, stage: 0, intent: 0 };

  function getState() {
    var disk = readFlag();
    if (disk) memFlag = disk;
    return memFlag;
  }

  function writeFlag(patch) {
    var cur = Object.assign({}, getState(), patch);
    memFlag = {
      v: 2,
      seen: cur.seen ? 1 : 0,
      muted: cur.muted ? 1 : 0,
      stage: clampInt(cur.stage, 0, 4, 0),
      intent: clampInt(cur.intent, 0, 3, 0)
    };
    try {
      window.localStorage.setItem(KEY, JSON.stringify(memFlag));
    } catch (e) { /* تصفح خاص أو تخزين مقفول */ }
  }

  var memSess = { v: 2, views: 0, props: 0, nextAt: 0 };

  function readSession() {
    try {
      var raw = window.sessionStorage && window.sessionStorage.getItem(SKEY);
      if (!raw) return memSess;
      var p = JSON.parse(raw);
      if (!p || typeof p !== 'object') return memSess;
      memSess = {
        v: 2,
        views: clampInt(p.views, 0, 999, 0),
        props: clampInt(p.props, 0, 999, 0),
        nextAt: typeof p.nextAt === 'number' && p.nextAt > 0 ? Math.floor(p.nextAt) : 0
      };
    } catch (e) { /* ignore */ }
    return memSess;
  }

  function writeSession(patch) {
    var s = Object.assign({}, readSession(), patch);
    memSess = {
      v: 2,
      views: clampInt(s.views, 0, 999, 0),
      props: clampInt(s.props, 0, 999, 0),
      nextAt: typeof s.nextAt === 'number' && s.nextAt > 0 ? Math.floor(s.nextAt) : 0
    };
    try {
      if (window.sessionStorage) window.sessionStorage.setItem(SKEY, JSON.stringify(memSess));
    } catch (e) { /* ignore */ }
  }

  /* ─── فهم سياق الصفحة والنية الهادئة ───────────────────────────────────── */
  function isPropertyDetail() {
    if (pageKind === 'property_page') return true;
    var p = String((window.location && window.location.pathname) || '');
    return /^\/properties\/[^/]+\/?$/.test(p) &&
      !/^\/properties\/(page|apartments-for-sale|apartments-for-rent|commercial|makram-ebeid|abbas-el-akkad|seventh-district|mostafa-el-nahas|el-tayaran)(\.html|\/|$)/.test(p);
  }

  function inferPassiveIntent() {
    var loc = window.location || {};
    var p = String(loc.pathname || '') + String(loc.search || '');
    if (/deal=rent|apartments-for-rent|commercial/i.test(p)) return INTENTS.RENT;
    if (/^\/requests(\/|$)/i.test(p) || pageKind === 'request_page') return INTENTS.SELL;
    if (/deal=sale|apartments-for-sale/i.test(p) || isPropertyDetail()) return INTENTS.BUY;
    return INTENTS.NONE;
  }

  function effectiveIntent() {
    return getState().intent || inferPassiveIntent();
  }

  var WA_MESSAGES = {};
  WA_MESSAGES[INTENTS.NONE] = 'السلام عليكم أ. طارق طنطاوي، بتصفح موقع سمسار طلبك ومحتاج ترشيح عقار مناسب في مدينة نصر.';
  WA_MESSAGES[INTENTS.BUY] = 'السلام عليكم أ. طارق طنطاوي، أبحث عن شقة/عقار تمليك في مدينة نصر من خلال موقع سمسار طلبك ومحتاج ترشيح مناسب.';
  WA_MESSAGES[INTENTS.RENT] = 'السلام عليكم أ. طارق طنطاوي، أبحث عن وحدة للإيجار أو مقر تجاري في مدينة نصر عبر موقع سمسار طلبك.';
  WA_MESSAGES[INTENTS.SELL] = 'السلام عليكم أ. طارق طنطاوي، لدي عقار في مدينة نصر وأرغب في تقييمه وعرضه للتسويق عبر سمسار طلبك.';

  function buildWaHref(intent) {
    if (!waUrl) return '';
    var msg = WA_MESSAGES[intent] || WA_MESSAGES[INTENTS.NONE];
    return waUrl + '?text=' + encodeURIComponent(msg);
  }

  /* ─── نصوص الخطوات الأربع المرتبة (مداعبة ← نية ← طريق ← تحفيز) ───────── */
  function copyS1(onProp) {
    return {
      stepLabel: '١ من ٤',
      brand: 'طارق طنطاوي · مُضيفك الذكي',
      title: onProp ? 'بداية موفّقة واختيار جميل!' : 'منوّر مدينة نصر!',
      text: onProp
        ? 'خد وقتك خالص في قراءة تفاصيل العرض ده.. أنا طارق طنطاوي (سمسار طلبك)، وكل وحدة هنا بسعر المالك المعلن من غير لف ولا مبالغة.'
        : 'مشوار التدوير على عقار ساعات بيبقى محيّر.. خد نفس هادي واتفرّج براحتك، أنا طارق طنطاوي (سمسار طلبك)، وكل عرض هنا بسعر المالك الحقيقي من غير لف ولا دوران.',
      primary: { label: onProp ? 'رسّملي الطريق' : 'يلا نبدأ الجولة', act: 'next' },
      escape: false,
      ttl: 16000
    };
  }

  function copyS2() {
    return {
      stepLabel: '٢ من ٤',
      brand: 'نفهم طلبك في ثانية',
      title: 'إيه اللي في بالك النهارده؟',
      text: 'بنقرة خفيفة قولي بتفكر في إيه، عشان أفتحلك السكة الأقصر جوه الموقع على مقاس طلبك بالظبط:',
      chips: [
        { label: '🏠 بدوّر على شقة أو عقار تمليك', intent: INTENTS.BUY },
        { label: '🔑 إيجار سكني أو مقر تجاري', intent: INTENTS.RENT },
        { label: '💎 عندي عقار أقيّمه أو أعرضه', intent: INTENTS.SELL }
      ],
      escape: false,
      ttl: 20000
    };
  }

  var S3_BY_INTENT = {};
  S3_BY_INTENT[INTENTS.SELL] = {
    stepLabel: '٣ من ٤',
    brand: 'طريقك كمالك عقار',
    title: 'خطوة ذكية قبل تسعير وحدتك',
    text: 'قبل ما تحدد السعر، شوف مؤشر سعر المتر الفعلي في منطقتك بمدينة نصر مجانًا في ثواني، وبعدها نعرض عقارك للمشترين الجادين بدون أي رسوم مقدمة.',
    primary: { label: 'قيّم عقارك مجانًا', act: 'href', href: HREFS.valuation },
    secondary: { label: 'اعرض عقارك', act: 'href', href: HREFS.add },
    escape: true,
    escapeText: 'أو ابعت تفاصيل وحدتك لطارق طنطاوي على واتساب',
    ttl: 18000
  };
  S3_BY_INTENT[INTENTS.RENT] = {
    stepLabel: '٣ من ٤',
    brand: 'أقصر طريق لطلبك',
    title: 'عروض الإيجار والتجاري جاهزة ليك',
    text: 'جمعنالك الشقق المفروشة والفاضية والمحلات والمقرات الإدارية بفلترة فورية، وجوه كل عرض تقدر تسمع ملخصه الصوتي في نصف دقيقة بدل القراية الطويلة.',
    primary: { label: 'افتح عروض الإيجار', act: 'href', href: HREFS.rent },
    secondary: { label: 'التجاري والإداري', act: 'href', href: HREFS.commercial },
    escape: true,
    escapeText: 'مستعجل على طلبك؟ كلّم طارق طنطاوي على واتساب',
    ttl: 18000
  };
  S3_BY_INTENT[INTENTS.BUY] = {
    stepLabel: '٣ من ٤',
    brand: 'أقصر طريق للتمليك',
    title: 'اكتب طلبك بطبيعتك واسمع العرض بالصوت!',
    text: 'في بحث المعرض اكتب اللي في بالك كأنك بتحكيه (مثلاً: «شقة 3 غرف المنطقة الثامنة أقل من 8 مليون»)، وجوه كل شقة هتلاقي إعلان صوتي يختصرلك التفاصيل في 25 ثانية.',
    primary: { label: 'جرّب البحث الذكي الآن', act: 'search_or_buy', href: HREFS.buy },
    escape: true,
    escapeText: 'تحب تختصر المشوار؟ كلّم طارق طنطاوي على واتساب',
    ttl: 18000
  };
  S3_BY_INTENT[INTENTS.NONE] = {
    stepLabel: '٣ من ٤',
    brand: 'خريطة سريعة للموقع',
    title: '٣ مزايا تريّحك وأنت بتتصفح',
    text: 'اكتب طلبك بطبيعتك في بحث العقارات، أو اسمع ملخص أي شقة بالصوت في ثواني، ولو عندك عقار تقدر تقيّم متوسط سعره الفعلي في منطقتك مجانًا.',
    primary: { label: 'استكشف عروض مدينة نصر', act: 'href', href: HREFS.browse },
    secondary: { label: 'قيّم عقارك', act: 'href', href: HREFS.valuation },
    escape: true,
    escapeText: 'تحب تسأل طارق طنطاوي مباشرة؟ تواصل عبر واتساب',
    ttl: 18000
  };

  function copyS4(intent) {
    if (intent === INTENTS.SELL) {
      return {
        stepLabel: '٤ من ٤',
        brand: 'لمسة أخيرة تريّحك',
        title: 'جاهز نوصّل عقارك للمشتري الصح؟',
        text: 'سجّل بيانات مبدئية لوحدتك في دقيقة واحدة وهنراجعها معاك بهدوء ونبدأ تسويقها لقاعدة العملاء الجادين في مدينة نصر خطوة بخطوة.',
        primary: { label: 'سجّل عقارك للتسويق', act: 'href', href: HREFS.add },
        escape: true,
        escapeText: 'أو ابعت تفاصيل الشقة مباشرة لطارق طنطاوي على واتساب',
        ttl: 20000
      };
    }
    return {
      stepLabel: '٤ من ٤',
      brand: 'لمسة أخيرة تريّحك',
      title: 'محتار بين العروض أو مش لاقي المناسب؟',
      text: 'طبيعي جدًا تحتار! بدل ما تلف كتير، اكتب للوكيل الذكي ٣ حاجات بس (تمليك ولا إيجار · المنطقة · ميزانيتك) لترشيح أقرب وحدات حقيقية في ٢٠ ثانية.',
      primary: { label: 'رشّحلي بالوكيل الذكي', act: 'href', href: HREFS.agent },
      escape: true,
      escapeText: 'تفضّل تحكيها لطارق طنطاوي بنفسه؟ كلّمه على واتساب',
      ttl: 20000
    };
  }

  function stepCopy(stage) {
    var intent = effectiveIntent();
    if (stage === 'S1') return copyS1(isPropertyDetail());
    if (stage === 'S2') return copyS2();
    if (stage === 'S3') return S3_BY_INTENT[intent] || S3_BY_INTENT[INTENTS.NONE];
    return copyS4(intent);
  }

  /* ─── البوابات وحالة الانشغال والقياس ──────────────────────────────────── */
  function isPreviewMode() {
    return /[?&]nudge=preview\b/.test(String((window.location && window.location.search) || ''));
  }

  function isSlowNetwork() {
    var conn = window.navigator && (window.navigator.connection || window.navigator.mozConnection || window.navigator.webkitConnection);
    return Boolean(conn && (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || '')));
  }

  function disabled() {
    if (root.hasAttribute('data-wn-off') || window.NASR_NUDGE === false) return true;
    if (/[?&]nudge=off\b/.test(String((window.location && window.location.search) || ''))) return true;
    if (isSlowNetwork()) return true;
    if (isPreviewMode()) return false;
    var st = getState();
    return st.muted === 1 || st.seen === 1 || st.stage >= ORDER.length;
  }

  function busy() {
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return true;
    return Boolean(document.querySelector('[aria-modal="true"], .push-banner-visible:not(.push-banner-hidden), #floatingMenuPanel.open, .floating-menu-open, .pp-lightbox.show'));
  }

  function track(name, data) {
    try {
      window.dataLayer = window.dataLayer || [];
      window.dataLayer.push(Object.assign({ event: name }, data));
    } catch (e) { /* ignore */ }
  }

  /* ─── حالة العرض والمؤقّتات القابلة للإيقاف عند القراءة ────────────────── */
  var off = false;
  var current = null;
  var hideTimer = null;
  var stepTimer = null;
  var retryTimer = null;
  var shownAt = 0;
  var remainingMs = 0;
  var paused = false;
  var barFill = null;
  var loadedAt = Date.now();

  function clearTimers() {
    if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; }
    if (stepTimer) { window.clearTimeout(stepTimer); stepTimer = null; }
    if (retryTimer) { window.clearTimeout(retryTimer); retryTimer = null; }
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  }

  function linkEl(cls, text, href, external) {
    var a = el('a', cls + ' wn-link', text);
    a.href = href;
    if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  }

  function startCountdown(ms) {
    if (hideTimer) window.clearTimeout(hideTimer);
    remainingMs = ms;
    shownAt = Date.now();
    paused = false;
    root.classList.remove('wn-paused');
    if (barFill) {
      barFill.style.animation = 'none';
      barFill.style.animation = 'wn-progress ' + Math.round(ms) + 'ms linear forwards';
    }
    hideTimer = window.setTimeout(function () {
      hideTimer = null;
      if (current && root.classList.contains('wn-visible')) finishStep(current, 'ttl', STEP_GAP);
    }, ms);
  }

  function pauseCountdown() {
    if (!current || paused) return;
    paused = true;
    if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; }
    remainingMs = Math.max(RESUME_MIN_TTL, remainingMs - Math.max(0, Date.now() - shownAt));
    root.classList.add('wn-paused');
  }

  function resumeCountdown() {
    if (!current || !paused || document.visibilityState === 'hidden') return;
    startCountdown(Math.max(RESUME_MIN_TTL, remainingMs));
  }

  function muteAll() {
    var stage = current || 'S1';
    clearTimers();
    current = null;
    off = true;
    root.classList.remove('wn-visible');
    writeFlag({ muted: 1, seen: 1 });
    track('nudge_close', { nudge_stage: stage, nudge_how: 'mute' });
  }

  function nextStageToRun() {
    var st = getState();
    if (st.muted === 1 || st.seen === 1 || st.stage >= ORDER.length) return null;
    return ORDER[st.stage] || null;
  }

  function scheduleNext(delayMs) {
    if (off) return;
    var next = nextStageToRun();
    if (!next) return;
    if (stepTimer) window.clearTimeout(stepTimer);
    stepTimer = window.setTimeout(function () {
      stepTimer = null;
      show(next);
    }, Math.max(0, delayMs));
  }

  function finishStep(stage, how, nextGapMs) {
    if (current !== stage) return;
    if (hideTimer) { window.clearTimeout(hideTimer); hideTimer = null; }
    current = null;
    paused = false;
    root.classList.remove('wn-visible');
    root.classList.remove('wn-paused');

    var num = STAGES[stage] || 1;
    var isFinal = num >= ORDER.length;
    writeFlag({ stage: Math.max(getState().stage, num), seen: isFinal ? 1 : 0 });
    var gap = typeof nextGapMs === 'number' ? nextGapMs : STEP_GAP;
    writeSession({ nextAt: Date.now() + gap });
    track('nudge_close', { nudge_stage: stage, nudge_how: how });

    if (!isFinal && !off && gap >= 0) scheduleNext(gap);
  }

  /* ─── بناء عناصر البطاقة ──────────────────────────────────────────────── */
  function renderChips(stage, chips) {
    var box = el('div', 'wn-chips');
    for (var i = 0; i < chips.length; i += 1) {
      (function (item) {
        var chip = el('button', 'wn-chip');
        chip.type = 'button';
        chip.appendChild(el('span', '', item.label));
        chip.appendChild(el('span', 'wn-chip-arrow', '←'));
        chip.addEventListener('click', function () {
          writeFlag({ intent: item.intent, stage: 2 });
          track('nudge_tap', { nudge_stage: stage, nudge_action: 'intent_' + item.intent });
          finishStep(stage, 'intent', 420);
        });
        box.appendChild(chip);
      })(chips[i]);
    }
    return box;
  }

  function buildPrimaryControl(stage, primary) {
    if (primary.act === 'next') {
      var bNext = el('button', 'wn-btn wn-btn-primary', primary.label);
      bNext.type = 'button';
      bNext.addEventListener('click', function () {
        track('nudge_tap', { nudge_stage: stage, nudge_action: 'continue' });
        finishStep(stage, 'continue', 450);
      });
      return bNext;
    }
    var searchInput = primary.act === 'search_or_buy' ? document.getElementById('plSearch') : null;
    if (searchInput && typeof searchInput.focus === 'function') {
      var bSearch = el('button', 'wn-btn wn-btn-primary', primary.label);
      bSearch.type = 'button';
      bSearch.addEventListener('click', function () {
        track('nudge_tap', { nudge_stage: stage, nudge_action: 'focus_search' });
        finishStep(stage, 'primary', STEP_GAP);
        searchInput.focus();
        if (typeof searchInput.scrollIntoView === 'function') {
          searchInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
      return bSearch;
    }
    var bLink = linkEl('wn-btn wn-btn-primary', primary.label, primary.href, false);
    bLink.addEventListener('click', function () {
      track('nudge_tap', { nudge_stage: stage, nudge_action: 'primary' });
      finishStep(stage, 'primary', NEXT_PAGE_DELAY);
    });
    return bLink;
  }

  function renderActions(stage, copy) {
    var actions = el('div', 'wn-actions');
    actions.appendChild(buildPrimaryControl(stage, copy.primary));
    if (copy.secondary) {
      var bSec = linkEl('wn-btn wn-btn-ghost', copy.secondary.label, copy.secondary.href, false);
      bSec.addEventListener('click', function () {
        track('nudge_tap', { nudge_stage: stage, nudge_action: 'secondary' });
        finishStep(stage, 'secondary', NEXT_PAGE_DELAY);
      });
      actions.appendChild(bSec);
    }
    return actions;
  }

  function renderFooter(stage, copy, intent) {
    var foot = el('div', 'wn-foot');
    var waHref = buildWaHref(intent);
    if (copy.escape && waHref) {
      var esc = el('p', 'wn-escape');
      var escLink = linkEl('wn-escape-link', copy.escapeText, waHref, true);
      escLink.addEventListener('click', function () {
        track('nudge_tap', { nudge_stage: stage, nudge_action: 'escape_whatsapp' });
      });
      esc.appendChild(escLink);
      foot.appendChild(esc);
    }
    var muteBtn = el('button', 'wn-mute', 'إيقاف نصائح الجولة');
    muteBtn.type = 'button';
    muteBtn.addEventListener('click', muteAll);
    foot.appendChild(muteBtn);
    return foot;
  }

  function buildCard(stage) {
    var copy = stepCopy(stage);
    root.innerHTML = '';
    if (document.querySelector('.pp-floating-wa, .rq-floating-wa')) root.classList.add('wn-high');
    else root.classList.remove('wn-high');
    root.classList.add('wn-visible');

    var head = el('div', 'wn-head');
    head.appendChild(el('span', 'wn-dot'));
    head.appendChild(el('span', 'wn-brand', copy.brand));
    head.appendChild(el('span', 'wn-step', copy.stepLabel));
    var closeBtn = el('button', 'wn-close', '\u00d7');
    closeBtn.type = 'button';
    closeBtn.setAttribute('aria-label', 'إغلاق هذه الرسالة');
    closeBtn.addEventListener('click', function () { finishStep(stage, 'x', CLOSE_BREATHER); });
    head.appendChild(closeBtn);
    root.appendChild(head);

    if (copy.title) root.appendChild(el('p', 'wn-title', copy.title));
    root.appendChild(el('p', 'wn-text', copy.text));

    if (copy.chips) root.appendChild(renderChips(stage, copy.chips));
    else if (copy.primary) root.appendChild(renderActions(stage, copy));

    root.appendChild(renderFooter(stage, copy, effectiveIntent()));

    var bar = el('div', 'wn-bar');
    barFill = el('div', 'wn-bar-fill');
    bar.appendChild(barFill);
    root.appendChild(bar);

    startCountdown(copy.ttl);
  }

  function waitUntilFree(stage) {
    var tries = 0;
    var tick = function () {
      retryTimer = null;
      tries += 1;
      if (off || current) return;
      if (!busy() && document.visibilityState !== 'hidden') { show(stage); return; }
      if (tries < 12) retryTimer = window.setTimeout(tick, 2000);
    };
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(tick, 2000);
  }

  function show(stage) {
    if (off || current || !stage || nextStageToRun() !== stage) return;
    if (busy() || document.visibilityState === 'hidden') {
      waitUntilFree(stage);
      return;
    }
    current = stage;
    var num = STAGES[stage] || 1;
    writeFlag({ stage: num, seen: num >= ORDER.length ? 1 : 0 });
    writeSession({ nextAt: Date.now() + NEXT_PAGE_DELAY });
    buildCard(stage);
    track('nudge_shown', { nudge_stage: stage });
  }

  function onExitCue(e) {
    if (off || current || (Date.now() - loadedAt) < EXIT_AFTER) return;
    if ((e && e.relatedTarget) || (e && typeof e.clientY === 'number' && e.clientY > 6)) return;
    var st = getState();
    if (st.stage >= 2 && st.stage < 4 && st.muted !== 1 && st.seen !== 1) {
      writeFlag({ stage: 3 });
      show('S4');
    }
  }

  function bindInteractions() {
    root.addEventListener('pointerenter', pauseCountdown);
    root.addEventListener('mouseenter', pauseCountdown);
    root.addEventListener('touchstart', pauseCountdown, { passive: true });
    root.addEventListener('focusin', pauseCountdown);

    root.addEventListener('pointerleave', resumeCountdown);
    root.addEventListener('mouseleave', resumeCountdown);
    root.addEventListener('focusout', resumeCountdown);

    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') pauseCountdown();
      else resumeCountdown();
    });

    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && current) finishStep(current, 'esc', CLOSE_BREATHER);
    }, { passive: true });

    document.addEventListener('pointerout', onExitCue, { passive: true });
    document.addEventListener('mouseleave', onExitCue, { passive: true });
  }

  function computeInitialDelay(stage, curStage, props, cooldownLeft) {
    if (curStage === 0) return FIRST_DELAY;
    var baseDelay = stage === 'S4' ? S4_PAGE_DELAY : NEXT_PAGE_DELAY;
    if (stage === 'S4' && props >= 2) baseDelay = COMPARE_DELAY;
    return Math.max(baseDelay, cooldownLeft);
  }

  function schedule() {
    loadedAt = Date.now();
    if (isPreviewMode()) {
      writeFlag({ seen: 0, muted: 0, stage: 0, intent: 0 });
      writeSession({ views: 0, props: 0, nextAt: 0 });
    }
    if (disabled()) { off = true; return; }

    var sess = readSession();
    var views = sess.views + 1;
    var props = sess.props + (isPropertyDetail() ? 1 : 0);
    writeSession({ views: views, props: props });

    var curState = getState();
    if (curState.intent === INTENTS.NONE && views >= 2) {
      var hinted = inferPassiveIntent();
      if (hinted !== INTENTS.NONE) writeFlag({ intent: hinted });
    }

    bindInteractions();
    var stage = nextStageToRun();
    if (!stage) return;

    var cooldownLeft = sess.nextAt > loadedAt ? (sess.nextAt - loadedAt) : 0;
    scheduleNext(computeInitialDelay(stage, curState.stage, props, cooldownLeft));
  }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();
