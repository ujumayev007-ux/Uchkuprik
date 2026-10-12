import { expect, test } from '@playwright/test';
import { openNav, signInOwner } from './helpers';

test('a paid POS order appears live on the kitchen screen and then on the queue TV', async ({
  browser,
  page,
}) => {
  // Kitchen screen in its own browser context, opened before the order exists.
  const kitchenContext = await browser.newContext();
  const kitchen = await kitchenContext.newPage();
  await signInOwner(kitchen);
  await openNav(kitchen, 'Oshxona');
  await expect(
    kitchen.getByRole('heading', { name: 'Oshxona ekrani' }),
  ).toBeVisible();
  await expect(kitchen.locator('.live-dot.on')).toBeVisible();

  await signInOwner(page);
  await openNav(page, 'Kassa');
  await expect(page.getByRole('heading', { name: 'Savat' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const openShift = page.getByRole('button', { name: 'Smenani ochish' });
  if (await openShift.isVisible()) {
    await page.getByLabel('Boshlang‘ich naqd pul (so‘m)').fill('0');
    await openShift.click();
    await expect(openShift).toHaveCount(0);
  }
  await page
    .getByRole('button', { name: 'Klassik burger 40 000 so‘m' })
    .click();
  await page
    .getByRole('complementary', { name: 'Savat' })
    .getByRole('button', { name: 'To‘lov qilish' })
    .click();
  const payment = page.getByRole('dialog');
  await payment.getByLabel('Qabul qilindi (so‘m)').fill('50000');
  await payment.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();
  const done = page.getByRole('dialog', { name: 'To‘lov qabul qilindi' });
  const numberText = (await done
    .locator('.order-number')
    .textContent())!.trim();
  const number = numberText.replace(/\D/g, '');
  await done.getByRole('button', { name: 'Yangi buyurtma' }).click();

  // No reload: the socket event refreshes the kitchen display.
  const ticket = kitchen.getByRole('article', { name: `№${number}` });
  await expect(ticket).toBeVisible({ timeout: 10_000 });
  await expect(ticket).toContainText('Klassik burger');
  await expect(ticket).not.toContainText('so‘m');
  await ticket.getByRole('button', { name: 'Tayyor', exact: true }).click();
  await expect(ticket.getByRole('button', { name: 'Berildi' })).toBeVisible();

  const queue = await kitchenContext.newPage();
  await queue.goto('/navbat');
  await expect(queue.locator('.queue-columns .ready')).toContainText(number);

  await ticket.getByRole('button', { name: 'Berildi' }).click();
  await expect(ticket).toHaveCount(0);
  await expect(queue.locator('.queue-columns .ready')).not.toContainText(
    number,
    { timeout: 10_000 },
  );
  await kitchenContext.close();
});
