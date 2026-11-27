/**
 * =====================================================================================
 * CuidAção — Suíte de Testes Unitários Nativos (node:test + node:assert/strict)
 * -------------------------------------------------------------------------------------
 * Cobertura:
 *  - calculateDistanceMeters (Haversine)
 *  - findNearestLocalPlace (Gazetteer Guarujá/Perequê)
 *  - hashPassword / verifyPassword (scrypt moderno com salt e SHA-256 legado)
 *  - generateJWT / verifyJWT (assinatura HMAC, alg === HS256 e exigência de exp numérico)
 *  - inCoverage (limites geográficos do Guarujá/SP)
 *  - recomputeLocationMetrics (cálculo exato sem erro de arredondamento acumulado)
 *  - Backup rotativo comprimido (zlib.gzipSync / gunzipSync)
 *  - PostgresRepository (adapter SQL/PostGIS com pool injetado) e sync-osm-guaruja
 * =====================================================================================
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const tmpUnitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuidacao-unit-'));
process.env.DATA_DIR = tmpUnitDir;
process.env.NO_AUTO_LISTEN = '1';
process.env.JWT_SECRET = 'unit-test-jwt-secret-key-with-high-entropy-2026';

const {
  calculateDistanceMeters,
  findNearestLocalPlace,
  hashPassword,
  verifyPassword,
  recomputeLocationMetrics,
  PEREQUE_CENTER,
  JsonRepository,
  PostgresRepository
} = require('../server/database');

const server = require('../server/server');
const { generateJWT, verifyJWT, inCoverage } = server;
const { mapOsmElementToLocation, evaluateAedesClimateRisk } = require('../scripts/sync-osm-guaruja');

test.after(() => {
  fs.rmSync(tmpUnitDir, { recursive: true, force: true });
});

test('calculateDistanceMeters: calcula distância Haversine com precisão', () => {
  assert.equal(calculateDistanceMeters(PEREQUE_CENTER.lat, PEREQUE_CENTER.lng, PEREQUE_CENTER.lat, PEREQUE_CENTER.lng), 0);

  // Perequê (-23.93680, -46.18250) até Pitangueiras (-23.99103, -46.25892) ~ 9.8 km
  const d1 = calculateDistanceMeters(-23.93680, -46.18250, -23.99103, -46.25892);
  const d2 = calculateDistanceMeters(-23.99103, -46.25892, -23.93680, -46.18250);
  assert.equal(d1, d2);
  assert.ok(d1 > 9000 && d1 < 10500, `Distância esperada ~9.8km, obtida: ${d1}m`);
});

test('findNearestLocalPlace: identifica corretamente Perequê e Vicente de Carvalho', () => {
  const nearPereque = findNearestLocalPlace(-23.9369, -46.1824);
  assert.equal(nearPereque.place.neighborhood, 'Perequê');
  assert.ok(nearPereque.distance < 100);

  const nearVicente = findNearestLocalPlace(-23.9411, -46.2894);
  assert.equal(nearVicente.place.neighborhood, 'Vicente de Carvalho');
  assert.ok(nearVicente.distance < 100);
});

test('hashPassword e verifyPassword: suporta scrypt com salt e hash legado SHA-256', () => {
  const hash = hashPassword('SenhaForte@2026');
  assert.ok(hash.startsWith('scrypt$'));
  assert.equal(verifyPassword('SenhaForte@2026', hash), true);
  assert.equal(verifyPassword('SenhaErrada', hash), false);
  assert.equal(verifyPassword('', hash), false);

  // Compatibilidade retroativa com SHA-256 legado
  const legacyPass = 'legado123';
  const legacySha = crypto.createHash('sha256').update(legacyPass).digest('hex');
  assert.equal(verifyPassword(legacyPass, legacySha), true);
  assert.equal(verifyPassword('outro', legacySha), false);
});

test('generateJWT e verifyJWT: valida alg === HS256, assinatura e expiração numérica obrigatória', () => {
  const token = generateJWT({ id: 'usr-test', name: 'Kauê', role: 'citizen' });
  const decoded = verifyJWT(token);
  assert.ok(decoded);
  assert.equal(decoded.id, 'usr-test');
  assert.equal(typeof decoded.exp, 'number');

  // Assinatura adulterada
  assert.equal(verifyJWT(token.slice(0, -3) + 'abc'), null);

  const [headerB64, bodyB64] = token.split('.');

  // Header com alg !== HS256 deve ser rejeitado mesmo assinado
  const fakeHeader = Buffer.from(JSON.stringify({ alg: 'HS512', typ: 'JWT' })).toString('base64url');
  const fakeSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(fakeHeader + '.' + bodyB64).digest('base64url');
  assert.equal(verifyJWT(`${fakeHeader}.${bodyB64}.${fakeSig}`), null);

  // Token sem campo exp numérico deve ser rejeitado
  const noExpBody = Buffer.from(JSON.stringify({ id: 'usr-test' })).toString('base64url');
  const noExpSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(headerB64 + '.' + noExpBody).digest('base64url');
  assert.equal(verifyJWT(`${headerB64}.${noExpBody}.${noExpSig}`), null);

  // Token expirado deve ser rejeitado
  const expiredBody = Buffer.from(JSON.stringify({ id: 'usr-test', exp: Date.now() - 5000 })).toString('base64url');
  const expiredSig = crypto.createHmac('sha256', process.env.JWT_SECRET).update(headerB64 + '.' + expiredBody).digest('base64url');
  assert.equal(verifyJWT(`${headerB64}.${expiredBody}.${expiredSig}`), null);
});

test('inCoverage: aceita coordenadas no Guarujá e rejeita fora da cobertura ou inválidas', () => {
  assert.equal(inCoverage(-23.93680, -46.18250), true); // Perequê
  assert.equal(inCoverage(-24.01420, -46.27250), true); // Praia do Tombo
  assert.equal(inCoverage(-23.55052, -46.63331), false); // São Paulo (Praça da Sé / 01001-000)
  assert.equal(inCoverage(NaN, -46.18), false);
  assert.equal(inCoverage(null, null), false);
});

test('recomputeLocationMetrics: deriva médias exatas sem erro acumulado de arredondamento', () => {
  const emptyLoc = { reviews: [], total_reviews: 99, overall_score: 4.9 };
  recomputeLocationMetrics(emptyLoc);
  assert.equal(emptyLoc.total_reviews, 0);
  assert.equal(emptyLoc.overall_score, 0);

  const loc = {
    reviews: [
      { wait: 5, access: 4, care: 5 },
      { wait: 3, access: 5, care: 4 },
      { wait: 4, access: 4, care: 5 }
    ]
  };
  recomputeLocationMetrics(loc);
  assert.equal(loc.total_reviews, 3);
  assert.equal(loc.avg_wait_time, 4);
  assert.equal(loc.avg_accessibility, 4.3);
  assert.equal(loc.avg_humanized_care, 4.7);
  assert.equal(loc.overall_score, 4.3);
});

test('JsonRepository: gera backups rotativos comprimidos (.json.gz) válidos', () => {
  const bkpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuidacao-bkp-'));
  try {
    const repo = new JsonRepository({
      dataDir: bkpDir,
      seedFactory: () => ({ users: [], categories: [], locations: [], reports: [] }),
      recomputeLocationMetrics
    });

    const p1 = repo.createCompressedBackup({ maxBackups: 2 });
    const p2 = repo.createCompressedBackup({ maxBackups: 2 });
    const p3 = repo.createCompressedBackup({ maxBackups: 2 });
    assert.ok(p3 && fs.existsSync(p3));

    const gzFiles = fs.readdirSync(path.join(bkpDir, 'backups')).filter(f => f.endsWith('.json.gz'));
    assert.equal(gzFiles.length, 2, 'Deve rotacionar mantendo apenas maxBackups=2');

    const unzipped = JSON.parse(zlib.gunzipSync(fs.readFileSync(p3)).toString('utf8'));
    assert.ok(Array.isArray(unzipped.locations));
    assert.ok(p1 && p2);
  } finally {
    fs.rmSync(bkpDir, { recursive: true, force: true });
  }
});

test('PostgresRepository e sync-osm-guaruja: executam SQL PostGIS e tratam ecopontos sem tag name', async () => {
  const executedQueries = [];
  const mockPool = {
    async query(sql, params) {
      executedQueries.push({ sql: sql.trim(), params });
      return { rows: [{ cnt: 1 }] };
    },
    async end() {}
  };

  const pgRepo = new PostgresRepository({
    pool: mockPool,
    seedFactory: () => ({ users: [], categories: [], locations: [], reports: [] })
  });

  await pgRepo.syncEntity('report', {
    id: 'rep-pg-1',
    userId: 'usr-1',
    reporterName: 'Maria',
    report_type: 'foco_dengue',
    title: 'Água parada',
    description: 'Teste PostGIS',
    urgency: 4,
    address: 'Perequê',
    lat: -23.9368,
    lng: -46.1825,
    status: 'pending',
    confirmations: 1
  });
  assert.ok(executedQueries.some(q => q.sql.includes('ST_MakePoint')));
  await pgRepo.close();

  // Ecoponto e Parque OSM sem tag name recebem nome contextualizado pelo bairro
  const unnamedEco = mapOsmElementToLocation({
    type: 'node',
    id: 9991,
    lat: -23.9365,
    lon: -46.1822,
    tags: { amenity: 'recycling', 'recycling:plastic': 'yes' }
  });
  assert.ok(unnamedEco);
  assert.equal(unnamedEco.categoryId, 'cat-4');
  assert.ok(unnamedEco.name.includes('Perequê'));

  const unnamedPark = mapOsmElementToLocation({
    type: 'way',
    id: 9992,
    center: { lat: -23.9865, lon: -46.2291 },
    tags: { leisure: 'park' }
  });
  assert.ok(unnamedPark);
  assert.equal(unnamedPark.categoryId, 'cat-5');
  assert.ok(unnamedPark.name.includes('Enseada'));

  const highRisk = evaluateAedesClimateRisk(31, 28);
  assert.equal(highRisk.level, 'alto');
});
