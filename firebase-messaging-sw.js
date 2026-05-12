importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyBZxGDQ-N-Sue4GdoAmCfoUjeRkmAbdCZU",
  authDomain: "simsartalabak.firebaseapp.com",
  projectId: "simsartalabak",
  storageBucket: "simsartalabak.firebasestorage.app",
  messagingSenderId: "733807203688",
  appId: "1:733807203688:web:a0582925001409994e32dd"
});

const messaging = firebase.messaging();

// ✅ يقرأ من data فقط — الـ SW يتحكم في كل شيء
messaging.onBackgroundMessage((payload) => {
  self.registration.showNotification(payload.data.title, {
    body: payload.data.body,
    icon: 'https://nasr-realestate.github.io/assets/img/logo.webp',
    data: { url: payload.data.url }
  });
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const targetUrl = event.notification.data?.url
    || 'https://nasr-realestate.github.io/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        for (const client of clientList) {
          if (decodeURIComponent(client.url) === decodeURIComponent(targetUrl) && 'focus' in client)
            return client.focus();
        }
        return clients.openWindow(targetUrl);
      })
  );
});
