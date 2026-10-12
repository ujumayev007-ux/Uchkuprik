import type { Tx } from '../../db.js';
import { money, notify } from './notify.js';

const severityLabels: Record<string, string> = {
  LOW: 'Past',
  MEDIUM: 'O‘rta',
  HIGH: 'Yuqori',
  CRITICAL: 'Kritik',
};

async function branchName(tx: Tx, branchId: string) {
  const branch = await tx.branch.findUnique({
    where: { id: branchId },
    select: { name: true },
  });
  return branch?.name ?? '';
}

/** High and critical incidents alert subscribers immediately. */
export async function notifyIncident(
  tx: Tx,
  incident: {
    tenantId: string;
    branchId: string;
    severity: string;
    title: string;
    description: string;
  },
) {
  if (incident.severity !== 'HIGH' && incident.severity !== 'CRITICAL') return;
  await notify(
    tx,
    incident.tenantId,
    'incident',
    {
      severity: severityLabels[incident.severity] ?? incident.severity,
      title: incident.title,
      description: incident.description,
      branch: await branchName(tx, incident.branchId),
    },
    incident.branchId,
  );
}

export async function notifyOnlineOrder(
  tx: Tx,
  order: { tenantId: string; branchId: string; number: number; total: number },
) {
  await notify(
    tx,
    order.tenantId,
    'order.online',
    {
      number: order.number,
      total: money(order.total),
      branch: await branchName(tx, order.branchId),
    },
    order.branchId,
  );
}

export async function notifyShiftClosed(
  tx: Tx,
  shift: {
    tenantId: string;
    branchId: string;
    cashier: string;
    expected: number;
    counted: number;
    variance: number;
  },
) {
  await notify(
    tx,
    shift.tenantId,
    'shift.closed',
    {
      branch: await branchName(tx, shift.branchId),
      cashier: shift.cashier,
      expected: money(shift.expected),
      counted: money(shift.counted),
      difference: money(shift.variance),
    },
    shift.branchId,
  );
}
