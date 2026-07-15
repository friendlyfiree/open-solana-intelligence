(function () {
  'use strict';

  var viewHashes = {
    registry: 'home',
    field: 'field-office',
    wire: 'wire',
    records: 'public-records',
    analysts: 'analyst-network',
    prooflog: 'proof-log',
    methodology: 'about',
    admin: 'admin'
  };
  var hashViews = {};
  Object.keys(viewHashes).forEach(function (key) { hashViews[viewHashes[key]] = key; });

  var platformTrigger;
  var platformMenu;
  var platformWrap;
  var platformIntent;
  var mobileToggle;
  var globalNav;
  var navScrim;

  function setPlatform(open, focusFirst) {
    if (!platformTrigger || !platformMenu) return;
    platformTrigger.setAttribute('aria-expanded', open ? 'true' : 'false');
    platformMenu.hidden = !open;
    if (open && focusFirst) {
      var first = platformMenu.querySelector('button');
      if (first) first.focus();
    }
  }

  function closeMobileNav(returnFocus) {
    if (!mobileToggle || !globalNav || !navScrim) return;
    document.body.classList.remove('nav-open');
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileToggle.setAttribute('aria-label', 'Open navigation');
    navScrim.hidden = true;
    setPlatform(false);
    if (returnFocus) mobileToggle.focus();
  }

  function openMobileNav() {
    if (!mobileToggle || !globalNav || !navScrim) return;
    document.body.classList.add('nav-open');
    mobileToggle.setAttribute('aria-expanded', 'true');
    mobileToggle.setAttribute('aria-label', 'Close navigation');
    navScrim.hidden = false;
    var first = globalNav.querySelector('button');
    if (first) first.focus();
  }

  function syncActiveNavigation(view) {
    document.querySelectorAll('[data-global-view]').forEach(function (button) {
      if (button.getAttribute('data-global-view') === view) {
        button.setAttribute('aria-current', 'page');
      } else {
        button.removeAttribute('aria-current');
      }
    });
    if (platformTrigger) {
      var platformViews = ['field', 'wire', 'records', 'prooflog', 'admin', 'identity', 'workspace'];
      if (platformViews.indexOf(view) !== -1) {
        platformTrigger.setAttribute('aria-current', 'page');
      } else {
        platformTrigger.removeAttribute('aria-current');
      }
    }
  }

  function navigate(view, options) {
    var opts = options || {};
    var target = viewHashes[view] ? view : 'registry';
    if (typeof window.showView === 'function') window.showView(target);
    syncActiveNavigation(target);
    closeMobileNav(false);
    setPlatform(false);
    if (!opts.history) {
      var nextHash = '#' + viewHashes[target];
      if (window.location.hash !== nextHash) {
        window.history.pushState({ osiView: target }, '', nextHash);
      }
    }
    if (!opts.preserveScroll) window.scrollTo({ top: 0, behavior: 'auto' });
    if (opts.focus !== false) {
      var main = document.getElementById('main-content');
      if (main) window.setTimeout(function () { main.focus({ preventScroll: true }); }, 0);
    }
  }

  function navigateSection(view, sectionId, hash) {
    navigate(view, { focus: false, preserveScroll: true });
    window.setTimeout(function () {
      var section = document.getElementById(sectionId);
      if (!section) return;
      section.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      section.setAttribute('tabindex', '-1');
      section.focus({ preventScroll: true });
      if (hash) window.history.replaceState({ osiView: view }, '', '#' + hash);
    }, 0);
  }

  function openCase() {
    navigate('field', { focus: false });
    window.setTimeout(function () {
      var fieldTrigger = document.querySelector('#field-view .fo-cta');
      if (fieldTrigger) fieldTrigger.focus({ preventScroll: true });
      if (typeof window.fieldOpenForm === 'function') window.fieldOpenForm();
    }, 0);
  }

  function navigateFieldStage(stage) {
    navigate('field', { focus: false });
    window.setTimeout(function () {
      var select = document.querySelector('#field-view .fo-toolbar select[onchange*="fieldFilter"]');
      if (select) select.value = stage;
      if (typeof window.fieldFilter === 'function') window.fieldFilter(stage);
      var heading = document.getElementById('fo-title');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
      }
    }, 0);
  }

  function focusable(container) {
    return Array.prototype.slice.call(container.querySelectorAll(
      'button:not([disabled]):not([hidden]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )).filter(function (item) { return item.offsetParent !== null; });
  }

  function trapMobileFocus(event) {
    if (event.key !== 'Tab' || !document.body.classList.contains('nav-open') || !globalNav) return;
    var items = focusable(globalNav);
    if (!items.length) return;
    var first = items[0];
    var last = items[items.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function setupNavigation() {
    platformTrigger = document.getElementById('platform-menu-trigger');
    platformMenu = document.getElementById('platform-menu');
    platformWrap = platformTrigger && platformTrigger.closest('.osi-platform-wrap');
    mobileToggle = document.getElementById('mobile-nav-toggle');
    globalNav = document.getElementById('global-nav');
    navScrim = document.getElementById('nav-scrim');

    if (platformTrigger && platformMenu) {
      if (platformWrap && window.OSINavIntent) {
        platformIntent = window.OSINavIntent.create({
          openDelay: 100,
          closeDelay: 220,
          canHover: function () { return window.matchMedia('(hover: hover) and (pointer: fine)').matches; },
          isOpen: function () { return platformTrigger.getAttribute('aria-expanded') === 'true'; },
          open: function () { setPlatform(true); },
          close: function () { setPlatform(false); }
        });
        platformWrap.addEventListener('pointerenter', function (event) {
          platformIntent.pointerEnter(event.pointerType);
        });
        platformWrap.addEventListener('pointerleave', function (event) {
          platformIntent.pointerLeave(event.pointerType);
        });
      }
      platformTrigger.addEventListener('click', function () {
        if (platformIntent) platformIntent.cancel();
        setPlatform(platformTrigger.getAttribute('aria-expanded') !== 'true');
      });
      platformTrigger.addEventListener('focus', function () {
        if (document.documentElement.classList.contains('osi-keyboard-input')) setPlatform(true);
      });
      platformTrigger.addEventListener('keydown', function (event) {
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setPlatform(true, true);
        } else if (event.key === 'Escape') {
          setPlatform(false);
        }
      });
      platformMenu.addEventListener('keydown', function (event) {
        var items = focusable(platformMenu);
        var index = items.indexOf(document.activeElement);
        if (event.key === 'Escape') {
          event.preventDefault();
          setPlatform(false);
          platformTrigger.focus();
        } else if (event.key === 'ArrowDown' && items.length) {
          event.preventDefault();
          items[(index + 1 + items.length) % items.length].focus();
        } else if (event.key === 'ArrowUp' && items.length) {
          event.preventDefault();
          items[(index - 1 + items.length) % items.length].focus();
        }
      });
    }

    if (mobileToggle) {
      mobileToggle.addEventListener('click', function () {
        if (document.body.classList.contains('nav-open')) closeMobileNav(true);
        else openMobileNav();
      });
    }
    if (navScrim) navScrim.addEventListener('click', function () { closeMobileNav(true); });

    document.addEventListener('keydown', function (event) {
      if (event.key === 'Tab' || event.key.indexOf('Arrow') === 0) {
        document.documentElement.classList.add('osi-keyboard-input');
      }
      trapMobileFocus(event);
      if (event.key === 'Escape') {
        if (document.body.classList.contains('nav-open')) closeMobileNav(true);
        else if (platformTrigger && platformTrigger.getAttribute('aria-expanded') === 'true') {
          setPlatform(false);
          platformTrigger.focus();
        }
      }
    });
    document.addEventListener('pointerdown', function (event) {
      document.documentElement.classList.remove('osi-keyboard-input');
      if (!platformMenu || !platformTrigger || platformMenu.hidden) return;
      if (!platformMenu.contains(event.target) && !platformTrigger.contains(event.target)) setPlatform(false);
    });

    window.addEventListener('resize', function () {
      if (platformIntent) platformIntent.cancel();
      if (window.matchMedia('(min-width: 981px)').matches) closeMobileNav(false);
    });
  }

  function setupWalletMenuAccessibility() {
    var walletButton = document.getElementById('walletBtn');
    var walletMenu = document.getElementById('wbMenu');
    if (!walletButton || !walletMenu) return;
    walletButton.setAttribute('aria-haspopup', 'menu');
    walletButton.setAttribute('aria-controls', 'wbMenu');
    var sync = function () {
      var open = walletMenu.classList.contains('open');
      walletButton.setAttribute('aria-expanded', open ? 'true' : 'false');
    };
    new MutationObserver(sync).observe(walletMenu, { attributes: true, attributeFilter: ['class'] });
    walletButton.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowDown') return;
      event.preventDefault();
      if (typeof window.openWalletMenu === 'function') window.openWalletMenu();
      var first = walletMenu.querySelector('[role="menuitem"]:not([style*="display:none"])');
      if (first) window.setTimeout(function () { first.focus(); }, 0);
    });
    walletMenu.addEventListener('keydown', function (event) {
      var items = focusable(walletMenu);
      var index = items.indexOf(document.activeElement);
      if (event.key === 'Escape') {
        event.preventDefault();
        if (typeof window.closeWalletMenu === 'function') window.closeWalletMenu();
        walletButton.focus();
      } else if (event.key === 'ArrowDown' && items.length) {
        event.preventDefault();
        items[(index + 1 + items.length) % items.length].focus();
      } else if (event.key === 'ArrowUp' && items.length) {
        event.preventDefault();
        items[(index - 1 + items.length) % items.length].focus();
      }
    });
    sync();
  }

  function make(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function shortRef(value) {
    var text = String(value || '');
    if (text.length <= 18) return text || 'Public record';
    return text.slice(0, 10) + '...' + text.slice(-5);
  }

  function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); });
  }

  function publicApi(path, body) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, 9000);
    return fetch(SUPABASE_URL + '/functions/v1/' + path, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: 'Bearer ' + SUPABASE_ANON_KEY
      },
      body: JSON.stringify(body),
      signal: controller.signal
    }).then(function (response) {
      if (!response.ok) throw new Error('public_read_unavailable');
      return response.json();
    }).finally(function () {
      window.clearTimeout(timer);
    });
  }

  function renderHomeCaseState(cases) {
    var host = document.getElementById('osi-home-live-state');
    if (!host) return;
    host.replaceChildren();
    host.setAttribute('aria-busy', 'false');
    var mark = make('span', 'osi-state-mark');
    mark.setAttribute('aria-hidden', 'true');
    host.appendChild(mark);
    var copy = make('div');
    if (!cases.length) {
      copy.appendChild(make('strong', '', 'No public Cases are listed'));
      copy.appendChild(make('small', '', 'Private intake and unpublished Reports remain outside this public view.'));
      host.appendChild(copy);
      return;
    }
    var item = cases[0];
    copy.appendChild(make('strong', '', item.title || shortRef(item.public_ref)));
    copy.appendChild(make('small', '', shortRef(item.public_ref) + ' / ' + titleCase(item.stage)));
    host.appendChild(copy);
    var open = make('button', '', 'Open');
    open.type = 'button';
    open.addEventListener('click', function () {
      navigate('field', { focus: false });
      window.setTimeout(function () {
        if (typeof window.osiV2OpenCase === 'function') window.osiV2OpenCase(item.public_ref);
      }, 0);
    });
    host.appendChild(open);
  }

  function renderHomeCasesError() {
    var host = document.getElementById('osi-home-live-state');
    if (!host) return;
    host.replaceChildren();
    host.setAttribute('aria-busy', 'false');
    var mark = make('span', 'osi-state-mark');
    mark.setAttribute('aria-hidden', 'true');
    host.appendChild(mark);
    var copy = make('div');
    copy.appendChild(make('strong', '', 'Public Case index unavailable'));
    copy.appendChild(make('small', '', 'No cached or invented Case data is shown.'));
    host.appendChild(copy);
    var retry = make('button', '', 'Retry');
    retry.type = 'button';
    retry.addEventListener('click', loadHomeData);
    host.appendChild(retry);
  }

  function rowButton(label, handler) {
    var button = make('button', '', label);
    button.type = 'button';
    button.addEventListener('click', handler);
    return button;
  }

  function renderAnalysts(analysts) {
    var host = document.getElementById('home-analyst-list');
    if (!host) return;
    host.replaceChildren();
    host.setAttribute('aria-busy', 'false');
    if (!analysts.length) {
      var empty = make('div', 'osi-list-loading');
      var icon = make('span');
      icon.setAttribute('aria-hidden', 'true');
      var copy = make('p');
      copy.appendChild(make('strong', '', 'No activated analysts yet'));
      copy.appendChild(make('small', '', 'Only approved, verified public profiles appear here.'));
      empty.appendChild(icon);
      empty.appendChild(copy);
      host.appendChild(empty);
      return;
    }
    analysts.slice(0, 3).forEach(function (analyst) {
      var row = make('div', 'osi-public-row');
      row.appendChild(make('span', '', titleCase(analyst.tier_code || analyst.status)));
      var copy = make('div');
      copy.appendChild(make('strong', '', analyst.display_name || analyst.handle || shortRef(analyst.wallet)));
      var expertise = Array.isArray(analyst.expertise) ? analyst.expertise.slice(0, 3).join(', ') : '';
      copy.appendChild(make('small', '', expertise || 'Public analyst profile'));
      row.appendChild(copy);
      row.appendChild(rowButton('View profile', function () {
        navigate('analysts', { focus: false });
        window.setTimeout(function () {
          if (typeof window.openAnalystProfile === 'function') window.openAnalystProfile(analyst.wallet);
        }, 0);
      }));
      host.appendChild(row);
    });
  }

  function renderAnalystError() {
    var host = document.getElementById('home-analyst-list');
    if (!host) return;
    host.replaceChildren();
    host.setAttribute('aria-busy', 'false');
    var empty = make('div', 'osi-list-loading');
    var icon = make('span');
    icon.setAttribute('aria-hidden', 'true');
    var copy = make('p');
    copy.appendChild(make('strong', '', 'Analyst directory unavailable'));
    copy.appendChild(make('small', '', 'No cached or invented analyst identity is shown.'));
    empty.appendChild(icon);
    empty.appendChild(copy);
    empty.appendChild(rowButton('Retry', loadHomeData));
    host.appendChild(empty);
  }

  function renderRecords(cases) {
    var host = document.getElementById('home-public-records');
    if (!host) return;
    host.replaceChildren();
    host.setAttribute('aria-busy', 'false');
    var sealed = cases.filter(function (item) { return item.stage === 'sealed'; });
    if (!sealed.length) {
      var empty = make('div', 'osi-list-loading');
      var icon = make('span');
      icon.setAttribute('aria-hidden', 'true');
      var copy = make('p');
      copy.appendChild(make('strong', '', 'No sealed public records are listed'));
      copy.appendChild(make('small', '', 'OSI does not substitute example records for an empty public index.'));
      empty.appendChild(icon);
      empty.appendChild(copy);
      host.appendChild(empty);
      return;
    }
    sealed.slice(0, 3).forEach(function (item) {
      var row = make('div', 'osi-public-row');
      row.appendChild(make('span', '', shortRef(item.public_ref)));
      var copy = make('div');
      copy.appendChild(make('strong', '', item.title || 'Sealed public record'));
      copy.appendChild(make('small', '', titleCase(item.category) + ' / ' + (item.sealed_at ? new Date(item.sealed_at).toLocaleDateString() : 'Seal recorded')));
      row.appendChild(copy);
      row.appendChild(rowButton('Inspect proof', function () {
        navigate('field', { focus: false });
        window.setTimeout(function () {
          if (typeof window.osiV2OpenCase === 'function') window.osiV2OpenCase(item.public_ref);
        }, 0);
      }));
      host.appendChild(row);
    });
  }

  function renderRecordsError() {
    var host = document.getElementById('home-public-records');
    if (!host) return;
    host.replaceChildren();
    host.setAttribute('aria-busy', 'false');
    var empty = make('div', 'osi-list-loading');
    var icon = make('span');
    icon.setAttribute('aria-hidden', 'true');
    var copy = make('p');
    copy.appendChild(make('strong', '', 'Public record index unavailable'));
    copy.appendChild(make('small', '', 'Private or cached data is never used as a fallback.'));
    empty.appendChild(icon);
    empty.appendChild(copy);
    empty.appendChild(rowButton('Retry', loadHomeData));
    host.appendChild(empty);
  }

  function loadHomeData() {
    var caseRequest = publicApi('osi-v2-case-read', { op: 'list_public_cases' })
      .then(function (result) {
        var cases = Array.isArray(result.cases) ? result.cases : [];
        renderHomeCaseState(cases);
        renderRecords(cases);
      })
      .catch(function () {
        renderHomeCasesError();
        renderRecordsError();
      });
    var analystRequest = publicApi('osi-v2-analyst', { op: 'list_public_profiles' })
      .then(function (result) {
        renderAnalysts(Array.isArray(result.analysts) ? result.analysts : []);
      })
      .catch(renderAnalystError);
    return Promise.allSettled([caseRequest, analystRequest]);
  }

  function routeFromLocation() {
    var hash = window.location.hash.replace(/^#/, '');
    if (hash === 'how-it-works') {
      navigateSection('registry', 'how-osi-works', 'how-it-works');
      return;
    }
    if (hashViews[hash]) navigate(hashViews[hash], { history: true, focus: false });
    else if (!hash) navigate('registry', { history: true, focus: false });
    else syncActiveNavigation(document.body.dataset.view || 'registry');
  }

  function init() {
    setupNavigation();
    setupWalletMenuAccessibility();
    routeFromLocation();
    loadHomeData();
    new MutationObserver(function () {
      syncActiveNavigation(document.body.dataset.view || 'registry');
    }).observe(document.body, { attributes: true, attributeFilter: ['data-view'] });
    window.addEventListener('popstate', routeFromLocation);
  }

  window.osiNavigate = navigate;
  window.osiNavigateSection = navigateSection;
  window.osiOpenCase = openCase;
  window.osiNavigateFieldStage = navigateFieldStage;
  window.osiLoadHomeData = loadHomeData;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
