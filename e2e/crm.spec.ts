import { expect, test, type Page } from '@playwright/test';
import { openNav, signInOwner } from './helpers';

async function ensureShift(page: Page) {
  await expect(page.getByRole('heading', { name: 'Savat' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const open = page.getByRole('button', { name: 'Smenani ochish' });
  if (await open.isVisible()) {
    await page.getByLabel('Boshlang‘ich naqd pul (so‘m)').fill('0');
    await open.click();
    await expect(open).toHaveCount(0);
  }
}

test('loyalty and promo codes: earn points on a discounted sale, then pay with points', async ({
  page,
}, info) => {
  const suffix = info.project.name === 'desktop' ? '1' : '2';
  const phone = `+998 90 000 00 0${suffix}`;
  const code = `E2E${suffix}${Date.now().toString().slice(-5)}`;
  await signInOwner(page);

  await openNav(page, 'Sozlamalar');
  await page.getByLabel(/Sodiqlik ballari/).fill('5');
  await page.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText('O‘zgarishlar saqlandi.').last()).toBeVisible();

  await openNav(page, 'Mijozlar');
  await page.getByRole('tab', { name: 'Promokodlar' }).click();
  await page.getByRole('button', { name: '+ Yangi promokod' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Kod').fill(code);
  await dialog.getByLabel(/Qiymati/).fill('10');
  await dialog.getByRole('button', { name: 'Yaratish' }).click();
  await expect(page.getByRole('row', { name: new RegExp(code) })).toContainText(
    '10%',
  );

  // Discounted sale for a loyalty customer: 3 × 40 000 − 10 % = 108 000.
  await openNav(page, 'Kassa');
  await ensureShift(page);
  const burger = page.getByRole('button', {
    name: 'Klassik burger 40 000 so‘m',
  });
  for (let i = 0; i < 3; i++) await burger.click();
  const cart = page.getByRole('complementary', { name: 'Savat' });
  await cart.getByText('Mijoz telefoni · Promokod').click();
  await cart.getByLabel(/Mijoz telefoni/).fill(phone);
  await cart.getByLabel(/Promokod/).fill(code);
  await cart.getByRole('button', { name: 'To‘lov qilish' }).click();
  const payment = page.getByRole('dialog');
  await expect(payment.locator('.payment-summary')).toContainText(
    '108 000 so‘m',
  );
  await payment.getByLabel('Qabul qilindi (so‘m)').fill('108000');
  await payment.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();
  const done = page.getByRole('dialog', { name: 'To‘lov qabul qilindi' });
  const number = (
    (await done.locator('.order-number').textContent()) ?? ''
  ).replace(/\D/g, '');
  await done.getByRole('button', { name: 'Yangi buyurtma' }).click();

  await openNav(page, 'Buyurtmalar');
  await page
    .getByRole('row')
    .filter({ hasText: `№${number}` })
    .first()
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Yakunlash (berildi)' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('Yakunlandi');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Yopish' })
    .click();

  // 5 % of 108 000 = 5 400 points.
  await openNav(page, 'Mijozlar');
  await expect(
    page.getByRole('row').filter({ hasText: '+99890000000' + suffix }),
  ).toContainText('5400');

  // Next order: pay 5 400 with points and the rest by card.
  await openNav(page, 'Kassa');
  await ensureShift(page);
  await page
    .getByRole('button', { name: 'Klassik burger 40 000 so‘m' })
    .click();
  await cart.getByText('Mijoz telefoni · Promokod').click();
  await cart.getByLabel(/Mijoz telefoni/).fill(phone);
  await cart.getByRole('button', { name: 'To‘lov qilish' }).click();
  const second = page.getByRole('dialog');
  await second.getByRole('radio', { name: 'Ballar' }).click();
  await expect(second.locator('.notice')).toContainText('5400');
  await expect(second.getByLabel('To‘lov summasi (so‘m)')).toHaveValue('5 400');
  await second.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();
  await expect(second.locator('.payment-summary .due')).toContainText(
    '34 600 so‘m',
  );
  await second.getByRole('radio', { name: 'Karta' }).click();
  await second.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();
  await expect(
    page.getByRole('dialog', { name: 'To‘lov qabul qilindi' }),
  ).toBeVisible();
});
