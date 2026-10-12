import { expect, test, type Page } from '@playwright/test';

const tenant = () => process.env.E2E_TENANT!;
const password = () => process.env.E2E_PASSWORD!;
const pin = () => process.env.E2E_PIN!;

async function signIn(page: Page) {
  await page.goto('/kirish');
  await page.getByLabel('Biznes kodi').fill(tenant());
  await page.getByLabel('Login').fill('owner');
  await page.getByLabel('Parol').fill(password());
  await page.getByRole('button', { name: 'Kirish', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: /Xush kelibsiz, Aziz Karimov/ }),
  ).toBeVisible();
}

async function openNav(page: Page, name: string) {
  const toggle = page.getByRole('button', { name: 'Menyuni ochish' });
  if (await toggle.isVisible()) await toggle.click();
  await page
    .getByRole('complementary')
    .getByRole('link', { name, exact: true })
    .click();
}

test('rejects wrong credentials with an Uzbek message', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/kirish$/);
  await page.getByLabel('Biznes kodi').fill(tenant());
  await page.getByLabel('Login').fill('owner');
  await page.getByLabel('Parol').fill('noto-gri-parol-1');
  await page.getByRole('button', { name: 'Kirish', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText(
    'Login yoki parol noto‘g‘ri.',
  );
});

test('owner manages staff, registers a terminal, and a cashier signs in with a PIN', async ({
  page,
}, info) => {
  await signIn(page);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);

  // Staff list shows the seeded cashier with a PIN badge.
  await openNav(page, 'Xodimlar');
  await expect(
    page.getByRole('heading', { name: 'Xodimlar', level: 1 }),
  ).toBeVisible();
  const cashierRow = page.getByRole('row', { name: /Dilnoza Rahimova/ });
  await expect(cashierRow).toContainText('Kassir');
  await expect(cashierRow).toContainText('PIN');

  // Create a waiter through the UI; the fresh login satisfies re-authentication.
  const waiter = `ofitsiant-${info.project.name}`;
  await page.getByRole('button', { name: '+ Xodim qo‘shish' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Login').fill(waiter);
  await dialog.getByLabel('To‘liq ismi').fill(`Sardor ${info.project.name}`);
  await dialog.getByLabel(/PIN-kod/).fill('2580');
  await dialog.getByLabel('Ofitsiant').check();
  await dialog.getByLabel('Barcha filiallarga ruxsat').check();
  await dialog.getByRole('button', { name: 'Saqlash' }).click();
  await expect(page.getByText('Xodim qo‘shildi.')).toBeVisible();
  await expect(
    page.getByRole('row', { name: new RegExp(`Sardor ${info.project.name}`) }),
  ).toBeVisible();

  // Register this browser as the branch terminal.
  await openNav(page, 'Qurilmalar');
  await page
    .getByRole('button', { name: '+ Shu qurilmani ro‘yxatdan o‘tkazish' })
    .click();
  await page
    .getByRole('dialog')
    .getByLabel('Qurilma nomi')
    .fill(`Kassa ${info.project.name}`);
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Shu qurilmani ro‘yxatdan o‘tkazish' })
    .click();
  await expect(page.getByText('Qurilma ro‘yxatdan o‘tkazildi.')).toBeVisible();

  // Audit trail recorded the actions.
  await openNav(page, 'Audit jurnali');
  await expect(
    page.getByRole('cell', { name: /Qurilma ro‘yxatdan o‘tdi/ }).first(),
  ).toBeVisible();
  await expect(
    page.getByRole('cell', { name: /Xodim qo‘shildi/ }).first(),
  ).toBeVisible();

  await page.getByRole('button', { name: 'Chiqish' }).click();
  await expect(page).toHaveURL(/\/kirish$/);

  // PIN terminal: pick the cashier and type the PIN on the touchscreen keypad.
  await page.goto('/pin');
  await page.getByRole('button', { name: /Dilnoza Rahimova/ }).click();
  for (const digit of '0000')
    await page.getByRole('button', { name: digit, exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('PIN-kod noto‘g‘ri.');
  for (const digit of pin())
    await page.getByRole('button', { name: digit, exact: true }).click();
  // Terminal cashiers land on the POS screen.
  await expect(page).toHaveURL(/\/kassa$/);
  await expect(page.getByRole('heading', { name: 'Savat' })).toBeVisible();
  // Cashiers do not see staff administration.
  await expect(
    page.getByRole('link', { name: 'Xodimlar', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: info.outputPath('pin-dashboard.png'),
    fullPage: true,
  });
});
