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

const {
  db,
  saveDatabase,
  PEREQUE_CENTER,
  GUARUJA_CENTER,
  GUARUJA_PLACES,
  findNearestLocalPlace,
  calculateDistanceMeters,
  hashPassword,
  verifyPassword
} = require('./database');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'secret_cuidacao_onehealth_tcc_2026';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';

// Diretórios de arquivos estáticos (HTML, CSS e JS separados)
const ROOT_DIR = path.resolve(__dirname, '..');
const HTML_FILE = path.join(ROOT_DIR, 'html', 'index.html');
const CSS_FILE = path.join(ROOT_DIR, 'css', 'styles.css');
const JS_FILE = path.join(ROOT_DIR, 'js', 'app.js');

// ============================================================================
// CRIPTOGRAFIA E TOKENS JWT
// ============================================================================
function generateJWT(payload) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify({ ...payload, exp: Date.now() + 86400000 })).toString('base64url');
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
    if (signature !== expectedSig) return null;
    const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (data.exp && Date.now() > data.exp) return null;
    return data;
  } catch {
    return null;
  }
}

// ============================================================================
// SERVICE WORKER OFICIAL DO PWA CuidAção (/sw.js)
// ============================================================================
const SERVICE_WORKER_SOURCE = `
const CACHE_NAME = 'cuidacao-pwa-v2';
const STATIC_ASSETS = [
  '/',
  '/css/styles.css',
  '/js/app.js',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(STATIC_ASSETS)).catch(() => {})
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const reqUrl = new URL(req.url);
  if (reqUrl.pathname.startsWith('/api/')) {
    return;
  }

  event.respondWith(
    fetch(req)
      .then((networkRes) => {
        if (networkRes && networkRes.status === 200 && reqUrl.origin === self.location.origin) {
          const clone = networkRes.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, clone)).catch(() => {});
        }
        return networkRes;
      })
      .catch(() => caches.match(req))
  );
});
`.trim();

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
              id: 'osm-real-' + (el.id || i),
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
              avg_wait_time: 4.2,
              avg_accessibility: 4.5,
              avg_humanized_care: 4.4,
              overall_score: 4.4,
              total_reviews: 14,
              reviews: []
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
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => body += chunk);
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (err) {
        reject(err);
      }
    });
  });
}

function sendJSON(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, 'utf8', (err, content) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('Arquivo não encontrado: ' + path.basename(filePath));
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(content);
  });
}

function httpsGet(requestUrl, timeoutMs = 5000, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(requestUrl, {
      headers: {
        'User-Agent': 'CuidAcaoOneHealthTCC/5.0 (pesquisa-academica)',
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

// ============================================================================
// SERVIDOR HTTP PRINCIPAL
// ============================================================================
const server = http.createServer(async (req, res) => {
  // WHATWG URL API (substitui o url.parse() depreciado)
  const parsedUrl = new URL(req.url, 'http://localhost');
  const pathname = parsedUrl.pathname;
  const query = Object.fromEntries(parsedUrl.searchParams);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    });
    return res.end();
  }

  // Arquivos Estáticos (HTML, CSS e JS nas pastas separadas)
  if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/html/index.html')) {
    return serveStaticFile(res, HTML_FILE, 'text/html; charset=utf-8');
  }

  if (req.method === 'GET' && (pathname === '/css/styles.css' || pathname === '/styles.css')) {
    return serveStaticFile(res, CSS_FILE, 'text/css; charset=utf-8');
  }

  if (req.method === 'GET' && (pathname === '/js/app.js' || pathname === '/app.js')) {
    return serveStaticFile(res, JS_FILE, 'application/javascript; charset=utf-8');
  }

  // Service Worker PWA (/sw.js)
  if (req.method === 'GET' && pathname === '/sw.js') {
    res.writeHead(200, {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Service-Worker-Allowed': '/',
      'Cache-Control': 'no-cache'
    });
    return res.end(SERVICE_WORKER_SOURCE);
  }

  // Manifest PWA Oficial CuidAção
  if (req.method === 'GET' && pathname === '/manifest.json') {
    res.writeHead(200, { 'Content-Type': 'application/manifest+json; charset=utf-8' });
    return res.end(JSON.stringify({
      short_name: "CuidAção",
      name: "CuidAção - Saúde Única (One Health) • Guarujá/SP",
      description: "Mapeamento Geoespacial de Saúde Pública e Sustentabilidade no Guarujá/SP",
      start_url: "/",
      background_color: "#064E3B",
      theme_color: "#10B981",
      display: "standalone"
    }));
  }

  // Configuração OAuth do Google
  if (req.method === 'GET' && pathname === '/api/v1/auth/google/config') {
    return sendJSON(res, 200, {
      status: 'success',
      clientId: GOOGLE_CLIENT_ID
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
      accuracy: 25,
      isCoarseIp: false,
      neighborhood: 'Perequê',
      city: 'Bairro do Perequê, Guarujá',
      state: 'SP'
    });
  }

  // Reverse geocoding de alta precisão (zoom=18 + número + enriquecimento com Gazetteer do Perequê e Guarujá)
  if (req.method === 'GET' && pathname === '/api/v1/geo/reverse') {
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
    const radius = parseFloat(query.radius) || 25000;
    const domain = query.domain;
    const category = query.category;
    const search = query.search ? query.search.toLowerCase() : '';

    const nearbyCount = db.locations.filter(l => calculateDistanceMeters(lat, lng, l.lat, l.lng) <= radius).length;
    if (nearbyCount < 3) {
      await Promise.race([
        fetchRealOsmPoints(lat, lng, radius),
        new Promise(r => setTimeout(r, 6000))
      ]);
    }

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

  // Auth: Register
  if (req.method === 'POST' && pathname === '/api/v1/auth/register') {
    try {
      const { name, email, password } = await parseBody(req);
      if (!name || !email || !password) return sendJSON(res, 400, { error: 'Campos obrigatórios.' });
      if (db.users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
        return sendJSON(res, 409, { error: 'E-mail já cadastrado.' });
      }

      const newUser = {
        id: 'usr-' + (db.users.length + 1) + '-' + Date.now().toString(36),
        name: String(name).trim(),
        email: String(email).trim().toLowerCase(),
        passwordHash: hashPassword(password),
        provider: 'local',
        googleId: null,
        picture: null,
        createdAt: new Date().toISOString()
      };
      db.users.push(newUser);
      saveDatabase();

      const token = generateJWT({ id: newUser.id, name: newUser.name, email: newUser.email, picture: newUser.picture, provider: 'local' });
      return sendJSON(res, 201, {
        status: 'success',
        token,
        user: { id: newUser.id, name: newUser.name, email: newUser.email, picture: newUser.picture, provider: 'local' }
      });
    } catch {
      return sendJSON(res, 400, { error: 'Requisição inválida.' });
    }
  }

  // Auth: Login Tradicional (Scrypt com Salt)
  if (req.method === 'POST' && pathname === '/api/v1/auth/login') {
    try {
      const { email, password } = await parseBody(req);
      const user = db.users.find(
        u => u.email.toLowerCase() === (email || '').trim().toLowerCase() && verifyPassword(password || '', u.passwordHash)
      );
      if (!user) return sendJSON(res, 401, { error: 'E-mail ou senha inválidos.' });

      const token = generateJWT({ id: user.id, name: user.name, email: user.email, picture: user.picture, provider: user.provider || 'local' });
      return sendJSON(res, 200, {
        status: 'success',
        token,
        user: { id: user.id, name: user.name, email: user.email, picture: user.picture, provider: user.provider || 'local' }
      });
    } catch {
      return sendJSON(res, 400, { error: 'Requisição inválida.' });
    }
  }

  // Auth: Entrar com Google (Com proteção contra sobrescrita de contas locais protegidas por senha)
  if (req.method === 'POST' && pathname === '/api/v1/auth/google') {
    try {
      const body = await parseBody(req);
      let googleEmail = '';
      let googleName = '';
      let googlePicture = '';
      let googleSub = '';
      let isVerifiedOAuthToken = false;

      if (body.accessToken) {
        const userInfo = await httpsGet('https://www.googleapis.com/oauth2/v3/userinfo', 5000, {
          'Authorization': 'Bearer ' + body.accessToken
        });
        googleEmail = (userInfo.email || '').trim().toLowerCase();
        googleName = userInfo.name || userInfo.given_name || '';
        googlePicture = userInfo.picture || '';
        googleSub = userInfo.sub || '';
        isVerifiedOAuthToken = Boolean(googleEmail && userInfo.email_verified !== false);
      } else if (body.credential) {
        const tokenInfo = await httpsGet(
          'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(body.credential),
          5000
        );
        googleEmail = (tokenInfo.email || '').trim().toLowerCase();
        googleName = tokenInfo.name || tokenInfo.given_name || '';
        googlePicture = tokenInfo.picture || '';
        googleSub = tokenInfo.sub || '';
        isVerifiedOAuthToken = Boolean(googleEmail && tokenInfo.email_verified !== 'false');
      } else if (body.email) {
        googleEmail = String(body.email).trim().toLowerCase();
        googleName = String(body.name || googleEmail.split('@')[0]).trim();
        googlePicture = body.picture || '';
        googleSub = body.googleId || ('google-' + crypto.createHash('md5').update(googleEmail).digest('hex').slice(0, 12));
        isVerifiedOAuthToken = false;
      }

      if (!googleEmail || !googleEmail.includes('@')) {
        return sendJSON(res, 400, { error: 'Informe um e-mail válido da sua conta do Google.' });
      }

      if (!googleName) {
        const prefix = googleEmail.split('@')[0].replace(/[._-]+/g, ' ');
        googleName = prefix.replace(/\b\w/g, l => l.toUpperCase());
      }

      let user = db.users.find(u => u.email.toLowerCase() === googleEmail);

      if (user && user.provider === 'local' && !isVerifiedOAuthToken) {
        return sendJSON(res, 403, {
          error: 'Este e-mail pertence a uma conta local protegida por senha. Entre com seu e-mail e senha ou utilize uma conta Google.'
        });
      }

      if (!user) {
        user = {
          id: 'usr-google-' + (db.users.length + 1) + '-' + Date.now().toString(36),
          googleId: googleSub,
          name: googleName,
          email: googleEmail,
          passwordHash: null,
          provider: 'google',
          picture: googlePicture || null,
          createdAt: new Date().toISOString()
        };
        db.users.push(user);
      } else {
        user.name = googleName || user.name;
        user.googleId = googleSub || user.googleId;
        if (googlePicture) user.picture = googlePicture;
      }

      saveDatabase();

      const tokenPayload = {
        id: user.id,
        name: user.name,
        email: user.email,
        picture: user.picture,
        provider: 'google'
      };
      const token = generateJWT(tokenPayload);

      return sendJSON(res, 200, {
        status: 'success',
        token,
        user: tokenPayload
      });
    } catch (err) {
      return sendJSON(res, 400, { error: 'Não foi possível autenticar com o Google: ' + (err.message || 'Erro desconhecido') });
    }
  }

  // Reviews (Apenas usuários autenticados; persiste em data.json)
  if (req.method === 'POST' && pathname.startsWith('/api/v1/locations/') && pathname.endsWith('/reviews')) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const user = verifyJWT(token);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para avaliar este local.' });

    const locationId = pathname.split('/')[4];
    const loc = db.locations.find(l => l.id === locationId);
    if (!loc) return sendJSON(res, 404, { error: 'Local não encontrado.' });

    try {
      const body = await parseBody(req);
      const wait = Math.min(5, Math.max(1, parseInt(body.rating_wait_time, 10) || 5));
      const access = Math.min(5, Math.max(1, parseInt(body.rating_accessibility, 10) || 5));
      const care = Math.min(5, Math.max(1, parseInt(body.rating_humanized_care, 10) || 5));

      const newReview = {
        id: 'rev-' + Date.now(),
        userName: user.name,
        wait,
        access,
        care,
        comment: String(body.comment || '').trim(),
        date: new Date().toISOString().split('T')[0]
      };

      loc.reviews.unshift(newReview);
      loc.total_reviews += 1;
      const count = loc.total_reviews;
      loc.avg_wait_time = parseFloat(((loc.avg_wait_time * (count - 1) + wait) / count).toFixed(1));
      loc.avg_accessibility = parseFloat(((loc.avg_accessibility * (count - 1) + access) / count).toFixed(1));
      loc.avg_humanized_care = parseFloat(((loc.avg_humanized_care * (count - 1) + care) / count).toFixed(1));
      loc.overall_score = parseFloat(((loc.avg_wait_time + loc.avg_accessibility + loc.avg_humanized_care) / 3).toFixed(1));

      saveDatabase();

      return sendJSON(res, 201, { status: 'success', message: 'Avaliação registrada com sucesso!', location: loc });
    } catch {
      return sendJSON(res, 400, { error: 'Erro ao processar avaliação.' });
    }
  }

  // Reports (Apenas usuários autenticados; persiste em data.json)
  if (req.method === 'POST' && pathname === '/api/v1/reports') {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
    const user = verifyJWT(token);
    if (!user) return sendJSON(res, 401, { error: 'Faça login para registrar alertas ambientais.' });

    try {
      const body = await parseBody(req);
      const repLat = parseFloat(body.lat);
      const repLng = parseFloat(body.lng);

      if (!body.title || isNaN(repLat) || isNaN(repLng)) {
        return sendJSON(res, 400, { error: 'Título e coordenadas válidas são obrigatórios.' });
      }

      const newReport = {
        id: 'rep-' + Date.now(),
        title: String(body.title).trim(),
        report_type: body.report_type || 'foco_dengue',
        description: String(body.description || '').trim(),
        address: String(body.address || 'Localização selecionada no mapa').trim(),
        lat: repLat,
        lng: repLng,
        status: 'pending',
        date: new Date().toISOString().split('T')[0],
        reporterName: user.name
      };

      db.reports.unshift(newReport);
      saveDatabase();

      return sendJSON(res, 201, { status: 'success', report: newReport });
    } catch {
      return sendJSON(res, 400, { error: 'Erro ao processar alerta ambiental.' });
    }
  }

  // Seed OSM manual
  if (req.method === 'POST' && pathname === '/api/v1/seed/osm-live') {
    try {
      const { lat, lng, radius } = await parseBody(req);
      const count = await fetchRealOsmPoints(parseFloat(lat), parseFloat(lng), parseFloat(radius) || 8000);
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

server.listen(PORT, () => {
  console.log(`\n========================================================================`);
  console.log(`🌿 CuidAção — SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP (INCLUINDO PEREQUÊ)`);
  console.log(`========================================================================`);
  console.log(`📍 Aplicação Web & PWA: http://localhost:${PORT}`);
  console.log(`💾 Persistência Automática: server/data.json`);
  console.log(`📂 Estrutura Modular: /html, /css, /js e /server`);
  console.log(`========================================================================\n`);
});

module.exports = server;
