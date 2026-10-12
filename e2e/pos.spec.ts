import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('cashier flow: open shift, sell with cash change, print receipt, complete order, close shift', async ({
  page,
}, info) => {
  await signInOwner(page);
  await openNav(page, 'Kassa');

  // Desktop and mobile runs share the owner's register; open a shift only if needed.
  await expect(page.getByRole('heading', { name: 'Savat' })).toBeVisible();
  await page.waitForLoadState('networkidle');
  const openShift = page.getByRole('button', { name: 'Smenani ochish' });
  if (await openShift.isVisible()) {
    await page.getByLabel('Boshlang‘ich naqd pul (so‘m)').fill('100000');
    await openShift.click();
    await expect(openShift).toHaveCount(0);
  }

  // 3 × burger (40 000) + 1 × cola (10 000) = 130 000 so‘m.
  const burger = page.getByRole('button', {
    name: 'Klassik burger 40 000 so‘m',
  });
  for (let i = 0; i < 3; i++) await burger.click();
  await page.getByRole('button', { name: 'Kola 10 000 so‘m' }).click();
  const cart = page.getByRole('complementary', { name: 'Savat' });
  await expect(cart.locator('.cart-total')).toContainText('130 000 so‘m');
  await noHorizontalScroll(page);

  await cart.getByRole('button', { name: 'To‘lov qilish' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Qabul qilindi (so‘m)').fill('200000');
  await expect(dialog.locator('.change')).toContainText('70 000 so‘m');
  await dialog.getByRole('button', { name: 'To‘lovni tasdiqlash' }).click();

  const done = page.getByRole('dialog', { name: 'To‘lov qabul qilindi' });
  await expect(done).toContainText('Mijozga qaytim bering');
  await expect(done).toContainText('70 000 so‘m');
  const [receipt] = await Promise.all([
    page.waitForEvent('popup'),
    done.getByRole('button', { name: 'Chek chiqarish' }).click(),
  ]);
  await expect(receipt.getByText('Fiskal chek emas')).toBeVisible();
  await expect(receipt.locator('.receipt')).toContainText('130 000 so‘m');
  await expect(receipt.locator('.receipt')).toContainText('Qaytim');
  await receipt.screenshot({
    path: info.outputPath('receipt.png'),
    fullPage: true,
  });
  await receipt.close();
  await done.getByRole('button', { name: 'Yangi buyurtma' }).click();
  await page.screenshot({ path: info.outputPath('pos.png'), fullPage: true });

  // The paid order appears in today's orders and can be handed out.
  await openNav(page, 'Buyurtmalar');
  const row = page
    .getByRole('row')
    .filter({ hasText: '130 000 so‘m' })
    .filter({ hasText: 'Qabul qilindi' })
    .first();
  await row.click();
  const detail = page.getByRole('dialog');
  await detail.getByRole('button', { name: 'Yakunlash (berildi)' }).click();
  await expect(detail).toContainText('Yakunlandi');
  await detail.getByRole('button', { name: 'Yopish' }).click();

  // Close the shift; the Z-report opens in a new window.
  page.context().on('page', (popup) => void popup.close());
  await openNav(page, 'Smena');
  await page.getByLabel('Sanalgan naqd (so‘m)').fill('230000');
  await page.getByRole('button', { name: 'Smenani yopish' }).click();
  await expect(page.getByText('Smena yopildi').last()).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Smenani ochish' }),
  ).toBeVisible();
});
