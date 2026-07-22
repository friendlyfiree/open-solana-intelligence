// Dependency-free regression contract for the integrated intelligence interface.
// Run: node tests/osi-intelligence-interface.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const css = read('assets/css/70-intelligence-redesign.css');
const shell = read('assets/js/94-navigation-shell.js');
const signal = read('assets/js/95-signal-interactions.js');
const routeStyles = read('assets/js/02-route-styles.js');
const walletWorkspace = read('assets/js/60-wallet-workspace.js');
const supportTransfer = read('assets/js/70-support-transfer.js');
const favicon = read('assets/favicon.svg');
const records = read('assets/js/84-public-records.js');
const cases = read('assets/js/v2-case-integration.js');
const safety = read('assets/js/20-safety-consensus.js');
const home = index.slice(index.indexOf('<section class="osi-home osi-home-hero"'), index.indexOf('<section class="sec" id="records-hero"'));

let assertions = 0;
function ok(value, message) {
  assertions += 1;
  if (!value) throw new Error('not ok ' + assertions + ' - ' + message);
  console.log('ok ' + assertions + ' - ' + message);
}

ok(index.includes('<header class="osi-global-header"'), 'one global navigation shell is integrated into index.html');
const globalHeader = index.slice(index.indexOf('<header class="osi-global-header"'), index.indexOf('</header>'));
ok((globalHeader.match(/data-global-view="registry"/g) || []).length === 1 && globalHeader.includes('>Home</button>'), 'global navigation exposes one explicit Home route');
ok(!/>How It Works<\/button>/.test(globalHeader) && shell.includes("hash === 'how-it-works'") && shell.includes("navigateSection('registry', 'how-osi-works', 'how-it-works')"), 'How It Works is a Home section with backward-compatible deep linking, not a duplicate global route');
ok(index.includes('<main id="main-content" tabindex="-1">') && index.includes('class="skip-link"'), 'main landmark and keyboard skip link are present');
ok((index.match(/data-osi-route-style/g) || []).length === 9 && index.includes('./assets/js/02-route-styles.js'), 'route-only CSS is preloaded behind the shared activation guard');
ok(routeStyles.includes("window.addEventListener('pointerdown'") && routeStyles.includes("window.addEventListener('keydown'") && routeStyles.includes("window.addEventListener('hashchange'") && routeStyles.includes("link.setAttribute('media', 'all')") && shell.includes('window.osiActivateRouteStyles()'), 'route CSS activates for direct, programmatic, pointer and keyboard navigation');
ok(walletWorkspace.includes("if(v!=='registry' && typeof window.osiActivateRouteStyles==='function')") && walletWorkspace.includes('function openWalletMenu()'), 'canonical view and wallet-menu paths expose their shared activation controls');
ok(shell.includes("identity: 'identity'") && shell.includes("workspace: 'workspace'") && walletWorkspace.includes("osiNavigate('identity')") && !walletWorkspace.includes("showView('identity')"), 'user and role workspaces participate in canonical history-aware navigation');
ok(index.includes('id="tip-modal" role="dialog" aria-modal="true" aria-labelledby="tip-h" aria-describedby="tip-note" aria-hidden="true"') && index.includes('aria-label="Close support dialog"'), 'SOL support uses a named modal dialog with an accessible close control');
ok(supportTransfer.includes("event.key === 'Escape'") && supportTransfer.includes("event.key !== 'Tab'") && supportTransfer.includes('tipReturnFocus') && supportTransfer.includes("m.setAttribute('aria-hidden','false')"), 'SOL support traps focus, closes on Escape, and restores focus');
ok(index.indexOf('70-intelligence-redesign.css') > index.indexOf('v2-activation.css'), 'redesign CSS is the final cascade layer');
ok(index.indexOf('94-navigation-shell.js') > index.indexOf('99-app.js'), 'navigation enhancement loads after the existing application');
ok(index.indexOf('95-signal-interactions.js') > index.indexOf('94-navigation-shell.js'), 'signal enhancement loads after navigation without replacing product behavior');
ok(!index.includes('90-stream-canvas.js') && !index.includes('92-reveal-anim.js'), 'retired root-only animation runtimes are no longer loaded');
const externalScripts = [...index.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/g)].map((match) => match[0]);
ok(externalScripts.length > 1 && externalScripts.filter((tag) => !tag.includes('02-route-styles.js')).every((tag) => /\bdefer\b/.test(tag)), 'application scripts preserve order without blocking HTML parsing');
ok(Buffer.byteLength(index, 'utf8') < 150000 && !index.includes('data:image/'), 'primary document excludes the retired inline image payload');

for (const width of [640, 960, 1536]) {
  for (const extension of ['avif', 'webp']) {
    ok(fs.existsSync(path.join(root, 'assets', 'images', 'osi-intelligence-desk-' + width + '.' + extension)),
      width + 'px ' + extension + ' hero asset exists');
  }
}
ok(fs.existsSync(path.join(root, 'assets/images/osi-intelligence-desk-1536.jpg')), 'JPEG hero fallback exists');
ok(home.includes('<picture>') && home.includes('fetchpriority="high"') && home.includes('width="1536" height="1024"'), 'hero uses a responsive, dimensioned local picture');
ok(!/https?:\/\//.test(home) && !/data:image\//.test(home), 'new homepage has no remote or embedded image payload');
ok(index.includes('class="osi-eye-emblem" id="osi-about-emblem"') && index.includes('aria-labelledby="osi-eye-title osi-eye-desc"'), 'About uses a scalable, accessible OSI emblem without a boxed raster background');
ok(index.includes('Never used as a proof or verification seal.') && css.includes('.osi-about-wordmark .osi-eye-emblem'), 'About keeps the brand emblem visually distinct from proof status');

const homeSections = [...home.matchAll(/<section\b[^>]*class="[^"]*\bosi-home\b/g)];
const homeWords = home
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z0-9#]+;/gi, ' ')
  .trim()
  .split(/\s+/)
  .filter(Boolean);
ok(homeSections.length === 3, 'Home is limited to three strong product sections');
ok(homeWords.length <= Math.floor(866 * .45), 'Home copy remains at least 55 percent shorter than the 866-word baseline');
ok(!/osi-home-(?:perspectives|workspaces|network|records|boundaries)/.test(home), 'retired newspaper-style Home sections are absent from markup');

ok(home.includes('>Open a Case</button>') && home.includes('>Browse Public Records</button>'), 'hero exposes the primary Case and public-record routes');
ok(home.includes('onclick="osiV2OpenMyReports()"') && home.includes('onclick="osiNavigate(\'prooflog\')"'), 'workflow controls call real Report and Proof Log routes');
ok(home.includes('class="art-manifest"') && home.includes('class="art-version art-version-current"') && home.includes('class="art-hash-ring"') && home.includes('Build a Versioned Report'), 'Report route visibly binds evidence manifest, immutable version and hash lock');
ok(home.includes('<strong>Review</strong>') && home.includes('onclick="osiV2OpenReviewQueue()"'), 'Home review step opens the authorized Review Queue');
ok(home.includes('No custody') && home.includes('Support never changes review, ranking, or governance'), 'money and governance boundaries are explicit');
ok(!/SAS|durable record fields|<span>Planned<\/span>/i.test(home), 'premature SAS and planned durable-record claims are absent');
ok(!home.includes('data-action-contract='), 'Home stays explanatory instead of duplicating the live action-contract surface');
ok(home.includes('Only when an eligible transfer confirms') && home.includes('<strong>After confirmation</strong>'), 'static proof model uses conditional verification language');
for (const action of ['case', 'report', 'wire', 'analyst', 'review', 'governance', 'money', 'proof', 'operations']) {
  ok((index.match(new RegExp(`data-action-contract="${action}"`, 'g')) || []).length === 1,
    `${action} action contract appears exactly once`);
}
const platformMenuStart = index.indexOf('id="platform-menu"');
const platformMenu = index.slice(platformMenuStart, index.indexOf('<button class="osi-nav-link"', platformMenuStart));
const walletMenu = index.slice(index.indexOf('id="wbMenu"'), index.indexOf('</header>'));
ok((platformMenu.match(/data-action-contract=/g) || []).length === 5, 'Platform menu owns its five public and governance action contracts');
ok((walletMenu.match(/data-action-contract=/g) || []).length === 4, 'wallet menu owns its four private and maintainer action contracts');
ok(/id="maintainerAccessMenu"[^>]*style="display:none"[^>]*data-action-contract="operations"/.test(walletMenu), 'Operations stays hidden behind the maintainer capability gate');

ok(shell.includes("op: 'list_public_cases'") && shell.includes("op: 'list_public_profiles'"), 'homepage reads only dedicated public endpoints');
ok(!/(details_private|summary_private|restricted_detail|private_note)/.test(shell), 'homepage bundle does not request or render restricted fields');
ok(shell.includes('No cached or invented Case data is shown') && shell.includes('No cached or invented analyst identity is shown'), 'failure states never substitute invented data');
ok(shell.includes("event.key === 'Escape'") && shell.includes("event.key !== 'Tab'"), 'menus implement Escape and mobile focus trapping');
ok(shell.includes('window.addEventListener(\'popstate\'') && shell.includes('window.history.pushState'), 'navigation supports browser history');
ok(signal.includes('requestAnimationFrame') && signal.includes('IntersectionObserver'), 'signal motion is frame-throttled and viewport-scoped');
ok(signal.includes('prefers-reduced-motion: reduce') && signal.includes('(pointer: fine)'), 'pointer illumination respects motion and input capabilities');
ok(signal.includes('var SIGNAL_TIMING = { step: 2200 }') && signal.includes('var SIGNAL_STATES = ['), 'hero signal sequence uses one named calm timing contract');
for (const state of ['WALLET_SIGNED', 'REVIEW_QUORUM', 'CHALLENGE_WINDOW', 'MEMO_ANCHORED', 'SOL_TRANSFER_VERIFIED']) {
  ok(signal.includes(`'${state}'`), `signal sequence includes truthful ${state} state`);
}

ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion behavior is defined');
ok(css.includes('@media (max-width: 390px)'), '390px mobile layout is explicitly covered');
ok(!/transition\s*:\s*all/i.test(css), 'redesign avoids transition-all');
ok(!/#ff7a3d|#ff5a1f|#f97316|#ea580c/i.test(css), 'redesign introduces no orange or red-orange primary color');
ok(favicon.includes('#08090d') && favicon.includes('#ff4d5f') && favicon.includes('#f5f0e8'), 'favicon follows the red signal and platinum identity');
ok(css.includes(':focus-visible') && css.includes('outline: 2px solid'), 'visible keyboard focus is preserved');
ok(/\.osi-hero-lede\s*\{[\s\S]*?font-size:\s*clamp\(16px,\s*1\.25vw,\s*18px\)/.test(css), 'hero body copy preserves a comfortable reading size');
ok(shell.includes("document.documentElement.classList.add('nav-open')") && shell.includes("document.documentElement.classList.remove('nav-open')"), 'mobile drawer locks and releases the document root');
for (const marker of [
  'class="cr-aside" aria-label="Public Records trust console" tabindex="0"',
  'class="lb-aside" aria-label="Reputation system" tabindex="0"',
  'class="pl-aside" aria-label="Proof log reference" tabindex="0"',
  'class="wire-side" aria-label="Wire guide" tabindex="0"'
]) {
  ok(index.includes(marker), 'mobile horizontal reference region remains keyboard scrollable');
}
ok(index.includes('id="pl-dash" role="region" aria-label="Proof Log summary" tabindex="0"'), 'mobile Proof Log summary strip is a named keyboard-scrollable region');
const about = index.slice(index.indexOf('<section class="sec osi-about"'), index.indexOf('<div class="fo-modal" id="apx-modal"'));
ok(about.includes('Product boundary') && about.includes('Proof vocabulary') && about.includes('Protocol principles') && !/\babt-|\bab-/.test(about), 'About uses the shared design system without repeating the Home lifecycle card wall');
ok(about.includes('Wallet-signed and server-verified. Never labeled on-chain.') && about.includes('Memo-anchored on Solana only after the exact transaction confirms.') && about.includes('Verified SOL'), 'About preserves distinct and truthful proof vocabulary');
ok(css.includes('.osi-about-hero') && css.includes('.osi-about-proof-grid') && css.includes('@keyframes osi-report-bind'), 'About and Report illustration have shared responsive visual styling');
ok(index.includes('<form class="adm-card" onsubmit="event.preventDefault();admLogin()">') && index.includes('id="admMsg" role="status" aria-live="polite"'), 'maintainer sign-in is keyboard-submittable and reports status accessibly');
ok(!/onclick="[^"]*showView\(/.test(index), 'visible document actions use canonical navigation instead of bypassing history state');

ok(!records.includes('reports.updated_at') && !records.includes('created_at,updated_at'), 'legacy public record query does not request a missing column');
const idContext = { Math };
vm.runInNewContext(records.slice(records.indexOf('function crStableIdHash'), records.indexOf('function crCountTokens')), idContext);
const legacyRefA = idContext.osiCaseId('rep_1782886895974');
const legacyRefB = idContext.osiCaseId('rep_1782633406125');
ok(legacyRefA !== legacyRefB && /^OSI-[A-Z0-9]{6}-[A-F0-9]{8}$/.test(legacyRefA), 'legacy fallback references are stable and do not collapse records with a shared prefix');
ok(records.includes("return '<article class=\"'+cls+'\" data-cid=\"'+crAttr(r.id)+'\">'") && !records.includes('role="button" tabindex="0" onclick="openCaseRecord'), 'public record cards avoid nested interactive controls');
ok(index.includes('id="cr-drawer" aria-hidden="true" hidden') && index.includes('aria-modal="true" aria-labelledby="cr-drawer-title"'), 'public record drawer starts hidden and exposes modal semantics');
ok(records.includes("event.key==='Escape'") && records.includes('crDrawerReturnFocus') && records.includes("event.key!=='Tab'"), 'public record drawer closes on Escape, traps focus and restores the trigger');
ok(records.includes('Imported test material') && records.includes('Treat certainty claims as unverified.'), 'legacy test and certainty language is visibly qualified');
ok(!index.includes('Recently updated</option>'), 'unsupported recently-updated sort is not exposed');
ok(!safety.includes('setTimeout(welcomeShow, 800)'), 'first load no longer forces an unsolicited briefing modal');
ok(!index.includes('12-demo-briefing.js') && !index.includes('id="demo-root"'), 'production document contains no briefing or demo runtime');
ok(cases.includes("setReviewNavigationVisibility(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true)"), 'review navigation is revealed only from server-derived capability');

const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, position) => ids.indexOf(id) !== position);
ok(duplicateIds.length === 0, 'integrated document has no duplicate IDs');
ok((index.match(/How a record becomes public/g) || []).length === 1, 'public-record explanation remains unique');

console.log('1..' + assertions);
