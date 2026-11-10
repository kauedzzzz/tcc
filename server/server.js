/**
 * =====================================================================================
 * PROJETO TCC: CuidAção - SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP
 * Servidor HTTP Principal, API RESTful, Service Worker PWA, ViaCEP+OSM e Google Auth
 * Cobertura Integral do Guarujá/SP com Priorização Geográfica para o Bairro do Perequê
 * Equipe Back-End & Banco de Dados: Kauê, Igor e Pedro
 * Equipe Front-End & Design do Site: Jamily e Yasmin
 * =====================================================================================
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const scryptAsync = promisify(crypto.scrypt);

const {
  db,
  saveDatabase,
  flushDatabase,
  recomputeLocationMetrics,
  PEREQUE_CENTER,
  GUARUJA_CENTER,
  GUARUJA_PLACES,
  findNearestLocalPlace,
  calculateDistanceMeters,
  hashPassword,
  verifyPassword
} = require('./database');

const PORT = process.env.PORT || 3000;
const IS_PROD = process.env.NODE_ENV === 'production';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const KEEP_DEMO_RATINGS = process.env.KEEP_DEMO_RATINGS === '1';
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const JWT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias (app mobile: evita pedir login todo dia)

// Login "demo" (sem Google real): só em desenvolvimento sem GOOGLE_CLIENT_ID, ou se ALLOW_DEMO_LOGIN=1.
// Em produção, deixe desligado: ele NÃO verifica a posse do e-mail.
const DEMO_LOGIN_ENABLED = process.env.ALLOW_DEMO_LOGIN === '1' || (!IS_PROD && !GOOGLE_CLIENT_ID);

// Origens autorizadas a chamar a API de outro domínio (ex.: o app Capacitor).
// Requisições do próprio site (mesma origem) não precisam de CORS.
const DEFAULT_ORIGINS = ['capacitor://localhost', 'http://localhost', 'https://localhost', 'ionic://localhost'];
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : DEFAULT_ORIGINS).map(o => o.trim()).filter(Boolean)
);
const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.has('*');

// Segredo do JWT: variável de ambiente > arquivo local gerado automaticamente (nunca um valor fixo no código)
const DATA_DIR_FOR_SECRET = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
function loadJwtSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  if (IS_PROD) {
    console.error('❌ Defina a variável JWT_SECRET em produção (ex.: openssl rand -hex 48).');
    process.exit(1);
  }
  const file = path.join(DATA_DIR_FOR_SECRET, '.jwt-secret');
  try {
    return fs.readFileSync(file, 'utf8').trim();
  } catch {
    const generated = crypto.randomBytes(48).toString('hex');
    try { fs.writeFileSync(file, generated, { mode: 0o600 }); } catch { /* usa só em memória */ }
    return generated;
  }
}
const JWT_SECRET = loadJwtSecret();

// Diretório dos arquivos estáticos do site/app (index.html, css, js, ícones, sw.js, manifest)
const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// Área de cobertura (Guarujá/SP, com margem) usada para validar coordenadas de alertas
const COVERAGE = { minLat: -24.12, maxLat: -23.82, minLng: -46.40, maxLng: -46.05 };
function inCoverage(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= COVERAGE.minLat && lat <= COVERAGE.maxLat && lng >= COVERAGE.minLng && lng <= COVERAGE.maxLng;
}

const REPORT_TYPES = ['foco_dengue', 'descarte_irregular', 'terreno_baldio', 'esgoto_ceu_aberto'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// ============================================================================
// LIMITADOR DE REQUISIÇÕES (em memória, por IP) — protege login e escrita
// ============================================================================
const rateBuckets = new Map();
function clientIp(req) {
  if (TRUST_PROXY) {
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
    if (fwd) return fwd;
  }
  return req.socket.remoteAddress || 'unknown';
}
function rateLimited(req, res, bucket, max, windowMs) {
  const key = bucket + ':' + clientIp(req);
  const now = Date.now();
  let entry = rateBuckets.get(key);
  if (!entry || now > entry.reset) {
    entry = { count: 0, reset: now + windowMs };
    rateBuckets.set(key, entry);
  }
  entry.count++;
  if (entry.count > max) {
    const retry = Math.ceil((entry.reset - now) / 1000);
    res.setHeader('Retry-After', String(retry));
    sendJSON(res, 429, { error: 'Muitas tentativas. Aguarde ' + retry + 's e tente novamente.' });
    return true;
  }
  return false;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateBuckets) if (now > v.reset) rateBuckets.delete(k);
}, 60000).unref();

// ============================================================================
// CRIPTOGRAFIA E TOKENS JWT
// ============================================================================
function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + JWT_TTL_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

function verifyJWT(token) {
  try {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + body).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// ============================================================================
// INGESTÃO DE DADOS ABERTOS REAIS (OPENSTREETMAP OVERPASS)
// ============================================================================
function fetchRealOsmPoints(lat, lng, radiusMeters = 6000) {
  return new Promise((resolve) => {
    const overpassQuery = `
      [out:json][timeout:15];
      (
        nwr["amenity"="hospital"](around:${radiusMeters}, ${lat}, ${lng});
        nwr["amenity"="clinic"](around:${radiusMeters}, ${lat}, ${lng});
        nwr["amenity"="doctors"](around:${radiusMeters}, ${lat}, ${lng});
        nwr["amenity"="pharmacy"](around:${radiusMeters}, ${lat}, ${lng});
        nwr["amenity"="recycling"](around:${radiusMeters}, ${lat}, ${lng});
        nwr["leisure"="park"](around:${radiusMeters}, ${lat}, ${lng});
      );
      out center 60;
    `;

    const postData = 'data=' + encodeURIComponent(overpassQuery);

    const req = https.request('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(postData),
        'User-Agent': 'CuidAcaoOneHealthTCC/5.0 (contato-academico@tcc.edu)'
      },
      timeout: 10000
    }, (res) => {
      let rawData = '';
      res.on('data', chunk => rawData += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(rawData);
          const elements = json.elements || [];
          let added = 0;

          elements.forEach((el, i) => {
            const tags = el.tags || {};
            const name = tags.name;
            if (!name) return;

            const elLat = el.lat || (el.center && el.center.lat);
            const elLon = el.lon || (el.center && el.center.lon);
            if (!elLat || !elLon) return;

            const alreadyExists = db.locations.some(l => 
              l.name.toLowerCase() === name.toLowerCase() || 
              calculateDistanceMeters(elLat, elLon, l.lat, l.lng) < 35
            );
            if (alreadyExists) return;

            let catId = 'cat-1';
            let catName = 'UBS / USAFA - Posto de Saúde';
            let domain = 'health';
            let color = '#10B981';
            let iconType = 'clinic';
            let services = ['Atendimento Geral'];

            if (tags.amenity === 'hospital') {
              catId = 'cat-2';
              catName = 'Hospital / UPA 24h';
              color = '#EF4444';
              iconType = 'hospital';
              services = ['Pronto Atendimento', 'Leitos de Internação', 'Emergência'];
            } else if (tags.amenity === 'pharmacy') {
              catId = 'cat-3';
              catName = 'Farmácia Popular';
              color = '#8B5CF6';
              iconType = 'pill';
              services = ['Medicamentos', 'Primeiros Socorros', 'Coleta Consciente'];
            } else if (tags.amenity === 'recycling') {
              catId = 'cat-4';
              catName = 'Ecoponto - Descarte Consciente';
              domain = 'environment';
              color = '#2563EB';
              iconType = 'recycle';
              services = ['Reciclagem Seletiva', 'Logística Reversa', 'Pilhas & Baterias'];
            } else if (tags.leisure === 'park') {
              catId = 'cat-5';
              catName = 'Parque & Área Verde (Mata Atlântica)';
              domain = 'environment';
              color = '#059669';
              iconType = 'tree';
              services = ['Área Verde', 'Lazer Comunitário', 'Caminhada ao Ar Livre'];
            }

            const nearest = findNearestLocalPlace(elLat, elLon);
            const fallbackSuburb = nearest.distance <= 5000 ? nearest.place.neighborhood : 'Guarujá';
            const street = tags['addr:street']
              ? `${tags['addr:street']}${tags['addr:housenumber'] ? ', ' + tags['addr:housenumber'] : ''}`
              : `Próximo a ${nearest.place.name}`;
            const suburb = tags['addr:suburb'] || tags['addr:neighbourhood'] || fallbackSuburb;
            const city = tags['addr:city'] || 'Guarujá';
            const is24h = tags.amenity === 'hospital' || tags.leisure === 'park' || tags.opening_hours === '24/7';
            const hours = is24h ? {
              '0': { open: '00:00', close: '23:59' },
              '1': { open: '00:00', close: '23:59' },
              '2': { open: '00:00', close: '23:59' },
              '3': { open: '00:00', close: '23:59' },
              '4': { open: '00:00', close: '23:59' },
              '5': { open: '00:00', close: '23:59' },
              '6': { open: '00:00', close: '23:59' }
            } : {
              '1': { open: '08:00', close: '18:00' },
              '2': { open: '08:00', close: '18:00' },
              '3': { open: '08:00', close: '18:00' },
              '4': { open: '08:00', close: '18:00' },
              '5': { open: '08:00', close: '18:00' },
              '6': { open: '08:00', close: '13:00' }
            };

            db.locations.push({
              id: 'osm-' + (el.type || 'x') + '-' + (el.id || i),
              categoryId: catId,
              categoryName: catName,
              domain,
              color,
              iconType,
              name,
              address: `${street} - ${suburb}, ${city} - SP`,
              city,
              state: 'SP',
              lat: elLat,
              lng: elLon,
              services,
              opening_hours: hours,
              avg_wait_time: 0,
              avg_accessibility: 0,
              avg_humanized_care: 0,
              overall_score: 0,
              total_reviews: 0,
              reviews: [],
              source: 'openstreetmap'
            });
            added++;
          });

          if (added > 0) {
            saveDatabase();
          }

          resolve(added);
        } catch {
          resolve(0);
        }
      });
    });

    req.on('error', () => resolve(0));
    req.on('timeout', () => { req.destroy(); resolve(0); });
    req.write(postData);
    req.end();
  });
}

// ============================================================================
// PARSER E HELPERS HTTP
// ============================================================================
// ============================================================================
// SENHAS (scrypt ASSÍNCRONO: não trava o servidor) E AUTENTICAÇÃO POR BEARER TOKEN
// ============================================================================
async function hashPasswordAsync(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const key = await scryptAsync(String(password), salt, 64);
  return `scrypt$${salt}$${key.toString('hex')}`;
}

async function verifyPasswordAsync(password, storedHash) {
  try {
    if (!password || !storedHash) return false;
    if (storedHash.startsWith('scrypt$')) {
      const parts = storedHash.split('$');
      if (parts.length !== 3) return false;
      const original = Buffer.from(parts[2], 'hex');
      const derived = await scryptAsync(String(password), parts[1], 64);
      return derived.length === original.length && crypto.timingSafeEqual(derived, original);
    }
    return verifyPassword(password, storedHash); // hashes SHA-256 legados
  } catch {
    return false;
  }
}

function getAuthUser(req) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  return verifyJWT(token);
}

function publicUser(user, provider) {
  return { id: user.id, name: user.name, email: user.email, picture: user.picture || null, provider: provider || user.provider || 'local' };
}

function todayInBrazil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

const MAX_BODY_BYTES = 100 * 1024;

// Importação em segundo plano com "cooldown" por área
const osmCooldown = new Map();
function maybeImportOsmInBackground(lat, lng, radius) {
  if (calculateDistanceMeters(lat, lng, GUARUJA_CENTER.lat, GUARUJA_CENTER.lng) > 60000) return;
  const key = lat.toFixed(2) + ',' + lng.toFixed(2);
  const last = osmCooldown.get(key) || 0;
  if (Date.now() - last < 10 * 60 * 1000) return;
  osmCooldown.set(key, Date.now());
  fetchRealOsmPoints(lat, lng, Math.min(radius, 10000)).catch(() => {});
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Corpo da requisição muito grande.'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function corsHeaders(req) {
  const origin = req && req.headers ? req.headers.origin : '';
  const headers = {};
  if (origin && (ALLOW_ANY_ORIGIN || ALLOWED_ORIGINS.has(origin))) {
    headers['Access-Control-Allow-Origin'] = ALLOW_ANY_ORIGIN ? '*' : origin;
    headers['Vary'] = 'Origin';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization';
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
  }
  return headers;
}

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(self)'
};

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...SECURITY_HEADERS,
    ...corsHeaders(res.req)
  });
  res.end(JSON.stringify(data));
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8'
};

// Serve arquivos de /public com proteção contra path traversal
function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Requisição inválida.');
  }
  if (rel === '/html/index.html' || rel === '/html/' || rel === '/html') {
    res.writeHead(302, { Location: '/', ...SECURITY_HEADERS });
    return res.end();
  }
  if (rel === '/') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Acesso negado.');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Arquivo não encontrado.');
    }
    const ext = path.extname(filePath).toLowerCase();
    const isIcon = rel.startsWith('/icons/');
    const headers = {
      'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
      'Content-Length': stat.size,
      'Cache-Control': isIcon ? 'public, max-age=604800' : 'no-cache',
      ...SECURITY_HEADERS
    };
    if (rel === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    if (rel === '/manifest.json') headers['Content-Type'] = 'application/manifest+json; charset=utf-8';
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(filePath).pipe(res);
  });
}

// Requisições a serviços externos (ViaCEP / Nominatim / Google) com cache e limite de taxa.
// A política de uso do Nominatim exige no máximo ~1 requisição/segundo e cache de resultados.
const geoCache = new Map();
const GEO_CACHE_TTL_MS = 60 * 60 * 1000;
let nominatimChain = Promise.resolve();

function httpsGetRaw(requestUrl, timeoutMs = 5000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(requestUrl, {
      headers: {
        'User-Agent': 'CuidAcaoOneHealthTCC/6.0 (pesquisa-academica)',
        'Accept-Language': 'pt-BR,pt;q=0.9',
        ...extraHeaders
      },
      timeout: timeoutMs
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

function httpsGet(requestUrl, timeoutMs = 5000, extraHeaders = {}) {
  const hasAuth = Object.keys(extraHeaders).length > 0;
  const host = new URL(requestUrl).hostname;
  const cacheable = !hasAuth && (host === 'nominatim.openstreetmap.org' || host === 'viacep.com.br');
  if (!cacheable) return httpsGetRaw(requestUrl, timeoutMs, extraHeaders);

  const hit = geoCache.get(requestUrl);
  if (hit && Date.now() - hit.at < GEO_CACHE_TTL_MS) return Promise.resolve(hit.value);

  const run = () => httpsGetRaw(requestUrl, timeoutMs).then(value => {
    if (geoCache.size > 500) geoCache.delete(geoCache.keys().next().value);
    geoCache.set(requestUrl, { at: Date.now(), value });
    return value;
  });

  if (host !== 'nominatim.openstreetmap.org') return run();

  // Serializa chamadas ao Nominatim com intervalo de 1,1 s
  const task = nominatimChain.then(run, run);
  nominatimChain = task.then(() => new Promise(r => setTimeout(r, 1100)), () => new Promise(r => setTimeout(r, 1100)));
  return task;
}

// ============================================================================
// SERVIDOR HTTP PRINCIPAL
// ============================================================================
const server = http.createServer(async (req, res) => {
  // WHATWG URL API (substitui o url.parse() depreciado)
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...SECURITY_HEADERS, ...corsHeaders(req) });
    return res.end();
  }

  // Health check (hospedagem e monitoramento)
  if (req.method === 'GET' && pathname === '/api/v1/health') {
    return sendJSON(res, 200, { status: 'ok', uptime: Math.round(process.uptime()), locations: db.locations.length });
  }

  // Site / PWA: qualquer GET que não seja da API é servido da pasta /public
  if ((req.method === 'GET' || req.method === 'HEAD') && !pathname.startsWith('/api/')) {
    return serveStatic(req, res, pathname);
  }

  // Configuração OAuth do Google
  if (req.method === 'GET' && pathname === '/api/v1/auth/google/config') {
    return sendJSON(res, 200, {
      status: 'success',
      clientId: GOOGLE_CLIENT_ID,
      demoLogin: DEMO_LOGIN_ENABLED
    });
  }

  // Geolocalização de Rede / IP Calibrada para o Bairro do Perequê (Guarujá - SP)
  // Em computadores desktop/notebooks na Baixada Santista, o IP da operadora aponta para a central
  // em Santos/Centro do Guarujá/SP. Este endpoint garante ancoragem precisa no Bairro do Perequê.
  if (req.method === 'GET' && pathname === '/api/v1/geo/ip') {
    return sendJSON(res, 200, {
      status: 'success',
      latitude: PEREQUE_CENTER.lat,
      longitude: PEREQUE_CENTER.lng,
      accuracy: 5000,
      isCoarseIp: true,
      approximate: true,
      neighborhood: 'Perequê',
      city: 'Bairro do Perequê, Guarujá',
      state: 'SP'
    });
  }

  // Reverse geocoding de alta precisão (zoom=18 + número + enriquecimento com Gazetteer do Perequê e Guarujá)
  if (req.method === 'GET' && pathname === '/api/v1/geo/reverse') {
    if (rateLimited(req, res, 'geo', 60, 60 * 1000)) return;
    const lat = parseFloat(query.lat);
    const lng = parseFloat(query.lng);

    if (isNaN(lat) || isNaN(lng)) {
      return sendJSON(res, 400, { error: 'lat e lng são obrigatórios' });
    }

    const nearestLocal = findNearestLocalPlace(lat, lng);

    // Se estiver dentro do raio imediato do Perequê (até 1.8 km do centro do Perequê),
    // garante que o bairro "Perequê" apareça explicitamente no endereço
    const distToPereque = calculateDistanceMeters(lat, lng, PEREQUE_CENTER.lat, PEREQUE_CENTER.lng);

    try {
      const geoData = await httpsGet(
        `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lng}&zoom=18&addressdetails=1`,
        4000
      );
      const addr = geoData.address || {};
      const road = addr.road || addr.pedestrian || addr.footway || addr.path || addr.cycleway || '';
      const houseNumber = addr.house_number ? `, ${addr.house_number}` : '';
      const fallbackNeighborhood = distToPereque <= 2000
        ? 'Perequê'
        : (nearestLocal.distance <= 15000 ? nearestLocal.place.neighborhood : '');

      let neighborhood = addr.suburb || addr.neighbourhood || addr.quarter || addr.city_district || addr.residential || addr.village || fallbackNeighborhood;
      if (distToPereque <= 1800 && (!neighborhood || !neighborhood.toLowerCase().includes('perequ'))) {
        neighborhood = 'Perequê';
      }

      const city = addr.city || addr.town || addr.municipality || addr.county || (nearestLocal.distance <= 20000 ? 'Guarujá' : '');
      const state = addr.state_code || addr.state || 'SP';
      const postcode = addr.postcode || '';

      let displayName = '';
      if (road && neighborhood) {
        displayName = `${road}${houseNumber} - ${neighborhood}${city ? ', ' + city : ''}`;
      } else if (neighborhood) {
        displayName = `Bairro ${neighborhood}${city ? ', ' + city : ''} - SP`;
      } else if (road) {
        displayName = `${road}${houseNumber}${city ? ', ' + city : ''}`;
      } else if (geoData.display_name) {
        displayName = geoData.display_name.split(',').slice(0, 3).join(',').trim();
      } else {
        displayName = `${nearestLocal.place.name} - ${nearestLocal.place.city}/SP`;
      }

      return sendJSON(res, 200, {
        status: 'success',
        road: road ? `${road}${houseNumber}` : '',
        neighborhood,
        city,
        state,
        postcode,
        displayName
      });
    } catch {
      if (nearestLocal.distance <= 20000) {
        return sendJSON(res, 200, {
          status: 'fallback',
          road: nearestLocal.place.name,
          neighborhood: nearestLocal.place.neighborhood,
          city: nearestLocal.place.city,
          state: 'SP',
          displayName: `${nearestLocal.place.name} - ${nearestLocal.place.city}/SP`
        });
      }
      return sendJSON(res, 200, {
        status: 'fallback',
        road: '',
        neighborhood: 'Perequê',
        city: 'Guarujá',
        state: 'SP',
        displayName: `Bairro do Perequê, Guarujá - SP`
      });
    }
  }

  // Busca de endereço / rua / número / CEP (ViaCEP + Gazetteer Guarujá Inteiro + Nominatim OSM)
  if (req.method === 'GET' && pathname === '/api/v1/geo/search') {
    if (rateLimited(req, res, 'geo', 60, 60 * 1000)) return;
    const q = (query.q || '').trim();
    const houseNumParam = (query.num || '').trim();

    if (!q) {
      return sendJSON(res, 200, { status: 'success', results: GUARUJA_PLACES.slice(0, 12) });
    }

    const qLower = q.toLowerCase();
    const resultsList = [];

    // 1. Verifica se o usuário digitou um CEP brasileiro (8 dígitos, ex: 11446-000 para Perequê)
    const cepDigits = q.replace(/\D/g, '');
    if (cepDigits.length === 8) {
      // Atalho direto para faixas de CEP do Perequê (11446-xxx)
      if (cepDigits.startsWith('11446')) {
        resultsList.push({
          displayName: `Bairro do Perequê (Estrada Guarujá-Bertioga / CEP ${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}) - Guarujá/SP`,
          neighborhood: 'Perequê',
          city: 'Guarujá',
          lat: PEREQUE_CENTER.lat,
          lng: PEREQUE_CENTER.lng,
          source: 'viacep'
        });
      }

      try {
        const viaCep = await httpsGet(`https://viacep.com.br/ws/${cepDigits}/json/`, 4000);
        if (viaCep && !viaCep.erro && viaCep.logradouro) {
          const numText = houseNumParam ? `, ${houseNumParam}` : '';
          const fullAddressQuery = `${viaCep.logradouro}${numText}, ${viaCep.localidade}, ${viaCep.uf}, Brasil`;
          const osmByCep = await httpsGet(
            `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=4&countrycodes=br&q=${encodeURIComponent(fullAddressQuery)}`,
            4500
          );

          if (Array.isArray(osmByCep) && osmByCep.length > 0) {
            osmByCep.forEach(item => {
              const itemLat = parseFloat(item.lat);
              const itemLng = parseFloat(item.lon);
              if (!isNaN(itemLat) && !isNaN(itemLng)) {
                resultsList.push({
                  displayName: `${viaCep.logradouro}${numText} - ${viaCep.bairro || ''}, ${viaCep.localidade}/${viaCep.uf} (CEP ${viaCep.cep})`,
                  neighborhood: viaCep.bairro || '',
                  city: viaCep.localidade || '',
                  lat: itemLat,
                  lng: itemLng,
                  source: 'viacep'
                });
              }
            });
          } else {
            const streetOnlyQuery = `${viaCep.logradouro}, ${viaCep.localidade}, ${viaCep.uf}`;
            const osmStreet = await httpsGet(
              `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=3&countrycodes=br&q=${encodeURIComponent(streetOnlyQuery)}`,
              4000
            );
            if (Array.isArray(osmStreet)) {
              osmStreet.forEach(item => {
                const itemLat = parseFloat(item.lat);
                const itemLng = parseFloat(item.lon);
                if (!isNaN(itemLat) && !isNaN(itemLng)) {
                  resultsList.push({
                    displayName: `${viaCep.logradouro}${numText} - ${viaCep.bairro || ''}, ${viaCep.localidade}/${viaCep.uf} (CEP ${viaCep.cep})`,
                    neighborhood: viaCep.bairro || '',
                    city: viaCep.localidade || '',
                    lat: itemLat,
                    lng: itemLng,
                    source: 'viacep'
                  });
                }
              });
            }
          }
        }
      } catch {
        // Continua para busca nominal
      }
    }

    // 2. Busca no Gazetteer de alta precisão do Guarujá (Todos os bairros, começando pelo Perequê)
    GUARUJA_PLACES.forEach(p => {
      if (p.name.toLowerCase().includes(qLower) || p.neighborhood.toLowerCase().includes(qLower)) {
        resultsList.push({
          displayName: `${p.name} - ${p.city}/SP`,
          neighborhood: p.neighborhood,
          city: p.city,
          lat: p.lat,
          lng: p.lng,
          source: 'local'
        });
      }
    });

    // 3. Busca nos locais cadastrados
    db.locations.forEach(loc => {
      if (loc.name.toLowerCase().includes(qLower) || loc.address.toLowerCase().includes(qLower)) {
        resultsList.push({
          displayName: `${loc.name} (${loc.address})`,
          neighborhood: loc.city,
          city: loc.city,
          lat: loc.lat,
          lng: loc.lng,
          source: 'db'
        });
      }
    });

    // 4. Busca aberta no OpenStreetMap Nominatim (com número de imóvel se informado)
    try {
      const combinedQuery = houseNumParam ? `${q}, ${houseNumParam}` : q;
      const hasCityHint = qLower.includes('guaruj') || qLower.includes('santos') || qLower.includes('são paulo') || qLower.includes('sp') || qLower.includes(',');
      const primaryQuery = hasCityHint ? combinedQuery : `${combinedQuery}, Guarujá, SP`;

      let osmResults = await httpsGet(
        `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=br&q=${encodeURIComponent(primaryQuery)}`,
        4500
      );

      if ((!Array.isArray(osmResults) || osmResults.length === 0) && !hasCityHint) {
        osmResults = await httpsGet(
          `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=6&countrycodes=br&q=${encodeURIComponent(combinedQuery)}`,
          4500
        );
      }

      if (Array.isArray(osmResults)) {
        osmResults.forEach(item => {
          const itemLat = parseFloat(item.lat);
          const itemLng = parseFloat(item.lon);
          if (!isNaN(itemLat) && !isNaN(itemLng)) {
            const addr = item.address || {};
            const road = addr.road || addr.pedestrian || item.name || '';
            const num = addr.house_number ? `, ${addr.house_number}` : (houseNumParam ? `, ${houseNumParam}` : '');
            const sub = addr.suburb || addr.neighbourhood || addr.quarter || '';
            const city = addr.city || addr.town || addr.municipality || '';
            const shortLabel = road
              ? `${road}${num}${sub ? ' - ' + sub : ''}${city ? ', ' + city : ''}`
              : (item.display_name || '').split(',').slice(0, 3).join(', ');

            resultsList.push({
              displayName: shortLabel,
              neighborhood: sub,
              city: city || 'Guarujá',
              lat: itemLat,
              lng: itemLng,
              source: 'osm'
            });
          }
        });
      }
    } catch {
      // Se Nominatim falhar, retorna os resultados já obtidos
    }

    return sendJSON(res, 200, {
      status: 'success',
      results: resultsList.slice(0, 12)
    });
  }

  // Locations list (Padrão: Guarujá Inteiro 25 km, ordenado pela distância a partir da posição do usuário)
  if (req.method === 'GET' && pathname === '/api/v1/locations') {
    const lat = !isNaN(parseFloat(query.lat)) ? parseFloat(query.lat) : PEREQUE_CENTER.lat;
    const lng = !isNaN(parseFloat(query.lng)) ? parseFloat(query.lng) : PEREQUE_CENTER.lng;
    const radius = Math.min(50000, parseFloat(query.radius) || 25000);
    const domain = query.domain;
    const category = query.category;
    const search = query.search ? query.search.toLowerCase() : '';

    // Poucos pontos por perto? Importa do OpenStreetMap em segundo plano (sem travar a resposta),
    // no máximo 1 vez a cada 10 min por área e só na região de cobertura.
    const nearbyCount = db.locations.filter(l => calculateDistanceMeters(lat, lng, l.lat, l.lng) <= radius).length;
    if (nearbyCount < 3) maybeImportOsmInBackground(lat, lng, radius);

    let results = db.locations.map(loc => {
      const distance = calculateDistanceMeters(lat, lng, loc.lat, loc.lng);
      return { ...loc, distance_meters: distance };
    });

    if (domain && domain !== 'all') {
      results = results.filter(l => l.domain === domain);
    }

    if (category && category !== 'all') {
      results = results.filter(l => l.categoryId === category);
    }

    if (search) {
      results = results.filter(l => 
        l.name.toLowerCase().includes(search) ||
        l.address.toLowerCase().includes(search) ||
        l.services.some(s => s.toLowerCase().includes(search))
      );
    }

    results = results.filter(l => l.distance_meters <= radius);
    results.sort((a, b) => a.distance_meters - b.distance_meters);

    return sendJSON(res, 200, {
      status: 'success',
      count: results.length,
      data: results
    });
  }

  // Location detail
  if (req.method === 'GET' && pathname.startsWith('/api/v1/locations/')) {
    const id = pathname.split('/')[4];
    const loc = db.locations.find(l => l.id === id);
    if (!loc) return sendJSON(res, 404, { error: 'Local não encontrado.' });
    return sendJSON(res, 200, { status: 'success', data: loc });
  }

  // Reports list
  if (req.method === 'GET' && pathname === '/api/v1/reports') {
    return sendJSON(res, 200, {
      status: 'success',
      count: db.reports.length,
      data: db.reports
    });
  }

  // Auth: Cadastro
  if (req.method === 'POST' && pathname === '/api/v1/auth/register') {
    if (rateLimited(req, res, 'auth', 10, 10 * 60 * 1000)) return;
    try {
      const body = await parseBody(req);
      const name = String(body.name || '').trim();
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (name.length < 2 || name.length > 80) return sendJSON(res, 400, { error: 'Informe seu nome (2 a 80 caracteres).' });
      if (email.length > 255 || !EMAIL_RE.test(email)) return sendJSON(res, 400, { error: 'Informe um e-mail válido.' });
      if (password.length < 8 || password.length > 128) return sendJSON(res, 400, { error: 'A senha deve ter de 8 a 128 caracteres.' });
      if (db.users.some(u => u.email.toLowerCase() === email)) return sendJSON(res, 409, { error: 'E-mail já cadastrado.' });

      const passwordHash = await hashPasswordAsync(password);
      if (db.users.some(u => u.email.toLowerCase() === email)) return sendJSON(res, 409, { error: 'E-mail já cadastrado.' });

      const newUser = {
        id: 'usr-' + crypto.randomUUID(),
        name,
        email,
        passwordHash,
        provider: 'local',
        googleId: null,
        picture: null,
        createdAt: new Date().toISOString()
      };
      db.users.push(newUser);
      saveDatabase();

      const user = publicUser(newUser, 'local');
      return sendJSON(res, 201, { status: 'success', token: generateJWT(user), user });
    } catch {
      return sendJSON(res, 400, { error: 'Requisição inválida.' });
    }
  }

  // Auth: Login (scrypt com salt; migra hashes SHA-256 antigos no primeiro acesso)
  if (req.method === 'POST' && pathname === '/api/v1/auth/login') {
    if (rateLimited(req, res, 'auth', 10, 10 * 60 * 1000)) return;
    try {
      const body = await parseBody(req);
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const found = db.users.find(u => u.email.toLowerCase() === email);

      let ok = false;
      if (found && found.passwordHash) {
        ok = await verifyPasswordAsync(password, found.passwordHash);
      } else {
        await scryptAsync('x', 'tempo-constante', 64); // iguala o tempo de resposta (não revela se o e-mail existe)
      }
      if (!ok) return sendJSON(res, 401, { error: 'E-mail ou senha inválidos.' });

      if (!found.passwordHash.startsWith('scrypt$')) {
        found.passwordHash = await hashPasswordAsync(password);
        saveDatabase();
      }

      const user = publicUser(found);
      return sendJSON(res, 200, { status: 'success', token: generateJWT(user), user });
    } catch {
      return sendJSON(res, 400, { error: 'Requisição inválida.' });
    }
  }

  // Auth: Google (token verificado no Google). O modo "demo" só existe em desenvolvimento.
  if (req.method === 'POST' && pathname === '/api/v1/auth/google') {
    if (rateLimited(req, res, 'auth', 20, 10 * 60 * 1000)) return;
    try {
      const body = await parseBody(req);
      let profile = null;
      let provider = 'google';

      if (body.credential || body.accessToken) {
        if (!GOOGLE_CLIENT_ID) {
          return sendJSON(res, 503, { error: 'Login com Google não está configurado neste servidor (defina GOOGLE_CLIENT_ID).' });
        }
        if (body.credential) {
          const info = await httpsGetRaw('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(String(body.credential)), 5000);
          if (info.aud !== GOOGLE_CLIENT_ID) throw new Error('Token emitido para outro aplicativo.');
          if (!['accounts.google.com', 'https://accounts.google.com'].includes(info.iss)) throw new Error('Emissor do token inválido.');
          profile = {
            email: String(info.email || '').trim().toLowerCase(),
            name: info.name || info.given_name || '',
            picture: info.picture || '',
            sub: info.sub || '',
            verified: String(info.email_verified) === 'true'
          };
        } else {
          const tokenInfo = await httpsGetRaw('https://oauth2.googleapis.com/tokeninfo?access_token=' + encodeURIComponent(String(body.accessToken)), 5000);
          if ((tokenInfo.aud || tokenInfo.azp) !== GOOGLE_CLIENT_ID) throw new Error('Token emitido para outro aplicativo.');
          const ui = await httpsGetRaw('https://www.googleapis.com/oauth2/v3/userinfo', 5000, { Authorization: 'Bearer ' + body.accessToken });
          profile = {
            email: String(ui.email || '').trim().toLowerCase(),
            name: ui.name || ui.given_name || '',
            picture: ui.picture || '',
            sub: ui.sub || '',
            verified: ui.email_verified === true || ui.email_verified === 'true'
          };
        }
        if (!profile.email || !profile.verified) {
          return sendJSON(res, 403, { error: 'O e-mail da conta Google não está verificado.' });
        }
      } else if (body.email) {
        if (!DEMO_LOGIN_ENABLED) {
          return sendJSON(res, 403, { error: 'Entrar apenas com e-mail do Google está desativado neste servidor. Use o botão do Google ou e-mail e senha.' });
        }
        const demoEmail = String(body.email).trim().toLowerCase();
        if (demoEmail.length > 255 || !EMAIL_RE.test(demoEmail)) return sendJSON(res, 400, { error: 'Informe um e-mail válido.' });
        provider = 'demo';
        profile = {
          email: demoEmail,
          name: String(body.name || demoEmail.split('@')[0]).trim().slice(0, 80),
          picture: '',
          sub: 'demo-' + crypto.createHash('sha256').update(demoEmail).digest('hex').slice(0, 16),
          verified: false
        };
      } else {
        return sendJSON(res, 400, { error: 'Credencial do Google não informada.' });
      }

      if (!profile.name) {
        profile.name = profile.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
      }

      let user = db.users.find(u => u.email.toLowerCase() === profile.email);

      if (user && provider === 'demo' && user.provider !== 'demo') {
        return sendJSON(res, 403, { error: 'Este e-mail já pertence a uma conta cadastrada. Entre pelo método original dessa conta.' });
      }

      if (!user) {
        user = {
          id: 'usr-' + crypto.randomUUID(),
          googleId: profile.sub,
          name: profile.name,
          email: profile.email,
          passwordHash: null,
          provider,
          picture: profile.picture || null,
          createdAt: new Date().toISOString()
        };
        db.users.push(user);
      } else {
        // Token Google verificado: vincula à conta existente (local ou demo) e promove demo -> google
        if (provider === 'google') {
          user.googleId = profile.sub || user.googleId;
          if (user.provider === 'demo') user.provider = 'google';
        }
        if (profile.picture) user.picture = profile.picture;
        if (!user.name) user.name = profile.name;
      }
      saveDatabase();

      const publicInfo = publicUser(user, provider === 'demo' ? 'demo' : 'google');
      return sendJSON(res, 200, { status: 'success', token: generateJWT(publicInfo), user: publicInfo });
    } catch (err) {
      return sendJSON(res, 400, { error: 'Não foi possível autenticar com o Google: ' + (err.message || 'Erro desconhecido') });
    }
  }

  // Avaliações (usuário autenticado; 1 por usuário/local/dia; notas obrigatórias de 1 a 5)
  if (req.method === 'POST' && pathname.startsWith('/api/v1/locations/') && pathname.endsWith('/reviews')) {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para avaliar este local.' });
    if (rateLimited(req, res, 'write', 30, 60 * 60 * 1000)) return;

    const locationId = pathname.split('/')[4];
    const loc = db.locations.find(l => l.id === locationId);
    if (!loc) return sendJSON(res, 404, { error: 'Local não encontrado.' });

    try {
      const body = await parseBody(req);
      const [wait, access, care] = [body.rating_wait_time, body.rating_accessibility, body.rating_humanized_care].map(Number);
      if ([wait, access, care].some(v => !Number.isInteger(v) || v < 1 || v > 5)) {
        return sendJSON(res, 400, { error: 'As três notas devem ser números inteiros de 1 a 5.' });
      }

      const today = todayInBrazil();
      if (!Array.isArray(loc.reviews)) loc.reviews = [];
      if (loc.reviews.some(r => r.userId === user.id && r.date === today)) {
        return sendJSON(res, 409, { error: 'Você já avaliou este local hoje. Volte amanhã para registrar uma nova avaliação.' });
      }

      loc.reviews.unshift({
        id: 'rev-' + crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        wait,
        access,
        care,
        comment: String(body.comment || '').trim().slice(0, 500),
        date: today
      });

      if (KEEP_DEMO_RATINGS) {
        // Modo demonstração: mantém as notas fictícias do seed e apenas incorpora a nova avaliação
        loc.total_reviews += 1;
        const count = loc.total_reviews;
        loc.avg_wait_time = parseFloat(((loc.avg_wait_time * (count - 1) + wait) / count).toFixed(1));
        loc.avg_accessibility = parseFloat(((loc.avg_accessibility * (count - 1) + access) / count).toFixed(1));
        loc.avg_humanized_care = parseFloat(((loc.avg_humanized_care * (count - 1) + care) / count).toFixed(1));
        loc.overall_score = parseFloat(((loc.avg_wait_time + loc.avg_accessibility + loc.avg_humanized_care) / 3).toFixed(1));
      } else {
        recomputeLocationMetrics(loc);
      }

      saveDatabase();
      return sendJSON(res, 201, { status: 'success', message: 'Avaliação registrada com sucesso!', location: loc });
    } catch {
      return sendJSON(res, 400, { error: 'Erro ao processar avaliação.' });
    }
  }

  // Alertas ambientais (usuário autenticado; tipo e coordenadas validados)
  if (req.method === 'POST' && pathname === '/api/v1/reports') {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para registrar alertas ambientais.' });
    if (rateLimited(req, res, 'write', 30, 60 * 60 * 1000)) return;

    try {
      const body = await parseBody(req);
      const title = String(body.title || '').trim();
      const description = String(body.description || '').trim();
      const address = String(body.address || 'Localização selecionada no mapa').trim();
      const repLat = parseFloat(body.lat);
      const repLng = parseFloat(body.lng);
      const reportType = body.report_type || 'foco_dengue';

      if (title.length < 3 || title.length > 120) return sendJSON(res, 400, { error: 'O título deve ter de 3 a 120 caracteres.' });
      if (!REPORT_TYPES.includes(reportType)) return sendJSON(res, 400, { error: 'Tipo de alerta inválido.' });
      if (description.length > 1000) return sendJSON(res, 400, { error: 'A descrição deve ter no máximo 1000 caracteres.' });
      if (address.length > 255) return sendJSON(res, 400, { error: 'O endereço deve ter no máximo 255 caracteres.' });
      if (!inCoverage(repLat, repLng)) return sendJSON(res, 422, { error: 'O local do alerta está fora da área de cobertura (Guarujá/SP).' });

      const newReport = {
        id: 'rep-' + crypto.randomUUID(),
        title,
        report_type: reportType,
        description,
        address,
        lat: repLat,
        lng: repLng,
        status: 'pending',
        date: todayInBrazil(),
        reporterName: user.name
      };

      db.reports.unshift(newReport);
      saveDatabase();
      return sendJSON(res, 201, { status: 'success', report: newReport });
    } catch {
      return sendJSON(res, 400, { error: 'Erro ao processar alerta ambiental.' });
    }
  }

  // Importação sob demanda de pontos do OpenStreetMap (exige login; limitada em área e frequência)
  if (req.method === 'POST' && pathname === '/api/v1/seed/osm-live') {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Entre na sua conta para buscar novos pontos no OpenStreetMap.' });
    if (rateLimited(req, res, 'osm', 5, 10 * 60 * 1000)) return;
    try {
      const body = await parseBody(req);
      const lat = parseFloat(body.lat);
      const lng = parseFloat(body.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng) || calculateDistanceMeters(lat, lng, GUARUJA_CENTER.lat, GUARUJA_CENTER.lng) > 60000) {
        return sendJSON(res, 422, { error: 'A busca está limitada à região do Guarujá/Baixada Santista.' });
      }
      const radius = Math.min(10000, Math.max(1000, parseFloat(body.radius) || 8000));
      const count = await fetchRealOsmPoints(lat, lng, radius);
      return sendJSON(res, 200, {
        status: 'success',
        message: `${count} novos pontos reais foram importados do OpenStreetMap no seu entorno!`
      });
    } catch {
      return sendJSON(res, 500, { error: 'Erro ao sincronizar com OpenStreetMap.' });
    }
  }

  sendJSON(res, 404, { error: 'Recurso não encontrado.' });
});

function shutdown() {
  flushDatabase();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

server.listen(PORT, () => {
  console.log(`\n========================================================================`);
  console.log(`🌿 CuidAção — SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP (INCLUINDO PEREQUÊ)`);
  console.log(`========================================================================`);
  console.log(`📍 Aplicação Web & PWA: http://localhost:${PORT}`);
  console.log(`💾 Persistência Automática: server/data.json`);
  console.log(`📂 Estrutura: /public (site/app) e /server (API)`);
  console.log(`🔐 Login demo (sem Google real): ${DEMO_LOGIN_ENABLED ? 'ATIVADO (apenas desenvolvimento)' : 'desativado'}`);
  console.log(`========================================================================\n`);
});

module.exports = server;
