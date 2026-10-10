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
  var state = 'loading'; // loading | ready | subscribed | unsupported | ios-guide | denied | unavailable

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
        state = 'subscribed';
      } else if (Notification.permission === 'denied') {
        state = 'denied';
      } else {
        return fetch(API_BASE + '/push/config')
          .then(function (res) { return res.json(); })
          .then(function (cfg) {
            state = (cfg && cfg.enabled) ? 'ready' : 'unavailable';
          })
          .catch(function () { state = 'unavailable'; });
      }
    }).then(render, function () { state = 'unavailable'; render(); });
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
            return api('/push/subscribe', {
              subscription: subscription.toJSON(),
              device: deviceClass()
            });
          }).then(function (result) {
            if (result && result.ok) {
              state = 'subscribed';
              render();
              return true;
            }
            state = 'unavailable';
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
      if (!sub) { state = 'ready'; render(); return true; }
      var endpoint = sub.endpoint;
      return api('/push/unsubscribe', { endpoint: endpoint })
        .catch(function () { return { ok: true }; })
        .then(function () { return sub.unsubscribe().catch(function () { return true; }); })
        .then(function () {
          state = 'ready';
          render();
          return true;
        });
    });
  }

  function copySubscriptionId() {
    return getExistingSubscription().then(function (sub) {
      if (!sub) return null;
      return api('/push/subscribe', {
        subscription: sub.toJSON(),
        device: deviceClass()
      }).then(function (result) {
        var id = result && result.id ? result.id : '';
        if (id && navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(id).catch(function () { /* ignore */ });
        }
        $all('.push-sub-id').forEach(function (el) { el.textContent = id || '—'; });
        return id;
      });
    });
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
    $all('[data-push-copy-id]').forEach(function (btn) {
      btn.addEventListener('click', function (e) { e.preventDefault(); copySubscriptionId(); });
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
