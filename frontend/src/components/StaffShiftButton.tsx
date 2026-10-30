import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { t } from '../i18n';
import { api, post } from '../lib/api';
import { useConfirm, useToast } from './ui';

type OpenShift = { id: string; clockIn: string } | null;

const duration = (from: string, to = Date.now()) => {
  const minutes = Math.max(0, Math.floor((to - new Date(from).getTime()) / 60_000));
  return `${Math.floor(minutes / 60)} s ${minutes % 60} d`;
};

/**
 * "Smenani ochish / yopish" for Kassa, Ofitsiant and Oshxona staff. Each person opens
 * and closes only their own shift (the existing attendance records, one open shift per
 * person); signing out or another employee signing in on the same terminal leaves it
 * open. The cashier's cash shift (money count) stays on the "Kassa smenasi" page.
 */
export function StaffShiftButton({ cashier = false }: { cashier?: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const { confirm, element } = useConfirm();
  const [busy, setBusy] = useState(false);
  const [, tick] = useState(0);
  const me = useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: () => api<{ open: OpenShift }>('/attendance/me'),
    staleTime: 30_000,
  });
  const open = me.data?.open ?? null;
  // The time on the button moves on by itself.
  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => tick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [open]);
  if (me.isPending || me.isError) return null;

  const act = async () => {
    if (busy) return;
    if (open) {
      const time = duration(open.clockIn);
      const message = t.staffShift.closeConfirm.replace('{time}', time);
      if (!(await confirm(cashier ? `${message}\n\n${t.staffShift.cashierHint}` : message)))
        return;
    }
    setBusy(true);
    try {
      await post(open ? '/attendance/clock-out' : '/attendance/clock-in');
      toast(
        open
          ? t.staffShift.closed.replace('{time}', duration(open.clockIn))
          : t.staffShift.opened,
      );
    } catch (caught) {
      toast(caught instanceof Error ? caught.message : t.common.errorTitle, 'error');
    } finally {
      setBusy(false);
      await client.invalidateQueries({ queryKey: ['attendance'] });
    }
  };

  return (
    <>
      <button
        type="button"
        className={`btn btn-ghost btn-sm shift-chip ${open ? 'on' : ''}`}
        disabled={busy}
        onClick={() => void act()}
        title={open ? t.staffShift.close : t.staffShift.open}
      >
        {open
          ? `⏱ ${t.staffShift.since.replace('{time}', duration(open.clockIn))} · ${t.staffShift.close}`
          : `▶ ${t.staffShift.open}`}
      </button>
      {element}
    </>
  );
}
