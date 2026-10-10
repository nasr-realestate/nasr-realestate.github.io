/* ═══════════════════════════════════════════════════════════════
   تنبيهات «سمسار طلبك» — Web Push عبر Cloudflare Worker (VAPID)
   ─────────────────────────────────────────────────────────────
   2026-10-10 · مستقل تمامًا عن Firebase ومنطق المحادثة.

   ⚠️ القواعد المطبقة هنا:
   • لا يُطلب إذن المتصفح أبدًا تلقائيًا — فقط بعد ضغط المستخدم
     على زر «فعّل التنبيهات».
   • زر «أوقف التنبيهات» متاح دائمًا للمشتركين.
   • عند عدم الدعم (أو iPhone غير مثبَّت كتطبيق) يُعرض بديل واضح:
     واتساب + إرشادات التثبيت على الشاشة الرئيسية.
   • المفتاح العام VAPID يُجلب من الـWorker (/push/config) —
     لا أسرار في هذا الملف إطلاقًا.
   ═══════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var API_BASE = 'https://royal-snow-ea32.footcai-555.workers.dev';
  var WA_LINK = 'https://wa.me/201147758857';
  var PROMPT_DISMISS_KEY = 'nasrPushPrompt';
  // معرّف الاشتراك: الـWorker يعيد { ok: true, id: hash.slice(0,16) } — أي 16 حرفًا hex
  // (بصمة SHA-256 للـendpoint). لا يُحفظ ولا يُعرض أي معرّف خارج هذا الشكل.
  var SUB_ID_KEY = 'nasrPushSubId';
  var SUB_ID_RE = /^[0-9a-f]{16}$/;
  var ID_EMPTY = '—';
  var MSG_ID_FETCH_FAILED = 'تعذر جلب المعرّف — تحقق من الاتصال';
  var MSG_COPY_OK = 'تم النسخ ✓';
  var MSG_COPY_FAILED = 'تعذر النسخ — يمكنك تحديد المعرّف بالأعلى ونسخه يدويًا.';
  var MSG_SAVE_FAILED = 'تم التفعيل في المتصفح، لكن تعذّر حفظ الاشتراك على الخادم — اضغط «فعّل التنبيهات» مرة أخرى.';
  var MSG_NO_SUBSCRIPTION = 'لا يوجد اشتراك فعّال على هذا الجهاز — اضغط «فعّل التنبيهات» أولًا.';
  var COPY_LABEL = 'نسخ معرّف الاشتراك';
  var state = 'loading'; // loading | ready | subscribed | unsupported | ios-guide | denied | unavailable
  var subId = '';            // آخر معرّف معروف (من التخزين المحلي أو من الخادم)
  var pendingRegister = null; // طلب /push/subscribe الجاري — يمنع الطلبات المكررة المتزامنة
  var idRequested = false;    // refresh() جرّبت جلب المعرّف مرة واحدة في هذه الجلسة فقط
  var idFetchFailed = false;  // آخر محاولة تلقائية لجلب المعرّف فشلت (تُعرض الرسالة بلا طلب جديد)
  var pendingCopy = null;     // عملية نسخ جارية — النقر المتكرر لا ينشئ عمليات موازية
  var copyTimer = null;

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function deviceClass() {
    var ua = navigator.userAgent || '';
    if (/iPad|iPhone|iPod/.test(ua)) return 'mobile';
    if (/Android/.test(ua)) return /Mobile/.test(ua) ? 'mobile' : 'tablet';
    if (/Tablet|PlayBook/.test(ua)) return 'tablet';
    return 'desktop';
  }

  function isIosSafari() {
    var ua = navigator.userAgent || '';
    return /iPad|iPhone|iPod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }

  // iOS: Web Push يتطلب تثبيت الموقع كتطبيق (16.4+) وإطلاقه من الشاشة الرئيسية
  function isIosInstalledPwa() {
    return window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  }

  function iosVersion() {
    var m = /OS (\d+)_(\d+)/.exec(navigator.userAgent || '');
    return m ? { major: parseInt(m[1], 10), minor: parseInt(m[2], 10) } : null;
  }

  function supportsWebPush() {
    return 'serviceWorker' in navigator &&
      'PushManager' in window &&
      'Notification' in window &&
      typeof navigator.serviceWorker.getRegistration === 'function';
  }

  function urlBase64ToUint8Array(base64String) {
    var padding = '='.repeat((4 - base64String.length % 4) % 4);
    var base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(base64);
    var output = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i += 1) output[i] = raw.charCodeAt(i);
    return output;
  }

  function api(path, body) {
    return fetch(API_BASE + path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {})
    }).then(function (res) {
      return res.json().catch(function () { return { ok: false, error: 'bad_response' }; });
    });
  }

  function setText(sel, text) {
    $all(sel).forEach(function (el) { el.textContent = text; });
  }

  // ── معرّف الاشتراك: تحقق + تخزين محلي + عرض ─────────────────────────────
  function isValidSubId(id) {
    return typeof id === 'string' && SUB_ID_RE.test(id);
  }

  function readStoredId() {
    try {
      var v = localStorage.getItem(SUB_ID_KEY);
      return isValidSubId(v) ? v : '';
    } catch (e) { return ''; }
  }

  function writeStoredId(id) {
    try { localStorage.setItem(SUB_ID_KEY, id); } catch (e) { /* التخزين معطّل — لا يكسر الصفحة */ }
  }

  function clearStoredId() {
    try { localStorage.removeItem(SUB_ID_KEY); } catch (e) { /* ignore */ }
  }

  function renderSubId() {
    $all('.push-sub-id').forEach(function (el) { el.textContent = subId || ID_EMPTY; });
  }

  // رسالة قصيرة أسفل البطاقة — بنفس نمط .push-hint الموجود (بلا أنماط أو ملفات جديدة)
  function noticePanel() {
    var panels = $all('[data-push-panel]');
    for (var i = 0; i < panels.length; i += 1) {
      if (panels[i] && typeof panels[i].querySelector === 'function' && panels[i].querySelector('.push-sub-id')) return panels[i];
    }
    return panels[0] || null;
  }

  function showNotice(text, isError) {
    var panel = noticePanel();
    if (!panel) return;
    var el = typeof panel.querySelector === 'function' ? panel.querySelector('.push-notice') : null;
    if (!text) { if (el) el.textContent = ''; return; }
    if (!el) {
      el = document.createElement('p');
      el.className = 'push-hint push-notice';
      if (typeof el.setAttribute === 'function') {
        el.setAttribute('role', 'status');
        el.setAttribute('aria-live', 'polite');
      }
      el.style.marginTop = '10px';
      panel.appendChild(el);
    }
    el.textContent = text;
    el.style.color = isError ? '#8c1d18' : '';
  }

  // طلب واحد فقط لحفظ الاشتراك واسترجاع المعرّف — المتزامنات تشترك في نفس الوعد
  function registerSubscription(subscription) {
    if (!subscription || typeof subscription.toJSON !== 'function') {
      return Promise.resolve({ ok: false, error: 'no_subscription' });
    }
    if (pendingRegister) return pendingRegister;
    pendingRegister = api('/push/subscribe', {
      subscription: subscription.toJSON(),
      device: deviceClass()
    }).then(function (result) {
      // العقد الفعلي: { ok: true, id: <16 hex> } — أي رد آخر = فشل (لا نجاح زائفًا)
      if (result && result.ok === true && isValidSubId(result.id)) {
        subId = result.id;
        writeStoredId(subId);
        return { ok: true, id: subId };
      }
      if (result && result.ok === true) return { ok: false, error: 'invalid_id' };
      return { ok: false, error: (result && result.error) || 'subscribe_failed' };
    }).catch(function () {
      return { ok: false, error: 'network' }; // لا يُطبع أي جزء من بيانات الاشتراك
    }).then(function (out) {
      pendingRegister = null;
      return out;
    });
    return pendingRegister;
  }

  // ── الحافظة: API حديث ثم بديل execCommand — والنجاح يُبلَّغ فقط بعد التحقق ──
  function legacyCopy(text) {
    var host = document.body || document.documentElement;
    var ta = null;
    try {
      ta = document.createElement('textarea');
      ta.value = text;
      if (typeof ta.setAttribute === 'function') ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-1000px';
      ta.style.opacity = '0';
      host.appendChild(ta);
      if (typeof ta.select === 'function') ta.select();
      if (typeof ta.setSelectionRange === 'function') ta.setSelectionRange(0, String(text).length);
      return typeof document.execCommand === 'function' ? document.execCommand('copy') === true : false;
    } catch (e) {
      return false;
    } finally {
      if (ta && host && typeof host.removeChild === 'function') host.removeChild(ta);
    }
  }

  function copyToClipboard(text) {
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      return navigator.clipboard.writeText(text).then(
        function () { return true; },
        function () { return legacyCopy(text); }
      );
    }
    return Promise.resolve(legacyCopy(text));
  }

  function setCopyFeedback(ok) {
    if (!ok) return;
    $all('[data-push-copy-id]').forEach(function (btn) {
      btn.textContent = MSG_COPY_OK; // لا يُعرض إلا بعد نجاح النسخ فعليًا
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(function () {
        copyTimer = null;
        $all('[data-push-copy-id]').forEach(function (b) { b.textContent = COPY_LABEL; });
      }, 2500);
    });
  }

  function setCopyBusy(busy) {
    $all('[data-push-copy-id]').forEach(function (btn) { btn.disabled = busy === true; });
  }

  function render() {
    $all('[data-push-panel]').forEach(function (panel) {
      panel.setAttribute('data-push-state', state);
    });
    $all('.push-status-text').forEach(function (el) {
      var messages = {
        loading: 'جارٍ التحقق من حالة التنبيهات…',
        ready: 'اضغط «فعّل التنبيهات» ليصلك كل عرض أو طلب جديد فور نشره.',
        subscribed: 'أنت مشترك ✓ — ستصلك تنبيهات العروض والطلبات الجديدة على هذا الجهاز.',
        unsupported: 'متصفحك لا يدعم تنبيهات الويب. يمكنك متابعة العروض عبر واتساب أو صفحة العقارات.',
        'ios-guide': 'على iPhone/iPad: افتح قائمة المشاركة ⬆︎ ثم «إضافة إلى الشاشة الرئيسية»، وبعد التثبيت افتح التطبيق وفعّل التنبيهات من داخله (يتطلب iOS 16.4 فأحدث).',
        denied: 'الإذن مرفوض حاليًا. فعّله من إعدادات الموقع في المتصفح (رمز القفل 🔒) ثم اضغط «فعّل التنبيهات».',
        unavailable: 'خدمة التنبيهات غير متاحة حاليًا — جرّب لاحقًا أو تابعنا على واتساب.'
      };
      el.textContent = messages[state] || messages.ready;
    });
    $all('[data-push-enable]').forEach(function (btn) {
      btn.disabled = state === 'loading' || state === 'subscribed' || state === 'unsupported' || state === 'ios-guide' || state === 'unavailable';
    });
    $all('[data-push-disable]').forEach(function (btn) {
      btn.disabled = state !== 'subscribed';
    });
    renderSubId();
  }

  function getExistingSubscription() {
    return navigator.serviceWorker.getRegistration()
      .then(function (reg) { return reg ? reg.pushManager.getSubscription() : null; })
      .catch(function () { return null; });
  }

  function refresh() {
    if (!supportsWebPush()) {
      if (isIosSafari()) {
        var ver = iosVersion();
        if (ver && (ver.major < 16 || (ver.major === 16 && ver.minor < 4))) {
          state = 'unsupported';
        } else if (!isIosInstalledPwa()) {
          state = 'ios-guide';
        } else {
          state = 'unavailable';
        }
      } else {
        state = 'unsupported';
      }
      render();
      return Promise.resolve();
    }
    return getExistingSubscription().then(function (sub) {
      if (sub) {
        // الاشتراك الحقيقي في المتصفح هو مصدر الحقيقة — لا قيمة localStorage وحدها
        if (isValidSubId(subId)) { state = 'subscribed'; return null; } // معرّف مؤكَّد سابقًا — بلا طلب شبكة
        if (idRequested) {
          // محاولة سابقة في هذه الجلسة: لا نكرر الطلب، ونعيد عرض نتيجتها
          return idFetchFailed ? { ok: false, error: 'already_attempted' } : null;
        }
        state = 'subscribed';                      // مؤقتًا حتى يؤكد الخادم حفظ الاشتراك
        idRequested = true;
        return registerSubscription(sub);          // طلب واحد فقط لاسترجاع/تسجيل المعرّف
      }
      // لا اشتراك حقيقي في المتصفح → لا نعرض اشتراكًا ولا معرّفًا قديمًا
      if (subId) { subId = ''; clearStoredId(); }
      idFetchFailed = false;
      showNotice('', false);
      if (Notification.permission === 'denied') {
        state = 'denied';
        return null;
      }
      return fetch(API_BASE + '/push/config')
        .then(function (res) { return res.json(); })
        .then(function (cfg) {
          state = (cfg && cfg.enabled) ? 'ready' : 'unavailable';
          return null;
        })
        .catch(function () { state = 'unavailable'; return null; });
    }).then(function (result) {
      if (result && result.ok === false) {
        idFetchFailed = true;
        // الخادم لم يؤكد الاشتراك → لا ندّعي «مشترك»، ونترك زر التفعيل متاحًا لإعادة المحاولة
        state = 'ready';
        showNotice(MSG_ID_FETCH_FAILED, true);
      } else if (result && result.ok === true) {
        idFetchFailed = false;
        state = 'subscribed';
        showNotice('', false);
      }
      render();
    }, function () { state = 'unavailable'; render(); });
  }

  function enablePush() {
    if (!supportsWebPush()) { refresh(); return Promise.resolve(false); }
    return Notification.requestPermission().then(function (permission) {
      if (permission !== 'granted') {
        state = permission === 'denied' ? 'denied' : 'ready';
        render();
        return false;
      }
      return fetch(API_BASE + '/push/config')
        .then(function (res) { return res.json(); })
        .then(function (cfg) {
          if (!cfg || !cfg.enabled || !cfg.publicKey) {
            state = 'unavailable';
            render();
            return false;
          }
          return navigator.serviceWorker.ready.then(function (reg) {
            return reg.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(cfg.publicKey)
            });
          }).then(function (subscription) {
            // الاشتراك في المتصفح وحده لا يكفي: يجب تأكيد حفظه لدى الـWorker
            return registerSubscription(subscription);
          }).then(function (result) {
            if (result && result.ok === true) {
              idRequested = true;   // لا حاجة لطلب آخر عند refresh()
              idFetchFailed = false;
              state = 'subscribed';
              showNotice('', false);
              render();
              return true;
            }
            // المتصفح مشترك لكن الخادم لم يحفظ الاشتراك → لا نعرض نجاحًا زائفًا
            state = 'ready';
            showNotice(MSG_SAVE_FAILED, true);
            render();
            return false;
          });
        })
        .catch(function () {
          state = 'unavailable';
          render();
          return false;
        });
    });
  }

  function disablePush() {
    return getExistingSubscription().then(function (sub) {
      subId = '';
      clearStoredId();
      if (!sub) { state = 'ready'; showNotice('', false); render(); return true; }
      var endpoint = sub.endpoint;
      return api('/push/unsubscribe', { endpoint: endpoint })
        .catch(function () { return { ok: true }; })
        .then(function () { return sub.unsubscribe().catch(function () { return true; }); })
        .then(function () {
          state = 'ready';
          showNotice('', false);
          render();
          return true;
        });
    });
  }

  function performCopy() {
    var known = isValidSubId(subId) ? subId : readStoredId();
    if (known) {
      // المعرّف معروف محليًا → نسخ مباشر داخل تفاعل المستخدم (بلا طلب شبكة)
      subId = known;
      renderSubId();
      return copyToClipboard(known).then(function (ok) { return finishCopy(ok); });
    }
    return getExistingSubscription().then(function (sub) {
      if (!sub) {
        showNotice(MSG_NO_SUBSCRIPTION, true);
        render();
        return { copied: false, reason: 'no_subscription' };
      }
      return registerSubscription(sub).then(function (result) {
        if (result && result.ok === true) {
          render();
          return copyToClipboard(result.id).then(function (ok) { return finishCopy(ok); });
        }
        showNotice(MSG_ID_FETCH_FAILED, true);
        render();
        return { copied: false, reason: 'fetch_failed' };
      });
    }).catch(function () {
      showNotice(MSG_ID_FETCH_FAILED, true);
      render();
      return { copied: false, reason: 'error' };
    });
  }

  function finishCopy(ok) {
    setCopyFeedback(ok === true);
    showNotice(ok === true ? MSG_COPY_OK : MSG_COPY_FAILED, ok !== true);
    return { copied: ok === true };
  }

  function copySubscriptionId() {
    if (pendingCopy) return pendingCopy; // النقرات المتكررة → عملية واحدة فقط
    pendingCopy = Promise.resolve().then(performCopy).then(function (out) {
      pendingCopy = null;
      setCopyBusy(false);
      return out;
    }, function () {
      pendingCopy = null;
      setCopyBusy(false);
      showNotice(MSG_ID_FETCH_FAILED, true);
      return { copied: false, reason: 'error' };
    });
    return pendingCopy;
  }

  function dismissPrompt() {
    try { localStorage.setItem(PROMPT_DISMISS_KEY, '1'); } catch (e) { /* ignore */ }
    $all('.push-banner').forEach(function (el) { el.classList.add('push-banner-hidden'); });
  }

  function maybeShowBanner() {
    var dismissed = false;
    try { dismissed = localStorage.getItem(PROMPT_DISMISS_KEY) === '1'; } catch (e) { /* ignore */ }
    if (dismissed || state !== 'ready') return;
    $all('.push-banner').forEach(function (el) { el.classList.add('push-banner-visible'); });
  }

  function init() {
    subId = readStoredId();   // معرّف محفوظ سابقًا يظهر فورًا (بلا طلب شبكة)
    $all('[data-push-enable]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        btn.disabled = true;
        enablePush().then(function () {
          $all('.push-banner').forEach(function (el) { el.classList.add('push-banner-hidden'); });
        });
      });
    });
    $all('[data-push-disable]').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.preventDefault(); disablePush(); });
    });
    var copyBtn = $('[data-push-copy-id]');
    if (copyBtn && copyBtn.textContent) COPY_LABEL = String(copyBtn.textContent).trim() || COPY_LABEL;
    $all('[data-push-copy-id]').forEach(function (btn) {
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        if (pendingCopy) return;      // النقر المتكرر لا ينشئ عمليات/طلبات موازية
        setCopyBusy(true);
        copySubscriptionId();
      });
    });
    $all('[data-push-dismiss]').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.preventDefault(); dismissPrompt(); });
    });

    if (document.readyState === 'complete') {
      refresh().then(maybeShowBanner);
    } else {
      window.addEventListener('load', function () { refresh().then(maybeShowBanner); });
    }
  }

  window.NasrPush = {
    enable: enablePush,
    disable: disablePush,
    refresh: refresh,
    copyId: copySubscriptionId,
    getState: function () { return state; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
