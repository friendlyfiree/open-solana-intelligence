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
ok(html.includes('id="an-safety" type="checkbox" required')
  && html.includes('Describe your work (optional)')
  && analyst.includes('safety_acknowledged:document.getElementById(\'an-safety\').checked===true'),
  'application keeps a signed safety acknowledgement while detailed experience is optional');
ok(html.includes('Apply in about one minute')
  && html.includes('This is the only written field required for a first application.')
  && html.includes('id="analyst-optional-details"')
  && html.includes('SIGN ONCE AND SUBMIT'),
  'first application exposes a one-minute minimal path and collapses optional evidence');
ok(html.includes('id="apx-modal" role="dialog" aria-modal="true" aria-hidden="true" aria-labelledby="osi-application-title"')
  && analyst.includes("modal.setAttribute('aria-hidden','false')")
  && analyst.includes("modal.setAttribute('aria-hidden','true')"),
  'application dialog publishes an exact accessible open and closed state');
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
ok(!analyst.includes('Approve the wallet message to unlock the private application workspace.')
  && analyst.includes("var target=document.getElementById('an-bio')")
  && analyst.includes('Only the final exact message needs one wallet signature.'),
  'first application opens without a private-read signature and focuses the only required written field');
ok(analyst.includes("op:'prepare_review'") && analyst.includes("op:'commit_review'"), 'maintainer review has prepare and commit stages');
ok(analyst.includes("op:'prepare_activation'") && analyst.includes("op:'commit_activation'"), 'probation activation has prepare and commit stages');
ok(analyst.includes('signMessage(prepared.message)'), 'class-B application and review proofs sign exact server messages');
ok(analyst.includes('castOnchainVote(prepared.memo)'), 'probation activation uses an exact Solana Memo');
ok(analyst.includes('transaction_not_confirmed') && analyst.includes('commitActivationWithConfirmation'), 'UI never treats an unconfirmed Memo as success');
ok(analyst.includes("weight '+Number(committed.analyst.weight).toFixed(2)"), 'activated weight is displayed from the server result');
ok(analyst.includes('Support with SOL via Phantom or Solana Pay') && analyst.includes('osiV2SupportAnalyst'), 'public verified profile exposes Phantom and Solana Pay support');
ok(analyst.includes('SOL transfer verified on Solana') && analyst.includes('recipient_amount_lamports'), 'analyst proof history labels finalized support and shows the exact recipient lamports');
ok(html.includes('id="an-handle"') && html.includes('id="an-x-handle"')
  && analyst.includes('handle:handle') && analyst.includes('x_handle:xHandle'),
  'OSI handle and X handle are separate optional application fields');
ok(!analyst.includes("'@'+esc(profile.handle)") && analyst.includes("profile.handle?'@'+profile.handle:short(profile.wallet)"),
  'blank handles fall back to the wallet without rendering @null');
ok(analyst.includes("body.setAttribute('aria-busy','true')")
  && analyst.includes('state.profilesPromise')
  && analyst.includes('data-profile-retry'),
  'cold profile opens expose a deduplicated loading state and retry action');
ok(analyst.includes("osiV2RenderSubmissionReceipt('osi-analyst-receipt'")
  && !analyst.includes("setTimeout(function(){closeApplication();openWorkspace('applications');},700)"),
  'application success keeps a persistent exact-version receipt until navigation or dismissal');
ok(analyst.includes('window.osiAnalystLoadReviewTasks=loadMaintainerQueueData')
  && analyst.includes('window.osiAnalystOpenMaintainerApplication')
  && analyst.includes('String(application.version.version_ref)!==String(expectedVersionRef')
  && analyst.includes('This exact application task changed. Refresh My Reviews before acting.'),
  'application review tasks compose into the unified queue with exact-target routing');
ok(!analyst.includes('Submit a new application version')
  && analyst.includes('No new version is needed now. Open My Applications')
  && analyst.includes('application_under_review'),
  'pending applicants are routed to status instead of a duplicate submission dead end');

ok(analyst.includes('trustedAvatar') && analyst.includes('osi-analyst-avatars'), 'public avatar rendering accepts only the owned storage prefix');
ok(analyst.includes("['image/png','image/jpeg']") && analyst.includes('524288'), 'client mirrors strict avatar MIME and size gates');
ok(analyst.includes('details_restricted') && analyst.includes("'analyst:workspace'"), 'restricted application details render only in scoped private workspaces');
ok(html.includes('class="ap-modal-card" role="dialog" aria-modal="true"')
  && analyst.includes('profileReturnFocus')
  && analyst.includes('trapModalFocus(event,profileModal)')
  && analyst.includes("event.key==='Escape'"),
  'public Analyst profile modal traps keyboard focus, closes on Escape, and restores its opener');
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
ok(css.includes('.osi-application-steps')
  && css.includes('.osi-application-optional')
  && css.includes('.osi-application-actions'),
  'fast application guidance, progressive disclosure and mobile actions have dedicated styling');
ok(!analyst.includes('\u2014') && !css.includes('\u2014'), 'new visible analyst UI introduces no em dash');

// \u2500\u2500 Verified work record: the CV surface \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// A track record that a reader cannot open, cannot send and cannot attach to
// an application is a list, not a credential. These are the four properties
// that make it one, plus the two honesty rules it must never break.
ok(analyst.includes('function recordSection(record)')
  && analyst.includes('recordSection(profile.record)'),
  'both the analyst and the maintainer profile render the same verified work record');
ok(analyst.includes("'Each row is a signed act on a record anyone can open. An outcome states where the process reached, never that a finding is true.'"),
  'the record states in its own copy that an outcome is a process state, not a verdict');
ok(/function recordEntryHref\(entry\)[\s\S]*?\/\^OSI-\[0-9A-Z\]\{6,20\}\$\/\.test\(ref\)/.test(analyst)
  && analyst.includes("'#case/'+encodeURIComponent(ref)"),
  'a record row links only to a validated public Case reference');
ok(analyst.includes("esc(t(OUTCOME_LABELS[outcome]||label(outcome)))")
  && analyst.includes("'<b class=\"osi-cv-title\" data-osi-user-content>'+esc(title)"),
  'record titles and outcomes are escaped and marked as user content');
ok(analyst.includes("osi-cv-act-offchain")
  && /function recordAct\(act\)[\s\S]*?act\.proof_type==='solana_memo'/.test(analyst),
  'only a Memo receipt gets a chain link; a wallet signature is labelled as what it is');
ok(analyst.includes("'{count} further signed acts are on subjects that are not public yet. They are counted here and deliberately not named.'"),
  'work on a private subject is counted in the record and never named');

// A profile address is public or it does not exist. A wallet in a URL would
// make the shareable link an identifier the reader never chose to publish.
ok(/function profileRoute\(profile,isMaintainer\)[\s\S]*?\/\^\[a-z0-9_\]\{2,32\}\$\/\.test\(handle\)\?origin\+'#analyst\/'\+handle:''/.test(analyst),
  'a profile with no public handle gets no shareable address rather than a wallet URL');
ok(analyst.includes("function analystRouteHandle(hash)")
  && analyst.includes("function adoptProfileRoute(hash)")
  && analyst.includes("function clearProfileRoute()")
  && analyst.includes("window.addEventListener('popstate',routeProfileFromLocation)"),
  'opening a profile adopts its address, closing it releases the address, and Back works');
ok(/function adoptProfileRoute[\s\S]*?window\.history\.replaceState/.test(analyst)
  && !/function adoptProfileRoute[\s\S]*?window\.history\.pushState/.test(analyst),
  'a profile address replaces rather than stacking a history entry per profile glanced at');
ok(analyst.includes("op:'get_public_profile'"),
  'a shared profile link resolves one profile instead of requiring the whole roster');

ok(css.includes('@media print')
  && css.includes('body>#ap-modal.open{display:block!important')
  && css.includes('.osi-cv-hide-in-print'),
  'the profile prints as a standalone document with its interactive controls removed');
ok(css.includes(".osi-cv-act-proof[href]::after{content:' (' attr(href) ')'"),
  'a printed record keeps its verification links readable on paper');

console.log('1..' + assertions);
