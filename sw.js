/* ═══════════════════════════════════════════════════════════════
   Service Worker — «سمسار طلبك» (وكيل طارق طنطاوي)
   ─────────────────────────────────────────────────────────────
   الغرض: جعل الموقع PWA قابلة للتثبيت فعلياً (manifest لوحده لا يكفي).
   النطاق: "/" — الملف في روت المستودع، لذلك يتحكم في كل الموقع.

   ⚠️ قواعد السلامة المطبقة هنا:
   • لا كاش لأي طلب غير GET، ولا لأي أصل خارجي (الخطوط / الـ Worker / Firebase).
   • لا كاش للمسارات الحساسة: /upload-images و /api/ ... إلخ.
   • لا نحفظ إلا الاستجابات الناجحة (200) من نفس الأصل (basic).
   • الاستراتيجية: Network-First مع السقوط على الكاش عند انقطاع الشبكة.
   ═══════════════════════════════════════════════════════════════ */

const CACHE_NAME = 'smsar-v1';
const OFFLINE_URL = '/agent.html';

const PRECACHE_URLS = [
  '/',
  '/agent.html',
  '/assets/css/style.css',
  '/assets/img/logo.webp',
  '/manifest.json',
];

// ملفات/مسارات محظور تخزينها في الكاش (بيانات مستخدم أو رفع صور أو API)
const NEVER_CACHE = ['/upload-images', '/api/'];

// ─── التثبيت: تجهيز الكاش بالقشرة الأساسية ───
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => Promise.all(
        PRECACHE_URLS.map((url) =>
          // كل ملف على حدة — فشل ملف واحد لا يُسقط التثبيت كله
          cache.add(new Request(url, { cache: 'reload' })).catch(() => {})
        )
      ))
      .then(() => self.skipWaiting())
  );
});

// ─── التنشيط: مسح الكاشات القديمة + السيطرة على الصفحات المفتوحة ───
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

// ═══════════════════════════════════════════════════════════════
// إشعارات Web Push (VAPID) — 2026-10-10
// ───────────────────────────────────────────────────────────────
// ⚠️ قواعد السلامة:
// • هذا هو Service Worker الوحيد بنطاق "/" — لا يُسجَّل غيره.
// • معالجات الإشعارات مستقلة عن الكاش ولا تغيّره إطلاقًا.
// • رابط الضغط على الإشعار يُقيَّد بالموقع الرسمي فقط (ضد أي إساءة).
// ═══════════════════════════════════════════════════════════════
const PUSH_SITE_ORIGIN = 'https://nasr-realestate.github.io';

// روابط الإشعارات: نفس الأصل فقط — أي رابط آخر يُعاد توجيهه للرئيسية
function safeNotificationUrl(raw) {
  try {
    const u = new URL(String(raw || ''), PUSH_SITE_ORIGIN + '/');
    if (u.origin === PUSH_SITE_ORIGIN && u.pathname.charAt(0) === '/' && u.pathname.charAt(1) !== '/') {
      return u.href;
    }
  } catch (_) { /* ignore */ }
  return PUSH_SITE_ORIGIN + '/';
}

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    try { data = { body: event.data ? event.data.text() : '' }; } catch (__) { /* ignore */ }
  }
  const title = (typeof data.title === 'string' && data.title.trim())
    ? data.title.trim().slice(0, 140) : 'سمسار طلبك';
  const body = (typeof data.body === 'string') ? data.body.trim().slice(0, 180) : '';
  const options = {
    body: body,
    icon: '/assets/img/logo.webp',
    badge: '/assets/img/icon-192.png',
    lang: 'ar',
    dir: 'rtl',
    data: { url: safeNotificationUrl(data.url) },
  };
  if (typeof data.tag === 'string' && data.tag) options.tag = data.tag.slice(0, 64);
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = safeNotificationUrl(event.notification.data && event.notification.data.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (decodeURIComponent(client.url) === decodeURIComponent(targetUrl) && 'focus' in client) {
            return client.focus();
          }
        }
        return self.clients.openWindow(targetUrl);
      })
  );
});

// ─── الجلب: Network-First مع fallback للكاش ───
self.addEventListener('fetch', (event) => {
  const request = event.request;

  // لا نتعامل إلا مع GET
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // نفس الأصل فقط (الخطوط/الـ Cloudflare Worker/Firebase تُترك للمتصفح)
  if (url.origin !== self.location.origin) return;

  // ممنوع كاش للرفع أو الـ API أو طلبات النطاقات (Range)
  if (NEVER_CACHE.some((p) => url.pathname.indexOf(p) === 0)) return;
  if (request.headers.has('range')) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        // نحفظ فقط الاستجابات الناجحة من نفس الأصل
        if (response && response.status === 200 && response.type === 'basic') {
          const clone = response.clone();
          caches.open(CACHE_NAME)
            .then((cache) => cache.put(request, clone))
            .catch(() => {});
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then((cached) =>
          cached || (request.mode === 'navigate' ? caches.match(OFFLINE_URL) : undefined)
        )
      )
  );
});
