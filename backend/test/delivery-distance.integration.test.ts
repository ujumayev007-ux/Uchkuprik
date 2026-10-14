import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  distanceMeters,
  parsePoint,
  priceForDistance,
} from '../src/modules/delivery/distance.js';
import { createTenant, createTestContext, login, ORIGIN } from './helpers.js';

const ctx = createTestContext();
afterAll(() => ctx.close());

type Agent = ReturnType<typeof ctx.agent>;
const post = (agent: Agent, path: string, body: object = {}) =>
  agent.post(`/api${path}`).set('Origin', ORIGIN).send(body);
const put = (agent: Agent, path: string, body: object = {}) =>
  agent.put(`/api${path}`).set('Origin', ORIGIN).send(body);

describe('GPS and distance-based delivery fee', () => {
  it('parses points and prices distance', () => {
    expect(
      parsePoint('📍 https://maps.google.com/?q=41.311081,69.240562'),
    ).toEqual({ lat: 41.311081, lng: 69.240562 });
    expect(parsePoint('Chilonzor 5')).toBeNull();
    // About 1.1 km per 0.01° of latitude.
    const meters = distanceMeters(
      { lat: 41.3, lng: 69.24 },
      { lat: 41.31, lng: 69.24 },
    );
    expect(Math.round(meters)).toBeGreaterThan(1100);
    expect(Math.round(meters)).toBeLessThan(1120);
    const pricing = {
      enabled: true,
      baseFee: 5000,
      perKm: 2000,
      minFee: 8000,
      maxKm: 10,
      freeFrom: 200000,
      roadFactor: 1.3,
    };
    expect(priceForDistance(pricing, 3000, 50000)).toBe(11000);
    expect(priceForDistance(pricing, 500, 50000)).toBe(8000);
    expect(priceForDistance(pricing, 3000, 250000)).toBe(0);
  });

  it('sets the customer point and recalculates the order total', async () => {
    const tenant = await createTenant(ctx);
    const owner = ctx.agent();
    await login(owner, tenant.slug, 'owner').expect(200);
    const category = await post(owner, '/menu/categories', {
      name: 'Burgerlar',
    }).expect(201);
    const product = await post(owner, '/menu/products', {
      categoryId: category.body.id,
      name: 'Burger',
      variants: [{ name: 'Standart', price: 40000 }],
    }).expect(201);
    const variant = await ctx.db.productVariant.findFirstOrThrow({
      where: { productId: product.body.id },
    });
    await put(owner, '/delivery/pricing', {
      pricing: {
        enabled: true,
        baseFee: 5000,
        perKm: 2000,
        minFee: 8000,
        maxKm: 5,
        roadFactor: 1,
      },
      branch: { id: tenant.branch.id, lat: 41.3, lng: 69.24 },
    }).expect(200);
    const order = await post(owner, '/orders', {
      idempotencyKey: randomUUID(),
      type: 'DELIVERY',
      customerPhone: '+998901234567',
      deliveryAddress: 'Yunusobod',
      items: [{ variantId: variant.id, quantity: 1 }],
    }).expect(201);
    const priced = await post(
      owner,
      `/orders/${order.body.id}/delivery-location`,
      {
        lat: 41.327,
        lng: 69.24,
      },
    ).expect(200);
    // ~3 km straight: 5 000 + 3 × 2 000, rounded up to 100.
    expect(priced.body.distanceM).toBeGreaterThan(2900);
    expect(priced.body.deliveryFee).toBe(11100);
    expect(priced.body.total).toBe(40000 + 11100);
    await post(owner, `/orders/${order.body.id}/delivery-location`, {
      lat: 41.5,
      lng: 69.24,
    }).expect(400);
  });
});
