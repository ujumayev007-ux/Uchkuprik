import { expect, test } from '@playwright/test';
import { openNav, password, signInOwner, tenant } from './helpers';

test('delivery: zone fee at the POS, kitchen ready, courier assignment, pickup and proof of delivery', async ({
  browser,
  page,
}, info) => {
  const suffix = info.project.name;
  await signInOwner(page);

  await openNav(page, 'Yetkazib berish');
  await page.getByRole('tab', { name: 'Hududlar' }).click();
  await page.getByRole('button', { name: '+ Hudud qo‘shish' }).click();
  const zoneDialog = page.getByRole('dialog');
  await zoneDialog.getByLabel('Nomi').fill(`Yunusobod ${suffix}`);
  await zoneDialog.getByLabel(/Yetkazib berish narxi/).fill('15000');
  await zoneDialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(`Yunusobod ${suffix}`) }),
  ).toContainText('15 000 so‘m');

  // Delivery sale: 40 000 + 15 000 fee = 55 000, paid by card.
  await openNav(page, 'Kassa');
  await expect(page.getByRole('heading', { name: 'Savat' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const openShift = page.getByRole('button', { name: 'Smenani ochish' });
  if (await openShift.isVisible()) {
    await page.getByLabel('Boshlang‘ich naqd pul (so‘m)').fill('0');
    await openShift.click();
    await expect(openShift).toHaveCount(0);
  }
  const cart = page.getByRole('complementary', { name: 'Savat' });
  await cart.getByRole('radio', { name: 'Yetkazib berish' }).click();
  await cart
    .getByLabel('Mijoz telefoni', { exact: true })
    .fill('+998 90 555 44 33');
  await cart
    .getByLabel('Yetkazib berish manzili')
    .fill(`Yunusobod 4-kvartal, ${suffix}`);
  await cart
    .getByLabel('Hudud')
    .selectOption({ label: `Yunusobod ${suffix} (+15 000 so‘m)` });
  await page
    .getByRole('button', { name: 'Klassik burger 40 000 so‘m' })
    .click();
  await cart.getByRole('button', { name: 'To‘lov qilish' }).click();
  const payment = page.getByRole('dialog');
  await expect(payment.locator('.payment-summary')).toContainText(
    '55 000 so‘m',
  );
  await payment.getByRole('radio', { name: 'Karta' }).click();
  await payment.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();
  const done = page.getByRole('dialog', { name: 'To‘lov qabul qilindi' });
  const number = (
    (await done.locator('.order-number').textContent()) ?? ''
  ).replace(/\D/g, '');
  await done.getByRole('button', { name: 'Yangi buyurtma' }).click();

  // Kitchen marks it ready.
  await openNav(page, 'Oshxona');
  await page
    .getByRole('article', { name: `№${number}` })
    .getByRole('button', { name: 'Tayyor', exact: true })
    .click();

  // Dispatcher assigns the courier.
  await openNav(page, 'Yetkazib berish');
  await page
    .getByLabel(`Kuryer ${number}`)
    .selectOption({ label: 'Jasur Kuryer' });
  await expect(
    page.getByRole('row').filter({ hasText: `№${number}` }),
  ).toContainText('Kuryerga berildi');

  // Courier on their phone.
  const courierContext = await browser.newContext();
  const courier = await courierContext.newPage();
  await courier.goto('/kirish');
  await courier.getByLabel('Biznes kodi').fill(tenant());
  await courier.getByLabel('Login').fill('kuryer');
  await courier.getByLabel('Parol').fill(password());
  await courier.getByRole('button', { name: 'Kirish', exact: true }).click();
  await expect(
    courier.getByRole('heading', { name: 'Mening yetkazishlarim' }),
  ).toBeVisible();
  const card = courier.getByRole('article', { name: `№${number}` });
  await expect(card).toContainText(`Yunusobod 4-kvartal, ${suffix}`);
  await expect(card).toContainText('To‘langan');
  await card.getByRole('button', { name: 'Buyurtmani oldim' }).click();
  await card.getByRole('button', { name: 'Yetkazildi' }).click();
  await courier
    .getByRole('dialog')
    .getByLabel('Kim qabul qildi / izoh')
    .fill('Mijozning o‘zi');
  await courier
    .getByRole('dialog')
    .getByRole('button', { name: 'Tasdiqlash' })
    .click();
  await expect(card).toHaveCount(0);
  await courierContext.close();

  // Paid and delivered: the order is completed and leaves the board.
  await page.reload();
  await expect(
    page.getByRole('row').filter({ hasText: `№${number}` }),
  ).toHaveCount(0);
});
