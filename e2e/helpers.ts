import { expect, type Page } from '@playwright/test';

export const tenant = () => process.env.E2E_TENANT!;
export const password = () => process.env.E2E_PASSWORD!;
export const pin = () => process.env.E2E_PIN!;

export async function signInOwner(page: Page) {
  await page.goto('/kirish');
  await page.getByLabel('Biznes kodi').fill(tenant());
  await page.getByLabel('Login').fill('owner');
  await page.getByLabel('Parol').fill(password());
  await page.getByRole('button', { name: 'Kirish', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /Xush kelibsiz, Aziz Karimov/ }),
  ).toBeVisible();
}

export async function openNav(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: 'Menyuni ochish' });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('complementary')
    .getByRole('link', { name, exact: true })
    .click();
}

export async function noHorizontalScroll(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
}
