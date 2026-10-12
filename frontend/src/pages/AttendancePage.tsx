import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Dialog,
  EmptyState,
  FormError,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, del, patch, post } from '../lib/api';
import { formatDateTime } from '../lib/format';

type AttendanceRecord = {
  id: string;
  clockIn: string;
  clockOut: string | null;
  note: string | null;
  name?: string;
  minutes?: number | null;
};
const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () =>
  new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
const hours = (minutes: number | null | undefined) =>
  minutes == null ? '—' : `${Math.floor(minutes / 60)} s ${minutes % 60} d`;
const localInput = (iso: string) => {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
    .toISOString()
    .slice(0, 16);
};

/** Clock in/out card, reused on the dashboard. */
export function ClockCard() {
  const client = useQueryClient();
  const toast = useToast();
  const me = useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: () =>
      api<{ open: AttendanceRecord | null; records: AttendanceRecord[] }>(
        '/attendance/me',
      ),
  });
  const act = async (path: string) => {
    try {
      await post(path);
      await client.invalidateQueries({ queryKey: ['attendance'] });
    } catch (caught) {
      toast(
        caught instanceof Error ? caught.message : t.common.errorTitle,
        'error',
      );
    }
  };
  const open = me.data?.open;
  return (
    <section className="card stack">
      <h2>{t.hr.attendanceTitle}</h2>
      <p className="big">
        {open
          ? `${t.hr.onShiftSince}: ${formatDateTime(open.clockIn)}`
          : t.hr.offShift}
      </p>
      {open ? (
        <Button
          variant="danger"
          size="lg"
          onClick={() => void act('/attendance/clock-out')}
        >
          {t.hr.clockOut}
        </Button>
      ) : (
        <Button
          variant="primary"
          size="lg"
          onClick={() => void act('/attendance/clock-in')}
        >
          {t.hr.clockIn}
        </Button>
      )}
    </section>
  );
}

function CorrectionDialog({
  record,
  onClose,
}: {
  record: AttendanceRecord;
  onClose: () => void;
}) {
  const client = useQueryClient();
  const [clockIn, setClockIn] = useState(localInput(record.clockIn));
  const [clockOut, setClockOut] = useState(
    record.clockOut ? localInput(record.clockOut) : '',
  );
  const [note, setNote] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <Dialog
      open
      title={`${t.hr.correct}: ${record.name ?? ''}`}
      onClose={onClose}
    >
      <form
        className="stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            await patch(`/attendance/${record.id}`, {
              clockIn: new Date(clockIn).toISOString(),
              clockOut: clockOut ? new Date(clockOut).toISOString() : null,
              note,
            });
            await client.invalidateQueries({ queryKey: ['attendance'] });
            onClose();
          } catch (caught) {
            setError(caught);
          }
        }}
      >
        <TextField
          label={t.hr.in}
          type="datetime-local"
          value={clockIn}
          onChange={(e) => setClockIn(e.target.value)}
          required
        />
        <TextField
          label={t.hr.out}
          type="datetime-local"
          value={clockOut}
          onChange={(e) => setClockOut(e.target.value)}
        />
        <TextField
          label={t.hr.correctionReason}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          minLength={3}
          required
        />
        <FormError error={error} />
        <Button type="submit" variant="primary">
          {t.common.save}
        </Button>
      </form>
    </Dialog>
  );
}

function Schedule({ manager }: { manager: boolean }) {
  const client = useQueryClient();
  const toast = useToast();
  const from = today();
  const to = new Date(Date.now() + 13 * 86_400_000).toISOString().slice(0, 10);
  const shifts = useQuery({
    queryKey: ['attendance', 'schedule', from],
    queryFn: () =>
      api<{
        shifts: {
          id: string;
          name: string;
          startsAt: string;
          endsAt: string;
          note: string | null;
        }[];
      }>(`/schedule?from=${from}&to=${to}`).then((d) => d.shifts),
  });
  const employees = useQuery({
    queryKey: ['hr', 'employees'],
    queryFn: () =>
      api<{ employees: { userId: string; name: string; status: string }[] }>(
        '/hr/employees',
      ).then((d) => d.employees),
    enabled: manager,
  });
  const [form, setForm] = useState({
    userId: '',
    date: today(),
    start: '09:00',
    end: '18:00',
  });
  return (
    <section className="stack">
      <h2 className="section-title">{t.hr.schedule}</h2>
      {manager && (
        <form
          className="inline-form"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              const startsAt = new Date(`${form.date}T${form.start}`);
              let endsAt = new Date(`${form.date}T${form.end}`);
              if (endsAt <= startsAt)
                endsAt = new Date(endsAt.getTime() + 86_400_000);
              await post('/schedule', {
                userId: form.userId || employees.data?.[0]?.userId,
                startsAt: startsAt.toISOString(),
                endsAt: endsAt.toISOString(),
              });
              await client.invalidateQueries({
                queryKey: ['attendance', 'schedule'],
              });
            } catch (caught) {
              toast(
                caught instanceof Error ? caught.message : t.common.errorTitle,
                'error',
              );
            }
          }}
        >
          <SelectField
            label={t.hr.employee}
            value={form.userId || employees.data?.[0]?.userId || ''}
            onChange={(e) => setForm({ ...form, userId: e.target.value })}
          >
            {(employees.data ?? [])
              .filter((employee) => employee.status === 'ACTIVE')
              .map((employee) => (
                <option key={employee.userId} value={employee.userId}>
                  {employee.name}
                </option>
              ))}
          </SelectField>
          <TextField
            label={t.hr.date}
            type="date"
            value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
          />
          <TextField
            label={t.hr.start}
            type="time"
            value={form.start}
            onChange={(e) => setForm({ ...form, start: e.target.value })}
          />
          <TextField
            label={t.hr.end}
            type="time"
            value={form.end}
            onChange={(e) => setForm({ ...form, end: e.target.value })}
          />
          <Button type="submit" variant="primary">
            + {t.hr.addShift}
          </Button>
        </form>
      )}
      {shifts.data && shifts.data.length > 0 ? (
        <ul className="plain-list">
          {shifts.data.map((shift) => (
            <li key={shift.id} className="track-line card">
              <span>
                <strong>{shift.name}</strong> · {formatDateTime(shift.startsAt)}{' '}
                — {formatDateTime(shift.endsAt)}
              </span>
              {manager && (
                <button
                  className="text-link"
                  onClick={async () => {
                    await del(`/schedule/${shift.id}`);
                    await client.invalidateQueries({
                      queryKey: ['attendance', 'schedule'],
                    });
                  }}
                >
                  {t.common.delete}
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <EmptyState />
      )}
    </section>
  );
}

export function AttendancePage() {
  const { data: me } = useMe();
  const manager = can(me, 'hr.manage');
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const [correcting, setCorrecting] = useState<AttendanceRecord | null>(null);
  const mine = useQuery({
    queryKey: ['attendance', 'me'],
    queryFn: () =>
      api<{ open: AttendanceRecord | null; records: AttendanceRecord[] }>(
        '/attendance/me',
      ),
  });
  const branch = useQuery({
    queryKey: ['attendance', 'branch', from, to],
    queryFn: () =>
      api<{ records: AttendanceRecord[] }>(
        `/attendance?from=${from}&to=${to}`,
      ).then((d) => d.records),
    enabled: manager,
  });
  return (
    <>
      <PageHeader
        title={t.hr.attendanceTitle}
        subtitle={t.hr.attendanceSubtitle}
      />
      <div className="grid-cards">
        <ClockCard />
        <section className="card">
          <h2>{t.hr.myRecords}</h2>
          <ul className="plain-list small">
            {(mine.data?.records ?? []).slice(0, 8).map((record) => (
              <li key={record.id} className="track-line">
                <span>{formatDateTime(record.clockIn)}</span>
                <span>
                  {record.clockOut ? (
                    formatDateTime(record.clockOut)
                  ) : (
                    <Badge tone="success">{t.hr.in}</Badge>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      </div>
      {manager && (
        <>
          <h2 className="section-title">{t.hr.branchRecords}</h2>
          <div className="toolbar">
            <TextField
              label={t.reports.from}
              type="date"
              value={from}
              max={to}
              onChange={(e) => setFrom(e.target.value)}
            />
            <TextField
              label={t.reports.to}
              type="date"
              value={to}
              min={from}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
          {branch.data && branch.data.length > 0 ? (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{t.hr.employee}</th>
                    <th>{t.hr.in}</th>
                    <th>{t.hr.out}</th>
                    <th className="right">{t.hr.duration}</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {branch.data.map((record) => (
                    <tr key={record.id}>
                      <td>
                        {record.name}
                        {record.note && (
                          <small className="muted block">{record.note}</small>
                        )}
                      </td>
                      <td>{formatDateTime(record.clockIn)}</td>
                      <td>
                        {record.clockOut
                          ? formatDateTime(record.clockOut)
                          : '—'}
                      </td>
                      <td className="right">{hours(record.minutes)}</td>
                      <td className="right">
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setCorrecting(record)}
                        >
                          {t.hr.correct}
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState />
          )}
        </>
      )}
      <Schedule manager={manager} />
      {correcting && (
        <CorrectionDialog
          record={correcting}
          onClose={() => setCorrecting(null)}
        />
      )}
    </>
  );
}
