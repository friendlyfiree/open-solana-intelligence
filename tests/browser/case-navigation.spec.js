// Public Case navigation, canonical routing and wallet-friction contracts.
//
// These specs drive the real navigation handlers in index.html against
// production-shaped Edge Function responses. Nothing is injected into the DOM:
// every assertion is about markup the application itself rendered after a real
// click, key press or hash change.
//
// The Case and Report references mirror the live production record so the
// nullable public summary, the maintainer bootstrap channel and the Memo proof
// are exercised exactly as an anonymous visitor sees them.
const { test, expect } = require('@playwright/test');

const CASE_REF = 'OSI-00CB089E5105';
const SECOND_CASE_REF = 'OSI-BFD6490F5270';
const REPORT_REF = 'OSI-RPT-F7D8C6A745D9';
const VERSION_REF = 'OSI-RV-7998E263D19C4218';
const UNPUBLISHED_REPORT_REF = 'OSI-RPT-000000000001';
const UNPUBLISHED_VERSION_REF = 'OSI-RV-00000000000000001';
const PUBLISH_TX = 'DR4znTjFxyRZVJGCXgMbyPADWp8U3oSQSHCTiKxWHSaTj58c92TACh7gBcpuVpqruCYrSk8An86SFixPe5YpyAV';
const OPEN_TX = 'YFbEg7G5tC5DjPTqKkGeEjeBb2QpqNysjexUuKVUz9KSwxp6iALjaS6b4SnHRZjMSNR874Z5eGSpCRTkJVdRS2H';
const OWNER = '7wT9ZrM3B41GfZ9sA33fPTnRM23fZ9wP5VeFJvvzG5Ai';
const ANALYST = '2awpjumkqhWywwbmDBixjo7cAnqD5fGfNGNv6MMTc4M7';
const MAINTAINER = '42VqbY8JghJuf4TcyzaQ9nzQ446W9L3zYTUL3no6XU4y';
// A sentinel that only ever exists inside a restricted Report body. If it
// reaches the browser through any surface the privacy contract has failed.
const PRIVATE_SENTINEL = 'RESTRICTED_REPORT_BODY_SENTINEL';

const publicCase = {
  public_ref: CASE_REF,
  title: 'Forward Industries',
  summary: 'A public-safe intake summary for the reviewed public investigation.',
  category: 'other',
  stage: 'open_public',
  visibility: 'public',
  risk_tier: 'standard',
  created_at: '2026-07-29T13:04:16+00:00',
  sealed_at: null,
  evidence: [],
  reviews: [
    {
      reviewer_wallet: ANALYST, decision: 'approve_open', reviewer_role: 'analyst', weight: 0.5,
      is_active: true, created_at: '2026-07-29T13:07:51.598502+00:00',
      proof_label: 'Wallet-signed and server-verified',
      sas_authority: { enforced: true, counted: true, state: 'verified' },
    },
  ],
  reports: [{
    public_ref: REPORT_REF,
    status: 'active',
    current_version: {
      version_ref: VERSION_REF, version_no: 1, lifecycle_state: 'published',
      published_at: '2026-08-01T09:02:46+00:00',
    },
    content_public_safe: null,
    published: true,
  }],
  governance: { resolution: null, challenges: [], process_notice: 'Primary Report selection and process sealing record reviewed, challengeable outcomes.' },
  money: { reward: null, support_options: [], confirmed_support: [], notice: 'Rewards and support are voluntary direct wallet-to-wallet SOL transfers.' },
  proof_log: [
    {
      label: 'Memo-anchored on Solana', event_type: 'CASE_OPENED', public_ref: CASE_REF,
      actor_wallet: MAINTAINER, actor_role: 'maintainer', decision: 'open', weight: null,
      occurred_at: '2026-07-29T13:11:47+00:00', decision_channel: 'standard', decision_channel_label: null,
      tx_sig: OPEN_TX, solscan_url: `https://solscan.io/tx/${OPEN_TX}`,
    },
    {
      label: 'Memo-anchored on Solana', event_type: 'REPORT_PUBLISHED', public_ref: VERSION_REF,
      actor_wallet: MAINTAINER, actor_role: 'maintainer', decision: 'publish', weight: null,
      occurred_at: '2026-08-01T09:02:46+00:00', decision_channel: 'maintainer_bootstrap',
      decision_channel_label: 'Maintainer bootstrap (cold-start) decision. Not an independent analyst quorum outcome.',
      tx_sig: PUBLISH_TX, solscan_url: `https://solscan.io/tx/${PUBLISH_TX}`,
    },
  ],
};

const secondCase = {
  ...publicCase,
  public_ref: SECOND_CASE_REF,
  title: 'Forward Industries treasury follow-up',
  summary: 'A second reviewed public Case with no published Report yet.',
  reports: [],
  proof_log: [],
};

// Production has two open public Cases titled "Forward Industries". This
// variant keeps the second Case's own ref and date but gives it that same
// title, spaced and cased differently, as the registry may hold it.
const sameTitleSecondCase = {
  ...secondCase,
  title: '  forward   INDUSTRIES ',
  created_at: '2026-07-26T08:00:00+00:00',
};
const hostileTwin = {
  ...secondCase,
  public_ref: 'OSI-0000000000AA',
  created_at: '2026-07-20T08:00:00+00:00',
};

const publishedReport = {
  report_public_ref: REPORT_REF,
  version_public_ref: VERSION_REF,
  version_no: 1,
  state: 'published',
  // Production truth: this exact published version has no public-safe summary.
  content_public_safe: null,
  evidence: [],
  quorum: { risk_tier: 'standard', approve_count: 0, approve_weight: 0, required_count: 2, required_weight: 2, approve_ready: false },
  review_timeline: [],
  publication_proof: {
    event_type: 'REPORT_PUBLISHED', actor_wallet: MAINTAINER, actor_role: 'maintainer',
    proof_type: 'solana_memo', server_verified: true, tx_sig: PUBLISH_TX,
    occurred_at: '2026-08-01T09:02:46+00:00', decision_channel: 'maintainer_bootstrap',
    decision_channel_label: 'Maintainer bootstrap (cold-start) decision. Not an independent analyst quorum outcome.',
  },
  published_at: '2026-08-01T09:02:46+00:00',
  process_notice: 'Publication records a reviewed OSI process outcome. It is not proof of truth, guilt, legal certainty, recovery, custody, or guaranteed payment.',
};

// Hostile server text for the drawer's rendering paths. Every field a drawer
// tab prints, as text or inside an attribute, carries markup or a script URL.
// The record is reachable only by its reference, never listed.
const HOSTILE_REF = 'OSI-BADBADBAD001';
const HOSTILE_VERSION_REF = 'OSI-RV-BADBADBADBAD0001';
const XSS = '<img src=x onerror="window.__osiXss=1">';
const XSS_ATTR = '"><svg onload="window.__osiXss=2"></svg>';
const XSS_URL = 'javascript:window.__osiXss=3';
const hostileProof = {
  label: XSS, event_type: XSS_ATTR, public_ref: XSS, actor_wallet: XSS_ATTR, actor_role: XSS,
  decision: XSS, weight: null, occurred_at: XSS, decision_channel: 'maintainer_bootstrap',
  decision_channel_label: XSS, tx_sig: XSS_ATTR, solscan_url: XSS_URL, memo: XSS,
};
const hostileCase = {
  ...publicCase,
  public_ref: HOSTILE_REF,
  title: XSS,
  summary: XSS_ATTR,
  category: XSS,
  stage: 'sealed',
  sealed_at: XSS,
  reports: [],
  evidence: [],
  evidence_sections: {
    wallets: [{ kind: 'wallet', ref: XSS_ATTR, network: XSS, sha256: XSS, link_url: XSS_URL }],
    transactions: [], links: [{ kind: 'url', ref: XSS, link_url: XSS_URL }], other: [], networks: [XSS],
  },
  reviews: [{
    reviewer_wallet: XSS_ATTR, decision: XSS, reviewer_role: XSS, weight: XSS, is_active: true,
    created_at: '2026-07-29T13:07:51+00:00', proof_label: XSS, reason_code: XSS_ATTR,
    sas_authority: { enforced: true, counted: false, state: XSS },
  }],
  governance: {
    resolution: {
      public_ref: XSS, state: 'sealed', decision_channel: 'maintainer_bootstrap', decision_channel_label: XSS,
      winning_report_version_ref: XSS_ATTR, challenge_window_opens_at: XSS, challenge_window_closes_at: XSS, sealed_at: XSS,
      selection_quorum: { leader_count: 0, leader_weight: 0, required_count: 2, required_weight: 2.5 },
      final_proof: hostileProof, seal_proof: { ...hostileProof, solscan_url: `https://solscan.io/tx/${OPEN_TX}` },
      reviews: [{ phase: 'selection', reviewer_wallet: XSS_ATTR, reviewer_role: XSS, decision: XSS, weight: 1,
        target_version_ref: XSS_ATTR, created_at: XSS, public_rationale: XSS, proof_label: XSS,
        sas_authority: { enforced: true, counted: true, state: 'verified' } }],
    },
    challenges: [{ public_ref: XSS_ATTR, state: XSS, blocking: false, public_safe_summary: XSS,
      admissibility_deadline_at: XSS, review_deadline_at: XSS, reviews: [], outcome_quorum: {}, challenger_wallet: XSS }],
  },
  money: {
    reward: { state: 'pledged', status: XSS, amount_lamports: '1000', confirmed_lamports: '0', outstanding_lamports: '1000',
      winning_report_author_wallet: XSS_ATTR, winning_report_version_ref: XSS_ATTR,
      payments: [{ amount_lamports: '5', state: XSS, confirmed_at: XSS, solscan_url: XSS_URL }] },
    support_options: [{ target_type: XSS_ATTR, target_ref: XSS_ATTR, wallet: XSS_ATTR, label: XSS }],
    confirmed_support: [{ support_type: 'report_author', amount_lamports: '5', state: 'confirmed', confirmed_at: XSS, solscan_url: XSS_URL }],
  },
  proof_log: [
    hostileProof,
    { ...hostileProof, actor_wallet: '', decision: null, label: 'SOL transfer verified on Solana',
      payment_proof: { payer_wallet: XSS_ATTR, total_lamports: XSS, target_public_ref: XSS, finality: XSS, slot: XSS,
        block_time: XSS, memo_verified: true, transfers_verified: true,
        recipient_manifest: [{ wallet: XSS_ATTR, amount_lamports: XSS, recipient_type: XSS }] } },
  ],
};
const hostileReport = {
  report_public_ref: XSS_ATTR, version_public_ref: HOSTILE_VERSION_REF, version_no: XSS, state: 'published',
  content_public_safe: XSS, public_body: XSS_ATTR,
  evidence: [{ kind: 'url', ref: XSS, ordinal: XSS, link_url: XSS_URL }],
  quorum: { approve_count: XSS, approve_weight: 0, required_count: XSS, required_weight: 2 },
  review_timeline: [{ reviewer_wallet: XSS_ATTR, reviewer_handle: XSS, reviewer_display_name: XSS, decision: XSS, weight: 1,
    tier_snapshot: XSS, public_rationale: XSS, actor_role: XSS, proof_type: XSS, created_at: XSS, is_active: true,
    sas_authority: { enforced: true, counted: false, state: XSS } }],
  publication_proof: { event_type: XSS_ATTR, actor_wallet: XSS_ATTR, actor_role: XSS, proof_type: XSS, server_verified: true,
    tx_sig: XSS_ATTR, occurred_at: XSS, decision_channel: 'maintainer_bootstrap', decision_channel_label: XSS },
  published_at: XSS, process_notice: XSS,
};

// Install a fixture backend. `options.wallet` decides whether a Phantom-like
// provider exists at all, which is what the no-wallet contracts depend on.
async function installFixture(page, options = {}) {
  const publicCaseDelayMs = Number(options.publicCaseDelayMs || 0);
  page.__walletCalls = [];
  page.__toasts = [];

  await page.addInitScript(({ wallet }) => {
    window.__osiWalletCalls = [];
    const record = (name) => { window.__osiWalletCalls.push(name); };
    if (wallet === 'none') {
      // No extension at all. Reading window.solana must stay harmless.
      Object.defineProperty(window, 'solana', {
        configurable: true,
        get() { record('read:window.solana'); return undefined; },
      });
      Object.defineProperty(window, 'phantom', {
        configurable: true,
        get() { record('read:window.phantom'); return undefined; },
      });
    } else {
      const publicKey = { toString: () => '11111111111111111111111111111111' };
      const provider = {
        isPhantom: true, isConnected: false, publicKey: null,
        connect: async (connectOptions) => {
          record(connectOptions && connectOptions.onlyIfTrusted ? 'connect:trusted' : 'connect:explicit');
          if (connectOptions && connectOptions.onlyIfTrusted) throw new Error('not trusted');
          provider.isConnected = true;
          provider.publicKey = publicKey;
          return { publicKey };
        },
        disconnect: async () => { provider.isConnected = false; provider.publicKey = null; },
        signMessage: async () => { record('signMessage'); return { signature: new Uint8Array(64).fill(3) }; },
        signAndSendTransaction: async () => { record('sendTransaction'); return { signature: '2'.repeat(88) }; },
        on: () => {}, off: () => {},
      };
      if (wallet === 'phantom-with-rival') {
        // A second Solana extension won the shared window.solana alias, which
        // is what a visitor with two wallets installed actually has.
        window.phantom = { solana: provider };
        window.solana = {
          isPhantom: false, isConnected: false, publicKey: null,
          connect: async () => { record('rival:connect'); throw new Error('rival wallet refused'); },
          signMessage: async () => { record('rival:signMessage'); throw new Error('rival wallet refused'); },
          on: () => {}, off: () => {},
        };
      } else if (wallet === 'phantom-late') {
        // The extension finishes injecting after the page has started running.
        setTimeout(() => { window.phantom = { solana: provider }; window.solana = provider; }, 700);
      } else {
        window.solana = provider;
        window.phantom = { solana: provider };
      }
    }
    window.open = function () { record('window.open'); return null; };
  }, { wallet: options.wallet || 'none' });

  await page.route(/https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\/.*/, (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: '',
  }));
  await page.route('https://api.coingecko.com/**', (route) => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ solana: { usd: 0, usd_24h_change: 0 }, bitcoin: { usd: 0, usd_24h_change: 0 }, ethereum: { usd: 0, usd_24h_change: 0 } }),
  }));
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));

  await page.route('**/functions/v1/**', async (route) => {
    const request = route.request();
    const endpoint = new URL(request.url()).pathname.split('/').pop();
    let body = {};
    try { body = JSON.parse(request.postData() || '{}'); } catch (_) { body = {}; }
    let status = 200;
    let payload = { ok: true };

    if (endpoint === 'osi-v2-case-read') {
      const listed = options.sameTitle
        ? [publicCase, sameTitleSecondCase]
        : options.hostileTwin ? [hostileCase, { ...hostileTwin, title: hostileCase.title }] : [publicCase, secondCase];
      if (body.op === 'list_public_cases') payload = { ok: true, cases: listed };
      else if (body.op === 'get_public_case') {
        if (publicCaseDelayMs) await new Promise((resolve) => setTimeout(resolve, publicCaseDelayMs));
        const match = listed.concat([hostileCase]).find((item) => item.public_ref === body.public_ref);
        if (match) payload = { ok: true, case: match };
        else { status = 404; payload = { ok: false, error: 'not_found_or_private' }; }
      } else { status = 401; payload = { ok: false, error: 'wallet_not_connected' }; }
    } else if (endpoint === 'osi-v2-report-read') {
      if (body.op === 'list_public_reports') {
        // The public projection returns published versions only and never
        // carries a restricted body field.
        payload = body.case_ref === CASE_REF
          ? { ok: true, case_public_ref: CASE_REF, reports: [publishedReport] }
          : body.case_ref === HOSTILE_REF
            ? { ok: true, case_public_ref: HOSTILE_REF, reports: [hostileReport] }
            : { ok: true, case_public_ref: body.case_ref, reports: [] };
      } else { status = 401; payload = { ok: false, error: 'wallet_not_connected' }; }
    } else if (endpoint === 'osi-v2-report-write' && body.op === 'capabilities') {
      payload = { ok: true, report_writes_enabled: false, case_eligible: false, prerequisite: 'Connect a wallet to submit a Report.' };
    } else if (endpoint === 'osi-v2-analyst' && body.op === 'list_public_profiles') {
      payload = { ok: true, analysts: [] };
    } else if (endpoint === 'osi-v2-wire') {
      payload = { ok: true, reports: [], wire_reports: [], stats: {} };
    } else if (endpoint === 'osi-v2-proof') {
      payload = { ok: true, events: [] };
    } else {
      payload = { ok: true };
    }

    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  });
}

async function boot(page, options = {}) {
  page.__runtimeErrors = [];
  page.on('pageerror', (error) => page.__runtimeErrors.push(`page: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 500) page.__runtimeErrors.push(`http ${response.status()} ${response.url()}`);
  });
  await installFixture(page, options);
  await page.goto(options.path || '/');
  await page.waitForFunction(() => typeof window.osiNavigate === 'function' && typeof window.osiV2OpenCase === 'function');
  await page.evaluate(() => {
    window.__osiToasts = [];
    const original = window.showToast;
    window.showToast = function (message) {
      window.__osiToasts.push(String(message));
      if (typeof original === 'function') return original.apply(this, arguments);
      return undefined;
    };
  });
}

const walletCalls = (page) => page.evaluate(() => window.__osiWalletCalls.slice());
const toasts = (page) => page.evaluate(() => (window.__osiToasts || []).slice());

// Only property reads are tolerated on a public path. A connect, signMessage,
// sendTransaction or phantom.app popup is a contract failure.
function expectNoWalletApproval(calls) {
  expect(calls.filter((call) => !call.startsWith('read:'))).toEqual([]);
}

async function expectPublishedReportVisible(page) {
  const reportsTab = page.locator('#osi-case-tabs button[data-tab="reports"]');
  await expect(reportsTab).toHaveText('Published Reports');
  await reportsTab.click();
  const card = page.locator(`#osi-case-content [data-report-public-ref="${REPORT_REF}"]`);
  await expect(card).toBeVisible();
  await expect(card).toContainText(REPORT_REF);
  await expect(card).toContainText(VERSION_REF);
  await expect(card).toContainText('Published');
  await expect(card).toContainText('No public-safe summary was provided.');
  await expect(card).toContainText('Not an independent analyst quorum outcome.');
  await expect(card.locator(`a[href="https://solscan.io/tx/${PUBLISH_TX}"]`)).toHaveCount(1);
  await expect(page.locator('#osi-case-content')).toContainText('This parent Case stays open.');
}

test.describe('public Case navigation', () => {
  test('home Open Case reveals the canonical Case detail immediately and shows the published Report', async ({ page }) => {
    // A deliberately slow public read: the drawer must still appear at once.
    await boot(page, { publicCaseDelayMs: 3000 });
    await expect(page.locator('#osi-home-live-state')).toContainText('Forward Industries');

    const open = page.locator('#osi-home-live-state button', { hasText: 'Open Case' });
    await expect(open).toHaveAttribute('aria-label', new RegExp(CASE_REF));
    const started = Date.now();
    await open.click();
    await expect(page.locator('#osi-case-drawer')).toBeVisible({ timeout: 1200 });
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    expect(Date.now() - started).toBeLessThan(1500);

    await expect(page).toHaveURL(new RegExp(`#case/${CASE_REF}$`));
    await expect(page.locator('#osi-case-title')).toHaveText('Forward Industries');
    await expectPublishedReportVisible(page);
    expectNoWalletApproval(await walletCalls(page));
    expect(await toasts(page)).toEqual([]);
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('Field Office Case row opens the same canonical Case detail', async ({ page }) => {
    await boot(page, { publicCaseDelayMs: 3000 });
    await page.evaluate(() => window.osiNavigate('field'));
    const row = page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`);
    await expect(row).toBeVisible();

    // Regression guard for the no-op row: with a 3s public read in flight the
    // drawer still has to appear at once, from the already-loaded list row.
    const started = Date.now();
    await row.click();
    await expect(page.locator('#osi-case-drawer')).toBeVisible({ timeout: 1200 });
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    await expect(row).toHaveAttribute('aria-label', new RegExp(`Open Case detail: ${CASE_REF}`));
    await expect(page).toHaveURL(new RegExp(`#case/${CASE_REF}$`));
    await expectPublishedReportVisible(page);
    expectNoWalletApproval(await walletCalls(page));
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('a direct Case URL survives load, reload and browser history', async ({ page }) => {
    await boot(page, { path: `/#case/${CASE_REF}` });
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    await expectPublishedReportVisible(page);

    await page.reload();
    await page.waitForFunction(() => typeof window.osiV2OpenCase === 'function');
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);

    // Close returns to the Field Office route; Back reopens the same Case.
    await page.locator('#osi-case-drawer .osi-case-close').click();
    await expect(page.locator('#osi-case-drawer')).toBeHidden();
    await expect(page).toHaveURL(/#field-office$/);

    await page.goBack();
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);

    await page.goForward();
    await expect(page.locator('#osi-case-drawer')).toBeHidden();
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('the whole public path works with no wallet extension present', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    expect(await page.evaluate(() => window.solana)).toBeUndefined();

    await page.evaluate(() => window.osiNavigate('field'));
    await page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`).click();
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await expectPublishedReportVisible(page);

    // The proof detail opens without any wallet involvement.
    const toggle = page.locator(`[data-report-detail-toggle="${VERSION_REF}"]`);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const detail = page.locator(`#osi-report-detail-${VERSION_REF}`);
    await expect(detail).toBeVisible();
    await expect(detail).toContainText('Memo-anchored on Solana');
    await expect(detail).toContainText('maintainer_bootstrap');
    await expect(detail).toContainText(PUBLISH_TX);

    expectNoWalletApproval(await walletCalls(page));
    expect(await toasts(page)).toEqual([]);
    const body = await page.evaluate(() => document.body.innerText);
    expect(body).not.toContain('Phantom not found');
    expect(page.__runtimeErrors).toEqual([]);
  });
});

test.describe('private workspace friction', () => {
  test('My Reports navigation shows an inline lock and never opens the wallet by itself', async ({ page }) => {
    await boot(page, { wallet: 'phantom' });
    await page.evaluate(() => window.osiNavigate('field'));

    const railReports = page.locator('.fo-rail button', { hasText: 'My Reports' });
    await expect(railReports).toHaveCount(1);
    await railReports.click();

    const lock = page.locator('[data-workspace-lock="report:mine"]');
    await expect(lock).toBeVisible();
    await expect(lock).toContainText('My Reports is a private workspace');
    await expect(page.locator('#fo-title')).toHaveText('My Reports');
    const unlock = lock.locator('[data-workspace-unlock]');
    await expect(unlock).toContainText('Connect wallet');
    await expect(lock).toContainText('No Solana transaction');

    // Navigation alone must not have touched the wallet.
    expectNoWalletApproval((await walletCalls(page)).filter((call) => call !== 'connect:trusted'));
    expect(await toasts(page)).toEqual([]);

    // Only the explicit CTA is allowed to start a wallet connection.
    await unlock.click();
    await expect
      .poll(async () => (await walletCalls(page)).includes('connect:explicit'))
      .toBe(true);
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('My Cases and the review queue use the same explicit unlock', async ({ page }) => {
    await boot(page, { wallet: 'phantom' });
    await page.evaluate(() => window.osiV2OpenMyCases());
    await expect(page.locator('[data-workspace-lock="mine"]')).toBeVisible();
    await expect(page.locator('#fo-title')).toHaveText('My Cases');

    await page.evaluate(() => window.osiV2OpenReviewQueue());
    await expect(page.locator('[data-workspace-lock="review"]')).toBeVisible();
    await expect(page.locator('#fo-title')).toHaveText('My Reviews');

    expectNoWalletApproval((await walletCalls(page)).filter((call) => call !== 'connect:trusted'));
    expect(page.__runtimeErrors).toEqual([]);
  });
});

test.describe('public projection privacy', () => {
  test('no restricted Report body reaches the network, the DOM or client state', async ({ page }) => {
    const responses = [];
    page.on('response', async (response) => {
      if (!response.url().includes('/functions/v1/')) return;
      try { responses.push(await response.text()); } catch (_) { /* ignore */ }
    });
    await boot(page, { wallet: 'none' });
    await page.evaluate(() => window.osiNavigate('field'));
    await page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`).click();
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await page.locator('#osi-case-tabs button[data-tab="reports"]').click();
    await expect(page.locator(`[data-report-public-ref="${REPORT_REF}"]`)).toBeVisible();
    await page.locator(`[data-report-detail-toggle="${VERSION_REF}"]`).click();

    for (const text of responses) {
      expect(text).not.toContain('body_private');
      expect(text).not.toContain(PRIVATE_SENTINEL);
    }
    const serialized = await page.evaluate(() => document.documentElement.outerHTML);
    expect(serialized).not.toContain('body_private');
    expect(serialized).not.toContain(PRIVATE_SENTINEL);
    expect(serialized).not.toContain(UNPUBLISHED_REPORT_REF);
    expect(serialized).not.toContain(UNPUBLISHED_VERSION_REF);
    expect(await page.evaluate(() => JSON.stringify(window.__osiV2ReadProof || null))).not.toContain(PRIVATE_SENTINEL);
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('a Case with no published Report shows an honest empty state, not a leak', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    await page.evaluate(() => window.osiNavigate('field'));
    await page.locator(`#field-cases [data-case-ref="${SECOND_CASE_REF}"]`).click();
    await expect(page.locator('#osi-case-ref')).toHaveText(SECOND_CASE_REF);
    await page.locator('#osi-case-tabs button[data-tab="reports"]').click();
    await expect(page.locator('#osi-case-content')).toContainText('No published Reports');
    await expect(page.locator('#osi-case-content')).not.toContainText(REPORT_REF);
    expect(page.__runtimeErrors).toEqual([]);
  });
});

test.describe('hostile server text', () => {
  test('every drawer tab renders hostile server text as text and never as markup or a script link', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    await page.evaluate((ref) => window.osiV2OpenCase(ref), HOSTILE_REF);
    await expect(page.locator('#osi-case-ref')).toHaveText(HOSTILE_REF);
    // The title is user content and arrives as literal characters.
    await expect(page.locator('#osi-case-title')).toHaveText(XSS);
    const tabs = await page.locator('#osi-case-tabs [data-tab]').evaluateAll((nodes) => nodes.map((node) => node.dataset.tab));
    expect(tabs).toEqual(expect.arrayContaining(['overview', 'reviews', 'evidence', 'reports', 'resolution', 'challenges', 'reward', 'proof']));
    for (const tab of tabs) {
      await page.locator(`#osi-case-tabs [data-tab="${tab}"]`).click();
      if (tab === 'reports') {
        await expect(page.locator(`[data-report-version-public-ref="${HOSTILE_VERSION_REF}"]`)).toBeVisible();
        await page.locator(`[data-report-detail-toggle="${HOSTILE_VERSION_REF}"]`).click();
      }
      const audit = await page.evaluate(() => {
        const root = document.getElementById('osi-case-drawer');
        return {
          handlers: root.querySelectorAll('[onerror],[onload]').length,
          images: root.querySelectorAll('img[src="x"]').length,
          scriptLinks: Array.from(root.querySelectorAll('a[href]')).filter((node) => !/^https:\/\//.test(node.getAttribute('href'))).map((node) => node.getAttribute('href')),
          fired: window.__osiXss || null,
        };
      });
      expect(audit, tab).toEqual({ handlers: 0, images: 0, scriptLinks: [], fired: null });
    }
    // The resolution still names the maintainer bootstrap channel and keeps
    // the one validated Solscan link while dropping the script URL.
    await page.locator('#osi-case-tabs [data-tab="resolution"]').click();
    await expect(page.locator('#osi-case-content [data-decision-channel="maintainer_bootstrap"]').first()).toBeVisible();
    await expect(page.locator(`#osi-case-content a[href="https://solscan.io/tx/${OPEN_TX}"]`)).toHaveCount(1);
    await page.locator('#osi-case-tabs [data-tab="proof"]').click();
    await expect(page.locator('#osi-case-content')).toContainText(XSS);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__osiXss || null)).toBeNull();
    expect(page.__runtimeErrors).toEqual([]);
  });
});

test.describe('accessibility and mobile', () => {
  test('a Case row opens with Enter and with Space and keeps a visible focus ring', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    await page.evaluate(() => window.osiNavigate('field'));
    const row = page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`);
    await row.focus();
    expect(await page.evaluate(() => document.activeElement.getAttribute('data-case-ref'))).toBe(CASE_REF);
    expect(await page.evaluate(() => {
      const node = document.activeElement;
      const styles = getComputedStyle(node);
      return styles.borderTopColor !== '' || styles.outlineStyle !== 'none';
    })).toBe(true);

    await page.keyboard.press('Enter');
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('#osi-case-drawer')).toBeHidden();

    await row.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('the mobile Case journey keeps 44px targets and no horizontal overflow', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, { wallet: 'none' });
    await page.evaluate(() => window.osiNavigate('field'));
    const row = page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`);
    expect((await row.boundingBox()).height).toBeGreaterThanOrEqual(44);
    await row.click();
    await expect(page.locator('#osi-case-drawer')).toBeVisible();

    const reportsTab = page.locator('#osi-case-tabs button[data-tab="reports"]');
    expect((await reportsTab.boundingBox()).height).toBeGreaterThanOrEqual(40);
    await reportsTab.click();
    const toggle = page.locator(`[data-report-detail-toggle="${VERSION_REF}"]`);
    await expect(toggle).toBeVisible();
    expect((await toggle.boundingBox()).height).toBeGreaterThanOrEqual(44);

    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
    expect(page.__runtimeErrors).toEqual([]);
  });
});

test.describe('wallet detection', () => {
  test('a second installed Solana wallet never blocks the Phantom connection', async ({ page }) => {
    await boot(page, { wallet: 'phantom-with-rival' });

    await page.locator('#walletBtn').click();
    await expect(page.locator('#wbText')).toHaveText('1111…1111');
    await expect(page.locator('#walletBtn')).toHaveClass(/connected/);

    const calls = await walletCalls(page);
    expect(calls).toContain('connect:explicit');
    // The rival provider is never opened and the install page is never pushed
    // at a visitor who already has Phantom.
    expect(calls.filter((call) => call.startsWith('rival:'))).toEqual([]);
    expect(calls).not.toContain('window.open');
    expect(await toasts(page)).not.toContain('Phantom not found. Install it from phantom.app, then refresh and connect.');
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('an extension that injects late still restores the trusted session', async ({ page }) => {
    await boot(page, { wallet: 'phantom-late' });

    // The silent trusted check must reach the provider that arrived after load.
    await expect.poll(async () => (await walletCalls(page)).includes('connect:trusted'), { timeout: 5000 }).toBe(true);
    expect(await walletCalls(page)).not.toContain('connect:explicit');

    await page.locator('#walletBtn').click();
    await expect(page.locator('#wbText')).toHaveText('1111…1111');
    expect(await walletCalls(page)).not.toContain('window.open');
    expect(page.__runtimeErrors).toEqual([]);
  });
});

test.describe('degraded public reads', () => {
  test('a failing Case read keeps the drawer open with a retry instead of a silent no-op', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    // Force the canonical detail read to fail for a Case that is not cached.
    await page.route('**/functions/v1/osi-v2-case-read', async (route) => {
      let body = {};
      try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) { body = {}; }
      if (body.op === 'get_public_case') {
        await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ ok: false, error: 'read_failed' }) });
        return;
      }
      await route.fallback();
    });
    await page.evaluate(() => { window.location.hash = '#case/OSI-000000000000'; });
    await expect(page.locator('#osi-case-drawer')).toBeVisible();
    await expect(page.locator('#osi-case-content')).toContainText('Case detail unavailable');
    await expect(page.locator('#osi-case-content [data-case-retry]')).toBeVisible();
    expectNoWalletApproval(await walletCalls(page));
  });
});

// HA-25: a counted review's label sits beside the reviewer's tier, so it says
// what was confirmed on chain, review authority, and never "verified", which
// is also an analyst tier.
test.describe('tier and SAS review authority wording', () => {
  test('a counted review reads as confirmed SAS review authority, not as verified', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    await page.evaluate((ref) => window.osiV2OpenCase(ref), CASE_REF);
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    await page.locator('#osi-case-tabs [data-tab="reviews"]').click();
    const counted = page.locator('#osi-case-content [data-sas-authority="counted"]').first();
    await expect(counted).toHaveText('Counted: SAS review authority confirmed');
    await expect(page.locator('#osi-case-content')).not.toContainText('Authority verified on Solana');
    await expect(page.locator('#osi-case-content')).not.toContainText(/SAS verified/i);
    expectNoWalletApproval(await walletCalls(page));
    expect(page.__runtimeErrors).toEqual([]);
  });
});

// Two public Cases can share a title. The registry has no merge transition and
// a public record is never rewritten, so both stay; a neutral note tells them
// apart and the intake suggests checking the existing Case first.
test.describe('same-title public Cases', () => {
  test('rows and the drawer name the other Case without calling it a duplicate', async ({ page }) => {
    await boot(page, { wallet: 'none', sameTitle: true });
    await page.evaluate(() => window.osiNavigate('field'));
    const first = page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`);
    const second = page.locator(`#field-cases [data-case-ref="${SECOND_CASE_REF}"]`);
    await expect(first.locator('.osi-same-title')).toHaveText(`Same title as ${SECOND_CASE_REF}, opened Jul 26, 2026`);
    await expect(second.locator('.osi-same-title')).toHaveText(`Same title as ${CASE_REF}, opened Jul 29, 2026`);
    await expect(first).toHaveAttribute('aria-label', new RegExp(`Same title as ${SECOND_CASE_REF}`));
    expect(await page.locator('#field-cases').innerText()).not.toMatch(/duplicate/i);

    await first.click();
    const note = page.locator('#osi-case-same-title');
    await expect(note).toBeVisible();
    await expect(note).toContainText('Another public Case has the same title. It opened Jul 26, 2026.');
    await note.getByRole('button', { name: `Open ${SECOND_CASE_REF}` }).click();
    await expect(page.locator('#osi-case-ref')).toHaveText(SECOND_CASE_REF);
    await expect(note).toBeVisible();
    await expect(note.getByRole('button', { name: `Open ${CASE_REF}` })).toBeVisible();
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('Cases with different titles carry no note', async ({ page }) => {
    await boot(page, { wallet: 'none' });
    await page.evaluate(() => window.osiNavigate('field'));
    await expect(page.locator(`#field-cases [data-case-ref="${SECOND_CASE_REF}"]`)).toBeVisible();
    await expect(page.locator('#field-cases .osi-same-title')).toHaveCount(0);
    await page.locator(`#field-cases [data-case-ref="${CASE_REF}"]`).click();
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    await expect(page.locator('#osi-case-same-title')).toBeHidden();
  });

  test('a hostile shared title stays text in the row and the drawer note', async ({ page }) => {
    await boot(page, { wallet: 'none', hostileTwin: true });
    await page.evaluate(() => window.osiNavigate('field'));
    const row = page.locator('#field-cases [data-case-ref="OSI-0000000000AA"]');
    await expect(row.locator('.osi-same-title')).toContainText(`Same title as ${HOSTILE_REF}`);
    await row.click();
    await expect(page.locator('#osi-case-same-title')).toBeVisible();
    expect(await page.evaluate(() => window.__osiXss === undefined && !document.querySelector('#field-cases img, #osi-case-drawer img[src="x"]'))).toBe(true);
    expect(page.__runtimeErrors).toEqual([]);
  });

  test('the Case intake hints at an existing public Case with the same title and never blocks', async ({ page }) => {
    await boot(page, { wallet: 'none', sameTitle: true });
    await page.evaluate(() => window.osiNavigate('field'));
    await page.evaluate(() => { const m = document.getElementById('fo-modal'); m.classList.add('open'); });
    const title = page.locator('#v2-case-title');
    await title.fill('Forward industries');
    const hint = page.locator('#v2-case-title-match');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText(`A public Case with this title already exists: ${CASE_REF}.`);
    await expect(title).toHaveAttribute('aria-describedby', 'v2-case-title-match');
    await title.fill('Forward Industries treasury wallets');
    await expect(hint).toBeHidden();
    await title.fill('FORWARD   industries');
    await expect(hint).toBeVisible();
    await hint.getByRole('button', { name: `Open ${CASE_REF}` }).click();
    await expect(page.locator('#osi-case-ref')).toHaveText(CASE_REF);
    // The typed draft is still in the form after looking at the other Case.
    await expect(title).toHaveValue('FORWARD   industries');
    expect(page.__runtimeErrors).toEqual([]);
  });
});
