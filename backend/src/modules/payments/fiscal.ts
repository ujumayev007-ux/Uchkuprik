import type { Tx } from '../../db.js';

/**
 * Fiscal receipt adapter boundary. Uzbekistan requires receipts to be registered
 * through an online cash register (OFD) operated by a certified provider. That
 * integration needs provider contracts, device certification and credentials, so no
 * adapter is configured: every completed order records NOT_CONFIGURED and receipts
 * are printed as non-fiscal. A certified adapter implements FiscalAdapter and
 * replaces the default without changing order flows.
 */
export type FiscalResult = { fiscalSign: string; qrUrl: string };
export interface FiscalAdapter {
  readonly name: string;
  register(order: {
    id: string;
    total: number;
    items: { name: string; quantity: number; price: number }[];
  }): Promise<FiscalResult>;
}

export const fiscalAdapter: FiscalAdapter | null = null;

export async function recordFiscalReceipt(
  tx: Tx,
  tenantId: string,
  orderId: string,
) {
  await tx.fiscalReceipt.upsert({
    where: { orderId },
    create: {
      tenantId,
      orderId,
      status: fiscalAdapter ? 'PENDING' : 'NOT_CONFIGURED',
      provider: fiscalAdapter?.name ?? null,
    },
    update: {},
  });
}
