import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('developer platform: API key is shown once and authorizes the public API', async ({
  page,
}) => {
  const name = `ERP ${randomBytes(3).toString('hex')}`;
  await signInOwner(page);
  await openNav(page, 'Integratsiyalar');
  await page.getByLabel('Kalit nomi').fill(name);
  await page.getByLabel('Menyuni o‘qish').check();
  await page.getByRole('button', { name: '+ Kalit yaratish' }).click();
  const dialog = page.getByRole('dialog', { name: 'Yangi API kaliti' });
  const key = (await dialog.locator('.secret-box').textContent())?.trim() ?? '';
  expect(key).toMatch(/^ffk_/);
  await dialog.getByRole('button', { name: 'Yopish' }).click();
  await expect(page.locator('.ops-item', { hasText: name })).toContainText(
    key.slice(0, 12),
  );
  await noHorizontalScroll(page);

  const response = await page.request.get('/api/v1/menu', {
    headers: { Authorization: `Bearer ${key}` },
  });
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.products.length).toBeGreaterThan(0);
  const denied = await page.request.get('/api/v1/menu', {
    headers: { Authorization: 'Bearer ffk_invalidinvalidinvalidinvalid' },
  });
  expect(denied.status()).toBe(401);
});
