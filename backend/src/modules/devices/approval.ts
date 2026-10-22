import type { Db, Tx } from '../../db.js';
import { audit } from '../audit/audit.js';

/**
 * A restaurant install (self-hosted) never activates a new terminal by itself: the
 * restaurant Admin registers it, the Owner (SUPER_OWNER) approves or rejects it from the
 * Owner console, and the decision arrives as a signed command of the central server.
 */
export const ownerApprovalRequired = (services: { selfHosted?: boolean }) =>
  services.selfHosted === true;

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
