// App shell is fetched fresh when online (so updates arrive) and served from cache when offline. Data lives in IndexedDB.
const CACHE = 'church-shell-v18';
const SHELL = ['./', 'index.html', 'style.css', 'manifest.webmanifest', 'js/main.js', 'js/sync.js', 'js/store.js', 'js/ui.js', 'js/icons.js', 'js/config.js', 'js/csv.js', 'js/importers.js',
  'js/views/dashboard.js', 'js/views/members.js', 'js/views/ministries.js', 'js/views/attendance.js', 'js/views/finance.js',
  'js/views/reports.js', 'js/views/people.js', 'js/views/programmes.js', 'js/views/settings.js',
  'brand/logo-192.png', 'brand/logo-512.png', 'brand/favicon-32.png', 'brand/favicon-16.png', 'brand/favicon.ico', 'brand/apple-touch-icon.png'];

// skipWaiting + clients.claim: a new version takes over immediately instead of
// sitting "waiting" until every tab is closed (the default service-worker lifecycle).
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL))); });
self.addEventListener('activate', (e) => e.waitUntil(
  caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())));
self.addEventListener('fetch', (e) => {
  const u = new URL(e.request.url);
  if (e.request.method !== 'GET' || u.origin !== location.origin) return; // API calls pass through
  e.respondWith(fetch(e.request).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); } return r; }).catch(() => caches.match(e.request)));
});
