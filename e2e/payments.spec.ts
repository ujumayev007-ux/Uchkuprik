import { expect, test } from '@playwright/test';
import { openNav, signInOwner, tenant } from './helpers';

const KEY = 'e2e-paycom-key-0001';

test('Payme: owner connects the provider, guest pays, verified callback accepts the order', async ({
  browser,
  page,
  request,
}, info) => {
  test.skip(
    info.project.name !== 'desktop',
    'Provider configuration is tenant-wide; one run is enough.',
  );
  await signInOwner(page);

  // Online ordering must be on for the public storefront.
  await openNav(page, 'Sozlamalar');
  const toggle = page.getByLabel(/onlayn buyurtmani yoqish/);
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await page.getByRole('button', { name: 'Saqlash' }).click();
    await expect(page.getByText('O‘zgarishlar saqlandi.').last()).toBeVisible();
  }

  await openNav(page, 'Onlayn to‘lovlar');
  const card = page.locator('form.card').filter({ hasText: 'Payme' });
  await card.getByLabel('Merchant ID').fill('e2e-merchant');
  await card.getByLabel('Maxfiy kalit').fill(KEY);
  await card.getByRole('button', { name: 'Saqlash' }).click();
  await expect(card.locator('.callback-box code')).toContainText(
    '/api/webhooks/payme/',
  );
  const callbackUrl = (await card
    .locator('.callback-box code')
    .textContent())!.trim();
  // The password field is cleared and never refilled from the server.
  await expect(card.getByLabel('Maxfiy kalit')).toHaveValue('');

  // Guest orders on the website and sees the Payme checkout button.
  const guestContext = await browser.newContext();
  const guest = await guestContext.newPage();
  await guest.goto(`/r/${tenant()}`);
  await guest.getByRole('button', { name: /Kola/ }).click();
  await guest.getByRole('button', { name: /Buyurtmangiz · 1/ }).click();
  await guest.getByLabel('Ismingiz').fill('Mijoz');
  await guest.getByLabel('Telefon raqamingiz').fill('+998 90 765 43 21');
  await guest.getByRole('button', { name: 'Buyurtmani yuborish' }).click();
  const payButton = guest.getByRole('link', { name: 'Payme orqali to‘lash' });
  await expect(payButton).toBeVisible();
  const href = (await payButton.getAttribute('href'))!;
  expect(href).toMatch(/^https:\/\/checkout\.paycom\.uz\//);
  const decoded = Buffer.from(href.split('/').pop()!, 'base64').toString();
  const orderId = /ac\.order_id=([0-9a-f-]{36})/.exec(decoded)![1]!;
  const amount = Number(/;a=(\d+);/.exec(decoded)![1]);

  // Payme's server calls the merchant API (same requests Payme sends in production).
  const path = new URL(callbackUrl).pathname;
  const call = (method: string, params: object) =>
    request.post(`http://127.0.0.1:4000${path}`, {
      headers: {
        Authorization: `Basic ${Buffer.from(`Paycom:${KEY}`).toString('base64')}`,
      },
      data: { jsonrpc: '2.0', id: 1, method, params },
    });
  const txId = `e2e-${Date.now()}`;
  expect(
    (
      await (
        await call('CheckPerformTransaction', {
          amount,
          account: { order_id: orderId },
        })
      ).json()
    ).result.allow,
  ).toBe(true);
  await call('CreateTransaction', {
    id: txId,
    time: Date.now(),
    amount,
    account: { order_id: orderId },
  });
  expect(
    (await (await call('PerformTransaction', { id: txId })).json()).result
      .state,
  ).toBe(2);

  await guest.reload();
  await expect(guest.locator('.track-hint')).toHaveText('Tasdiqlandi');
  await expect(
    guest.getByRole('link', { name: 'Payme orqali to‘lash' }),
  ).toHaveCount(0);
  await guestContext.close();
});
