/**
 * =====================================================================================
 * CuidAção — Camada Leaflet de farmácias
 * -------------------------------------------------------------------------------------
 * Recebe uma lista no formato { id, nome, endereco, latitude, longitude, temFarmaciaPopular }
 * e devolve um L.LayerGroup com:
 *  - marcador próprio (pino branco com cruz verde; selo "FP" azul para o Farmácia Popular);
 *  - popup com nome, endereço, participação no Programa Farmácia Popular,
 *    distância até o usuário (opcional) e link "Como chegar".
 *
 * Exposto em window.CuidacaoPharmacyLayer:
 *   create(pharmacies, { getUserPosition?: () => ({lat, lng}) | null, isMockData?: boolean })
 *   buildPopupHtml(pharmacy, options)
 * =====================================================================================
 */
(function (global) {
  'use strict';

  const CROSS_SVG =
    '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">' +
      '<path fill="currentColor" d="M9 3h6v6h6v6h-6v6H9v-6H3V9h6z"/>' +
    '</svg>';

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function isValidPharmacy(p) {
    return p && typeof p.nome === 'string' &&
      Number.isFinite(p.latitude) && Number.isFinite(p.longitude) &&
      Math.abs(p.latitude) <= 90 && Math.abs(p.longitude) <= 180;
  }

  function formatDistance(meters) {
    if (!Number.isFinite(meters)) return '';
    return meters < 1000 ? Math.round(meters) + ' m' : (meters / 1000).toFixed(1).replace('.', ',') + ' km';
  }

  function buildIcon(pharmacy) {
    const popular = pharmacy.temFarmaciaPopular === true;
    return global.L.divIcon({
      className: 'pharmacy-marker',
      html:
        '<div class="pharmacy-pin' + (popular ? ' pharmacy-pin--popular' : '') + '">' +
          '<div class="pharmacy-pin__body"><span class="pharmacy-pin__cross">' + CROSS_SVG + '</span></div>' +
          (popular ? '<span class="pharmacy-pin__badge" title="Farmácia Popular">FP</span>' : '') +
        '</div>',
      iconSize: [34, 44],
      iconAnchor: [17, 41],   // ponta do pino
      popupAnchor: [0, -38]
    });
  }

  function buildPopupHtml(pharmacy, options) {
    const o = options || {};
    const popular = pharmacy.temFarmaciaPopular === true;

    let distanceHtml = '';
    if (typeof o.getUserPosition === 'function') {
      const user = o.getUserPosition();
      if (user && Number.isFinite(user.lat) && Number.isFinite(user.lng)) {
        const meters = global.L.latLng(user.lat, user.lng).distanceTo([pharmacy.latitude, pharmacy.longitude]);
        distanceHtml = '<p class="pharmacy-popup__distance">📏 A ' + formatDistance(meters) + ' de você (em linha reta)</p>';
      }
    }

    const statusHtml = popular
      ? '<span class="pharmacy-popup__status pharmacy-popup__status--yes">✔ Participa do Programa Farmácia Popular</span>'
      : '<span class="pharmacy-popup__status pharmacy-popup__status--no">✖ Não participa do Programa Farmácia Popular</span>';

    const directionsUrl = 'https://www.google.com/maps/dir/?api=1&destination=' +
      encodeURIComponent(pharmacy.latitude + ',' + pharmacy.longitude);

    return (
      '<div class="pharmacy-popup">' +
        '<p class="pharmacy-popup__kicker">💊 Farmácia</p>' +
        '<h3 class="pharmacy-popup__title">' + escapeHtml(pharmacy.nome) + '</h3>' +
        '<p class="pharmacy-popup__address">📍 ' + escapeHtml(pharmacy.endereco || 'Endereço não informado') + '</p>' +
        statusHtml +
        distanceHtml +
        '<a class="pharmacy-popup__link" href="' + directionsUrl + '" target="_blank" rel="noopener noreferrer">🧭 Como chegar</a>' +
        (o.isMockData !== false ? '<p class="pharmacy-popup__note">Dados fictícios para demonstração (TCC).</p>' : '') +
      '</div>'
    );
  }

  function create(pharmacies, options) {
    if (typeof global.L === 'undefined') throw new Error('Leaflet (L) não foi carregado.');
    const o = options || {};
    const group = global.L.layerGroup();

    (Array.isArray(pharmacies) ? pharmacies : []).forEach(function (pharmacy) {
      if (!isValidPharmacy(pharmacy)) {
        console.warn('[CuidAção] Farmácia ignorada (dados inválidos):', pharmacy);
        return;
      }
      const marker = global.L.marker([pharmacy.latitude, pharmacy.longitude], {
        icon: buildIcon(pharmacy),
        title: pharmacy.nome,
        alt: 'Farmácia ' + pharmacy.nome,
        keyboard: true,
        riseOnHover: true,
        zIndexOffset: 400
      });
      // Conteúdo gerado na abertura: a distância usa a posição mais recente do usuário
      marker.bindPopup(function () { return buildPopupHtml(pharmacy, o); }, {
        className: 'pharmacy-popup-wrapper',
        maxWidth: 270,
        minWidth: 220
      });
      marker.pharmacyId = pharmacy.id;
      group.addLayer(marker);
    });

    return group;
  }

  global.CuidacaoPharmacyLayer = Object.freeze({
    create: create,
    buildPopupHtml: buildPopupHtml
  });
})(window);
