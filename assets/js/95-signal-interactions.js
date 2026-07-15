(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  var hero = document.querySelector('.osi-home-hero');
  var frame = 0;
  var pendingPoint = null;

  function paintPointer() {
    frame = 0;
    if (!hero || !pendingPoint) return;
    var rect = hero.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    var x = Math.max(0, Math.min(100, ((pendingPoint.x - rect.left) / rect.width) * 100));
    var y = Math.max(0, Math.min(100, ((pendingPoint.y - rect.top) / rect.height) * 100));
    hero.style.setProperty('--pointer-x', x.toFixed(2) + '%');
    hero.style.setProperty('--pointer-y', y.toFixed(2) + '%');
  }

  function onPointerMove(event) {
    if (reduceMotion.matches || !finePointer.matches) return;
    pendingPoint = { x: event.clientX, y: event.clientY };
    if (!frame) frame = window.requestAnimationFrame(paintPointer);
  }

  function resetPointer() {
    pendingPoint = null;
    if (frame) window.cancelAnimationFrame(frame);
    frame = 0;
    if (!hero) return;
    hero.style.removeProperty('--pointer-x');
    hero.style.removeProperty('--pointer-y');
  }

  function revealSections() {
    var sections = Array.prototype.slice.call(document.querySelectorAll('[data-signal-reveal]'));
    if (!sections.length) return;
    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      sections.forEach(function (section) { section.classList.add('is-visible'); });
      return;
    }
    var observer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        observer.unobserve(entry.target);
      });
    }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
    sections.forEach(function (section) { observer.observe(section); });
  }

  function watchPreference(query) {
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', resetPointer);
      return;
    }
    if (typeof query.addListener === 'function') query.addListener(resetPointer);
  }

  if (hero) {
    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', resetPointer, { passive: true });
  }
  watchPreference(reduceMotion);
  watchPreference(finePointer);
  document.documentElement.classList.add('osi-signal-ready');
  revealSections();
})();
