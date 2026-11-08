/* ═══════════════════════════════════════════════════════════════════════
   تحية سمسار طلبك — «Welcome Nudge» (V1)
   ─────────────────────────────────────────────────────────────────────
   الفكرة: الزائر اللي داخل لأول مرة ياخد تحية قصيرة، ومعلومة واحدة لو هو
   مشغول، وطريق ترشيح لو هو جدّي ومش لاقي — بس في الترتيب ده مش دفعة واحدة.

   ثلاث درجات (سلَّم) — فقاعة واحدة في كل مرة، والتصعيد ما دام الزائر ما قفلش:
   والظهور كله مرة واحدة على الجهاز للأبد (علامة seen تُكتب عند أول ظهور):
     S0  بعد 1.2 ثانية من التحميل  → تعريف بالشخص والكيان (طارق طنطاوي = سمسار طلبك).
                                     لا عرض محادثة هنا إطلاقًا: البداية تعريف مش إلحاح.
     S1  بعد 20 ثانية تصفّح هادي    → «موقعي مش عايز السرعة» + طريق للعروض.
     S3  عند الوقوف/الخروج (بعد 25 ثانية على أي حال) → «جدّي في الشراء بس مش لاقي المناسب» + ترشيح.
         ثلاث طرق توصله: خروج الماوس من الحافة العليا · طلوع الزائر من التبويب ·
         ثبات 2.5 ثانية في أعلى الصفحة بعد S1 (ده مسار اللمس الوحيد على الموبايل).

   «طارق هو الخلاص»: في كل درجة بعد S0 فيه سطر خروج يوصّله بطارق على واتساب،
   لكنه مش هو الزر الأساسي ومش بيظهر في أول ثانية. الخلاص يفتح لما الزائر
   يقف (مفيش نتيجة، حيرته، خروجه) — مش لما يوصل.

   قواعد السلامة (ثابتة ومفحوصة في scripts/tests/welcome-nudge.test.mjs):
     • V1 بلا صوت إطلاقًا: لا <audio>، لا speechSynthesis، لا autoplay، لا ملف صوت.
       (نفس قاعدة _includes/property-audio.html: «لا تشغيل تلقائي إطلاقًا».)
     • لا نافذة معطِّلة: لا alert/confirm/modal — فقاعة صغيرة فقط، بلا حاجز فوق الصفحة.
     • بلا تشويش: لو الزائر بيكتب أو بيلف أو دوس على بطاقة عقار → الدرجة تتأجل أو تُلغى.
     • بلا تكرار: علامة واحدة في localStorage تمنع الظهور للأبد، وكتم دائم من القائمة.
     • بلا بيانات: المُخزَّن {v,seen,muted,stage} بس — لا نص حرّ، لا اسم، لا هاتف، لا IP.
     • التخزين مقفول (تصفح خاص) → كل شيء يشتغل في حدود الصفحة، ومفيش استثناء.
     • ولا تعارض مع بانر التنبيهات: بانر «فعّل التنبيهات» أولّى؛ التحية تنتظره.
     • لا تُشغَّل في PWA المثبّت، ولا مع prefers-reduced-motion/saveData/شبكة بطيئة.
     • إطفاء فوري: ?nudge=off أو window.NASR_NUDGE === false.

   القياس: أحداث في dataLayer الموجود (GTM-5BTRF7NP) — بلا cookie وبلا محلل جديد.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var KEY = 'simsar_welcome_nudge_v1';
  var STAGES = { S0: 1, S1: 2, S3: 3 };

  /* ─── النصوص ─────────────────────────────────────────────────────────── */
  var WN_COPY = {
    S0: {
      title: 'سمسار طلبك',
      text: 'أهلاً بيك — أنا طارق طنطاوي، صاحب الموقع ده. عقارات مدينة نصر بس، من 2014، بالسعر اللي المالك أعلنه.',
      primary: { label: 'كمّل تصفّح', act: 'close' },
      escape: false,
      ttl: 6000
    },
    S1: {
      title: 'موقعي مش عايز السرعة',
      text: 'لو أنت في الشارع دلوقتي، اشرب فنجان القهوة وارجع بالراحة — التحية مش هترجع تاني.',
      primary: { label: 'شوف 3 عروض في مدينة نصر', act: 'href', key: 'browse' },
      dismiss: 'مش فاضي دلوقتي',
      escape: true,
      ttl: 9000
    },
    S3: {
      title: 'جدّي بس مش لاقي المناسب؟',
      text: 'قولي 3 حاجات بس: تشتري ولا تأجر · المنطقة · ميزانيتك — 20 ثانية وأرشّحلك اللي يناسبك.',
      primary: { label: 'ابدأ الترشيح', act: 'href', key: 'agent' },
      dismiss: 'لأ، شكرًا',
      escape: true,
      ttl: 12000
    }
  };

  var WN_ESCAPE_TEXT = 'ولا تستنى ترشيح؟ كلّم طارق طنطاوي على واتساب';

  /* ─── حالة التشغيل ─────────────────────────────────────────────────────── */
  var root = document.getElementById('wnNudge');
  if (!root) return;

  var base = (root.getAttribute('data-wn-base') || '/').replace(/\/$/, '');
  /* رقم واتساب يأتي من إعدادات الموقع عبر data-wn-wa فقط — لا رقم مكرَّر في الكود.
     لو غاب (إعداد ناقص) يبقى سطر الخلاص بلا رابط، والفحوص تظل خضراء. */
  var waUrl = root.getAttribute('data-wn-wa') || '';
  var waHref = waUrl ? waUrl + '?text=' + encodeURIComponent(
    'السلام عليكم أ. طارق طنطاوي، وصلت لصفحة سمسار طلبك ومحتاج ترشيح عقار في مدينة نصر.'
  ) : '';
  var HREFS = {
    browse: base + '/properties/',
    agent: base + '/agent.html'
  };

  var off = false;
  var fired = {};                 // كل درجة تُعرض مرة واحدة في الصفحة
  var dismissed = false;          // الزائر قفلها ⇒ لا تصعيد بعدها
  var current = null;             // الدرجة الظاهرة الآن (فقاعة واحدة بس)
  var lastActivity = Date.now();
  var clickedCard = false;        // دوس على بطاقة عقار ⇒ مش محتاج تحية
  var hideTimer = null;           // مؤقّت إخفاء الفقاعة الحالية (وحده)
  var retryTimer = null;          // مؤقّت انتظار بانر التنبيهات

  /* ─── التخزين: علامة واحدة، بحقول محصورة ──────────────────────────────── */
  function readFlag() {
    try {
      var raw = window.localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function writeFlag(patch) {
    try {
      var cur = readFlag() || { v: 1 };
      for (var k in patch) { if (Object.prototype.hasOwnProperty.call(patch, k)) cur[k] = patch[k]; }
      window.localStorage.setItem(KEY, JSON.stringify({
        v: 1,
        seen: cur.seen ? 1 : 0,
        muted: cur.muted ? 1 : 0,
        stage: typeof cur.stage === 'number' ? cur.stage : 0
      }));
    } catch (e) { /* التخزين معطّل — لا يكسر الصفحة */ }
  }

  /* ─── البوابات: إيه اللي يمنع الظهور ───────────────────────────────────── */
  function media(q) { return window.matchMedia && window.matchMedia(q).matches; }

  function disabled() {
    if (root.hasAttribute('data-wn-off')) return true;
    if (window.NASR_NUDGE === false) return true;
    if (/[?&]nudge=off\b/.test(window.location.search)) return true;
    var flag = readFlag();
    if (flag && (flag.seen === 1 || flag.muted === 1)) return true;
    if (media('(display-mode: standalone)') || window.navigator.standalone === true) return true;
    if (media('(prefers-reduced-motion: reduce)')) return true;
    var conn = window.navigator.connection || window.navigator.mozConnection || window.navigator.webkitConnection;
    if (conn && (conn.saveData === true || /(^|-)2g$/.test(conn.effectiveType || ''))) return true;
    return false;
  }

  /* الزائر مشغول؟ (كتابة / قائمة مفتوحة / مودال / بانر التنبيهات ظاهر) */
  function busy() {
    var ae = document.activeElement;
    if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.isContentEditable)) return true;
    if (document.querySelector('[aria-modal="true"], .push-banner-visible, .floating-menu-open')) return true;
    return false;
  }

  function idleFor(ms) { return (Date.now() - lastActivity) >= ms; }

  /* ─── القياس ───────────────────────────────────────────────────────────── */
  function track(name, data) {
    try {
      window.dataLayer = window.dataLayer || [];
      var payload = { event: name };
      for (var k in data) { if (Object.prototype.hasOwnProperty.call(data, k)) payload[k] = data[k]; }
      window.dataLayer.push(payload);
    } catch (e) { /* التحليلات مش شرط تشتغل */ }
  }

  /* ─── الرسم ────────────────────────────────────────────────────────────── */
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;          // نص ثابت من الكود — بلا أي مدخل مستخدم
    return n;
  }

  function link(cls, text, href, external) {
    var a = el('a', cls + ' wn-link', text);
    a.href = href;
    if (external) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
    return a;
  }

  function build(stage) {
    var copy = WN_COPY[stage];
    root.innerHTML = '';
    root.classList.add('wn-visible');

    var head = el('div', 'wn-head');
    head.appendChild(el('span', 'wn-brand', copy.title));
    var close = el('button', 'wn-close', '\u00d7');
    close.type = 'button';
    close.setAttribute('aria-label', 'اقفل التحية');
    close.addEventListener('click', function () { closeNudge(stage, 'x'); });
    head.appendChild(close);
    root.appendChild(head);

    root.appendChild(el('p', 'wn-text', copy.text));

    var actions = el('div', 'wn-actions');
    if (copy.primary.act === 'close') {
      var b0 = el('button', 'wn-btn wn-btn-primary', copy.primary.label);
      b0.type = 'button';
      b0.addEventListener('click', function () { track('nudge_tap', { nudge_stage: stage, nudge_action: 'continue' }); closeNudge(stage, 'continue'); });
      actions.appendChild(b0);
    } else {
      var b1 = link('wn-btn wn-btn-primary', copy.primary.label, HREFS[copy.primary.key]);
      b1.addEventListener('click', function () { track('nudge_tap', { nudge_stage: stage, nudge_action: 'primary' }); });
      actions.appendChild(b1);
    }
    if (copy.dismiss) {
      var bd = el('button', 'wn-btn wn-btn-ghost', copy.dismiss);
      bd.type = 'button';
      bd.addEventListener('click', function () { closeNudge(stage, 'dismiss'); });
      actions.appendChild(bd);
    }
    root.appendChild(actions);

    /* الخلاص: طارق — بس بعد درجة التعريف، ومش كزر أساسي */
    if (copy.escape && waHref) {
      var esc = el('p', 'wn-escape');
      var escLink = link('wn-escape-link', WN_ESCAPE_TEXT, waHref, true);
      escLink.addEventListener('click', function () { track('nudge_tap', { nudge_stage: stage, nudge_action: 'escape_whatsapp' }); });
      esc.appendChild(escLink);
      root.appendChild(esc);
    }

    root.setAttribute('aria-label', 'تحية من سمسار طلبك');
    if (hideTimer) window.clearTimeout(hideTimer);
    hideTimer = window.setTimeout(function () {
      if (root.classList.contains('wn-visible')) closeNudge(stage, 'ttl');
    }, copy.ttl);
  }

  function closeNudge(stage, how) {
    if (current !== stage) return;
    current = null;
    if (how === 'dismiss' || how === 'x') dismissed = true;   // رفض صريح ⇒ السلَّم يقف
    root.classList.remove('wn-visible');
    if (how === 'dismiss' || how === 'x' || how === 'ttl') writeFlag({ seen: 1, stage: STAGES[stage] || 0 });
    track('nudge_close', { nudge_stage: stage, nudge_how: how });
  }

  /**
   * السلَّم يتصعّد لكن فقاعة واحدة فقط: لو S0 لسه ظاهرة عند العشرين ثانية نستبدلها
   * بـS1 (الاستمرار أحسن من طبقتين فوق بعض)، ولو الزائر قفلها بأزراره نقف خالص.
   */
  function show(stage) {
    if (off || dismissed || fired[stage]) return;
    if (busy()) { waitAgain(stage); return; }
    fired[stage] = true;
    current = stage;
    build(stage);
    writeFlag({ seen: 1, stage: STAGES[stage] || 0 });
    track('nudge_shown', { nudge_stage: stage });
  }

  /* بانر التنبيهات أولّى: ننتظره بمحاولة كل 1.5 ثانية، 3 مرات، وبعدين اسكت */
  function waitAgain(stage) {
    var tries = 0;
    var tick = function () {
      retryTimer = null;
      tries += 1;
      if (dismissed) return;
      if (!busy()) { show(stage); return; }
      if (tries < 3) retryTimer = window.setTimeout(tick, 1500);
    };
    if (retryTimer) window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(tick, 1500);
  }

  /* ─── العدّادات والنشاط ────────────────────────────────────────────────── */
  /*   EXIT_AFTER على كل المسارات: S3 ما تسبقش 25 ثانية سواء خرج الماوس من الحافة
       العليا، أو طلع الزائر من التبويب، أو وقف فوق الصفحة. (المسار الأخير كان
       بلا بوابة عمر — خطأ ترتيب: كان ممكن يقابل الزائر S3 قبل S1.)
       EXIT_RETRY: التفويت الصامت كان بيحصل لما الزائر يلفّف ويقفل على طول،
       فنعيد قياس الهدوء مرة واحدة بعد 800 مللي بدل ما نسكت خالص.
       TOP_STILL: مسار اللمس الوحيد — الموبايل مفيهوش pointerout من حافة علّي. */
  var EXIT_AFTER = 25000, IDLE_MS = 3000, EXIT_RETRY = 800;
  var TOP_STILL = 2500, TOP_Y = 8;
  var idleRetryTimer = null, topStillTimer = null;

  function mark() { lastActivity = Date.now(); }

  function watchActivity() {
    window.addEventListener('scroll', function () { mark(); watchTopStillness(); }, { passive: true });
    window.addEventListener('pointerdown', mark, { passive: true });
    window.addEventListener('keydown', mark, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') mark();
      else maybeExitIntent();
    });
    /* ضغطة على بطاقة عقار = الزائر مشغول بنفسه ⇒ لا S1 */
    document.addEventListener('click', function (e) {
      var a = e.target && e.target.closest ? e.target.closest('a') : null;
      if (a && /\/properties\/[^/]+\/?$/.test(a.getAttribute('href') || '')) clickedCard = true;
    }, { passive: true, capture: true });
  }

  var exitFired = false;

  function maybeExitIntent(minIdle) {
    if (off || dismissed || exitFired) return;
    if (!elapsedSinceLoad(EXIT_AFTER)) return;
    if (!idleFor(typeof minIdle === 'number' ? minIdle : IDLE_MS)) { scheduleIdleRetry(); return; }
    exitFired = true;
    show('S3');
  }

  function scheduleIdleRetry() {
    if (idleRetryTimer || exitFired) return;
    idleRetryTimer = window.setTimeout(function () {
      idleRetryTimer = null;
      maybeExitIntent(EXIT_RETRY);   // في المحاولة التانية: 800 مللي سكوت كفاية
    }, EXIT_RETRY);
  }

  /* مسار اللمس: رجوع لأعلى الصفحة + ثبات 2.5 ثانية، وبعد ما S1 تكون اتعرضت وانقفلت.
     دايمًا مش وقت ما الفقاعة ظاهرة (current)، ومش أكتر من عدّاد واحد للهدوء الحالي. */
  function watchTopStillness() {
    if (off || dismissed || exitFired || current || !fired.S1) return;
    if (((window.scrollY || 0) + (document.documentElement.scrollTop || 0)) > TOP_Y) return;
    if (topStillTimer) return;
    topStillTimer = window.setTimeout(function () {
      topStillTimer = null;
      maybeExitIntent(TOP_STILL);
    }, TOP_STILL);
  }

  function onLeave(e) {
    if (e && e.relatedTarget) return;
    if (e && typeof e.clientY === 'number' && e.clientY > 4) return;
    maybeExitIntent();   // بوابة العمر صارت داخل maybeExitIntent (مسار واحد لكل الطرق)
  }

  var loadedAt = Date.now();
  function elapsedSinceLoad(ms) { return (Date.now() - loadedAt) >= ms; }

  function schedule() {
    loadedAt = Date.now();
    if (disabled()) { off = true; return; }
    watchActivity();

    document.addEventListener('pointerout', onLeave, { passive: true });
    document.addEventListener('mouseleave', onLeave, { passive: true });
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && current) closeNudge(current, 'x');
    }, { passive: true });

    window.setTimeout(function () { show('S0'); }, 1200);
    window.setTimeout(function () {
      // 20 ثانية هدوء: لو داس على بطاقة عقار فهو مشغول بنفسه ⇒ لا تحية.
      if (dismissed || fired.S1 || clickedCard) return;
      show('S1');
    }, 20000);
  }

  if (document.readyState === 'complete') schedule();
  else window.addEventListener('load', schedule, { once: true });
})();
