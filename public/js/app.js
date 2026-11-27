/**
 * =====================================================================================
 * PROJETO TCC: CuidAção - SAÚDE ÚNICA (ONE HEALTH) • GUARUJÁ/SP
 * Lógica de Interface, Geolocalização Calibrada (Bairro do Perequê & Guarujá Inteiro),
 * Busca por CEP (ViaCEP), Toasts Modernos, Service Worker PWA e Login Google
 * Equipe Back-End & Banco de Dados: Kauê, Igor e Pedro
 * Equipe Front-End & Design: Jamily e Yasmin
 * =====================================================================================
 */

// URL da API: definida em js/config.js (necessário no app nativo, que não roda no mesmo domínio do servidor)
const API_BASE = (window.CUIDACAO_CONFIG && window.CUIDACAO_CONFIG.apiBase) ||
  (window.location.protocol === 'file:' ? 'http://localhost:3000' : '');
const IS_NATIVE_APP = !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
let demoLoginEnabled = false;
let deferredInstallPrompt = null;
const PEREQUE_COORDS = { lat: -23.93680, lng: -46.18250 };
const DEFAULT_GUARUJA_COORDS = { lat: PEREQUE_COORDS.lat, lng: PEREQUE_COORDS.lng };
const GUARUJA_COVERAGE = Object.freeze({ minLat: -24.12, maxLat: -23.82, minLng: -46.40, maxLng: -46.05 });
const STORAGE_COORDS_KEY = 'cuidacao_precise_coords_v2_pereque';
const STORAGE_MAP_STYLE_KEY = 'cuidacao_map_style';
const STORAGE_GOOGLE_ACCOUNTS_KEY = 'cuidacao_google_accounts_v1';

let map;
let baseLayers = {
  streets: null,
  satellite: null,
  hybridLabels: null,
  hybridTransportation: null
};
let currentMapStyle = localStorage.getItem(STORAGE_MAP_STYLE_KEY) === 'satellite' ? 'satellite' : 'streets';
let locationsGroup = (typeof L !== 'undefined' && typeof L.markerClusterGroup === 'function')
  ? L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 42,
      spiderfyOnMaxZoom: true,
      disableClusteringAtZoom: 17,
      iconCreateFunction: function (cluster) {
        return L.divIcon({
          html: '<div class="cuidacao-cluster-badge">' + cluster.getChildCount() + '</div>',
          className: 'cuidacao-cluster-icon',
          iconSize: L.point(40, 40)
        });
      }
    })
  : L.layerGroup();
let reportsGroup = L.layerGroup();
let neighborhoodsGroup = L.layerGroup();
let heatmapLayer = null;
let heatmapVisible = false;
let cachedReports = [];
let userMarker = null;
let cepHighlightMarker = null;
let cepFeedbackTimer = null;
let accuracyCircle = null;
let pickLocationMode = false; // false | 'user' | 'report'

// GPS em tempo real (módulo js/map/live-gps.js)
const LIVE_GPS_MAX_ACCURACY_M = 300;            // leituras piores (IP/wi-fi) não movem o pino
const LIVE_GPS_MAX_DIST_FROM_PEREQUE_M = 30000; // fora do Guarujá o pino não é movido
const LIVE_GPS_CONTEXT_MIN_MOVE_M = 150;        // endereço/locais só são recarregados após andar 150 m...
const LIVE_GPS_CONTEXT_MIN_INTERVAL_MS = 30000; // ...e no máximo a cada 30 s (poupa API e Nominatim)
let liveGpsTracker = null;
let liveGpsFollow = true;            // false quando o usuário fixa a posição manualmente (arrastar/CEP/clique)
let liveGpsHasFirstFix = false;
let liveGpsCenterOnNextFix = false;
let liveGpsLastAccepted = null;      // última leitura válida { lat, lng, accuracy, timestamp }
let liveGpsLastContext = null;       // { lat, lng, at } da última recarga de endereço/locais
const liveGpsNoticeAt = {};          // controle anti-spam dos avisos
let locationContextSeq = 0;

// Camada unificada de farmácias (cat-3)
const STORAGE_PHARMACY_LAYER_KEY = 'cuidacao_show_pharmacies';
let pharmaciesVisible = localStorage.getItem(STORAGE_PHARMACY_LAYER_KEY) !== '0';

let locationsAbortController = null;
let locationsReqSeq = 0;
let reportsAbortController = null;
let reportsReqSeq = 0;
let modalsInitialized = false;

let currentFilter = 'all';
let currentCategory = 'all';
let onlyPopularPharmacy = false;
let onlyOpenNow = false;
let currentSearch = '';
let currentRadius = 25000; // 25 km por padrão para abranger 100% do Guarujá e todos os bairros
let selectedLocation = null;
let userCoords = { lat: PEREQUE_COORDS.lat, lng: PEREQUE_COORDS.lng };
let reportTargetCoords = null;
let currentAddressLabel = 'Bairro do Perequê, Guarujá - SP';
let currentAccuracyMeters = 12;
let currentLocationSource = 'Bairro do Perequê';
let currentUser = null;
let authToken = localStorage.getItem('cuidacao_token') || localStorage.getItem('onehealth_token') || null;
let cachedLocations = [];
let googleClientId = ''; // definido pelo servidor (/api/v1/auth/google/config)

// ÍCONES VETORIAIS OFICIAIS PARA CADA ENTIDADE DO PROJETO CuidAção
const SVG_ICONS = {
  hospital: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-2 10h-4v4h-2v-4H7v-2h4V7h2v4h4v2z"/></svg>',
  clinic: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M10.5 4a1.5 1.5 0 00-1.5 1.5V9H5.5A1.5 1.5 0 004 10.5v3A1.5 1.5 0 005.5 15H9v3.5A1.5 1.5 0 0010.5 20h3a1.5 1.5 0 001.5-1.5V15h3.5a1.5 1.5 0 001.5-1.5v-3a1.5 1.5 0 00-1.5-1.5H15V5.5A1.5 1.5 0 0013.5 4h-3z"/></svg>',
  pill: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.5 20.5l10-10a4.95 4.95 0 10-7-7l-10 10a4.95 4.95 0 107 7z"/><path d="M8.5 8.5l7 7"/></svg>',
  recycle: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M7 19H4.8a1.8 1.8 0 0 1-1.56-.88 1.8 1.8 0 0 1 0-1.78L7.2 9.5"/><path d="M11 19h8.2a1.8 1.8 0 0 0 1.58-.91 1.8 1.8 0 0 0 0-1.8L17 10"/><path d="m14 12 3-3 3 3"/><path d="M14.5 4.5 12 2 9.5 4.5"/><path d="M12 2v6.5a1.5 1.5 0 0 0 1.5 1.5H17"/><path d="m6 16 2 3-2 3"/></svg>',
  tree: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L4 14h3v6h10v-6h3L12 2zm0 3.8L15.5 9h-7L12 5.8z"/></svg>',
  paw: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor"><circle cx="6.5" cy="9.5" r="2"/><circle cx="10" cy="6.5" r="2"/><circle cx="14.5" cy="6.5" r="2"/><circle cx="17.8" cy="9.5" r="2"/><path d="M12 11.5c-3.1 0-5.8 2.4-5.8 5.2 0 1.6 1.2 2.8 2.8 2.8 1.1 0 2-.5 3-.5s1.9.5 3 .5c1.6 0 2.8-1.2 2.8-2.8 0-2.8-2.7-5.2-5.8-5.2z"/></svg>',
  alert: '<svg class="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/></svg>'
};

// ============================================================================
// BASE COMPLETA DE BAIRROS E UNIDADES DO GUARUJÁ INTEIRO (GARANTIA CLIENTE+SERVIDOR)
// ============================================================================
const GUARUJA_ALL_NEIGHBORHOODS = [
  { name: 'Bairro do Perequê', lat: -23.93680, lng: -46.18250, highlight: true },
  { name: 'Praia do Perequê', lat: -23.93780, lng: -46.18050, highlight: true },
  { name: 'Cachoeira do Perequê', lat: -23.93250, lng: -46.18850, highlight: true },
  { name: 'Praia de Pernambuco', lat: -23.96820, lng: -46.19120 },
  { name: 'Mar Casado', lat: -23.97180, lng: -46.18720 },
  { name: 'Jardim Acapulco', lat: -23.96240, lng: -46.20150 },
  { name: 'Cidade Atlântica', lat: -23.98380, lng: -46.21250 },
  { name: 'Serra do Guararu / Iporanga', lat: -23.89650, lng: -46.15800 },
  { name: 'Prainha Branca', lat: -23.86850, lng: -46.13550 },
  { name: 'Morrinhos I, II, III e IV', lat: -23.96850, lng: -46.25100 },
  { name: 'Vila Júlia / Helena Maria', lat: -23.98010, lng: -46.22480 },
  { name: 'Enseada', lat: -23.98650, lng: -46.22910 },
  { name: 'Vila Baiana / Jd. Virgínia', lat: -23.98220, lng: -46.23640 },
  { name: 'Jardim Três Marias', lat: -23.98520, lng: -46.24120 },
  { name: 'Pitangueiras', lat: -23.99103, lng: -46.25892 },
  { name: 'Centro do Guarujá', lat: -23.99946, lng: -46.26439 },
  { name: 'Vila Maia', lat: -23.99060, lng: -46.25325 },
  { name: 'Santo Antônio', lat: -23.98327, lng: -46.26759 },
  { name: 'Astúrias', lat: -24.00180, lng: -46.26470 },
  { name: 'Tombo / Las Palmas', lat: -24.01420, lng: -46.27250 },
  { name: 'Jardim dos Pássaros', lat: -24.00950, lng: -46.27120 },
  { name: 'Guaiúba', lat: -24.01850, lng: -46.29120 },
  { name: 'Vila Santa Rosa', lat: -23.99427, lng: -46.28623 },
  { name: 'Santa Cruz dos Navegantes', lat: -23.98750, lng: -46.30850 },
  { name: 'Vicente de Carvalho', lat: -23.94100, lng: -46.28950 },
  { name: 'Pae Cará / Vila Alice', lat: -23.94880, lng: -46.29220 },
  { name: 'Jardim Boa Esperança', lat: -23.95650, lng: -46.28300 },
  { name: 'Jardim Conceiçãozinha', lat: -23.96280, lng: -46.29150 },
  { name: 'Vila Áurea / Monteiro da Cruz', lat: -23.93620, lng: -46.28150 }
];

const GUARUJA_BUILTIN_LOCATIONS = [
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
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
    opening_hours: { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } },
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
    has_popular_pharmacy: true,
    name: 'Farmácia Popular & Drogaria do Perequê',
    address: 'Estrada Guarujá-Bertioga, 410 - Centro do Perequê, Guarujá - SP',
    city: 'Guarujá',
    state: 'SP',
    lat: -23.93650,
    lng: -46.18190,
    services: ['Medicamentos de Uso Contínuo (Hipertensão e Diabetes)', 'Coleta de Medicamentos Vencidos', 'Aferição de Pressão Arterial e Glicemia'],
    opening_hours: { '0': { open: '08:00', close: '21:00' }, '1': { open: '07:30', close: '22:00' }, '2': { open: '07:30', close: '22:00' }, '3': { open: '07:30', close: '22:00' }, '4': { open: '07:30', close: '22:00' }, '5': { open: '07:30', close: '22:00' }, '6': { open: '08:00', close: '22:00' } },
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
    opening_hours: { '1': { open: '08:00', close: '17:00' }, '2': { open: '08:00', close: '17:00' }, '3': { open: '08:00', close: '17:00' }, '4': { open: '08:00', close: '17:00' }, '5': { open: '08:00', close: '17:00' }, '6': { open: '08:00', close: '13:00' } },
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
    opening_hours: { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } },
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
    opening_hours: { '0': { open: '07:00', close: '18:00' }, '1': { open: '07:00', close: '18:00' }, '2': { open: '07:00', close: '18:00' }, '3': { open: '07:00', close: '18:00' }, '4': { open: '07:00', close: '18:00' }, '5': { open: '07:00', close: '18:00' }, '6': { open: '07:00', close: '18:00' } },
    avg_wait_time: 5.0,
    avg_accessibility: 4.4,
    avg_humanized_care: 4.9,
    overall_score: 4.8,
    total_reviews: 39,
    reviews: []
  },
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
    opening_hours: { '1': { open: '08:00', close: '17:00' }, '2': { open: '08:00', close: '17:00' }, '3': { open: '08:00', close: '17:00' }, '4': { open: '08:00', close: '17:00' }, '5': { open: '08:00', close: '17:00' } },
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
    has_popular_pharmacy: true,
    name: 'Drogaria & Farmácia Popular Praia de Pernambuco',
    address: 'Av. Marjory da Silva Prado, 1100 - Praia de Pernambuco, Guarujá - SP',
    city: 'Guarujá',
    state: 'SP',
    lat: -23.96857,
    lng: -46.18805,
    services: ['Programa Farmácia Popular', 'Descarte Consciente de Blisters e Remédios', 'Atendimento Farmacêutico'],
    opening_hours: { '0': { open: '08:00', close: '22:00' }, '1': { open: '08:00', close: '22:00' }, '2': { open: '08:00', close: '22:00' }, '3': { open: '08:00', close: '22:00' }, '4': { open: '08:00', close: '22:00' }, '5': { open: '08:00', close: '22:00' }, '6': { open: '08:00', close: '22:00' } },
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
    opening_hours: { '1': { open: '08:00', close: '17:00' }, '2': { open: '08:00', close: '17:00' }, '3': { open: '08:00', close: '17:00' }, '4': { open: '08:00', close: '17:00' }, '5': { open: '08:00', close: '17:00' }, '6': { open: '08:00', close: '13:00' } },
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
    opening_hours: { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } },
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
    opening_hours: { '0': { open: '07:00', close: '18:00' }, '1': { open: '07:00', close: '18:00' }, '2': { open: '07:00', close: '18:00' }, '3': { open: '07:00', close: '18:00' }, '4': { open: '07:00', close: '18:00' }, '5': { open: '07:00', close: '18:00' }, '6': { open: '07:00', close: '18:00' } },
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
    avg_wait_time: 4.4,
    avg_accessibility: 4.7,
    avg_humanized_care: 4.6,
    overall_score: 4.6,
    total_reviews: 18,
    reviews: []
  },
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
    opening_hours: { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } },
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
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
    opening_hours: { '1': { open: '08:00', close: '17:00' }, '2': { open: '08:00', close: '17:00' }, '3': { open: '08:00', close: '17:00' }, '4': { open: '08:00', close: '17:00' }, '5': { open: '08:00', close: '17:00' }, '6': { open: '08:00', close: '12:00' } },
    avg_wait_time: 4.8,
    avg_accessibility: 4.7,
    avg_humanized_care: 4.8,
    overall_score: 4.8,
    total_reviews: 25,
    reviews: []
  },
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
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
    opening_hours: { '0': { open: '08:00', close: '20:00' }, '1': { open: '08:00', close: '20:00' }, '2': { open: '08:00', close: '20:00' }, '3': { open: '08:00', close: '20:00' }, '4': { open: '08:00', close: '20:00' }, '5': { open: '08:00', close: '20:00' }, '6': { open: '08:00', close: '20:00' } },
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
    opening_hours: { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } },
    avg_wait_time: 5.0,
    avg_accessibility: 4.8,
    avg_humanized_care: 4.9,
    overall_score: 4.9,
    total_reviews: 34,
    reviews: []
  },
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
    opening_hours: { '0': { open: '00:00', close: '23:59' }, '1': { open: '00:00', close: '23:59' }, '2': { open: '00:00', close: '23:59' }, '3': { open: '00:00', close: '23:59' }, '4': { open: '00:00', close: '23:59' }, '5': { open: '00:00', close: '23:59' }, '6': { open: '00:00', close: '23:59' } },
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
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
    opening_hours: { '1': { open: '08:00', close: '17:00' }, '2': { open: '08:00', close: '17:00' }, '3': { open: '08:00', close: '17:00' }, '4': { open: '08:00', close: '17:00' }, '5': { open: '08:00', close: '17:00' }, '6': { open: '08:00', close: '12:00' } },
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
    opening_hours: { '1': { open: '07:00', close: '17:00' }, '2': { open: '07:00', close: '17:00' }, '3': { open: '07:00', close: '17:00' }, '4': { open: '07:00', close: '17:00' }, '5': { open: '07:00', close: '17:00' } },
    avg_wait_time: 4.6,
    avg_accessibility: 4.6,
    avg_humanized_care: 4.9,
    overall_score: 4.7,
    total_reviews: 21,
    reviews: []
  },
  {
    id: 'loc-zoonoses-1',
    categoryId: 'cat-6',
    categoryName: 'Saúde Animal & Controle de Zoonoses',
    domain: 'animal',
    color: '#0D9488',
    iconType: 'paw',
    name: 'Centro de Controle de Zoonoses (CCZ) & Bem-Estar Animal do Guarujá',
    address: 'Av. Adriano Dias dos Santos, 600 - Jardim Boa Esperança / Vicente de Carvalho, Guarujá - SP',
    city: 'Guarujá',
    state: 'SP',
    lat: -23.95710,
    lng: -46.28420,
    services: ['Vacinação Antirrábica Gratuita (Cães e Gatos)', 'Vigilância e Controle de Zoonoses', 'Castração Pública e Microchipagem'],
    opening_hours: { '1': { open: '08:00', close: '17:00' }, '2': { open: '08:00', close: '17:00' }, '3': { open: '08:00', close: '17:00' }, '4': { open: '08:00', close: '17:00' }, '5': { open: '08:00', close: '17:00' } },
    avg_wait_time: 4.5,
    avg_accessibility: 4.7,
    avg_humanized_care: 4.9,
    overall_score: 4.7,
    total_reviews: 1,
    reviews: []
  },
  {
    id: 'loc-zoonoses-2',
    categoryId: 'cat-6',
    categoryName: 'Saúde Animal & Controle de Zoonoses',
    domain: 'animal',
    color: '#0D9488',
    iconType: 'paw',
    name: 'Posto Avançado de Saúde Animal & Zoonoses Perequê / Serra do Guararu',
    address: 'Estrada Guarujá-Bertioga, km 7,5 - Perequê, Guarujá - SP',
    city: 'Guarujá',
    state: 'SP',
    lat: -23.93510,
    lng: -46.18560,
    services: ['Campanha Permanente de Vacinação Antirrábica', 'Monitoramento de Fauna Silvestre da Mata Atlântica', 'Prevenção de Zoonoses Costeiras'],
    opening_hours: { '1': { open: '08:00', close: '16:30' }, '2': { open: '08:00', close: '16:30' }, '3': { open: '08:00', close: '16:30' }, '4': { open: '08:00', close: '16:30' }, '5': { open: '08:00', close: '16:30' } },
    avg_wait_time: 4.7,
    avg_accessibility: 4.6,
    avg_humanized_care: 4.9,
    overall_score: 4.7,
    total_reviews: 1,
    reviews: []
  }
].concat(
  (Array.isArray(window.CUIDACAO_FARMACIAS_MOCK) ? window.CUIDACAO_FARMACIAS_MOCK : []).map(p => ({
    id: p.id,
    categoryId: 'cat-3',
    categoryName: p.temFarmaciaPopular ? 'Farmácia Popular' : 'Farmácia & Drogaria',
    domain: 'health',
    color: '#8B5CF6',
    iconType: 'pill',
    has_popular_pharmacy: !!p.temFarmaciaPopular,
    name: p.nome,
    address: p.endereco,
    city: 'Guarujá',
    state: 'SP',
    lat: p.latitude,
    lng: p.longitude,
    services: p.temFarmaciaPopular
      ? ['Programa Farmácia Popular', 'Medicamentos e Atendimento Farmacêutico', 'Descarte Consciente']
      : ['Medicamentos e Perfumaria', 'Primeiros Socorros', 'Atendimento Farmacêutico'],
    opening_hours: { '0': { open: '08:00', close: '22:00' }, '1': { open: '07:00', close: '23:00' }, '2': { open: '07:00', close: '23:00' }, '3': { open: '07:00', close: '23:00' }, '4': { open: '07:00', close: '23:00' }, '5': { open: '07:00', close: '23:00' }, '6': { open: '07:00', close: '23:00' } },
    avg_wait_time: 0,
    avg_accessibility: 0,
    avg_humanized_care: 0,
    overall_score: 0,
    total_reviews: 0,
    reviews: []
  }))
);

// ============================================================================
// SISTEMA DE NOTIFICAÇÕES FLUTUANTES (TOASTS MODERNOS - SUBSTITUI ALERT NATIVO)
// ============================================================================
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const styles = {
    success: {
      bg: 'bg-emerald-900/95 border-emerald-400/40 text-white',
      icon: '✅',
      badge: 'Sucesso'
    },
    error: {
      bg: 'bg-red-900/95 border-red-400/40 text-white',
      icon: '⚠️',
      badge: 'Atenção'
    },
    info: {
      bg: 'bg-gray-900/95 border-gray-600/40 text-white',
      icon: '💡',
      badge: 'CuidAção'
    }
  };

  const cfg = styles[type] || styles.info;
  const toast = document.createElement('div');
  toast.className =
    'toast-enter pointer-events-auto flex items-start gap-3 p-3.5 rounded-2xl shadow-2xl border backdrop-blur-md text-xs ' +
    cfg.bg;

  toast.innerHTML =
    '<span class="text-base leading-none mt-0.5 shrink-0">' + cfg.icon + '</span>' +
    '<div class="flex-1 min-w-0">' +
      '<p class="text-[10px] font-extrabold uppercase tracking-wider opacity-80">' + cfg.badge + '</p>' +
      '<p class="font-semibold leading-snug mt-0.5 break-words">' + escapeHtml(message) + '</p>' +
    '</div>' +
    '<button type="button" class="opacity-70 hover:opacity-100 font-bold text-xs px-1">✕</button>';

  const closeBtn = toast.querySelector('button');
  const removeToast = () => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-8px)';
    toast.style.transition = 'opacity 0.2s, transform 0.2s';
    setTimeout(() => {
      if (toast.parentNode) toast.parentNode.removeChild(toast);
    }, 200);
  };

  if (closeBtn) closeBtn.onclick = removeToast;
  container.appendChild(toast);
  setTimeout(removeToast, 4500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function decodeJwtPayload(token) {
  const base64Url = token.split('.')[1];
  if (!base64Url) throw new Error('Token inválido');
  let base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const jsonPayload = decodeURIComponent(
    atob(base64)
      .split('')
      .map(c => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
      .join('')
  );
  return JSON.parse(jsonPayload);
}

function isInGuarujaCoverage(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) &&
    lat >= GUARUJA_COVERAGE.minLat && lat <= GUARUJA_COVERAGE.maxLat &&
    lng >= GUARUJA_COVERAGE.minLng && lng <= GUARUJA_COVERAGE.maxLng;
}

function isTokenValid(token) {
  if (!token || typeof token !== 'string') return false;
  try {
    const payload = decodeJwtPayload(token);
    if (!payload || typeof payload.exp !== 'number') return false;
    return Date.now() <= payload.exp;
  } catch {
    return false;
  }
}

function clearExpiredOrInvalidSession(promptLogin = true, message = 'Sua sessão expirou. Faça login novamente.') {
  authToken = null;
  currentUser = null;
  try {
    localStorage.removeItem('cuidacao_token');
    localStorage.removeItem('onehealth_token');
  } catch {
    // Ignora erro de localStorage
  }
  renderAuthBox();
  if (selectedLocation) openSidebar(selectedLocation);
  if (message) showToast(message, 'info');
  if (promptLogin) openLoginModal();
}

async function apiFetch(pathOrUrl, options = {}) {
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : (API_BASE + pathOrUrl);
  const opts = Object.assign({}, options);
  const headers = Object.assign({}, opts.headers || {});
  const isAuthRequest = !!(opts.auth || headers['Authorization'] || headers['authorization']);
  delete opts.auth;

  if (isAuthRequest && authToken && !headers['Authorization'] && !headers['authorization']) {
    headers['Authorization'] = 'Bearer ' + authToken;
  }
  opts.headers = headers;

  const res = await fetch(url, opts);
  if (res.status === 401 && isAuthRequest) {
    clearExpiredOrInvalidSession(true, 'Sessão expirada ou inválida. Faça login novamente para continuar.');
  }
  return res;
}

function setupAccessibleModals() {
  if (modalsInitialized) return;
  modalsInitialized = true;

  const modalCloseMap = {
    'modal-about': closeAboutModal,
    'modal-google-account': closeGoogleAccountModal,
    'modal-location': closeLocationModal,
    'modal-login': closeLoginModal,
    'modal-review': closeReviewModal,
    'modal-report': closeReportModal
  };

  Object.keys(modalCloseMap).forEach(id => {
    const modalEl = document.getElementById(id);
    if (!modalEl) return;
    modalEl.addEventListener('click', (e) => {
      if (e.target === modalEl) {
        modalCloseMap[id]();
      }
    });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const priorityIds = ['modal-review', 'modal-report', 'modal-login', 'modal-google-account', 'modal-location', 'modal-about'];
    for (const id of priorityIds) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) {
        e.preventDefault();
        modalCloseMap[id]();
        return;
      }
    }
    const gpsAlertEl = document.getElementById('gps-alert');
    if (gpsAlertEl && !gpsAlertEl.classList.contains('hidden')) {
      e.preventDefault();
      hideGpsAlert();
      return;
    }
    if (pickLocationMode) {
      e.preventDefault();
      cancelPickLocationMode();
      return;
    }
    const communityEl = document.getElementById('community-bar');
    if (communityEl && !communityEl.classList.contains('hidden')) {
      e.preventDefault();
      closeCommunityBar();
      return;
    }
    const sidebarEl = document.getElementById('sidebar');
    if (sidebarEl && !sidebarEl.classList.contains('hidden')) {
      e.preventDefault();
      closeSidebar();
    }
  });
}

function updateDemoLoginVisibility() {
  const demoBox = document.getElementById('demo-credentials-box');
  if (demoBox) {
    demoBox.classList.toggle('hidden', !demoLoginEnabled);
  }
}

function updateHomeScreenCta() {
  const labelEl = document.getElementById('btn-home-explore-label');
  if (!labelEl) return;
  if (currentUser && currentUser.name && authToken && isTokenValid(authToken)) {
    const firstName = currentUser.name.trim().split(/\s+/)[0];
    labelEl.textContent = 'Continuar como ' + firstName;
  } else {
    labelEl.textContent = 'Começar a Explorar o Mapa';
  }
}

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371e3;
  const p1 = lat1 * Math.PI / 180;
  const p2 = lat2 * Math.PI / 180;
  const dp = (lat2 - lat1) * Math.PI / 180;
  const dl = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dp / 2) * Math.sin(dp / 2) +
            Math.cos(p1) * Math.cos(p2) *
            Math.sin(dl / 2) * Math.sin(dl / 2);
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

function findNearestNeighborhood(lat, lng) {
  let nearest = GUARUJA_ALL_NEIGHBORHOODS[0];
  let minDist = Infinity;
  for (const nb of GUARUJA_ALL_NEIGHBORHOODS) {
    const d = haversineMeters(lat, lng, nb.lat, nb.lng);
    if (d < minDist) {
      minDist = d;
      nearest = nb;
    }
  }
  return { neighborhood: nearest, distance: minDist };
}

// ============================================================================
// REGISTRO DO SERVICE WORKER (PWA INSTALÁVEL)
// ============================================================================
function registerServiceWorkerPwa() {
  if (IS_NATIVE_APP) return;
  const secure = window.location.protocol === 'https:' || window.location.hostname === 'localhost';
  if ('serviceWorker' in navigator && secure) {
    navigator.serviceWorker
      .register('sw.js')
      .catch((err) => console.warn('Service Worker não registrado:', err.message));
  }
}

// ============================================================================
// 1. INICIALIZAR MAPA COM FOCO NO BAIRRO DO PEREQUÊ E COBERTURA DO GUARUJÁ INTEIRO
// ============================================================================
async function initMap() {
  registerServiceWorkerPwa();
  setupAccessibleModals();

  try {
    const cfgRes = await apiFetch('/api/v1/auth/google/config');
    if (cfgRes.ok) {
      const cfg = await cfgRes.json();
      if (cfg.clientId) {
        googleClientId = cfg.clientId;
      }
      demoLoginEnabled = !!cfg.demoLogin;
    }
  } catch {
    // Segue com configuração local
  }
  updateDemoLoginVisibility();

  let hasManualSaved = false;
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_COORDS_KEY) || 'null');
    if (saved && typeof saved.lat === 'number' && typeof saved.lng === 'number') {
      userCoords = { lat: saved.lat, lng: saved.lng };
      currentLocationSource = saved.source || 'Bairro do Perequê';
      currentAccuracyMeters = saved.accuracy || 5;
      if (saved.label) currentAddressLabel = saved.label;
      hasManualSaved = saved.source === 'Manual';
    }
  } catch {
    // Ignora erro de leitura do localStorage
  }

  map = L.map('map', {
    zoomControl: false,
    scrollWheelZoom: true,
    wheelPxPerZoomLevel: 260,
    wheelDebounceTime: 100,
    zoomDelta: 0.5,
    zoomSnap: 0.25,
    inertia: true,
    inertiaDeceleration: 3000
  }).setView([userCoords.lat, userCoords.lng], hasManualSaved ? 16 : 15);

  // 1. Camada Vetorial / Padrão (OpenStreetMap)
  baseLayers.streets = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap contributors',
    maxZoom: 19
  });

  // 2. Camada Satélite HD Estilo Google Earth (Esri World Imagery)
  baseLayers.satellite = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics, USDA, USGS, AeroGRID, IGN, and the GIS User Community',
      maxZoom: 19
    }
  );

  // 3. Camadas Híbridas de Referência Sobrepostas ao Satélite (Limites, Bairros e Viário Esri)
  baseLayers.hybridTransportation = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
    {
      maxZoom: 19,
      opacity: 0.85
    }
  );

  baseLayers.hybridLabels = L.tileLayer(
    'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
    {
      attribution: 'Labels &copy; Esri',
      maxZoom: 19
    }
  );

  // Aplica a camada salva no localStorage ('streets' ou 'satellite')
  applyMapStyle(currentMapStyle, false);

  neighborhoodsGroup.addTo(map);
  locationsGroup.addTo(map);
  reportsGroup.addTo(map);
  updatePharmacyToggleButton();

  renderNeighborhoodLabelsOnMap();

  window.addEventListener('resize', () => {
    if (map) map.invalidateSize({ animate: false });
  });

  // Clique no mapa para calibrar a localização do usuário OU apontar local exato de um foco ambiental
  map.on('click', async (e) => {
    if (!pickLocationMode) return;
    const { lat, lng } = e.latlng;
    const mode = pickLocationMode;
    cancelPickLocationMode();

    if (mode === 'report') {
      await applyCustomReportPoint(lat, lng);
      return;
    }

    const nearest = findNearestNeighborhood(lat, lng);
    const label = nearest.distance <= 2500 ? (nearest.neighborhood.name + ', Guarujá - SP') : '';
    saveManualCoordinates(lat, lng, label);
    await applyUserCoordinates(lat, lng, 'Posição Exata (100%)', 3, true);
    showToast('Sua localização exata foi cravada no mapa!', 'success');
  });

  if (authToken) {
    if (isTokenValid(authToken)) {
      currentUser = decodeJwtPayload(authToken);
    } else {
      localStorage.removeItem('cuidacao_token');
      localStorage.removeItem('onehealth_token');
      authToken = null;
      currentUser = null;
    }
  }
  renderAuthBox();

  // Renderiza pino inicial e dispara o bootstrap único de localização + locais + alertas (sem duplicidade)
  ensureUserMarker(userCoords.lat, userCoords.lng, currentAccuracyMeters || 12, currentLocationSource);
  initCommunityBar();

  // Suporte a link direto vindo de comunidade.html (?focusLat=...&focusLng=...)
  const params = new URLSearchParams(window.location.search);
  const focusLat = parseFloat(params.get('focusLat'));
  const focusLng = parseFloat(params.get('focusLng'));
  if (Number.isFinite(focusLat) && Number.isFinite(focusLng) && isInGuarujaCoverage(focusLat, focusLng)) {
    hideHomeScreen();
    await selectPreciseLocation(focusLat, focusLng, 'Alerta da Comunidade, Guarujá - SP');
    return;
  }

  await detectAndApplyUserLocation(false);
}

// ============================================================================
// ALTERNADOR DINÂMICO DE CAMADAS (MAPA DE RUAS OSM <-> SATÉLITE HD HÍBRIDO ESRI)
// ============================================================================
function toggleMapStyle() {
  const nextStyle = currentMapStyle === 'satellite' ? 'streets' : 'satellite';
  applyMapStyle(nextStyle, true);
}

function applyMapStyle(style, notifyUser = true) {
  currentMapStyle = style === 'satellite' ? 'satellite' : 'streets';

  try {
    localStorage.setItem(STORAGE_MAP_STYLE_KEY, currentMapStyle);
  } catch {
    // Ignora caso localStorage esteja bloqueado
  }

  const mapEl = document.getElementById('map');

  if (map && baseLayers.streets && baseLayers.satellite) {
    if (currentMapStyle === 'satellite') {
      if (map.hasLayer(baseLayers.streets)) {
        map.removeLayer(baseLayers.streets);
      }
      if (!map.hasLayer(baseLayers.satellite)) {
        baseLayers.satellite.addTo(map);
      }
      if (baseLayers.hybridTransportation && !map.hasLayer(baseLayers.hybridTransportation)) {
        baseLayers.hybridTransportation.addTo(map);
      }
      if (baseLayers.hybridLabels && !map.hasLayer(baseLayers.hybridLabels)) {
        baseLayers.hybridLabels.addTo(map);
      }
      if (mapEl) mapEl.classList.add('satellite-mode');
    } else {
      if (map.hasLayer(baseLayers.satellite)) {
        map.removeLayer(baseLayers.satellite);
      }
      if (baseLayers.hybridTransportation && map.hasLayer(baseLayers.hybridTransportation)) {
        map.removeLayer(baseLayers.hybridTransportation);
      }
      if (baseLayers.hybridLabels && map.hasLayer(baseLayers.hybridLabels)) {
        map.removeLayer(baseLayers.hybridLabels);
      }
      if (!map.hasLayer(baseLayers.streets)) {
        baseLayers.streets.addTo(map);
      }
      if (mapEl) mapEl.classList.remove('satellite-mode');
    }
  }

  // Ajusta o contraste do círculo de precisão do usuário para destacar sobre o mar/mata no satélite
  if (accuracyCircle) {
    if (currentMapStyle === 'satellite') {
      accuracyCircle.setStyle({
        color: '#60A5FA',
        weight: 1.8,
        fillColor: '#3B82F6',
        fillOpacity: 0.18
      });
    } else {
      accuracyCircle.setStyle({
        color: '#2563EB',
        weight: 1.2,
        fillColor: '#3B82F6',
        fillOpacity: 0.10
      });
    }
  }

  updateMapStyleButtons();

  if (notifyUser) {
    if (currentMapStyle === 'satellite') {
      showToast('Visão Orbital de Satélite HD (Estilo Google Earth) ativada!', 'info');
    } else {
      showToast('Mapa Vetorial de Ruas (OpenStreetMap) ativado!', 'info');
    }
  }
}

function updateMapStyleButtons() {
  const floatingBtn = document.getElementById('btn-map-style-floating');
  if (!floatingBtn) return;

  if (currentMapStyle === 'satellite') {
    floatingBtn.className =
      'px-3.5 h-11 bg-emerald-600 hover:bg-emerald-700 active:scale-95 text-white rounded-2xl font-extrabold text-xs border border-emerald-400 ring-2 ring-emerald-300/60 shadow-2xl flex items-center justify-center gap-1.5 transition';
    floatingBtn.innerHTML = '🗺️ <span>Mapa de Ruas</span>';
  } else {
    floatingBtn.className =
      'px-3.5 h-11 bg-white/95 backdrop-blur-md hover:bg-gray-50 active:scale-95 text-slate-800 rounded-2xl font-extrabold text-xs border border-gray-200 shadow-xl flex items-center justify-center gap-1.5 transition';
    floatingBtn.innerHTML = '🛰️ <span>Satélite</span>';
  }
}

// Renderiza marcadores discretos de identificação dos bairros do Guarujá para referência geográfica
function renderNeighborhoodLabelsOnMap() {
  neighborhoodsGroup.clearLayers();
  GUARUJA_ALL_NEIGHBORHOODS.forEach(nb => {
    const badgeClass = nb.highlight
      ? 'bg-emerald-900/90 text-lime-200 border-lime-400/50 font-extrabold shadow-md'
      : 'bg-gray-900/70 text-white/90 border-white/25 font-semibold';

    const icon = L.divIcon({
      className: '',
      html:
        '<div class="px-2 py-0.5 rounded-full text-[10px] border backdrop-blur-sm whitespace-nowrap pointer-events-auto cursor-pointer hover:scale-105 transition ' + badgeClass + '" title="Centralizar em ' + escapeHtml(nb.name) + '">' +
          (nb.highlight ? '📍 ' : '') + escapeHtml(nb.name) +
        '</div>',
      iconSize: [110, 20],
      iconAnchor: [55, 10]
    });

    const m = L.marker([nb.lat, nb.lng], { icon, zIndexOffset: -200 });
    m.on('click', () => {
      selectPreciseLocation(nb.lat, nb.lng, nb.name + ', Guarujá - SP');
    });
    neighborhoodsGroup.addLayer(m);
  });
}

function jumpToNeighborhood(val) {
  if (!val) return;
  if (val === 'OVERVIEW_GUARUJA') {
    viewWholeGuaruja();
    return;
  }
  const parts = val.split(',');
  const lat = parseFloat(parts[0]);
  const lng = parseFloat(parts[1]);
  const label = parts.slice(2).join(',').trim();
  if (!isNaN(lat) && !isNaN(lng)) {
    selectPreciseLocation(lat, lng, label || 'Guarujá - SP');
  }
}

function viewWholeGuaruja() {
  if (!map) return;
  currentRadius = 25000;
  const radiusSelect = document.getElementById('radius-select');
  if (radiusSelect) radiusSelect.value = '25000';
  loadLocations();

  // Enquadra toda a Ilha de Santo Amaro (Guarujá Inteiro: de Santa Cruz/Vicente de Carvalho e Guaiúba até o Perequê e Prainha Branca)
  const bounds = L.latLngBounds(
    [-24.0220, -46.3120], // Sudoeste (Guaiúba / Santa Cruz dos Navegantes)
    [-23.8650, -46.1320]  // Nordeste (Perequê / Serra do Guararu / Prainha Branca)
  );
  map.flyToBounds(bounds, { padding: [50, 50], duration: 1.1 });
  showToast('Exibindo todos os bairros do Guarujá/SP (incluindo Perequê e entorno)!', 'info');
}

function saveManualCoordinates(lat, lng, label) {
  try {
    localStorage.setItem(STORAGE_COORDS_KEY, JSON.stringify({
      lat,
      lng,
      label: label || currentAddressLabel || 'Bairro do Perequê, Guarujá - SP',
      accuracy: 5,
      source: 'Manual',
      updatedAt: Date.now()
    }));
  } catch {
    // Ignora caso localStorage esteja indisponível
  }
  // Posição escolhida à mão: o GPS continua lendo, mas para de mover o pino até "Centralizar em mim"
  pauseLiveGpsFollow();
}

function accuracyVisualRadius(accuracyMeters) {
  return accuracyMeters && accuracyMeters <= 15 ? 8 : Math.min(Math.max(accuracyMeters || 15, 10), 300);
}

function buildUserPopupHtml(accuracyMeters, sourceLabel) {
  const accText = accuracyMeters ? ' (precisão ±' + Math.round(accuracyMeters) + 'm)' : '';
  const liveActive = liveGpsFollow && liveGpsTracker && liveGpsTracker.getState() === 'tracking';
  return (
    '<div class="text-xs leading-snug">' +
      '<b class="text-blue-700">📍 Sua Localização (' + escapeHtml(sourceLabel || 'Bairro do Perequê') + ')</b>' +
      '<p class="text-gray-700 font-semibold mt-0.5">' + escapeHtml(currentAddressLabel) + accText + '</p>' +
      (liveActive ? '<p class="text-[10px] text-emerald-700 font-bold mt-1">🟢 GPS em tempo real ativo</p>' : '') +
      '<p class="text-[10px] text-gray-500 mt-1">💡 Você pode arrastar este pino azul até sua rua exata (isso pausa o GPS em tempo real; toque em 🎯 Centralizar em mim para retomar).</p>' +
    '</div>'
  );
}

function ensureUserMarker(lat, lng, accuracyMeters, sourceLabel) {
  const popupHtml = buildUserPopupHtml(accuracyMeters, sourceLabel);

  if (userMarker) {
    // Posicionamento direto cancela qualquer animação de GPS em andamento
    if (window.CuidacaoLiveGps) window.CuidacaoLiveGps.cancelMarkerAnimation(userMarker);
    userMarker.setLatLng([lat, lng]);
    userMarker.setPopupContent(popupHtml);
  } else {
    const pulseIcon = L.divIcon({
      className: '',
      html: '<div class="user-pulse-pin" title="Sua posição (arraste para ajustar a rua)"></div>',
      iconSize: [24, 24],
      iconAnchor: [12, 12],
      popupAnchor: [0, -12]
    });
    userMarker = L.marker([lat, lng], {
      icon: pulseIcon,
      draggable: true,
      zIndexOffset: 1000
    }).addTo(map);

    userMarker.bindPopup(popupHtml);

    // Enquanto o usuário arrasta, o GPS não pode "puxar" o pino de volta
    userMarker.on('dragstart', () => {
      if (window.CuidacaoLiveGps) window.CuidacaoLiveGps.cancelMarkerAnimation(userMarker);
      pauseLiveGpsFollow();
    });

    userMarker.on('dragend', async () => {
      const pos = userMarker.getLatLng();
      await applyUserCoordinates(pos.lat, pos.lng, 'Posição Exata (100%)', 3, false);
      saveManualCoordinates(pos.lat, pos.lng, currentAddressLabel);
      userMarker.openPopup();
      showToast('Posição atualizada para o ponto arrastado.', 'info');
    });
  }

  const visualRadius = accuracyVisualRadius(accuracyMeters);
  if (accuracyCircle) {
    accuracyCircle.setLatLng([lat, lng]);
    accuracyCircle.setRadius(visualRadius);
  } else {
    const isSat = currentMapStyle === 'satellite';
    accuracyCircle = L.circle([lat, lng], {
      radius: visualRadius,
      color: isSat ? '#60A5FA' : '#2563EB',
      weight: isSat ? 1.8 : 1.2,
      fillColor: '#3B82F6',
      fillOpacity: isSat ? 0.18 : 0.10,
      interactive: false
    }).addTo(map);
  }
}

// ============================================================================
// 2. GEOLOCALIZAÇÃO: ÂNCORA NO PEREQUÊ + GPS EM TEMPO REAL (watchPosition)
// ============================================================================
async function detectAndApplyUserLocation(forceScan = false) {
  let respectManual = false;

  // Se o usuário já salvou manualmente sua rua/bairro, respeita a escolha (salvo leitura forçada)
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_COORDS_KEY) || 'null');
    if (saved && saved.source === 'Manual' && !forceScan) {
      respectManual = true;
      liveGpsFollow = false;
      applyUserCoordinates(saved.lat, saved.lng, 'Bairro Calibrado', 5, true).catch(() => {});
    }
  } catch {
    // Continua
  }

  if (!respectManual) {
    liveGpsFollow = true;
    const knownFix = liveGpsLastAccepted;
    if (knownFix) {
      // GPS já ativo: usa na hora a leitura mais recente (o watch só avisa quando a posição muda)
      liveGpsHasFirstFix = true;
      liveGpsLastContext = { lat: knownFix.lat, lng: knownFix.lng, at: Date.now() };
      applyUserCoordinates(knownFix.lat, knownFix.lng, 'GPS em tempo real', knownFix.accuracy || 10, true).catch(() => {});
    } else {
      // Ancora no Bairro do Perequê até a 1ª leitura válida do GPS chegar
      liveGpsHasFirstFix = false;
      applyUserCoordinates(PEREQUE_COORDS.lat, PEREQUE_COORDS.lng, 'Bairro do Perequê (Guarujá/SP)', 12, true).catch(() => {});
    }
  }

  // Rastreamento contínuo e de alta precisão (substitui a leitura única com getCurrentPosition)
  startLiveGpsTracking();
}

async function applyUserCoordinates(lat, lng, source, accuracyMeters = 10, shouldFly = true) {
  userCoords = { lat, lng };
  currentLocationSource = source || 'Bairro do Perequê';
  currentAccuracyMeters = accuracyMeters;

  updateApproxAddressLabel(lat, lng);
  ensureUserMarker(lat, lng, accuracyMeters, source);

  if (map) {
    map.invalidateSize({ animate: false });
    if (shouldFly) {
      let targetZoom = 16;
      if (accuracyMeters <= 25) targetZoom = 16;
      else if (accuracyMeters <= 300) targetZoom = 15.5;
      else targetZoom = 15;

      map.flyTo([lat, lng], targetZoom, { animate: true, duration: 0.9 });
    }
  }

  await refreshLocationContext(lat, lng);
}

function updateApproxAddressLabel(lat, lng) {
  const distToPereque = haversineMeters(lat, lng, PEREQUE_COORDS.lat, PEREQUE_COORDS.lng);
  const nearestNb = findNearestNeighborhood(lat, lng);
  if (distToPereque <= 1800) {
    currentAddressLabel = 'Bairro do Perequê, Guarujá - SP';
  } else if (nearestNb.distance <= 3500) {
    currentAddressLabel = nearestNb.neighborhood.name + ', Guarujá - SP';
  }
}

// Endereço (geocodificação reversa), selo do bairro e locais/alertas próximos da posição atual.
// Não reposiciona o pino: com o GPS ao vivo ele pode já ter andado enquanto a resposta chegava.
async function refreshLocationContext(lat, lng) {
  const seq = ++locationContextSeq;
  const distToPereque = haversineMeters(lat, lng, PEREQUE_COORDS.lat, PEREQUE_COORDS.lng);
  const nearestNb = findNearestNeighborhood(lat, lng);
  updateApproxAddressLabel(lat, lng);

  try {
    const res = await fetch(API_BASE + '/api/v1/geo/reverse?lat=' + lat + '&lng=' + lng);
    const geoInfo = res.ok ? await res.json() : null;
    if (seq !== locationContextSeq) return; // chegou uma posição mais nova enquanto esperávamos
    if (geoInfo && geoInfo.displayName) {
      if (distToPereque <= 1800 && !geoInfo.displayName.toLowerCase().includes('perequ')) {
        currentAddressLabel = geoInfo.displayName + ' (Bairro do Perequê)';
      } else {
        currentAddressLabel = geoInfo.displayName;
      }
    }
  } catch {
    if (seq !== locationContextSeq) return;
    if (distToPereque <= 1800) {
      currentAddressLabel = 'Bairro do Perequê, Guarujá - SP';
    }
  }

  const badge = document.getElementById('location-badge');
  if (badge) {
    const tagText = distToPereque <= 1800 ? 'Perequê' : (nearestNb.distance <= 3500 ? nearestNb.neighborhood.name : 'Guarujá');
    const precisionTag = ' <span class="text-[10px] bg-emerald-200 text-emerald-950 px-1.5 py-0.5 rounded-md ml-1 font-extrabold">' + escapeHtml(tagText) + '</span>';
    badge.innerHTML = '📍 <span class="max-w-[160px] sm:max-w-[230px] truncate">' + escapeHtml(currentAddressLabel) + '</span>' + precisionTag;
  }

  if (userMarker) userMarker.setPopupContent(buildUserPopupHtml(currentAccuracyMeters, currentLocationSource));
  loadLocations();
  loadReports();
}

// ---------------------------------------------------------------------------
// GPS em tempo real — integração com js/map/live-gps.js
// ---------------------------------------------------------------------------
function getLiveGpsTracker() {
  if (!liveGpsTracker && window.CuidacaoLiveGps) {
    liveGpsTracker = window.CuidacaoLiveGps.createTracker({
      onPosition: handleLiveGpsFix,
      onError: handleLiveGpsError,
      onStatusChange: updateGpsStatusIndicator
    });
  }
  return liveGpsTracker;
}

function startLiveGpsTracking() {
  const tracker = getLiveGpsTracker();
  if (!tracker) {
    console.warn('[CuidAção] Módulo de GPS (js/map/live-gps.js) não carregado.');
    return false;
  }
  return tracker.start();
}

// Avisos discretos e sem repetição (no máximo 1 a cada `cooldownMs` por tipo)
function notifyGps(key, message, type = 'info', cooldownMs = 120000) {
  const now = Date.now();
  if (liveGpsNoticeAt[key] && now - liveGpsNoticeAt[key] < cooldownMs) return;
  liveGpsNoticeAt[key] = now;
  showToast(message, type);
}

function handleLiveGpsFix(fix) {
  const distFromPereque = haversineMeters(fix.lat, fix.lng, PEREQUE_COORDS.lat, PEREQUE_COORDS.lng);
  if (distFromPereque > LIVE_GPS_MAX_DIST_FROM_PEREQUE_M) {
    notifyGps('outside', 'Sua posição de GPS está fora do Guarujá/SP (área atendida pelo CuidAção). O pino fica na última posição dentro da cidade.');
    return;
  }
  if (fix.accuracy != null && fix.accuracy > LIVE_GPS_MAX_ACCURACY_M) {
    notifyGps('weak', 'Sinal de GPS fraco (±' + Math.round(fix.accuracy) + ' m). Aguardando uma leitura mais precisa...');
    return;
  }

  hideGpsAlert();
  liveGpsLastAccepted = fix;
  if (!liveGpsFollow) return; // posição fixada manualmente: só guarda a leitura para "Centralizar em mim"

  // 1ª leitura válida: posiciona, centraliza e carrega endereço/locais
  if (!liveGpsHasFirstFix || !userMarker) {
    liveGpsHasFirstFix = true;
    liveGpsCenterOnNextFix = false;
    liveGpsLastContext = { lat: fix.lat, lng: fix.lng, at: Date.now() };
    applyUserCoordinates(fix.lat, fix.lng, 'GPS em tempo real', fix.accuracy || 10, true).catch(() => {});
    return;
  }

  // Leituras seguintes (usuário caminhando): só desliza o pino, sem tirar o mapa de onde o usuário deixou
  moveUserMarkerSmoothly(fix);
  if (liveGpsCenterOnNextFix) {
    liveGpsCenterOnNextFix = false;
    flyToUser(fix);
  }
  maybeRefreshLocationContext(fix);
}

function moveUserMarkerSmoothly(fix) {
  userCoords = { lat: fix.lat, lng: fix.lng };
  currentLocationSource = 'GPS em tempo real';
  if (fix.accuracy != null) currentAccuracyMeters = fix.accuracy;

  if (!userMarker || !window.CuidacaoLiveGps) {
    ensureUserMarker(fix.lat, fix.lng, currentAccuracyMeters, currentLocationSource);
    return;
  }

  if (accuracyCircle) accuracyCircle.setRadius(accuracyVisualRadius(currentAccuracyMeters));
  window.CuidacaoLiveGps.animateMarkerTo(userMarker, fix, {
    duration: 900,
    onStep: (latLng) => {
      if (accuracyCircle) accuracyCircle.setLatLng(latLng);
    }
  });
  userMarker.setPopupContent(buildUserPopupHtml(currentAccuracyMeters, currentLocationSource));
}

function maybeRefreshLocationContext(fix) {
  const now = Date.now();
  const last = liveGpsLastContext;
  if (last) {
    const tooSoon = now - last.at < LIVE_GPS_CONTEXT_MIN_INTERVAL_MS;
    const tooClose = haversineMeters(last.lat, last.lng, fix.lat, fix.lng) < LIVE_GPS_CONTEXT_MIN_MOVE_M;
    if (tooSoon || tooClose) return;
  }
  liveGpsLastContext = { lat: fix.lat, lng: fix.lng, at: now };
  refreshLocationContext(fix.lat, fix.lng).catch(() => {});
}

function handleLiveGpsError(err) {
  if (err.kind === 'permission-denied' || err.kind === 'insecure' || err.kind === 'unsupported') {
    liveGpsCenterOnNextFix = false;
    showGpsAlert(err.kind === 'permission-denied' ? 'denied' : err.kind);
    return;
  }
  // Timeout/indisponível: o watchPosition continua tentando. Se já temos posição recente, segue em silêncio.
  if (liveGpsLastAccepted && Date.now() - liveGpsLastAccepted.timestamp < 60000) return;
  if (err.kind === 'timeout') {
    notifyGps('timeout', 'O GPS está demorando para responder. Tente ir para um local aberto ou perto de uma janela — seguimos tentando.');
  } else {
    notifyGps('unavailable', 'Sinal de GPS indisponível no momento. Verifique se a localização do aparelho está ligada — seguimos tentando.');
  }
}

function pauseLiveGpsFollow() {
  if (!liveGpsFollow) return;
  liveGpsFollow = false;
  liveGpsCenterOnNextFix = false;
  if (liveGpsTracker) {
    updateGpsStatusIndicator(liveGpsTracker.getState());
    if (liveGpsTracker.getState() === 'tracking') {
      showToast('GPS em tempo real pausado na posição escolhida. Toque em 🎯 Centralizar em mim para voltar a seguir o GPS.', 'info');
    }
  }
}

function flyToUser(fix) {
  if (!map || !fix) return;
  const target = L.latLng(fix.lat, fix.lng);
  if (map.getZoom() >= 16 && map.getCenter().distanceTo(target) < 1500) {
    map.panTo(target, { animate: true, duration: 0.6 });
  } else {
    map.flyTo(target, Math.max(map.getZoom(), 16), { animate: true, duration: 0.9 });
  }
}

// Botão "Centralizar em mim": foca na coordenada de GPS mais recente (e retoma o GPS se estava pausado)
function centerOnMe() {
  const tracker = getLiveGpsTracker();
  if (!tracker) {
    showToast('O módulo de GPS não foi carregado. Recarregue a página.', 'error');
    return;
  }

  const state = tracker.getState();
  if (state === 'denied' || state === 'insecure' || state === 'unsupported') {
    // A permissão pode ter sido liberada nas configurações; se continuar bloqueada, o alerta reaparece
    retryLiveGps();
    return;
  }

  const wasPaused = !liveGpsFollow;
  liveGpsFollow = true;
  if (!tracker.isActive()) tracker.start();
  updateGpsStatusIndicator(tracker.getState());
  if (wasPaused) {
    try { localStorage.removeItem(STORAGE_COORDS_KEY); } catch { /* ignora */ }
  }

  const fix = liveGpsLastAccepted;
  if (fix) {
    if (wasPaused || !liveGpsHasFirstFix) {
      liveGpsHasFirstFix = true;
      liveGpsLastContext = { lat: fix.lat, lng: fix.lng, at: Date.now() };
      applyUserCoordinates(fix.lat, fix.lng, 'GPS em tempo real', fix.accuracy || 10, false).catch(() => {});
      if (wasPaused) showToast('Voltamos a seguir seu GPS em tempo real.', 'success');
    }
    flyToUser(fix);
    return;
  }

  // Ainda sem leitura válida: centraliza assim que ela chegar
  if (wasPaused) liveGpsHasFirstFix = false;
  liveGpsCenterOnNextFix = true;
  const raw = tracker.getLastFix();
  if (raw && haversineMeters(raw.lat, raw.lng, PEREQUE_COORDS.lat, PEREQUE_COORDS.lng) > LIVE_GPS_MAX_DIST_FROM_PEREQUE_M) {
    showToast('Sua posição de GPS está fora do Guarujá/SP, área atendida pelo CuidAção.', 'info');
  } else if (raw && raw.accuracy != null && raw.accuracy > LIVE_GPS_MAX_ACCURACY_M) {
    showToast('Sinal de GPS fraco (±' + Math.round(raw.accuracy) + ' m). Centralizamos assim que ficar mais preciso.', 'info');
  } else {
    showToast('Procurando o sinal do GPS... centralizamos assim que ele chegar.', 'info');
  }
}

// Compatibilidade com chamadas antigas
function refreshUserLocation() {
  centerOnMe();
}

function forceGpsScan() {
  localStorage.removeItem(STORAGE_COORDS_KEY);
  detectAndApplyUserLocation(true);
  showToast('Buscando sua posição por GPS...', 'info');
}

function retryLiveGps() {
  hideGpsAlert();
  liveGpsFollow = true;
  liveGpsCenterOnNextFix = true;
  if (startLiveGpsTracking()) {
    showToast('Solicitando acesso ao GPS...', 'info');
  }
}

const GPS_STATUS_LABELS = {
  idle: 'GPS desligado',
  waiting: 'procurando sinal do GPS…',
  tracking: 'GPS em tempo real ativo',
  manual: 'posição fixada manualmente (toque para voltar ao GPS)',
  paused: 'GPS pausado (app em segundo plano)',
  denied: 'permissão de localização negada',
  insecure: 'GPS bloqueado (o site precisa de HTTPS)',
  unsupported: 'aparelho sem localização'
};

function updateGpsStatusIndicator(state) {
  const effective = (state === 'tracking' || state === 'waiting') && !liveGpsFollow ? 'manual' : state;
  const dot = document.getElementById('gps-status-dot');
  if (dot) dot.dataset.state = effective;
  const btn = document.getElementById('btn-center-me');
  if (btn) btn.title = 'Centralizar em mim — ' + (GPS_STATUS_LABELS[effective] || '');
}

// Alerta amigável (fica na tela até o usuário agir) para permissão negada / sem HTTPS / sem GPS
function getGpsAlertContent(kind) {
  const fallbackTip = 'Enquanto isso, você pode usar o mapa normalmente, buscar por CEP ou marcar sua rua manualmente.';
  if (kind === 'insecure') {
    return {
      title: 'GPS bloqueado nesta conexão',
      text: 'Por segurança, o navegador só libera a localização em sites com HTTPS (ou em localhost). Abra o CuidAção pelo endereço publicado com https://. ' + fallbackTip,
      retry: false
    };
  }
  if (kind === 'unsupported') {
    return {
      title: 'Localização indisponível neste aparelho',
      text: 'Seu aparelho ou navegador não oferece acesso ao GPS. ' + fallbackTip,
      retry: false
    };
  }
  const howTo = IS_NATIVE_APP
    ? 'Para liberar, abra Configurações do celular › Apps › CuidAção › Permissões › Localização › Permitir'
    : 'Para liberar, toque no cadeado 🔒 ao lado do endereço do site › Permissões › Localização › Permitir';
  return {
    title: 'Permita o acesso à sua localização',
    text: 'Sem essa permissão não conseguimos mostrar sua posição em tempo real nem as unidades de saúde mais perto de você. ' +
      howTo + ' e depois toque em "Tentar novamente". ' + fallbackTip,
    retry: true
  };
}

function showGpsAlert(kind) {
  const content = getGpsAlertContent(kind);
  const el = document.getElementById('gps-alert');
  if (!el) {
    showToast(content.title + '. ' + content.text, 'error');
    return;
  }
  document.getElementById('gps-alert-title').textContent = content.title;
  document.getElementById('gps-alert-text').textContent = content.text;
  const retryBtn = document.getElementById('gps-alert-retry');
  if (retryBtn) retryBtn.classList.toggle('hidden', !content.retry);
  el.classList.remove('hidden');
}

function hideGpsAlert() {
  const el = document.getElementById('gps-alert');
  if (el) el.classList.add('hidden');
}

function openLocationSearchFromGpsAlert() {
  hideGpsAlert();
  openLocationModal();
}

// ============================================================================
// CAMADA UNIFICADA DE FARMÁCIAS E FARMÁCIA POPULAR (cat-3 em locations)
// ============================================================================
function togglePharmacyLayer() {
  if (!map) return;
  pharmaciesVisible = !pharmaciesVisible;
  try { localStorage.setItem(STORAGE_PHARMACY_LAYER_KEY, pharmaciesVisible ? '1' : '0'); } catch { /* ignora */ }
  updatePharmacyToggleButton();
  loadLocations();
  showToast(
    pharmaciesVisible
      ? 'Farmácias exibidas no mapa (selo FP = Farmácia Popular).'
      : 'Farmácias ocultadas do mapa.',
    'info'
  );
}

function updatePharmacyToggleButton() {
  const btn = document.getElementById('btn-toggle-pharmacies');
  if (!btn) return;
  const active = pharmaciesVisible && currentFilter !== 'environment' && currentFilter !== 'animal';
  btn.setAttribute('aria-pressed', String(active));
  btn.classList.toggle('is-active', active);
  btn.title = active ? 'Ocultar farmácias do mapa' : 'Mostrar farmácias no mapa';
}

function updateHeatmapLayerFromReports() {
  if (!map || typeof L === 'undefined' || typeof L.heatLayer !== 'function') return;
  if (heatmapLayer && map.hasLayer(heatmapLayer)) {
    map.removeLayer(heatmapLayer);
  }
  if (!heatmapVisible) return;

  const heatPoints = cachedReports
    .filter(r =>
      r.status !== 'resolved' &&
      r.status !== 'rejected' &&
      r.lat !== null &&
      r.lng !== null &&
      Number.isFinite(Number(r.lat)) &&
      Number.isFinite(Number(r.lng))
    )
    .map(r => {
      const intensity = Math.min(1, 0.45 + (Number(r.urgency || 3) * 0.08) + (Math.min(5, Number(r.confirmations || 0)) * 0.05));
      return [Number(r.lat), Number(r.lng), intensity];
    });

  heatmapLayer = L.heatLayer(heatPoints, {
    radius: 32,
    blur: 22,
    maxZoom: 17,
    gradient: { 0.3: '#fde047', 0.65: '#f97316', 1.0: '#dc2626' }
  }).addTo(map);
}

function toggleHeatmapLayer() {
  if (!map || typeof L.heatLayer !== 'function') {
    showToast('Camada de Mapa de Calor indisponível.', 'error');
    return;
  }
  heatmapVisible = !heatmapVisible;
  const btn = document.getElementById('btn-toggle-heatmap');
  if (btn) {
    btn.setAttribute('aria-pressed', String(heatmapVisible));
    btn.classList.toggle('is-active', heatmapVisible);
  }
  updateHeatmapLayerFromReports();
  showToast(
    heatmapVisible
      ? 'Mapa de Calor de focos de dengue/resíduos ativado!'
      : 'Mapa de Calor desativado.',
    'info'
  );
}

// ============================================================================
// MODO DE CALIBRAÇÃO DIRETA POR CLIQUE NO MAPA E BUSCA VIA-CEP
// ============================================================================
function togglePickLocationMode() {
  if (pickLocationMode) {
    cancelPickLocationMode();
  } else {
    startPickLocationMode();
  }
}

function startPickLocationMode() {
  pickLocationMode = 'user';
  document.getElementById('map').classList.add('pick-location-mode');
  const btn = document.getElementById('btn-pick-map');
  if (btn) {
    btn.className = 'px-2.5 py-1 bg-blue-600 text-white border border-blue-700 rounded-xl text-[11px] font-bold transition flex items-center gap-1 shadow-md';
    btn.innerHTML = '🎯 <span>Clique na sua Rua...</span>';
  }
  const banner = document.getElementById('calibration-banner');
  const textEl = document.getElementById('calibration-banner-text');
  const cepBtn = document.getElementById('calibration-cep-btn');
  if (cepBtn) cepBtn.classList.remove('hidden');
  if (banner && textEl) {
    textEl.innerText = '🎯 Clique exatamente sobre a sua casa/rua no Perequê ou em qualquer bairro do Guarujá para cravar o pino azul';
    banner.classList.remove('hidden');
  }
}

function cancelPickLocationMode() {
  const wasReportMode = pickLocationMode === 'report';
  pickLocationMode = false;
  document.getElementById('map').classList.remove('pick-location-mode');
  const btn = document.getElementById('btn-pick-map');
  if (btn) {
    btn.className = 'px-2.5 py-1 bg-blue-50 hover:bg-blue-100 text-blue-700 border border-blue-200 rounded-xl text-[11px] font-bold transition flex items-center gap-1 active:scale-95';
    btn.innerHTML = '📌 <span class="hidden xl:inline">Cravar no Mapa</span>';
  }
  const banner = document.getElementById('calibration-banner');
  if (banner) banner.classList.add('hidden');

  if (wasReportMode) {
    document.getElementById('modal-report').classList.remove('hidden');
  }
}

function openLocationModal() {
  document.getElementById('modal-location').classList.remove('hidden');
  const input = document.getElementById('geo-search-input');
  const numInput = document.getElementById('geo-search-number');
  if (input) {
    input.value = '';
    input.focus();
  }
  if (numInput) numInput.value = '';
  runGeoSearch('');
}

function closeLocationModal() {
  document.getElementById('modal-location').classList.add('hidden');
}

let geoSearchDebounce = null;
function handleGeoSearchInput() {
  clearTimeout(geoSearchDebounce);
  geoSearchDebounce = setTimeout(() => {
    runGeoSearch();
  }, 260);
}

async function runGeoSearch(overrideQuery) {
  const container = document.getElementById('geo-search-results');
  if (!container) return;

  const inputEl = document.getElementById('geo-search-input');
  const numEl = document.getElementById('geo-search-number');
  const queryStr = typeof overrideQuery === 'string' ? overrideQuery : (inputEl ? inputEl.value.trim() : '');
  const houseNum = numEl ? numEl.value.trim() : '';

  container.innerHTML = '<p class="text-xs text-gray-400 py-2">Buscando no Perequê e em todo o Guarujá...</p>';

  // Busca local instantânea combinada com API
  const qLower = (queryStr || '').toLowerCase();
  const localMatches = GUARUJA_ALL_NEIGHBORHOODS
    .filter(nb => !qLower || nb.name.toLowerCase().includes(qLower))
    .map(nb => ({
      displayName: nb.name + ' - Guarujá/SP',
      lat: nb.lat,
      lng: nb.lng,
      source: nb.highlight ? 'Perequê' : 'Bairro'
    }));

  try {
    const res = await fetch(
      API_BASE + '/api/v1/geo/search?q=' + encodeURIComponent(queryStr || '') + '&num=' + encodeURIComponent(houseNum || '')
    );
    const data = await res.json();
    const apiList = data.results || [];

    const combined = [...localMatches];
    apiList.forEach(item => {
      if (!combined.some(c => haversineMeters(c.lat, c.lng, item.lat, item.lng) < 50)) {
        combined.push(item);
      }
    });

    if (combined.length === 0) {
      container.innerHTML = '<p class="text-xs text-gray-400 py-2">Nenhum endereço encontrado. Digite um CEP (ex: 11446-000) ou selecione um bairro abaixo.</p>';
      return;
    }

    container.innerHTML = '';
    combined.slice(0, 12).forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'w-full text-left p-2 rounded-xl hover:bg-emerald-50 border border-transparent hover:border-emerald-200 transition flex items-center justify-between gap-2 text-xs';
      const badgeText = item.source === 'viacep' ? 'CEP Exato' : (item.source === 'Perequê' ? '⭐ Perequê' : 'Selecionar');
      btn.innerHTML =
        '<span class="font-semibold text-gray-800 truncate">📍 ' + escapeHtml(item.displayName) + '</span>' +
        '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded shrink-0">' + badgeText + '</span>';
      btn.onclick = () => {
        selectPreciseLocation(item.lat, item.lng, item.displayName);
      };
      container.appendChild(btn);
    });
  } catch {
    container.innerHTML = '';
    localMatches.slice(0, 10).forEach(item => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'w-full text-left p-2 rounded-xl hover:bg-emerald-50 border border-transparent hover:border-emerald-200 transition flex items-center justify-between gap-2 text-xs';
      btn.innerHTML =
        '<span class="font-semibold text-gray-800 truncate">📍 ' + escapeHtml(item.displayName) + '</span>' +
        '<span class="text-[10px] font-bold text-emerald-700 bg-emerald-100 px-2 py-0.5 rounded shrink-0">Bairro</span>';
      btn.onclick = () => {
        selectPreciseLocation(item.lat, item.lng, item.displayName);
      };
      container.appendChild(btn);
    });
  }
}

async function selectPreciseLocation(lat, lng, label) {
  closeLocationModal();
  cancelPickLocationMode();
  if (label) currentAddressLabel = label;
  saveManualCoordinates(lat, lng, label);
  await applyUserCoordinates(lat, lng, label || 'Posição Exata (100%)', 5, true);
  showToast('Localização definida em: ' + (label || 'Coordenada selecionada'), 'success');
}

// ============================================================================
// 3. CRIAR MARCADORES VETORIAIS COM ANCORAGEM EXATA NO PIXEL DA COORDENADA
// ============================================================================
function createInteractiveMarker(color, iconType, labelText, badgeText = '') {
  const svgIcon = SVG_ICONS[iconType] || SVG_ICONS.clinic;
  const badgeHtml = badgeText
    ? '<span class="pin-fp-badge" title="Participante do Programa Farmácia Popular">' + escapeHtml(badgeText) + '</span>'
    : '';
  
  const html = 
    '<div class="pin-badge-wrapper">' +
      '<div class="pin-tag px-2.5 py-0.5 rounded-full text-[10px] font-black whitespace-nowrap max-w-[155px] truncate text-center">' +
        escapeHtml(labelText) +
      '</div>' +
      '<div class="relative w-10 h-10 rounded-2xl flex items-center justify-center shadow-lg border-2 border-white ring-2 ring-black/20 shrink-0" style="background-color: ' + color + ';">' +
        svgIcon +
        badgeHtml +
      '</div>' +
      '<div class="w-3 h-3 rotate-45 -mt-1.5 border-r-2 border-b-2 border-white shadow-sm shrink-0" style="background-color: ' + color + ';"></div>' +
    '</div>';

  return L.divIcon({
    className: '',
    html: html,
    iconSize: [44, 48],
    iconAnchor: [22, 48],
    popupAnchor: [0, -48]
  });
}

// 4. Calcular Status de Funcionamento em Tempo Real
function evaluateBusinessHours(hoursMap) {
  if (!hoursMap) return { open: false, text: 'Horário sob consulta' };
  const now = new Date();
  const day = now.getDay().toString();
  const sched = hoursMap[day];

  if (!sched) return { open: false, text: 'Fechado hoje' };

  if (sched.open === '00:00' && sched.close === '23:59') {
    return { open: true, text: 'Aberto 24 horas' };
  }

  const current = ('0' + now.getHours()).slice(-2) + ':' + ('0' + now.getMinutes()).slice(-2);
  if (current >= sched.open && current <= sched.close) {
    return { open: true, text: 'Aberto agora • Fecha às ' + sched.close };
  }
  return { open: false, text: 'Fechado • Abre às ' + sched.open };
}

// ============================================================================
// 5. CARREGAR LOCAIS E ALERTAS DE TODO O GUARUJÁ (INCLUINDO PEREQUÊ E ENTORNO)
// ============================================================================
async function loadLocations() {
  if (locationsAbortController) {
    locationsAbortController.abort();
  }
  const controller = new AbortController();
  locationsAbortController = controller;
  const reqSeq = ++locationsReqSeq;

  let apiLocations = [];
  let apiSucceeded = false;
  try {
    const url = '/api/v1/locations?lat=' + userCoords.lat + 
                '&lng=' + userCoords.lng + 
                '&radius=' + currentRadius + 
                '&domain=' + currentFilter + 
                '&category=' + currentCategory +
                (onlyPopularPharmacy ? '&popular_only=1' : '') +
                (onlyOpenNow ? '&open_now=1' : '') +
                '&search=' + encodeURIComponent(currentSearch);
                
    const res = await apiFetch(url, { signal: controller.signal });
    if (reqSeq !== locationsReqSeq) return;
    if (res.ok) {
      const json = await res.json();
      apiLocations = json.data || [];
      apiSucceeded = true;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    console.warn('Usando base integrada offline do Guarujá/Perequê:', err);
  }

  if (reqSeq !== locationsReqSeq) return;

  // Se a API respondeu com sucesso, usa os dados oficiais do servidor; fallback local apenas offline
  const mergedMap = new Map();
  if (apiSucceeded) {
    apiLocations.forEach(loc => mergedMap.set(loc.id, loc));
  } else {
    GUARUJA_BUILTIN_LOCATIONS.forEach(loc => {
      mergedMap.set(loc.id, normalizeLocationRatings(loc));
    });
  }

  const searchLower = (currentSearch || '').toLowerCase().trim();
  let allList = Array.from(mergedMap.values()).map(loc => {
    const dist = haversineMeters(userCoords.lat, userCoords.lng, loc.lat, loc.lng);
    return { ...loc, distance_meters: dist };
  });

  if (currentFilter && currentFilter !== 'all') {
    allList = allList.filter(l => l.domain === currentFilter);
  }

  if (currentCategory && currentCategory !== 'all') {
    allList = allList.filter(l => l.categoryId === currentCategory);
  }

  if (onlyPopularPharmacy) {
    allList = allList.filter(l => l.categoryId === 'cat-3' && l.has_popular_pharmacy !== false);
  }

  if (onlyOpenNow) {
    allList = allList.filter(l => evaluateBusinessHours(l.opening_hours).open);
  }

  if (!pharmaciesVisible && currentCategory !== 'cat-3') {
    allList = allList.filter(l => l.categoryId !== 'cat-3' && l.categoryId !== 'farmacia');
  }

  if (searchLower) {
    allList = allList.filter(l =>
      l.name.toLowerCase().includes(searchLower) ||
      l.address.toLowerCase().includes(searchLower) ||
      (l.services || []).some(s => s.toLowerCase().includes(searchLower))
    );
  }

  allList = allList.filter(l => l.distance_meters <= currentRadius);
  allList.sort((a, b) => a.distance_meters - b.distance_meters);

  cachedLocations = allList;
  updatePharmacyToggleButton();
  locationsGroup.clearLayers();

  cachedLocations.forEach(loc => {
    let iconType = loc.iconType || 'clinic';
    if (!loc.iconType) {
      if (loc.categoryId === 'cat-2' || loc.categoryId === 'upa') iconType = 'hospital';
      else if (loc.categoryId === 'cat-3' || loc.categoryId === 'farmacia') iconType = 'pill';
      else if (loc.categoryId === 'cat-4' || loc.categoryId === 'ecoponto') iconType = 'recycle';
      else if (loc.categoryId === 'cat-5' || loc.categoryId === 'parque') iconType = 'tree';
      else if (loc.categoryId === 'cat-6' || loc.categoryId === 'zoonoses') iconType = 'paw';
    }

    const isPharmacy = loc.categoryId === 'cat-3' || loc.categoryId === 'farmacia';
    const isPopularPharmacy = isPharmacy && (loc.has_popular_pharmacy !== false);
    const badgeText = isPopularPharmacy ? 'FP' : '';

    const shortName = loc.name.split('(')[0].replace('Centro Municipal de Saúde', 'CMS').replace('Hospital', 'Hosp.').trim();

    const marker = L.marker([loc.lat, loc.lng], {
      icon: createInteractiveMarker(loc.color, iconType, shortName, badgeText)
    });

    const status = evaluateBusinessHours(loc.opening_hours);
    const distanceStr = loc.distance_meters >= 1000 ? (loc.distance_meters / 1000).toFixed(2) + ' km' : loc.distance_meters + ' m';
    const safeId = escapeHtml(loc.id);
    const scoreBadgeHtml = loc.total_reviews > 0
      ? '<span>Nota: <b class="text-yellow-600">⭐ ' + loc.overall_score + '</b> <span class="text-gray-400">(' + loc.total_reviews + ')</span></span>'
      : '<span class="text-gray-400">Sem avaliações ainda</span>';
    const fpPopupBadge = isPharmacy
      ? (isPopularPharmacy
          ? '<p class="text-[11px] font-extrabold text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-2 py-1 mb-2">✔ selo FP • Participante do Programa Farmácia Popular</p>'
          : '<p class="text-[11px] font-semibold text-gray-600 bg-gray-100 border border-gray-200 rounded-lg px-2 py-1 mb-2">Farmácia Comunitária / Rede Privada</p>')
      : '';

    const popupContent = 
      '<div class="p-1 min-w-[250px] max-w-[290px]">' +
        '<div class="flex items-center justify-between gap-1 mb-1.5">' +
          '<span class="px-2 py-0.5 rounded text-[10px] font-extrabold uppercase text-white" style="background-color: ' + loc.color + '">' + escapeHtml(loc.categoryName) + '</span>' +
          '<span class="text-[11px] font-bold ' + (status.open ? 'text-emerald-600' : 'text-red-600') + '">' + (status.open ? 'Aberto agora' : 'Fechado') + '</span>' +
        '</div>' +
        '<h3 class="font-black text-sm text-gray-900 leading-snug mb-1">' + escapeHtml(loc.name) + '</h3>' +
        fpPopupBadge +
        '<div class="p-2 bg-gray-50 rounded-xl border border-gray-100 my-2">' +
          '<p class="text-[10px] font-bold uppercase text-gray-400">Localização Exata</p>' +
          '<p class="text-xs text-gray-700 font-medium leading-tight mt-0.5">📍 ' + escapeHtml(loc.address) + '</p>' +
        '</div>' +
        '<div class="flex items-center justify-between text-xs text-gray-500 mb-2.5 px-0.5">' +
          '<span>Distância: <b class="text-emerald-700">' + distanceStr + '</b></span>' +
          scoreBadgeHtml +
        '</div>' +
        '<div class="flex gap-2 pt-1 border-t border-gray-100">' +
          '<button onclick="openSidebarById(\'' + safeId + '\')" class="flex-1 bg-gray-900 hover:bg-black text-white text-xs py-2 px-2.5 rounded-xl font-bold transition">' +
            'Ver Detalhes & Notas' +
          '</button>' +
          '<a href="https://www.google.com/maps/dir/?api=1&origin=' + userCoords.lat + ',' + userCoords.lng + '&destination=' + loc.lat + ',' + loc.lng + '" target="_blank" rel="noopener noreferrer" class="bg-blue-600 hover:bg-blue-700 text-white text-xs py-2 px-3 rounded-xl font-bold transition flex items-center justify-center" title="Traçar rota a partir da sua posição">' +
            '🗺️ Rota' +
          '</a>' +
        '</div>' +
      '</div>';

    marker.bindPopup(popupContent);

    marker.on('click', () => {
      map.panTo([loc.lat, loc.lng]);
    });

    locationsGroup.addLayer(marker);
  });
}

const OFFLINE_FALLBACK_REPORTS = [
  {
    id: 'rep-pereque-1',
    title: 'Monitoramento Preventivo de Dengue e Limpeza de Vala',
    report_type: 'foco_dengue',
    description: 'Ponto de atenção para escoamento de água de chuva próximo à margem da Estrada Guarujá-Bertioga no Perequê.',
    address: 'Estrada Guarujá-Bertioga, próx. ao km 7 - Perequê, Guarujá - SP',
    lat: -23.93710,
    lng: -46.18360
  }
];

const REPORT_STATUS_UI = {
  pending: { pinColor: '#D97706', pinLabel: '⚠️ Alerta', badgeBg: 'bg-amber-100 text-amber-800', text: 'Em aberto' },
  in_analysis: { pinColor: '#2563EB', pinLabel: '🔎 Em análise', badgeBg: 'bg-blue-100 text-blue-800', text: 'Em análise' },
  resolved: { pinColor: '#059669', pinLabel: '✅ Resolvido', badgeBg: 'bg-emerald-100 text-emerald-800', text: 'Resolvido' },
  rejected: { pinColor: '#6B7280', pinLabel: 'Arquivado', badgeBg: 'bg-gray-100 text-gray-600', text: 'Arquivado' }
};

async function confirmReportFromMap(reportId) {
  if (!authToken || !currentUser) {
    showToast('Faça login para confirmar que você também viu este foco.', 'info');
    openLoginModal();
    return;
  }
  try {
    const res = await apiFetch('/api/v1/reports/' + encodeURIComponent(reportId) + '/confirm', {
      method: 'POST',
      auth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    });
    if (res.status === 401) return;
    const json = await res.json();
    if (res.ok) {
      showToast(json.message || 'Confirmação comunitária registrada!', 'success');
      loadReports();
      if (communityFeedController) communityFeedController.reload();
    } else {
      showToast(json.error || 'Você já confirmou este alerta.', 'info');
    }
  } catch {
    showToast('Sem conexão para confirmar o alerta agora.', 'error');
  }
}

async function changeReportStatusFromMap(reportId, nextStatus) {
  if (!authToken || !currentUser) return;
  try {
    const res = await apiFetch('/api/v1/reports/' + encodeURIComponent(reportId) + '/status', {
      method: 'PATCH',
      auth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: nextStatus })
    });
    if (res.status === 401) return;
    const json = await res.json();
    if (res.ok) {
      showToast('Status do alerta atualizado!', 'success');
      loadReports();
      if (communityFeedController) communityFeedController.reload();
    } else {
      showToast(json.error || 'Sem permissão para alterar status.', 'error');
    }
  } catch {
    showToast('Erro de conexão ao atualizar status.', 'error');
  }
}

function renderReportsMarkers(list) {
  cachedReports = Array.isArray(list) ? list : [];
  reportsGroup.clearLayers();

  const canModerate = !!(currentUser && (currentUser.role === 'agent' || currentUser.role === 'admin'));

  cachedReports.forEach(rep => {
    if (rep.lat === null || rep.lng === null || !Number.isFinite(Number(rep.lat)) || !Number.isFinite(Number(rep.lng))) return;
    if (rep.status === 'rejected') return;

    const stMeta = REPORT_STATUS_UI[rep.status] || REPORT_STATUS_UI.pending;
    const confirmations = Number(rep.confirmations) || 0;
    const safeRepId = escapeHtml(rep.id);

    const marker = L.marker([Number(rep.lat), Number(rep.lng)], {
      icon: createInteractiveMarker(stMeta.pinColor, 'alert', stMeta.pinLabel)
    });

    let nearestHtml = '';
    if (rep.nearest_ubs || rep.nearest_ecoponto) {
      nearestHtml = '<div class="mt-2 p-2 rounded-lg bg-emerald-50/80 border border-emerald-200 text-[11px] text-gray-700 space-y-0.5">' +
        (rep.nearest_ubs ? '<p>🏥 <b>UBS/USAFA próx.:</b> ' + escapeHtml(rep.nearest_ubs.name) + ' (' + rep.nearest_ubs.distance_meters + ' m)</p>' : '') +
        (rep.nearest_ecoponto ? '<p>♻️ <b>Ecoponto próx.:</b> ' + escapeHtml(rep.nearest_ecoponto.name) + ' (' + rep.nearest_ecoponto.distance_meters + ' m)</p>' : '') +
      '</div>';
    }

    const confirmBtnHtml = rep.status !== 'resolved'
      ? '<button type="button" onclick="confirmReportFromMap(\'' + safeRepId + '\')" class="mt-2 w-full py-1.5 px-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold transition">' +
          '👁️ Eu também vi este foco (' + confirmations + ')' +
        '</button>'
      : '<p class="mt-2 text-[11px] font-bold text-emerald-700">✔ Alerta solucionado (' + confirmations + ' confirmações)</p>';

    const modHtml = canModerate
      ? '<div class="mt-2 pt-2 border-t border-gray-100">' +
          '<label class="text-[10px] font-bold uppercase text-gray-400">Moderação Agente/Admin</label>' +
          '<select onchange="changeReportStatusFromMap(\'' + safeRepId + '\', this.value)" class="mt-1 w-full p-1.5 text-xs border border-gray-300 rounded-lg bg-white font-semibold">' +
            '<option value="pending"' + (rep.status === 'pending' ? ' selected' : '') + '>Em aberto</option>' +
            '<option value="in_analysis"' + (rep.status === 'in_analysis' ? ' selected' : '') + '>Em análise</option>' +
            '<option value="resolved"' + (rep.status === 'resolved' ? ' selected' : '') + '>Resolvido</option>' +
            '<option value="rejected"' + (rep.status === 'rejected' ? ' selected' : '') + '>Arquivar / Rejeitar</option>' +
          '</select>' +
        '</div>'
      : '';

    const popupContent = 
      '<div class="p-1 min-w-[245px] max-w-[295px]">' +
        '<div class="flex items-center justify-between gap-1">' +
          '<span class="bg-amber-100 text-amber-800 text-[10px] font-extrabold px-2 py-0.5 rounded uppercase">Alerta One Health</span>' +
          '<span class="text-[10px] font-extrabold px-2 py-0.5 rounded ' + stMeta.badgeBg + '">' + escapeHtml(stMeta.text) + '</span>' +
        '</div>' +
        '<h4 class="font-bold text-sm text-gray-900 mt-1.5">' + escapeHtml(rep.title) + '</h4>' +
        '<p class="text-xs text-gray-600 mt-1 font-medium">📍 ' + escapeHtml(rep.address || 'Localização no mapa') + '</p>' +
        '<p class="text-xs text-gray-500 mt-1 bg-amber-50 p-2 rounded-lg border border-amber-100">' + escapeHtml(rep.description) + '</p>' +
        nearestHtml +
        confirmBtnHtml +
        modHtml +
      '</div>';

    marker.bindPopup(popupContent);
    marker.on('click', () => {
      map.panTo([Number(rep.lat), Number(rep.lng)]);
    });
    reportsGroup.addLayer(marker);
  });

  updateHeatmapLayerFromReports();
}

async function loadReports() {
  if (reportsAbortController) {
    reportsAbortController.abort();
  }
  const controller = new AbortController();
  reportsAbortController = controller;
  const reqSeq = ++reportsReqSeq;

  try {
    const res = await apiFetch('/api/v1/reports', { signal: controller.signal });
    if (reqSeq !== reportsReqSeq) return;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const json = await res.json();
    if (reqSeq !== reportsReqSeq) return;
    // Renderiza exatamente os alertas retornados pela API (sem re-injetar rep-pereque-1 se removido/resolvido)
    renderReportsMarkers(json.data || []);
  } catch (err) {
    if (err && err.name === 'AbortError') return;
    if (reqSeq !== reportsReqSeq) return;
    console.warn('Usando alertas offline de contingência:', err);
    renderReportsMarkers(OFFLINE_FALLBACK_REPORTS);
  }
}

// Deriva nota e contagem das avaliações reais (reviews[]). Usado no dataset embutido de fallback.
function normalizeLocationRatings(loc) {
  const copy = Object.assign({}, loc);
  const reviews = Array.isArray(copy.reviews) ? copy.reviews : [];
  const n = reviews.length;
  const avg = function (key) {
    return n ? Math.round(reviews.reduce(function (acc, r) { return acc + (Number(r[key]) || 0); }, 0) / n * 10) / 10 : 0;
  };
  copy.total_reviews = n;
  copy.avg_wait_time = avg('wait');
  copy.avg_accessibility = avg('access');
  copy.avg_humanized_care = avg('care');
  copy.overall_score = n ? Math.round((copy.avg_wait_time + copy.avg_accessibility + copy.avg_humanized_care) / 3 * 10) / 10 : 0;
  return copy;
}

function openSidebarById(id) {
  const found = cachedLocations.find(l => l.id === id);
  if (found) openSidebar(found);
}

function openSidebar(loc) {
  closeCommunityBar();
  selectedLocation = loc;
  document.getElementById('side-title').innerText = loc.name;
  document.getElementById('side-address').innerText = loc.address;
  document.getElementById('side-category').innerText = loc.categoryName;
  document.getElementById('side-category').style.backgroundColor = loc.color;

  const status = evaluateBusinessHours(loc.opening_hours);
  const statusEl = document.getElementById('side-status');
  statusEl.innerText = status.text;
  statusEl.className = 'text-xs font-bold px-2.5 py-1 rounded-md border ' + 
    (status.open ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-red-50 text-red-700 border-red-200');

  const distMeters = typeof loc.distance_meters === 'number'
    ? loc.distance_meters
    : haversineMeters(userCoords.lat, userCoords.lng, loc.lat, loc.lng);

  document.getElementById('side-distance').innerText = '📍 ' + (distMeters >= 1000 ? (distMeters / 1000).toFixed(2) + ' km de você' : distMeters + ' m de você');
  document.getElementById('side-gmaps-link').href = 'https://www.google.com/maps/dir/?api=1&origin=' + userCoords.lat + ',' + userCoords.lng + '&destination=' + loc.lat + ',' + loc.lng;

  const sContainer = document.getElementById('side-services');
  sContainer.innerHTML = '';
  (loc.services || []).forEach(s => {
    sContainer.innerHTML += '<span class="text-xs bg-gray-100 text-gray-800 px-2.5 py-1 rounded-lg border border-gray-200 font-medium">✓ ' + escapeHtml(s) + '</span>';
  });

  renderWeeklyHoursGrid(loc.opening_hours);

  const unlockedMetricsEl = document.getElementById('side-metrics-unlocked');
  if (unlockedMetricsEl) unlockedMetricsEl.classList.remove('hidden');

  const hasReviews = loc.total_reviews > 0;
  document.getElementById('side-score').innerText = hasReviews ? '⭐ ' + loc.overall_score + ' / 5.0' : 'Sem avaliações ainda';
  document.getElementById('metric-access').innerText = hasReviews ? loc.avg_accessibility : '—';
  document.getElementById('bar-access').style.width = (loc.avg_accessibility / 5 * 100) + '%';
  document.getElementById('metric-wait').innerText = hasReviews ? loc.avg_wait_time : '—';
  document.getElementById('bar-wait').style.width = (loc.avg_wait_time / 5 * 100) + '%';
  document.getElementById('metric-care').innerText = hasReviews ? loc.avg_humanized_care : '—';
  document.getElementById('bar-care').style.width = (loc.avg_humanized_care / 5 * 100) + '%';
  document.getElementById('side-total-reviews').innerText = hasReviews
    ? loc.total_reviews + (loc.total_reviews === 1 ? ' avaliação registrada' : ' avaliações registradas')
    : 'Seja a primeira pessoa a avaliar este local';

  const revContainer = document.getElementById('side-reviews');
  revContainer.innerHTML = '';
  if (loc.reviews && loc.reviews.length > 0) {
    loc.reviews.forEach(r => {
      revContainer.innerHTML += 
        '<div class="p-2.5 bg-gray-50 rounded-xl text-xs border border-gray-100">' +
          '<div class="flex justify-between font-bold text-gray-800">' +
            '<span>' + escapeHtml(r.userName) + '</span>' +
            '<span class="text-[10px] text-gray-400 font-normal">' + escapeHtml(r.date) + '</span>' +
          '</div>' +
          '<p class="text-gray-600 mt-1">' + escapeHtml(r.comment) + '</p>' +
        '</div>';
    });
  } else {
    revContainer.innerHTML = '<p class="text-xs text-gray-400 italic">Nenhum comentário por escrito ainda.</p>';
  }

  const isLogged = !!(currentUser && authToken);
  const unlockedActionEl = document.getElementById('side-action-unlocked');
  const lockedActionEl = document.getElementById('side-action-locked');
  if (isLogged) {
    if (unlockedActionEl) unlockedActionEl.classList.remove('hidden');
    if (lockedActionEl) lockedActionEl.classList.add('hidden');
  } else {
    if (unlockedActionEl) unlockedActionEl.classList.add('hidden');
    if (lockedActionEl) lockedActionEl.classList.remove('hidden');
  }

  const sidebarEl = document.getElementById('sidebar');
  sidebarEl.classList.remove('hidden');
  sidebarEl.classList.add('flex');
}

function closeSidebar() {
  const sidebarEl = document.getElementById('sidebar');
  sidebarEl.classList.add('hidden');
  sidebarEl.classList.remove('flex');
  selectedLocation = null;
}

const WEEKDAY_NAMES = ['Domingo', 'Segunda-feira', 'Terça-feira', 'Quarta-feira', 'Quinta-feira', 'Sexta-feira', 'Sábado'];

function renderWeeklyHoursGrid(hoursMap) {
  const container = document.getElementById('side-weekly-hours');
  if (!container) return;
  const todayIdx = new Date().getDay();
  let html = '';
  for (let d = 0; d < 7; d++) {
    const sched = hoursMap && hoursMap[String(d)];
    const isToday = d === todayIdx;
    let hoursLabel = 'Fechado';
    if (sched) {
      hoursLabel = (sched.open === '00:00' && sched.close === '23:59')
        ? '24 horas'
        : (sched.open + ' às ' + sched.close);
    }
    const rowCls = isToday
      ? 'bg-emerald-50 border-emerald-300 text-emerald-950 font-bold'
      : 'bg-gray-50 border-gray-100 text-gray-600';
    html +=
      '<div class="flex items-center justify-between px-2.5 py-1 rounded-lg border ' + rowCls + '">' +
        '<span>' + WEEKDAY_NAMES[d] + (isToday ? ' (Hoje)' : '') + '</span>' +
        '<span>' + escapeHtml(hoursLabel) + '</span>' +
      '</div>';
  }
  container.innerHTML = html;
}

function updateFilterButtonsUI() {
  document.querySelectorAll('.filter-tab').forEach(b => {
    b.className = 'filter-tab px-2.5 py-1.5 rounded-xl text-xs font-bold text-gray-700 hover:bg-gray-100 transition';
  });
  const mapDomainBtn = {
    all: 'btn-filter-all',
    health: 'btn-filter-health',
    animal: 'btn-filter-animal',
    environment: 'btn-filter-env'
  };
  const activeDomainBtn = document.getElementById(mapDomainBtn[currentFilter] || 'btn-filter-all');
  if (activeDomainBtn && currentCategory === 'all' && !onlyPopularPharmacy) {
    activeDomainBtn.className = 'filter-tab px-2.5 py-1.5 rounded-xl text-xs font-bold bg-gray-900 text-white transition';
  }

  const activeChipKey = onlyPopularPharmacy ? 'farmacia_popular' : currentCategory;
  document.querySelectorAll('.granular-chip').forEach(chip => {
    const isSelected = chip.getAttribute('data-cat-chip') === activeChipKey;
    chip.className = isSelected
      ? 'granular-chip px-2 py-1 rounded-lg text-[11px] font-bold bg-emerald-600 text-white whitespace-nowrap transition shadow-sm'
      : 'granular-chip px-2 py-1 rounded-lg text-[11px] font-bold bg-gray-100 text-gray-700 hover:bg-emerald-50 hover:text-emerald-800 whitespace-nowrap transition';
  });

  const openNowBtn = document.getElementById('btn-filter-open-now');
  if (openNowBtn) {
    openNowBtn.setAttribute('aria-pressed', String(onlyOpenNow));
    openNowBtn.className = onlyOpenNow
      ? 'px-2 py-1 rounded-lg text-[11px] font-bold bg-emerald-700 text-white whitespace-nowrap transition ml-auto shadow-sm'
      : 'px-2 py-1 rounded-lg text-[11px] font-bold bg-gray-100 text-gray-700 hover:bg-emerald-50 hover:text-emerald-800 whitespace-nowrap transition ml-auto';
  }
}

function setFilter(domain) {
  currentFilter = domain;
  currentCategory = 'all';
  onlyPopularPharmacy = false;
  updateFilterButtonsUI();
  loadLocations();
}

function setCategoryFilter(catKey) {
  const currentKey = onlyPopularPharmacy ? 'farmacia_popular' : currentCategory;
  if (currentKey === catKey) {
    // Clicar novamente limpa o filtro granular e volta para Todos
    currentCategory = 'all';
    onlyPopularPharmacy = false;
    currentFilter = 'all';
  } else if (catKey === 'farmacia_popular') {
    currentFilter = 'health';
    currentCategory = 'cat-3';
    onlyPopularPharmacy = true;
    pharmaciesVisible = true;
  } else {
    onlyPopularPharmacy = false;
    currentCategory = catKey;
    if (catKey === 'cat-1' || catKey === 'cat-2') currentFilter = 'health';
    else if (catKey === 'cat-4' || catKey === 'cat-5') currentFilter = 'environment';
    else if (catKey === 'cat-6') currentFilter = 'animal';
  }
  updateFilterButtonsUI();
  loadLocations();
}

function toggleOpenNowFilter() {
  onlyOpenNow = !onlyOpenNow;
  updateFilterButtonsUI();
  loadLocations();
}

let searchDebounce;
function handleSearch(val) {
  hideCepFeedback();
  clearTimeout(searchDebounce);

  const trimmed = String(val || '').trim();
  // Se o usuário estiver digitando apenas números/traço (CEP), não filtra os pontos do mapa para vazio
  const isTypingCep = /^[\d\s.-]+$/.test(trimmed);
  if (isTypingCep) {
    if (currentSearch !== '') {
      currentSearch = '';
      loadLocations();
    }
    return;
  }

  searchDebounce = setTimeout(() => {
    currentSearch = trimmed;
    loadLocations();
  }, 300);
}

// ============================================================================
// BARRA DE PESQUISA COM BUSCA POR CEP (VIACEP + NOMINATIM OPENSTREETMAP)
// ============================================================================
function showCepFeedback(message, type = 'info') {
  const feedbackEl = document.getElementById('cep-search-feedback');
  if (!feedbackEl) return;

  clearTimeout(cepFeedbackTimer);
  feedbackEl.className = 'cep-feedback-banner is-' + (type || 'info');
  feedbackEl.textContent = message;

  cepFeedbackTimer = setTimeout(() => {
    hideCepFeedback();
  }, 5500);
}

function hideCepFeedback() {
  const feedbackEl = document.getElementById('cep-search-feedback');
  if (feedbackEl) {
    feedbackEl.classList.add('hidden');
  }
}

function renderCepHighlightMarker(lat, lon, addressData) {
  if (!map) return;

  const rua = addressData.logradouro || 'Logradouro geral do CEP';
  const bairro = addressData.bairro || 'Centro / Região Geral';
  const cidadeUf = (addressData.localidade || '') + (addressData.uf ? '/' + addressData.uf : '');
  const cepFormatted = addressData.cep || '';

  const popupHtml =
    '<div class="p-1 min-w-[230px] max-w-[280px] text-xs leading-relaxed">' +
      '<div class="flex items-center justify-between gap-2 mb-1.5">' +
        '<span class="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-extrabold uppercase tracking-wider">📍 CEP Localizado</span>' +
        (cepFormatted ? '<span class="text-[11px] font-bold text-emerald-800 bg-emerald-50 px-1.5 py-0.5 rounded border border-emerald-200">' + escapeHtml(cepFormatted) + '</span>' : '') +
      '</div>' +
      '<p class="text-gray-900 font-black text-sm leading-snug">' + escapeHtml(rua) + '</p>' +
      '<div class="mt-1.5 pt-1.5 border-t border-gray-100 space-y-0.5 text-gray-700">' +
        '<p><b>Bairro:</b> ' + escapeHtml(bairro) + '</p>' +
        '<p><b>Cidade/UF:</b> ' + escapeHtml(cidadeUf) + '</p>' +
      '</div>' +
    '</div>';

  const pinIcon = L.divIcon({
    className: '',
    html:
      '<div class="cep-highlight-pin">' +
        '<div class="w-10 h-10 rounded-2xl bg-emerald-600 flex items-center justify-center shadow-lg border-2 border-white ring-2 ring-emerald-400/50 text-white text-base">' +
          '📍' +
        '</div>' +
        '<div class="w-3 h-3 rotate-45 -mt-1.5 bg-emerald-600 border-r-2 border-b-2 border-white shadow-sm"></div>' +
      '</div>',
    iconSize: [44, 50],
    iconAnchor: [22, 50],
    popupAnchor: [0, -48]
  });

  if (cepHighlightMarker) {
    cepHighlightMarker.setLatLng([lat, lon]);
    cepHighlightMarker.setIcon(pinIcon);
    cepHighlightMarker.setPopupContent(popupHtml);
  } else {
    cepHighlightMarker = L.marker([lat, lon], {
      icon: pinIcon,
      zIndexOffset: 1200
    }).addTo(map);
    cepHighlightMarker.bindPopup(popupHtml);
  }

  cepHighlightMarker.openPopup();
}

async function searchByCep(rawInput) {
  const searchBtn = document.getElementById('btn-cep-search');
  const cep = String(rawInput || '').replace(/\D/g, '');

  if (cep.length !== 8) {
    const msg = 'CEP inválido. Digite um CEP válido com 8 números (ex: 11446-000).';
    showCepFeedback(msg, 'error');
    showToast(msg, 'error');
    return;
  }

  const formattedCep = cep.slice(0, 5) + '-' + cep.slice(5);

  try {
    if (searchBtn) {
      searchBtn.disabled = true;
      searchBtn.innerHTML = '<span>...</span>';
    }
    showCepFeedback('Consultando CEP ' + formattedCep + '...', 'info');

    // Centralizado no backend (/api/v1/geo/search): usa geoCache, fila Nominatim 1,1s e atalho Perequê
    const res = await apiFetch('/api/v1/geo/search?q=' + encodeURIComponent(formattedCep));
    if (!res.ok) {
      throw new Error('Falha ao consultar o serviço de geocodificação.');
    }

    const payload = await res.json();
    const results = Array.isArray(payload.results) ? payload.results : [];

    if (payload.cepNotFound || results.length === 0) {
      const notFoundMsg = 'CEP ' + formattedCep + ' não encontrado. Verifique os números informados e tente novamente.';
      showCepFeedback(notFoundMsg, 'error');
      showToast(notFoundMsg, 'error');
      return;
    }

    const best = results[0];
    const lat = parseFloat(best.lat);
    const lon = parseFloat(best.lng);

    if (isNaN(lat) || isNaN(lon)) {
      throw new Error('Coordenadas retornadas são inválidas.');
    }

    const inCoverage = typeof best.inCoverage === 'boolean' ? best.inCoverage : isInGuarujaCoverage(lat, lon);
    const cityLabel = [best.city || best.localidade, best.uf || best.state].filter(Boolean).join('/');

    if (!inCoverage) {
      const outMsg = 'O CEP ' + formattedCep + (cityLabel ? ' (' + cityLabel + ')' : '') +
        ' fica fora da área de cobertura do CuidAção (Guarujá/SP). O mapa permanece ancorado no Guarujá.';
      showCepFeedback(outMsg, 'error');
      showToast(outMsg, 'error');
      return;
    }

    if (map) {
      map.setView([lat, lon], 16, { animate: true, duration: 0.9 });
    }

    const addressData = {
      logradouro: best.logradouro || best.displayName || 'Logradouro localizado',
      bairro: best.bairro || best.neighborhood || 'Guarujá',
      localidade: best.localidade || best.city || 'Guarujá',
      uf: best.uf || best.state || 'SP',
      cep: best.cep || formattedCep
    };

    renderCepHighlightMarker(lat, lon, addressData);

    const summaryAddress = [addressData.logradouro, addressData.bairro, `${addressData.localidade}/${addressData.uf}`]
      .filter(Boolean)
      .join(' • ');
    showCepFeedback('Localizado: ' + summaryAddress, 'success');
    showToast('CEP localizado: ' + summaryAddress, 'success');
  } catch (err) {
    console.error('Erro na busca por CEP:', err);
    const errMsg = 'Não foi possível buscar o CEP no momento. Verifique sua conexão e tente novamente.';
    showCepFeedback(errMsg, 'error');
    showToast(errMsg, 'error');
  } finally {
    if (searchBtn) {
      searchBtn.disabled = false;
      searchBtn.innerHTML = '<span>Buscar</span>';
    }
  }
}

async function handleCepSearchSubmit() {
  const inputEl = document.getElementById('search-input');
  if (!inputEl) return;
  const rawValue = inputEl.value.trim();
  if (!rawValue) return;

  // Trata como CEP apenas quando corresponde a formato de CEP (ex: 11446-000 ou somente dígitos com traço/ponto)
  const isCepFormat = /^\d{5}-?\d{3}$/.test(rawValue) || /^[\d.\s-]+$/.test(rawValue);
  if (isCepFormat) {
    await searchByCep(rawValue);
    return;
  }

  // Busca textual de unidades (ex: "UPA 24h", "SAMU 192", "USAFA Perequê")
  clearTimeout(searchDebounce);
  currentSearch = rawValue;
  await loadLocations();

  if (cachedLocations.length > 0) {
    const firstLoc = cachedLocations[0];
    if (map && firstLoc) {
      map.setView([firstLoc.lat, firstLoc.lng], 16, { animate: true, duration: 0.9 });
      openSidebar(firstLoc);
    }
  } else {
    const msg = 'Nenhuma unidade encontrada para "' + rawValue + '" no raio selecionado.';
    showCepFeedback(msg, 'info');
    showToast(msg, 'info');
  }
}

function changeRadius(val) {
  currentRadius = parseInt(val, 10);
  loadLocations();
}

async function syncOsmLive() {
  if (!authToken) {
    showToast('Entre na sua conta para buscar novos pontos no OpenStreetMap.', 'info');
    openLoginModal();
    return;
  }
  const btn = document.getElementById('btn-sync-osm');
  btn.innerHTML = '<span class="animate-spin">🌀</span> Buscando...';
  btn.disabled = true;

  try {
    const res = await apiFetch('/api/v1/seed/osm-live', {
      method: 'POST',
      auth: true,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lat: userCoords.lat, lng: userCoords.lng, radius: currentRadius })
    });
    if (res.status === 401) return;
    const data = await res.json();
    showToast(data.message || data.error || 'Sincronização com OpenStreetMap concluída!', res.ok ? 'success' : 'error');
    loadLocations();
  } catch {
    showToast('Erro ao consultar o servidor OpenStreetMap.', 'error');
  } finally {
    btn.innerHTML = '🔄 <span class="hidden sm:inline">Buscar no OSM</span>';
    btn.disabled = false;
  }
}

// ============================================================================
// 6. AUTENTICAÇÃO COM CONTA DO GOOGLE (GOOGLE SIGN-IN / OAUTH 2.0 + SELETOR)
// ============================================================================
function getSavedGoogleAccounts() {
  try {
    const list = JSON.parse(localStorage.getItem(STORAGE_GOOGLE_ACCOUNTS_KEY) || '[]');
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function saveGoogleAccountToDevice(account) {
  try {
    const list = getSavedGoogleAccounts().filter(a => a.email.toLowerCase() !== account.email.toLowerCase());
    list.unshift({
      email: account.email,
      name: account.name,
      picture: account.picture || ''
    });
    localStorage.setItem(STORAGE_GOOGLE_ACCOUNTS_KEY, JSON.stringify(list.slice(0, 5)));
  } catch {
    // Ignora erro de localStorage
  }
}

function startGoogleSignIn() {
  if (IS_NATIVE_APP) {
    showToast('No app, entre com e-mail e senha. O login com Google nativo ainda não está ativado.', 'info');
    openLoginModal();
    return;
  }
  if (!googleClientId && !demoLoginEnabled) {
    showToast('Login com Google não está configurado neste servidor. Use e-mail e senha.', 'info');
    openLoginModal();
    return;
  }
  if (googleClientId && window.google && window.google.accounts && window.google.accounts.oauth2) {
    try {
      const tokenClient = window.google.accounts.oauth2.initTokenClient({
        client_id: googleClientId,
        scope: 'openid email profile',
        callback: async (tokenResponse) => {
          if (tokenResponse && tokenResponse.access_token) {
            await completeGoogleAuthOnServer({ accessToken: tokenResponse.access_token });
          }
        }
      });
      tokenClient.requestAccessToken({ prompt: 'select_account' });
      return;
    } catch (err) {
      console.warn('Fallback para seletor de conta Google:', err);
    }
  }

  openGoogleAccountModal();
}

function openGoogleAccountModal() {
  const modal = document.getElementById('modal-google-account');
  const errEl = document.getElementById('google-modal-error');
  if (errEl) errEl.classList.add('hidden');
  const directForm = document.getElementById('google-direct-form');
  const savedBox = document.getElementById('saved-google-accounts');
  const unavailableMsg = document.getElementById('google-unavailable-msg');
  if (directForm) directForm.classList.toggle('hidden', !demoLoginEnabled);
  if (savedBox) savedBox.classList.toggle('hidden', !demoLoginEnabled);
  if (unavailableMsg) unavailableMsg.classList.toggle('hidden', demoLoginEnabled);

  renderSavedGoogleAccounts();
  if (modal) modal.classList.remove('hidden');

  const emailInput = document.getElementById('google-input-email');
  if (emailInput) emailInput.focus();
}

function closeGoogleAccountModal() {
  const modal = document.getElementById('modal-google-account');
  if (modal) modal.classList.add('hidden');
}

function renderSavedGoogleAccounts() {
  const container = document.getElementById('saved-google-accounts');
  if (!container) return;

  const accounts = getSavedGoogleAccounts();
  if (accounts.length === 0) {
    container.innerHTML = '';
    return;
  }

  container.innerHTML = '<p class="text-[10px] font-bold uppercase tracking-wider text-gray-400 mb-1">Contas Google neste dispositivo</p>';
  accounts.forEach(acc => {
    const initial = (acc.name || acc.email || 'G').trim().charAt(0).toUpperCase();
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'w-full p-2.5 rounded-2xl border border-gray-200 hover:border-blue-300 hover:bg-blue-50/50 transition flex items-center gap-3 text-left';
    btn.innerHTML =
      '<div class="w-9 h-9 rounded-full bg-blue-600 text-white font-black text-sm flex items-center justify-center shrink-0 shadow-sm">' +
        escapeHtml(initial) +
      '</div>' +
      '<div class="flex-1 min-w-0">' +
        '<p class="text-xs font-bold text-gray-900 truncate">' + escapeHtml(acc.name) + '</p>' +
        '<p class="text-[11px] text-gray-500 truncate">' + escapeHtml(acc.email) + '</p>' +
      '</div>' +
      '<span class="text-[10px] font-bold text-blue-600 bg-blue-50 px-2 py-1 rounded-lg border border-blue-200">Entrar</span>';
    btn.onclick = () => {
      completeGoogleAuthOnServer({ email: acc.email, name: acc.name, picture: acc.picture });
    };
    container.appendChild(btn);
  });
}

async function handleGoogleDirectSubmit(e) {
  e.preventDefault();
  const email = document.getElementById('google-input-email').value.trim();
  const name = document.getElementById('google-input-name').value.trim();
  const errEl = document.getElementById('google-modal-error');

  if (!email || !email.includes('@')) {
    if (errEl) {
      errEl.innerText = 'Digite um endereço de e-mail válido da sua conta do Google.';
      errEl.classList.remove('hidden');
    }
    return;
  }

  await completeGoogleAuthOnServer({ email, name });
}

async function completeGoogleAuthOnServer(payload) {
  const errEl = document.getElementById('google-modal-error');
  if (errEl) errEl.classList.add('hidden');

  try {
    const res = await fetch(API_BASE + '/api/v1/auth/google', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (res.ok && json.token) {
      authToken = json.token;
      currentUser = json.user;
      localStorage.setItem('cuidacao_token', authToken);
      if (json.user && json.user.provider === 'demo') saveGoogleAccountToDevice(json.user);

      closeGoogleAccountModal();
      closeLoginModal();
      hideHomeScreen();
      renderAuthBox();
      loadLocations();
      if (selectedLocation) openSidebar(selectedLocation);
      showToast('Bem-vindo(a) ao CuidAção, ' + currentUser.name + '!', 'success');
    } else {
      if (errEl) {
        errEl.innerText = json.error || 'Falha ao autenticar com o Google.';
        errEl.classList.remove('hidden');
      } else {
        showToast(json.error || 'Falha ao autenticar com o Google.', 'error');
      }
    }
  } catch {
    if (errEl) {
      errEl.innerText = 'Erro de conexão com o servidor.';
      errEl.classList.remove('hidden');
    } else {
      showToast('Erro de conexão com o servidor.', 'error');
    }
  }
}

// ============================================================================
// 7. CONTROLE DA TELA DE INÍCIO (HERO CARD), MODAL SOBRE & AUTENTICAÇÃO
// ============================================================================
let authMode = 'login';

function openAboutModal() {
  const modal = document.getElementById('modal-about');
  if (modal) modal.classList.remove('hidden');
}

function closeAboutModal() {
  const modal = document.getElementById('modal-about');
  if (modal) modal.classList.add('hidden');
}

function fillDemoCredentials() {
  switchAuthTab('login');
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-pass');
  if (emailEl) emailEl.value = 'cidadao@onehealth.org';
  if (passEl) passEl.value = '123456';
  showToast('Credenciais de demonstração preenchidas para avaliação da Banca!', 'info');
}

function showHomeScreen() {
  const homeEl = document.getElementById('home-screen');
  if (!homeEl) return;
  updateHomeScreenCta();
  homeEl.classList.remove('hidden');
  requestAnimationFrame(() => {
    homeEl.classList.remove('opacity-0');
    homeEl.classList.add('opacity-100');
  });
}

function hideHomeScreen() {
  const homeEl = document.getElementById('home-screen');
  if (homeEl && !homeEl.classList.contains('hidden')) {
    homeEl.classList.remove('opacity-100');
    homeEl.classList.add('opacity-0');
    setTimeout(() => {
      homeEl.classList.add('hidden');
    }, 300);
  }
  if (map) {
    setTimeout(() => {
      map.invalidateSize({ animate: false });
      map.setView([userCoords.lat, userCoords.lng], map.getZoom() || 15.5, { animate: false });
      if (!liveGpsTracker || !liveGpsTracker.isActive()) {
        startLiveGpsTracking();
      }
    }, 60);
  }
}

function enterAsGuest() {
  // Preserva sessão válida já existente (não destrói cuidacao_token ao voltar para a tela inicial)
  if (authToken && isTokenValid(authToken) && currentUser) {
    renderAuthBox();
    hideHomeScreen();
    if (selectedLocation) openSidebar(selectedLocation);
    showToast('Continuando sessão como ' + currentUser.name + '!', 'success');
    return;
  }

  if (authToken && !isTokenValid(authToken)) {
    authToken = null;
    currentUser = null;
    localStorage.removeItem('cuidacao_token');
    localStorage.removeItem('onehealth_token');
  }

  renderAuthBox();
  hideHomeScreen();
  if (selectedLocation) openSidebar(selectedLocation);
  showToast('Modo Visitante ativo no Bairro do Perequê (Guarujá/SP)!', 'info');
}

function openLoginModal() {
  updateDemoLoginVisibility();
  switchAuthTab(authMode || 'login');
  document.getElementById('modal-login').classList.remove('hidden');
}
function closeLoginModal() { document.getElementById('modal-login').classList.add('hidden'); }

function switchAuthTab(mode) {
  authMode = mode;
  const passEl = document.getElementById('auth-pass');
  const nameEl = document.getElementById('auth-name');
  if (mode === 'login') {
    document.getElementById('tab-login').className = 'flex-1 pb-2 border-b-2 border-emerald-600 text-emerald-600';
    document.getElementById('tab-register').className = 'flex-1 pb-2 border-b-2 border-transparent text-gray-400';
    document.getElementById('field-name').classList.add('hidden');
    document.getElementById('btn-auth-submit').innerText = 'Entrar';
    if (nameEl) nameEl.required = false;
    if (passEl) {
      passEl.removeAttribute('minlength');
      passEl.setAttribute('maxlength', '128');
      passEl.placeholder = 'Sua senha (mín. 8 no cadastro)';
    }
  } else {
    document.getElementById('tab-register').className = 'flex-1 pb-2 border-b-2 border-emerald-600 text-emerald-600';
    document.getElementById('tab-login').className = 'flex-1 pb-2 border-b-2 border-transparent text-gray-400';
    document.getElementById('field-name').classList.remove('hidden');
    document.getElementById('btn-auth-submit').innerText = 'Criar Conta';
    if (nameEl) nameEl.required = true;
    if (passEl) {
      passEl.setAttribute('minlength', '8');
      passEl.setAttribute('maxlength', '128');
      passEl.placeholder = 'Mínimo de 8 caracteres';
    }
  }
}

async function handleAuthSubmit(e) {
  e.preventDefault();
  const endpoint = authMode === 'login' ? '/api/v1/auth/login' : '/api/v1/auth/register';
  const payload = {
    name: document.getElementById('auth-name').value,
    email: document.getElementById('auth-email').value,
    password: document.getElementById('auth-pass').value
  };

  try {
    const res = await fetch(API_BASE + endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const json = await res.json();

    if (res.ok) {
      authToken = json.token;
      currentUser = json.user;
      localStorage.setItem('cuidacao_token', authToken);
      renderAuthBox();
      closeLoginModal();
      hideHomeScreen();
      loadLocations();
      if (communityFeedController) communityFeedController.reload();
      if (selectedLocation) openSidebar(selectedLocation);
      showToast('Autenticado com sucesso como ' + currentUser.name + '!', 'success');
    } else {
      showToast(json.error || 'Erro na autenticação.', 'error');
    }
  } catch {
    showToast('Erro de comunicação com o servidor.', 'error');
  }
}

function renderAuthBox() {
  updateHomeScreenCta();
  updateDemoLoginVisibility();
  const container = document.getElementById('auth-box');
  if (currentUser && currentUser.name) {
    const firstName = currentUser.name.split(' ')[0];
    const isGoogle = currentUser.provider === 'google';
    const badgeIcon = isGoogle
      ? '<span class="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-600 text-white text-[10px] font-black">G</span>'
      : '<span>👤</span>';

    container.innerHTML = 
      '<div class="flex items-center gap-1.5 bg-white/95 px-3 py-1.5 rounded-xl border border-gray-200 shadow-md text-xs font-bold">' +
        badgeIcon +
        '<span>' + escapeHtml(firstName) + '</span>' +
        '<button onclick="logout()" class="text-red-500 hover:text-red-700 ml-1.5 font-extrabold" title="Sair e voltar ao início">Sair</button>' +
      '</div>';
  } else {
    container.innerHTML = 
      '<div class="flex items-center gap-1.5">' +
        '<span class="hidden sm:inline-flex items-center gap-1 bg-gray-900/80 text-white px-2.5 py-1.5 rounded-xl text-[11px] font-bold">👁️ Visitante</span>' +
        '<button onclick="openLoginModal()" class="bg-emerald-600 hover:bg-emerald-700 text-white shadow-md px-3.5 py-2 rounded-xl text-xs font-bold transition">🔑 Entrar</button>' +
      '</div>';
  }
}

function logout() {
  authToken = null;
  currentUser = null;
  localStorage.removeItem('cuidacao_token');
  localStorage.removeItem('onehealth_token');
  renderAuthBox();
  closeSidebar();
  loadLocations();
  showHomeScreen();
  showToast('Sessão encerrada com segurança.', 'info');
}

// ============================================================================
// 8. AÇÕES DE ESCRITA RESTRITAS A AUTENTICADOS (AVALIAÇÕES E RELATOS)
// ============================================================================
function openReviewModal() {
  if (!currentUser || !authToken) {
    showToast('Faça login com sua conta ou Google para avaliar este local.', 'info');
    return openLoginModal();
  }
  document.getElementById('modal-review').classList.remove('hidden');
}

function closeReviewModal() {
  document.getElementById('modal-review').classList.add('hidden');
}

function updateRangeText(elId, val, labels) {
  document.getElementById(elId).innerText = val + ' - ' + labels[val - 1];
}

async function handleReviewSubmit(e) {
  e.preventDefault();
  if (!selectedLocation) return;

  const payload = {
    rating_wait_time: document.getElementById('rate-wait').value,
    rating_accessibility: document.getElementById('rate-access').value,
    rating_humanized_care: document.getElementById('rate-care').value,
    comment: document.getElementById('rate-comment').value
  };

  try {
    const res = await apiFetch('/api/v1/locations/' + encodeURIComponent(selectedLocation.id) + '/reviews', {
      method: 'POST',
      auth: true,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) {
      closeReviewModal();
      return;
    }
    const json = await res.json();

    if (res.ok) {
      showToast('Avaliação registrada com sucesso no CuidAção!', 'success');
      document.getElementById('rate-comment').value = '';
      closeReviewModal();
      openSidebar(json.location);
      loadLocations();
    } else {
      showToast(json.error || 'Erro ao submeter avaliação.', 'error');
    }
  } catch {
    showToast('Erro ao conectar ao servidor.', 'error');
  }
}

// ============================================================================
// 9. RELATO AMBIENTAL COM OPÇÃO DE APONTAR O LOCAL EXATO DO FOCO NO MAPA
// ============================================================================
function openReportModal() {
  if (!currentUser || !authToken) {
    showToast('Faça login para reportar um foco de dengue ou descarte irregular.', 'info');
    return openLoginModal();
  }

  if (!reportTargetCoords) {
    reportTargetCoords = { lat: userCoords.lat, lng: userCoords.lng, source: 'Posição Atual' };
  }

  updateReportCoordsBadge();
  const repAddr = document.getElementById('rep-address');
  if (repAddr && !repAddr.value && currentAddressLabel) {
    repAddr.value = currentAddressLabel;
  }
  document.getElementById('modal-report').classList.remove('hidden');
}

function closeReportModal() {
  document.getElementById('modal-report').classList.add('hidden');
}

function updateReportCoordsBadge() {
  const badgeEl = document.getElementById('rep-coords-badge');
  if (!badgeEl) return;
  const target = reportTargetCoords || { lat: userCoords.lat, lng: userCoords.lng, source: 'Posição Atual' };
  badgeEl.innerText = target.source + ' (' + target.lat.toFixed(4) + ', ' + target.lng.toFixed(4) + ')';
}

function useCurrentPositionForReport() {
  reportTargetCoords = { lat: userCoords.lat, lng: userCoords.lng, source: 'Posição Atual' };
  const repAddr = document.getElementById('rep-address');
  if (repAddr && currentAddressLabel) {
    repAddr.value = currentAddressLabel;
  }
  updateReportCoordsBadge();
  showToast('Usando sua posição atual para o relato ambiental.', 'info');
}

function startPickReportLocationMode() {
  closeReportModal();
  pickLocationMode = 'report';
  document.getElementById('map').classList.add('pick-location-mode');

  const banner = document.getElementById('calibration-banner');
  const textEl = document.getElementById('calibration-banner-text');
  const cepBtn = document.getElementById('calibration-cep-btn');
  if (cepBtn) cepBtn.classList.add('hidden');
  if (banner && textEl) {
    textEl.innerText = '📌 Clique no ponto exato do mapa onde está o foco de dengue ou descarte irregular';
    banner.classList.remove('hidden');
  }
  showToast('Clique sobre o local exato do foco no mapa.', 'info');
}

async function applyCustomReportPoint(lat, lng) {
  reportTargetCoords = { lat, lng, source: 'Ponto no Mapa' };
  const nearest = findNearestNeighborhood(lat, lng);
  let resolvedAddress = nearest.distance <= 3500
    ? (nearest.neighborhood.name + ', Guarujá - SP')
    : ('Lat ' + lat.toFixed(5) + ', Lng ' + lng.toFixed(5));

  try {
    const res = await fetch(API_BASE + '/api/v1/geo/reverse?lat=' + lat + '&lng=' + lng);
    const geoInfo = await res.json();
    if (geoInfo && geoInfo.displayName) {
      resolvedAddress = geoInfo.displayName;
    }
  } catch {
    // Mantém endereço do bairro identificado
  }

  const repAddr = document.getElementById('rep-address');
  if (repAddr) repAddr.value = resolvedAddress;
  updateReportCoordsBadge();

  document.getElementById('modal-report').classList.remove('hidden');
  showToast('Local do foco capturado: ' + resolvedAddress, 'success');
}

async function handleReportSubmit(e) {
  e.preventDefault();
  const coords = reportTargetCoords || { lat: userCoords.lat, lng: userCoords.lng };
  const payload = {
    title: document.getElementById('rep-title').value,
    report_type: document.getElementById('rep-type').value,
    address: document.getElementById('rep-address').value,
    description: document.getElementById('rep-desc').value,
    lat: coords.lat,
    lng: coords.lng
  };

  try {
    const res = await apiFetch('/api/v1/reports', {
      method: 'POST',
      auth: true,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });
    if (res.status === 401) {
      closeReportModal();
      return;
    }
    const json = await res.json();

    if (res.status === 409 && json.duplicate_of) {
      closeReportModal();
      showToast(json.message || 'Já existe um alerta deste tipo a menos de 50m! Confirmando alerta existente...', 'info');
      await confirmReportFromMap(json.duplicate_of.id);
      if (map && Number.isFinite(Number(json.duplicate_of.lat)) && Number.isFinite(Number(json.duplicate_of.lng))) {
        map.flyTo([Number(json.duplicate_of.lat), Number(json.duplicate_of.lng)], 17, { animate: true, duration: 0.9 });
      }
      return;
    }

    if (res.ok) {
      showToast('Alerta comunitário publicado no mapa do CuidAção!', 'success');
      document.getElementById('rep-title').value = '';
      document.getElementById('rep-desc').value = '';
      reportTargetCoords = null;
      closeReportModal();
      loadReports();
      if (communityFeedController) communityFeedController.reload();
      if (map) {
        map.flyTo([coords.lat, coords.lng], 17, { animate: true, duration: 0.9 });
      }
    } else {
      showToast(json.error || 'Erro ao publicar denúncia.', 'error');
    }
  } catch {
    showToast('Erro de comunicação com o servidor.', 'error');
  }
}

// ============================================================================
// 7. EXPERIÊNCIA DE APP: INSTALAÇÃO (PWA), OFFLINE/ONLINE E BOTÃO VOLTAR (ANDROID)
// ============================================================================
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  deferredInstallPrompt = e;
  const btn = document.getElementById('btn-install-app');
  if (btn) btn.classList.remove('hidden');
});

function installApp() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  deferredInstallPrompt.userChoice.finally(function () {
    deferredInstallPrompt = null;
    const btn = document.getElementById('btn-install-app');
    if (btn) btn.classList.add('hidden');
  });
}

window.addEventListener('appinstalled', function () {
  const btn = document.getElementById('btn-install-app');
  if (btn) btn.classList.add('hidden');
  showToast('CuidAção instalado! Procure o ícone na sua tela inicial.', 'success');
});

window.addEventListener('offline', function () {
  showToast('Você está offline. Mostrando os últimos dados carregados.', 'info');
});
window.addEventListener('online', function () {
  showToast('Conexão restabelecida.', 'success');
  if (map) { loadLocations(); loadReports(); }
});

function handleAndroidBack() {
  const modalIds = ['modal-review', 'modal-report', 'modal-login', 'modal-location', 'modal-google-account', 'modal-about'];
  for (const id of modalIds) {
    const el = document.getElementById(id);
    if (el && !el.classList.contains('hidden')) { el.classList.add('hidden'); return; }
  }
  const communityEl = document.getElementById('community-bar');
  if (communityEl && !communityEl.classList.contains('hidden')) { closeCommunityBar(); return; }
  const sidebarEl = document.getElementById('sidebar');
  if (sidebarEl && !sidebarEl.classList.contains('hidden')) { closeSidebar(); return; }
  if (pickLocationMode) { cancelPickLocationMode(); return; }
  const homeEl = document.getElementById('home-screen');
  if (homeEl && homeEl.classList.contains('hidden')) { showHomeScreen(); return; }
  const appPlugin = window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App;
  if (appPlugin && appPlugin.exitApp) appPlugin.exitApp();
}

if (IS_NATIVE_APP && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
  window.Capacitor.Plugins.App.addListener('backButton', handleAndroidBack);
}

// ============================================================================
// BARRA DE COMUNIDADE E ALERTAS INTEGRADA À API REST + FILA OFFLINE
// (Usa módulo compartilhado public/js/community/feed.js)
// ============================================================================
let cbInitialized = false;
let communityFeedController = null;

function openCommunityBar() {
  const bar = document.getElementById('community-bar');
  if (!bar) return;
  closeSidebar();
  bar.classList.remove('hidden');
  const btn = document.getElementById('btn-community-bar');
  if (btn) btn.setAttribute('aria-expanded', 'true');
  if (communityFeedController) communityFeedController.reload();
}

function closeCommunityBar() {
  const bar = document.getElementById('community-bar');
  if (!bar) return;
  bar.classList.add('hidden');
  const btn = document.getElementById('btn-community-bar');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function toggleCommunityBar() {
  const bar = document.getElementById('community-bar');
  if (!bar) return;
  if (bar.classList.contains('hidden')) {
    openCommunityBar();
  } else {
    closeCommunityBar();
  }
}

function initCommunityBar() {
  if (cbInitialized) return;
  const bar = document.getElementById('community-bar');
  if (!bar || !window.CuidacaoCommunityFeed) return;
  cbInitialized = true;

  communityFeedController = window.CuidacaoCommunityFeed.mount({
    root: bar,
    apiBase: API_BASE,
    spritePrefix: 'cb-',
    iconClass: 'cb-icon',
    starBtnClass: 'cb-star',
    selectors: {
      form: '#cb-post-form',
      fileInput: '#cb-post-image',
      dropzone: '#cb-dropzone',
      preview: '#cb-preview',
      previewImg: '#cb-preview-img',
      previewChange: '#cb-preview-change',
      previewRemove: '#cb-preview-remove',
      typeSelect: '#cb-post-type',
      includeCoords: '#cb-include-coords',
      details: '#cb-post-details',
      detailsCount: '#cb-details-count',
      rating: '#cb-post-rating',
      ratingCaption: '#cb-rating-caption',
      error: '#cb-post-error',
      submit: '#cb-post-submit',
      feed: '#cb-feed',
      feedEmpty: '#cb-feed-empty',
      feedCount: '#cb-feed-count',
      tplPost: '#cb-tpl-post',
      tplComment: '#cb-tpl-comment',
      badge: '#community-bar-badge'
    },
    getAuthToken: () => authToken,
    getCurrentUser: () => currentUser,
    getCoordinates: () => ({
      lat: userCoords.lat,
      lng: userCoords.lng,
      address: currentAddressLabel || 'Bairro do Perequê, Guarujá - SP'
    }),
    onAuthRequired: () => {
      openLoginModal();
    },
    onUnauthorized: () => {
      clearExpiredOrInvalidSession(true, 'Sessão expirada ou inválida. Faça login novamente.');
    },
    onReportsChanged: () => {
      loadReports();
    },
    onFocusMapPoint: (post) => {
      if (map && post.lat !== null && post.lng !== null) {
        closeCommunityBar();
        hideHomeScreen();
        map.flyTo([post.lat, post.lng], 17, { animate: true, duration: 0.9 });
      }
    },
    notify: (msg, kind) => {
      showToast(msg, kind);
    }
  });
}

window.onload = initMap;
