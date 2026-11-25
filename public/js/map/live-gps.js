/**
 * =====================================================================================
 * CuidAção — Módulo de GPS em tempo real (alta precisão) + animação suave de marcador
 * -------------------------------------------------------------------------------------
 * - Usa navigator.geolocation.watchPosition() com { enableHighAccuracy, maximumAge: 0, timeout: 5000 }.
 * - Não conhece o resto do app: comunica-se apenas por callbacks (onPosition, onError, onStatusChange).
 * - Pausa o GPS quando a aba/app vai para segundo plano (economia de bateria) e retoma ao voltar.
 * - Se a permissão for liberada depois de negada (Permissions API), volta a rastrear sozinho.
 *
 * Exposto em window.CuidacaoLiveGps:
 *   createTracker(options)              -> { start, stop, getLastFix, getState, isActive }
 *   animateMarkerTo(marker, latLng, o)  -> move um L.Marker suavemente até a nova coordenada
 *   cancelMarkerAnimation(marker)
 *   GPS_OPTIONS
 * =====================================================================================
 */
(function (global) {
  'use strict';

  const GPS_OPTIONS = Object.freeze({
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 5000
  });

  // Códigos de GeolocationPositionError -> nomes legíveis
  const ERROR_KINDS = { 1: 'permission-denied', 2: 'unavailable', 3: 'timeout' };

  /**
   * Estados possíveis do rastreador:
   *  idle        – parado
   *  waiting     – watch ativo, aguardando a 1ª leitura
   *  tracking    – recebendo posições
   *  paused      – parado temporariamente (aba em segundo plano)
   *  denied      – usuário negou/bloqueou a permissão
   *  insecure    – página fora de HTTPS/localhost (navegador bloqueia o GPS)
   *  unsupported – aparelho/navegador sem Geolocation API
   */
  function createTracker(options) {
    const opts = Object.assign({
      onPosition: null,
      onError: null,
      onStatusChange: null,
      pauseWhenHidden: true
    }, options || {});

    let watchId = null;
    let lastFix = null;
    let state = 'idle';
    let resumeWhenVisible = false;

    function setState(next) {
      if (next === state) return;
      state = next;
      if (typeof opts.onStatusChange === 'function') opts.onStatusChange(state);
    }

    function emitError(kind, nativeError) {
      if (typeof opts.onError === 'function') {
        opts.onError({
          kind: kind,
          code: nativeError ? nativeError.code : null,
          message: nativeError ? nativeError.message : ''
        });
      }
    }

    function clearWatch() {
      if (watchId !== null && global.navigator && global.navigator.geolocation) {
        global.navigator.geolocation.clearWatch(watchId);
      }
      watchId = null;
    }

    function handleSuccess(position) {
      const c = position && position.coords;
      if (!c || !Number.isFinite(c.latitude) || !Number.isFinite(c.longitude)) return;

      lastFix = {
        lat: c.latitude,
        lng: c.longitude,
        accuracy: Number.isFinite(c.accuracy) ? c.accuracy : null,
        heading: Number.isFinite(c.heading) ? c.heading : null,
        speed: Number.isFinite(c.speed) ? c.speed : null,
        timestamp: position.timestamp || Date.now()
      };
      setState('tracking');
      if (typeof opts.onPosition === 'function') opts.onPosition(Object.assign({}, lastFix));
    }

    function handleError(err) {
      const kind = ERROR_KINDS[err && err.code] || 'unavailable';

      if (kind === 'permission-denied') {
        // Sem permissão não adianta continuar o watch
        clearWatch();
        const insecure = global.isSecureContext === false;
        setState(insecure ? 'insecure' : 'denied');
        emitError(insecure ? 'insecure' : 'permission-denied', err);
        return;
      }

      // 'timeout' e 'unavailable' não encerram o watchPosition: o navegador continua tentando.
      if (!lastFix) setState('waiting');
      emitError(kind, err);
    }

    function start() {
      if (!global.navigator || !('geolocation' in global.navigator)) {
        setState('unsupported');
        emitError('unsupported', null);
        return false;
      }
      // Navegadores só liberam GPS em HTTPS ou localhost (ex.: http://192.168.x.x é bloqueado)
      if (global.isSecureContext === false) {
        setState('insecure');
        emitError('insecure', null);
        return false;
      }
      if (watchId !== null) return true;

      resumeWhenVisible = false;
      setState(lastFix ? 'tracking' : 'waiting');
      watchId = global.navigator.geolocation.watchPosition(handleSuccess, handleError, GPS_OPTIONS);
      return true;
    }

    function stop() {
      clearWatch();
      resumeWhenVisible = false;
      setState('idle');
    }

    // Economia de bateria: desliga o GPS com a aba/app em segundo plano e religa ao voltar
    if (opts.pauseWhenHidden && typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          if (watchId !== null) {
            clearWatch();
            resumeWhenVisible = true;
            setState('paused');
          }
        } else if (resumeWhenVisible) {
          start();
        }
      });
    }

    // Se o usuário liberar a permissão nas configurações depois de ter negado, retoma sozinho
    try {
      if (global.navigator && global.navigator.permissions && global.navigator.permissions.query) {
        global.navigator.permissions.query({ name: 'geolocation' }).then(function (status) {
          status.onchange = function () {
            if (status.state === 'granted' && state === 'denied') start();
          };
        }).catch(function () { /* Permissions API indisponível (ex.: Safari antigo) */ });
      }
    } catch (e) {
      // Ignora: recurso opcional
    }

    return {
      start: start,
      stop: stop,
      getLastFix: function () { return lastFix ? Object.assign({}, lastFix) : null; },
      getState: function () { return state; },
      isActive: function () { return watchId !== null; }
    };
  }

  // ===================================================================================
  // Animação suave de marcador Leaflet (interpolação com requestAnimationFrame)
  // ===================================================================================
  const runningAnimations = new WeakMap();

  function prefersReducedMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function easeOutCubic(t) {
    return 1 - Math.pow(1 - t, 3);
  }

  function cancelMarkerAnimation(marker) {
    const anim = marker && runningAnimations.get(marker);
    if (anim) {
      global.cancelAnimationFrame(anim.frame);
      runningAnimations.delete(marker);
    }
  }

  /**
   * Move o marcador até `target` ({lat, lng} ou L.LatLng) em `duration` ms.
   * Saltos muito grandes (> maxAnimatedDistance metros), aba oculta ou "reduzir movimento"
   * fazem a troca ser instantânea. `onStep(latLng)` é chamado a cada quadro (ex.: mover o círculo de precisão).
   */
  function animateMarkerTo(marker, target, options) {
    if (!marker || !target || typeof global.L === 'undefined') return;
    const o = Object.assign({ duration: 900, maxAnimatedDistance: 2000, onStep: null }, options || {});

    cancelMarkerAnimation(marker);

    const from = marker.getLatLng();
    const to = global.L.latLng(target.lat, target.lng);
    const distance = from.distanceTo(to);
    const notify = function (ll) { if (typeof o.onStep === 'function') o.onStep(ll); };

    const instant = o.duration <= 0 || distance < 0.3 || distance > o.maxAnimatedDistance ||
      prefersReducedMotion() || (typeof document !== 'undefined' && document.hidden);
    if (instant) {
      marker.setLatLng(to);
      notify(to);
      return;
    }

    const startedAt = global.performance.now();
    const anim = { frame: 0 };

    function step(now) {
      const t = Math.min(1, (now - startedAt) / o.duration);
      const k = easeOutCubic(t);
      const current = global.L.latLng(
        from.lat + (to.lat - from.lat) * k,
        from.lng + (to.lng - from.lng) * k
      );
      marker.setLatLng(current);
      notify(current);
      if (t < 1) {
        anim.frame = global.requestAnimationFrame(step);
      } else {
        runningAnimations.delete(marker);
      }
    }

    anim.frame = global.requestAnimationFrame(step);
    runningAnimations.set(marker, anim);
  }

  global.CuidacaoLiveGps = Object.freeze({
    GPS_OPTIONS: GPS_OPTIONS,
    createTracker: createTracker,
    animateMarkerTo: animateMarkerTo,
    cancelMarkerAnimation: cancelMarkerAnimation
  });
})(window);
