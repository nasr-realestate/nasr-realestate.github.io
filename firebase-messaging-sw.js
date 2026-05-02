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

messaging.onBackgroundMessage((payload) => {
  const notificationTitle = payload.notification.title;
  const notificationOptions = {
    body: payload.notification.body,
    icon: 'https://nasr-realestate.github.io/assets/img/logo.webp',
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const urlToOpen = event.notification.data?.FCM_MSG?.notification?.click_action || 'https://nasr-realestate.github.io/';
  event.waitUntil(clients.openWindow(urlToOpen));
});
