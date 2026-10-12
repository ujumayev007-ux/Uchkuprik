import { expect, test } from '@playwright/test';
import { openNav, signInOwner, tenant } from './helpers';

test('guest orders from a table QR menu, staff approve it live, guest tracks it', async ({
  browser,
  page,
}, info) => {
  const suffix = info.project.name;
  await signInOwner(page);

  // Enable online ordering.
  await openNav(page, 'Sozlamalar');
  const toggle = page.getByLabel(/onlayn buyurtmani yoqish/);
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await page.getByRole('button', { name: 'Saqlash' }).click();
    await expect(page.getByText('O‘zgarishlar saqlandi.').last()).toBeVisible();
  }

  // A table with a printable QR code.
  await openNav(page, 'Zallar va stollar');
  await page.getByRole('button', { name: '+ Zal qo‘shish' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Zal nomi')
    .fill(`Terrasa ${suffix}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Saqlash' })
    .click();
  const room = page
    .locator('section.card')
    .filter({ hasText: `Terrasa ${suffix}` });
  await room.getByRole('button', { name: '+ Stol qo‘shish' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Stol nomi yoki raqami')
    .fill(`QR-${suffix}`);
  await page.getByRole('dialog').getByLabel('O‘rinlar soni').fill('2');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Saqlash' })
    .click();
  await room.getByRole('button', { name: 'QR kod' }).click();
  const qrLink = await page
    .getByRole('dialog')
    .getByRole('link')
    .getAttribute('href');
  expect(qrLink).toMatch(/\/t\/[A-Za-z0-9_-]+$/);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Yopish' })
    .click();
  await openNav(page, 'Buyurtmalar');

  // Anonymous guest on their phone.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(qrLink!);
  await expect(
    guest.getByRole('heading', { name: 'Lazzat Burger' }),
  ).toBeVisible();
  await expect(guest.getByText(`Stol QR-${suffix}`)).toBeVisible();
  await guest.getByRole('button', { name: /Klassik burger/ }).click();
  await guest.getByRole('button', { name: /Klassik burger/ }).click();
  await guest.getByRole('button', { name: /Buyurtmangiz · 2/ }).click();
  await guest.getByLabel('Ismingiz').fill('Mehmon');
  await guest.getByRole('button', { name: 'Buyurtmani yuborish' }).click();
  await expect(
    guest.getByRole('heading', { name: 'Buyurtma holati' }),
  ).toBeVisible();
  await expect(
    guest.getByText('Restoran buyurtmangizni ko‘rib chiqmoqda.'),
  ).toBeVisible();
  const number = (
    (await guest.locator('.order-number').textContent()) ?? ''
  ).replace(/\D/g, '');

  // Staff see it live in the pending banner and approve it.
  const banner = page.locator('.pending-orders');
  await expect(banner).toContainText(`№${number}`, { timeout: 10_000 });
  await expect(banner).toContainText('QR menyu');
  await banner
    .locator('li')
    .filter({ hasText: `№${number}` })
    .getByRole('button', { name: 'Tasdiqlash' })
    .click();
  await expect(
    banner.locator('li').filter({ hasText: `№${number}` }),
  ).toHaveCount(0);

  await guest.reload();
  await expect(guest.locator('.track-hint')).toHaveText('Tasdiqlandi');
  await guestContext.close();
});

test('website delivery order requires contact details', async ({ page }) => {
  await page.goto(`/r/${tenant()}`);
  await expect(
    page.getByRole('heading', { name: 'Lazzat Burger' }),
  ).toBeVisible();
  await page.getByRole('radio', { name: 'Yetkazib berish' }).click();
  await page.getByRole('button', { name: /Kola/ }).click();
  await page.getByRole('button', { name: /Buyurtmangiz · 1/ }).click();
  await page.getByLabel('Ismingiz').fill('Mijoz');
  await page.getByLabel('Telefon raqamingiz').fill('+998 90 123 45 67');
  await page
    .getByLabel('Yetkazib berish manzili')
    .fill('Chilonzor 9-kvartal, 12-uy');
  await page.getByRole('button', { name: 'Buyurtmani yuborish' }).click();
  await expect(page.getByText('Qabul qilinmoqda')).toBeVisible();
});
