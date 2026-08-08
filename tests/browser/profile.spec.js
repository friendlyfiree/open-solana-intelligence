const { test, expect } = require('@playwright/test');

const WALLET = '11111111111111111111111111111111';
const PROFILE_REF = 'OSI-PRF-A1B2C3D4E5F60708';
const publicProfile = {
  public_ref: PROFILE_REF,
  wallet: WALLET,
  handle: 'chainreader',
  display_name: 'Chain Reader',
  bio: 'Public evidence contributor.',
  avatar_url: null,
  updated_at: '2026-08-08T12:00:00Z',
};

async function installFixture(page, options = {}) {
  const requests = [];
  await page.route(/https:\/\/(?:bundle\.run|unpkg\.com|cdn\.jsdelivr\.net)\/.*/, (route) => route.fulfill({
    status: 200, contentType: 'application/javascript', body: '',
  }));
  await page.route('https://api.coingecko.com/**', (route) => route.fulfill({
    status: 200, contentType: 'application/json', body: JSON.stringify({ solana: {}, bitcoin: {}, ethereum: {} }),
  }));
  await page.route('**/rest/v1/**', (route) => route.fulfill({ status: 200, contentType: 'application/json', body: '[]' }));
  await page.route('**/functions/v1/**', async (route) => {
    let body = {};
    try { body = JSON.parse(route.request().postData() || '{}'); } catch (_) {}
    const endpoint = new URL(route.request().url()).pathname.split('/').pop();
    let status = 200;
    let payload = { ok: true };
    if (endpoint === 'osi-v2-profile') {
      requests.push(body);
      if (body.op === 'rollout_status') payload = { ok: true, profile_writes_enabled: options.writesEnabled !== false };
      else if (body.op === 'get_public_profile') payload = { ok: true, profile: publicProfile };
      else if (body.op === 'get_my_profile') payload = { ok: true, profile: options.ownerProfile || null };
      else if (body.op === 'prepare_profile_update') payload = { ok: true, nonce: 'profile-nonce', message: 'WALLET_PROFILE_UPDATED\nexact profile binding' };
      else if (body.op === 'commit_profile_update') payload = { ok: true, public_ref: PROFILE_REF, revision: 1 };
    } else if (endpoint === 'osi-v2-case-read' && body.op === 'list_public_cases') payload = { ok: true, cases: [] };
    else if (endpoint === 'osi-v2-analyst' && body.op === 'list_public_profiles') payload = { ok: true, analysts: [] };
    else if (endpoint === 'osi-v2-wire') payload = { ok: true, reports: [], wire_reports: [], stats: {} };
    else if (endpoint === 'osi-v2-proof') payload = { ok: true, events: [] };
    await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
  });
  await page.goto('/');
  await page.waitForFunction(() => typeof window.osiV2OpenMyProfile === 'function' && typeof window.osiV2OpenPublicProfile === 'function');
  return requests;
}

test('owner profile is private by default and saves only explicit public attribution', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const requests = await installFixture(page);
  await page.evaluate((wallet) => {
    eval('walletPubkey = wallet');
    window.osiV2ReadSession = async () => ({ wallet, token: 'owner-read-session' });
    window.osiV2RefreshReadSession = window.osiV2ReadSession;
    window.osiV2ApproveMessage = async () => 'base64-wallet-signature';
    window.resolveWorkspaceContext = () => ({ isVerifiedAnalyst: true, isMaintainer: false });
    window.osiV2OpenMyProfile();
  }, WALLET);

  await expect(page.getByRole('heading', { name: 'My Profile', exact: true })).toBeVisible();
  await expect(page.locator('#osi-profile-private')).toBeChecked();
  await expect(page.locator('#osi-profile-attribution')).toBeDisabled();
  await expect(page.getByText('Analyst authority stays separate')).toBeVisible();
  await expect(page.getByText('Your wallet profile stays owner-only. General identity fields you save also update your separate public analyst profile.')).toBeVisible();
  await expect(page.getByText(/even when this wallet profile is private/)).toBeVisible();
  await expect(page.locator('#osi-profile-form [name="expertise"]')).toHaveCount(0);

  await page.locator('#osi-profile-handle').fill('ChainReader');
  await page.locator('#osi-profile-name').fill('Chain Reader');
  await page.locator('#osi-profile-bio').fill('Public evidence contributor.');
  await page.locator('#osi-profile-public').check();
  await page.locator('#osi-profile-attribution').check();
  await page.getByRole('button', { name: 'Review and sign update' }).click();
  await expect(page.getByText('Profile saved. Your visibility and Case attribution choices are now current.')).toBeVisible();

  const prepare = requests.find((entry) => entry.op === 'prepare_profile_update');
  const commit = requests.find((entry) => entry.op === 'commit_profile_update');
  expect(prepare.profile).toMatchObject({
    handle: 'chainreader', display_name: 'Chain Reader', visibility: 'public', attribute_public_cases: true, avatar_action: 'keep',
  });
  expect(commit.profile).toEqual(prepare.profile);
  expect(JSON.stringify(prepare.profile)).not.toMatch(/wallet|expertise|review_weight|maintainer|analyst_status/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);
});

test('public profile route is responsive, keyboard reachable and never renders wallet identity', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await installFixture(page);
  await page.evaluate((profileRef) => window.osiV2OpenPublicProfile(profileRef), PROFILE_REF);

  await expect(page).toHaveURL(new RegExp(`#profile/${PROFILE_REF}$`));
  await expect(page.getByRole('heading', { name: 'Chain Reader' })).toBeVisible();
  await expect(page.getByText('@chainreader')).toBeVisible();
  await expect(page.getByText('Public evidence contributor.')).toBeVisible();
  await expect(page.getByText(WALLET)).toHaveCount(0);
  const back = page.getByRole('button', { name: 'Back to public Cases' });
  await back.focus();
  await expect(back).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1)).toBe(true);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Chain Reader' })).toBeVisible();
  await expect(page.getByText(WALLET)).toHaveCount(0);
});

test('published handle and rollout-disabled controls are visibly unavailable', async ({ page }) => {
  await installFixture(page, {
    writesEnabled: false,
    ownerProfile: {
      ...publicProfile, visibility: 'public', attribute_public_cases: true, revision: 2,
      source: 'wallet_profile', handle_locked: true,
    },
  });
  await page.evaluate((wallet) => {
    eval('walletPubkey = wallet');
    window.osiV2ReadSession = async () => ({ wallet, token: 'owner-read-session' });
    window.osiV2OpenMyProfile();
  }, WALLET);
  await expect(page.getByText('Profile updates are currently disabled')).toBeVisible();
  await expect(page.locator('#osi-profile-handle')).toBeDisabled();
  await expect(page.getByText('This username cannot be renamed after its first publication.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Profile updates disabled' })).toBeDisabled();
});
