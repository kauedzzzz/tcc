# CuidAção — Saúde Única (One Health) • Guarujá/SP

Plataforma comunitária de mapeamento geoespacial voltada à **Saúde Pública e Sustentabilidade** no município de **Guarujá/SP**, baseada no conceito de **Saúde Única (One Health)**.

O projeto funciona como **aplicação web**, **PWA instalável** (com suporte a cache e funcionamento offline) e pode ser empacotado como **aplicativo nativo Android/iOS** utilizando o **Capacitor**.

---

## Principais Funcionalidades

- **Mapa Interativo (Leaflet):** Visualização de unidades de saúde, farmácias, ecopontos e alertas ambientais no Guarujá/SP.
- **GPS em Tempo Real (`public/js/map/live-gps.js`):** Rastreamento de alta precisão via `navigator.geolocation.watchPosition()`, com animação suave de marcador, pausa automática em segundo plano para economia de bateria e retomada automática ao retornar ou conceder permissão.
- **Camada de Farmácias e Farmácia Popular (`public/js/map/pharmacies-data.js` e `pharmacy-layer.js`):** Mapeamento de farmácias e drogarias locais distribuídas pelos bairros do Guarujá/SP, com destaque visual (selo **FP**) para participantes do *Programa Farmácia Popular*, cálculo de distância e atalho de rota (*Como chegar*).
- **Busca por Endereço e CEP:** Geocodificação direta e reversa integrada à API (`/api/v1/geo/search`, `/api/v1/geo/reverse`, `/api/v1/geo/ip`).
- **Comunidade e Alertas (`public/comunidade.html`):** Página dedicada para visualização e registro de alertas ambientais e comunitários.
- **Avaliações de Locais:** Usuários autenticados podem avaliar unidades e serviços com notas e comentários.
- **Autenticação Segura:** Cadastro e login por e-mail/senha com JWT, suporte opcional a login com Google (`GOOGLE_CLIENT_ID`) e modo demo configurável para desenvolvimento.
- **PWA Offline-First (`public/sw.js`):** Service Worker (`v6`) com cache de shell da aplicação, cache limitado de tiles do mapa e estratégia *network-first* com fallback offline para a API.

---

## Pré-requisitos

- **Node.js 18+** (o servidor utiliza apenas módulos nativos do Node, sem dependências externas obrigatórias para rodar localmente).
- Para usar arquivo `.env` nativamente com `--env-file`: **Node.js 20.6+**.

---

## Como Executar Localmente

```bash
# 1. Entre na pasta do projeto
cd /caminho/para/tcc

# 2. Inicie o servidor (http://localhost:3000)
npm start
```

Outras opções de execução e automação:

```bash
npm run dev          # Inicia com --watch (reinicia automaticamente ao editar o servidor)
npm run start:env    # Carrega variáveis do arquivo .env (Node 20.6+)
npm run build        # Compila CSS estático (Tailwind), valida SHELL_ASSETS e atualiza hash do Service Worker
npm run doctor       # Diagnóstico completo: Node, .env, data.json, assets PWA e node --check
npm run sync:osm     # Job CLI/cron: sincroniza OpenStreetMap, clima/Aedes (Open-Meteo) e balneabilidade
npm test             # Executa suíte de testes unitários e de integração HTTP (node:test)
./run.sh             # Script auxiliar de inicialização
```

> **Nota de desenvolvimento:** Quando `GOOGLE_CLIENT_ID` não está definido em ambiente de desenvolvimento, o login demo por e-mail permanece habilitado para facilitar testes. Em produção (`NODE_ENV=production`), ele é desabilitado por padrão.

---

## Estrutura do Projeto

```text
.
├── server/
│   ├── server.js            # Servidor HTTP nativo, API REST v1 e entrega de arquivos estáticos
│   ├── database.js          # Orquestração de persistência (JsonRepository | PostgresRepository)
│   ├── repositories/        # Adapters JsonRepository (backups .gz) e PostgresRepository (PostGIS)
│   └── data.json            # Banco de dados local em JSON (gerado/atualizado em runtime)
├── public/
│   ├── index.html           # Interface principal (mapa interativo, filtros granulares, cluster e calor)
│   ├── comunidade.html      # Página dedicada de comunidade e alertas integrada à API REST
│   ├── painel.html          # Painel analítico One Health e exportação GeoJSON (QGIS)
│   ├── manifest.json        # Manifesto PWA
│   ├── sw.js                # Service Worker 100% offline-first (assets validados no build)
│   ├── css/
│   │   ├── tailwind.min.css # Folha utilitária compilada estaticamente (sem CDN JIT)
│   │   └── styles.css       # Estilos institucionais Mata Atlântica & Guarujá
│   ├── vendor/              # Assets locais do Leaflet, MarkerCluster e Leaflet.heat
│   ├── images/              # Imagens locais otimizadas (WebP/JPG)
│   ├── js/
│   │   ├── app.js           # Lógica principal do frontend
│   │   ├── config.js        # Configuração de URL da API (web vs Capacitor)
│   │   ├── community/
│   │   │   └── feed.js      # Módulo compartilhado de feed, comentários e fila offline
│   │   └── map/
│   │       ├── live-gps.js         # Módulo de GPS em tempo real e animação do marcador
│   │       ├── pharmacies-data.js  # Dados georreferenciados das farmácias do Guarujá/SP
│   │       └── pharmacy-layer.js   # Utilitários da camada unificada de farmácias (selo FP)
│   └── icons/               # Ícones do PWA e app nativo
├── database/
│   └── schema.sql           # Fonte única oficial DDL para PostgreSQL + PostGIS
├── scripts/
│   ├── build.js             # Build estático CSS + validação e versionamento do Service Worker
│   ├── doctor.js            # Verificador de integridade de ambiente, dados, PWA e sintaxe
│   └── sync-osm-guaruja.js  # Job CLI/cron OSM + clima/Aedes (Open-Meteo) + balneabilidade
├── tests/
│   ├── unit.test.js         # Testes unitários nativos (node:test)
│   └── integration.test.js  # Testes de integração HTTP em portas efêmeras e DATA_DIR isolado
├── .github/workflows/ci.yml # Pipeline CI/CD (testes, doctor e build opcional de APK Android)
├── capacitor.config.json    # Configuração do Capacitor (br.com.cuidacao.app)
├── package.json             # Metadados e scripts npm
├── .env.example             # Modelo de variáveis de ambiente
└── run.sh                   # Script de inicialização
```

---

## Variáveis de Ambiente

Copie `.env.example` para `.env` e ajuste conforme o ambiente:

| Variável | Descrição |
|---|---|
| `JWT_SECRET` | **Obrigatória em produção.** Chave para assinatura dos tokens JWT. Em desenvolvimento, é gerada automaticamente em `server/.jwt-secret`. |
| `GOOGLE_CLIENT_ID` | Habilita o login real com Google (o servidor valida o token e o campo `aud`). |
| `ALLOW_DEMO_LOGIN` | `1` habilita o login simplificado por e-mail (apenas para demonstração). |
| `ALLOWED_ORIGINS` | Origens autorizadas no CORS (já inclui as origens padrão do Capacitor). |
| `DATA_DIR` | Diretório onde o `data.json` será salvo. Em produção, aponte para um **volume/disco persistente**. |
| `TRUST_PROXY` | `1` quando atrás de proxy reverso/CDN (Render, Railway, Nginx), garantindo leitura correta do IP no rate limit. |
| `SEED_DEMO_DATA` | `1` cria usuário e alertas de demonstração em produção (em desenvolvimento já são criados). |
| `KEEP_DEMO_RATINGS` | `1` mantém as notas fictícias do seed inicial (útil em apresentações). |
| `DB_DRIVER` | `json` (padrão local sem dependências externas) ou `postgres` (usa `PostgresRepository` + PostGIS). |
| `DATABASE_URL` | String de conexão PostgreSQL/PostGIS opcional quando `DB_DRIVER=postgres`. |
| `ADMIN_EMAILS` | Lista opcional de e-mails separados por vírgula promovidos automaticamente a `admin`. |

---

## Endpoints da API (`v1`)

| Método | Rota | Descrição |
|---|---|---|
| `GET` | `/api/v1/health` | Status de saúde do servidor e driver ativo |
| `GET` | `/api/v1/locations` | Lista locais (SUS, Farmácias `cat-3`, Ecopontos, Parques e Zoonoses `cat-6`) |
| `GET` | `/api/v1/locations/:id` | Detalhes de um local específico |
| `POST` | `/api/v1/locations/:id/reviews` | Registra avaliação 1x/dia para um local (requer autenticação) |
| `GET` | `/api/v1/reports` | Lista alertas ambientais/comunitários enriquecidos (UBS e Ecoponto próximos) |
| `POST` | `/api/v1/reports` | Cria alerta com deduplicação em 50m e imagem opcional (requer autenticação) |
| `POST` | `/api/v1/reports/:id/comments` | Adiciona comentário em alerta da comunidade (requer autenticação) |
| `POST` | `/api/v1/reports/:id/confirm` | Confirma alerta comunitário ("Eu também vi" — 1x/usuário) |
| `PATCH` | `/api/v1/reports/:id/status` | Transição de status RBAC (`agent`/`admin`: `pending` → `in_analysis` → `resolved`/`rejected`) |
| `GET` | `/api/v1/uploads/:filename` | Entrega segura das imagens enviadas pela comunidade |
| `GET` | `/api/v1/analytics/summary` | Indicadores agregados One Health, rankings e correlação territorial |
| `GET` | `/api/v1/export/reports.geojson` | Exportação GeoJSON compatível com SIG / QGIS |
| `GET` | `/api/v1/geo/search` | Busca centralizada de endereço e CEP (ViaCEP + Gazetteer + Nominatim com cache) |
| `GET` | `/api/v1/geo/reverse` | Geocodificação reversa por latitude/longitude |
| `GET` | `/api/v1/geo/ip` | Localização aproximada por IP (ancorada no Perequê) |
| `GET` | `/api/v1/auth/google/config` | Configuração pública do login Google |
| `POST` | `/api/v1/auth/register` | Cadastro de usuário (`citizen`) |
| `POST` | `/api/v1/auth/login` | Login por e-mail e senha |
| `POST` | `/api/v1/auth/google` | Login via token Google |
| `POST` | `/api/v1/seed/osm-live` | Importação sob demanda do OpenStreetMap |

---

## Publicação em Produção e PWA

Recursos como **Geolocalização (GPS)** e **Service Worker (PWA)** exigem **HTTPS**.

1. Publique o projeto em uma hospedagem Node.js (Render, Railway, Fly.io ou VPS) usando `npm start`.
2. Configure `NODE_ENV=production`, `JWT_SECRET`, `DATA_DIR` (disco persistente) e `TRUST_PROXY=1`.
3. Acesse a URL HTTPS pelo celular:
   - **Android (Chrome):** toque em *"Instalar o app CuidAção"* ou no menu `⋮` → *Instalar app*.
   - **iOS (Safari):** toque em *Compartilhar* → *Adicionar à Tela de Início*.

---

## Empacotamento Nativo (Android / iOS com Capacitor)

1. Publique a API e configure a URL base em `public/js/config.js`:
   ```js
   apiBase: 'https://SEU-SERVIDOR.com' // sem barra no final
   ```
2. Instale o Capacitor e adicione as plataformas:
   ```bash
   npm i -D @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/app
   npm run cap:add:android   # e/ou npm run cap:add:ios (exige macOS + Xcode)
   ```
3. **Permissões de localização:**
   - **Android (`android/app/src/main/AndroidManifest.xml`):** adicione `ACCESS_FINE_LOCATION` e `ACCESS_COARSE_LOCATION`.
   - **iOS (`ios/App/App/Info.plist`):** adicione `NSLocationWhenInUseUsageDescription`.
4. **Ícones e Splash Screen (opcional):** copie `public/icons/icon-1024-source.png` para `assets/icon-only.png` e gere os assets com `@capacitor/assets`.
5. **Sincronizar e gerar build:**
   ```bash
   npm run cap:sync
   npm run cap:open:android
   ```
   No Android Studio, utilize **Build > Build APK(s)**. Ajuste o `appId` em `capacitor.config.json` (`br.com.cuidacao.app`) se desejar publicar em loja.

### Observações sobre o App Nativo
- **Login com Google em WebView:** o Google bloqueia fluxo OAuth web dentro de WebViews. No app empacotado, utilize login por e-mail/senha ou integre um plugin nativo de Google Sign-In para Capacitor.
- **Assets locais e tiles de mapa:** o frontend serve CSS utilitário compilado estaticamente (`public/css/tailwind.min.css`), Leaflet, MarkerCluster, Leaflet.heat e imagens locais diretamente de `public/`, garantindo funcionamento offline já no primeiro acesso e no APK. Os tiles do mapa (OpenStreetMap/Esri) visitados são cacheados localmente pelo Service Worker.
