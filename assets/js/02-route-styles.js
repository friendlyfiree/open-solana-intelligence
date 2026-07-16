(function () {
  'use strict';

  var selector = 'link[data-osi-route-style]';
  var activated = false;

  function isHomeRoute() {
    var hash = window.location.hash.replace(/^#/, '').toLowerCase();
    return !hash || hash === 'home' || hash === 'registry';
  }

  function activateRouteStyles() {
    if (activated) return;
    activated = true;
    Array.prototype.forEach.call(document.querySelectorAll(selector), function (link) {
      link.setAttribute('media', 'all');
    });
  }

  if (!isHomeRoute()) activateRouteStyles();
  window.addEventListener('hashchange', function () {
    if (!isHomeRoute()) activateRouteStyles();
  });
  window.addEventListener('pointerdown', activateRouteStyles, { once: true, capture: true, passive: true });
  window.addEventListener('keydown', activateRouteStyles, { once: true, capture: true });
  window.osiActivateRouteStyles = activateRouteStyles;
})();
