/**
 * =====================================================================================
 * CuidAção — Módulo Compartilhado de Comunidade e Alertas (public/js/community/feed.js)
 * -------------------------------------------------------------------------------------
 * Conecta tanto a Barra de Comunidade (#community-bar em index.html) quanto a página
 * dedicada (public/comunidade.html) à API REST (/api/v1/reports e /api/v1/reports/:id/comments),
 * com:
 *  - Imagem opcional (otimizada no cliente em JPEG/WebP e salva no servidor em DATA_DIR/uploads)
 *  - Alerta textual rápido (sem exigir foto)
 *  - Nota / urgência de 1 a 5 estrelas
 *  - Coordenadas opcionais no Guarujá/SP com vínculo em tempo real ao mapa
 *  - Confirmação comunitária ("Eu também vi este foco") e selos de status (RBAC)
 *  - Fila offline automática (localStorage) sincronizada assim que a conexão retorna
 * =====================================================================================
 */
(function (global) {
  'use strict';

  const CACHE_KEY = 'cuidacao_community_cache_v1';
  const OUTBOX_KEY = 'cuidacao_community_outbox_v1';
  const COMMENT_MAX = 225;
  const DETAILS_MAX = 1000;
  const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
  const IMAGE_MAX_SIDE = 1280;
  const IMAGE_QUALITY = 0.80;
  const RATING_LABELS = ['Selecione de 1 a 5', 'Baixa (1)', 'Moderada (2)', 'Relevante (3)', 'Alta (4)', 'Crítica / Urgente (5)'];

  const STATUS_META = {
    pending: { label: 'Em aberto', bg: '#fef3c7', color: '#92400e' },
    in_analysis: { label: 'Em análise', bg: '#dbeafe', color: '#1e40af' },
    resolved: { label: 'Resolvido', bg: '#d1fae5', color: '#065f46' },
    rejected: { label: 'Arquivado', bg: '#f3f4f6', color: '#4b5563' }
  };

  const TYPE_LABELS = {
    foco_dengue: 'Foco de Dengue / Água Parada',
    descarte_irregular: 'Descarte Irregular de Resíduos',
    terreno_baldio: 'Terreno Baldio / Mato Alto',
    esgoto_ceu_aberto: 'Esgoto / Vazamento a Céu Aberto',
    animal_ferido_silvestre: 'Animal Silvestre / Marinho Ferido',
    risco_zoonose: 'Risco de Zoonose / Saúde Animal'
  };

  function uid() {
    if (global.crypto && typeof global.crypto.randomUUID === 'function') return global.crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function pluralize(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  const rtf = (typeof Intl !== 'undefined' && Intl.RelativeTimeFormat)
    ? new Intl.RelativeTimeFormat('pt-BR', { numeric: 'auto' })
    : null;

  function relativeTime(ts) {
    const numTs = typeof ts === 'number' ? ts : Date.parse(ts) || Date.now();
    const diff = (numTs - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 45) return 'agora';
    if (!rtf) return new Date(numTs).toLocaleString('pt-BR');
    const units = [
      ['year', 31557600],
      ['month', 2629800],
      ['week', 604800],
      ['day', 86400],
      ['hour', 3600],
      ['minute', 60]
    ];
    for (let i = 0; i < units.length; i++) {
      if (abs >= units[i][1] || units[i][0] === 'minute') {
        return rtf.format(Math.round(diff / units[i][1]), units[i][0]);
      }
    }
    return '';
  }

  function readJsonStorage(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      const parsed = JSON.parse(raw);
      return parsed != null ? parsed : fallback;
    } catch {
      return fallback;
    }
  }

  function writeJsonStorage(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch {
      return false;
    }
  }

  function readFileAsDataURL(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
  }

  function loadImageElement(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  function optimizeImage(dataUrl) {
    return loadImageElement(dataUrl).then(img => {
      const w = img.naturalWidth || 800;
      const h = img.naturalHeight || 600;
      const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
      if (scale === 1 && dataUrl.length < 350000 && /^data:image\/(jpeg|webp);base64,/.test(dataUrl)) {
        return dataUrl;
      }
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(w * scale));
      canvas.height = Math.max(1, Math.round(h * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      return canvas.toDataURL('image/jpeg', IMAGE_QUALITY);
    });
  }

  function normalizeApiReport(r) {
    if (!r || typeof r !== 'object') return null;
    const createdTs = typeof r.createdAt === 'number'
      ? r.createdAt
      : (r.created_at ? Date.parse(r.created_at) : (r.date ? Date.parse(r.date + 'T12:00:00-03:00') : Date.now()));
    return {
      id: String(r.id),
      title: String(r.title || ''),
      details: String(r.description || r.details || r.title || ''),
      report_type: r.report_type || 'foco_dengue',
      rating: Math.max(1, Math.min(5, Math.round(Number(r.urgency || r.rating || 3)))),
      image: r.image_url || r.image || null,
      address: r.address || '',
      lat: Number.isFinite(Number(r.lat)) && r.lat !== null ? Number(r.lat) : null,
      lng: Number.isFinite(Number(r.lng)) && r.lng !== null ? Number(r.lng) : null,
      status: r.status || 'pending',
      confirmations: Number(r.confirmations) || (Array.isArray(r.confirmedBy) ? r.confirmedBy.length : 0),
      confirmedBy: Array.isArray(r.confirmedBy) ? r.confirmedBy : [],
      nearest_ubs: r.nearest_ubs || null,
      nearest_ecoponto: r.nearest_ecoponto || null,
      reporterName: r.reporterName || 'Morador CuidAção',
      createdAt: createdTs || Date.now(),
      offlinePending: !!r.offlinePending,
      comments: (Array.isArray(r.comments) ? r.comments : []).map(c => ({
        id: String(c.id || uid()),
        author: String(c.author || c.userName || 'Morador'),
        text: String(c.text || ''),
        createdAt: typeof c.createdAt === 'number' ? c.createdAt : (Date.parse(c.createdAt) || Date.now()),
        offlinePending: !!c.offlinePending
      }))
    };
  }

  function mount(options) {
    const cfg = Object.assign({
      apiBase: '',
      spritePrefix: 'cb-',
      selectors: {},
      getAuthToken: () => localStorage.getItem('cuidacao_token') || null,
      getCurrentUser: () => null,
      getCoordinates: () => null,
      onAuthRequired: null,
      onUnauthorized: null,
      onReportsChanged: null,
      onFocusMapPoint: null,
      notify: null
    }, options || {});

    const root = cfg.root || document;
    const $ = (sel, el) => (el || root).querySelector(sel);
    const s = cfg.selectors;

    const els = {
      form: $(s.form),
      fileInput: $(s.fileInput),
      dropzone: $(s.dropzone),
      preview: $(s.preview),
      previewImg: $(s.previewImg),
      previewChange: $(s.previewChange),
      previewRemove: $(s.previewRemove),
      typeSelect: s.typeSelect ? $(s.typeSelect) : null,
      includeCoords: s.includeCoords ? $(s.includeCoords) : null,
      details: $(s.details),
      detailsCount: $(s.detailsCount),
      rating: $(s.rating),
      ratingCaption: $(s.ratingCaption),
      error: $(s.error),
      submit: $(s.submit),
      feed: $(s.feed),
      feedEmpty: $(s.feedEmpty),
      feedCount: $(s.feedCount),
      tplPost: $(s.tplPost),
      tplComment: $(s.tplComment),
      badge: s.badge ? document.querySelector(s.badge) : null
    };

    if (!els.form || !els.feed || !els.tplPost || !els.tplComment) {
      return null;
    }

    const state = {
      posts: [],
      rating: 4,
      image: { token: 0, job: null },
      syncing: false
    };

    const stars = [];

    function notifyUser(msg, kind) {
      if (typeof cfg.notify === 'function') cfg.notify(msg, kind || 'info');
    }

    function resolveImageUrl(imgSrc) {
      if (!imgSrc) return '';
      if (imgSrc.startsWith('data:') || imgSrc.startsWith('http://') || imgSrc.startsWith('https://')) return imgSrc;
      return (cfg.apiBase || '') + (imgSrc.startsWith('/') ? imgSrc : '/' + imgSrc);
    }

    async function requestApi(path, fetchOpts = {}) {
      const token = cfg.getAuthToken();
      const headers = Object.assign({}, fetchOpts.headers || {});
      const isAuth = !!fetchOpts.auth;
      const opts = Object.assign({}, fetchOpts);
      delete opts.auth;
      if (isAuth && token) {
        headers['Authorization'] = 'Bearer ' + token;
      }
      opts.headers = headers;
      const res = await fetch((cfg.apiBase || '') + path, opts);
      if (res.status === 401 && isAuth) {
        if (typeof cfg.onUnauthorized === 'function') cfg.onUnauthorized();
      }
      return res;
    }

    function svgUse(name, extraClass) {
      const ns = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(ns, 'svg');
      const iconCls = cfg.iconClass || 'cb-icon';
      svg.setAttribute('class', iconCls + (extraClass ? ' ' + extraClass : ''));
      svg.setAttribute('aria-hidden', 'true');
      svg.setAttribute('focusable', 'false');
      const use = document.createElementNS(ns, 'use');
      use.setAttribute('href', '#' + cfg.spritePrefix + name);
      svg.appendChild(use);
      return svg;
    }

    function setTime(el, ts) {
      if (!el) return;
      const numTs = typeof ts === 'number' ? ts : (Date.parse(ts) || Date.now());
      const d = new Date(numTs);
      el.dateTime = d.toISOString();
      el.dataset.feedTs = String(numTs);
      el.title = d.toLocaleString('pt-BR');
      el.textContent = relativeTime(numTs);
    }

    function showError(msg, focusEl) {
      if (!els.error) return;
      els.error.textContent = msg;
      els.error.hidden = false;
      if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
    }

    function hideError() {
      if (!els.error) return;
      els.error.hidden = true;
      els.error.textContent = '';
    }

    function handleFile(file) {
      hideError();
      if (!file) return;
      if (!/^image\/(jpeg|png|webp|jpg)/i.test(file.type)) {
        els.fileInput.value = '';
        showError('Selecione uma imagem JPG, PNG ou WebP.', els.fileInput);
        return;
      }
      if (file.size > IMAGE_MAX_BYTES) {
        els.fileInput.value = '';
        showError('A imagem deve ter no máximo 10 MB.', els.fileInput);
        return;
      }
      const token = ++state.image.token;
      readFileAsDataURL(file)
        .then(dataUrl => {
          if (token !== state.image.token) return;
          els.previewImg.src = dataUrl;
          els.preview.hidden = false;
          els.dropzone.hidden = true;
          state.image.job = optimizeImage(dataUrl).catch(() => dataUrl);
        })
        .catch(() => {
          if (token === state.image.token) {
            showError('Não foi possível processar a imagem selecionada.', els.fileInput);
          }
        });
    }

    function clearImage() {
      state.image.token++;
      state.image.job = null;
      if (els.fileInput) els.fileInput.value = '';
      if (els.previewImg) els.previewImg.removeAttribute('src');
      if (els.preview) els.preview.hidden = true;
      if (els.dropzone) els.dropzone.hidden = false;
    }

    function buildRating() {
      const starBtnClass = cfg.starBtnClass || 'cb-star';
      els.rating.textContent = '';
      stars.length = 0;
      for (let i = 1; i <= 5; i++) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = starBtnClass;
        btn.dataset.value = String(i);
        btn.setAttribute('role', 'radio');
        btn.setAttribute('aria-checked', 'false');
        btn.setAttribute('aria-label', pluralize(i, 'estrela', 'estrelas') + ', ' + RATING_LABELS[i]);
        btn.tabIndex = i === 1 ? 0 : -1;
        btn.appendChild(svgUse('star'));
        els.rating.appendChild(btn);
        stars.push(btn);
      }
      setRating(4, false);
    }

    function paintStars(val) {
      stars.forEach((star, idx) => star.classList.toggle('is-filled', idx < val));
      if (els.ratingCaption) {
        els.ratingCaption.textContent = val ? (val + ' de 5 · ' + RATING_LABELS[val]) : RATING_LABELS[0];
      }
    }

    function setRating(val, moveFocus) {
      state.rating = val;
      stars.forEach((star, idx) => {
        const checked = idx + 1 === val;
        star.setAttribute('aria-checked', String(checked));
        star.tabIndex = (val ? checked : idx === 0) ? 0 : -1;
      });
      paintStars(val);
      if (val) {
        if (moveFocus && stars[val - 1]) stars[val - 1].focus();
        hideError();
      }
    }

    function resetComposer() {
      els.form.reset();
      clearImage();
      if (els.details) els.details.removeAttribute('aria-invalid');
      if (els.detailsCount) els.detailsCount.textContent = '0 / ' + DETAILS_MAX;
      setRating(4, false);
      hideError();
    }

    function renderStaticStars(container, rating) {
      if (!container) return;
      container.textContent = '';
      container.setAttribute('aria-label', 'Urgência/Avaliação: ' + rating + ' de 5 estrelas');
      for (let i = 1; i <= 5; i++) {
        container.appendChild(svgUse('star', i <= rating ? 'is-filled' : ''));
      }
    }

    function renderCommentNode(comment) {
      const node = els.tplComment.content.firstElementChild.cloneNode(true);
      const authorEl = $(cfg.commentAuthorSel || '.cb-comment-author', node);
      const timeEl = $(cfg.commentTimeSel || '.cb-comment-time', node);
      const textEl = $(cfg.commentTextSel || '.cb-comment-text', node);
      if (authorEl) authorEl.textContent = (comment.author || 'Morador') + (comment.offlinePending ? ' (fila offline)' : '');
      setTime(timeEl, comment.createdAt);
      if (textEl) textEl.textContent = comment.text;
      return node;
    }

    function renderPostNode(post) {
      const node = els.tplPost.content.firstElementChild.cloneNode(true);
      node.dataset.id = post.id;

      const mediaFig = $(cfg.postMediaSel || '.cb-post-media', node);
      const img = $(cfg.postImgSel || '.cb-post-img', node);
      if (post.image && img && mediaFig) {
        img.src = resolveImageUrl(post.image);
        img.alt = 'Registro comunitário: ' + (post.title || post.details).slice(0, 80);
        mediaFig.hidden = false;
      } else if (mediaFig) {
        mediaFig.hidden = true;
      }

      renderStaticStars($(cfg.starsStaticSel || '.cb-stars-static', node), post.rating);
      setTime($(cfg.postTimeSel || '.cb-post-time', node), post.createdAt);

      const detailsEl = $(cfg.postDetailsSel || '.cb-post-details', node);
      if (detailsEl) {
        detailsEl.textContent = post.details || post.title;
      }

      // Metadados One Health (tipo, autor, status, confirmação comunitária, UBS/Ecoponto próximos e link pro mapa)
      const bodyEl = $(cfg.postBodySel || '.cb-post-body', node);
      if (bodyEl) {
        const infoBar = document.createElement('div');
        infoBar.className = 'feed-extra-meta';
        infoBar.style.cssText = 'margin-top:8px;display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-size:11px;';

        const st = STATUS_META[post.status] || STATUS_META.pending;
        const stBadge = document.createElement('span');
        stBadge.style.cssText = `padding:2px 8px;border-radius:999px;font-weight:700;background:${st.bg};color:${st.color};`;
        stBadge.textContent = post.offlinePending ? '⏳ Aguardando internet' : st.label;
        infoBar.appendChild(stBadge);

        if (post.report_type && TYPE_LABELS[post.report_type]) {
          const typeBadge = document.createElement('span');
          typeBadge.style.cssText = 'padding:2px 8px;border-radius:999px;font-weight:600;background:rgba(16,185,129,0.12);color:#065f46;';
          typeBadge.textContent = TYPE_LABELS[post.report_type];
          infoBar.appendChild(typeBadge);
        }

        const authorSpan = document.createElement('span');
        authorSpan.style.cssText = 'color:#6b7280;font-weight:600;';
        authorSpan.textContent = 'Por ' + (post.reporterName || 'Morador');
        infoBar.appendChild(authorSpan);

        if (post.lat !== null && post.lng !== null) {
          const mapBtn = document.createElement('button');
          mapBtn.type = 'button';
          mapBtn.style.cssText = 'padding:2px 8px;border-radius:999px;border:1px solid #a7f3d0;background:#ecfdf5;color:#047857;font-weight:700;cursor:pointer;';
          mapBtn.textContent = '📍 Ver no mapa';
          mapBtn.addEventListener('click', () => {
            if (typeof cfg.onFocusMapPoint === 'function') {
              cfg.onFocusMapPoint(post);
            } else {
              global.location.href = './?focusLat=' + encodeURIComponent(post.lat) + '&focusLng=' + encodeURIComponent(post.lng);
            }
          });
          infoBar.appendChild(mapBtn);
        }

        // Botão de confirmação comunitária ("Eu também vi")
        if (!post.offlinePending && post.status !== 'resolved' && post.status !== 'rejected') {
          const confirmBtn = document.createElement('button');
          confirmBtn.type = 'button';
          confirmBtn.className = 'feed-confirm-btn';
          confirmBtn.dataset.reportId = post.id;
          confirmBtn.style.cssText = 'padding:2px 8px;border-radius:999px;border:1px solid #fcd34d;background:#fffbeb;color:#92400e;font-weight:700;cursor:pointer;';
          confirmBtn.textContent = '👁️ Eu também vi (' + (post.confirmations || 0) + ')';
          infoBar.appendChild(confirmBtn);
        }

        // Controles de moderação para agentes de saúde / admin (RBAC Fase 3)
        const currentUser = typeof cfg.getCurrentUser === 'function' ? cfg.getCurrentUser() : null;
        if (!post.offlinePending && currentUser && (currentUser.role === 'agent' || currentUser.role === 'admin')) {
          const modSelect = document.createElement('select');
          modSelect.className = 'feed-status-select';
          modSelect.dataset.reportId = post.id;
          modSelect.setAttribute('aria-label', 'Alterar status do alerta');
          modSelect.style.cssText = 'padding:2px 6px;border-radius:8px;border:1px solid #cbd5e1;font-size:11px;font-weight:700;background:#fff;color:#1e293b;';
          [
            ['pending', 'Status: Em aberto'],
            ['in_analysis', 'Status: Em análise'],
            ['resolved', 'Status: Resolvido'],
            ['rejected', 'Status: Arquivado']
          ].forEach(([val, label]) => {
            const opt = document.createElement('option');
            opt.value = val;
            opt.textContent = label;
            if (post.status === val) opt.selected = true;
            modSelect.appendChild(opt);
          });
          infoBar.appendChild(modSelect);
        }

        bodyEl.appendChild(infoBar);

        // Referências territoriais One Health (USAFA/UBS e Ecoponto mais próximos)
        if (post.nearest_ubs || post.nearest_ecoponto) {
          const refBox = document.createElement('div');
          refBox.style.cssText = 'margin-top:8px;padding:7px 10px;border-radius:10px;background:rgba(16,185,129,0.07);border:1px solid rgba(16,185,129,0.2);font-size:11px;color:#374151;display:flex;flex-direction:column;gap:2px;';
          if (post.nearest_ubs) {
            const p1 = document.createElement('div');
            p1.textContent = '🏥 Saúde mais próxima: ' + post.nearest_ubs.name + ' (' + post.nearest_ubs.distance_meters + ' m)';
            refBox.appendChild(p1);
          }
          if (post.nearest_ecoponto) {
            const p2 = document.createElement('div');
            p2.textContent = '♻️ Ecoponto mais próximo: ' + post.nearest_ecoponto.name + ' (' + post.nearest_ecoponto.distance_meters + ' m)';
            refBox.appendChild(p2);
          }
          bodyEl.appendChild(refBox);
        }
      }

      const inputId = (cfg.spritePrefix || 'cb-') + 'comment-' + post.id;
      const counterId = (cfg.spritePrefix || 'cb-') + 'counter-' + post.id;
      const label = $(cfg.commentLabelSel || '.cb-comment-label', node);
      const textarea = $(cfg.commentInputSel || '.cb-comment-input', node);
      const counter = $(cfg.commentCounterSel || '.cb-counter', node);
      if (label) label.htmlFor = inputId;
      if (textarea) {
        textarea.id = inputId;
        textarea.maxLength = COMMENT_MAX;
        textarea.setAttribute('aria-describedby', counterId);
      }
      if (counter) {
        counter.id = counterId;
        counter.textContent = '0 / ' + COMMENT_MAX;
      }

      const list = $(cfg.commentListSel || '.cb-comment-list', node);
      if (list) {
        post.comments.forEach(c => list.appendChild(renderCommentNode(c)));
      }
      const countEl = $(cfg.commentsCountSel || '.cb-comments-count', node);
      if (countEl) countEl.textContent = String(post.comments.length);

      return node;
    }

    function updateFeedMeta() {
      const n = state.posts.length;
      if (els.feedEmpty) els.feedEmpty.hidden = n > 0;
      if (els.feedCount) els.feedCount.textContent = n ? pluralize(n, 'publicação', 'publicações') : '';
      if (els.badge) els.badge.textContent = String(n);
    }

    function renderAll() {
      const frag = document.createDocumentFragment();
      state.posts.forEach(p => frag.appendChild(renderPostNode(p)));
      els.feed.textContent = '';
      els.feed.appendChild(frag);
      updateFeedMeta();
    }

    async function loadFromServer() {
      try {
        const res = await requestApi('/api/v1/reports');
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const json = await res.json();
        const serverPosts = (Array.isArray(json.data) ? json.data : []).map(normalizeApiReport).filter(Boolean);
        writeJsonStorage(CACHE_KEY, serverPosts);

        // Mescla eventuais itens pendentes da fila offline
        const outbox = readJsonStorage(OUTBOX_KEY, []);
        const pendingPosts = outbox
          .filter(item => item.kind === 'post')
          .map(item => normalizeApiReport(item.preview));

        state.posts = pendingPosts.concat(serverPosts);
        renderAll();
      } catch {
        const cached = readJsonStorage(CACHE_KEY, []).map(normalizeApiReport).filter(Boolean);
        const outbox = readJsonStorage(OUTBOX_KEY, []);
        const pendingPosts = outbox
          .filter(item => item.kind === 'post')
          .map(item => normalizeApiReport(item.preview));
        state.posts = pendingPosts.concat(cached);
        renderAll();
      }
    }

    function enqueueOfflineItem(item) {
      const outbox = readJsonStorage(OUTBOX_KEY, []);
      outbox.push(item);
      writeJsonStorage(OUTBOX_KEY, outbox);
    }

    async function flushOutbox() {
      if (state.syncing) return;
      const token = cfg.getAuthToken();
      if (!token) return;
      const outbox = readJsonStorage(OUTBOX_KEY, []);
      if (!Array.isArray(outbox) || outbox.length === 0) return;

      state.syncing = true;
      const remaining = [];
      let syncedCount = 0;

      for (const item of outbox) {
        try {
          if (item.kind === 'post') {
            const res = await requestApi('/api/v1/reports', {
              method: 'POST',
              auth: true,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(item.payload)
            });
            if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
              if (res.ok) syncedCount++;
            } else {
              remaining.push(item);
            }
          } else if (item.kind === 'comment') {
            const res = await requestApi('/api/v1/reports/' + encodeURIComponent(item.reportId) + '/comments', {
              method: 'POST',
              auth: true,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: item.text })
            });
            if (res.ok || (res.status >= 400 && res.status < 500 && res.status !== 429)) {
              if (res.ok) syncedCount++;
            } else {
              remaining.push(item);
            }
          }
        } catch {
          remaining.push(item);
        }
      }

      writeJsonStorage(OUTBOX_KEY, remaining);
      state.syncing = false;

      if (syncedCount > 0) {
        notifyUser(pluralize(syncedCount, 'registro pendente sincronizado', 'registros pendentes sincronizados') + ' com o servidor!', 'success');
        await loadFromServer();
        if (typeof cfg.onReportsChanged === 'function') cfg.onReportsChanged();
      }
    }

    // Eventos de arquivo e estrelas
    if (els.fileInput) {
      els.fileInput.addEventListener('change', () => {
        handleFile(els.fileInput.files && els.fileInput.files[0]);
      });
    }
    if (els.previewChange) els.previewChange.addEventListener('click', () => els.fileInput && els.fileInput.click());
    if (els.previewRemove) {
      els.previewRemove.addEventListener('click', () => {
        clearImage();
        if (els.fileInput) els.fileInput.focus();
      });
    }
    if (els.dropzone) {
      ['dragenter', 'dragover'].forEach(type => {
        els.dropzone.addEventListener(type, e => {
          e.preventDefault();
          els.dropzone.classList.add('is-dragover');
        });
      });
      ['dragleave', 'drop'].forEach(type => {
        els.dropzone.addEventListener(type, () => els.dropzone.classList.remove('is-dragover'));
      });
      els.dropzone.addEventListener('drop', e => {
        e.preventDefault();
        const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        handleFile(f);
      });
    }

    if (els.details) {
      els.details.addEventListener('input', () => {
        if (els.detailsCount) els.detailsCount.textContent = els.details.value.length + ' / ' + DETAILS_MAX;
        if (els.details.value.trim()) {
          els.details.removeAttribute('aria-invalid');
          hideError();
        }
      });
    }

    els.rating.addEventListener('click', e => {
      const star = e.target.closest('button[role="radio"]');
      if (star) setRating(Number(star.dataset.value), false);
    });
    els.rating.addEventListener('pointerover', e => {
      if (e.pointerType !== 'mouse') return;
      const star = e.target.closest('button[role="radio"]');
      if (star) paintStars(Number(star.dataset.value));
    });
    els.rating.addEventListener('pointerleave', () => paintStars(state.rating));
    els.rating.addEventListener('keydown', e => {
      const cur = state.rating || 0;
      let next = null;
      if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = Math.min(5, cur + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = Math.max(1, cur - 1);
      else if (e.key === 'Home') next = 1;
      else if (e.key === 'End') next = 5;
      if (next !== null) {
        e.preventDefault();
        setRating(next, true);
      }
    });

    // Submissão de nova publicação comunitária (imagem opcional + alerta textual rápido)
    els.form.addEventListener('submit', async e => {
      e.preventDefault();
      hideError();

      const token = cfg.getAuthToken();
      if (!token) {
        showError('Faça login na sua conta CuidAção para publicar um alerta na comunidade.');
        if (typeof cfg.onAuthRequired === 'function') cfg.onAuthRequired();
        return;
      }

      const details = (els.details ? els.details.value : '').trim();
      if (details.length < 3) {
        if (els.details) els.details.setAttribute('aria-invalid', 'true');
        showError('Descreva o evento ou alerta (mínimo de 3 caracteres).', els.details);
        return;
      }
      if (details.length > DETAILS_MAX) {
        if (els.details) els.details.setAttribute('aria-invalid', 'true');
        showError('A descrição deve ter no máximo ' + DETAILS_MAX + ' caracteres.', els.details);
        return;
      }
      if (state.rating < 1 || state.rating > 5) {
        showError('Selecione a urgência/avaliação de 1 a 5 estrelas.', stars[0]);
        return;
      }

      els.submit.disabled = true;
      const origLabel = els.submit.textContent;
      els.submit.textContent = 'Publicando...';

      try {
        const imageData = state.image.job ? await state.image.job : null;
        const firstLine = details.split(/\r?\n/)[0].trim();
        const derivedTitle = firstLine.length >= 3 ? firstLine.slice(0, 100) : ('Alerta Comunitário: ' + details.slice(0, 80));
        const reportType = (els.typeSelect && els.typeSelect.value) ? els.typeSelect.value : 'foco_dengue';

        let coords = null;
        const wantCoords = !els.includeCoords || els.includeCoords.checked;
        if (wantCoords && typeof cfg.getCoordinates === 'function') {
          coords = cfg.getCoordinates();
        }

        const payload = {
          title: derivedTitle,
          description: details,
          report_type: reportType,
          urgency: state.rating,
          address: (coords && coords.address) ? coords.address : 'Comunidade Guarujá/SP',
          lat: (coords && Number.isFinite(coords.lat)) ? coords.lat : null,
          lng: (coords && Number.isFinite(coords.lng)) ? coords.lng : null,
          image: imageData
        };

        try {
          const res = await requestApi('/api/v1/reports', {
            method: 'POST',
            auth: true,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          if (res.status === 401) return;
          const json = await res.json();

          if (res.status === 409 && json.duplicate_of) {
            // Deduplicação inteligente (Fase 3): sugere confirmar alerta existente a menos de 50m
            notifyUser(json.message || 'Já existe um alerta aberto deste tipo a menos de 50m. Confirmando foco existente!', 'info');
            await confirmExistingReport(json.duplicate_of.id);
            resetComposer();
            return;
          }

          if (!res.ok) {
            showError(json.error || 'Não foi possível publicar o alerta.');
            return;
          }

          const created = normalizeApiReport(json.report);
          state.posts.unshift(created);
          writeJsonStorage(CACHE_KEY, state.posts.filter(p => !p.offlinePending));
          renderAll();
          resetComposer();
          notifyUser('Alerta publicado com sucesso!', 'success');
          if (typeof cfg.onReportsChanged === 'function') cfg.onReportsChanged(created);
        } catch {
          // Offline fallback: salva na fila local e exibe imediatamente
          const user = (typeof cfg.getCurrentUser === 'function' && cfg.getCurrentUser()) || { name: 'Você' };
          const preview = {
            id: 'offline-' + uid(),
            title: derivedTitle,
            description: details,
            report_type: reportType,
            urgency: state.rating,
            image: imageData,
            address: payload.address,
            lat: payload.lat,
            lng: payload.lng,
            reporterName: user.name,
            createdAt: Date.now(),
            offlinePending: true,
            comments: []
          };
          enqueueOfflineItem({ kind: 'post', payload, preview });
          state.posts.unshift(normalizeApiReport(preview));
          renderAll();
          resetComposer();
          notifyUser('Sem internet: alerta salvo na fila local e será enviado automaticamente quando voltar online.', 'info');
        }
      } finally {
        els.submit.disabled = false;
        els.submit.textContent = origLabel;
      }
    });

    async function confirmExistingReport(reportId) {
      const token = cfg.getAuthToken();
      if (!token) {
        notifyUser('Faça login para confirmar que você também viu este foco.', 'info');
        if (typeof cfg.onAuthRequired === 'function') cfg.onAuthRequired();
        return;
      }
      try {
        const res = await requestApi('/api/v1/reports/' + encodeURIComponent(reportId) + '/confirm', {
          method: 'POST',
          auth: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({})
        });
        if (res.status === 401) return;
        const json = await res.json();
        if (res.ok && json.report) {
          const updated = normalizeApiReport(json.report);
          state.posts = state.posts.map(p => p.id === updated.id ? updated : p);
          renderAll();
          notifyUser(json.message || 'Confirmação comunitária registrada!', 'success');
          if (typeof cfg.onReportsChanged === 'function') cfg.onReportsChanged(updated);
        } else {
          notifyUser(json.error || 'Não foi possível confirmar este alerta.', 'info');
        }
      } catch {
        notifyUser('Sem conexão para registrar confirmação no momento.', 'error');
      }
    }

    // Delegação no feed: comentários, confirmação comunitária e moderação de status
    els.feed.addEventListener('click', e => {
      const confirmBtn = e.target.closest('.feed-confirm-btn');
      if (confirmBtn && confirmBtn.dataset.reportId) {
        confirmExistingReport(confirmBtn.dataset.reportId);
      }
    });

    els.feed.addEventListener('change', async e => {
      const select = e.target;
      if (!select.classList || !select.classList.contains('feed-status-select')) return;
      const reportId = select.dataset.reportId;
      const newStatus = select.value;
      try {
        const res = await requestApi('/api/v1/reports/' + encodeURIComponent(reportId) + '/status', {
          method: 'PATCH',
          auth: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ status: newStatus })
        });
        const json = await res.json();
        if (res.ok && json.report) {
          const updated = normalizeApiReport(json.report);
          state.posts = state.posts.map(p => p.id === updated.id ? updated : p);
          renderAll();
          notifyUser('Status atualizado para: ' + (STATUS_META[newStatus] ? STATUS_META[newStatus].label : newStatus), 'success');
          if (typeof cfg.onReportsChanged === 'function') cfg.onReportsChanged(updated);
        } else {
          notifyUser(json.error || 'Sem permissão para alterar status.', 'error');
          loadFromServer();
        }
      } catch {
        notifyUser('Erro de conexão ao atualizar status.', 'error');
      }
    });

    const inputSelClass = (cfg.commentInputSel || '.cb-comment-input').replace(/^\./, '');
    const formSelClass = (cfg.commentFormSel || '.cb-comment-form').replace(/^\./, '');
    const postItemSel = cfg.postItemSel || '.cb-post';

    function setCommentError(form, msg) {
      const errEl = $(cfg.commentErrorSel || '.cb-comment-error', form);
      const ta = $(cfg.commentInputSel || '.cb-comment-input', form);
      if (errEl) errEl.textContent = msg || '';
      form.classList.toggle('has-error', !!msg);
      if (ta) {
        if (msg) ta.setAttribute('aria-invalid', 'true');
        else ta.removeAttribute('aria-invalid');
      }
    }

    function updateCommentCounter(ta) {
      const form = ta.form;
      const len = ta.value.length;
      const counter = $(cfg.commentCounterSel || '.cb-counter', form);
      if (counter) {
        counter.textContent = len + ' / ' + COMMENT_MAX;
        counter.classList.toggle('is-limit', len >= COMMENT_MAX);
      }
      form.classList.toggle('is-ready', ta.value.trim().length > 0 && len <= COMMENT_MAX);
    }

    els.feed.addEventListener('input', e => {
      const ta = e.target;
      if (!ta.classList || !ta.classList.contains(inputSelClass)) return;
      updateCommentCounter(ta);
      if (ta.value.trim()) setCommentError(ta.form, '');
    });

    els.feed.addEventListener('submit', async e => {
      const form = e.target;
      if (!form.classList || !form.classList.contains(formSelClass)) return;
      e.preventDefault();

      const token = cfg.getAuthToken();
      if (!token) {
        setCommentError(form, 'Entre na sua conta para comentar.');
        if (typeof cfg.onAuthRequired === 'function') cfg.onAuthRequired();
        return;
      }

      const ta = $(cfg.commentInputSel || '.cb-comment-input', form);
      const raw = ta ? ta.value : '';
      const text = raw.trim();

      if (!text) {
        setCommentError(form, 'Escreva um comentário antes de enviar.');
        if (ta) ta.focus();
        return;
      }
      if (raw.length > COMMENT_MAX || text.length > COMMENT_MAX) {
        setCommentError(form, 'Máximo de ' + COMMENT_MAX + ' caracteres.');
        if (ta) ta.focus();
        return;
      }

      const postEl = form.closest(postItemSel);
      const post = postEl ? state.posts.find(p => p.id === postEl.dataset.id) : null;
      if (!post) return;

      try {
        const res = await requestApi('/api/v1/reports/' + encodeURIComponent(post.id) + '/comments', {
          method: 'POST',
          auth: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text })
        });
        if (res.status === 401) return;
        const json = await res.json();
        if (!res.ok) {
          setCommentError(form, json.error || 'Erro ao enviar comentário.');
          return;
        }
        const savedComment = json.comment;
        post.comments.unshift(savedComment);
        writeJsonStorage(CACHE_KEY, state.posts.filter(p => !p.offlinePending));
        const list = $(cfg.commentListSel || '.cb-comment-list', postEl);
        if (list) list.insertBefore(renderCommentNode(savedComment), list.firstChild);
        const countEl = $(cfg.commentsCountSel || '.cb-comments-count', postEl);
        if (countEl) countEl.textContent = String(post.comments.length);
        ta.value = '';
        setCommentError(form, '');
        updateCommentCounter(ta);
      } catch {
        const user = (typeof cfg.getCurrentUser === 'function' && cfg.getCurrentUser()) || { name: 'Morador' };
        const pendingComment = { id: 'offline-c-' + uid(), author: user.name, text, createdAt: Date.now(), offlinePending: true };
        if (!post.offlinePending) {
          enqueueOfflineItem({ kind: 'comment', reportId: post.id, text });
        }
        post.comments.unshift(pendingComment);
        const list = $(cfg.commentListSel || '.cb-comment-list', postEl);
        if (list) list.insertBefore(renderCommentNode(pendingComment), list.firstChild);
        const countEl = $(cfg.commentsCountSel || '.cb-comments-count', postEl);
        if (countEl) countEl.textContent = String(post.comments.length);
        ta.value = '';
        setCommentError(form, '');
        updateCommentCounter(ta);
        notifyUser('Comentário salvo offline e será sincronizado automaticamente.', 'info');
      }
    });

    global.addEventListener('online', () => {
      flushOutbox().then(() => loadFromServer());
    });

    buildRating();
    loadFromServer().then(() => flushOutbox());

    setInterval(() => {
      root.querySelectorAll('time[data-feed-ts]').forEach(el => {
        el.textContent = relativeTime(Number(el.dataset.feedTs));
      });
    }, 60000);

    return {
      reload: loadFromServer,
      flushOutbox,
      getPosts: () => state.posts.slice()
    };
  }

  global.CuidacaoCommunityFeed = Object.freeze({ mount });
})(window);
