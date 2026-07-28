// Amount picker for the server-prepared V2 transfers.
//
// These flows used window.prompt(), which on a payment surface is the wrong
// tool: it cannot be themed or styled, gives no preset amounts, shows no rough
// fiat value, is easy to mistype on a phone, and reads to a wallet-holder as
// something the page is doing to them rather than a considered step. This
// replaces it with the same amount affordance the support dialog already uses,
// and returns a promise so the caller's prepare/approve/verify sequence is
// otherwise untouched.
//
// It deliberately offers no payment method before preparation. Once the
// trusted server returns the exact intent, the V2 review step offers Phantom
// and, for one bound recipient, the exact Solana Pay transfer request.
(function () {
  'use strict';

  var PRESETS = [0.05, 0.1, 0.5, 1];
  var MAX_SOL = 100;
  var pending = null;      // { resolve }
  var amount = 0.1;
  var returnFocus = null;

  function el(id) { return document.getElementById(id); }
  function modal() { return el('sol-ask'); }

  function shortAddr(value) {
    var v = String(value || '');
    return v.length > 12 ? v.slice(0, 4) + '…' + v.slice(-4) : v;
  }

  // Mirrors the tip dialog's estimate, and stays silent rather than guessing
  // when no price is available: a wrong fiat figure next to a real transfer is
  // worse than none.
  function solPrice() {
    if (typeof window.OSI_SOL_USD === 'number' && window.OSI_SOL_USD > 0) return window.OSI_SOL_USD;
    if (typeof window.solUsd === 'number' && window.solUsd > 0) return window.solUsd;
    return 0;
  }

  function renderUsd() {
    var host = el('sol-ask-usd'); if (!host) return;
    var price = solPrice();
    host.textContent = (price && amount > 0) ? ('≈ $' + (amount * price).toFixed(2) + ' USD') : '';
  }

  function setError(message) {
    var host = el('sol-ask-err'); if (!host) return;
    host.textContent = message || '';
    host.classList.toggle('show', !!message);
  }

  // Accepts what the server accepts: a positive amount with at most 9 decimals.
  function normalize(value) {
    var text = String(value == null ? '' : value).trim();
    if (!/^\d+(\.\d{1,9})?$/.test(text)) return null;
    var num = Number(text);
    if (!isFinite(num) || num <= 0 || num > MAX_SOL) return null;
    return text.replace(/\.?0+$/, function (m) { return m.indexOf('.') === 0 ? '' : m; });
  }

  function markActive(value) {
    var buttons = modal() ? modal().querySelectorAll('.sol-ask-amt') : [];
    Array.prototype.forEach.call(buttons, function (b) {
      b.classList.toggle('active', Number(b.getAttribute('data-sol')) === Number(value));
    });
  }

  function focusable() {
    var m = modal(); if (!m) return [];
    return Array.prototype.filter.call(
      m.querySelectorAll('button, input, [tabindex]:not([tabindex="-1"])'),
      function (node) { return !node.disabled && node.offsetParent !== null; }
    );
  }

  function onKeydown(event) {
    if (event.key === 'Escape') { event.preventDefault(); close(null); return; }
    if (event.key === 'Enter' && event.target && event.target.id === 'sol-ask-custom') {
      event.preventDefault(); confirm(); return;
    }
    if (event.key !== 'Tab') return;
    var items = focusable(); if (!items.length) return;
    var first = items[0], last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  }

  function close(result) {
    var m = modal();
    if (m) { m.classList.remove('open'); m.setAttribute('aria-hidden', 'true'); m.removeEventListener('keydown', onKeydown, true); }
    var resolve = pending && pending.resolve; pending = null;
    var back = returnFocus; returnFocus = null;
    if (back && back.isConnected && typeof back.focus === 'function') window.setTimeout(function () { back.focus(); }, 0);
    if (resolve) resolve(result);
  }

  function confirm() {
    var custom = el('sol-ask-custom');
    var raw = custom && String(custom.value || '').trim() ? custom.value : amount;
    var value = normalize(raw);
    if (value === null) {
      setError('Enter a positive amount up to ' + MAX_SOL + ' SOL, with at most 9 decimals.');
      if (custom) custom.focus();
      return;
    }
    close(value);
  }

  // Resolves to a validated amount string, or null when the person backs out.
  function ask(options) {
    options = options || {};
    var m = modal();
    if (!m) return Promise.resolve(window.prompt(options.promptFallback || 'Amount in SOL', '0.1'));
    if (pending) close(null);

    // Route stylesheets normally switch on at the first interaction. A transfer
    // dialog must never be the thing that races that, so make sure they are on
    // before this one is shown: an unstyled payment prompt is not a cosmetic
    // problem, it is a reason not to trust the page.
    if (typeof window.osiActivateRouteStyles === 'function') window.osiActivateRouteStyles();

    amount = Number(options.amount) > 0 ? Number(options.amount) : 0.1;
    var head = el('sol-ask-h'); if (head) head.textContent = options.title || '◎ Voluntary support';
    var label = el('sol-ask-label'); if (label) label.textContent = options.label || 'recipient';
    var addr = el('sol-ask-addr'); if (addr) addr.textContent = options.address ? shortAddr(options.address) : '';
    var go = el('sol-ask-go'); if (go) go.textContent = options.action || 'Continue →';
    var note = el('sol-ask-note'); if (note && options.note) note.textContent = options.note;
    var custom = el('sol-ask-custom');
    if (custom) { custom.value = PRESETS.indexOf(amount) === -1 ? String(amount) : ''; }
    markActive(amount);
    setError('');
    renderUsd();

    returnFocus = document.activeElement && typeof document.activeElement.focus === 'function' ? document.activeElement : null;
    m.classList.add('open');
    m.setAttribute('aria-hidden', 'false');
    m.addEventListener('keydown', onKeydown, true);
    var card = m.querySelector('.sol-ask-card');
    window.setTimeout(function () { if (card) card.focus(); }, 0);

    return new Promise(function (resolve) { pending = { resolve: resolve }; });
  }

  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest && event.target.closest('.sol-ask-amt');
    if (!button || !modal() || !modal().contains(button)) return;
    amount = Number(button.getAttribute('data-sol')) || amount;
    var custom = el('sol-ask-custom'); if (custom) custom.value = '';
    markActive(amount); setError(''); renderUsd();
  });

  document.addEventListener('input', function (event) {
    if (!event.target || event.target.id !== 'sol-ask-custom') return;
    var typed = Number(event.target.value);
    if (isFinite(typed) && typed > 0) { amount = typed; markActive(null); }
    setError(''); renderUsd();
  });

  window.osiAskSolAmount = ask;
  window.osiConfirmSolAsk = confirm;
  window.osiCloseSolAsk = close;
})();
