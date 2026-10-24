import type { Db, Tx } from '../../db.js';
import { audit } from '../audit/audit.js';

/**
 * Local terminals registered on LAN do not require manual Owner approval.
 * Owner licensing limits (assertWithinLimit) govern the maximum terminal count.
 */
export const ownerApprovalRequired = (_services: { selfHosted?: boolean }) =>
  false;

/** Applies the Owner's decision for one pending terminal of this install. */
export async function applyOwnerDecision(
  db: Db | Tx,
  command: { id: string; localId?: string; approve?: boolean },
  at: Date,
) {
  if (!command.localId) return false;
  const device = await db.device.findFirst({
    where: { id: command.localId, status: 'PENDING' },
  });
  if (!device) return false;
  await db.device.update({
    where: { id: device.id },
    data: command.approve
      ? { status: 'ACTIVE' }
      : { status: 'REVOKED', revokedAt: at },
  });
  await audit(db, null, {
    tenantId: device.tenantId,
    branchId: device.branchId,
    action: command.approve ? 'device.owner_approve' : 'device.owner_reject',
    entityType: 'device',
    entityId: device.id,
    data: { by: 'owner', commandId: command.id, name: device.name },
  });
  return true;
}
