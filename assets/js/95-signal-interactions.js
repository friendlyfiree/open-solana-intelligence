(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  var finePointer = window.matchMedia('(hover: hover) and (pointer: fine)');
  var hero = document.querySelector('.osi-home-hero');
  var signalText = document.getElementById('osi-hero-signal-text');
  var frame = 0;
  var pendingPoint = null;
  var signalTimer = 0;
  var signalIndex = 0;

  /* ----------------------------------------------------------------------
   * HOME SIGNAL STORYBOARD
   *
   *    0ms   primary navigation and Case CTA are already interactive
   * 2200ms   explanatory proof label advances to the next lifecycle state
   * 4400ms   sequence continues without hiding or delaying page content
   * reduced  sequence stays static; the lifecycle remains fully readable
   * ---------------------------------------------------------------------- */
  var SIGNAL_TIMING = { step: 2200 };
  var SIGNAL_STATES = [
    'WALLET_SIGNED',
    'REVIEW_QUORUM',
    'CHALLENGE_WINDOW',
    'MEMO_ANCHORED',
    'SOL_TRANSFER_VERIFIED'
  ];

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

  function stopSignalSequence() {
    if (signalTimer) window.clearTimeout(signalTimer);
    signalTimer = 0;
  }

  function advanceSignalSequence() {
    stopSignalSequence();
    if (!signalText || reduceMotion.matches || document.hidden) return;
    signalIndex = (signalIndex + 1) % SIGNAL_STATES.length;
    signalText.classList.remove('is-changing');
    window.requestAnimationFrame(function () {
      signalText.textContent = SIGNAL_STATES[signalIndex];
      signalText.classList.add('is-changing');
    });
    signalTimer = window.setTimeout(advanceSignalSequence, SIGNAL_TIMING.step);
  }

  function syncSignalSequence() {
    stopSignalSequence();
    if (!signalText) return;
    if (reduceMotion.matches) {
      signalIndex = 0;
      signalText.textContent = SIGNAL_STATES[0];
      signalText.classList.remove('is-changing');
      return;
    }
    signalTimer = window.setTimeout(advanceSignalSequence, SIGNAL_TIMING.step);
  }

  function revealSections() {
    var sections = Array.prototype.slice.call(document.querySelectorAll('[data-signal-reveal]'));
    if (!sections.length) return;
    if (reduceMotion.matches || !('IntersectionObserver' in window)) {
      sections.forEach(function (section) { section.classList.add('is-visible'); });
      document.documentElement.classList.add('osi-signal-ready');
      return;
    }
    try {
      var observer = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          observer.unobserve(entry.target);
        });
      }, { threshold: .12, rootMargin: '0px 0px -8% 0px' });
      sections.forEach(function (section) { observer.observe(section); });
      document.documentElement.classList.add('osi-signal-ready');
    } catch (error) {
      sections.forEach(function (section) { section.classList.add('is-visible'); });
      document.documentElement.classList.remove('osi-signal-ready');
    }
  }

  function watchPreference(query, handler) {
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', handler);
      return;
    }
    if (typeof query.addListener === 'function') query.addListener(handler);
  }

  if (hero) {
    hero.addEventListener('pointermove', onPointerMove, { passive: true });
    hero.addEventListener('pointerleave', resetPointer, { passive: true });
  }
  watchPreference(reduceMotion, function () { resetPointer(); syncSignalSequence(); });
  watchPreference(finePointer, resetPointer);
  document.addEventListener('visibilitychange', syncSignalSequence);
  revealSections();
  syncSignalSequence();
})();
