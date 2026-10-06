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
    identity: 'identity',
    workspace: 'workspace',
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
    document.documentElement.classList.remove('nav-open');
    mobileToggle.setAttribute('aria-expanded', 'false');
    mobileToggle.setAttribute('aria-label', 'Open navigation');
    navScrim.hidden = true;
    setPlatform(false);
    if (returnFocus) mobileToggle.focus();
  }

  function openMobileNav() {
    if (!mobileToggle || !globalNav || !navScrim) return;
    document.body.classList.add('nav-open');
    document.documentElement.classList.add('nav-open');
    mobileToggle.setAttribute('aria-expanded', 'true');
    mobileToggle.setAttribute('aria-label', 'Close navigation');
    navScrim.hidden = false;
    var first = globalNav.querySelector('button');
    if (first) first.focus();
  }

  var viewTitles = {
    field: 'Field Office',
    wire: 'The Wire',
    records: 'Public Records',
    analysts: 'Analyst Network',
    prooflog: 'Proof Log',
    methodology: 'About',
    workspace: 'My OSI',
    identity: 'OSI Identity',
    admin: 'Operations Center'
  };
  function syncDocumentTitle(view) {
    var home = 'Open Solana Intelligence | Public incident intelligence';
    var t = typeof window.osiT === 'function' ? window.osiT : function (key) { return key; };
    document.title = viewTitles[view] ? t(viewTitles[view]) + ' | Open Solana Intelligence' : t(home);
  }

  window.osiSyncDocumentTitle = function () { syncDocumentTitle(document.body.dataset.view || 'registry'); };

  function syncActiveNavigation(view) {
    syncDocumentTitle(view);
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

  // Several workspace entry points (My Cases, My Reports, the review queues,
  // the analyst workspace) switch the visible view through showView without
  // going through navigate. The address bar used to keep the previous view's
  // hash, so the URL contradicted the page and a reload landed somewhere else.
  // This keeps the two in step without inventing extra history entries.
  var suppressRouteSync = false;
  function syncRouteForView(view) {
    if (suppressRouteSync) return;
    var target = viewHashes[view] ? view : 'registry';
    var hash = window.location.hash.replace(/^#/, '');
    // A Case route is a deeper address inside the Field Office, not a view
    // hash. Flattening it would drop the shareable Case reference. A profile
    // route is the same kind of deeper address inside the analyst network.
    if (caseRouteRef(hash) || profileRoute(hash) || walletProfileRoute(hash)) return;
    if (hashViews[hash] === target) return;
    try {
      window.history.replaceState({ osiView: target }, '', '#' + viewHashes[target]);
    } catch (_) { return; }
    syncActiveNavigation(target);
  }

  function navigate(view, options) {
    var opts = options || {};
    var target = viewHashes[view] ? view : 'registry';
    // A global view change owns the whole surface. Close any open Case drawer
    // before replacing its underlying view, while allowing the canonical
    // #case route parser to keep an already-open exact Case in place.
    if (opts.keepCaseDrawer !== true) closeCaseRoute();
    if (target !== 'registry' && typeof window.osiActivateRouteStyles === 'function') {
      window.osiActivateRouteStyles();
    }
    // navigate owns the history entry for this move, so the low-level sync
    // must not consume the hash change before pushState can record it.
    suppressRouteSync = true;
    try {
      if (opts.render === false) document.body.dataset.view = target;
      else if (typeof window.showView === 'function') window.showView(target);
    } finally {
      suppressRouteSync = false;
    }
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
    // The visible close control sits outside the drawer; keep it in the cycle.
    var items = (mobileToggle ? [mobileToggle] : []).concat(focusable(globalNav));
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
      // A menu opened by keyboard focus closes again when focus moves on, so
      // it never sits over the control the reader has tabbed to.
      if (platformWrap) {
        platformWrap.addEventListener('focusout', function (event) {
          if (document.body.classList.contains('nav-open')) return;
          if (event.relatedTarget && platformWrap.contains(event.relatedTarget)) return;
          if (platformIntent) platformIntent.cancel();
          setPlatform(false);
        });
      }
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
      platformMenu.addEventListener('click', function (event) {
        if (!event.target.closest('button')) return;
        if (document.body.classList.contains('nav-open')) closeMobileNav(false);
        else setPlatform(false);
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
      var key = typeof event.key === 'string' ? event.key : '';
      if (key === 'Tab' || key.indexOf('Arrow') === 0) {
        document.documentElement.classList.add('osi-keyboard-input');
      }
      trapMobileFocus(event);
      if (key === 'Escape') {
        var walletMenuNode = document.getElementById('wbMenu');
        if (document.body.classList.contains('nav-open')) closeMobileNav(true);
        else if (platformTrigger && platformTrigger.getAttribute('aria-expanded') === 'true') {
          setPlatform(false);
          platformTrigger.focus();
        } else if (walletMenuNode && walletMenuNode.classList.contains('open')) {
          if (typeof window.closeWalletMenu === 'function') window.closeWalletMenu();
          var walletButtonNode = document.getElementById('walletBtn');
          if (walletButtonNode) walletButtonNode.focus();
        }
      }
    });
    var skipLink = document.querySelector('.skip-link');
    if (skipLink) {
      skipLink.addEventListener('click', function (event) {
        var main = document.getElementById('main-content');
        if (!main) return;
        event.preventDefault();
        main.focus();
      });
    }
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

  var ACRONYMS = { Osint: 'OSINT', Aml: 'AML', Kyc: 'KYC', Defi: 'DeFi', Nft: 'NFT', Mev: 'MEV', Dao: 'DAO', Cex: 'CEX', Dex: 'DEX', Rpc: 'RPC', Sas: 'SAS' };
  function titleCase(value) {
    return String(value || '').replace(/_/g, ' ').replace(/\b\w/g, function (letter) { return letter.toUpperCase(); })
      .replace(/\b[A-Z][a-z]+\b/g, function (word) { return ACRONYMS[word] || word; });
  }

  function uiLocale() {
    var locale = window.OSI_I18N && typeof window.OSI_I18N.getLocale === 'function' ? window.OSI_I18N.getLocale() : document.documentElement.lang;
    return String(locale || 'en').toLowerCase().indexOf('tr') === 0 ? 'tr-TR' : 'en-US';
  }

  function tr(key, variables) {
    return typeof window.osiT === 'function' ? window.osiT(key, variables) : String(key).replace(/\{([a-zA-Z0-9_]+)\}/g, function (_, name) {
      return variables && Object.prototype.hasOwnProperty.call(variables, name) ? String(variables[name]) : '{' + name + '}';
    });
  }

  // Server enum values (stage, category, expertise) render as their English
  // label; the label is then translated as one exact key for the UI language.
  // Titles and names come from Case owners and analysts; they are never
  // passed through the interface dictionary.
  function userText(tag, className, text) {
    var node = make(tag, className, text);
    node.setAttribute('data-osi-user-content', '');
    return node;
  }

  function enumLabel(value) {
    return tr(titleCase(value));
  }

  // The same public stage names the Field Office list uses, so one Case never
  // reads as "Open Public" on the home page and "Public investigation" there.
  var STAGE_LABELS = {
    draft: 'Private intake', submitted: 'Private intake', initial_review: 'Initial review',
    initial_rejected: 'Initial review rejected', open_public: 'Public investigation',
    in_review: 'Reports under review', ready_for_finalization: 'Resolution selection',
    resolution_proposed: 'Resolution selection', in_challenge_window: 'Challenge window',
    resolved: 'Seal ready', sealed: 'Sealed', reopened: 'Resolution selection'
  };

  function stageText(stage) {
    return STAGE_LABELS[stage] ? tr(STAGE_LABELS[stage]) : enumLabel(stage);
  }

  function shortDate(value) {
    var date = new Date(value || '');
    if (isNaN(date.getTime())) return '';
    return date.toLocaleDateString(uiLocale(), { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
  }

  // One shared public reader for every surface. It de-duplicates concurrent
  // identical requests and reuses a list projection for a few seconds, so a
  // page visit no longer pays for the same server projection once per tab.
  function publicApi(path, body, options) {
    return window.osiPublicRead(path, body, options);
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
    // Prefer the newest Case still in progress: sealed outcomes are already
    // listed in the Public Records pane right below.
    var item = cases.filter(function (row) { return row.stage !== 'sealed'; })[0] || cases[0];
    copy.appendChild(make('span', 'osi-live-label', item.stage === 'sealed' ? 'Newest public Case' : 'Newest open public Case'));
    copy.appendChild(userText('strong', '', item.title || shortRef(item.public_ref)));
    copy.appendChild(make('small', '', shortRef(item.public_ref) + ' / ' + stageText(item.stage)));
    host.appendChild(copy);
    var open = make('button', '', 'Open Case');
    open.type = 'button';
    open.setAttribute('aria-label', tr('Open Case detail for {ref}, {title}', { ref: item.public_ref, title: item.title || '' }));
    open.addEventListener('click', function () { openPublicCase(item.public_ref); });
    host.appendChild(open);
  }

  // Every public entry point routes through one canonical Case detail so the
  // same reference always resolves to the same drawer and the same URL.
  function openPublicCase(publicRef) {
    // Only the #case/<ref> entry is pushed, so Back returns to where the
    // reader came from instead of an intermediate Field Office entry.
    navigate('field', { focus: false, preserveScroll: true, history: true });
    window.setTimeout(function () {
      if (typeof window.osiV2OpenCase === 'function') window.osiV2OpenCase(publicRef);
    }, 0);
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
      row.appendChild(make('span', 'osi-public-tier', enumLabel(analyst.tier_code || analyst.status)));
      var copy = make('div');
      copy.appendChild(userText('strong', '', analyst.display_name || analyst.handle || shortRef(analyst.wallet)));
      var expertise = Array.isArray(analyst.expertise) ? analyst.expertise.slice(0, 3).map(enumLabel).join(', ') : '';
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
      copy.appendChild(make('small', '', 'Public Records holds sealed outcomes only. Open public Cases and their published Reports are in the Field Office. OSI does not substitute example records for an empty public index.'));
      empty.appendChild(icon);
      empty.appendChild(copy);
      empty.appendChild(rowButton('Browse public Cases', function () { navigate('field', { focus: false }); }));
      host.appendChild(empty);
      return;
    }
    sealed.slice(0, 3).forEach(function (item) {
      var row = make('div', 'osi-public-row');
      row.appendChild(make('span', 'osi-public-ref mono', shortRef(item.public_ref)));
      var copy = make('div');
      copy.appendChild(item.title ? userText('strong', '', item.title) : make('strong', '', 'Sealed public record'));
      copy.appendChild(make('small', '', enumLabel(item.category) + ' / ' + (shortDate(item.sealed_at) || tr('Seal recorded'))));
      row.appendChild(copy);
      row.appendChild(rowButton('Inspect proof', function () { openPublicCase(item.public_ref); }));
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

  // The last public lists, kept only so a language switch can redraw the
  // same rows with translated labels and dates instead of refetching them.
  var homeCache = { cases: null, analysts: null };

  function loadHomeData() {
    // Home reads the full public Case projection although it draws only a few
    // fields. That is deliberate: the Field Office, Public Records and the Proof
    // Log read the same projection through the shared cache in
    // 04-public-read.js, so one answer serves every view. A separate summary
    // read for Home would add a request on the first navigation.
    var caseRequest = publicApi('osi-v2-case-read', { op: 'list_public_cases' })
      .then(function (result) {
        var cases = Array.isArray(result.cases) ? result.cases : [];
        homeCache.cases = cases;
        renderHomeCaseState(cases);
        renderRecords(cases);
      })
      .catch(function () {
        renderHomeCasesError();
        renderRecordsError();
      });
    var analystRequest = publicApi('osi-v2-analyst', { op: 'list_public_profiles' })
      .then(function (result) {
        homeCache.analysts = Array.isArray(result.analysts) ? result.analysts : [];
        renderAnalysts(homeCache.analysts);
      })
      .catch(renderAnalystError);
    return Promise.allSettled([caseRequest, analystRequest]);
  }

  window.addEventListener('osi:localechange', function () {
    if (homeCache.cases) { renderHomeCaseState(homeCache.cases); renderRecords(homeCache.cases); }
    if (homeCache.analysts) renderAnalysts(homeCache.analysts);
  });

  // #case/OSI-XXXXXXXXXXXX is the canonical, shareable public Case route. It
  // carries only a public reference, never a token, nonce or wallet value.
  function caseRouteRef(hash) {
    var match = /^case\/(OSI-[0-9A-Z]{6,20})$/i.exec(String(hash || ''));
    return match ? match[1].toUpperCase() : '';
  }

  // #analyst/<handle> and #maintainer address one public profile. The analyst
  // integration owns opening them; the shell only has to know they are real
  // addresses so it neither flattens them into a view hash nor treats them as
  // an unknown fragment. Both carry a public identifier and nothing else.
  function profileRoute(hash) {
    hash = String(hash || '');
    return hash === 'maintainer' || /^analyst\/[A-Za-z0-9_]{2,32}$/.test(hash);
  }

  // A wallet profile address carries only the opaque public profile reference
  // or owner-selected public handle. It never contains the controlling wallet.
  function walletProfileRoute(hash) {
    var match = /^profile\/(OSI-PRF-[A-F0-9]{16}|[A-Za-z0-9_]{2,32})$/.exec(String(hash || ''));
    return match ? match[1] : '';
  }

  function closeCaseRoute() {
    if (typeof window.osiV2CloseCaseFromRoute === 'function') window.osiV2CloseCaseFromRoute();
  }

  function routeFromLocation() {
    var hash = window.location.hash.replace(/^#/, '');
    if (hash === 'how-it-works') {
      closeCaseRoute();
      navigateSection('registry', 'how-osi-works', 'how-it-works');
      return;
    }
    var caseRef = caseRouteRef(hash);
    if (caseRef) {
      navigate('field', { history: true, focus: false, preserveScroll: true, keepCaseDrawer: true });
      if (typeof window.osiV2ActiveCaseRef === 'function' && window.osiV2ActiveCaseRef() === caseRef) return;
      window.setTimeout(function () {
        if (typeof window.osiV2OpenCaseFromRoute === 'function') window.osiV2OpenCaseFromRoute(caseRef);
      }, 0);
      return;
    }
    var walletProfileRef = walletProfileRoute(hash);
    if (walletProfileRef) {
      closeCaseRoute();
      navigate('identity', { history: true, render: false, focus: false, preserveScroll: true });
      window.setTimeout(function () {
        if (typeof window.osiV2OpenPublicProfile === 'function') window.osiV2OpenPublicProfile(walletProfileRef, { history: true });
      }, 0);
      return;
    }
    closeCaseRoute();
    // A profile address puts the reader in the analyst network, so closing the
    // profile leaves them on the page it belongs to instead of on the home
    // view they never asked for. Opening the profile itself is the analyst
    // integration's job.
    if (profileRoute(hash)) {
      navigate('analysts', { history: true, focus: false, preserveScroll: true });
      return;
    }
    if (hashViews[hash]) navigate(hashViews[hash], { history: true, focus: false });
    else if (!hash) navigate('registry', { history: true, focus: false });
    else {
      var current = document.body.dataset.view || 'registry';
      syncActiveNavigation(current);
      // An address that is neither a view nor an element on the page would
      // otherwise stay in the bar and contradict what is shown.
      if (!document.getElementById(hash) && viewHashes[current]) {
        try { window.history.replaceState({ osiView: current }, '', '#' + viewHashes[current]); } catch (_) {}
      }
    }
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
  window.osiSyncRouteForView = syncRouteForView;
  window.osiNavigateSection = navigateSection;
  window.osiOpenCase = openCase;
  window.osiOpenPublicCase = openPublicCase;
  window.osiBrowsePublicCases = function () { navigate('field'); };
  window.osiNavigateFieldStage = navigateFieldStage;
  window.osiPublicApi = publicApi;
  window.osiLoadHomeData = loadHomeData;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
}());
