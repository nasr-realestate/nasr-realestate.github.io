// استيراد مكتبات Firebase الأساسية (الإصدار الحديث)
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// تهيئة Firebase في الـ Service Worker
const firebaseConfig = {
    apiKey: "AIzaSyDi8uX4d6jruwmoqmjKp44iEAF4aWsrvpI",
    projectId: "simsar-talabak",
    messagingSenderId: "531743139625",
    appId: "1:367123992147:web:86518a4d46c813d9943444"
};

// تهيئة Firebase
firebase.initializeApp(firebaseConfig);

// الحصول على خدمة المراسلة
const messaging = firebase.messaging();

// معالجة الرسائل في الخلفية (عندما يكون التطبيق غير مفتوح)
messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);

    // بناء الإشعار
    const notificationTitle = payload.notification?.title || "تحديث جديد في سمسار طلبك!";
    const notificationOptions = {
        body: payload.notification?.body || "تم إضافة عرض جديد، اضغط للمعاينة.",
        icon: 'https://nasr-realestate.github.io/logo.png',
        badge: 'https://nasr-realestate.github.io/logo.png',
        data: {
            click_action: payload.data?.click_action || 'https://nasr-realestate.github.io/'
        }
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});

// إضافة معالج الضغط على الإشعار (اختياري لكن مفيد)
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const urlToOpen = event.notification.data?.click_action || 'https://nasr-realestate.github.io/';
    event.waitUntil(
        clients.openWindow(urlToOpen)
    );
});
