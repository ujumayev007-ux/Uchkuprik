import { expect, test } from '@playwright/test';

test('shows the real API result in Uzbek and supports retry and theme switching', async ({
  page,
  request,
}) => {
  const response = await request.get('http://127.0.0.1:4000/api/health/ready');
  expect([200, 503]).toContain(response.status());
  if (process.env.REQUIRE_DATABASE === 'true')
    expect(response.status()).toBe(200);
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'uz');
  await expect(
    page.getByRole('heading', { name: 'Tizim holati' }),
  ).toBeVisible();
  const state =
    response.status() === 200
      ? 'Ulanish tayyor'
      : 'Ulanish vaqtincha mavjud emas';
  await expect(
    page.getByRole('heading', { name: state, exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Qayta tekshirish' }).click();
  await expect(
    page.getByRole('heading', { name: state, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('foundation-light.png'),
    fullPage: true,
  });
  await page.getByRole('button', { name: 'Tungi ko‘rinish' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(
    page.getByRole('button', { name: 'Yorug‘ ko‘rinish' }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('foundation-dark.png'),
    fullPage: true,
  });
});

test('shows a recoverable network error instead of reporting success', async ({
  page,
}) => {
  await page.route('**/api/health/ready', (route) =>
    route.abort('connectionfailed'),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Xizmat bilan bog‘lanib bo‘lmadi' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Qayta tekshirish' }),
  ).toBeEnabled();
});

test('does not interpret an invalid API response as a healthy connection', async ({
  page,
}) => {
  await page.route('**/api/health/ready', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '{"status":"unavailable","message":"Invalid success"}',
    }),
  );
  await page.goto('/');
  await expect(
    page.getByRole('heading', { name: 'Xizmat bilan bog‘lanib bo‘lmadi' }),
  ).toBeVisible();
});
