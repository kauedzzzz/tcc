#!/usr/bin/env node
/**
 * =====================================================================================
 * CuidAção — Job de Sincronização Territorial e Ambiental (scripts/sync-osm-guaruja.js)
 * -------------------------------------------------------------------------------------
 * Executável via CLI (`npm run sync:osm` ou `node scripts/sync-osm-guaruja.js [--dry-run]`)
 * ou agendado via cron:
 *  1. Sincroniza pontos do OpenStreetMap no Guarujá/SP (tratando inclusive ecopontos/PEVs
 *     e parques/áreas verdes sem tag `name`, nomeando-os pelo bairro mais próximo).
 *  2. Enriquece contexto epidemiológico com previsão de chuva e temperatura via Open-Meteo
 *     para cálculo de risco preventivo de proliferação do Aedes aegypti.
 *  3. Atualiza indicadores de balneabilidade e monitoramento das praias do Guarujá.
 * =====================================================================================
 */

'use strict';

const https = require('https');
const {
  db,
  flushDatabase,
  GUARUJA_CENTER,
  findNearestLocalPlace,
  calculateDistanceMeters
} = require('../server/database');

const GUARUJA_BEACHES = [
  { slug: 'pereque', name: 'Praia do Perequê', neighborhood: 'Perequê', lat: -23.93780, lng: -46.18050, profile: 'Pesca artesanal & foz de rios — atenção após chuvas fortes' },
  { slug: 'pernambuco', name: 'Praia de Pernambuco', neighborhood: 'Balneário Praia do Pernambuco', lat: -23.96820, lng: -46.19120, profile: 'Águas abertas costeiras' },
  { slug: 'mar-casado', name: 'Praia do Mar Casado', neighborhood: 'Mar Casado / Pernambuco', lat: -23.97180, lng: -46.18720, profile: 'Baía abrigada' },
  { slug: 'enseada', name: 'Praia da Enseada', neighborhood: 'Enseada', lat: -23.98650, lng: -46.22910, profile: 'Orla urbana extensa monitorada' },
  { slug: 'pitangueiras', name: 'Praia das Pitangueiras', neighborhood: 'Pitangueiras', lat: -23.99460, lng: -46.25890, profile: 'Orla central monitorada' },
  { slug: 'asturias', name: 'Praia das Astúrias', neighborhood: 'Astúrias', lat: -24.00180, lng: -46.26470, profile: 'Baía calma' },
  { slug: 'tombo', name: 'Praia do Tombo (Bandeira Azul)', neighborhood: 'Jardim Las Palmas', lat: -24.01420, lng: -46.27250, profile: 'Certificação internacional Bandeira Azul' },
  { slug: 'guaiuba', name: 'Praia do Guaiúba', neighborhood: 'Guaiúba', lat: -24.01850, lng: -46.29120, profile: 'Reserva costeira' },
  { slug: 'prainha-branca', name: 'Prainha Branca', neighborhood: 'Serra do Guararu', lat: -23.86850, lng: -46.13550, profile: 'APA Serra do Guararu / Mata Atlântica' }
];

function httpsJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, {
      method: options.method || 'GET',
      headers: {
        'User-Agent': 'CuidAcaoOneHealthSync/2.0 (guarujasp-pesquisa)',
        ...(options.headers || {})
      },
      timeout: options.timeout || 10000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    if (options.body) req.write(options.body);
    req.end();
  });
}

/**
 * Converte um elemento OSM Overpass em objeto de local CuidAção, tratando inclusive
 * pontos de reciclagem/ecopontos e parques sem tag `name`!
 */
function mapOsmElementToLocation(el, index = 0) {
  if (!el || typeof el !== 'object') return null;
  const tags = el.tags || {};
  const elLat = Number(el.lat !== undefined ? el.lat : (el.center && el.center.lat));
  const elLon = Number(el.lon !== undefined ? el.lon : (el.center && el.center.lon));
  if (!Number.isFinite(elLat) || !Number.isFinite(elLon)) return null;

  const nearest = findNearestLocalPlace(elLat, elLon);
  const neighborhood = tags['addr:suburb'] || tags['addr:neighbourhood'] ||
    (nearest.distance <= 8000 ? nearest.place.neighborhood : 'Guarujá');

  let name = (tags.name || tags['name:pt'] || '').trim();
  // Tratamento especial para ecopontos/reciclagem e parques sem tag `name`
  if (!name) {
    if (tags.amenity === 'recycling') {
      const mat = tags['recycling:glass_bottles'] || tags['recycling:cans'] || tags['recycling:plastic']
        ? 'Coleta Seletiva'
        : 'PEV / Reciclagem';
      name = `${mat} Comunitário — ${neighborhood}`;
    } else if (tags.leisure === 'park' || tags.leisure === 'nature_reserve') {
      name = `Área Verde / Praça Comunitária — ${neighborhood}`;
    } else {
      return null;
    }
  }

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
    services = ['Pronto Atendimento', 'Emergência 24h'];
  } else if (tags.amenity === 'pharmacy') {
    catId = 'cat-3';
    catName = 'Farmácia & Drogaria';
    color = '#8B5CF6';
    iconType = 'pill';
    services = ['Medicamentos', 'Atendimento Farmacêutico'];
  } else if (tags.amenity === 'recycling') {
    catId = 'cat-4';
    catName = 'Ecoponto - Descarte Consciente';
    domain = 'environment';
    color = '#2563EB';
    iconType = 'recycle';
    services = ['Reciclagem Seletiva', 'Logística Reversa'];
  } else if (tags.leisure === 'park' || tags.leisure === 'nature_reserve') {
    catId = 'cat-5';
    catName = 'Parque & Área Verde (Mata Atlântica)';
    domain = 'environment';
    color = '#059669';
    iconType = 'tree';
    services = ['Área Verde', 'Convivência e Bem-Estar'];
  } else if (tags.amenity === 'veterinary' || tags.amenity === 'animal_shelter') {
    catId = 'cat-6';
    catName = 'Saúde Animal & Controle de Zoonoses';
    domain = 'animal';
    color = '#0D9488';
    iconType = 'paw';
    services = ['Saúde Animal', 'Prevenção de Zoonoses'];
  }

  const street = tags['addr:street']
    ? `${tags['addr:street']}${tags['addr:housenumber'] ? ', ' + tags['addr:housenumber'] : ''}`
    : `Próximo a ${nearest.place.name}`;
  const is24h = tags.amenity === 'hospital' || tags.leisure === 'park' || tags.opening_hours === '24/7';
  const hours = is24h
    ? { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } }
    : { '1': { open: '08:00', close: '18:00' }, '2': { open: '08:00', close: '18:00' }, '3': { open: '08:00', close: '18:00' }, '4': { open: '08:00', close: '18:00' }, '5': { open: '08:00', close: '18:00' } };

  return {
    id: `osm-${el.type || 'node'}-${el.id || index}`,
    categoryId: catId,
    categoryName: catName,
    domain,
    color,
    iconType,
    has_popular_pharmacy: catId === 'cat-3' ? /popular/i.test(name) : false,
    name,
    address: `${street} - ${neighborhood}, Guarujá - SP`,
    city: 'Guarujá',
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
  };
}

function evaluateAedesClimateRisk(maxTempC, rainSum3dMm) {
  if (maxTempC >= 27 && rainSum3dMm >= 15) {
    return {
      level: 'alto',
      recommendation: 'Alerta Preventivo Aedes: calor intenso + acumulado de chuva favorecem eclosão de ovos em até 7 dias. Vistoriar calhas, pratos e ralos no Perequê e bairros costeiros.'
    };
  }
  if (maxTempC >= 24 && rainSum3dMm >= 5) {
    return {
      level: 'moderado',
      recommendation: 'Atenção moderada: temperaturas amenas/quentes com pancadas costeiras exigem eliminação semanal de água parada.'
    };
  }
  return {
    level: 'baixo',
    recommendation: 'Risco climático reduzido no momento; manter rotina preventiva nas residências.'
  };
}

function computeBeachBathability(rainSum3dMm = 0) {
  return GUARUJA_BEACHES.map(b => {
    // Chuvas intensas (> 35mm em 72h) impactam temporariamente praias com deságue de canais/rios costeiros
    const sensitiveToRain = b.slug === 'pereque' || b.slug === 'enseada';
    const status = (rainSum3dMm > 35 && sensitiveToRain) ? 'atencao_pos_chuva' : 'propria';
    return {
      slug: b.slug,
      name: b.name,
      neighborhood: b.neighborhood,
      lat: b.lat,
      lng: b.lng,
      status,
      label: status === 'propria' ? 'Própria / Monitorada' : 'Atenção pós-chuva intensa (aguardar 24h)',
      profile: b.profile
    };
  });
}

async function runSync(options = {}) {
  const dryRun = !!options.dryRun || process.argv.includes('--dry-run');
  let osmAdded = 0;

  // 1. OpenStreetMap Overpass
  const overpassQuery = `
    [out:json][timeout:18];
    (
      nwr["amenity"~"hospital|clinic|doctors|pharmacy|recycling|veterinary"](around:12000, ${GUARUJA_CENTER.lat}, ${GUARUJA_CENTER.lng});
      nwr["leisure"~"park|nature_reserve"](around:12000, ${GUARUJA_CENTER.lat}, ${GUARUJA_CENTER.lng});
    );
    out center 100;
  `;

  try {
    const body = 'data=' + encodeURIComponent(overpassQuery);
    const osmJson = await httpsJson('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });
    const elements = Array.isArray(osmJson.elements) ? osmJson.elements : [];
    elements.forEach((el, idx) => {
      const mapped = mapOsmElementToLocation(el, idx);
      if (!mapped) return;
      const exists = db.locations.some(l =>
        l.id === mapped.id ||
        l.name.toLowerCase() === mapped.name.toLowerCase() ||
        calculateDistanceMeters(mapped.lat, mapped.lng, l.lat, l.lng) < 35
      );
      if (!exists) {
        if (!dryRun) db.locations.push(mapped);
        osmAdded++;
      }
    });
  } catch (err) {
    console.warn('ℹ️ Overpass indisponível/offline (mantendo base local):', err.message);
  }

  // 2. Clima & Chuva (Open-Meteo — gratuito e sem chave) para risco de Aedes + Balneabilidade
  let maxTempC = 28.0;
  let rainSum3dMm = 12.0;
  let weatherSource = 'estimativa-costeira-local';

  try {
    const meteoUrl = `https://api.open-meteo.com/v1/forecast?latitude=${GUARUJA_CENTER.lat}&longitude=${GUARUJA_CENTER.lng}&daily=temperature_2m_max,precipitation_sum&timezone=America%2FSao_Paulo&forecast_days=3`;
    const meteo = await httpsJson(meteoUrl, { timeout: 6000 });
    if (meteo && meteo.daily) {
      const temps = meteo.daily.temperature_2m_max || [];
      const rains = meteo.daily.precipitation_sum || [];
      if (temps.length > 0) maxTempC = Math.max(...temps.map(Number).filter(Number.isFinite));
      if (rains.length > 0) rainSum3dMm = Math.round(rains.reduce((a, v) => a + (Number(v) || 0), 0) * 10) / 10;
      weatherSource = 'open-meteo';
    }
  } catch (err) {
    console.warn('ℹ️ Open-Meteo indisponível/offline (usando parâmetros costeiros padrão):', err.message);
  }

  const aedesRisk = evaluateAedesClimateRisk(maxTempC, rainSum3dMm);
  const beaches = computeBeachBathability(rainSum3dMm);

  const envContext = {
    updated_at: new Date().toISOString(),
    weather_source: weatherSource,
    max_temp_3d_c: maxTempC,
    rain_sum_3d_mm: rainSum3dMm,
    aedes_risk: aedesRisk,
    beaches
  };

  if (!dryRun) {
    db.environmental_context = envContext;
    flushDatabase();
  }

  console.log(`✅ Sync Guarujá concluído${dryRun ? ' (DRY-RUN)' : ''}: +${osmAdded} pontos OSM • Risco Aedes: ${aedesRisk.level.toUpperCase()} (${maxTempC}°C / ${rainSum3dMm}mm 72h) • ${beaches.length} praias avaliadas.`);
  return { osmAdded, envContext };
}

if (require.main === module) {
  runSync().catch(err => {
    console.error('❌ Erro na sincronização:', err.message);
    process.exit(1);
  });
}

module.exports = {
  mapOsmElementToLocation,
  evaluateAedesClimateRisk,
  computeBeachBathability,
  runSync
};
