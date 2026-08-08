// Dependency-free structural regression tests for the integrated V2 Case UI.
// Run: node tests/osi-v2-case-ui.test.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const index = read('index.html');
const legacy = read('legacy.html');
const app = read('assets/js/v2-case-integration.js');
const css = read('assets/css/v2-case-integration.css');
const reportIntegration = read('assets/js/v2-report-integration.js');
const analystIntegration = read('assets/js/v2-analyst-integration.js');
const aiPackIntegration = read('assets/js/v2-ai-pack-integration.js');
const functionalSurface = read('assets/js/88-functional-surface.js');
const briefing = read('assets/js/12-demo-briefing.js');
const solanaPay = read('assets/js/73-solana-pay.js');

let pass = 0;
let fail = 0;
function ok(name, condition) {
  if (condition) pass++;
  else { fail++; console.log('FAIL ' + name); }
}

ok('Case lifecycle is integrated into the primary app',
  index.includes('assets/js/v2-case-integration.js') &&
  index.includes('assets/css/v2-case-integration.css'));
ok('Home exposes the primary Case intake and public Case registry actions',
  index.includes('onclick="osiOpenCase()">Open a Case</button>')
    && index.includes('onclick="osiBrowsePublicCases()">Browse Public Cases</button>'));
ok('sealed Public Records stay reachable under an unambiguous label',
  index.includes('onclick="osiNavigate(\'records\')">Browse sealed Public Records</button>'));
ok('Case integration overrides the legacy Field renderer before app boot',
  index.indexOf('assets/js/v2-case-integration.js') < index.indexOf('assets/js/99-app.js'));
ok('AI Pack integration loads before the Case drawer that consumes it',
  index.indexOf('assets/js/v2-ai-pack-integration.js') > 0
    && index.indexOf('assets/js/v2-ai-pack-integration.js') < index.indexOf('assets/js/v2-case-integration.js'));
ok('legacy fallback does not load the V2 Case integration',
  !legacy.includes('v2-case-integration'));
ok('preview is not promoted from the primary app',
  !index.includes('v2-preview.html'));
ok('preview document is retired behind a permanent root redirect',
  !fs.existsSync(path.join(root, 'v2-preview.html'))
    && /"source"\s*:\s*"\/v2-preview\.html"/.test(read('vercel.json'))
    && /"destination"\s*:\s*"\/"/.test(read('vercel.json'))
    && /"permanent"\s*:\s*true/.test(read('vercel.json')));
ok('primary app provides a local favicon without a network 404',
  index.includes('./assets/favicon.svg')
    && fs.existsSync(path.join(root, 'assets/favicon.svg'))
    && /"source"\s*:\s*"\/favicon\.ico"/.test(read('vercel.json'))
    && /"destination"\s*:\s*"\/assets\/favicon\.svg"/.test(read('vercel.json')));
ok('primary navigation keeps Field Office and The Wire',
  index.includes('data-view="field"') && index.includes('data-view="wire"'));
ok('My Cases is in the wallet menu',
  /role="menuitem"[^>]+osiV2OpenMyCases/.test(index));
ok('My Reviews is in the wallet menu',
  /role="menuitem"[^>]+osiV2OpenReviewQueue/.test(index));
ok('My Reports is active only because it is wired to the signed Report read gateway',
  /role="menuitem"[^>]+data-action-contract="report"[^>]+data-endpoint="osi-v2-report-read:list_my_reports"[^>]+onclick="osiRunLiveAction\('report'\)[^"]*"[^>]*>My Reports/.test(index)
    && functionalSurface.includes("if(id==='report')return need(env,'openMyReports')()")
    && reportIntegration.includes("list_my_reports"));
ok('My OSI is not a primary navigation item',
  !/<button class="sb-item"[^>]*>\s*<span>My OSI<\/span>/.test(index));
ok('My Cases is not duplicated into a secondary rail',
  !read('assets/js/44-prooflog-deck.js').includes("'My Cases',\"showView('field');fieldMine(true)\""));

for (const field of [
  'v2-case-category', 'v2-case-title', 'v2-case-summary',
  'v2-case-details', 'v2-case-wallets', 'v2-case-transactions',
  'v2-case-urls', 'v2-case-reward', 'v2-case-confirm',
]) {
  ok('private Case form contains ' + field, index.includes('id="' + field + '"'));
}
ok('Case form uses the real signed submission handler',
  index.includes('onsubmit="osiV2SubmitCase(event)"'));
for (const section of [
  'Overview', 'Evidence', 'Reports', 'Reviews', 'AI Pack',
  'Resolution', 'Challenges', 'Rewards & Support', 'Proof Log',
]) {
  ok('Case detail exposes ' + section, app.includes(section));
}

ok('browser calls dedicated read and write functions',
  app.includes('/functions/v1/osi-v2-case-read') &&
  app.includes('/functions/v1/osi-v2-case-write'));
ok('Case timestamps follow the selected product locale instead of the browser locale',
  app.includes("window.OSI_I18N.getLocale()")
    && app.includes("==='tr'?'tr-TR':'en-US'")
    && app.includes("date.toLocaleString(locale,{dateStyle:'medium',timeStyle:'short'})")
    && !app.includes("date.toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'})"));
ok('Case drawer localizes generated labels without translating author content',
  app.includes('esc(t(tab[1]))')
    && app.includes("esc(t('Case overview'))")
    && app.includes("esc(t('Created'))")
    && app.includes("esc(t('Summary'))")
    && app.includes("esc(t('Submit Report'))")
    && app.includes('caseProse(item.summary)')
    && app.includes('data-osi-user-content'));
ok('AI Pack browser calls only its dedicated trusted gateway',
  aiPackIntegration.includes('/functions/v1/osi-v2-ai-pack')
    && !/supa(?:Post|Patch|Delete)|\.from\(/.test(aiPackIntegration));
ok('AI Pack generation is Case-specific and fails closed on the server capability',
  aiPackIntegration.includes("op:'capabilities'")
    && aiPackIntegration.includes('case_ref:ref')
    && aiPackIntegration.includes('!reason&&caps.can_generate===true'));
ok('global capability refresh skips AI Pack until an exact Case is active',
  app.includes("var aiPackCaseRef=String(state.current&&state.current.public_ref||'')")
    && app.includes('if(aiPackCaseRef){')
    && app.includes('case_ref:aiPackCaseRef')
    && !app.includes('case_ref:state.current&&state.current.public_ref||undefined'));
ok('AI Pack tab appears only for the exact full-maintainer private mode',
  app.includes("state.capabilities.maintainer_access===true")
    && app.includes("state.capabilities.ai_pack_access_mode==='maintainer_only'")
    && app.includes("tab[0]!=='ai_pack'||aiVisible"));
ok('AI Pack browser render fails closed for anonymous, owner, analyst and half-maintainer states',
  aiPackIntegration.includes("state.capabilities.ai_pack_access_mode!=='maintainer_only'||state.capabilities.maintainer_access!==true")
    && aiPackIntegration.includes("if(!wallet()||typeof window.osiV2ReadSession!=='function')return false")
    && aiPackIntegration.includes("window.osiV2ReadSession(['aipack:detail']"));
ok('maintainer-only AI Pack reads never fall through to a public discovery endpoint',
  aiPackIntegration.includes("op:'get_case_packs'")
    && !aiPackIntegration.slice(
      aiPackIntegration.indexOf('async function performLoad'),
      aiPackIntegration.indexOf('function reload'),
    ).includes('list_public'));
ok('maintainer-only drafts expose no review, owner-feedback, approval, or publication controls',
  aiPackIntegration.includes('<b>Private draft only</b>')
    && aiPackIntegration.includes('Analyst review, owner feedback, approval, and public publication are intentionally unavailable')
    && aiPackIntegration.includes("if((state.capabilities||{}).ai_pack_access_mode==='maintainer_only')return'';"));
ok('AI Pack never invents staleness or receipt verification',
  aiPackIntegration.includes('staleness unavailable')
    && aiPackIntegration.includes('Proof unavailable')
    && !aiPackIntegration.includes("row.proof_label||'Wallet-signed and server-verified'"));
ok('AI Pack content remains a component profile rather than one headline score',
  aiPackIntegration.includes('Public verifiability')
    && aiPackIntegration.includes('Count-gated analyst attestation')
    && aiPackIntegration.includes('does not calculate an accuracy'));
ok('AI Pack missing-script state cannot silently fall through to Proof Log',
  app.includes('AI Pack interface did not load')
    && app.includes("state.tab==='ai_pack'?"));
ok('closing or invalidating a Case wipes AI Pack state and rendered drawer content',
  app.includes('function wipeCaseDrawerContent()')
    && app.includes('window.osiV2AiPackClear()')
    && aiPackIntegration.includes('state.loadToken++')
    && aiPackIntegration.includes('root.replaceChildren()'));
ok('browser calls the dedicated server-only native SOL gateway',
  app.includes('/functions/v1/osi-v2-payment') && app.includes("op:'prepare_payment'")
    && app.includes("op:recovery?'recover_payment':'commit_payment'"));
ok('reward UI requires the server-derived sealed payment-ready state',
  app.includes('Pay sealed winner') && app.includes("'payment_ready','partially_fulfilled'")
    && app.includes('winning_report_author_wallet') && app.includes('Pledged, not escrowed'));
ok('challenge-window reward control is disabled with the exact sealing prerequisite',
  app.includes('Challenge window must end and the Case must be sealed')
    && app.includes('>Payment unavailable</button>'));
ok('support contributors are bounded to four atomic recipients',
  app.includes('Select up to four recipients') && app.includes('checks.length>4')
    && app.includes('SystemProgram.transfer') && app.includes('bytes.length>1232'));
ok('Phantom pre-sign review states mainnet, exact recipients, irreversibility and no custody',
  app.includes('Review exact mainnet transfer') && app.includes('Solana mainnet-beta')
    && app.includes('This transaction is irreversible') && app.includes('OSI receives no funds'));
ok('pending payment remains awaiting finality with exact retry',
  app.includes("result.state==='awaiting_finality'") && app.includes('not marked paid')
    && app.includes('osiV2RetryPayment'));
ok('submitted signature survives reload and blocks an accidental second payment',
  app.includes("PAYMENT_RECOVERY_PREFIX = 'osi:v2:payment-recovery:2:'")
    && app.includes('localStorage.setItem(paymentRecoveryKey(wallet),serialized)')
    && app.includes('localStorage.getItem(paymentRecoveryKey(wallet))!==serialized')
    && app.includes('<b>Do not start a second payment</b>')
    && app.includes('Re-verify existing signature')
    && app.includes('!pendingRecovery&&Object.keys(supportGroups)'));
ok('wallet account or disconnect hides the pending intent without deleting durable recovery',
  app.includes("provider.on('disconnect',clearPaymentState)")
    && app.includes("provider.on('accountChanged'")
    && app.includes("if(settings.forgetRecovery===true)forgetPaymentRecovery(pendingWallet)"));
ok('wallet opens only after a durable wallet-scoped recovery record exists',
  app.indexOf('persistPaymentPending(pending);') < app.indexOf('var txSig=await sendPreparedPayment')
    && app.includes("throw new Error('payment_recovery_unavailable')")
    && app.includes('exactPaymentProvider(prepared,expectedWallet,generation)'));
ok('restored Solana Pay records are server-poll-only and cannot reconstruct a transfer',
  app.includes('pending.restored_from_storage=true')
    && app.includes("if(pending&&pending.restored_from_storage===true)throw new Error('payment_recovery_poll_only')")
    && app.includes('async function pollRestoredSolanaPay')
    && app.indexOf("state.paymentPending.method==='solana_pay'&&state.paymentPending.restored_from_storage===true")
      < app.indexOf('try{exactPaymentProvider(state.paymentPending.prepared'));
ok('payment proof shows exact lamports, target, slot, finality and transfer verification',
  app.includes('payment.total_lamports') && app.includes('payment.target_public_ref')
    && app.includes('payment.finality') && app.includes('payment.transfers_verified'));
ok('published Reports and verified analyst profiles expose real support actions',
  reportIntegration.includes('osiV2SupportReportAuthor')
    && analystIntegration.includes('osiV2SupportAnalyst'));
ok('primary UI exposes only the server-bound single-recipient Solana Pay route',
  index.includes('assets/js/73-solana-pay.js')
    && index.indexOf('qrcode-generator-1.4.4.min.js') < index.indexOf('assets/js/73-solana-pay.js')
    && solanaPay.includes("params.set('reference',exact.reference)")
    && solanaPay.includes("params.set('memo',exact.memo)")
    && app.includes("op:'poll_solana_pay'")
    && app.includes("method==='solana_pay'")
    && app.includes('Atomic multi-recipient payment')
    && !index.includes('tip-pay-toggle'));
ok('legacy direct payment entry points fail closed outside the archive',
  read('assets/js/70-support-transfer.js').includes("endsWith('/legacy.html')")
    && read('assets/js/40-wire-field.js').includes("endsWith('/legacy.html')")
    && !/Support the OSI project/.test(read('assets/js/60-wallet-workspace.js').split("endsWith('/legacy.html')")[0]));
ok('browser bundle contains no service-role credential name',
  !/service[_-]?role/i.test(app + aiPackIntegration));
ok('browser bundle has no console logging', !/console\s*\./.test(app + aiPackIntegration));
ok('maintainer control uses the mature shell button id',
  app.includes("getElementById('admLockBtn')"));
ok('owners are told self-review is unavailable',
  app.includes('Case owners cannot self-review'));
ok('maintainer review is an honest weight-zero independent open path',
  app.includes('full maintainer path has analyst weight 0') &&
  app.includes('independently authorizes initial open'));
ok('maintainer receives the real review and CASE_OPENED route',
  app.includes('Full maintainer initial-open review') &&
  app.includes("route:route,case_ref:ref") &&
  app.includes('committed.actor_open_ready'));
ok('initial open copy remains explicit that it is not truth or guilt approval',
  app.includes('it does not determine truth or guilt') &&
  app.includes('it is not a truth or guilt decision'));
ok('normal rejection is an analyst-only exact review and Memo outcome',
  app.includes('<option value="reject" data-analyst-only="true">')
    && app.includes("op:'prepare_rejection'")
    && app.includes("op:'commit_rejection'")
    && app.includes('at least 2 independent analysts and total weight 2.00'));
ok('rejected Case owner gets a compact new-evidence appeal path',
  app.includes('Appeal with new evidence')
    && app.includes("op:'prepare_appeal'")
    && app.includes("op:'commit_appeal'")
    && app.includes('fresh review cycle'));
ok('Case form fails closed before opening when the server gate is unavailable',
  app.includes("capabilities.case_writes_enabled!==true"));
ok('public proof attribution is shown only from returned receipt fields',
  app.includes('wallet-signed receipt is server-verified') &&
  app.includes('Memo-anchored on Solana') &&
  app.includes('row.solscan_url'));
ok('new visual layer does not use gradients', !/gradient\s*\(/i.test(css));
ok('legacy operations deck remains hidden in the native Case registry',
  css.includes('.fo-deck[hidden]{display:none!important}'));
// Both spellings count. A `font:` shorthand carries the size too, and that is
// how 9.5px chips reached the Case rows without tripping this gate.
ok('new visual layer does not use 9px micro text',
  !/font-size:\s*(?:8(?:\.\d+)?|9(?:\.\d+)?)px/i.test(css)
  && !/font:[^;}]*?\b(?:8(?:\.\d+)?|9(?:\.\d+)?)px/i.test(css));
ok('responsive and reduced-motion states exist',
  css.includes('@media(max-width:640px)') && css.includes('prefers-reduced-motion:reduce'));
ok('Case form and drawer trap keyboard focus',
  app.includes('function trapFocus(') &&
  (app.includes("event.key==='Tab'") || app.includes("event.key!=='Tab'")));
ok('payment dialogs consume Escape before an underlying drawer or profile can close',
  app.includes("event.stopImmediatePropagation==='function'")
    && app.includes("document.addEventListener('keydown',keyHandler,true)")
    && app.includes("document.removeEventListener('keydown',keyHandler,true)"));
ok('Case detail tabs expose tab semantics',
  app.includes('role="tab"') && app.includes('aria-selected=') &&
  app.includes("'ArrowLeft','ArrowRight','Home','End'") &&
  app.includes('aria-controls="osi-case-content"') &&
  app.includes("content.setAttribute('aria-labelledby'"));
ok('My Reviews composes all eight authorized workflow lanes',
  ['initial_open','report_publication','analyst_applications','wire_reviews','resolution_selection','challenge_admissibility','challenge_adjudication','seal_reviews']
    .every((lane) => app.includes("['" + lane + "'")));
ok('Analyst application tasks bind the immutable version separately from routing',
  app.includes("exact_target:version.version_ref,route_target:application.id")
    && app.includes("osiAnalystOpenMaintainerApplication(task.routeTarget,task.exactTarget)"));
ok('Report queue next actions distinguish standard quorum publication from bootstrap',
  app.includes("var standard=report.can_publish_via_standard_quorum===true")
    && app.includes("standard?'Publish exact Report version from completed analyst quorum'"));
ok('unified lane failures remain errors and expired sessions offer explicit scoped refresh',
  app.includes("errorCode:errorCode||''")
    && app.includes("read_session_(expired|wrong_scope)")
    && app.includes("window.osiV2RefreshReadSession([scope])")
    && app.includes("id==='report_publication'?'report:review'")
    && app.includes("id==='analyst_applications'?'analyst:maintainer'")
    && app.includes("id==='wire_reviews'?'wire:queue':'case:review'"));
ok('server-derived task conflicts survive exact queue routing and suppress conflicted governance controls',
  app.includes('activeReviewTask: null')
    && app.includes('function activeTaskConflict(lane,exactTarget)')
    && app.includes('openCase(task.caseRef||task.exactTarget,task)')
    && app.includes("!conflicted&&admissibilityTask&&(row.state==='submitted'||row.state==='admissibility_review')")
    && app.includes('This wallet is excluded from the exact task by a server-derived conflict rule.'));
ok('governance mutations require their exact My Reviews task even from a direct Case drawer',
  app.includes('function requireActiveReviewTask(lane,exactTarget)')
    && app.includes("if(!requireActiveReviewTask('resolution_selection'))return;")
    && app.includes("if(!requireActiveReviewTask('seal_reviews'))return;")
    && app.includes("if(!requireActiveReviewTask('challenge_admissibility',ref))return;")
    && app.includes("if(!requireActiveReviewTask('challenge_adjudication',ref))return;")
    && app.includes('Direct Case views are read-only.'));
// The Case summary and the restricted detail now render through caseProse, and
// every structured reference through referenceRow. Both still escape each text
// chunk and still mark it data-osi-user-content, so automatic translation and
// stored XSS are excluded on the exact path the content now takes.
ok('Case-authored titles, summaries, evidence, and rationale opt out of automatic translation',
  app.includes("<b data-osi-user-content>'+esc(item.title)")
    && app.includes("caseProse(item.summary)")
    && app.includes("caseProse(item.details_restricted)")
    && /function caseProse\(value\)\{[\s\S]*?<p data-osi-user-content>[\s\S]*?return esc\(line\.trim\(\)\);/.test(app)
    && app.includes('class="osi-ref-value mono" data-osi-user-content title="\'+esc(ref)+\'">\'+esc(ref)+\'</div>')
    && app.includes("<p data-osi-user-content>'+esc(row.public_rationale"));
// Constitution section 8: a public governance decision is publicly attributed,
// and attribution is the analyst's public profile as well as their wallet. The
// list used to print a shortened wallet alone, so a reader could see that
// someone decided but never who, and had no route to their other work.
ok('a public initial review names the analyst profile, not only a shortened wallet',
  app.includes('function reviewerIdentity(wallet)')
    && app.includes('window.VERIFIED_ANALYSTS&&window.VERIFIED_ANALYSTS[address]')
    && app.includes("directory.handle?'@'+directory.handle:directory.name")
    && app.includes('data-analyst-profile="\'+esc(address)+\'"')
    && app.includes('reviewerIdentity(row.reviewer_wallet)'));
ok('the full reviewer wallet is never lost to the shortened display',
  app.includes('title="\'+esc(address)+\'"'));
ok('an attributed reviewer opens the public analyst profile',
  app.includes("event.target.closest('[data-analyst-profile]')")
    && app.includes("window.openAnalystProfile(wallet)"));
ok('a wallet absent from the public directory is stated, never invented',
  app.includes("if(!directory)return '<span class=\"osi-review-actor\"")
    && css.includes('.osi-review-actor{')
    && css.includes('.osi-review-actor-link{'));
ok('all four native submissions retain actionable exact-reference receipts',
  index.includes('id="v2-case-receipt"')
    && index.includes('id="osi-report-receipt"')
    && index.includes('id="osi-analyst-receipt"')
    && index.includes('id="osi-wire-receipt"')
    && app.includes('osiV2RenderSubmissionReceipt')
    && reportIntegration.includes("osiV2RenderSubmissionReceipt('osi-report-receipt'")
    && analystIntegration.includes("osiV2RenderSubmissionReceipt('osi-analyst-receipt'"));
ok('connected Phantom reuses the exact prepared Solana Pay intent',
  app.includes('function sendPreparedSolanaPay(prepared,expectedWallet,generation,onBroadcast)')
    && app.includes('data-solana-pay-phantom')
    && solanaPay.includes("params.set('reference',exact.reference)")
    && app.includes('new web3.PublicKey(prepared.solana_pay.reference)')
    && app.includes("Use connected Phantom")
    && app.includes('exactPaymentProvider(prepared,expectedWallet,generation)'));

function uiFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return uiFiles(full);
    return /\.(?:html|css|js)$/.test(entry.name) ? [full] : [];
  });
}
const sourceFiles = [
  path.join(root, 'index.html'),
  path.join(root, 'legacy.html'),
]
  .concat(uiFiles(path.join(root, 'assets', 'js')))
  .concat(uiFiles(path.join(root, 'assets', 'css')));
for (const file of sourceFiles) {
  const relative = path.relative(root, file);
  ok(relative + ' contains no em dash', !/[—]|&mdash;|&#8212;/.test(fs.readFileSync(file, 'utf8')));
}

console.log((fail ? 'FAILED: ' + fail : 'OK') +
  ' (' + pass + ' assertions passed, ' + fail + ' failed)');
process.exit(fail ? 1 : 0);
