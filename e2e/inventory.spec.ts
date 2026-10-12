import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('warehouse: ingredient, supplier, purchase receipt, valuation and recipe', async ({
  page,
}, info) => {
  const suffix = info.project.name;
  await signInOwner(page);
  await openNav(page, 'Ombor');
  await expect(
    page.getByRole('heading', { name: 'Ombor', level: 1 }),
  ).toBeVisible();

  await page.getByRole('button', { name: '+ Mahsulot qo‘shish' }).click();
  const itemDialog = page.getByRole('dialog');
  await itemDialog.getByLabel('Nomi').fill(`Go‘sht ${suffix}`);
  await itemDialog.getByLabel('Minimal qoldiq').fill('20000');
  await itemDialog.getByRole('button', { name: '+ Birlik qo‘shish' }).click();
  await itemDialog.getByLabel('Birlik nomi').fill('kg');
  await itemDialog.getByLabel(/Asosiy birlikda/).fill('1000');
  await itemDialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(`Go‘sht ${suffix}`) }),
  ).toContainText('0 g');

  await page.getByRole('tab', { name: 'Ta’minotchilar' }).click();
  await page.getByLabel('Nomi').fill(`Ta’minot ${suffix}`);
  await page.getByRole('button', { name: '+ Ta’minotchi qo‘shish' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(`Ta’minot ${suffix}`) }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Xaridlar' }).click();
  await page.getByRole('button', { name: '+ Yangi xarid' }).click();
  const purchase = page.getByRole('dialog');
  await purchase
    .getByLabel('Ta’minotchi')
    .selectOption({ label: `Ta’minot ${suffix}` });
  await purchase.getByRole('button', { name: '+ Qator qo‘shish' }).click();
  await purchase
    .getByLabel('Mahsulot')
    .selectOption({ label: `Go‘sht ${suffix}` });
  await purchase.getByLabel('Miqdori').fill('10');
  await purchase.getByLabel('Birlik', { exact: true }).selectOption('kg');
  await purchase.getByLabel(/Birlik narxi/).fill('80000');
  await expect(purchase.locator('.cart-total')).toContainText('800 000 so‘m');
  await purchase.getByRole('button', { name: 'Saqlash' }).click();
  const draft = page.getByRole('row').filter({ hasText: `Ta’minot ${suffix}` });
  await draft.getByRole('button', { name: 'Qabul qilish' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Tasdiqlash' })
    .click();
  await expect(draft).toContainText('Qabul qilingan');

  await page.getByRole('tab', { name: 'Qoldiqlar' }).click();
  const stockRow = page.getByRole('row', {
    name: new RegExp(`Go‘sht ${suffix}`),
  });
  await expect(stockRow).toContainText('10 000 g');
  await expect(stockRow).toContainText('800 000 so‘m');
  await expect(stockRow).toContainText('Kam qoldi');
  await page.getByRole('tab', { name: 'Ta’minotchilar' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(`Ta’minot ${suffix}`) }),
  ).toContainText('800 000 so‘m');
  await noHorizontalScroll(page);

  // Recipe: 150 g per burger, priced from the average cost (150 × 80 = 12 000 so‘m).
  await openNav(page, 'Menyu');
  const card = page.getByRole('article').filter({ hasText: 'Klassik burger' });
  await card.getByRole('button', { name: 'Retsept' }).click();
  const recipe = page.getByRole('dialog');
  // Both browser projects share the demo menu; start from an empty recipe.
  await page.waitForLoadState('networkidle');
  const remove = recipe.getByRole('button', { name: 'Olib tashlash' });
  while ((await remove.count()) > 0) await remove.first().click();
  await recipe.getByRole('button', { name: '+ Masalliq qo‘shish' }).click();
  await recipe
    .getByLabel('Masalliq')
    .selectOption({ label: `Go‘sht ${suffix}` });
  await recipe.getByLabel(/Miqdori/).fill('150');
  await recipe.getByRole('button', { name: 'Saqlash' }).click();
  await expect(recipe).toContainText('12 000 so‘m');
});
