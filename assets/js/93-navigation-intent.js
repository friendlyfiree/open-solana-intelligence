(function (root, factory) {
  'use strict';
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OSINavIntent = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  function create(options) {
    var opts = options || {};
    var openDelay = Number.isFinite(opts.openDelay) ? opts.openDelay : 100;
    var closeDelay = Number.isFinite(opts.closeDelay) ? opts.closeDelay : 220;
    var setTimer = opts.setTimer || setTimeout;
    var clearTimer = opts.clearTimer || clearTimeout;
    var openTimer = null;
    var closeTimer = null;

    function clearOpen() {
      if (openTimer === null) return;
      clearTimer(openTimer);
      openTimer = null;
    }

    function clearClose() {
      if (closeTimer === null) return;
      clearTimer(closeTimer);
      closeTimer = null;
    }

    function pointerEnter(pointerType) {
      if (pointerType !== 'mouse' || (opts.canHover && !opts.canHover())) return;
      clearClose();
      if (opts.isOpen && opts.isOpen()) return;
      if (openTimer !== null) return;
      openTimer = setTimer(function () {
        openTimer = null;
        opts.open();
      }, openDelay);
    }

    function pointerLeave(pointerType) {
      if (pointerType !== 'mouse' || (opts.canHover && !opts.canHover())) return;
      clearOpen();
      if (closeTimer !== null) return;
      closeTimer = setTimer(function () {
        closeTimer = null;
        opts.close();
      }, closeDelay);
    }

    function cancel() {
      clearOpen();
      clearClose();
    }

    return {
      pointerEnter: pointerEnter,
      pointerLeave: pointerLeave,
      cancel: cancel,
      openDelay: openDelay,
      closeDelay: closeDelay
    };
  }

  return { create: create };
}));
