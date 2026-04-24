importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-app.js');
importScripts('https://www.gstatic.com/firebasejs/8.10.1/firebase-messaging.js');

// تهيئة الخدمة ببيانات مشروعك
firebase.initializeApp({
  messagingSenderId: "531743139625"
});

const messaging = firebase.messaging();

// هذه هي "القطعة الناقصة" التي تجعل الإشعار يظهر على الهاتف والموقع مغلق
messaging.onBackgroundMessage(function(payload) {
  console.log('[firebase-messaging-sw.js] Received background message ', payload);
  
  const notificationTitle = payload.notification.title || "عقار جديد في سمسار طلبك!";
  const notificationOptions = {
    body: payload.notification.body || "تم إضافة عرض جديد، اضغط للمعاينة.",
    icon: 'https://nasr-realestate.github.io/logo.png', // رابط لوجو موقعك
    badge: 'https://nasr-realestate.github.io/logo.png'
  };

  return self.registration.showNotification(notificationTitle, notificationOptions);
});
