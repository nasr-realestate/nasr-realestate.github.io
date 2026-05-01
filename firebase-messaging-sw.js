importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js');

// تهيئة Firebase داخل Service Worker
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
    icon: 'https://nasr-realestate.github.io/logo.png',
  };
  self.registration.showNotification(notificationTitle, notificationOptions);
});
