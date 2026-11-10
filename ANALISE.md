# Análise do projeto CuidAção — achados e o que foi alterado

Legenda: 🔴 crítico · 🟠 alto · 🟡 médio · ✅ corrigido · 📌 recomendado (não alterado)

## Segurança

| # | Gravidade | Achado | Situação |
|---|---|---|---|
| 1 | 🔴 | `POST /auth/google` aceitava só `{email}` sem verificar nada e devolvia um token da conta existente. Qualquer pessoa que soubesse o e-mail de um usuário "Google" entrava como ele (o modal do site tinha um formulário para isso). | ✅ Só aceita token Google validado (confere `aud`, emissor e e-mail verificado). O modo por e-mail virou "demo", só em desenvolvimento, e nunca entra em conta já existente. |
| 2 | 🔴 | `JWT_SECRET` com valor padrão fixo no código (`secret_cuidacao_…`): quem lê o repositório forja tokens. | ✅ Vem do ambiente; em dev é gerado aleatório; em produção o servidor se recusa a subir sem ele. |
| 3 | 🟠 | `POST /seed/osm-live` público e sem limite; `GET /locations` podia travar a resposta até 6 s consultando o Overpass. | ✅ Exige login, limita área/raio/frequência; a importação agora roda em segundo plano. |
| 4 | 🟠 | CORS `*`, corpo da requisição sem limite, sem limite de tentativas (login/cadastro/escrita). | ✅ CORS por lista de origens, corpo máx. 100 KB, limitador por IP (login: 10 por 10 min), cabeçalhos de segurança. |
| 5 | 🟠 | Alertas aceitavam qualquer tipo e qualquer coordenada (mundo todo). | ✅ Tipo validado (mesmo enum do `schema.sql`), coordenadas dentro do Guarujá, tamanhos máximos. |
| 6 | 🟡 | Senha: sem tamanho mínimo; `scryptSync` bloqueava o servidor; hash SHA-256 legado. | ✅ 8–128 caracteres, scrypt assíncrono, hash legado é migrado no 1º login, tempo de resposta igualado. |
| 7 | 🟡 | O `data.json` enviado continha e-mails/hash de usuários e alertas de teste (LGPD). | ✅ Projeto entregue sem `data.json` (criado no 1º acesso; está no `.gitignore`). 📌 Publique política de privacidade. |
| 7b | 🟠 | O seed criava o usuário `cidadao@onehealth.org` com senha fixa `123456` e 3 alertas de demonstração exibidos como alertas comunitários reais. | ✅ Em produção não são criados (`SEED_DEMO_DATA=1` os inclui para apresentação). |
| 8 | 🟡 | Rota estática sem proteção explícita de caminho. | ✅ Servidor de arquivos com bloqueio de path traversal. |

## Integridade dos dados

| # | Gravidade | Achado | Situação |
|---|---|---|---|
| 9 | 🟠 | **Notas e contagens inventadas.** Os 32 locais do seed têm `total_reviews` que não bate com as avaliações existentes (ex.: "64 avaliações" com 2 registradas); locais importados do OSM nasciam com nota 4,4 e "14 avaliações" falsas; o `app.js` tem um 2º dataset embutido com o mesmo problema. | ✅ Nota e contagem agora são **sempre calculadas das avaliações reais**; sem avaliações aparece "Sem avaliações ainda". `KEEP_DEMO_RATINGS=1` devolve os números fictícios só para apresentação. |
| 10 | 🟠 | Avaliação sem nota virava **5** silenciosamente; podia avaliar o mesmo local várias vezes; média "corrida" acumulava erro. | ✅ Notas 1–5 obrigatórias, 1 avaliação por usuário/local/dia (igual ao `schema.sql`), média recalculada. |
| 11 | 🟡 | IDs com `Date.now()` (colisão) e IDs do OSM sem o tipo (node/way podem repetir). | ✅ UUIDs; IDs OSM com tipo. |
| 12 | 🟡 | `data.json` regravado inteiro e de forma síncrona a cada ação (risco de corromper). | ✅ Gravação atômica (arquivo temporário + rename), agrupada, e descarga ao encerrar. |
| 13 | 🟡 | `schema.sql` diz "sincronizado com o backend", mas o backend usa JSON. | ✅ Nota no topo; é o modelo alvo para migrar ao PostgreSQL. |
| 14 | 🟡 | Categorias duplicadas com nomes diferentes (`UBS - Posto de Saúde` × `UBS / USAFA - Posto de Saúde`; `Parque & Área Verde` × `… (Mata Atlântica)`). | 📌 Padronizar nomes no seed. |

## Experiência de uso / app

| # | Gravidade | Achado | Situação |
|---|---|---|---|
| 15 | 🟠 | O GPS só era aceito a menos de 3,5 km do Perequê, e o botão 🎯 apenas voltava ao Perequê — quem estava em outro bairro nunca via a própria posição. | ✅ GPS aceito em todo o Guarujá; 🎯 usa o GPS de verdade; selo do bairro dinâmico. |
| 16 | 🟡 | `/api/v1/geo/ip` devolvia o Perequê como "precisão 25 m, não é IP". | ✅ Marcado como aproximado (`isCoarseIp: true`). |
| 17 | 🟡 | Nominatim (OSM) chamado sem cache e sem limite de 1 req/s (risco de bloqueio). | ✅ Cache de 1 h e fila com intervalo de 1,1 s. |
| 18 | 🟡 | `user-scalable=no` (impede zoom; barreira de acessibilidade) e nenhum tratamento de notch/barra de gestos. | ✅ Zoom liberado, áreas seguras, foco visível, `prefers-reduced-motion`, alvos de toque maiores. |
| 19 | 🟡 | Caminhos quebrados (`../css`, `../js`), `manifest.json` e `run.sh` não vieram nos arquivos enviados, `server_1.js` redundante. | ✅ Estrutura `public/` + `server/`, `npm start` direto, manifest e ícones reais. |
| 20 | — | Não era instalável de verdade (sem ícones, sem offline útil). | ✅ PWA completo: manifest, ícones (incl. maskable), service worker com app shell, tiles e últimas listas offline, botão "Instalar". |
| 21 | — | Sem versão nativa. | ✅ Configuração Capacitor, botão voltar do Android, API configurável, guia no README. |

## Recomendações (não alteradas)

1. **Tailwind via CDN** (`cdn.tailwindcss.com`) é só para protótipo: lento e exige internet. Compile o CSS (`tailwindcss` CLI) e hospede o Leaflet em `public/`.
2. **Dataset duplicado** (≈500 linhas no `app.js` e o seed no `database.js`): deixe uma fonte só (a API) — o service worker já guarda a última resposta para uso offline.
3. **Moderação de alertas:** todo alerta nasce `pending` e é público; falta uma tela/rota administrativa para aprovar ou resolver.
4. **PostgreSQL + PostGIS** quando houver uso real (o `schema.sql` já está pronto); `data.json` não escala nem aceita 2 servidores.
5. **Login Google no app nativo** com plugin próprio; **recuperação de senha** (hoje não existe).
6. **Mobile:** a barra superior concentra ~14 controles. Vale um painel "Filtros" recolhível no celular (não alterei o layout às cegas, sem poder testar em tela real).
7. **LGPD:** política de privacidade, base legal para guardar e-mail/nome e forma de excluir a conta.

