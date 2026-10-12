import { expect, test } from '@playwright/test';
import { noHorizontalScroll, openNav, signInOwner } from './helpers';

test('analytics: weekday forecast and employee risk signals render for the owner', async ({
  page,
}) => {
  await signInOwner(page);
  await openNav(page, 'Tahlil');
  await expect(
    page.getByRole('heading', { name: 'Keyingi 7 kun prognozi' }),
  ).toBeVisible();
  await expect(page.locator('.ops-item')).toHaveCount(7);
  await expect(
    page.getByRole('heading', { name: 'Xavf signallari' }),
  ).toBeVisible();
  await expect(page.getByLabel('Dan', { exact: true })).toBeVisible();
  await noHorizontalScroll(page);
});
