/* Private CRM Web Push & PWA Service Worker — zero offline storage, same-origin only */

self.addEventListener('install', event => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', event => {
  event.waitUntil(self.clients.claim());
});

// Network-only navigation handler required by Chrome Android WebAPK installability (zero cache storage)
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET' || event.request.mode !== 'navigate') return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  event.respondWith(fetch(event.request));
});

function resolveSafeTargetUrl(rawUrl) {
  try {
    const parsed = new URL(String(rawUrl || '/'), self.location.origin);
    if (parsed.origin === self.location.origin && parsed.pathname.startsWith('/') && !parsed.pathname.startsWith('//')) {
      return parsed.href;
    }
  } catch {
    // Fall back to CRM root on malformed URLs.
  }
  return `${self.location.origin}/`;
}

function parsePushData(event) {
  if (!event.data) return {};
  try {
    return event.data.json() || {};
  } catch {
    try {
      return { body: event.data.text() };
    } catch {
      return {};
    }
  }
}

self.addEventListener('push', event => {
  const data = parsePushData(event);
  const title = typeof data.title === 'string' && data.title.trim()
    ? data.title.trim().slice(0, 120)
    : 'إدارة العملاء — سمسار طلبك';
  const body = typeof data.body === 'string' ? data.body.trim().slice(0, 200) : 'لديك تنبيه متابعة جديد في الـCRM.';
  const options = {
    body,
    icon: '/crm-assets/icon-192.png',
    badge: '/crm-assets/icon-192.png',
    lang: 'ar',
    dir: 'rtl',
    renotify: Boolean(data.tag),
    data: { url: resolveSafeTargetUrl(data.url) },
  };
  if (typeof data.tag === 'string' && data.tag.trim()) {
    options.tag = data.tag.trim().slice(0, 64);
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = resolveSafeTargetUrl(event.notification?.data?.url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});
