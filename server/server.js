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
  repository,
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

// Login "demo" (sem Google real): só em desenvolvimento sem GOOGLE_CLIENT_ID, ou se ALLOW_DEMO_LOGIN=1 / SEED_DEMO_DATA=1.
// Em produção sem essas flags, fica desligado: ele NÃO verifica a posse do e-mail.
const DEMO_LOGIN_ENABLED = process.env.ALLOW_DEMO_LOGIN === '1' || process.env.SEED_DEMO_DATA === '1' || (!IS_PROD && !GOOGLE_CLIENT_ID);

// Origens autorizadas a chamar a API de outro domínio (ex.: o app Capacitor).
// Requisições do próprio site (mesma origem) não precisam de CORS.
const DEFAULT_ORIGINS = ['capacitor://localhost', 'http://localhost', 'https://localhost', 'ionic://localhost'];
const ALLOWED_ORIGINS = new Set(
  (process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : DEFAULT_ORIGINS).map(o => o.trim()).filter(Boolean)
);
const ALLOW_ANY_ORIGIN = ALLOWED_ORIGINS.has('*');

// Segredo do JWT e pasta de uploads: variável de ambiente > arquivo/pasta local em DATA_DIR
const DATA_DIR_FOR_SECRET = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
const UPLOADS_DIR = path.join(DATA_DIR_FOR_SECRET, 'uploads');
try { fs.mkdirSync(UPLOADS_DIR, { recursive: true }); } catch { /* ignora */ }
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

const REPORT_TYPES = [
  'foco_dengue',
  'descarte_irregular',
  'terreno_baldio',
  'esgoto_ceu_aberto',
  'animal_ferido_silvestre',
  'risco_zoonose'
];
const REPORT_STATUSES = ['pending', 'in_analysis', 'resolved', 'rejected'];
const ADMIN_EMAILS = new Set(
  String(process.env.ADMIN_EMAILS || '')
    .split(',')
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
);
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
    if (!token || typeof token !== 'string') return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const parsedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    if (!parsedHeader || parsedHeader.alg !== 'HS256') return null;
    const expectedSig = crypto.createHmac('sha256', JWT_SECRET).update(header + '.' + body).digest('base64url');
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (!data || typeof data.exp !== 'number' || !Number.isFinite(data.exp)) return null;
    if (Date.now() > data.exp) return null;
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
        nwr["amenity"="veterinary"](around:${radiusMeters}, ${lat}, ${lng});
        nwr["amenity"="animal_shelter"](around:${radiusMeters}, ${lat}, ${lng});
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
            const elLat = el.lat || (el.center && el.center.lat);
            const elLon = el.lon || (el.center && el.center.lon);
            if (!elLat || !elLon) return;

            const nearest = findNearestLocalPlace(elLat, elLon);
            const fallbackSuburb = nearest.distance <= 5000 ? nearest.place.neighborhood : 'Guarujá';
            let name = (tags.name || tags['name:pt'] || '').trim();
            if (!name) {
              if (tags.amenity === 'recycling') name = `PEV / Ponto de Reciclagem — ${fallbackSuburb}`;
              else if (tags.leisure === 'park') name = `Área Verde Comunitária — ${fallbackSuburb}`;
              else return;
            }

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
            } else if (tags.amenity === 'veterinary' || tags.amenity === 'animal_shelter') {
              catId = 'cat-6';
              catName = 'Saúde Animal & Controle de Zoonoses';
              domain = 'animal';
              color = '#0D9488';
              iconType = 'paw';
              services = ['Atendimento Veterinário', 'Saúde Animal & Prevenção de Zoonoses'];
            }

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
  const role = ['citizen', 'agent', 'admin'].includes(user.role) ? user.role : 'citizen';
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role,
    picture: user.picture || null,
    provider: provider || user.provider || 'local'
  };
}

function getEffectiveRole(authUser) {
  if (!authUser) return 'citizen';
  const dbUser = db.users.find(u => u.id === authUser.id);
  const role = dbUser ? dbUser.role : authUser.role;
  return ['citizen', 'agent', 'admin'].includes(role) ? role : 'citizen';
}

function isLocationOpenNow(hoursMap) {
  if (!hoursMap || typeof hoursMap !== 'object') return false;
  const brNow = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Sao_Paulo' }));
  const day = String(brNow.getDay());
  const sched = hoursMap[day];
  if (!sched) return false;
  if (sched.open === '00:00' && sched.close === '23:59') return true;
  const hhmm = String(brNow.getHours()).padStart(2, '0') + ':' + String(brNow.getMinutes()).padStart(2, '0');
  return hhmm >= sched.open && hhmm <= sched.close;
}

function computeNearestSupportUnits(lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return { nearest_ubs: null, nearest_ecoponto: null };
  }
  let bestUbs = null;
  let bestUbsDist = Infinity;
  let bestEco = null;
  let bestEcoDist = Infinity;

  for (const loc of db.locations) {
    if (!Number.isFinite(loc.lat) || !Number.isFinite(loc.lng)) continue;
    const d = calculateDistanceMeters(lat, lng, loc.lat, loc.lng);
    if (loc.categoryId === 'cat-1' && d < bestUbsDist) {
      bestUbsDist = d;
      bestUbs = { id: loc.id, name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng, distance_meters: d };
    } else if (loc.categoryId === 'cat-4' && d < bestEcoDist) {
      bestEcoDist = d;
      bestEco = { id: loc.id, name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng, distance_meters: d };
    }
  }
  return { nearest_ubs: bestUbs, nearest_ecoponto: bestEco };
}

function enrichReport(rep) {
  if (!rep) return rep;
  const hasCoords = rep.lat !== null && rep.lng !== null && Number.isFinite(Number(rep.lat)) && Number.isFinite(Number(rep.lng));
  const refs = hasCoords ? computeNearestSupportUnits(Number(rep.lat), Number(rep.lng)) : { nearest_ubs: null, nearest_ecoponto: null };
  const confirmedBy = Array.isArray(rep.confirmedBy) ? rep.confirmedBy : [];
  const confirmations = typeof rep.confirmations === 'number' ? rep.confirmations : confirmedBy.length;
  return {
    ...rep,
    status: rep.status || 'pending',
    confirmations,
    confirmedBy,
    comments: Array.isArray(rep.comments) ? rep.comments : [],
    nearest_ubs: refs.nearest_ubs,
    nearest_ecoponto: refs.nearest_ecoponto
  };
}

function todayInBrazil() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
}

const MAX_BODY_BYTES = 100 * 1024;
const MAX_UPLOAD_BODY_BYTES = 2500 * 1024; // 2.5 MB para suportar imagens otimizadas em base64
const MAX_IMAGE_DECODED_BYTES = 1500 * 1024; // 1.5 MB binário máximo

function saveReportImage(imageDataUrl) {
  if (!imageDataUrl) return null;
  if (typeof imageDataUrl !== 'string') {
    throw new Error('Formato de imagem inválido.');
  }
  const match = imageDataUrl.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=\s]+)$/);
  if (!match) {
    throw new Error('Apenas imagens JPG, PNG ou WebP otimizadas são aceitas.');
  }
  const mime = match[1];
  const base64Data = match[2].replace(/\s+/g, '');
  const buf = Buffer.from(base64Data, 'base64');
  if (buf.length < 16 || buf.length > MAX_IMAGE_DECODED_BYTES) {
    throw new Error('A imagem excede o limite permitido (máx. 1,5 MB otimizada).');
  }

  // Validação de assinatura binária (magic bytes) contra falsificação de MIME
  let ext = '.jpg';
  if (mime === 'image/jpeg') {
    if (buf[0] !== 0xFF || buf[1] !== 0xD8 || buf[2] !== 0xFF) throw new Error('Arquivo JPEG inválido.');
    ext = '.jpg';
  } else if (mime === 'image/png') {
    if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4E || buf[3] !== 0x47) throw new Error('Arquivo PNG inválido.');
    ext = '.png';
  } else if (mime === 'image/webp') {
    const riff = buf.subarray(0, 4).toString('ascii');
    const webp = buf.subarray(8, 12).toString('ascii');
    if (riff !== 'RIFF' || webp !== 'WEBP') throw new Error('Arquivo WebP inválido.');
    ext = '.webp';
  }

  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  const fileName = 'rep-img-' + crypto.randomUUID() + ext;
  const destPath = path.join(UPLOADS_DIR, fileName);
  fs.writeFileSync(destPath, buf, { mode: 0o644 });
  return '/api/v1/uploads/' + fileName;
}

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

function parseBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > maxBytes) {
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
    headers['Access-Control-Allow-Methods'] = 'GET, POST, PATCH, OPTIONS';
  }
  return headers;
}

const CSP_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://accounts.google.com",
  "style-src 'self' 'unsafe-inline' https://accounts.google.com",
  "img-src 'self' data: blob: https://*.tile.openstreetmap.org https://tile.openstreetmap.org https://server.arcgisonline.com https://*.googleusercontent.com",
  "connect-src 'self' https://accounts.google.com https://oauth2.googleapis.com https://www.googleapis.com https://*.tile.openstreetmap.org https://server.arcgisonline.com",
  "frame-src https://accounts.google.com",
  "font-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'"
].join('; ');

const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'SAMEORIGIN',
  'Permissions-Policy': 'geolocation=(self)',
  'Content-Security-Policy': CSP_POLICY,
  ...(IS_PROD ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {})
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
    res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
    return res.end('Requisição inválida.');
  }
  if (rel === '/html' || rel.startsWith('/html/')) {
    res.writeHead(302, { Location: '/', ...SECURITY_HEADERS });
    return res.end();
  }
  if (rel === '/') rel = '/index.html';

  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
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
    return sendJSON(res, 200, {
      status: 'ok',
      driver: repository.driver,
      uptime: Math.round(process.uptime()),
      locations: db.locations.length
    });
  }

  // Rota segura para servir imagens anexadas em alertas/comunidade (proteção estrita contra path traversal)
  if ((req.method === 'GET' || req.method === 'HEAD') && pathname.startsWith('/api/v1/uploads/')) {
    let rawName;
    try {
      rawName = decodeURIComponent(pathname.slice('/api/v1/uploads/'.length));
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Requisição inválida.');
    }
    const candidatePath = path.normalize(path.join(UPLOADS_DIR, rawName));
    if (!candidatePath.startsWith(UPLOADS_DIR + path.sep) || !/^[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/.test(rawName)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
      return res.end('Acesso negado.');
    }
    return fs.stat(candidatePath, (err, stat) => {
      if (err || !stat.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
        return res.end('Imagem não encontrada.');
      }
      const ext = path.extname(candidatePath).toLowerCase();
      res.writeHead(200, {
        'Content-Type': MIME_TYPES[ext] || 'application/octet-stream',
        'Content-Length': stat.size,
        'Cache-Control': 'public, max-age=604800',
        ...SECURITY_HEADERS,
        ...corsHeaders(req)
      });
      if (req.method === 'HEAD') return res.end();
      fs.createReadStream(candidatePath).pipe(res);
    });
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
    const isStrictCepQuery = /^\d{5}-?\d{3}$/.test(q) || (/^[\d.\s-]+$/.test(q) && cepDigits.length === 8);
    if (cepDigits.length === 8) {
      const formattedCep = `${cepDigits.slice(0, 5)}-${cepDigits.slice(5)}`;
      let cepNotFound = false;

      try {
        const viaCep = await httpsGet(`https://viacep.com.br/ws/${cepDigits}/json/`, 4000);
        if (viaCep && viaCep.erro) {
          cepNotFound = !cepDigits.startsWith('11446');
        } else if (viaCep && (viaCep.logradouro || viaCep.bairro || viaCep.localidade)) {
          const numText = houseNumParam ? `, ${houseNumParam}` : '';
          const cepLabel = viaCep.cep || formattedCep;
          let osmMatches = [];

          if (viaCep.logradouro) {
            const fullAddressQuery = `${viaCep.logradouro}${numText}, ${viaCep.bairro ? viaCep.bairro + ', ' : ''}${viaCep.localidade}, ${viaCep.uf}, Brasil`;
            const osmByCep = await httpsGet(
              `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=4&countrycodes=br&q=${encodeURIComponent(fullAddressQuery)}`,
              4500
            ).catch(() => []);
            if (Array.isArray(osmByCep) && osmByCep.length > 0) {
              osmMatches = osmByCep;
            } else {
              const streetOnlyQuery = `${viaCep.logradouro}, ${viaCep.localidade}, ${viaCep.uf}`;
              const osmStreet = await httpsGet(
                `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=3&countrycodes=br&q=${encodeURIComponent(streetOnlyQuery)}`,
                4000
              ).catch(() => []);
              if (Array.isArray(osmStreet)) osmMatches = osmStreet;
            }
          }

          if (osmMatches.length === 0 && viaCep.bairro) {
            const bairroQuery = `${viaCep.bairro}, ${viaCep.localidade} - ${viaCep.uf}, Brasil`;
            const osmBairro = await httpsGet(
              `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=2&countrycodes=br&q=${encodeURIComponent(bairroQuery)}`,
              4000
            ).catch(() => []);
            if (Array.isArray(osmBairro)) osmMatches = osmBairro;
          }

          if (osmMatches.length === 0 && viaCep.localidade) {
            const cityQuery = `${viaCep.localidade} - ${viaCep.uf}, Brasil`;
            const osmCity = await httpsGet(
              `https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&limit=1&countrycodes=br&q=${encodeURIComponent(cityQuery)}`,
              4000
            ).catch(() => []);
            if (Array.isArray(osmCity)) osmMatches = osmCity;
          }

          osmMatches.forEach(item => {
            const itemLat = parseFloat(item.lat);
            const itemLng = parseFloat(item.lon);
            if (!isNaN(itemLat) && !isNaN(itemLng)) {
              resultsList.push({
                displayName: `${viaCep.logradouro || viaCep.bairro || viaCep.localidade}${numText}${viaCep.bairro && viaCep.logradouro ? ' - ' + viaCep.bairro : ''}, ${viaCep.localidade}/${viaCep.uf} (CEP ${cepLabel})`,
                logradouro: viaCep.logradouro || '',
                bairro: viaCep.bairro || '',
                neighborhood: viaCep.bairro || '',
                localidade: viaCep.localidade || '',
                city: viaCep.localidade || '',
                uf: viaCep.uf || 'SP',
                state: viaCep.uf || 'SP',
                cep: cepLabel,
                lat: itemLat,
                lng: itemLng,
                inCoverage: inCoverage(itemLat, itemLng),
                source: 'viacep'
              });
            }
          });
        }
      } catch {
        // Continua para atalho local ou busca nominal
      }

      // Atalho direto / garantia offline para faixas de CEP do Perequê (11446-xxx) e faixas gerais do Guarujá (11400-xxx a 11499-xxx)
      if (cepDigits.startsWith('11446') && resultsList.length === 0) {
        resultsList.push({
          displayName: `Bairro do Perequê (Estrada Guarujá-Bertioga / CEP ${formattedCep}) - Guarujá/SP`,
          logradouro: 'Estrada Guarujá-Bertioga',
          bairro: 'Perequê',
          neighborhood: 'Perequê',
          localidade: 'Guarujá',
          city: 'Guarujá',
          uf: 'SP',
          state: 'SP',
          cep: formattedCep,
          lat: PEREQUE_CENTER.lat,
          lng: PEREQUE_CENTER.lng,
          inCoverage: true,
          source: 'viacep'
        });
      }

      if (isStrictCepQuery) {
        return sendJSON(res, 200, {
          status: 'success',
          cepNotFound,
          coverage: COVERAGE,
          results: resultsList.slice(0, 12)
        });
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
      coverage: COVERAGE,
      results: resultsList.slice(0, 12).map(r => ({
        ...r,
        inCoverage: typeof r.inCoverage === 'boolean' ? r.inCoverage : inCoverage(r.lat, r.lng)
      }))
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
      results = results.filter(l => l.categoryId === category || l.categorySlug === category);
    }

    if (query.popular_only === '1') {
      results = results.filter(l => l.categoryId === 'cat-3' && l.has_popular_pharmacy !== false);
    }

    if (query.open_now === '1') {
      results = results.filter(l => isLocationOpenNow(l.opening_hours));
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

  // Location detail (match exato de segmento: /api/v1/locations/:id)
  const locDetailMatch = pathname.match(/^\/api\/v1\/locations\/([^/]+)$/);
  if (req.method === 'GET' && locDetailMatch) {
    let id;
    try {
      id = decodeURIComponent(locDetailMatch[1]);
    } catch {
      return sendJSON(res, 400, { error: 'ID de local inválido.' });
    }
    const loc = db.locations.find(l => l.id === id);
    if (!loc) return sendJSON(res, 404, { error: 'Local não encontrado.' });
    return sendJSON(res, 200, { status: 'success', data: loc });
  }

  // Reports list (enriquecido com USAFA/UBS e Ecoponto mais próximos via Haversine)
  if (req.method === 'GET' && pathname === '/api/v1/reports') {
    const enriched = db.reports.map(enrichReport);
    return sendJSON(res, 200, {
      status: 'success',
      count: enriched.length,
      data: enriched
    });
  }

  // Exportação GeoJSON para SIG / QGIS (GET /api/v1/export/reports.geojson)
  if (req.method === 'GET' && pathname === '/api/v1/export/reports.geojson') {
    const features = db.reports
      .filter(r => r.lat !== null && r.lng !== null && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)))
      .map(raw => {
        const r = enrichReport(raw);
        return {
          type: 'Feature',
          id: r.id,
          geometry: {
            type: 'Point',
            coordinates: [Number(r.lng), Number(r.lat)]
          },
          properties: {
            id: r.id,
            title: r.title,
            report_type: r.report_type,
            description: r.description,
            address: r.address,
            status: r.status,
            urgency: r.urgency || 3,
            confirmations: r.confirmations || 0,
            reporter_name: r.reporterName || 'Morador',
            date: r.date || null,
            nearest_ubs: r.nearest_ubs ? r.nearest_ubs.name : null,
            nearest_ubs_distance_m: r.nearest_ubs ? r.nearest_ubs.distance_meters : null,
            nearest_ecoponto: r.nearest_ecoponto ? r.nearest_ecoponto.name : null,
            nearest_ecoponto_distance_m: r.nearest_ecoponto ? r.nearest_ecoponto.distance_meters : null
          }
        };
      });

    const geojson = {
      type: 'FeatureCollection',
      name: 'cuidacao_onehealth_guaruja_reports',
      crs: { type: 'name', properties: { name: 'urn:ogc:def:crs:OGC:1.3:CRS84' } },
      generated_at: new Date().toISOString(),
      features
    };

    res.writeHead(200, {
      'Content-Type': 'application/geo+json; charset=utf-8',
      'Content-Disposition': 'attachment; filename="cuidacao-reports-guaruja.geojson"',
      'Cache-Control': 'no-store',
      ...SECURITY_HEADERS,
      ...corsHeaders(req)
    });
    return res.end(JSON.stringify(geojson, null, 2));
  }

  // Dashboard Analítico One Health (GET /api/v1/analytics/summary)
  if (req.method === 'GET' && pathname === '/api/v1/analytics/summary') {
    const reports = db.reports.map(enrichReport);
    const totalReports = reports.length;
    const byStatus = { pending: 0, in_analysis: 0, resolved: 0, rejected: 0 };
    const byType = {};
    REPORT_TYPES.forEach(t => { byType[t] = 0; });
    const neighborhoodMap = new Map();
    let totalConfirmations = 0;

    let geoAlertsCount = 0;
    let sumEcoDist = 0;
    let within1kmEco = 0;
    let beyond1kmEco = 0;

    reports.forEach(r => {
      const st = REPORT_STATUSES.includes(r.status) ? r.status : 'pending';
      byStatus[st] = (byStatus[st] || 0) + 1;
      byType[r.report_type] = (byType[r.report_type] || 0) + 1;
      totalConfirmations += Number(r.confirmations) || 0;

      let nbName = 'Guarujá (Geral)';
      if (r.lat !== null && r.lng !== null && Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng))) {
        const nearest = findNearestLocalPlace(Number(r.lat), Number(r.lng));
        if (nearest && nearest.place && nearest.place.neighborhood) {
          nbName = nearest.place.neighborhood;
        }
        if (r.nearest_ecoponto && Number.isFinite(r.nearest_ecoponto.distance_meters)) {
          geoAlertsCount++;
          sumEcoDist += r.nearest_ecoponto.distance_meters;
          if (r.nearest_ecoponto.distance_meters <= 1000) within1kmEco++;
          else beyond1kmEco++;
        }
      }
      const curNb = neighborhoodMap.get(nbName) || { neighborhood: nbName, total: 0, open: 0, resolved: 0 };
      curNb.total++;
      if (st === 'resolved') curNb.resolved++;
      else if (st !== 'rejected') curNb.open++;
      neighborhoodMap.set(nbName, curNb);
    });

    const actionableCount = totalReports - byStatus.rejected;
    const resolutionRate = actionableCount > 0 ? Math.round((byStatus.resolved / actionableCount) * 1000) / 10 : 0;

    const ecopontos = db.locations.filter(l => l.categoryId === 'cat-4');
    const ecopontosCorrelation = ecopontos.map(eco => {
      const alertsWithin2km = reports.filter(r =>
        r.lat !== null && r.lng !== null &&
        calculateDistanceMeters(Number(r.lat), Number(r.lng), eco.lat, eco.lng) <= 2000
      ).length;
      return {
        id: eco.id,
        name: eco.name,
        address: eco.address,
        alerts_within_2km: alertsWithin2km
      };
    }).sort((a, b) => b.alerts_within_2km - a.alerts_within_2km);

    const ratedLocs = db.locations
      .filter(l => (Number(l.total_reviews) || 0) > 0 || (Number(l.overall_score) || 0) > 0)
      .map(l => ({
        id: l.id,
        name: l.name,
        categoryId: l.categoryId,
        categoryName: l.categoryName,
        domain: l.domain,
        overall_score: Number(l.overall_score) || 0,
        avg_accessibility: Number(l.avg_accessibility) || 0,
        avg_wait_time: Number(l.avg_wait_time) || 0,
        avg_humanized_care: Number(l.avg_humanized_care) || 0,
        total_reviews: Number(l.total_reviews) || 0
      }));

    const topOverall = [...ratedLocs].sort((a, b) => b.overall_score - a.overall_score || b.total_reviews - a.total_reviews).slice(0, 10);
    const topAccessibility = [...ratedLocs].sort((a, b) => b.avg_accessibility - a.avg_accessibility || b.overall_score - a.overall_score).slice(0, 5);
    const topWaitTime = [...ratedLocs].sort((a, b) => b.avg_wait_time - a.avg_wait_time || b.overall_score - a.overall_score).slice(0, 5);
    const topHumanizedCare = [...ratedLocs].sort((a, b) => b.avg_humanized_care - a.avg_humanized_care || b.overall_score - a.overall_score).slice(0, 5);

    const totalReviews = db.locations.reduce((acc, l) => acc + (Number(l.total_reviews) || 0), 0);

    return sendJSON(res, 200, {
      status: 'success',
      generated_at: new Date().toISOString(),
      totals: {
        locations: db.locations.length,
        categories: (db.categories || []).length,
        reports: totalReports,
        open_reports: byStatus.pending + byStatus.in_analysis,
        pending_reports: byStatus.pending,
        in_analysis_reports: byStatus.in_analysis,
        resolved_reports: byStatus.resolved,
        rejected_reports: byStatus.rejected,
        resolution_rate_percent: resolutionRate,
        total_confirmations: totalConfirmations,
        total_reviews: totalReviews
      },
      reports_by_type: byType,
      reports_by_status: byStatus,
      reports_by_neighborhood: Array.from(neighborhoodMap.values()).sort((a, b) => b.total - a.total),
      rankings: {
        overall: topOverall,
        accessibility: topAccessibility,
        wait_time: topWaitTime,
        humanized_care: topHumanizedCare
      },
      territorial_correlation: {
        georeferenced_alerts: geoAlertsCount,
        avg_distance_to_ecoponto_m: geoAlertsCount > 0 ? Math.round(sumEcoDist / geoAlertsCount) : 0,
        alerts_within_1km_of_ecoponto: within1kmEco,
        alerts_beyond_1km_of_ecoponto: beyond1kmEco,
        percent_beyond_1km: geoAlertsCount > 0 ? Math.round((beyond1kmEco / geoAlertsCount) * 1000) / 10 : 0,
        by_ecoponto: ecopontosCorrelation
      },
      environmental_context: db.environmental_context || null
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

      // RBAC: usuários cadastrados via API pública entram sempre como 'citizen' (impede auto-promoção)
      const assignedRole = ADMIN_EMAILS.has(email) ? 'admin' : 'citizen';
      const newUser = {
        id: 'usr-' + crypto.randomUUID(),
        name,
        email,
        passwordHash,
        role: assignedRole,
        provider: 'local',
        googleId: null,
        picture: null,
        createdAt: new Date().toISOString()
      };
      db.users.push(newUser);
      saveDatabase('user', newUser);

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
          role: ADMIN_EMAILS.has(profile.email) ? 'admin' : 'citizen',
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
      saveDatabase('user', user);

      const publicInfo = publicUser(user, provider === 'demo' ? 'demo' : 'google');
      return sendJSON(res, 200, { status: 'success', token: generateJWT(publicInfo), user: publicInfo });
    } catch (err) {
      return sendJSON(res, 400, { error: 'Não foi possível autenticar com o Google: ' + (err.message || 'Erro desconhecido') });
    }
  }

  // Avaliações (usuário autenticado; 1 por usuário/local/dia; notas obrigatórias de 1 a 5; match exato)
  const locReviewMatch = pathname.match(/^\/api\/v1\/locations\/([^/]+)\/reviews$/);
  if (req.method === 'POST' && locReviewMatch) {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para avaliar este local.' });
    if (rateLimited(req, res, 'write', 30, 60 * 60 * 1000)) return;

    let locationId;
    try {
      locationId = decodeURIComponent(locReviewMatch[1]);
    } catch {
      return sendJSON(res, 400, { error: 'ID de local inválido.' });
    }
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

      if (KEEP_DEMO_RATINGS && !loc.rating_base) {
        const baseCount = Number(loc.total_reviews) || 0;
        loc.rating_base = {
          count: baseCount,
          sum_wait: (Number(loc.avg_wait_time) || 0) * baseCount,
          sum_access: (Number(loc.avg_accessibility) || 0) * baseCount,
          sum_care: (Number(loc.avg_humanized_care) || 0) * baseCount
        };
      }

      const reviewObj = {
        id: 'rev-' + crypto.randomUUID(),
        userId: user.id,
        userName: user.name,
        wait,
        access,
        care,
        comment: String(body.comment || '').trim().slice(0, 500),
        date: today
      };
      loc.reviews.unshift(reviewObj);

      if (KEEP_DEMO_RATINGS) {
        // Modo demonstração: acumula soma/peso exatos para evitar erro de arredondamento sucessivo
        loc.rating_base.count += 1;
        loc.rating_base.sum_wait += wait;
        loc.rating_base.sum_access += access;
        loc.rating_base.sum_care += care;
        const count = loc.rating_base.count;
        const exactWait = loc.rating_base.sum_wait / count;
        const exactAccess = loc.rating_base.sum_access / count;
        const exactCare = loc.rating_base.sum_care / count;
        loc.total_reviews = count;
        loc.avg_wait_time = Math.round(exactWait * 10) / 10;
        loc.avg_accessibility = Math.round(exactAccess * 10) / 10;
        loc.avg_humanized_care = Math.round(exactCare * 10) / 10;
        loc.overall_score = Math.round(((exactWait + exactAccess + exactCare) / 3) * 10) / 10;
      } else {
        recomputeLocationMetrics(loc);
      }

      saveDatabase('review', { locationId: loc.id, review: reviewObj });
      return sendJSON(res, 201, { status: 'success', message: 'Avaliação registrada com sucesso!', location: loc });
    } catch {
      return sendJSON(res, 400, { error: 'Erro ao processar avaliação.' });
    }
  }

  // Alertas ambientais e publicações da comunidade (usuário autenticado; imagem opcional; nota 1-5; coordenadas opcionais no Guarujá)
  if (req.method === 'POST' && (pathname === '/api/v1/reports' || pathname === '/api/v1/community/posts')) {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para registrar alertas ambientais.' });
    if (rateLimited(req, res, 'write', 30, 60 * 60 * 1000)) return;

    try {
      const body = await parseBody(req, MAX_UPLOAD_BODY_BYTES);
      const rawDesc = String(body.description !== undefined ? body.description : (body.details || '')).trim();
      const hasExplicitTitle = body.title !== undefined && body.title !== null && String(body.title).trim() !== '';
      const title = hasExplicitTitle
        ? String(body.title).trim()
        : (rawDesc.split(/\r?\n/)[0].trim().slice(0, 100));
      const description = rawDesc || title;
      const address = String(body.address || 'Comunidade Guarujá/SP').trim();
      const reportType = body.report_type || 'foco_dengue';
      const urgencyRaw = body.urgency !== undefined ? Number(body.urgency) : (body.rating !== undefined ? Number(body.rating) : 3);

      if (title.length < 3 || title.length > 120) return sendJSON(res, 400, { error: 'O título deve ter de 3 a 120 caracteres.' });
      if (!REPORT_TYPES.includes(reportType)) return sendJSON(res, 400, { error: 'Tipo de alerta inválido.' });
      if (description.length > 1000) return sendJSON(res, 400, { error: 'A descrição deve ter no máximo 1000 caracteres.' });
      if (address.length > 255) return sendJSON(res, 400, { error: 'O endereço deve ter no máximo 255 caracteres.' });
      if (!Number.isInteger(urgencyRaw) || urgencyRaw < 1 || urgencyRaw > 5) {
        return sendJSON(res, 400, { error: 'A nota/urgência deve ser um número inteiro de 1 a 5.' });
      }

      const hasCoords = body.lat !== undefined && body.lat !== null && body.lat !== '' &&
                        body.lng !== undefined && body.lng !== null && body.lng !== '';
      let repLat = null;
      let repLng = null;
      if (hasCoords) {
        repLat = parseFloat(body.lat);
        repLng = parseFloat(body.lng);
        if (!inCoverage(repLat, repLng)) {
          return sendJSON(res, 422, { error: 'O local do alerta está fora da área de cobertura (Guarujá/SP).' });
        }

        // Deduplicação inteligente: verifica alerta aberto do mesmo tipo num raio de 50m
        if (!body.force_create) {
          const duplicate = db.reports.find(r =>
            (r.status === 'pending' || r.status === 'in_analysis' || !r.status) &&
            r.report_type === reportType &&
            r.lat !== null && r.lng !== null &&
            Number.isFinite(Number(r.lat)) && Number.isFinite(Number(r.lng)) &&
            calculateDistanceMeters(repLat, repLng, Number(r.lat), Number(r.lng)) <= 50
          );
          if (duplicate) {
            const dist = calculateDistanceMeters(repLat, repLng, Number(duplicate.lat), Number(duplicate.lng));
            return sendJSON(res, 409, {
              status: 'duplicate',
              error: 'Já existe um alerta aberto deste mesmo tipo num raio de 50 metros.',
              message: `Já existe um alerta aberto deste tipo a ${dist}m. Confirme o alerta existente ("Eu também vi") para aumentar sua relevância!`,
              distance_meters: dist,
              duplicate_of: enrichReport(duplicate),
              confirm_endpoint: `/api/v1/reports/${encodeURIComponent(duplicate.id)}/confirm`
            });
          }
        }
      }

      let imageUrl = null;
      if (body.image) {
        try {
          imageUrl = saveReportImage(body.image);
        } catch (imgErr) {
          return sendJSON(res, 400, { error: imgErr.message || 'Imagem inválida.' });
        }
      }

      const newReport = {
        id: 'rep-' + crypto.randomUUID(),
        userId: user.id,
        title,
        report_type: reportType,
        description,
        urgency: urgencyRaw,
        image_url: imageUrl,
        address,
        lat: repLat,
        lng: repLng,
        status: 'pending',
        confirmations: 1,
        confirmedBy: [user.id],
        date: todayInBrazil(),
        createdAt: Date.now(),
        reporterName: user.name,
        comments: []
      };

      db.reports.unshift(newReport);
      saveDatabase('report', newReport);
      return sendJSON(res, 201, { status: 'success', report: enrichReport(newReport) });
    } catch (err) {
      const msg = err && err.message && err.message.includes('muito grande')
        ? 'Imagem ou requisição excede o tamanho máximo permitido (2,5 MB).'
        : 'Erro ao processar alerta ambiental.';
      return sendJSON(res, 400, { error: msg });
    }
  }

  // Comentários nos alertas / feed da comunidade (POST /api/v1/reports/:id/comments)
  const repCommentMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/comments$/);
  if (req.method === 'POST' && repCommentMatch) {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para comentar nos alertas da comunidade.' });
    if (rateLimited(req, res, 'write', 45, 60 * 60 * 1000)) return;

    let reportId;
    try {
      reportId = decodeURIComponent(repCommentMatch[1]);
    } catch {
      return sendJSON(res, 400, { error: 'ID de alerta inválido.' });
    }
    const rep = db.reports.find(r => r.id === reportId);
    if (!rep) return sendJSON(res, 404, { error: 'Alerta não encontrado.' });

    try {
      const body = await parseBody(req);
      const text = String(body.text || '').trim();
      if (!text || text.length > 225) {
        return sendJSON(res, 400, { error: 'O comentário deve ter entre 1 e 225 caracteres.' });
      }
      if (!Array.isArray(rep.comments)) rep.comments = [];
      const comment = {
        id: 'comm-' + crypto.randomUUID(),
        userId: user.id,
        author: user.name,
        text,
        createdAt: Date.now()
      };
      rep.comments.unshift(comment);
      saveDatabase('comment', { reportId: rep.id, comment });
      return sendJSON(res, 201, { status: 'success', comment, report: enrichReport(rep) });
    } catch {
      return sendJSON(res, 400, { error: 'Erro ao registrar comentário.' });
    }
  }

  // Confirmação comunitária ("Eu também vi este foco" — trava de 1 confirmação por usuário)
  const repConfirmMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/confirm$/);
  if (req.method === 'POST' && repConfirmMatch) {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para confirmar alertas comunitários.' });
    if (rateLimited(req, res, 'write', 45, 60 * 60 * 1000)) return;

    let reportId;
    try {
      reportId = decodeURIComponent(repConfirmMatch[1]);
    } catch {
      return sendJSON(res, 400, { error: 'ID de alerta inválido.' });
    }
    const rep = db.reports.find(r => r.id === reportId);
    if (!rep) return sendJSON(res, 404, { error: 'Alerta não encontrado.' });

    if (!Array.isArray(rep.confirmedBy)) rep.confirmedBy = [];
    if (rep.confirmedBy.includes(user.id)) {
      return sendJSON(res, 409, {
        error: 'Você já confirmou este alerta comunitário.',
        confirmations: rep.confirmations || rep.confirmedBy.length,
        report: enrichReport(rep)
      });
    }

    rep.confirmedBy.push(user.id);
    rep.confirmations = Math.max((Number(rep.confirmations) || 0) + 1, rep.confirmedBy.length);
    saveDatabase('confirm', { reportId: rep.id, userId: user.id });
    return sendJSON(res, 200, {
      status: 'success',
      message: 'Confirmação comunitária ("Eu também vi") registrada!',
      confirmations: rep.confirmations,
      report: enrichReport(rep)
    });
  }

  // Moderação de status de alertas (RBAC: restrito a agent ou admin)
  const repStatusMatch = pathname.match(/^\/api\/v1\/reports\/([^/]+)\/status$/);
  if (req.method === 'PATCH' && repStatusMatch) {
    const user = getAuthUser(req);
    if (!user) return sendJSON(res, 401, { error: 'Autenticação necessária.' });
    const role = getEffectiveRole(user);
    if (role !== 'agent' && role !== 'admin') {
      return sendJSON(res, 403, { error: 'Apenas agentes de saúde ou administradores podem alterar o status de alertas.' });
    }
    if (rateLimited(req, res, 'write', 60, 60 * 60 * 1000)) return;

    let reportId;
    try {
      reportId = decodeURIComponent(repStatusMatch[1]);
    } catch {
      return sendJSON(res, 400, { error: 'ID de alerta inválido.' });
    }
    const rep = db.reports.find(r => r.id === reportId);
    if (!rep) return sendJSON(res, 404, { error: 'Alerta não encontrado.' });

    try {
      const body = await parseBody(req);
      const nextStatus = String(body.status || '').trim();
      if (!REPORT_STATUSES.includes(nextStatus)) {
        return sendJSON(res, 400, { error: 'Status inválido. Use: pending, in_analysis, resolved ou rejected.' });
      }
      rep.status = nextStatus;
      rep.updatedAt = new Date().toISOString();
      rep.moderatedBy = user.name;
      saveDatabase('report_status', { reportId: rep.id, status: nextStatus, moderatedBy: user.name });
      return sendJSON(res, 200, {
        status: 'success',
        message: 'Status do alerta atualizado com sucesso.',
        report: enrichReport(rep)
      });
    } catch {
      return sendJSON(res, 400, { error: 'Requisição inválida.' });
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

server.on('close', () => {
  flushDatabase();
});

function shutdown() {
  flushDatabase();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

if (process.env.NO_AUTO_LISTEN !== '1') {
  server.listen(PORT, () => {
    const addr = server.address();
    const actualPort = addr && typeof addr === 'object' ? addr.port : PORT;
    console.log(`\n========================================================================`);
    console.log(`🌿 CuidAção — SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP (INCLUINDO PEREQUÊ)`);
    console.log(`========================================================================`);
    console.log(`📍 Aplicação Web & PWA: http://localhost:${actualPort}`);
    console.log(`💾 Persistência Automática: server/data.json`);
    console.log(`📂 Estrutura: /public (site/app) e /server (API)`);
    console.log(`🔐 Login demo (sem Google real): ${DEMO_LOGIN_ENABLED ? 'ATIVADO (apenas desenvolvimento)' : 'desativado'}`);
    console.log(`========================================================================\n`);
  });
}

Object.assign(server, {
  generateJWT,
  verifyJWT,
  inCoverage,
  COVERAGE,
  rateBuckets,
  hashPasswordAsync,
  verifyPasswordAsync
});

module.exports = server;
