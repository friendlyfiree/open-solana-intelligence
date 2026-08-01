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

    const userSupport = document.createElement('p');
    userSupport.id = 'dynamic-user-support';
    userSupport.dataset.osiUserContent = '';
    userSupport.textContent = 'Support';
    document.body.appendChild(userSupport);

    const userSaved = document.createElement('p');
    userSaved.id = 'dynamic-user-saved';
    userSaved.dataset.osiUserContent = '';
    userSaved.textContent = 'Saved successfully';
    document.body.appendChild(userSaved);

    const payment = document.createElement('section');
    payment.id = 'dynamic-payment-copy';
    payment.setAttribute('role', 'dialog');
    payment.innerHTML = '<h3>Review exact mainnet transfer</h3><button>Show Solana Pay</button>';
    document.body.appendChild(payment);

    const analyst = document.createElement('section');
    analyst.id = 'dynamic-analyst-profile-copy';
    analyst.setAttribute('role', 'dialog');
    analyst.setAttribute('aria-label', 'Analyst profile');
    analyst.innerHTML = '<span>Server-derived weight</span><em>Probationary</em><h4>Public contributions</h4><b>No public contributions recorded</b><button>Support analyst with SOL</button>';
    document.body.appendChild(analyst);
  });

  await expect(page.locator('#dynamic-ui-copy')).toHaveText('Cüzdanı Bağla');
  await expect(page.locator('#dynamic-user-copy')).toHaveText('Home');
  await expect(page.locator('#dynamic-user-support')).toHaveText('Support');
  await expect(page.locator('#dynamic-user-saved')).toHaveText('Saved successfully');
  await expect(page.locator('#dynamic-payment-copy h3')).toHaveText('Kesin mainnet transferini inceleyin');
  await expect(page.locator('#dynamic-payment-copy button')).toHaveText('Solana Pay’i göster');
  await expect(page.locator('#dynamic-analyst-profile-copy')).toHaveAttribute('aria-label', 'Analist profili');
  await expect(page.locator('#dynamic-analyst-profile-copy span')).toHaveText('Sunucunun belirlediği ağırlık');
  await expect(page.locator('#dynamic-analyst-profile-copy em')).toHaveText('Deneme süreci');
  await expect(page.locator('#dynamic-analyst-profile-copy h4')).toHaveText('Kamusal katkılar');
  await expect(page.locator('#dynamic-analyst-profile-copy b')).toHaveText('Kaydedilmiş kamusal katkı yok');
  await expect(page.locator('#dynamic-analyst-profile-copy button')).toHaveText('Analisti SOL ile destekle');
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
