import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('owner configures the menu with sizes and a branch price', async ({
  page,
}, info) => {
  const suffix = info.project.name;
  await signInOwner(page);
  await openNav(page, 'Menyu');
  await expect(
    page.getByRole('heading', { name: 'Menyu', level: 1 }),
  ).toBeVisible();

  await page.getByRole('button', { name: '+ Kategoriya qo‘shish' }).click();
  await page.getByRole('dialog').getByLabel('Nomi').fill(`Burgerlar ${suffix}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Saqlash' })
    .click();
  await page
    .getByRole('button', { name: `Burgerlar ${suffix}`, exact: true })
    .click();

  await page.getByRole('button', { name: '+ Taom qo‘shish' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Taom nomi').fill(`Chizburger ${suffix}`);
  await dialog.getByLabel('Nomi', { exact: true }).fill('Kichik');
  await dialog.getByLabel('Sotuv narxi (so‘m)').fill('25000');
  await expect(dialog.getByLabel('Sotuv narxi (so‘m)')).toHaveValue('25 000');
  await dialog.getByLabel('Tannarx (so‘m)').fill('11000');
  await dialog.getByRole('button', { name: '+ O‘lcham qo‘shish' }).click();
  await dialog.getByLabel('Nomi', { exact: true }).nth(1).fill('Katta');
  await dialog.getByLabel('Sotuv narxi (so‘m)').nth(1).fill('32000');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();

  const card = page
    .getByRole('article')
    .filter({ hasText: `Chizburger ${suffix}` });
  await expect(card).toContainText('25 000 so‘m');
  await expect(card).toContainText('32 000 so‘m');
  await expect(card).toContainText('Tannarx: 11 000 so‘m');

  // Branch price override is reflected in the menu.
  await page.getByRole('tab', { name: 'Filial narxlari' }).click();
  await page
    .getByLabel(`Chizburger ${suffix} Kichik Filial narxi`)
    .fill('23000');
  await page.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText('O‘zgarishlar saqlandi.').last()).toBeVisible();
  await page.getByRole('tab', { name: 'Taomlar' }).click();
  await expect(card).toContainText('23 000 so‘m');
  await noHorizontalScroll(page);
  await page.screenshot({ path: info.outputPath('menu.png'), fullPage: true });
});

test('owner builds the floor plan and saves restaurant settings', async ({
  page,
}, info) => {
  const suffix = info.project.name;
  await signInOwner(page);
  await openNav(page, 'Zallar va stollar');
  await page.getByRole('button', { name: '+ Zal qo‘shish' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Zal nomi')
    .fill(`Asosiy zal ${suffix}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Saqlash' })
    .click();
  const room = page
    .locator('section.card')
    .filter({ hasText: `Asosiy zal ${suffix}` });
  await room.getByRole('button', { name: '+ Stol qo‘shish' }).click();
  await page
    .getByRole('dialog')
    .getByLabel('Stol nomi yoki raqami')
    .fill(`T1-${suffix}`);
  await page.getByRole('dialog').getByLabel('O‘rinlar soni').fill('6');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Saqlash' })
    .click();
  await expect(room).toContainText(`T1-${suffix}`);
  await expect(room).toContainText('6 o‘rin');

  await openNav(page, 'Sozlamalar');
  await page.getByLabel(/STIR/).fill('305123456');
  await page.getByLabel(/Chek pastki matni/).fill('Xaridingiz uchun rahmat!');
  await page.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText('O‘zgarishlar saqlandi.').last()).toBeVisible();
  await page.reload();
  await expect(page.getByLabel(/STIR/)).toHaveValue('305123456');
  await noHorizontalScroll(page);
});
