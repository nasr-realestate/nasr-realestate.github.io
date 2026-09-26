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
