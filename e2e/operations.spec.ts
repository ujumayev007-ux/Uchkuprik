import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

// Smallest valid PNG (1×1 pixel) used as photo evidence.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('operations: checklist with photo evidence and a temperature alarm', async ({
  page,
}) => {
  const suffix = randomBytes(3).toString('hex');
  const name = `Ochilish ${suffix}`;
  await signInOwner(page);
  await openNav(page, 'Operatsiyalar');
  await expect(
    page.getByRole('heading', { name: 'Operatsiyalar', exact: true }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Shablonlar' }).click();
  await page.getByRole('button', { name: '+ Yangi shablon' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nomi').fill(name);
  await dialog.getByLabel('Bandlar').fill('Pol tozaligi\nVitrina [rasm]');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText(name)).toBeVisible();

  await page.getByRole('tab', { name: 'Bugun' }).click();
  const card = page.locator('section.card', { hasText: name });
  await card.getByRole('button', { name: 'Boshlash' }).click();
  await card.getByRole('checkbox', { name: /Pol tozaligi/ }).click();
  await expect(
    card.getByRole('checkbox', { name: /Pol tozaligi/ }),
  ).toBeChecked();
  await card.getByLabel('Rasm yuklash').setInputFiles({
    name: 'vitrina.png',
    mimeType: 'image/png',
    buffer: PNG,
  });
  await expect(card.getByText('Rasm biriktirildi')).toBeVisible();
  await card.getByRole('button', { name: 'Yakunlash' }).click();
  await expect(card.getByText('Bajarildi', { exact: true })).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole('tab', { name: 'Harorat' }).click();
  await page.getByLabel('O‘lchash nuqtasi').fill(`Muzlatgich ${suffix}`);
  await page.getByLabel('Harorat, °C').fill('9');
  await page.getByRole('button', { name: 'Yozib qo‘yish' }).click();
  await expect(
    page.getByText('Me’yordan tashqari! Hodisa avtomatik ochildi.'),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Hodisalar' }).click();
  await expect(
    page.getByText(`Harorat me’yordan tashqarida: Muzlatgich ${suffix}`),
  ).toBeVisible();
});
