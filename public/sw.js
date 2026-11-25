/* CuidAção — Service Worker (PWA)
 * - App shell em cache (abre mesmo sem internet)
 * - Bibliotecas de CDN (Tailwind/Leaflet): stale-while-revalidate
 * - Tiles do mapa: cache com limite (mapa visitado continua visível offline)
 * - API de locais/alertas: rede primeiro, com os últimos dados como reserva offline
 */
const VERSION = 'v6';
const SHELL_CACHE = 'cuidacao-shell-' + VERSION;
const RUNTIME_CACHE = 'cuidacao-runtime-' + VERSION;
const TILE_CACHE = 'cuidacao-tiles-' + VERSION;
const API_CACHE = 'cuidacao-api-' + VERSION;
const MAX_TILES = 400;

// Mantenha estes caminhos iguais aos do index.html (incluindo o ?v=)
const SHELL_ASSETS = [
  './',
  'index.html',
  'comunidade.html',
  'css/styles.css?v=6',
  'js/config.js',
  'js/map/live-gps.js?v=6',
  'js/map/pharmacies-data.js?v=6',
  'js/map/pharmacy-layer.js?v=6',
  'js/app.js?v=6',
  'manifest.json',
  'icons/icon-192.png',
  'icons/icon-512.png'
];

const CDN_HOSTS = ['cdn.tailwindcss.com', 'unpkg.com', 'accounts.google.com'];
const TILE_HOSTS = ['tile.openstreetmap.org', 'server.arcgisonline.com'];
const CACHEABLE_API = ['/api/v1/locations', '/api/v1/reports'];

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

  // Bibliotecas externas
  if (CDN_HOSTS.includes(url.hostname)) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  if (url.origin !== self.location.origin) return;

  // API própria: só listas públicas ficam disponíveis offline
  if (url.pathname.startsWith('/api/')) {
    if (CACHEABLE_API.some((p) => url.pathname === p)) {
      event.respondWith(networkFirst(req, API_CACHE, 4000));
    }
    return;
  }

  // Navegação: rede primeiro; offline abre o app shell
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).catch(() => caches.match('index.html').then((r) => r || caches.match('./')))
    );
    return;
  }

  // Demais arquivos do app (css/js/ícones)
  event.respondWith(staleWhileRevalidate(req, SHELL_CACHE));
});

