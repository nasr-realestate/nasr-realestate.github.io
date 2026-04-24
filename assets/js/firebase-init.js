// استيراد مكتبات Firebase الأساسية (النموذج الوحدوي - Modular SDK)
// يجب أن تكون هذه المسارات متاحة عند النشر، لذا تأكد من أنها صحيحة.
// إذا كنت تستخدم npm أو yarn لتثبيت firebase، فستحتاج إلى بناء ملف الـ Service Worker بشكل مختلف.
// ولكن إذا كنت تستخدم الروابط المباشرة، فهذه هي الروابط الصحيحة للنسخة الوحدوية الحديثة (أكثر من v9).
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/9.22.0/firebase-messaging-compat.js');

// تهيئة Firebase في الـ Service Worker
// استخدم Project ID أو أرقام المشروع من إعدادات مشروعك في Firebase Console.
// يجب أن يكون messagingSenderId هو Project Number الخاص بك.
// Project Number: 531743139625
const firebaseConfig = {
    messagingSenderId: "531743139625",
    // يمكنك إضافة المزيد من مفاتيح التهيئة هنا إذا لزم الأمر،
    // لكن for a service worker, messagingSenderId is often sufficient.
};

// تهيئة Firebase
const app = firebase.initializeApp(firebaseConfig);

// الحصول على خدمة المراسلة
const messaging = firebase.messaging();

// معالجة الرسائل في الخلفية (عندما يكون التطبيق غير مفتوح أو في الخلفية)
messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Received background message ', payload);

    // بناء الإشعار
    const notificationTitle = payload.notification.title || "تحديث جديد في سمسار طلبك!";
    const notificationOptions = {
        body: payload.notification.body || "تم إضافة عرض جديد، اضغط للمعاينة.",
        icon: 'https://nasr-realestate.github.io/logo.png', // رابط لوجو موقعك
        badge: 'https://nasr-realestate.github.io/logo.png', // غالبًا ما يكون نفس الأيقونة
        // يمكنك إضافة المزيد من الخيارات هنا، مثل 'click_action'
        // click_action: payload.data.click_action || 'https://nasr-realestate.github.io'
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});
