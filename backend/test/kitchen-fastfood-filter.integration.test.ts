import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { enqueueKitchenTickets } from '../src/printing/queue.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

// Kitchen screens and kitchen tickets show only the «Fast Food» category when the menu
// has it; orders and totals stay complete. Without that category nothing changes.

const ctx = createTestContext();
afterAll(() => ctx.close());
type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);

async function setup(foodCategory: string) {
  const tenant = await createTenant(ctx);
  const owner = ctx.agent();
  await login(owner, tenant.slug, 'owner').expect(200);
  const product = async (category: string, name: string, price: number) => {
    const c = await post(owner, '/menu/categories', { name: category }).expect(
      201,
    );
    const p = await post(owner, '/menu/products', {
      categoryId: c.body.id,
      name,
      variants: [{ name: 'Standart', price }],
    }).expect(201);
    return (
      await ctx.db.productVariant.findFirstOrThrow({
        where: { productId: p.body.id },
      })
    ).id;
  };
  const lavash = await product(foodCategory, 'Lavash', 28000);
  const water = await product('Ichimliklar', 'Suv', 4000);
  const order = (items: { variantId: string; quantity: number }[]) =>
    post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'TAKEAWAY',
      place: true,
      items,
    }).expect(201);
  return { tenant, owner, lavash, water, order };
}

describe('kitchen: «Fast Food» category only', () => {
  it('shows and prints only Fast Food items; totals stay complete', async () => {
    const s = await setup('Fast Food');
    const printer = await ctx.db.printer.create({
      data: {
        tenantId: s.tenant.tenant.id,
        branchId: s.tenant.branch.id,
        name: 'Oshxona',
        kind: 'KITCHEN',
        host: '127.0.0.1',
        port: 9,
      },
    });
    const mixed = await s.order([
      { variantId: s.lavash, quantity: 2 },
      { variantId: s.water, quantity: 1 },
    ]);
    expect(mixed.body.total).toBe(60000);
    expect(mixed.body.items).toHaveLength(2);
    const waterOnly = await s.order([{ variantId: s.water, quantity: 3 }]);

    const tickets = (await s.owner.get('/api/kitchen/tickets').expect(200)).body
      .tickets as { orderId: string; items: { productName: string }[] }[];
    const ticket = tickets.find((t) => t.orderId === mixed.body.id)!;
    expect(ticket.items.map((i) => i.productName)).toEqual(['Lavash']);
    expect(tickets.some((t) => t.orderId === waterOnly.body.id)).toBe(false);

    const filter = (await s.owner.get('/api/kitchen/filter').expect(200)).body;
    expect(filter.variantIds).toEqual([s.lavash]);

    await enqueueKitchenTickets(ctx.services, mixed.body.id);
    await enqueueKitchenTickets(ctx.services, waterOnly.body.id);
    const jobs = await ctx.db.printJob.findMany({
      where: { printerId: printer.id },
    });
    expect(jobs).toHaveLength(1);
    const text = Buffer.from(jobs[0]!.payload).toString('latin1');
    expect(text).toContain('Lavash');
    expect(text).not.toContain('Suv');
  });

  it('keeps every item when the menu has no Fast Food category', async () => {
    const s = await setup('Taomlar');
    const mixed = await s.order([
      { variantId: s.lavash, quantity: 1 },
      { variantId: s.water, quantity: 1 },
    ]);
    const tickets = (await s.owner.get('/api/kitchen/tickets').expect(200)).body
      .tickets as { orderId: string; items: unknown[] }[];
    expect(
      tickets.find((t) => t.orderId === mixed.body.id)!.items,
    ).toHaveLength(2);
    expect(
      (await s.owner.get('/api/kitchen/filter').expect(200)).body.variantIds,
    ).toBeNull();
  });
});
