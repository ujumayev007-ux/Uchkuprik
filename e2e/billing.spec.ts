import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, password } from './helpers';

test('SaaS: self-service sign-up, plan-gated modules and upgrade', async ({
  page,
}) => {
  const slug = `e2e-${randomBytes(4).toString('hex')}`;
  await page.goto('/kirish');
  await page
    .getByRole('link', { name: 'Biznesingiz uchun hisob ochish' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Ro‘yxatdan o‘tish' }),
  ).toBeVisible();
  await page.getByLabel('Biznes nomi').fill('Tez Lavash');
  await page.getByLabel('Biznes identifikatori').fill(slug);
  await page.getByLabel('Birinchi filial nomi').fill('Sergeli');
  await page.getByLabel('Tarif').selectOption('BASIC');
  await page.getByLabel('Ismingiz').fill('Malika Yusupova');
  await page.getByLabel('Login').fill('malika');
  await page.getByLabel('Parol').fill(password());
  await page.getByLabel(/Foydalanish shartlari/).check();
  await noHorizontalScroll(page);
  await page.getByRole('button', { name: 'Ro‘yxatdan o‘tish' }).click();

  // The business code is remembered for sign-in.
  await expect(page.getByLabel('Biznes kodi')).toHaveValue(slug);
  await page.getByLabel('Login').fill('malika');
  await page.getByLabel('Parol').fill(password());
  await page.getByRole('button', { name: 'Kirish', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /Xush kelibsiz, Malika Yusupova/ }),
  ).toBeVisible();

  // Basic plan: optional modules are hidden and gated.
  const nav = page.getByRole('complementary');
  await expect(
    nav.getByRole('link', { name: 'Ombor', exact: true }),
  ).toHaveCount(0);
  await page.goto('/ombor');
  await expect(
    page.getByRole('heading', { name: 'Bu imkoniyat tarifingizga kirmaydi' }),
  ).toBeVisible();

  await page.getByRole('link', { name: 'Obunani ko‘rish' }).click();
  await expect(page.getByRole('heading', { name: 'Obuna' })).toBeVisible();
  await expect(page.getByText('Sinov davri').first()).toBeVisible();
  await expect(
    page.getByRole('progressbar', { name: 'Filiallar' }),
  ).toHaveAttribute('aria-valuenow', '1');
  await noHorizontalScroll(page);

  // Upgrade to Pro: the warehouse module becomes available.
  await page
    .locator('.plan-card', {
      has: page.getByRole('heading', { name: 'Pro', exact: true }),
    })
    .getByRole('button', { name: 'Tanlash' })
    .click();
  await page.getByRole('button', { name: 'Tasdiqlash' }).click();
  await expect(page.getByText('Tarif o‘zgartirildi').last()).toBeVisible();
  await expect(
    page
      .locator('.plan-card.current')
      .getByRole('heading', { name: 'Pro', exact: true }),
  ).toBeVisible();
  await openNav(page, 'Ombor');
  await expect(page).toHaveURL(/\/ombor$/);
  await expect(
    page.getByRole('heading', { name: 'Bu imkoniyat tarifingizga kirmaydi' }),
  ).toHaveCount(0);
});
