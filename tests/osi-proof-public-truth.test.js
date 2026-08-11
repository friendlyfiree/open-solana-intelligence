// Dependency-free proof/public-record truthfulness regressions.
// Run: node tests/osi-proof-public-truth.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const proofSource = read('assets/js/44-prooflog-deck.js');
const recordsSource = read('assets/js/84-public-records.js');
const index = read('index.html');
const i18nSource = read('assets/js/03-i18n.js');
const TX = '2'.repeat(88);
const CASE_REF = 'OSI-A1B2C3D4E5F6';

let pass = 0;
let fail = 0;
function ok(name, condition) {
  if (condition) pass++;
  else { fail++; console.log('FAIL ' + name); }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function load(source) {
  const context = {
    console, Date, JSON, Math, String, Number, Array, Object, RegExp,
    encodeURIComponent, parseFloat, isNaN,
    navigator: {}, location: { pathname: '/', hash: '' },
    document: {
      addEventListener() {},
      getElementById() { return null; },
      querySelectorAll() { return []; },
    },
    setTimeout(fn) { fn(); },
    clearTimeout() {},
    escapeHtml,
    showToast() {},
    showView() {},
    raTimeAgo() { return 'now'; },
    raShortW(value) { return String(value || '').slice(0, 8); },
    solscanTx(sig) { return 'https://solscan.io/tx/' + encodeURIComponent(sig); },
  };
  context.window = context;
  vm.createContext(context);
  vm.runInContext(source, context);
  return context;
}

const proof = load(proofSource);
const mixed = [
  { proof_type: 'wallet_signed_server_verified', server_verified: true },
  { proof_type: 'solana_memo', server_verified: true, tx_sig: TX },
  {
    proof_type: 'solana_memo', server_verified: true, tx_sig: TX,
    verification_metadata: { memo_verified: true, system_program_transfers_verified: true },
  },
  { proof_type: 'system_event', server_verified: true },
  { proof_type: 'legacy_imported', server_verified: false, tx_sig: TX },
];
const expected = [
  'Wallet-signed and server-verified',
  'Memo-anchored on Solana',
  'SOL transfer verified on Solana',
  'System event',
  'Legacy / not server-verified',
];
expected.forEach((label, index) => {
  ok('mixed proof type keeps exact label: ' + label,
    proof.plProofState(mixed[index]).label === label);
});
ok('transaction signature alone never earns a Memo label',
  proof.plProofState({ tx_sig: TX }).label === 'Legacy / not server-verified');
ok('unverified Memo claim never earns a Memo label',
  proof.plProofState({ proof_type: 'solana_memo', server_verified: false, tx_sig: TX }).key === 'legacy');
ok('Memo claim without an explicit valid proof tx never earns a Memo label',
  proof.plProofState({ proof_type: 'solana_memo', server_verified: true, tx: TX }).key === 'legacy');
ok('SOL transfer requires both Memo and System Program transfer verification',
  proof.plProofState({
    proof_type: 'solana_memo', server_verified: true, tx_sig: TX,
    verification_metadata: { memo_verified: true, system_program_transfers_verified: false },
  }).key === 'memo');
ok('server-projected wallet proof keeps its exact off-chain label',
  proof.plProofState({
    proof_source: 'native_public_dto',
    label: 'Wallet-signed & server-verified',
    actor_role: 'analyst',
  }).key === 'wallet');
ok('server-projected Memo label remains Memo even when payment metadata is present',
  proof.plProofState({
    proof_source: 'native_public_dto',
    label: 'Memo-anchored on Solana',
    event_type: 'SUPPORT_PAYMENT_CONFIRMED',
    tx_sig: TX,
    payment_proof: {
      cluster: 'mainnet-beta', finality: 'finalized',
      payer_wallet: '1'.repeat(32),
      recipient_manifest: [{ wallet: '2'.repeat(32), amount_lamports: '1' }],
      total_lamports: '1',
    },
  }).key === 'memo');
ok('server-projected SOL transfer requires its exact label and complete finalized metadata',
  proof.plProofState({
    proof_source: 'native_public_dto',
    label: 'SOL transfer verified on Solana',
    event_type: 'SUPPORT_PAYMENT_CONFIRMED',
    tx_sig: TX,
    payment_proof: {
      cluster: 'mainnet-beta', finality: 'finalized',
      payer_wallet: '1'.repeat(32),
      recipient_manifest: [{ wallet: '2'.repeat(32), amount_lamports: '1' }],
      total_lamports: '1',
    },
  }).key === 'transfer');
ok('legacy event type cannot invent an analyst or maintainer role',
  proof.plSignerRole({ event_type: 'maintainer_seal', actor_role: 'maintainer', tx_sig: TX }) === 'Unverified actor');
ok('server-projected verified actor role is displayed from the DTO',
  proof.plSignerRole({
    proof_source: 'native_public_dto',
    label: 'Wallet-signed & server-verified',
    actor_role: 'analyst',
  }) === 'Analyst');
ok('Proof Log reads native public DTO receipts before the legacy projection',
  proofSource.includes("window.osiPublicApi('osi-v2-case-read',{op:'list_public_cases'})")
    && proofSource.includes('window.osiV2ListPublicWireReports()')
    && proofSource.includes("proof_source:'native_public_dto'")
    && proofSource.includes("proof_source:'legacy_public_projection'"));
for (const eventType of [
  'CASE_OPENED',
  'CASE_INITIAL_REVIEW_CAST',
  'REPORT_PUBLISHED',
  'WIRE_REPORT_PUBLISHED',
  'SUPPORT_PAYMENT_CONFIRMED',
]) {
  ok('Proof Log displays the exact registry event type ' + eventType,
    proof.plMemo({ event_type: eventType }).tag === eventType);
}
ok('Proof Log reference cards use exact registry event examples',
  ['CASE_OPENED', 'CASE_REPORT_VERSION_SUBMITTED', 'WIRE_REPORT_PUBLISHED',
    'CASE_INITIAL_REVIEW_CAST', 'CHALLENGE_SUBMITTED', 'RECORD_SEALED',
    'SUPPORT_PAYMENT_CONFIRMED'].every((eventType) => proofSource.includes("['" + eventType + "'")));
ok('retired Proof Log aliases are absent',
  !/OSI_(?:CASE_OPENED|REVIEW_SIGNED|REPORT_PUBLISHED|WIRE_PUBLISHED|SUPPORT_SIGNAL)/.test(proofSource));

const accessibleProofCard = proof.plTimelineCard({
  event_type: 'CASE_OPENED',
  proof_source: 'native_public_dto',
  label: 'Memo-anchored on Solana',
  actor_wallet: '1'.repeat(32),
  tx_sig: TX,
  item_id: CASE_REF,
  created_at: '2026-08-08T12:00:00Z',
});
ok('Proof Log copy controls name the wallet and transaction target',
  accessibleProofCard.includes('aria-label="Copy wallet address ')
    && accessibleProofCard.includes('aria-label="Copy transaction signature '));

const proofDash = { innerHTML: '' };
proof.document.getElementById = (id) => id === 'pl-dash' ? proofDash : null;
proof.__plEvents = mixed;
proof.__plSourceState = 'loaded';
proof.plDashRender();
for (const label of ['Wallet verified', 'Memo anchored', 'SOL transfers', 'System events', 'Legacy / unverified']) {
  ok('dashboard exposes a separate ' + label + ' counter', proofDash.innerHTML.includes(label));
}
ok('dashboard no longer counts every transaction link as Memo',
  !proofSource.includes("var memos=evs.filter(function(e){ return !!e.tx_sig; })"));

const refHtml = proof.plReferenceHtml({
  event_type: 'case_opened', item_type: 'case', item_id: CASE_REF,
});
ok('canonical Case reference remains exact in the Proof Log', refHtml.includes(CASE_REF));
ok('Proof Log Case reference is a keyboard-accessible button',
  refHtml.includes('<button') && refHtml.includes('type="button"'));
const wireRefHtml = proof.plReferenceHtml({
  event_type: 'WIRE_REPORT_PUBLISHED', item_type: 'wire',
  item_id: 'OSI-WV-A1B2C3D4E5F60718',
});
ok('exact Wire version reference stays exact and keyboard-accessible in the Proof Log',
  wireRefHtml.includes('OSI-WV-A1B2C3D4E5F60718') && wireRefHtml.includes('plGoWire'));
let openedView = '';
let openedCase = '';
proof.showView = (view) => { openedView = view; };
proof.osiV2OpenCase = (ref) => { openedCase = ref; };
proof.plGoCase('legacy-id', CASE_REF);
ok('canonical Case reference opens the V2 Field Office route',
  openedView === 'field' && openedCase === CASE_REF);
ok('auto-generated cross-view rail is retired',
  !proofSource.includes('osiRailMount') && !proofSource.includes('rail-shell'));
ok('static Field Office contextual rail remains in the primary document',
  /<aside class="fo-rail" aria-label="Field Office navigation">/.test(index));

const records = load(recordsSource);
const legacy = {
  id: 'legacy-row', company: 'Legacy row', summary: 'Imported public material.',
  approved: true, sealed: true, tx: TX, created_at: '2026-01-01T00:00:00Z',
};
ok('legacy approved/sealed booleans do not become a native reviewed or sealed state',
  records.crStatus(legacy).txt === 'Legacy / unverified');
ok('legacy tx field does not become a confirmed Memo', records.crHasMemo(legacy) === false);
const legacyCard = records.crCard(legacy, []);
ok('legacy card carries the honest proof label', legacyCard.includes('Legacy / not server-verified'));
ok('legacy card offers inspection rather than verification',
  legacyCard.includes('Inspect transaction') && !legacyCard.includes('>Verify on Solana</button>'));
ok('legacy card is never labeled reviewed or Memo-anchored',
  !legacyCard.includes('>Reviewed<') && !legacyCard.includes('Memo-anchored on Solana'));

const memoRecord = {
  id: 'native-memo', company: 'Native record', summary: 'Public-safe record.',
  approved: true, sealed: true, created_at: '2026-01-02T00:00:00Z',
  publication_proof: { proof_type: 'solana_memo', server_verified: true, tx_sig: TX },
};
ok('explicit verified native Memo fields can produce a sealed status',
  records.crStatus(memoRecord).txt === 'Sealed' && records.crHasMemo(memoRecord));
const memoCard = records.crCard(memoRecord, []);
ok('verified native Memo card exposes exact label and verification action',
  memoCard.includes('Memo-anchored on Solana') && memoCard.includes('>Verify on Solana</button>'));

const walletRecord = {
  id: 'native-wallet', approved: true,
  proof: { proof_type: 'wallet_signed_server_verified', server_verified: true },
};
ok('a wallet signature alone never becomes a reviewed outcome',
  records.crStatus(walletRecord).txt === 'Under review'
    && records.crProofState(walletRecord).label === 'Wallet-signed and server-verified'
    && !records.crTxSig(walletRecord));
ok('spoofed root tx cannot complete a nested Memo proof',
  records.crProofState({
    approved: true, tx: TX,
    proof: { proof_type: 'solana_memo', server_verified: true },
  }).key === 'legacy');

const nativeReviewed = records.crNativeCaseRecord({
  public_ref: 'OSI-C-REVIEWED000001',
  title: 'Reviewed native Case',
  summary: 'Public-safe summary.',
  stage: 'in_challenge_window',
  reviews: [{ decision: 'approve' }],
  proof_log: [{ label: 'Wallet-signed & server-verified', actor_role: 'analyst' }],
});
ok('native reviewed status comes from the public Case lifecycle plus independent review data',
  records.crStatus(nativeReviewed).txt === 'Reviewed');
const nativeSealed = records.crNativeCaseRecord({
  public_ref: 'OSI-C-SEALED0000001',
  title: 'Sealed native Case',
  summary: 'Public-safe summary.',
  stage: 'sealed',
  reviews: [{ decision: 'approve' }],
  proof_log: [{ event_type: 'RECORD_SEALED', label: 'Memo-anchored on Solana', tx_sig: TX, actor_role: 'maintainer' }],
});
ok('native sealed status requires the exact server-projected RECORD_SEALED Memo receipt',
  records.crStatus(nativeSealed).txt === 'Sealed' && records.crHasMemo(nativeSealed));
const publishedCaseReports = records.crNativeCaseReportRecords({
  public_ref: CASE_REF,
  title: 'Published Case finding',
  category: 'exploit',
  stage: 'open_public',
  reports: [{
    public_ref: 'OSI-RPT-A1B2C3D4E5F6', published: true,
    current_version: {
      version_ref: 'OSI-RV-A1B2C3D4E5F60718', version_no: 2,
      lifecycle_state: 'published', published_at: '2026-08-09T00:00:00Z',
    },
    content_public_safe: 'Exact current published summary.',
    body_private: 'PRIVATE REPORT BODY MUST NOT RENDER',
    versions: [{ version_ref: 'OSI-RV-OLDVERSION0001', lifecycle_state: 'superseded' }],
  }, {
    public_ref: 'OSI-RPT-PRIVATE000001', published: false,
    current_version: {
      version_ref: 'OSI-RV-PRIVATE00000001', lifecycle_state: 'in_review',
      published_at: null,
    },
    content_public_safe: 'UNPUBLISHED EXISTENCE MUST NOT RENDER',
  }, {
    public_ref: 'OSI-RPT-invalid-ref', published: true,
    current_version: {
      version_ref: 'OSI-RV-INVALID00000001', lifecycle_state: 'published',
      published_at: 'not-a-date',
    },
    content_public_safe: 'INVALID IDENTIFIER MUST NOT RENDER',
  }],
  proof_log: [
    { event_type: 'CASE_REPORT_REVIEW_CAST', public_ref: 'OSI-RV-A1B2C3D4E5F60718', label: 'Wallet-signed & server-verified' },
    { event_type: 'CASE_REPORT_REVIEW_CAST', public_ref: 'OSI-RV-A1B2C3D4E5F60718', label: 'Wallet-signed & server-verified' },
    { event_type: 'REPORT_PUBLISHED', public_ref: 'OSI-RV-A1B2C3D4E5F60718', label: 'Memo-anchored on Solana', tx_sig: TX },
  ],
});
ok('Public Records flattens only the exact current published Case Report version',
  publishedCaseReports.length === 1
    && publishedCaseReports[0].version_public_ref === 'OSI-RV-A1B2C3D4E5F60718'
    && publishedCaseReports[0].summary === 'Exact current published summary.'
    && records.crAnalystReviews(publishedCaseReports[0]) === 2
    && records.crHasMemo(publishedCaseReports[0]));
const publishedCaseReportCard = records.crCard(publishedCaseReports[0], []);
ok('published Case Report card links to the canonical parent Case route',
  publishedCaseReportCard.includes('Published Case Report')
    && publishedCaseReportCard.includes('href="#case/' + CASE_REF + '"')
    && publishedCaseReportCard.includes('Open published Report'));
ok('published Case Report card never renders private, unpublished or superseded content',
  !publishedCaseReportCard.includes('PRIVATE REPORT BODY MUST NOT RENDER')
    && !publishedCaseReportCard.includes('UNPUBLISHED EXISTENCE MUST NOT RENDER')
    && !publishedCaseReportCard.includes('OSI-RV-OLDVERSION0001')
    && !publishedCaseReportCard.includes('INVALID IDENTIFIER MUST NOT RENDER'));
const noPublicationProof = { ...publishedCaseReports[0], publication_proof: { proof_source: 'native_public_dto' }, publication_channel: 'unavailable' };
ok('published Case Report never claims governed publication when its receipt is absent',
  records.crStatus(noPublicationProof).txt === 'Publication proof unavailable'
    && records.crIsNativeReviewed(noPublicationProof) === false);
const nativeWire = records.crNativeWireRecord({
  version_public_ref: 'OSI-WV-A1B2C3D4E5F60718',
  wire_report_public_ref: 'OSI-WR-A1B2C3D4E5F6',
  title: 'Published Wire finding', summary: 'Public-safe Wire summary.',
  evidence_count: 2, review_count: 2, challenge_count: 1,
  publication_channel: 'maintainer_bootstrap',
  publication_proof: { label: 'Memo-anchored on Solana', tx_sig: TX },
});
ok('published Wire record labels the bootstrap channel honestly',
  records.crStatus(nativeWire).txt === 'Maintainer bootstrap'
    && records.crStatus(nativeWire).detail.includes('maintainer bootstrap')
    && records.crHasMemo(nativeWire));
const supersededBootstrapWire = records.crNativeWireRecord({
  ...nativeWire,
  version_public_ref: 'OSI-WV-B1B2C3D4E5F60718',
  is_current_published: false,
});
ok('superseded Wire bootstrap record preserves both lifecycle labels',
  records.crStatus(supersededBootstrapWire).txt === 'Superseded bootstrap'
    && records.crStatus(supersededBootstrapWire).detail.includes('maintainer bootstrap'));
ok('published Wire record keeps public counts from the explicit DTO',
  records.crEvidenceCount(nativeWire) === 2
    && records.crAnalystReviews(nativeWire) === 2
    && nativeWire.native_challenge_count === 1);
const sealedWithPaymentOnly = records.crNativeCaseRecord({
  public_ref: 'OSI-C-SEALED0000002',
  title: 'Payment-only sealed Case',
  summary: 'Public-safe summary.',
  stage: 'sealed',
  reviews: [{ decision: 'approve' }],
  proof_log: [{
    event_type: 'REWARD_PAYMENT_CONFIRMED',
    label: 'SOL transfer verified on Solana',
    tx_sig: TX,
    payment_proof: {
      cluster: 'mainnet-beta', finality: 'finalized',
      payer_wallet: '1'.repeat(32),
      recipient_manifest: [{ wallet: '2'.repeat(32), amount_lamports: '1' }],
      total_lamports: '1',
    },
  }],
});
ok('unrelated verified payment cannot become a sealed-record proof',
  records.crStatus(sealedWithPaymentOnly).txt === 'Seal proof unavailable');
const nativeChallengeState = records.crNativeChallengeState([
  { id: 'native-a', native_challenge_count: 2 },
  { id: 'native-b', native_challenge_count: 0 },
]);
ok('native challenge state is counted independently of the legacy projection',
  nativeChallengeState.total === 2
    && nativeChallengeState.counts['native-a'] === 2
    && nativeChallengeState.challenged['native-a'] === 1);
records.crAddLegacyChallenges(nativeChallengeState, [{ item_id: 'legacy-a' }]);
ok('legacy challenge rows add to rather than replace native challenge state',
  nativeChallengeState.total === 3
    && nativeChallengeState.counts['native-a'] === 2
    && nativeChallengeState.counts['legacy-a'] === 1);
ok('Public Records reads the least-privilege native Case projection and keeps legacy rows labeled',
  recordsSource.includes("window.osiPublicApi('osi-v2-case-read',{op:'list_public_cases'})")
    && recordsSource.includes('window.osiV2ListPublicWireReports()')
    && recordsSource.includes("record_source:'native_public_dto'")
    && recordsSource.includes("record_source:'native_case_report_dto'")
    && recordsSource.includes("record_source:'native_wire_dto'")
    && recordsSource.includes("record_source:'legacy_public_projection'"));
ok('Public Records exposes loading, empty, filtered-empty and retryable error states',
  recordsSource.includes("host.setAttribute('aria-busy','true')")
    && recordsSource.includes('No published or sealed records yet.')
    && recordsSource.includes('No records match these filters.')
    && recordsSource.includes('onclick="renderCaseRecords()"')
    && recordsSource.includes("crT('Try again')"));
ok('Public Records discloses partial source failure instead of silently omitting published Reports',
  recordsSource.includes("sourceFailures?'partial':'loaded'")
    && recordsSource.includes("sourceState==='partial'")
    && recordsSource.includes('Published Reports may be incomplete until the Case registry recovers.')
    && recordsSource.includes("crT('Retry all sources')"));

const stats = { innerHTML: '' };
records.document.getElementById = (id) => id === 'cr-stats' ? stats : null;
records.__crSourceState = 'loaded';
records.__crList = [legacy, nativeReviewed, nativeSealed];
records.__crOpenChallengeCount = 0;
records.crRenderStats();
ok('Public Records stats name native review and Memo anchoring explicitly',
  stats.innerHTML.includes('Native reviewed') && stats.innerHTML.includes('Memo-anchored'));
ok('legacy row cannot inflate native reviewed or Memo counters',
  /<div class="fo-op-n sol">2<\/div><div class="fo-op-l">Native reviewed<\/div>/.test(stats.innerHTML)
    && /<div class="fo-op-n">1<\/div><div class="fo-op-l">Memo-anchored<\/div>/.test(stats.innerHTML));
ok('Proof Log copy distinguishes wallet, Memo, transfer, system, and legacy proof',
  index.includes('How proof labels work')
    && index.includes('It is not on-chain.')
    && index.includes('System or legacy'));
ok('Public Records explains standard seal quorum and separately labeled cold-start finalization',
  index.includes('The standard path requires analyst seal quorum and both maintainer gates. An eligible cold-start finalization is labeled separately.'));
ok('About describes both explicit quorum and clearly labeled cold-start review',
  index.includes('reviewed through explicit quorum or a clearly labeled cold-start process'));
ok('truthful cold-start copy remains localized in Turkish',
  i18nSource.includes('Uygun bir soğuk başlangıç sonuçlandırması ayrıca etiketlenir.')
    && i18nSource.includes('açıkça etiketlenmiş bir soğuk başlangıç süreciyle incelenir.'));
ok('Public Records copy includes open public Cases without calling them sealed outcomes',
  index.includes('Public Cases and governed findings')
    && index.includes('Public Cases, exact current published Case Report versions, and published Wire findings with their lifecycle and proof status.')
    && !index.includes('<span>Reviewed and sealed outcomes</span>'));

console.log((fail ? 'FAILED: ' + fail : 'OK') +
  ' (' + pass + ' assertions passed, ' + fail + ' failed)');
process.exit(fail ? 1 : 0);
