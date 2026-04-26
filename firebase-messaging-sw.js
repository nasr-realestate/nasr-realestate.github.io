importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

firebase.initializeApp({
  apiKey: "AIzaSyBZxGDQ-N-Sue4GdoAmCfoUjeRkmAbdCZU",
  authDomain: "simsartalabak.firebaseapp.com",
  projectId: "simsartalabak",
  storageBucket: "simsartalabak.firebasestorage.app",
  messagingSenderId: "733807203688",
  appId: "1:733807203688:web:a0582925001409994e32dd"
});

const messaging = firebase.messaging();
