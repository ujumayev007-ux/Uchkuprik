import { randomBytes } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('notifications: subscriber gets a Telegram link code and event preferences', async ({
  page,
}) => {
  const name = `Menejer ${randomBytes(3).toString('hex')}`;
  await signInOwner(page);
  await openNav(page, 'Bildirishnomalar');
  await expect(page.getByLabel(/Bot tokeni/)).toBeVisible();
  await expect(page.getByLabel(/Bot tokeni/)).toHaveAttribute(
    'type',
    'password',
  );

  await page.getByRole('tab', { name: 'Qabul qiluvchilar' }).click();
  await page.getByRole('button', { name: '+ Qabul qiluvchi qo‘shish' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Nomi', { exact: true }).fill(name);
  await dialog.getByLabel('Smena yopilishi').uncheck();
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  const link = page.getByRole('dialog', { name: 'Telegramni ulash' });
  await expect(link.getByText(/\/start [A-Z0-9]{10}/)).toBeVisible();
  await link.getByRole('button', { name: 'Yopish' }).click();

  const row = page.locator('.ops-item', { hasText: name });
  await expect(row).toContainText('Ulanmagan');
  await expect(row).not.toContainText('Smena yopilishi');
  await noHorizontalScroll(page);

  await page.getByRole('tab', { name: 'Shablonlar' }).click();
  await expect(page.getByLabel('Kunlik moliyaviy hisobot')).toHaveValue(
    /Kunlik hisobot/,
  );
});
