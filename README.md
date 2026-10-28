# 🌿 CuidAção — Saúde Única (One Health) • Guarujá/SP

![Node.js](https://img.shields.io/badge/Node.js-%3E%3D18.0.0-339933?style=for-the-badge&logo=node.js&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-ES6%2B-F7DF1E?style=for-the-badge&logo=javascript&logoColor=black)
![TailwindCSS](https://img.shields.io/badge/Tailwind_CSS-CDN-38B2AC?style=for-the-badge&logo=tailwind-css&logoColor=white)
![Leaflet](https://img.shields.io/badge/Leaflet-1.9.4-199900?style=for-the-badge&logo=leaflet&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL_%2B_PostGIS-DDL-4169E1?style=for-the-badge&logo=postgresql&logoColor=white)
![PWA](https://img.shields.io/badge/PWA-Ready-5A0FC8?style=for-the-badge&logo=pwa&logoColor=white)

> **Mapeamento Geoespacial Comunitário e Inteligente de Saúde Pública e Sustentabilidade no Município de Guarujá/SP (com destaque para o Bairro do Perequê e cobertura integral de todos os bairros).**

O **CuidAção** é um projeto de Trabalho de Conclusão de Curso (TCC) desenvolvido sob o paradigma de **Saúde Única (*One Health*)**, que reconhece a conexão indissociável entre a **saúde humana**, a **saúde animal** e a **preservação ambiental** no ecossistema de Mata Atlântica e zonas costeiras da Baixada Santista.

---

## ✨ Principais Funcionalidades

- 🗺️ **Mapa Interativo Georreferenciado (Ruas & Satélite HD)**: Visualização de Unidades de Saúde da Família (USAFAs), UBSs, UPAs 24h, Hospitais, Farmácias Populares, Ecopontos (SEMAM) e Parques/Áreas Verdes em todo o Guarujá/SP.
- 📍 **Geolocalização Calibrada & Busca Inteligente**:
  - Ancoragem calibrada para o **Bairro do Perequê** e cobertura de todos os bairros do Guarujá (raio padrão de 25 km).
  - Busca por CEP integrada ao **ViaCEP**, Gazetteer local de alta precisão e **OpenStreetMap Nominatim**.
  - Cálculo geoespacial nativo de distância em metros via **Fórmula de Haversine**.
- 🔄 **Ingestão de Dados Reais (OpenStreetMap Overpass API)**: Sincronização sob demanda de pontos de saúde e sustentabilidade reais próximos ao usuário.
- ⭐ **Avaliações Comunitárias Multi-Critério**: Cidadãos autenticados podem avaliar locais quanto ao **Tempo de Espera**, **Acessibilidade** e **Atendimento Humanizado**, recalculando automaticamente a nota geral da unidade.
- 🚨 **Alertas e Denúncias Ambientais Georreferenciadas**: Registro no mapa de focos de dengue (`foco_dengue`), descarte irregular de resíduos (`descarte_irregular`), terrenos baldios (`terreno_baldio`) e esgoto a céu aberto (`esgoto_ceu_aberto`).
- 🔐 **Autenticação Segura & Híbrida**:
  - Cadastro e login local com derivação criptográfica `crypto.scryptSync` + *Salt* aleatório e verificação `timingSafeEqual`.
  - Tokens **JWT (HS256)** nativos.
  - Integração com **Google Identity Services (OAuth 2.0)**.
- 📱 **Progressive Web App (PWA)**: Suporte a instalação em dispositivos móveis e desktop via `manifest.json` e cache estratégico com Service Worker (`/sw.js`).

---

## 🛠️ Tecnologias Utilizadas

### Identificadas no `package.json` e Ambiente Back-End
O servidor foi arquitetado em **Node.js puro (*Zero External NPM Dependencies*)**, garantindo leveza, segurança e execução imediata sem necessidade de compilação de pacotes externos:

| Tecnologia / Módulo | Versão / Escopo | Finalidade no Projeto |
| :--- | :--- | :--- |
| **Node.js** | `>= 18.0.0` (`engines` no `package.json`) | Runtime JavaScript principal do servidor backend (`server.js`). |
| **`http` / `https`** | Nativo do Node.js | Servidor HTTP RESTful e cliente HTTPS para consumo das APIs ViaCEP, Nominatim, Overpass e Google OAuth. |
| **`crypto`** | Nativo do Node.js | Hash de senhas com `scryptSync` + *salt*, comparação segura com `timingSafeEqual` e assinatura de tokens JWT (`HMAC-SHA256`). |
| **`fs` / `path`** | Nativo do Node.js | Servidor de arquivos estáticos e persistência transacional automática em disco (`server/data.json`). |
| **Bash (`run.sh`)** | Script de Inicialização (`npm start` / `npm run dev`) | Inicializador inteligente com suporte nativo ao sistema operacional e ambientes isolados (ex.: VS Code via Flatpak). |

### Front-End, Banco de Dados & Integrações Externas
| Camada | Tecnologias |
| :--- | :--- |
| **Front-End & UI** | HTML5 Semântico, CSS3 Customizado (`css/styles.css`), **Tailwind CSS** (via CDN), JavaScript ES6+ (`js/app.js`). |
| **Mapas & Geoprocessamento** | **Leaflet.js `1.9.4`**, OpenStreetMap Vector Tiles, **Esri World Imagery** (Satélite HD). |
| **APIs Geoespaciais & Auth** | **ViaCEP API** (consulta de CEPs), **OSM Nominatim** (Geocoding/Reverse), **OSM Overpass API** (POIs em tempo real), **Google Identity Services**. |
| **Persistência & Banco de Dados** | Persistência JSON em disco (`server/data.json`) + Modelagem relacional/espacial completa em **PostgreSQL + PostGIS** (`server/schema.sql` com triggers em `PL/pgSQL` e índices espaciais `GIST`). |

---

## 📂 Estrutura do Projeto

```text
tcc/
├── css/
│   └── styles.css          # Estilos visuais, animações de marcadores e alto contraste para modo satélite
├── html/
│   └── index.html          # Interface principal (Hero Card, Mapa Interativo, Modais de Auth/Avaliação/Denúncia)
├── js/
│   └── app.js              # Lógica client-side, integração Leaflet, geolocalização, ViaCEP e consumo da API
├── server/
│   ├── server.js           # Servidor HTTP, rotas da API REST (/api/v1/*), JWT, Service Worker e integração OSM
│   ├── database.js         # Camada de persistência (data.json), seed do Guarujá/Perequê, Haversine e Scrypt
│   ├── data.json           # Banco de dados local persistente em formato JSON
│   └── schema.sql          # Script DDL oficial para PostgreSQL + PostGIS com Triggers PL/pgSQL
├── package.json            # Metadados do projeto, scripts (start/dev) e requisitos de engine (Node >= 18)
├── run.sh                  # Script de execução compatível com Linux nativo e containers Flatpak
└── server.js               # Ponto de entrada principal (redireciona para ./server/server.js)
```

---

## 🌐 Tabela de Rotas e Endpoints

### 1. Arquivos Estáticos & PWA

| Método | Rota / Endpoint | Descrição |
| :---: | :--- | :--- |
| `GET` | `/`, `/index.html`, `/html/index.html` | Serve a aplicação web principal (`html/index.html`). |
| `GET` | `/css/styles.css`, `/styles.css` | Serve a folha de estilos principal do projeto. |
| `GET` | `/js/app.js`, `/app.js` | Serve o script principal do cliente (Front-End). |
| `GET` | `/manifest.json` | Retorna o Web App Manifest oficial do PWA **CuidAção**. |
| `GET` | `/sw.js` | Serve o Service Worker (`cuidacao-pwa-v2`) para suporte offline e cache de assets. |

### 2. API RESTful (`/api/v1`)

| Método | Endpoint | Autenticação | Parâmetros (Query / Body) | Descrição |
| :---: | :--- | :---: | :--- | :--- |
| `GET` | `/api/v1/auth/google/config` | Pública | — | Retorna a configuração de `clientId` para autenticação OAuth 2.0 com o Google. |
| `POST` | `/api/v1/auth/register` | Pública | **Body**: `{ name, email, password }` | Registra um novo usuário local com senha criptografada via `scrypt` e retorna o token JWT. |
| `POST` | `/api/v1/auth/login` | Pública | **Body**: `{ email, password }` | Autentica um usuário local e retorna o token JWT (`Bearer`) válido por 24h. |
| `POST` | `/api/v1/auth/google` | Pública | **Body**: `{ accessToken }` ou `{ credential }` ou `{ email, name, picture }` | Realiza login/cadastro via conta Google, protegendo contas locais contra sobrescrita. |
| `GET` | `/api/v1/geo/ip` | Pública | — | Retorna coordenadas de geolocalização de rede calibradas para o Bairro do Perequê (`Guarujá/SP`). |
| `GET` | `/api/v1/geo/reverse` | Pública | **Query**: `?lat={lat}&lng={lng}` | Geocodificação reversa de alta precisão combinando Nominatim OSM e o Gazetteer local do Guarujá. |
| `GET` | `/api/v1/geo/search` | Pública | **Query**: `?q={termo_ou_cep}&num={numero}` | Busca unificada de endereços por CEP (ViaCEP), bairros do Guarujá, unidades de saúde e Nominatim OSM. |
| `GET` | `/api/v1/locations` | Pública | **Query**: `?lat=&lng=&radius=25000&domain=&category=&search=` | Lista pontos de saúde e sustentabilidade ordenados por distância (em metros) a partir do usuário. |
| `GET` | `/api/v1/locations/:id` | Pública | **Path**: `id` do local | Retorna os detalhes completos de uma unidade específica, incluindo serviços, horários e avaliações. |
| `POST` | `/api/v1/locations/:id/reviews` | 🔒 `Bearer JWT` | **Body**: `{ rating_wait_time, rating_accessibility, rating_humanized_care, comment }` | Registra uma avaliação comunitária (notas de 1 a 5) e recalcula as médias da unidade. |
| `GET` | `/api/v1/reports` | Pública | — | Lista todos os alertas e denúncias ambientais georreferenciadas registradas na plataforma. |
| `POST` | `/api/v1/reports` | 🔒 `Bearer JWT` | **Body**: `{ title, report_type, description, address, lat, lng }` | Cria um novo alerta ambiental georreferenciado (ex.: foco de dengue ou descarte irregular). |
| `POST` | `/api/v1/seed/osm-live` | Pública | **Body**: `{ lat, lng, radius }` | Importa novos pontos reais do OpenStreetMap (Overpass API) em tempo real para a base local. |

---

## 📋 Pré-requisitos

Para executar o projeto localmente, você precisa apenas de:

- **[Node.js](https://nodejs.org/)** na versão **18.0.0 ou superior** (recomendado Node.js 18 LTS, 20 LTS ou superior).
- **Navegador Web Moderno** (Google Chrome, Firefox, Brave, Edge, Safari).
- **Conexão com a Internet** (para carregar os tiles de mapa do Leaflet/Esri, Tailwind CDN e consultas externas ViaCEP/OpenStreetMap; caso offline, o sistema conta com *fallbacks* locais automáticos).

> 💡 **Nota**: Como o projeto utiliza apenas módulos nativos do Node.js (`http`, `https`, `fs`, `path`, `crypto`), **não é necessário instalar dependências externas pesadas** na pasta `node_modules`.

---

## 🚀 Como Rodar Localmente

### 1. Clonar o repositório
```bash
git clone https://github.com/kauedzzzz/tcc.git
cd tcc
```

### 2. Iniciar o servidor
Você pode iniciar o servidor usando os scripts do `npm` ou diretamente pelo Node.js:

```bash
# Opção 1: Via NPM (executa o script ./run.sh)
npm start

# Opção 2: Modo de desenvolvimento
npm run dev

# Opção 3: Diretamente com o Node.js
node server.js
```

### 3. Acessar no navegador
Abra o navegador no endereço:
```text
http://localhost:3000
```

### 🔑 Conta de Demonstração Pré-configurada
Para testar rapidamente funcionalidades autenticadas (como **Avaliar Unidades** ou **Reportar Alertas Ambientais**), você pode criar uma nova conta na interface ou utilizar a conta de demonstração:
- **E-mail**: `cidadao@onehealth.org`
- **Senha**: `123456`

### ⚙️ Variáveis de Ambiente (Opcional)
O servidor funciona imediatamente sem necessidade de configuração extra, mas aceita as seguintes variáveis de ambiente caso deseje customizar:

| Variável | Valor Padrão | Descrição |
| :--- | :--- | :--- |
| `PORT` | `3000` | Porta HTTP onde o servidor será iniciado. |
| `JWT_SECRET` | `secret_cuidacao_onehealth_tcc_2026` | Chave secreta usada na assinatura HMAC-SHA256 dos tokens JWT. |
| `GOOGLE_CLIENT_ID` | *(vazio)* | Client ID do Google Cloud Console para login OAuth 2.0 oficial. |

---

## 👥 Equipe de Desenvolvimento (TCC 2026)

| Setor | Integrantes | Responsabilidades |
| :--- | :--- | :--- |
| ⚙️ **Back-End & Banco de Dados** | **Kauê, Igor e Pedro** | Arquitetura da API RESTful, Geoprocessamento (Haversine/OSM/ViaCEP), Segurança (Scrypt/JWT/Google Auth), Persistência e Modelagem PostgreSQL + PostGIS. |
| 🎨 **Front-End & Design (UI/UX)** | **Jamily e Yasmin** | Design da Interface, Experiência do Usuário, Acessibilidade, Mapa Interativo Leaflet e Identidade Visual *Mata Atlântica & Saúde Única*. |
