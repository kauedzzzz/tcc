/**
 * =====================================================================================
 * CuidAção — Suíte de Testes de Integração HTTP (node:test + node:assert/strict)
 * -------------------------------------------------------------------------------------
 * Sobe instâncias reais de server/server.js em porta aleatória (PORT=0) e DATA_DIR
 * temporário isolado, validando:
 *  - Health check e cabeçalhos de segurança (CSP / HSTS em produção)
 *  - Cadastro (register), anti-auto-promoção de role e login
 *  - Bloqueio de login demo em NODE_ENV=production
 *  - Rate limit (HTTP 429 + Retry-After)
 *  - Criação de review e bloqueio de 2ª review no mesmo dia (HTTP 409)
 *  - Criação, deduplicação 50m, confirmação comunitária, comentários e transição RBAC
 *    de status em reports (pending -> in_analysis -> resolved)
 *  - Proteção contra path traversal em arquivos estáticos e uploads (HTTP 403)
 *  - Busca por CEP do Guarujá (11446-000), busca textual ("UPA 24h"), analytics e GeoJSON
 * =====================================================================================
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVER_ENTRY = path.join(ROOT_DIR, 'server', 'server.js');

function startIsolatedServer(extraEnv = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cuidacao-int-'));
  const env = {
    ...process.env,
    PORT: '0',
    DATA_DIR: tmpDir,
    JWT_SECRET: 'integration-test-jwt-secret-key-secure-2026-tcc',
    NO_AUTO_LISTEN: '0',
    ...extraEnv
  };

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [SERVER_ENTRY], {
      cwd: ROOT_DIR,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`Timeout ao iniciar servidor. stdout=${stdout} stderr=${stderr}`));
    }, 8000);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      const m = stdout.match(/http:\/\/localhost:(\d+)/);
      if (m) {
        clearTimeout(timer);
        const port = parseInt(m[1], 10);
        resolve({
          baseUrl: `http://127.0.0.1:${port}`,
          tmpDir,
          async stop() {
            if (!child.killed) {
              await new Promise(r => {
                child.once('exit', r);
                child.kill('SIGTERM');
              });
            }
            fs.rmSync(tmpDir, { recursive: true, force: true });
          }
        });
      }
    });

    child.stderr.on('data', chunk => {
      stderr += chunk.toString('utf8');
    });

    child.once('exit', code => {
      if (!stdout.includes('http://localhost:')) {
        clearTimeout(timer);
        reject(new Error(`Servidor encerrou prematuramente (${code}): ${stderr}`));
      }
    });
  });
}

test('Fluxo completo HTTP: health, auth, reviews (1x/dia 409), reports (RBAC/confirm/comments), CEP, GeoJSON e path traversal (403)', async () => {
  const srv = await startIsolatedServer({ NODE_ENV: 'development' });
  try {
    // 1. Health check + Security Headers
    const healthRes = await fetch(`${srv.baseUrl}/api/v1/health`);
    assert.equal(healthRes.status, 200);
    assert.ok(healthRes.headers.get('content-security-policy'));
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    const healthJson = await healthRes.json();
    assert.equal(healthJson.status, 'ok');

    // 2. Register & Login (com bloqueio de auto-promoção para admin)
    const regRes = await fetch(`${srv.baseUrl}/api/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Cidadã Guarujá',
        email: 'cidada.teste@guaruja.sp.gov.br',
        password: 'SenhaSegura123',
        role: 'admin'
      })
    });
    assert.equal(regRes.status, 201);
    const regJson = await regRes.json();
    assert.equal(regJson.user.role, 'citizen');
    assert.ok(regJson.token);

    const loginRes = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'cidada.teste@guaruja.sp.gov.br',
        password: 'SenhaSegura123'
      })
    });
    assert.equal(loginRes.status, 200);
    const { token: citizenToken } = await loginRes.json();

    // Login do agente de saúde do seed para testar moderação RBAC
    const agentLoginRes = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'agente@onehealth.org',
        password: 'agente123456'
      })
    });
    assert.equal(agentLoginRes.status, 200);
    const { token: agentToken, user: agentUser } = await agentLoginRes.json();
    assert.equal(agentUser.role, 'agent');

    // 3. Avaliação de local (1ª retorna 201; 2ª no mesmo dia retorna 409) + rota exata
    const extraSegRes = await fetch(`${srv.baseUrl}/api/v1/locations/loc-pereque-1/segmento-invalido`);
    assert.equal(extraSegRes.status, 404);

    const rev1 = await fetch(`${srv.baseUrl}/api/v1/locations/loc-pereque-1/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${citizenToken}`
      },
      body: JSON.stringify({
        rating_wait_time: 5,
        rating_accessibility: 5,
        rating_humanized_care: 5,
        comment: 'Excelente atendimento na USAFA Perequê!'
      })
    });
    assert.equal(rev1.status, 201);

    const rev2 = await fetch(`${srv.baseUrl}/api/v1/locations/loc-pereque-1/reviews`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${citizenToken}`
      },
      body: JSON.stringify({
        rating_wait_time: 4,
        rating_accessibility: 4,
        rating_humanized_care: 4,
        comment: 'Segunda tentativa no mesmo dia'
      })
    });
    assert.equal(rev2.status, 409);

    // 4. Reports: criação, deduplicação 50m, confirmação comunitária, comentários e transição de status RBAC
    const repCreate = await fetch(`${srv.baseUrl}/api/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${citizenToken}`
      },
      body: JSON.stringify({
        title: 'Descarte irregular próximo à trilha',
        report_type: 'descarte_irregular',
        description: 'Sacolas e garrafas plásticas acumulando água.',
        address: 'Cachoeira do Perequê, Guarujá - SP',
        lat: -23.93250,
        lng: -46.18850,
        urgency: 4
      })
    });
    assert.equal(repCreate.status, 201);
    const { report: createdReport } = await repCreate.json();
    assert.equal(createdReport.status, 'pending');
    assert.ok(createdReport.nearest_ubs);
    assert.ok(createdReport.nearest_ecoponto);

    // Deduplicação a menos de 50m
    const repDup = await fetch(`${srv.baseUrl}/api/v1/reports`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`
      },
      body: JSON.stringify({
        title: 'Mesmo descarte',
        report_type: 'descarte_irregular',
        description: 'Relato duplicado a poucos metros',
        lat: -23.93255,
        lng: -46.18855
      })
    });
    assert.equal(repDup.status, 409);

    // Confirmação comunitária pelo agente (1ª = 200, 2ª = 409)
    const conf1 = await fetch(`${srv.baseUrl}/api/v1/reports/${createdReport.id}/confirm`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agentToken}` }
    });
    assert.equal(conf1.status, 200);
    const conf2 = await fetch(`${srv.baseUrl}/api/v1/reports/${createdReport.id}/confirm`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${agentToken}` }
    });
    assert.equal(conf2.status, 409);

    // Comentário no alerta
    const commRes = await fetch(`${srv.baseUrl}/api/v1/reports/${createdReport.id}/comments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${citizenToken}`
      },
      body: JSON.stringify({ text: 'Equipe da SEMAM acionada para recolhimento.' })
    });
    assert.equal(commRes.status, 201);

    // Transição de status: citizen bloqueado (403); agent permitido (pending -> in_analysis -> resolved)
    const citizenMod = await fetch(`${srv.baseUrl}/api/v1/reports/${createdReport.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${citizenToken}`
      },
      body: JSON.stringify({ status: 'in_analysis' })
    });
    assert.equal(citizenMod.status, 403);

    const agentMod1 = await fetch(`${srv.baseUrl}/api/v1/reports/${createdReport.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`
      },
      body: JSON.stringify({ status: 'in_analysis' })
    });
    assert.equal(agentMod1.status, 200);
    assert.equal((await agentMod1.json()).report.status, 'in_analysis');

    const agentMod2 = await fetch(`${srv.baseUrl}/api/v1/reports/${createdReport.id}/status`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${agentToken}`
      },
      body: JSON.stringify({ status: 'resolved' })
    });
    assert.equal(agentMod2.status, 200);
    assert.equal((await agentMod2.json()).report.status, 'resolved');

    // 5. Busca por CEP 11446-000 e busca textual "UPA 24h" + GeoJSON + Analytics
    const cepSearch = await fetch(`${srv.baseUrl}/api/v1/geo/search?q=11446-000`);
    assert.equal(cepSearch.status, 200);
    const cepJson = await cepSearch.json();
    assert.ok(cepJson.results.length >= 1);
    assert.equal(cepJson.results[0].inCoverage, true);

    const upaSearch = await fetch(`${srv.baseUrl}/api/v1/locations?search=${encodeURIComponent('UPA 24h')}`);
    assert.equal(upaSearch.status, 200);
    assert.ok((await upaSearch.json()).data.length >= 1);

    const geoRes = await fetch(`${srv.baseUrl}/api/v1/export/reports.geojson`);
    assert.equal(geoRes.status, 200);
    assert.equal((await geoRes.json()).type, 'FeatureCollection');

    // 6. Proteção contra Path Traversal (HTTP 403)
    const travStatic = await fetch(`${srv.baseUrl}/..%2Fserver%2Fserver.js`);
    assert.equal(travStatic.status, 403);
    const travUploads = await fetch(`${srv.baseUrl}/api/v1/uploads/..%2Fdata.json`);
    assert.equal(travUploads.status, 403);
  } finally {
    await srv.stop();
  }
});

test('Ambiente de produção (NODE_ENV=production) bloqueia login demo, aplica HSTS e impõe rateLimited (429)', async () => {
  const srv = await startIsolatedServer({
    NODE_ENV: 'production',
    ALLOW_DEMO_LOGIN: '0',
    SEED_DEMO_DATA: '0'
  });
  try {
    // 1. HSTS ativo em produção e demoLogin desabilitado
    const cfgRes = await fetch(`${srv.baseUrl}/api/v1/auth/google/config`);
    assert.equal(cfgRes.status, 200);
    assert.ok(cfgRes.headers.get('strict-transport-security'));
    const cfgJson = await cfgRes.json();
    assert.equal(cfgJson.demoLogin, false);

    // 2. Tentativa de login demo por e-mail bloqueada com 403
    const demoAttempt = await fetch(`${srv.baseUrl}/api/v1/auth/google`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'invasor@gmail.com', name: 'Invasor' })
    });
    assert.equal(demoAttempt.status, 403);

    // 3. Rate limit (bucket auth permite até 10 tentativas em POST /api/v1/auth/login; 11ª retorna 429)
    let hit429 = false;
    for (let i = 0; i < 12; i++) {
      const r = await fetch(`${srv.baseUrl}/api/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: `tentativa${i}@teste.com`, password: 'errada' })
      });
      if (r.status === 429) {
        hit429 = true;
        assert.ok(r.headers.get('retry-after'));
        break;
      }
    }
    assert.equal(hit429, true, 'Deve retornar HTTP 429 após exceder o limite de tentativas de login');
  } finally {
    await srv.stop();
  }
});
