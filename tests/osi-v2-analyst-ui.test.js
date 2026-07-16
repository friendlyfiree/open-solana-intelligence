// Focused static contract tests for the mature native V2 analyst experience.
// Run: node tests/osi-v2-analyst-ui.test.js
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const html = read('index.html');
const analyst = read('assets/js/v2-analyst-integration.js');
const walletWorkspace = read('assets/js/60-wallet-workspace.js');
const wire = read('assets/js/40-wire-field.js');
const maintainer = read('assets/js/54-maintainer-console.js');
const identity = read('assets/js/30-analysts-identity.js');
const css = read('assets/css/v2-activation.css');

let assertions = 0;
function ok(value, message) {
  assertions += 1;
  if (!value) throw new Error('not ok ' + assertions + ' - ' + message);
  console.log('ok ' + assertions + ' - ' + message);
}

ok(html.includes('assets/js/v2-analyst-integration.js'), 'mature app loads native analyst integration');
ok(html.includes('assets/css/v2-activation.css'), 'mature app loads shared activation foundation');
ok(html.includes('My Analyst Profile') && html.includes('Applications'), 'My OSI exposes profile and application workspaces');
ok(html.includes('onsubmit="osiAnalystSubmit(event)"'), 'application form maps to the native submit operation');
ok(html.includes('accept="image/png,image/jpeg"'), 'profile image picker excludes SVG and arbitrary formats');
ok(!html.includes('Most backed') && !html.includes('data-s="supported"'), 'The Wire has no support-based sort control');
ok(!wire.includes("wireState.sort==='supported'"), 'The Wire cannot order by support signals');
ok(wire.includes('interest signals') && wire.includes('Signal interest'), 'support counts are neutral interest information');

ok(analyst.includes("/functions/v1/osi-v2-analyst"), 'all analyst UI operations use the dedicated Edge Function');
ok(analyst.includes("op:'list_public_profiles'"), 'public directory uses the least-privilege public profile operation');
ok(analyst.includes('window.renderLeaderboard=renderPublicProfiles'), 'global Analyst Network navigation keeps the native V2 renderer');
ok(!analyst.includes("from('analyst_profiles')") && !analyst.includes('/rest/v1/analyst_'), 'browser does not query private analyst tables directly');
ok(analyst.includes("sessionRead('analyst:workspace','my_workspace')")
  && analyst.includes("sessionRead('analyst:maintainer','maintainer_queue')"),
  'private workspaces use the shared scoped read session');
ok(analyst.includes("op:'prepare_application'") && analyst.includes("op:'commit_application'"), 'application submission has prepare and commit stages');
ok(analyst.includes("op:'prepare_review'") && analyst.includes("op:'commit_review'"), 'maintainer review has prepare and commit stages');
ok(analyst.includes("op:'prepare_activation'") && analyst.includes("op:'commit_activation'"), 'probation activation has prepare and commit stages');
ok(analyst.includes('signMessage(prepared.message)'), 'class-B application and review proofs sign exact server messages');
ok(analyst.includes('castOnchainVote(prepared.memo)'), 'probation activation uses an exact Solana Memo');
ok(analyst.includes('transaction_not_confirmed') && analyst.includes('commitActivationWithConfirmation'), 'UI never treats an unconfirmed Memo as success');
ok(analyst.includes("weight '+Number(committed.analyst.weight).toFixed(2)"), 'activated weight is displayed from the server result');
ok(analyst.includes('Support analyst with SOL') && analyst.includes('osiV2SupportAnalyst'), 'public verified profile exposes the native SOL support action');
ok(analyst.includes('SOL transfer verified on Solana') && analyst.includes('recipient_amount_lamports'), 'analyst proof history labels finalized support and shows the exact recipient lamports');

ok(analyst.includes('trustedAvatar') && analyst.includes('osi-analyst-avatars'), 'public avatar rendering accepts only the owned storage prefix');
ok(analyst.includes("['image/png','image/jpeg']") && analyst.includes('524288'), 'client mirrors strict avatar MIME and size gates');
ok(analyst.includes('details_restricted') && analyst.includes("'analyst:workspace'"), 'restricted application details render only in scoped private workspaces');
ok(analyst.includes('aria-label="Analyst workspace sections"')
  && analyst.includes('role="tab"')
  && analyst.includes('aria-controls="osi-workspace-panel-profile"')
  && analyst.includes("['ArrowLeft','ArrowRight','Home','End']"),
  'native analyst tabs use roving focus, controlled panels, and complete arrow-key navigation');
ok(analyst.includes('aria-label="Related private work"')
  && analyst.includes('osiV2OpenMyCases()')
  && analyst.includes('osiV2OpenMyReports()')
  && analyst.includes('osiV2OpenReviewQueue()'),
  'analyst workspace routes related work through signed V2 collections outside the tablist');
ok(walletWorkspace.includes('aria-controls="identity-panel-')
  && walletWorkspace.includes("['ArrowLeft','ArrowRight','Home','End']")
  && walletWorkspace.includes("b.setAttribute('tabindex', on ? '0' : '-1')"),
  'identity tabs expose controlled panels and roving keyboard focus');
ok(!walletWorkspace.includes("showView('profile')")
  && !walletWorkspace.includes('openSelfProfile()'),
  'current identity and workspace controls cannot enter the legacy local XP profile');
ok(walletWorkspace.includes("['My Cases','Private and public Cases authorized for this wallet.',\"osiV2OpenMyCases()\"]")
  && walletWorkspace.includes("['My Reports','Exact immutable Report version history.',\"osiV2OpenMyReports()\"]")
  && walletWorkspace.includes("['Report Review Queue','Exact unpublished Report versions awaiting review.',\"osiV2OpenReportQueue()\"]"),
  'wallet and analyst cards route through the real V2 private-read functions');
ok(walletWorkspace.includes("['Operations Center','Double-gated lifecycle and publication controls.',\"admOpen()\"]")
  && walletWorkspace.includes("['Analyst Applications','Double-gated application review queue.',\"admOpen()\"]"),
  'maintainer cards enter the double-gated native Operations surface');
ok(walletWorkspace.includes('Profile and privacy settings require a dedicated server-authorized mutation')
  && !walletWorkspace.includes('Use the existing Profile view'),
  'settings state truthfully reports the unavailable server-authorized mutation');
ok(analyst.includes('permitted') === false || !analyst.includes('abstain_available:true'), 'UI never invents an abstain transition');
ok(analyst.includes('Abstain is unavailable'), 'Operations Center explains the canonical abstain limitation');
ok(!maintainer.includes('Approve / Reject disabled: Requires hardened backend'), 'obsolete analyst placeholder control is removed');
ok(!maintainer.includes('Seal Record disabled: Requires hardened backend review'), 'obsolete sealing placeholder control is removed');
ok(!identity.includes('(m.stats.reports||0)*10'), 'legacy profile no longer calculates hardcoded REP');
ok(!html.includes('Apply for credentials'), 'application wording describes the real action');

ok(css.includes(':focus-visible'), 'shared UI has visible keyboard focus');
ok(css.includes('prefers-reduced-motion:reduce'), 'shared UI respects reduced motion');
ok(css.includes('@media(max-width:600px)') && css.includes('@media(max-width:900px)'), 'analyst surfaces adapt to mobile and tablet widths');
ok(!analyst.includes('\u2014') && !css.includes('\u2014'), 'new visible analyst UI introduces no em dash');

console.log('1..' + assertions);
