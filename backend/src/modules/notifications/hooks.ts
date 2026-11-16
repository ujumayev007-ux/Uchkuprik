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
    id?: string;
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
    undefined,
    {
      ...(shift.id ? { dedupeKey: `shift.closed:${shift.id}` } : {}),
      financialKeys: ['expected', 'counted', 'difference'],
    },
  );
}

/** «Smena ochildi»: the cash shift of a register was opened. */
export async function notifyShiftOpened(
  tx: Tx,
  shift: {
    id: string;
    tenantId: string;
    branchId: string;
    cashier: string;
    opening: number;
  },
) {
  await notify(
    tx,
    shift.tenantId,
    'shift.opened',
    {
      branch: await branchName(tx, shift.branchId),
      cashier: shift.cashier,
      opening: money(shift.opening),
    },
    shift.branchId,
    undefined,
    { dedupeKey: `shift.opened:${shift.id}`, financialKeys: ['opening'] },
  );
}

/**
 * «Xodim ishga keldi» / «Xodim ishdan ketdi»: from the attendance records (the
 * employee pressed «Ishga keldim / Ketdim»), never from a PIN sign-in or app exit.
 */
export async function notifyAttendance(
  tx: Tx,
  record: {
    id: string;
    tenantId: string;
    branchId: string;
    employee: string;
    clockIn: Date;
    clockOut?: Date | null;
  },
) {
  const out = !!record.clockOut;
  const minutes = out
    ? Math.max(
        0,
        Math.round(
          (record.clockOut!.getTime() - record.clockIn.getTime()) / 60_000,
        ),
      )
    : 0;
  await notify(
    tx,
    record.tenantId,
    out ? 'attendance.out' : 'attendance.in',
    {
      employee: record.employee,
      branch: await branchName(tx, record.branchId),
      worked: `${Math.floor(minutes / 60)} soat ${minutes % 60} daqiqa`,
    },
    record.branchId,
    undefined,
    {
      dedupeKey: `${out ? 'attendance.out' : 'attendance.in'}:${record.id}`,
      now: out ? record.clockOut! : record.clockIn,
    },
  );
}
