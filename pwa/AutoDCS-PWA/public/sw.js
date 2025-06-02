/*  sw.js  ▸ Android / iOS 공통 푸시 핸들러  */
const CACHE = 'pwa-cache-v3.0.0';
const ASSETS = [
  '/', '/index.html', '/manifest.json', '/sw.js',
  '/icons/icon-152.png', '/icons/icon-192.png', '/icons/icon-512.png'
];

/* ---------- 앱 캐싱 ---------- */
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)));
});
self.addEventListener('fetch', e => {
  e.respondWith(
    caches.match(e.request).then(res => res || fetch(e.request))
  );
});

/* ---------- 푸시 수신 ---------- */
self.addEventListener('push', e => {
  /*   Chrome(Android) → event.data 가 암호화된 JSON
       Safari(iOS)     → event.data 가 text / 또는 null                */
  let payload = { title: 'CNU Todo', message: '새 알림이 도착했습니다.' };

  if (e.data) {
    try {                      // Chrome( JSON )
      payload = e.data.json();
    } catch {
      payload.message = e.data.text();     // iOS(WebKit) text fallback
    }
  }

  const opts = {
    body : payload.message,
    icon : '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    vibrate: [100, 50, 100]                // Android 시각 확인용
  };
  e.waitUntil(self.registration.showNotification(payload.title, opts));
});

/* ---------- 알림 클릭 ---------- */
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then(list => list.length ? list[0].focus() : clients.openWindow('/'))
  );
});