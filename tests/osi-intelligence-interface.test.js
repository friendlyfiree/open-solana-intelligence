// Dependency-free regression contract for the integrated intelligence interface.
// Run: node tests/osi-intelligence-interface.test.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const css = read('assets/css/70-intelligence-redesign.css');
const shell = read('assets/js/94-navigation-shell.js');
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
ok(index.includes('<main id="main-content" tabindex="-1">') && index.includes('class="skip-link"'), 'main landmark and keyboard skip link are present');
ok(index.indexOf('70-intelligence-redesign.css') > index.indexOf('v2-activation.css'), 'redesign CSS is the final cascade layer');
ok(index.indexOf('94-navigation-shell.js') > index.indexOf('99-app.js'), 'navigation enhancement loads after the existing application');
const externalScripts = [...index.matchAll(/<script\b[^>]*\bsrc="[^"]+"[^>]*><\/script>/g)].map((match) => match[0]);
ok(externalScripts.length > 0 && externalScripts.every((tag) => /\bdefer\b/.test(tag)), 'external scripts preserve order without blocking HTML parsing');
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

ok(home.includes('>Open a Case</button>') && home.includes('>Explore Field Office</button>'), 'hero preserves the approved primary and secondary actions');
ok(home.includes('onclick="osiV2OpenMyReports()"') && home.includes("osiNavigateFieldStage('challenge_active')"), 'workflow controls call real Report and challenge routes');
ok(home.includes('No custody') && home.includes('Support never changes ranking'), 'money and governance boundaries are explicit');
ok(!/SAS|durable record fields|<span>Planned<\/span>/i.test(home), 'premature SAS and planned durable-record claims are absent');
ok(home.includes('data-action-contract="operations"') && home.includes('data-action-contract="money"'), 'live Operations and payment paths are visible');

ok(shell.includes("op: 'list_public_cases'") && shell.includes("op: 'list_public_profiles'"), 'homepage reads only dedicated public endpoints');
ok(!/(details_private|summary_private|restricted_detail|private_note)/.test(shell), 'homepage bundle does not request or render restricted fields');
ok(shell.includes('No cached or invented Case data is shown') && shell.includes('No cached or invented analyst identity is shown'), 'failure states never substitute invented data');
ok(shell.includes("event.key === 'Escape'") && shell.includes("event.key !== 'Tab'"), 'menus implement Escape and mobile focus trapping');
ok(shell.includes('window.addEventListener(\'popstate\'') && shell.includes('window.history.pushState'), 'navigation supports browser history');

ok(css.includes('@media (prefers-reduced-motion: reduce)'), 'reduced-motion behavior is defined');
ok(css.includes('@media (max-width: 390px)'), '390px mobile layout is explicitly covered');
ok(!/transition\s*:\s*all/i.test(css), 'redesign avoids transition-all');
ok(!/#ff7a3d|#ff5a1f|#f97316|#ea580c/i.test(css), 'redesign introduces no orange or red-orange primary color');
ok(css.includes(':focus-visible') && css.includes('outline: 2px solid'), 'visible keyboard focus is preserved');

ok(!records.includes('reports.updated_at') && !records.includes('created_at,updated_at'), 'legacy public record query does not request a missing column');
ok(!index.includes('Recently updated</option>'), 'unsupported recently-updated sort is not exposed');
ok(!safety.includes('setTimeout(welcomeShow, 800)'), 'first load no longer forces an unsolicited briefing modal');
ok(!index.includes('12-demo-briefing.js') && !index.includes('id="demo-root"'), 'production document contains no briefing or demo runtime');
ok(cases.includes("setReviewNavigationVisibility(state.capabilities.analyst_eligible===true||state.capabilities.maintainer_access===true)"), 'review navigation is revealed only from server-derived capability');

const ids = [...index.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
const duplicateIds = ids.filter((id, position) => ids.indexOf(id) !== position);
ok(duplicateIds.length === 0, 'integrated document has no duplicate IDs');
ok((index.match(/How a record becomes public/g) || []).length === 1, 'public-record explanation remains unique');

console.log('1..' + assertions);
