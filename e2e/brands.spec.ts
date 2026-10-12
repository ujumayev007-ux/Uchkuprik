import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('multi-brand: owner creates a brand and a brand-specific menu category', async ({
  page,
}) => {
  const suffix = randomBytes(3).toString('hex');
  const name = `Pizza ${suffix}`;
  await signInOwner(page);
  await openNav(page, 'Brendlar');
  await expect(
    page.getByRole('heading', { name: 'Brendlar', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '+ Yangi brend' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nomi').fill(name);
  await dialog.getByLabel('Brend kodi').fill(`pizza-${suffix}`);
  await dialog.getByLabel(/Chek sarlavhasi/).fill(`${name} — xush kelibsiz`);
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
  await expect(
    page.getByRole('heading', { name: 'Brendlar bo‘yicha savdo' }),
  ).toBeVisible();
  await noHorizontalScroll(page);

  // The brand appears in the category editor.
  await openNav(page, 'Menyu');
  await page.getByRole('button', { name: /Kategoriya qo‘shish/ }).click();
  const category = page.getByRole('dialog');
  await category.getByLabel('Nomi').fill(`Pitsalar ${suffix}`);
  await category.getByLabel('Brend').selectOption({ label: name });
  await category.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText(`Pitsalar ${suffix}`).first()).toBeVisible();

  await openNav(page, 'Brendlar');
  await expect(page.locator('.brand-card', { hasText: name })).toContainText(
    'Kategoriyalar: 1',
  );
});
