import type { Db, Tx } from '../../db.js';
import { AppError, errors } from '../../http/errors.js';
import { canAccessBranch, type AuthContext } from '../auth/session.js';

/**
 * Resolves the branch a request operates on. An explicit branch must belong to the
 * caller's tenant and be within their branch scope; otherwise the session's active
 * branch is used. PIN sessions are always pinned to their device's branch.
 */
export async function resolveBranch(
  db: Db | Tx,
  auth: AuthContext,
  requested?: string | null,
) {
  if (auth.tenantKind !== 'BUSINESS') throw errors.forbidden();
  const branchId =
    auth.authMethod === 'PIN'
      ? auth.activeBranchId
      : (requested ?? auth.activeBranchId);
  if (!branchId) throw new AppError(400, 'BRANCH_REQUIRED', 'branchRequired');
  if (auth.authMethod === 'PIN' && requested && requested !== branchId)
    throw errors.forbidden();
  const branch = await db.branch.findFirst({
    where: { id: branchId, tenantId: auth.tenantId, deletedAt: null },
  });
  if (!branch || !canAccessBranch(auth, branch.id)) throw errors.forbidden();
  return branch;
}
