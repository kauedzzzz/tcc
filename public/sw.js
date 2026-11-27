/* CuidAção — Service Worker (PWA 100% Offline-First)
 * - App shell completo em cache (HTML, Tailwind estático, Leaflet local, ícones e imagens locais)
 * - Sem dependência de CDNs JIT em runtime: funciona offline no primeiro acesso e no APK Capacitor
 * - Tiles do mapa: cache com limite (mapa visitado continua visível offline)
 * - API de locais/alertas/analytics: rede primeiro, com os últimos dados como reserva offline
 */
const VERSION = 'v7-27f89201dd';
const SHELL_CACHE = 'cuidacao-shell-' + VERSION;
const RUNTIME_CACHE = 'cuidacao-runtime-' + VERSION;
const TILE_CACHE = 'cuidacao-tiles-' + VERSION;
const API_CACHE = 'cuidacao-api-' + VERSION;
const MAX_TILES = 400;

// Validado automaticamente por scripts/build.js e scripts/doctor.js
const SHELL_ASSETS = [
  './',
  'index.html',
  'comunidade.html',
  'painel.html',
  'css/tailwind.min.css',
  'css/styles.css?v=7',
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/markercluster/MarkerCluster.css',
  'vendor/markercluster/MarkerCluster.Default.css',
  'vendor/markercluster/leaflet.markercluster.js',
  'vendor/leaflet-heat/leaflet-heat.js',
  'images/mata-atlantica.webp',
  'images/mata-atlantica.jpg',
  'js/config.js',
  'js/community/feed.js?v=7',
  'js/map/live-gps.js?v=7',
  'js/map/pharmacies-data.js?v=7',
  'js/map/pharmacy-layer.js?v=7',
  'js/app.js?v=7',
  'manifest.json',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

const CDN_HOSTS = ['accounts.google.com'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];
const CACHEABLE_API = ['/api/v1/locations', '/api/v1/reports', '/api/v1/analytics/summary'];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(SHELL_ASSETS)).catch(() => {}));
});

self.addEventListener('activate', (event) => {
  const keep = [SHELL_CACHE, RUNTIME_CACHE, TILE_CACHE, API_CACHE];
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !keep.includes(k)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

function isStorable(res) {
  return res && (res.ok || res.type === 'opaque');
}

async function trimCache(cacheName, max) {
  const cache = await caches.open(cacheName);
  const keys = await cache.keys();
  if (keys.length > max) {
    await Promise.all(keys.slice(0, keys.length - max).map((k) => cache.delete(k)));
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  const network = fetch(req).then((res) => {
    if (isStorable(res)) cache.put(req, res.clone()).catch(() => {});
    return res;
  }).catch(() => cached);
  return cached || network;
}

async function cacheFirst(req, cacheName, max) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (isStorable(res)) {
      cache.put(req, res.clone()).catch(() => {});
      trimCache(cacheName, max);
    }
    return res;
  } catch {
    return new Response('', { status: 504 });
  }
}

async function networkFirst(req, cacheName, timeoutMs) {
  const cache = await caches.open(cacheName);
  try {
    const res = await Promise.race([
      fetch(req),
      new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs))
    ]);
    if (res && res.ok) cache.put(req, res.clone()).catch(() => {});
    return res;
  } catch {
    const cached = await cache.match(req);
    if (cached) return cached;
    throw new Error('offline');
  }
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Tiles do mapa
  if (TILE_HOSTS.some((h) => url.hostname === h || url.hostname.endsWith('.' + h))) {
    event.respondWith(cacheFirst(req, TILE_CACHE, MAX_TILES));
    return;
  }

  // Google Identity (opcional)
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // Imagens enviadas pela comunidade
  if (url.pathname.startsWith('/api/v1/uploads/')) {
    event.respondWith(cacheFirst(req, RUNTIME_CACHE, 120));
    return;
  }

  // API própria: listas públicas ficam disponíveis offline
  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API.some((p) => url.pathname === p)) {
      event.respondWith(networkFirst(req, API_CACHE, 4000));
    }
    return;
  }

  // Navegação: rede primeiro; offline abre a página correspondente em cache ou o app shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(async () => {
        const pageName = url.pathname.replace(/^\//, '');
        if (pageName) {
          const matched = await caches.match(pageName);
          if (matched) return matched;
        }
        return (await caches.match('index.html')) || caches.match('./');
      })
    );
    return;
  }

  // Demais arquivos do app (css/js/vendors/ícones/imagens)
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});
