import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('assets and training: register equipment, repair it and certify staff', async ({
  page,
}) => {
  const suffix = randomBytes(3).toString('hex').toUpperCase();
  const tag = `GRL-${suffix}`;
  await signInOwner(page);
  await openNav(page, 'Uskunalar');
  await page.getByRole('button', { name: '+ Yangi uskuna' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nomi', { exact: true }).fill(`Gril ${suffix}`);
  await dialog.getByLabel('Inventar raqami').fill(tag);
  await dialog.getByLabel('Turi').fill('Oshxona uskunasi');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText(`Gril ${suffix}`)).toBeVisible();
  await noHorizontalScroll(page);

  // Find it by its QR tag and report a problem.
  await page.getByLabel('Inventar raqami (QR)').fill(tag);
  await page.getByRole('button', { name: 'Qidirish' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByLabel('Muammo').fill('Gril qizimayapti');
  await dialog.getByLabel('Batafsil').fill('Ertalabdan beri ishlamaydi');
  await dialog
    .getByRole('button', { name: 'Nosozlik haqida xabar berish' })
    .click();
  await expect(dialog.getByText('Gril qizimayapti').first()).toBeVisible();
  await dialog
    .locator('.ops-item', { hasText: 'Gril qizimayapti' })
    .getByRole('button', { name: 'Tahrirlash' })
    .click();
  const repair = page.getByRole('dialog', { name: 'Gril qizimayapti' });
  await repair.getByLabel('Bajarilgan ish').fill('Rele almashtirildi');
  await repair.getByRole('button', { name: 'Ta’mir tugadi' }).click();
  await expect(dialog.getByText('Ta’mir yakunlandi')).toBeVisible();
  await dialog.getByRole('button', { name: 'Yopish' }).click();

  // Training: a course and a recorded completion.
  await openNav(page, 'O‘qitish');
  await page.getByLabel('Kurs nomi').fill(`Gigiyena ${suffix}`);
  await page.getByLabel(/Amal qilish muddati/).fill('365');
  await page.getByRole('button', { name: '+ Kurs qo‘shish' }).click();
  await expect(
    page.getByRole('columnheader', { name: `Gigiyena ${suffix}` }),
  ).toBeVisible();
  await page.getByLabel('Kurs', { exact: true }).selectOption({
    label: `Gigiyena ${suffix}`,
  });
  await page.getByLabel('Xodim', { exact: true }).selectOption({
    label: 'Aziz Karimov',
  });
  await page
    .getByRole('button', { name: 'Kurs tugatilganini qayd etish' })
    .click();
  await expect(
    page.getByRole('heading', { name: 'Mening sertifikatlarim' }),
  ).toBeVisible();
  await expect(
    page.locator('.ops-item', { hasText: `Gigiyena ${suffix}` }),
  ).toBeVisible();
});
