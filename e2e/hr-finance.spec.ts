import { expect, test } from '@playwright/test';
import { openNav, signInOwner } from './helpers';

test('HR and finance: clock in/out, expense in P&L, pay rate and payroll period', async ({
  page,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Tenant-wide payroll period; one run is enough.',
  );
  await signInOwner(page);

  // Clock in and out from the dashboard card.
  const clockIn = page.getByRole('button', { name: 'Ishga keldim' });
  if (await clockIn.isVisible()) await clockIn.click();
  await expect(page.getByText(/Ishdasiz, boshlangan vaqt/)).toBeVisible();
  await page.getByRole('button', { name: 'Ishdan ketdim' }).click();
  await expect(page.getByText('Hozir ish vaqtida emassiz')).toBeVisible();

  // Expense appears in profit and loss.
  await openNav(page, 'Moliya');
  await page.getByRole('tab', { name: 'Xarajatlar' }).click();
  await page.getByLabel('Turkum').fill('Ijara');
  await page.getByLabel(/To‘lov summasi/).fill('250000');
  await page.getByRole('button', { name: '+ Xarajat qo‘shish' }).click();
  await expect(page.getByRole('row', { name: /Ijara/ })).toContainText(
    '250 000 so‘m',
  );
  await page.getByRole('tab', { name: 'Foyda va zarar' }).click();
  await expect(page.locator('.totals')).toContainText('Xarajatlar: Ijara');
  await expect(
    page.getByRole('link', { name: 'CSV yuklab olish' }),
  ).toHaveAttribute('href', /\/api\/reports\/pnl\.csv/);

  // Pay rate and a payroll period.
  await openNav(page, 'Ish haqi');
  await page.getByRole('tab', { name: 'Stavkalar' }).click();
  await page.getByLabel('To‘lov turi Jasur Kuryer').selectOption('MONTHLY');
  await page
    .getByRole('row', { name: /Jasur Kuryer/ })
    .getByLabel('Stavka')
    .fill('4000000');
  await page
    .getByRole('row', { name: /Jasur Kuryer/ })
    .getByRole('button', { name: 'Saqlash' })
    .click();
  await expect(page.getByText('O‘zgarishlar saqlandi.').last()).toBeVisible();

  await page.getByRole('tab', { name: 'Davrlar' }).click();
  await page.getByRole('button', { name: '+ Yangi davr' }).click();
  const detail = page.getByRole('dialog');
  await expect(detail.getByRole('row', { name: /Jasur Kuryer/ })).toBeVisible();
  await expect(
    detail.getByRole('link', { name: 'Excel (CSV)' }),
  ).toHaveAttribute('href', /export\.csv$/);
  await detail.getByRole('button', { name: 'Tasdiqlash' }).click();
  await expect(detail).toContainText('Tasdiqlangan');
});
