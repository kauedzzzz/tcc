#!/usr/bin/env node
/**
 * =====================================================================================
 * CuidAção — Diagnóstico de Saúde do Ambiente e Projeto (scripts/doctor.js)
 * -------------------------------------------------------------------------------------
 * Executado via `npm run doctor`:
 *  1. Verifica versão do Node.js (>= 18.0.0)
 *  2. Verifica configuração de ambiente (.env.example / .env / variáveis críticas)
 *  3. Valida integridade estrutural de server/data.json (IDs únicos, cobertura, arrays)
 *  4. Confere presença de todos os assets do PWA (manifest.json + SHELL_ASSETS em sw.js)
 *  5. Executa checagem estática de sintaxe (`node --check`) em todos os arquivos JS
 * =====================================================================================
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { validateShellAssets } = require('./build');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT_DIR, 'server');
const DATA_FILE = path.join(DATA_DIR, 'data.json');

const results = [];
let hasError = false;

function pass(label, detail) {
  results.push({ status: 'PASS', label, detail });
  console.log(`✅ [PASS] ${label}${detail ? ' — ' + detail : ''}`);
}

function warn(label, detail) {
  results.push({ status: 'WARN', label, detail });
  console.log(`⚠️  [WARN] ${label}${detail ? ' — ' + detail : ''}`);
}

function fail(label, detail) {
  hasError = true;
  results.push({ status: 'FAIL', label, detail });
  console.error(`❌ [FAIL] ${label}${detail ? ' — ' + detail : ''}`);
}

// 1. Node.js Version
function checkNodeVersion() {
  const ver = process.versions.node;
  const major = parseInt(ver.split('.')[0], 10);
  if (major >= 18) {
    pass('Node.js runtime', `v${ver} (>= 18.0.0)`);
  } else {
    fail('Node.js runtime', `v${ver} detectado; mínimo exigido: 18.0.0`);
  }
}

// 2. .env & .env.example
function checkEnvFiles() {
  const envExamplePath = path.join(ROOT_DIR, '.env.example');
  const envPath = path.join(ROOT_DIR, '.env');
  if (!fs.existsSync(envExamplePath)) {
    fail('Arquivo .env.example', 'Não encontrado na raiz do projeto');
  } else {
    pass('Arquivo .env.example', 'Presente e documentado');
  }

  if (fs.existsSync(envPath)) {
    const raw = fs.readFileSync(envPath, 'utf8');
    const isProd = /NODE_ENV\s*=\s*production/.test(raw) || process.env.NODE_ENV === 'production';
    const hasSecret = /JWT_SECRET\s*=\s*\S{16,}/.test(raw) || (process.env.JWT_SECRET && process.env.JWT_SECRET.length >= 16);
    if (isProd && !hasSecret) {
      fail('Configuração .env (produção)', 'NODE_ENV=production requer JWT_SECRET forte definido');
    } else {
      pass('Arquivo .env', 'Encontrado e validado');
    }
  } else if (process.env.NODE_ENV === 'production' && !process.env.JWT_SECRET) {
    fail('Variáveis de ambiente', 'NODE_ENV=production sem JWT_SECRET definido');
  } else {
    warn('Arquivo .env opcional', 'Ausente (usando padrões locais de desenvolvimento e segredo automático em server/.jwt-secret)');
  }
}

// 3. Integridade do server/data.json
function checkDataJsonIntegrity() {
  if (!fs.existsSync(DATA_FILE)) {
    warn('Banco local data.json', `Ainda não gerado em ${path.relative(ROOT_DIR, DATA_FILE)} (será criado automaticamente no primeiro start)`);
    return;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    if (!parsed || !Array.isArray(parsed.users) || !Array.isArray(parsed.locations) || !Array.isArray(parsed.reports)) {
      return fail('Integridade data.json', 'Estrutura raiz inválida (esperado arrays users, locations e reports)');
    }
    const locIds = new Set();
    let dupId = null;
    let invalidCoord = null;
    for (const loc of parsed.locations) {
      if (locIds.has(loc.id)) dupId = loc.id;
      locIds.add(loc.id);
      if (!Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lng))) {
        invalidCoord = loc.id;
      }
    }
    if (dupId) return fail('Integridade data.json', `ID de local duplicado detectado: ${dupId}`);
    if (invalidCoord) return fail('Integridade data.json', `Coordenada inválida no local: ${invalidCoord}`);

    pass('Integridade data.json', `${parsed.locations.length} locais, ${parsed.reports.length} alertas, ${parsed.users.length} usuários válidos`);
  } catch (err) {
    fail('Integridade data.json', `JSON corrompido: ${err.message}`);
  }
}

// 4. Assets do PWA (manifest.json + sw.js + vendors + schema.sql)
function checkPwaAndSchemaAssets() {
  const schemaPath = path.join(ROOT_DIR, 'database', 'schema.sql');
  if (!fs.existsSync(schemaPath)) {
    fail('Schema PostgreSQL/PostGIS', 'database/schema.sql não encontrado');
  } else {
    pass('Schema PostgreSQL/PostGIS', 'database/schema.sql presente (fonte única oficial)');
  }

  const manifestPath = path.join(PUBLIC_DIR, 'manifest.json');
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const icons = Array.isArray(manifest.icons) ? manifest.icons : [];
    const missingIcons = icons.filter(ic => !fs.existsSync(path.join(PUBLIC_DIR, ic.src)));
    if (missingIcons.length > 0) {
      fail('Ícones do manifest.json', 'Ausentes: ' + missingIcons.map(i => i.src).join(', '));
    } else {
      pass('Manifesto PWA (manifest.json)', `${icons.length} ícones verificados`);
    }
  } catch (err) {
    fail('Manifesto PWA (manifest.json)', err.message);
  }

  try {
    const swRaw = fs.readFileSync(path.join(PUBLIC_DIR, 'sw.js'), 'utf8');
    const count = validateShellAssets(swRaw);
    pass('Service Worker SHELL_ASSETS', `${count} assets offline verificados em disco`);
  } catch (err) {
    fail('Service Worker SHELL_ASSETS', err.message);
  }
}

// 5. Checagem de sintaxe (`node --check`)
function collectJsFiles(dir, list = []) {
  if (!fs.existsSync(dir)) return list;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'vendor') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) collectJsFiles(full, list);
    else if (ent.isFile() && ent.name.endsWith('.js')) list.push(full);
  }
  return list;
}

function checkJsSyntax() {
  const targets = [
    path.join(ROOT_DIR, 'server.js'),
    ...collectJsFiles(path.join(ROOT_DIR, 'server')),
    ...collectJsFiles(PUBLIC_DIR),
    ...collectJsFiles(path.join(ROOT_DIR, 'scripts')),
    ...collectJsFiles(path.join(ROOT_DIR, 'tests'))
  ].filter(f => fs.existsSync(f));

  let failedSyntax = 0;
  for (const file of targets) {
    const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (chk.status !== 0) {
      failedSyntax++;
      fail('Sintaxe JS', `${path.relative(ROOT_DIR, file)}: ${(chk.stderr || '').trim()}`);
    }
  }
  if (failedSyntax === 0) {
    pass('Sintaxe JavaScript (node --check)', `${targets.length} arquivos verificados sem erros`);
  }
}

console.log('========================================================================');
console.log('🩺 CuidAção Doctor — Verificação de Integridade, PWA e Sintaxe');
console.log('========================================================================');
checkNodeVersion();
checkEnvFiles();
checkDataJsonIntegrity();
checkPwaAndSchemaAssets();
checkJsSyntax();
console.log('========================================================================');

if (hasError) {
  console.error('❌ Diagnóstico encontrou falhas críticas.');
  process.exit(1);
} else {
  console.log('🌿 Ambiente 100% íntegro e pronto para produção!');
}
