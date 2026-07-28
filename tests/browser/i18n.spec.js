const { test, expect } = require('@playwright/test');

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('osi_language'));
  await page.reload();
});

test('switches between English and Turkish and persists the choice', async ({ page }) => {
  const language = page.locator('#osi-language-select');

  await expect(language).toHaveValue('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#osi-home-title')).toHaveText('Investigate Solana incidents. Prove every step.');

  await language.selectOption('tr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.locator('#osi-home-title')).toHaveText('Solana olaylarını inceleyin. Her adımı kanıtlayın.');
  await expect(page.locator('[data-global-view="registry"]')).toHaveText('Ana Sayfa');
  await expect(page).toHaveTitle('Open Solana Intelligence | Kamusal olay istihbaratı');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('osi_language'))).toBe('tr');

  await page.reload();
  await expect(language).toHaveValue('tr');
  await expect(page.locator('html')).toHaveAttribute('lang', 'tr');
  await expect(page.locator('#osi-home-title')).toHaveText('Solana olaylarını inceleyin. Her adımı kanıtlayın.');

  await language.selectOption('en');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.locator('#osi-home-title')).toHaveText('Investigate Solana incidents. Prove every step.');
});

test('translates dynamic interface labels and leaves opted-out user content untouched', async ({ page }) => {
  await page.locator('#osi-language-select').selectOption('tr');
  await page.evaluate(() => {
    const ui = document.createElement('button');
    ui.id = 'dynamic-ui-copy';
    ui.textContent = 'Connect Wallet';
    document.body.appendChild(ui);

    const userContent = document.createElement('p');
    userContent.id = 'dynamic-user-copy';
    userContent.dataset.osiUserContent = '';
    userContent.textContent = 'Home';
    document.body.appendChild(userContent);

    const payment = document.createElement('section');
    payment.id = 'dynamic-payment-copy';
    payment.setAttribute('role', 'dialog');
    payment.innerHTML = '<h3>Review exact mainnet transfer</h3><button>Show Solana Pay</button>';
    document.body.appendChild(payment);
  });

  await expect(page.locator('#dynamic-ui-copy')).toHaveText('Cüzdanı Bağla');
  await expect(page.locator('#dynamic-user-copy')).toHaveText('Home');
  await expect(page.locator('#dynamic-payment-copy h3')).toHaveText('Kesin mainnet transferini inceleyin');
  await expect(page.locator('#dynamic-payment-copy button')).toHaveText('Solana Pay’i göster');
});

test('keeps the language control visible at supported viewport widths', async ({ page }) => {
  for (const width of [375, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    const box = await page.locator('.osi-language-control').boundingBox();
    expect(box).not.toBeNull();
    expect(box.width).toBeGreaterThanOrEqual(40);
    expect(box.height).toBeGreaterThanOrEqual(40);
    expect(box.x + box.width).toBeLessThanOrEqual(width);
  }
});
