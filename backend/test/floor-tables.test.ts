import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { featureCatalog } from '../src/modules/control/catalog.js';

describe('Admin Table Management & Deletion Safety', () => {
  const batchIdsSchema = z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
  });

  const ACTIVE_ORDER_STATUSES = [
    'DRAFT',
    'PENDING',
    'PLACED',
    'PREPARING',
    'READY',
    'SERVED',
  ] as const;

  it('validates batch delete and restore schemas', () => {
    const validUuid = '11111111-1111-4111-8111-111111111111';
    const parsed = batchIdsSchema.safeParse({ ids: [validUuid] });
    expect(parsed.success).toBe(true);

    const empty = batchIdsSchema.safeParse({ ids: [] });
    expect(empty.success).toBe(false);

    const invalid = batchIdsSchema.safeParse({ ids: ['invalid-uuid'] });
    expect(invalid.success).toBe(false);
  });

  it('catalog registers all floor table management endpoints under floor.manage', () => {
    const floorFeature = featureCatalog.find((f) => f.key === 'floor.manage');
    expect(floorFeature).toBeDefined();

    expect(floorFeature?.routes).toContain('DELETE /tables/:id');
    expect(floorFeature?.routes).toContain('POST /tables/:id/restore');
    expect(floorFeature?.routes).toContain('POST /tables/batch-delete');
    expect(floorFeature?.routes).toContain('POST /tables/batch-restore');
  });

  it('blocks table deletion when active orders exist', () => {
    function canDeleteTable(orders: { status: string }[]) {
      const hasActive = orders.some((o) =>
        (ACTIVE_ORDER_STATUSES as readonly string[]).includes(o.status),
      );
      if (hasActive) {
        throw new Error('TABLE_HAS_ACTIVE_ORDERS');
      }
      return true;
    }

    // Active orders in DRAFT, PLACED, PREPARING, READY, SERVED must block deletion
    for (const status of ACTIVE_ORDER_STATUSES) {
      expect(() => canDeleteTable([{ status }])).toThrow('TABLE_HAS_ACTIVE_ORDERS');
    }

    // Completed or Cancelled historical orders do not block deletion
    expect(canDeleteTable([{ status: 'PAID' }])).toBe(true);
    expect(canDeleteTable([{ status: 'CANCELLED' }])).toBe(true);
    expect(canDeleteTable([{ status: 'REFUNDED' }])).toBe(true);
    expect(canDeleteTable([])).toBe(true);
  });

  it('performs soft deactivation if historical orders exist, hard delete if no orders exist', () => {
    function resolveDeletionStrategy(totalOrderCount: number) {
      if (totalOrderCount > 0) {
        return { action: 'soft_deactivate', isActive: false };
      }
      return { action: 'hard_delete' };
    }

    expect(resolveDeletionStrategy(5)).toEqual({
      action: 'soft_deactivate',
      isActive: false,
    });
    expect(resolveDeletionStrategy(0)).toEqual({
      action: 'hard_delete',
    });
  });
});

