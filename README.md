# CuidAção — Saúde Única (One Health) • Guarujá/SP

Mapa comunitário de unidades de saúde, farmácias, ecopontos e alertas ambientais do Guarujá/SP.
Funciona como **site**, como **app instalável (PWA)** e pode ser empacotado como **app Android/iOS** (Capacitor).

> A lista completa do que foi encontrado e corrigido está em **[ANALISE.md](ANALISE.md)**.

## 1. Rodar no computador

```bash
npm start            # http://localhost:3000   (Node 18+; não há dependências para instalar)
# ou: ./run.sh
```

Em desenvolvimento, sem `GOOGLE_CLIENT_ID`, o login "demo" por e-mail fica ligado (aparece avisado no modal).
Em produção ele fica **desligado** (veja a tabela abaixo).

## 2. Estrutura

```
server/            API Node (server.js), persistência (database.js) e data.json (criado no 1º acesso)
public/            Tudo que o navegador/app carrega
  index.html  css/styles.css  js/app.js  js/config.js
  manifest.json  sw.js  icons/
database/schema.sql  Modelo alvo PostgreSQL + PostGIS (o backend atual usa data.json)
capacitor.config.json  Configuração do app nativo
```

## 3. Variáveis de ambiente (veja `.env.example`)

| Variável | Para que serve |
|---|---|
| `JWT_SECRET` | **Obrigatória em produção.** Em desenvolvimento é gerada e guardada em `server/.jwt-secret`. |
| `GOOGLE_CLIENT_ID` | Ativa o login Google real (o servidor valida o token e o `aud`). |
| `ALLOW_DEMO_LOGIN` | `1` liga o login só por e-mail (não verifica o dono do e-mail). Só para demonstração. |
| `ALLOWED_ORIGINS` | Origens que podem chamar a API de outro domínio (o app nativo). Já inclui as do Capacitor. |
| `DATA_DIR` | Pasta do `data.json`. Em hospedagem, aponte para um **disco persistente**. |
| `TRUST_PROXY` | `1` atrás de proxy/CDN, para o limite de requisições enxergar o IP real. |
| `SEED_DEMO_DATA` | `1` cria em produção o usuário demo e alertas de demonstração (em desenvolvimento já são criados). |
| `KEEP_DEMO_RATINGS` | `1` mantém as notas fictícias do seed (apresentações). Padrão: notas só das avaliações reais. |

Com Node 20.6+: copie `.env.example` para `.env` e rode `npm run start:env`.

## 4. Publicar o servidor

PWA e GPS exigem **HTTPS**. Qualquer hospedagem Node serve (Render, Railway, Fly.io, VPS):
comando de início `npm start`, defina `NODE_ENV=production`, `JWT_SECRET`, `DATA_DIR` (disco persistente)
e `TRUST_PROXY=1`. Abra a URL publicada no celular:

- **Android (Chrome):** botão "Instalar o app CuidAção" na tela inicial do site (ou menu ⋮ → Instalar app).
- **iPhone (Safari):** Compartilhar → Adicionar à Tela de Início.

O app abre em tela cheia, com ícone próprio, e mostra os últimos dados carregados quando fica sem internet.

## 5. Gerar o app Android/iOS (Capacitor)

1. Publique a API (passo 4) e coloque a URL em `public/js/config.js`:
   `apiBase: 'https://SEU-SERVIDOR.com'` (sem barra no final).
2. Instale o Capacitor e crie os projetos nativos:
   ```bash
   npm i -D @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios @capacitor/app
   npx cap add android      # e/ou: npx cap add ios  (iOS exige Mac + Xcode)
   ```
3. **Permissão de localização**
   - Android: em `android/app/src/main/AndroidManifest.xml` adicione
     `ACCESS_FINE_LOCATION` e `ACCESS_COARSE_LOCATION` (`<uses-permission .../>`).
   - iOS: em `ios/App/App/Info.plist` adicione `NSLocationWhenInUseUsageDescription`
     (ex.: "Usamos sua localização para mostrar unidades de saúde próximas").
4. Ícone e splash: crie `assets/icon-only.png` (copie `public/icons/icon-1024-source.png`) e rode
   `npm i -D @capacitor/assets && npx capacitor-assets generate` (veja a documentação do pacote).
5. `npx cap sync` → `npx cap open android` → no Android Studio: *Build > Build APK(s)*.
   Troque o `appId` em `capacitor.config.json` (`br.com.cuidacao.app`) pelo seu.

O botão "voltar" do Android já fecha modal → painel → modo de marcação → tela inicial, nessa ordem.

### Limitações conhecidas do app nativo
- **Login com Google no app:** o Google bloqueia o login web dentro de WebView. No app, o acesso é por
  e-mail e senha. Para Google nativo é preciso um plugin (ex.: login nativo do Google para Capacitor) — não incluído.
- O app carrega Tailwind e Leaflet de CDN (precisa de internet na 1ª abertura; depois o cache ajuda).
  Para uso 100% offline/loja, compile o Tailwind e copie o Leaflet para `public/` (ver ANALISE.md).
- Os mapas usam servidores públicos de tiles (OpenStreetMap/Esri). Para app publicado em loja, use um
  provedor com plano apropriado (MapTiler, Stadia, Mapbox...) — os servidores públicos limitam uso intenso.

## 6. O que foi e o que não foi testado

- **Testado (automaticamente, no servidor):** cadastro, login, limite de tentativas, bloqueio de tomada de
  conta via Google, avaliações (notas obrigatórias, duplicadas), alertas (tipo/área), CORS, body gigante,
  path traversal, entrega dos arquivos do site/PWA.
- **Verificado estaticamente:** sintaxe do `app.js`/`server.js`; todos os IDs e `onclick` do HTML têm função/elemento correspondente.
- **NÃO testado:** o visual e o comportamento em navegador/celular reais (não havia navegador disponível),
  o build do APK/IPA e o login Google real (exige seu `GOOGLE_CLIENT_ID`). Teste em um celular antes de apresentar.
