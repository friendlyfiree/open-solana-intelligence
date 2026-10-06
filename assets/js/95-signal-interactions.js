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
  // The panel is an explanatory example, so it shows readable labels that
  // carry their own condition instead of raw codes that read as live proof.
  var SIGNAL_LABELS = {
    WALLET_SIGNED: 'Wallet-signed and server-verified',
    REVIEW_QUORUM: 'Independent review quorum reached',
    CHALLENGE_WINDOW: 'Seven-day challenge window open',
    MEMO_ANCHORED: 'Memo-anchored, only after the transaction confirms',
    SOL_TRANSFER_VERIFIED: 'SOL transfer, only after RPC verification'
  };
  function signalLabel(index) {
    var key = SIGNAL_STATES[index];
    var text = SIGNAL_LABELS[key] || key;
    return typeof window.osiT === 'function' ? window.osiT(text) : text;
  }

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

  // One pass through the example, then rest on the first step: a calm,
  // single orchestrated moment rather than a loop for the whole visit.
  var signalPlayed = false;
  function advanceSignalSequence() {
    stopSignalSequence();
    if (!signalText || reduceMotion.matches || document.hidden) return;
    signalIndex = (signalIndex + 1) % SIGNAL_STATES.length;
    signalText.classList.remove('is-changing');
    window.requestAnimationFrame(function () {
      signalText.textContent = signalLabel(signalIndex);
      signalText.classList.add('is-changing');
    });
    if (signalIndex === 0) { signalPlayed = true; return; }
    signalTimer = window.setTimeout(advanceSignalSequence, SIGNAL_TIMING.step);
  }

  function syncSignalSequence() {
    stopSignalSequence();
    if (!signalText) return;
    if (reduceMotion.matches || signalPlayed) {
      signalIndex = 0;
      signalText.textContent = signalLabel(0);
      signalText.classList.remove('is-changing');
      return;
    }
    signalText.textContent = signalLabel(signalIndex);
    signalTimer = window.setTimeout(advanceSignalSequence, SIGNAL_TIMING.step);
  }
  window.addEventListener('osi:localechange', function () { if (signalText) signalText.textContent = signalLabel(signalIndex); });

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
