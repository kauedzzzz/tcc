/**
 * =====================================================================================
 * PROJETO TCC: CuidAção - SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP
 * Persistência em Disco (data.json), Criptografia Scrypt com Salt e Gazetteer Geoespacial
 * Cobertura Completa de Todos os Bairros do Guarujá/SP (Destaque: Bairro do Perequê e Entorno)
 * Equipe Back-End & Banco de Dados: Kauê, Igor e Pedro
 * Equipe Front-End & Design do Site: Jamily e Yasmin
 * =====================================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// DATA_DIR permite apontar para um disco persistente em hospedagens (Render, Railway, Fly...)
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : __dirname;
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch { /* ignora */ }
const DATA_FILE_PATH = path.join(DATA_DIR, 'data.json');

// ============================================================================
// CRIPTOGRAFIA DE SENHAS COM SALT (CRYPTO.SCRYPTSYNC + TIMING-SAFE EQUAL)
// ============================================================================
function hashPassword(password) {
  const cleanPass = String(password || '');
  const salt = crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.scryptSync(cleanPass, salt, 64).toString('hex');
  return `scrypt$${salt}$${derivedKey}`;
}

function verifyPassword(password, storedHash) {
  try {
    if (!password || !storedHash) return false;
    const cleanPass = String(password);

    // Formato moderno com salt: scrypt$<salt>$<hash>
    if (storedHash.startsWith('scrypt$')) {
      const parts = storedHash.split('$');
      if (parts.length !== 3) return false;
      const [, salt, originalHashHex] = parts;
      const derivedKey = crypto.scryptSync(cleanPass, salt, 64);
      const originalKey = Buffer.from(originalHashHex, 'hex');
      if (derivedKey.length !== originalKey.length) return false;
      return crypto.timingSafeEqual(derivedKey, originalKey);
    }

    // Compatibilidade retroativa com hashes SHA-256 legados
    const legacySha256 = crypto.createHash('sha256').update(cleanPass).digest('hex');
    const a = Buffer.from(legacySha256, 'utf8');
    const b = Buffer.from(String(storedHash), 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// ============================================================================
// CÁLCULO GEOESPACIAL NATIVO (FÓRMULA DE HAVERSINE EM METROS)
// ============================================================================
function calculateDistanceMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const phi1 = lat1 * Math.PI / 180;
  const phi2 = lat2 * Math.PI / 180;
  const deltaPhi = (lat2 - lat1) * Math.PI / 180;
  const deltaLambda = (lon2 - lon1) * Math.PI / 180;

  const a = Math.sin(deltaPhi / 2) * Math.sin(deltaPhi / 2) +
            Math.cos(phi1) * Math.cos(phi2) *
            Math.sin(deltaLambda / 2) * Math.sin(deltaLambda / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c);
}

// ============================================================================
// GAZETTEER COMPLETO DO GUARUJÁ/SP (TODOS OS BAIRROS + FOCO NO PEREQUÊ)
// ============================================================================
const PEREQUE_CENTER = { lat: -23.93680, lng: -46.18250 };
const GUARUJA_CENTER = { lat: -23.93680, lng: -46.18250 };

const GUARUJA_PLACES = [
  // BAIRRO DO PEREQUÊ E MICROÁREAS DO PEREQUÊ
  { name: 'Bairro do Perequê (Centro / Estrada Guarujá-Bertioga)', neighborhood: 'Perequê', city: 'Guarujá', lat: -23.93680, lng: -46.18250 },
  { name: 'Praia do Perequê (Orla / Vila de Pescadores)', neighborhood: 'Perequê', city: 'Guarujá', lat: -23.93780, lng: -46.18050 },
  { name: 'USAFA Perequê (Rua Rio Amazonas / Estr. Guarujá-Bertioga)', neighborhood: 'Perequê', city: 'Guarujá', lat: -23.93590, lng: -46.18410 },
  { name: 'Rio do Peixe / Caminho da Cachoeira do Perequê', neighborhood: 'Perequê', city: 'Guarujá', lat: -23.93250, lng: -46.18850 },
  { name: 'Vila Nova Perequê / Rio Amazonas', neighborhood: 'Perequê', city: 'Guarujá', lat: -23.93480, lng: -46.18620 },

  // BAIRROS PRÓXIMOS AO PEREQUÊ (REGIÃO LESTE E NORTE DO GUARUJÁ)
  { name: 'Praia de Pernambuco (Av. Marjory da Silva Prado)', neighborhood: 'Balneário Praia do Pernambuco', city: 'Guarujá', lat: -23.96820, lng: -46.19120 },
  { name: 'Mar Casado (Praia do Mar Casado / Ilha do Mar Casado)', neighborhood: 'Mar Casado / Pernambuco', city: 'Guarujá', lat: -23.97180, lng: -46.18720 },
  { name: 'Jardim Acapulco (Estrada do Pernambuco)', neighborhood: 'Jardim Acapulco', city: 'Guarujá', lat: -23.96240, lng: -46.20150 },
  { name: 'Sítio São Pedro / Península de Pernambuco', neighborhood: 'Praia de Pernambuco', city: 'Guarujá', lat: -23.96500, lng: -46.18200 },
  { name: 'Serra do Guararu / Praia de São Pedro / Iporanga', neighborhood: 'Serra do Guararu', city: 'Guarujá', lat: -23.89650, lng: -46.15800 },
  { name: 'Prainha Branca (Trilha / Comunidade Caiçara)', neighborhood: 'Prainha Branca', city: 'Guarujá', lat: -23.86850, lng: -46.13550 },
  { name: 'Cidade Atlântica / Tortugas (Enseada Leste)', neighborhood: 'Cidade Atlântica', city: 'Guarujá', lat: -23.98380, lng: -46.21250 },
  { name: 'Jardim Virginia / Pedreira (Caminho do Perequê)', neighborhood: 'Jardim Virgínia', city: 'Guarujá', lat: -23.97850, lng: -46.22100 },

  // REGIÃO MORRINHOS & ENSEADA
  { name: 'Morrinhos I e II (Av. Antenor Pimentel)', neighborhood: 'Morrinhos', city: 'Guarujá', lat: -23.96850, lng: -46.25100 },
  { name: 'Morrinhos III e IV', neighborhood: 'Morrinhos', city: 'Guarujá', lat: -23.96420, lng: -46.24750 },
  { name: 'Enseada - Praça Abílio dos Santos Branco (Av. Miguel Estéfno, 2689)', neighborhood: 'Enseada', city: 'Guarujá', lat: -23.98650, lng: -46.22910 },
  { name: 'Enseada (Praça Horácio Lafer / Av. Miguel Estéfno)', neighborhood: 'Enseada', city: 'Guarujá', lat: -23.99110, lng: -46.24670 },
  { name: 'Vila Júlia / Jardim Helena Maria (Av. Dom Pedro I)', neighborhood: 'Vila Júlia', city: 'Guarujá', lat: -23.98010, lng: -46.22480 },
  { name: 'Vila Baiana (Rua Vereador Orlando Falcão, 172)', neighborhood: 'Vila Baiana', city: 'Guarujá', lat: -23.98220, lng: -46.23640 },
  { name: 'Jardim Três Marias / Jardim Praiano', neighborhood: 'Jardim Três Marias', city: 'Guarujá', lat: -23.98520, lng: -46.24120 },

  // REGIÃO CENTRAL E SUL (PITANGUEIRAS, CENTRO, VILA MAIA, ASTÚRIAS, TOMBO, GUAIÚBA)
  { name: 'Pitangueiras (Centro / Av. Puglisi)', neighborhood: 'Pitangueiras', city: 'Guarujá', lat: -23.99103, lng: -46.25892 },
  { name: 'Praia das Pitangueiras (Praça das Bandeiras / Orla)', neighborhood: 'Pitangueiras', city: 'Guarujá', lat: -23.99460, lng: -46.25890 },
  { name: 'Centro do Guarujá (Av. Leomil)', neighborhood: 'Centro', city: 'Guarujá', lat: -23.99946, lng: -46.26439 },
  { name: 'Vila Maia (Hospital Santo Amaro / Rua Quinto Bertoldi)', neighborhood: 'Vila Maia', city: 'Guarujá', lat: -23.99060, lng: -46.25325 },
  { name: 'Santo Antônio (Av. Santos Dumont, 995 / PAM Rodoviária)', neighborhood: 'Santo Antônio', city: 'Guarujá', lat: -23.98327, lng: -46.26759 },
  { name: 'Astúrias (Praia das Astúrias / Av. Gal. Monteiro de Barros)', neighborhood: 'Astúrias', city: 'Guarujá', lat: -24.00180, lng: -46.26470 },
  { name: 'Tombo / Jardim Las Palmas (Praia do Tombo / Av. Prestes Maia)', neighborhood: 'Jardim Las Palmas', city: 'Guarujá', lat: -24.01420, lng: -46.27250 },
  { name: 'Jardim dos Pássaros / Canta Galo', neighborhood: 'Jardim dos Pássaros', city: 'Guarujá', lat: -24.00950, lng: -46.27120 },
  { name: 'Guaiúba (Jardim Guaiúba / Praia do Guaiúba)', neighborhood: 'Guaiúba', city: 'Guarujá', lat: -24.01850, lng: -46.29120 },

  // REGIÃO OESTE E DISTRITO DE VICENTE DE CARVALHO
  { name: 'Vila Santa Rosa (Av. Manoel da Cruz Michael, 387)', neighborhood: 'Vila Santa Rosa', city: 'Guarujá', lat: -23.99427, lng: -46.28623 },
  { name: 'Ferry Boat Guarujá (Travessia Santos-Guarujá)', neighborhood: 'Santa Rosa', city: 'Guarujá', lat: -23.99120, lng: -46.29180 },
  { name: 'Santa Cruz dos Navegantes (Pouca Farinha)', neighborhood: 'Santa Cruz dos Navegantes', city: 'Guarujá', lat: -23.98750, lng: -46.30850 },
  { name: 'Jardim Boa Esperança (Av. Adriano Dias dos Santos)', neighborhood: 'Jardim Boa Esperança', city: 'Guarujá', lat: -23.95650, lng: -46.28300 },
  { name: 'Jardim Conceiçãozinha (Margem Portuária)', neighborhood: 'Jardim Conceiçãozinha', city: 'Guarujá', lat: -23.96280, lng: -46.29150 },
  { name: 'Vila Alice / Pae Cará (Vicente de Carvalho)', neighborhood: 'Pae Cará', city: 'Guarujá', lat: -23.94880, lng: -46.29220 },
  { name: 'Vicente de Carvalho (Av. Thiago Ferreira / Centro Comercial)', neighborhood: 'Vicente de Carvalho', city: 'Guarujá', lat: -23.94100, lng: -46.28950 },
  { name: 'Vila Áurea / Monteiro da Cruz (Vicente de Carvalho)', neighborhood: 'Vila Áurea', city: 'Guarujá', lat: -23.93620, lng: -46.28150 }
];

function findNearestLocalPlace(lat, lng) {
  let nearest = GUARUJA_PLACES[0];
  let minDist = Infinity;
  for (const place of GUARUJA_PLACES) {
    const d = calculateDistanceMeters(lat, lng, place.lat, place.lng);
    if (d < minDist) {
      minDist = d;
      nearest = place;
    }
  }
  return { place: nearest, distance: minDist };
}

// ============================================================================
// SEED COMPLETO DO MUNICÍPIO DO GUARUJÁ/SP (INCLUINDO PEREQUÊ E TODOS OS BAIRROS)
// ============================================================================
// Em produção NÃO se cria o usuário demo (senha fixa conhecida) nem os alertas de demonstração.
// Para incluí-los (apresentação do TCC): SEED_DEMO_DATA=1
const SEED_DEMO_DATA = process.env.NODE_ENV !== 'production' || process.env.SEED_DEMO_DATA === '1';

function getInitialSeedData() {
  const seed = buildSeedData();
  if (!SEED_DEMO_DATA) {
    seed.users = [];
    seed.reports = [];
  }
  return seed;
}

function buildSeedData() {
  return {
    users: [
      {
        id: 'usr-1',
        name: 'Maria Cidadã Silva (Demonstração)',
        email: 'cidadao@onehealth.org',
        passwordHash: hashPassword('123456'),
        provider: 'local',
        googleId: null,
        picture: null,
        createdAt: '2026-03-01T10:00:00.000Z'
      }
    ],
    categories: [
      { id: 'cat-1', slug: 'ubs', name: 'UBS / USAFA - Posto de Saúde', domain: 'health', color: '#10B981', icon: 'clinic' },
      { id: 'cat-2', slug: 'upa', name: 'Hospital / UPA 24h', domain: 'health', color: '#EF4444', icon: 'hospital' },
      { id: 'cat-3', slug: 'farmacia', name: 'Farmácia Popular', domain: 'health', color: '#8B5CF6', icon: 'pill' },
      { id: 'cat-4', slug: 'ecoponto', name: 'Ecoponto - Descarte Consciente', domain: 'environment', color: '#2563EB', icon: 'recycle' },
      { id: 'cat-5', slug: 'parque', name: 'Parque & Área Verde (Mata Atlântica)', domain: 'environment', color: '#059669', icon: 'tree' }
    ],
    locations: [
      // ======================================================================
      // REGIÃO DO PEREQUÊ E BAIRROS PRÓXIMOS (PERNAMBUCO, MAR CASADO, ACAPULCO, GUARARU)
      // ======================================================================
      {
        id: 'loc-pereque-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'USAFA Perequê (Unidade de Saúde da Família do Perequê)',
        address: 'Rua Rio Amazonas, s/n (Estr. Guarujá-Bertioga, km 7) - Perequê, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.93590,
        lng: -46.18410,
        services: ['Médico de Saúde da Família', 'Vacinação SUS Completa', 'Farmácia Básica Municipal', 'Pré-Natal e Puericultura', 'Odontologia e Curativos'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.4,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.8,
        overall_score: 4.6,
        total_reviews: 45,
        reviews: [
          { id: 'rev-per-1', userName: 'Morador do Perequê', wait: 4, access: 5, care: 5, comment: 'Unidade fundamental para a nossa comunidade do Perequê! Equipe de agentes comunitários excelente.', date: '2026-03-15' },
          { id: 'rev-per-2', userName: 'Ana Paula Santos', wait: 5, access: 5, care: 5, comment: 'Vacinação rápida e atendimento muito humano com as crianças do bairro.', date: '2026-03-16' }
        ]
      },
      {
        id: 'loc-pereque-2',
        categoryId: 'cat-2',
        categoryName: 'Hospital / UPA 24h',
        domain: 'health',
        color: '#EF4444',
        iconType: 'hospital',
        name: 'Base de Pronto Atendimento & SAMU Perequê',
        address: 'Estrada Guarujá-Bertioga (SP-061), 650 - Perequê, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.93720,
        lng: -46.18280,
        services: ['Pronto Atendimento de Urgência', 'Base Descentralizada SAMU 192', 'Primeiros Socorros e Estabilização', 'Vigilância em Saúde Costeira'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 4.3,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.7,
        overall_score: 4.6,
        total_reviews: 31,
        reviews: [
          { id: 'rev-per-3', userName: 'João Pescador', wait: 4, access: 5, care: 5, comment: 'Atendimento rápido na entrada do Perequê, essencial para emergências na rodovia e na praia.', date: '2026-03-14' }
        ]
      },
      {
        id: 'loc-pereque-3',
        categoryId: 'cat-3',
        categoryName: 'Farmácia Popular',
        domain: 'health',
        color: '#8B5CF6',
        iconType: 'pill',
        name: 'Farmácia Popular & Drogaria do Perequê',
        address: 'Estrada Guarujá-Bertioga, 410 - Centro do Perequê, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.93650,
        lng: -46.18190,
        services: ['Medicamentos de Uso Contínuo (Hipertensão e Diabetes)', 'Coleta de Medicamentos Vencidos', 'Aferição de Pressão Arterial e Glicemia'],
        opening_hours: {
          '0': { open: '08:00', close: '21:00' },
          '1': { open: '07:30', close: '22:00' },
          '2': { open: '07:30', close: '22:00' },
          '3': { open: '07:30', close: '22:00' },
          '4': { open: '07:30', close: '22:00' },
          '5': { open: '07:30', close: '22:00' },
          '6': { open: '08:00', close: '22:00' }
        },
        avg_wait_time: 4.8,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.9,
        overall_score: 4.8,
        total_reviews: 27,
        reviews: [
          { id: 'rev-per-4', userName: 'Dona Aparecida', wait: 5, access: 5, care: 5, comment: 'Farmacêutico sempre atencioso com os moradores do Perequê.', date: '2026-03-13' }
        ]
      },
      {
        id: 'loc-pereque-4',
        categoryId: 'cat-4',
        categoryName: 'Ecoponto - Descarte Consciente',
        domain: 'environment',
        color: '#2563EB',
        iconType: 'recycle',
        name: 'Ecoponto & PEV Comunitário Perequê (SEMAM)',
        address: 'Av. Rio Amazonas, 185 - Perequê, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.93850,
        lng: -46.18520,
        services: ['Coleta de Óleo de Cozinha e Fritura', 'Reciclagem de Plásticos, Redes e Garrafas PET', 'Pilhas, Baterias e Eletrônicos', 'Preservação dos Rios e Manguezais do Perequê'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' },
          '6': { open: '08:00', close: '13:00' }
        },
        avg_wait_time: 4.9,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.8,
        overall_score: 4.8,
        total_reviews: 24,
        reviews: [
          { id: 'rev-per-5', userName: 'Instituto Mar Limpo Perequê', wait: 5, access: 5, care: 5, comment: 'Ajuda demais a manter a Praia do Perequê e o Rio do Peixe livres de plástico e óleo.', date: '2026-03-14' }
        ]
      },
      {
        id: 'loc-pereque-5',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Orla & Reserva Caiçara da Praia do Perequê',
        address: 'Estrada Guarujá-Bertioga (Orla da Praia do Perequê) - Perequê, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.93780,
        lng: -46.18050,
        services: ['Ecossistema Costeiro & Mata Atlântica Nativa', 'Comunidade Tradicional de Pesca Artesanal', 'Caminhada ao Ar Livre', 'Educação Ambiental Marinha'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 53,
        reviews: [
          { id: 'rev-per-6', userName: 'Kauê & Equipe CuidAção', wait: 5, access: 5, care: 5, comment: 'Patrimônio natural e cultural do Guarujá cercado pela Mata Atlântica.', date: '2026-03-16' }
        ]
      },
      {
        id: 'loc-pereque-6',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Cachoeira do Perequê & Mata Atlântica da Serra do Guararu',
        address: 'Estrada Guarujá-Bertioga, km 8 - Perequê, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.93250,
        lng: -46.18850,
        services: ['Preservação de Nascentes e Recursos Hídricos', 'Biodiversidade da Mata Atlântica', 'Ecoturismo Consciente e Saúde Mental'],
        opening_hours: {
          '0': { open: '07:00', close: '18:00' },
          '1': { open: '07:00', close: '18:00' },
          '2': { open: '07:00', close: '18:00' },
          '3': { open: '07:00', close: '18:00' },
          '4': { open: '07:00', close: '18:00' },
          '5': { open: '07:00', close: '18:00' },
          '6': { open: '07:00', close: '18:00' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.4,
        avg_humanized_care: 4.9,
        overall_score: 4.8,
        total_reviews: 39,
        reviews: []
      },

      // BAIRROS VIZINHOS AO PEREQUÊ: PERNAMBUCO, MAR CASADO, JARDIM ACAPULCO E CIDADE ATLÂNTICA
      {
        id: 'loc-pernambuco-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'Posto de Saúde & Atenção Básica Pernambuco / Mar Casado',
        address: 'Av. Marjory da Silva Prado, 1450 - Balneário Praia do Pernambuco, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.96820,
        lng: -46.19120,
        services: ['Atendimento Básico SUS', 'Vacinação e Curativos', 'Orientação de Prevenção à Dengue', 'Aferição de Sinais Vitais'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' }
        },
        avg_wait_time: 4.5,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.7,
        overall_score: 4.7,
        total_reviews: 22,
        reviews: []
      },
      {
        id: 'loc-pernambuco-2',
        categoryId: 'cat-3',
        categoryName: 'Farmácia Popular',
        domain: 'health',
        color: '#8B5CF6',
        iconType: 'pill',
        name: 'Drogaria & Farmácia Popular Praia de Pernambuco',
        address: 'Av. Marjory da Silva Prado, 1100 - Praia de Pernambuco, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.97050,
        lng: -46.19450,
        services: ['Programa Farmácia Popular', 'Descarte Consciente de Blisters e Remédios', 'Atendimento Farmacêutico'],
        opening_hours: {
          '0': { open: '08:00', close: '22:00' },
          '1': { open: '08:00', close: '22:00' },
          '2': { open: '08:00', close: '22:00' },
          '3': { open: '08:00', close: '22:00' },
          '4': { open: '08:00', close: '22:00' },
          '5': { open: '08:00', close: '22:00' },
          '6': { open: '08:00', close: '22:00' }
        },
        avg_wait_time: 4.8,
        avg_accessibility: 4.9,
        avg_humanized_care: 4.8,
        overall_score: 4.8,
        total_reviews: 19,
        reviews: []
      },
      {
        id: 'loc-acapulco-1',
        categoryId: 'cat-4',
        categoryName: 'Ecoponto - Descarte Consciente',
        domain: 'environment',
        color: '#2563EB',
        iconType: 'recycle',
        name: 'Ecoponto Pernambuco / Jardim Acapulco (Coleta Seletiva)',
        address: 'Estrada de Pernambuco, 820 - Jardim Acapulco / Pernambuco, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.96240,
        lng: -46.20150,
        services: ['Recicláveis Secos', 'Resíduos Verdes e Podas Controladas', 'Óleo Vegetal e Pilhas', 'Logística Reversa'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' },
          '6': { open: '08:00', close: '13:00' }
        },
        avg_wait_time: 4.9,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.8,
        overall_score: 4.8,
        total_reviews: 21,
        reviews: []
      },
      {
        id: 'loc-marcasado-1',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Parque Costeiro Mar Casado & Restinga de Pernambuco',
        address: 'Praia do Mar Casado, s/n - Balneário Praia do Pernambuco, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.97180,
        lng: -46.18720,
        services: ['Preservação de Restinga e Costão Rochoso', 'Caminhada Ecológica', 'Pontos de Coleta Seletiva na Orla'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 44,
        reviews: []
      },
      {
        id: 'loc-guararu-1',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'APA Serra do Guararu (Iporanga / São Pedro / Prainha Branca)',
        address: 'Rod. Ariovaldo de Almeida Viana (Estr. Guarujá-Bertioga), km 14 - Serra do Guararu, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.89650,
        lng: -46.15800,
        services: ['Área de Proteção Ambiental da Mata Atlântica', 'Monitoramento de Fauna e Flora Costeira', 'Reserva de Biosfera'],
        opening_hours: {
          '0': { open: '07:00', close: '18:00' },
          '1': { open: '07:00', close: '18:00' },
          '2': { open: '07:00', close: '18:00' },
          '3': { open: '07:00', close: '18:00' },
          '4': { open: '07:00', close: '18:00' },
          '5': { open: '07:00', close: '18:00' },
          '6': { open: '07:00', close: '18:00' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.6,
        avg_humanized_care: 4.9,
        overall_score: 4.8,
        total_reviews: 37,
        reviews: []
      },
      {
        id: 'loc-cidade-atlantica-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'USAFA Cidade Atlântica / Enseada Leste',
        address: 'Av. Dom Pedro I, 2950 - Cidade Atlântica / Enseada, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.98380,
        lng: -46.21250,
        services: ['Atenção Primária à Saúde', 'Vacinação', 'Acompanhamento de Hipertensos e Diabéticos'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.4,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.6,
        overall_score: 4.6,
        total_reviews: 18,
        reviews: []
      },

      // ======================================================================
      // REGIÃO MORRINHOS, VILA JÚLIA, ENSEADA E VILA BAIANA
      // ======================================================================
      {
        id: 'loc-vilajulia-1',
        categoryId: 'cat-2',
        categoryName: 'Hospital / UPA 24h',
        domain: 'health',
        color: '#EF4444',
        iconType: 'hospital',
        name: 'UPA 24h Enseada / Vila Júlia (Pronto Atendimento)',
        address: 'Av. Dom Pedro I, 2600 - Vila Júlia / Enseada, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.98010,
        lng: -46.22480,
        services: ['Urgência e Emergência 24h', 'Atendimento Clínico e Pediátrico', 'Hidratação para Casos de Dengue', 'Exames Laboratoriais de Urgência'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 4.0,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.5,
        overall_score: 4.4,
        total_reviews: 49,
        reviews: []
      },
      {
        id: 'loc-morrinhos-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'UBS Morrinhos (Complexo de Saúde Morrinhos I, II, III e IV)',
        address: 'Av. Antenor Pimentel, s/n - Morrinhos, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.96850,
        lng: -46.25100,
        services: ['Clínica Geral e Pediatria', 'Sala de Vacinação', 'Farmácia SUS', 'Saúde da Mulher e Pré-Natal', 'Odontologia'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.3,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.7,
        overall_score: 4.6,
        total_reviews: 41,
        reviews: []
      },
      {
        id: 'loc-morrinhos-2',
        categoryId: 'cat-4',
        categoryName: 'Ecoponto - Descarte Consciente',
        domain: 'environment',
        color: '#2563EB',
        iconType: 'recycle',
        name: 'Ecoponto Municipal Morrinhos (SEMAM Guarujá)',
        address: 'Rua Manoel Soares, 90 - Morrinhos II, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.96620,
        lng: -46.24880,
        services: ['Descarte Legal de Pequenos Volumes de Entulho', 'Recicláveis (Papel, Plástico, Vidro e Metal)', 'Pneus e Eletrônicos'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' },
          '6': { open: '08:00', close: '12:00' }
        },
        avg_wait_time: 4.8,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.8,
        overall_score: 4.8,
        total_reviews: 25,
        reviews: []
      },

      // ======================================================================
      // UNIDADES CENTRAIS E TRADICIONAIS DO GUARUJÁ (VILA MAIA, PITANGUEIRAS, CENTRO, ENSEADA, VILA BAIANA, SANTO ANTÔNIO, SANTA ROSA)
      // ======================================================================
      {
        id: 'loc-guaruja-1',
        categoryId: 'cat-2',
        categoryName: 'Hospital / UPA 24h',
        domain: 'health',
        color: '#EF4444',
        iconType: 'hospital',
        name: 'Hospital Santo Amaro (Emergência SUS 24h)',
        address: 'Rua Quinto Bertoldi, 40 - Vila Maia, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.99060,
        lng: -46.25325,
        services: ['Pronto-Socorro Adulto e Infantil 24h', 'UTI Adulto e Neonatal', 'Cirurgia de Emergência', 'Maternidade SUS', 'Ortopedia e Trauma'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 3.9,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.6,
        overall_score: 4.4,
        total_reviews: 64,
        reviews: [
          { id: 'rev-1', userName: 'Carlos Alberto Santos', wait: 4, access: 5, care: 5, comment: 'Atendimento de emergência muito prestativo e rampas de acesso bem conservadas.', date: '2026-03-12' },
          { id: 'rev-2', userName: 'Luciana Ferreira', wait: 4, access: 5, care: 4, comment: 'Equipe de triagem ágil na classificação de risco.', date: '2026-03-14' }
        ]
      },
      {
        id: 'loc-guaruja-2',
        categoryId: 'cat-2',
        categoryName: 'Hospital / UPA 24h',
        domain: 'health',
        color: '#EF4444',
        iconType: 'hospital',
        name: 'UPA Dr. Matheus Santamaria (PAM Rodoviária 24h)',
        address: 'Av. Santos Dumont, 995 - Santo Antônio, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.98327,
        lng: -46.26759,
        services: ['Pronto Atendimento Clínico 24h', 'Pediatria de Emergência', 'Exames de Raio-X e Eletrocardiograma', 'Sala de Estabilização'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 3.8,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.5,
        overall_score: 4.3,
        total_reviews: 52,
        reviews: [
          { id: 'rev-3', userName: 'Fernando Dias', wait: 4, access: 5, care: 4, comment: 'Localização de fácil acesso pela Av. Santos Dumont, bom atendimento geral.', date: '2026-03-15' }
        ]
      },
      {
        id: 'loc-guaruja-3',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'USAFA Santa Rosa (Estratégia Saúde da Família)',
        address: 'Av. Manoel da Cruz Michael, 387 - Vila Santa Rosa, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.99427,
        lng: -46.28623,
        services: ['Vacinação COVID/Gripe/Tríplice', 'Farmácia Básica SUS', 'Clínica da Família', 'Pré-Natal e Puericultura', 'Odontologia Preventiva'],
        opening_hours: {
          '1': { open: '07:00', close: '18:00' },
          '2': { open: '07:00', close: '18:00' },
          '3': { open: '07:00', close: '18:00' },
          '4': { open: '07:00', close: '18:00' },
          '5': { open: '07:00', close: '18:00' },
          '6': { open: '08:00', close: '12:00' }
        },
        avg_wait_time: 4.5,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.8,
        overall_score: 4.7,
        total_reviews: 38,
        reviews: [
          { id: 'rev-4', userName: 'Juliana Camargo', wait: 5, access: 5, care: 5, comment: 'Sala de vacina excelente e atendimento de odontologia muito cuidadoso.', date: '2026-03-10' }
        ]
      },
      {
        id: 'loc-guaruja-4',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'UBS Vila Baiana (Atenção Básica & Imunização)',
        address: 'Rua Vereador Orlando Falcão, 172 - Vila Baiana, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.98220,
        lng: -46.23640,
        services: ['Consultas Médicas Básicas', 'Sala de Curativos', 'Imunização SUS', 'Acolhimento de Enfermagem'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.2,
        avg_accessibility: 4.5,
        avg_humanized_care: 4.7,
        overall_score: 4.5,
        total_reviews: 29,
        reviews: [
          { id: 'rev-5', userName: 'Roberto Lemos', wait: 4, access: 5, care: 5, comment: 'Equipe de enfermagem muito dedicada com os idosos do bairro.', date: '2026-03-09' }
        ]
      },
      {
        id: 'loc-guaruja-5',
        categoryId: 'cat-3',
        categoryName: 'Farmácia Popular',
        domain: 'health',
        color: '#8B5CF6',
        iconType: 'pill',
        name: 'Drogaria São Paulo (Farmácia Popular & Coleta Segura)',
        address: 'Av. Puglisi, 240 - Centro / Pitangueiras, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.99103,
        lng: -46.25892,
        services: ['Medicamentos Gratuitos Programa Farmácia Popular', 'Descarte Ecológico de Medicamentos Vencidos', 'Aferição de Pressão e Glicemia'],
        opening_hours: {
          '0': { open: '07:00', close: '22:00' },
          '1': { open: '07:00', close: '23:00' },
          '2': { open: '07:00', close: '23:00' },
          '3': { open: '07:00', close: '23:00' },
          '4': { open: '07:00', close: '23:00' },
          '5': { open: '07:00', close: '23:00' },
          '6': { open: '07:00', close: '23:00' }
        },
        avg_wait_time: 4.9,
        avg_accessibility: 4.9,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 41,
        reviews: [
          { id: 'rev-6', userName: 'Beatriz Fonseca', wait: 5, access: 5, care: 5, comment: 'Excelente iniciativa! Urna para descarte de remédios vencidos logo na entrada.', date: '2026-03-11' }
        ]
      },
      {
        id: 'loc-guaruja-6',
        categoryId: 'cat-4',
        categoryName: 'Ecoponto - Descarte Consciente',
        domain: 'environment',
        color: '#2563EB',
        iconType: 'recycle',
        name: 'Ecoponto Municipal Centro (SEMAM Guarujá)',
        address: 'Av. Leomil, 1305 (Praça Mário da Silva) - Centro, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.99946,
        lng: -46.26439,
        services: ['Lixo Eletrônico (E-Waste)', 'Pilhas e Baterias', 'Óleo de Cozinha Usado', 'Materiais Recicláveis (Plástico/Metal/Papel/Vidro)', 'Logística Reversa'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' },
          '6': { open: '08:00', close: '13:00' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 47,
        reviews: [
          { id: 'rev-7', userName: 'Lucas Tavares', wait: 5, access: 5, care: 5, comment: 'Organizado e limpo. Descartei bateria de notebook e caixas de papelão facilmente.', date: '2026-03-10' }
        ]
      },
      {
        id: 'loc-guaruja-7',
        categoryId: 'cat-4',
        categoryName: 'Ecoponto - Descarte Consciente',
        domain: 'environment',
        color: '#2563EB',
        iconType: 'recycle',
        name: 'Estação de Sustentabilidade Enseada (PEV Municipal)',
        address: 'Av. Miguel Estéfno, 2689 (Praça Abílio dos Santos Branco) - Enseada, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.98650,
        lng: -46.22910,
        services: ['Urna para Pilhas e Celulares Antigos', 'Ponto Coletor de Óleo Vegetal', 'Entulho Pequeno e Papelão', 'Campanhas de Conscientização Ambiental'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' },
          '6': { open: '08:00', close: '12:00' }
        },
        avg_wait_time: 4.8,
        avg_accessibility: 4.6,
        avg_humanized_care: 4.8,
        overall_score: 4.7,
        total_reviews: 33,
        reviews: [
          { id: 'rev-8', userName: 'Patrícia Prado', wait: 5, access: 4, care: 5, comment: 'Excelente para os moradores da Enseada não descartarem óleo na pia ou esgoto.', date: '2026-03-08' }
        ]
      },
      {
        id: 'loc-guaruja-8',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Praça das Bandeiras (Área Verde & Lazer Ativo Pitangueiras)',
        address: 'Av. Mal. Deodoro da Fonseca, s/n - Pitangueiras, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.99460,
        lng: -46.25890,
        services: ['Calçadão Arborizado para Caminhada e Corrida', 'Lixeiras Seletivas e Bituqueiras Ecológicas', 'Ponto de Hidratação', 'Espaço de Convivência ao Ar Livre'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.9,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 89,
        reviews: [
          { id: 'rev-9', userName: 'Marcos Vinícius', wait: 5, access: 5, care: 5, comment: 'Orla ótima para atividade física e caminhada matinal, com fácil acesso.', date: '2026-03-14' }
        ]
      },
      {
        id: 'loc-guaruja-9',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Praça Horácio Lafer (Parque Urbano & Lazer Sustentável)',
        address: 'Av. Miguel Estéfano, s/n - Enseada, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.99110,
        lng: -46.24670,
        services: ['Pista de Cooper e Caminhada', 'Academia ao Ar Livre para Idosos', 'Área de Preservação e Jardins', 'Ciclovia Integrada'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 62,
        reviews: [
          { id: 'rev-10', userName: 'Renata Lemos', wait: 5, access: 5, care: 5, comment: 'Espaço verde amplo, ótimo para respirar ar puro e se exercitar na praia.', date: '2026-03-13' }
        ]
      },

      // ======================================================================
      // REGIÃO SUL (ASTÚRIAS, TOMBO, JARDIM LAS PALMAS E GUAIÚBA)
      // ======================================================================
      {
        id: 'loc-tombo-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'USAFA Jardim dos Pássaros / Las Palmas (Tombo)',
        address: 'Rua Rouxinol, 55 - Jardim dos Pássaros / Tombo, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -24.00950,
        lng: -46.27120,
        services: ['Estratégia Saúde da Família', 'Vacinação', 'Atendimento Médico e Odontológico'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.5,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.8,
        overall_score: 4.7,
        total_reviews: 28,
        reviews: []
      },
      {
        id: 'loc-asturias-1',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Mirante das Galhetas & Costão da Mata Atlântica (Astúrias/Tombo)',
        address: 'Rua Paulo Agostinho da Silva - Astúrias / Caixa D\'Água, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -24.01220,
        lng: -46.26540,
        services: ['Área de Preservação Costeira', 'Certificação Bandeira Azul (Praia do Tombo)', 'Educação Ambiental'],
        opening_hours: {
          '0': { open: '08:00', close: '20:00' },
          '1': { open: '08:00', close: '20:00' },
          '2': { open: '08:00', close: '20:00' },
          '3': { open: '08:00', close: '20:00' },
          '4': { open: '08:00', close: '20:00' },
          '5': { open: '08:00', close: '20:00' },
          '6': { open: '08:00', close: '20:00' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.9,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 57,
        reviews: []
      },
      {
        id: 'loc-guaiuba-1',
        categoryId: 'cat-5',
        categoryName: 'Parque & Área Verde (Mata Atlântica)',
        domain: 'environment',
        color: '#059669',
        iconType: 'tree',
        name: 'Parque Ecológico & Orla do Guaiúba',
        address: 'Av. Humberto Prieto Peres - Jardim Guaiúba, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -24.01850,
        lng: -46.29120,
        services: ['Reserva de Mata Atlântica Costeira', 'Lixeiras Seletivas de Praia', 'Caminhada e Bem-Estar'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 5.0,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.9,
        overall_score: 4.9,
        total_reviews: 34,
        reviews: []
      },

      // ======================================================================
      // DISTRITO DE VICENTE DE CARVALHO, PAE CARÁ, BOA ESPERANÇA E SANTA CRUZ DOS NAVEGANTES
      // ======================================================================
      {
        id: 'loc-vicente-1',
        categoryId: 'cat-2',
        categoryName: 'Hospital / UPA 24h',
        domain: 'health',
        color: '#EF4444',
        iconType: 'hospital',
        name: 'UPA 24h Vicente de Carvalho (Pronto Atendimento Pae Cará)',
        address: 'Av. São João, 111 - Pae Cará, Vicente de Carvalho, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.94880,
        lng: -46.29220,
        services: ['Pronto Socorro 24h', 'Emergência Adulto e Pediátrica', 'Raio-X e Laboratório 24h', 'Observação Clínica'],
        opening_hours: {
          '0': { open: '00:00', close: '23:59' },
          '1': { open: '00:00', close: '23:59' },
          '2': { open: '00:00', close: '23:59' },
          '3': { open: '00:00', close: '23:59' },
          '4': { open: '00:00', close: '23:59' },
          '5': { open: '00:00', close: '23:59' },
          '6': { open: '00:00', close: '23:59' }
        },
        avg_wait_time: 3.9,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.5,
        overall_score: 4.4,
        total_reviews: 58,
        reviews: []
      },
      {
        id: 'loc-vicente-2',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'UBS Vicente de Carvalho & Centro de Especialidades',
        address: 'Av. Thiago Ferreira, 650 - Vicente de Carvalho, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.94100,
        lng: -46.28950,
        services: ['Consultas Especializadas SUS', 'Vacinação', 'Farmácia Municipal de Alto Custo e Básica'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.3,
        avg_accessibility: 4.8,
        avg_humanized_care: 4.6,
        overall_score: 4.6,
        total_reviews: 36,
        reviews: []
      },
      {
        id: 'loc-boaesperanca-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'USAFA Jardim Boa Esperança / Conceiçãozinha',
        address: 'Av. Adriano Dias dos Santos, 520 - Jardim Boa Esperança, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.95650,
        lng: -46.28300,
        services: ['Saúde da Família', 'Imunização', 'Odontologia', 'Vigilância Epidemiológica'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.4,
        avg_accessibility: 4.6,
        avg_humanized_care: 4.7,
        overall_score: 4.6,
        total_reviews: 30,
        reviews: []
      },
      {
        id: 'loc-vicente-3',
        categoryId: 'cat-4',
        categoryName: 'Ecoponto - Descarte Consciente',
        domain: 'environment',
        color: '#2563EB',
        iconType: 'recycle',
        name: 'Ecoponto Municipal Vicente de Carvalho (SEMAM)',
        address: 'Rua Paraíba, 140 - Pae Cará / Vicente de Carvalho, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.95210,
        lng: -46.28650,
        services: ['Coleta Seletiva Solidária', 'Descarte de Eletroeletrônicos e Pilhas', 'Óleo de Cozinha Usado'],
        opening_hours: {
          '1': { open: '08:00', close: '17:00' },
          '2': { open: '08:00', close: '17:00' },
          '3': { open: '08:00', close: '17:00' },
          '4': { open: '08:00', close: '17:00' },
          '5': { open: '08:00', close: '17:00' },
          '6': { open: '08:00', close: '12:00' }
        },
        avg_wait_time: 4.9,
        avg_accessibility: 4.7,
        avg_humanized_care: 4.8,
        overall_score: 4.8,
        total_reviews: 23,
        reviews: []
      },
      {
        id: 'loc-santacruz-1',
        categoryId: 'cat-1',
        categoryName: 'UBS / USAFA - Posto de Saúde',
        domain: 'health',
        color: '#10B981',
        iconType: 'clinic',
        name: 'USAFA Santa Cruz dos Navegantes (Pouca Farinha)',
        address: 'Rua Messias Borges, 120 - Santa Cruz dos Navegantes, Guarujá - SP',
        city: 'Guarujá',
        state: 'SP',
        lat: -23.98750,
        lng: -46.30850,
        services: ['Saúde da Família', 'Vacinação', 'Pré-Natal', 'Atenção à Comunidade Caiçara e Portuária'],
        opening_hours: {
          '1': { open: '07:00', close: '17:00' },
          '2': { open: '07:00', close: '17:00' },
          '3': { open: '07:00', close: '17:00' },
          '4': { open: '07:00', close: '17:00' },
          '5': { open: '07:00', close: '17:00' }
        },
        avg_wait_time: 4.6,
        avg_accessibility: 4.6,
        avg_humanized_care: 4.9,
        overall_score: 4.7,
        total_reviews: 21,
        reviews: []
      }
    ],
    reports: [
      {
        id: 'rep-pereque-1',
        title: 'Monitoramento Preventivo de Dengue e Limpeza de Vala',
        report_type: 'foco_dengue',
        description: 'Ponto de atenção para escoamento de água de chuva próximo à margem da Estrada Guarujá-Bertioga no Perequê.',
        address: 'Estrada Guarujá-Bertioga, próx. ao km 7 - Perequê, Guarujá - SP',
        lat: -23.93710,
        lng: -46.18360,
        status: 'pending',
        date: '2026-03-16',
        reporterName: 'Vigilância Comunitária Perequê'
      },
      {
        id: 'rep-guaruja-1',
        title: 'Foco Potencial de Dengue (Caixas D\'Água Destampadas)',
        report_type: 'foco_dengue',
        description: 'Imóvel desocupado com acúmulo de água pluvial e recipientes abertos, alto risco de proliferação do Aedes aegypti.',
        address: 'Rua Quintino Bocaiúva, 180 - Centro / Pitangueiras, Guarujá - SP',
        lat: -23.99350,
        lng: -46.25880,
        status: 'pending',
        date: '2026-03-15',
        reporterName: 'Vigilância Comunitária Pitangueiras'
      },
      {
        id: 'rep-guaruja-2',
        title: 'Descarte Irregular de Entulho e Pneus Velhos',
        report_type: 'descarte_irregular',
        description: 'Descarte clandestino de resíduos da construção civil e pneus na beira da via, acumulando água parada.',
        address: 'Av. Santos Dumont, próx. ao nº 1100 - Santo Antônio, Guarujá - SP',
        lat: -23.98400,
        lng: -46.26800,
        status: 'pending',
        date: '2026-03-16',
        reporterName: 'Coletivo Ambiental Guarujá'
      }
    ]
  };
}

// ============================================================================
// PERSISTÊNCIA AUTOMÁTICA EM ARQUIVO JSON (FS NATIVO) COM MERGE DE NOVOS BAIRROS
// ============================================================================
function loadDatabase() {
  const seed = getInitialSeedData();

  try {
    if (fs.existsSync(DATA_FILE_PATH)) {
      const raw = fs.readFileSync(DATA_FILE_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && Array.isArray(parsed.users) && Array.isArray(parsed.locations) && Array.isArray(parsed.reports)) {
        // Garante que todos os novos pontos do Perequê e do Guarujá inteiro sejam mesclados caso data.json seja de versão anterior
        let updated = false;
        for (const seedLoc of seed.locations) {
          if (!parsed.locations.some(l => l.id === seedLoc.id)) {
            parsed.locations.push(seedLoc);
            updated = true;
          }
        }
        for (const seedRep of seed.reports) {
          if (!parsed.reports.some(r => r.id === seedRep.id)) {
            parsed.reports.unshift(seedRep);
            updated = true;
          }
        }
        if (updated) {
          try {
            fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(parsed, null, 2), 'utf8');
          } catch {
            // Ignora erro de escrita
          }
        }
        return parsed;
      }
    }
  } catch (err) {
    console.warn('⚠️ Aviso ao carregar data.json, inicializando com seed padrão:', err.message);
  }

  try {
    fs.writeFileSync(DATA_FILE_PATH, JSON.stringify(seed, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ Não foi possível gravar data.json inicial:', err.message);
  }
  return seed;
}

// ============================================================================
// MÉTRICAS DE AVALIAÇÃO: SEMPRE DERIVADAS DAS AVALIAÇÕES REAIS (reviews[])
// Evita notas/contagens "fantasmas" (ex.: "64 avaliações" com só 2 registradas).
// Para manter os números fictícios do seed em apresentações: KEEP_DEMO_RATINGS=1
// ============================================================================
function recomputeLocationMetrics(loc) {
  const reviews = Array.isArray(loc.reviews) ? loc.reviews : [];
  const n = reviews.length;
  const avg = (key) => n ? Math.round((reviews.reduce((a, r) => a + (Number(r[key]) || 0), 0) / n) * 10) / 10 : 0;
  loc.total_reviews = n;
  loc.avg_wait_time = avg('wait');
  loc.avg_accessibility = avg('access');
  loc.avg_humanized_care = avg('care');
  loc.overall_score = n ? Math.round(((loc.avg_wait_time + loc.avg_accessibility + loc.avg_humanized_care) / 3) * 10) / 10 : 0;
  return loc;
}

const db = loadDatabase();
if (process.env.KEEP_DEMO_RATINGS !== '1') {
  db.locations.forEach(l => { if (!Array.isArray(l.reviews)) l.reviews = []; recomputeLocationMetrics(l); });
}

// ============================================================================
// GRAVAÇÃO ATÔMICA E AGRUPADA (debounce) — evita corromper data.json em queda
// de energia e evita regravar o arquivo inteiro a cada requisição
// ============================================================================
let saveTimer = null;
function writeDatabaseNow() {
  const tmp = DATA_FILE_PATH + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, DATA_FILE_PATH);
    return true;
  } catch (err) {
    console.error('❌ Erro ao persistir data.json:', err.message);
    return false;
  }
}

function saveDatabase() {
  if (saveTimer) return true;
  saveTimer = setTimeout(() => { saveTimer = null; writeDatabaseNow(); }, 250);
  return true;
}

function flushDatabase() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  return writeDatabaseNow();
}

module.exports = {
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
};
