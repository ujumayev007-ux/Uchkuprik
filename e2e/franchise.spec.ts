import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('franchise: partner onboarding, contract activation and an inspection', async ({
  page,
}) => {
  const suffix = randomBytes(3).toString('hex');
  const partner = `Hamkor ${suffix}`;
  await signInOwner(page);
  await openNav(page, 'Franshiza');
  await expect(
    page.getByRole('heading', { name: 'Franshiza', exact: true }),
  ).toBeVisible();

  await page.getByRole('button', { name: '+ Yangi franchayzi' }).click();
  let dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nomi', { exact: true }).fill(partner);
  await dialog.getByLabel(/STIR/).fill('305123456');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(
    page.getByRole('row', { name: new RegExp(partner) }),
  ).toBeVisible();

  await page.getByRole('tab', { name: 'Shartnomalar' }).click();
  await page.getByRole('button', { name: '+ Yangi shartnoma' }).click();
  dialog = page.getByRole('dialog');
  await dialog
    .getByLabel('Franchayzi', { exact: true })
    .selectOption({ label: partner });
  await dialog.getByLabel('Shartnoma raqami').fill(`F-${suffix}`);
  await dialog.getByLabel('Hudud', { exact: true }).fill(`Hudud ${suffix}`);
  await dialog.getByLabel('Royalti, %').fill('6');
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  const row = page.getByRole('row', { name: new RegExp(`F-${suffix}`) });
  await expect(row).toContainText('Qoralama');
  await row.getByRole('button', { name: 'Faollashtirish' }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Tasdiqlash' })
    .click();
  await expect(row).toContainText('Faol');
  await noHorizontalScroll(page);

  await page.getByRole('tab', { name: 'Inspeksiyalar' }).click();
  await page.getByRole('button', { name: '+ Yangi inspeksiya' }).click();
  dialog = page.getByRole('dialog');
  await dialog.getByRole('checkbox', { name: 'Xodimlar formasi' }).uncheck();
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText('✗ Xodimlar formasi').first()).toBeVisible();
});
