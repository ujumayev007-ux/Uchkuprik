import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, post } from '../lib/api';
import { formatDateTime, formatMoney } from '../lib/format';

const tr = t.training;
type CellStatus = keyof typeof tr.cellStatus;

type Course = {
  id: string;
  title: string;
  description: string | null;
  content: string | null;
  validityDays: number | null;
  isActive: boolean;
};
type Matrix = {
  courses: { id: string; title: string; validityDays: number | null }[];
  users: {
    userId: string;
    name: string;
    courses: {
      courseId: string;
      completedAt: string | null;
      expiresAt: string | null;
      status: CellStatus;
    }[];
  }[];
  reminders: {
    userId: string;
    name: string;
    course: string;
    expiresAt: string | null;
    status: CellStatus;
  }[];
};

const tone = (status: CellStatus) =>
  status === 'VALID'
    ? 'success'
    : status === 'EXPIRING'
      ? 'warning'
      : status === 'EXPIRED'
        ? 'danger'
        : 'neutral';

function useAction() {
  const toast = useToast();
  const client = useQueryClient();
  return async (run: () => Promise<unknown>) => {
    try {
      await run();
      toast(t.common.saved);
      await client.invalidateQueries({ queryKey: ['training'] });
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    }
  };
}

function MyTraining() {
  const mine = useQuery({
    queryKey: ['training', 'me'],
    queryFn: () =>
      api<{
        records: {
          id: string;
          completedAt: string;
          expiresAt: string | null;
          score: number | null;
          course: { title: string };
        }[];
        now: string;
      }>('/training/me'),
  });
  const courses = useQuery({
    queryKey: ['training', 'courses'],
    queryFn: () =>
      api<{ courses: Course[] }>('/training/courses').then(
        (data) => data.courses,
      ),
  });
  return (
    <div className="stack">
      <section className="card stack">
        <h2 className="section-title">{tr.myCertificates}</h2>
        {mine.data?.records.length === 0 && <p className="muted">—</p>}
        <ul className="ops-list">
          {(mine.data?.records ?? []).map((record) => {
            const expired =
              record.expiresAt !== null &&
              new Date(record.expiresAt) < new Date(mine.data!.now);
            return (
              <li
                key={record.id}
                className={`ops-item ${expired ? 'alarm' : ''}`}
              >
                <div className="grow">
                  <strong>{record.course.title}</strong>
                  <div className="muted small">
                    {formatDateTime(record.completedAt)}
                    {record.score !== null && ` · ${record.score}%`}
                  </div>
                </div>
                <Badge tone={expired ? 'danger' : 'success'}>
                  {record.expiresAt
                    ? `${tr.validUntil} ${record.expiresAt.slice(0, 10)}`
                    : tr.noExpiry}
                </Badge>
              </li>
            );
          })}
        </ul>
      </section>
      <section className="stack">
        <h2 className="section-title">{tr.courses}</h2>
        {(courses.data ?? []).map((course) => (
          <details key={course.id} className="card">
            <summary>
              <strong>{course.title}</strong>
              {course.validityDays && (
                <span className="muted small">
                  {' '}
                  · {tr.validity}: {course.validityDays} {tr.days}
                </span>
              )}
            </summary>
            {course.description && <p>{course.description}</p>}
            {course.content &&
              (/^https:\/\//.test(course.content) ? (
                <a
                  className="text-link"
                  href={course.content}
                  target="_blank"
                  rel="noreferrer"
                >
                  {tr.openMaterial}
                </a>
              ) : (
                <p className="sop-body">{course.content}</p>
              ))}
          </details>
        ))}
      </section>
    </div>
  );
}

function ManageTraining() {
  const action = useAction();
  const [course, setCourse] = useState({
    title: '',
    description: '',
    content: '',
    validityDays: '',
  });
  const [record, setRecord] = useState({ courseId: '', userId: '', score: '' });
  const matrix = useQuery({
    queryKey: ['training', 'matrix'],
    queryFn: () => api<Matrix>('/training/matrix'),
  });
  if (matrix.isPending) return <LoadingState />;
  if (matrix.error)
    return (
      <ErrorState error={matrix.error} onRetry={() => void matrix.refetch()} />
    );
  const data = matrix.data;
  const courseId = record.courseId || data.courses[0]?.id || '';
  const userId = record.userId || data.users[0]?.userId || '';
  return (
    <div className="stack">
      {data.reminders.length > 0 && (
        <section className="card stack">
          <h2 className="section-title">{tr.reminders}</h2>
          <ul className="ops-list">
            {data.reminders.map((row) => (
              <li
                key={`${row.userId}-${row.course}`}
                className="ops-item alarm"
              >
                <div className="grow">
                  <strong>{row.name}</strong> · {row.course}
                </div>
                <Badge tone={tone(row.status)}>
                  {tr.cellStatus[row.status]} {row.expiresAt?.slice(0, 10)}
                </Badge>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="card stack">
        <h2 className="section-title">{tr.matrix}</h2>
        {data.courses.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{tr.employee}</th>
                  {data.courses.map((item) => (
                    <th key={item.id}>{item.title}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.users.map((row) => (
                  <tr key={row.userId}>
                    <td>{row.name}</td>
                    {row.courses.map((cell) => (
                      <td key={cell.courseId}>
                        <Badge tone={tone(cell.status)}>
                          {tr.cellStatus[cell.status]}
                        </Badge>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <form
        className="card form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          await action(() =>
            post('/training/records', {
              courseId,
              userId,
              completedAt: new Date().toISOString(),
              score: record.score === '' ? null : Number(record.score),
            }),
          );
        }}
      >
        <SelectField
          label={tr.course}
          value={courseId}
          onChange={(e) => setRecord({ ...record, courseId: e.target.value })}
        >
          {data.courses.map((item) => (
            <option key={item.id} value={item.id}>
              {item.title}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={tr.employee}
          value={userId}
          onChange={(e) => setRecord({ ...record, userId: e.target.value })}
        >
          {data.users.map((row) => (
            <option key={row.userId} value={row.userId}>
              {row.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={`${tr.score} (${t.common.optional})`}
          inputMode="numeric"
          pattern="\d{1,3}"
          value={record.score}
          onChange={(e) => setRecord({ ...record, score: e.target.value })}
        />
        <div className="form-actions">
          <Button
            type="submit"
            variant="primary"
            disabled={!courseId || !userId}
          >
            {tr.recordCompletion}
          </Button>
        </div>
      </form>
      <form
        className="card form-grid"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await action(() =>
              post('/training/courses', {
                title: course.title,
                description: course.description.trim() || null,
                content: course.content.trim() || null,
                validityDays:
                  course.validityDays === ''
                    ? null
                    : Number(course.validityDays),
              }),
            )
          )
            setCourse({
              title: '',
              description: '',
              content: '',
              validityDays: '',
            });
        }}
      >
        <TextField
          label={tr.courseTitle}
          value={course.title}
          minLength={2}
          onChange={(e) => setCourse({ ...course, title: e.target.value })}
          required
        />
        <TextField
          label={`${tr.description} (${t.common.optional})`}
          value={course.description}
          onChange={(e) =>
            setCourse({ ...course, description: e.target.value })
          }
        />
        <TextField
          label={`${tr.material} (${t.common.optional})`}
          value={course.content}
          onChange={(e) => setCourse({ ...course, content: e.target.value })}
        />
        <TextField
          label={`${tr.validity} (${t.common.optional})`}
          hint={tr.validityHint}
          inputMode="numeric"
          pattern="\d{1,4}"
          value={course.validityDays}
          onChange={(e) =>
            setCourse({ ...course, validityDays: e.target.value })
          }
        />
        <div className="form-actions">
          <Button type="submit">+ {tr.addCourse}</Button>
        </div>
      </form>
    </div>
  );
}

type Approval = {
  id: string;
  type: string;
  amount: number | null;
  reason: string;
  status: string;
  createdAt: string;
};

export function ApprovalsSection() {
  const action = useAction();
  const client = useQueryClient();
  const approvals = useQuery({
    queryKey: ['training', 'approvals'],
    queryFn: () =>
      api<{ approvals: Approval[] }>('/approvals').then(
        (data) => data.approvals,
      ),
  });
  const decide = async (id: string, decision: 'APPROVED' | 'REJECTED') => {
    if (await action(() => post(`/approvals/${id}/decide`, { decision })))
      await client.invalidateQueries({ queryKey: ['assets'] });
  };
  return (
    <section className="card stack">
      <h2 className="section-title">{tr.approvals}</h2>
      {approvals.data?.length === 0 && (
        <p className="muted">{tr.noApprovals}</p>
      )}
      <ul className="ops-list">
        {(approvals.data ?? []).map((row) => (
          <li key={row.id} className="ops-item">
            <div className="grow">
              <strong>
                {(tr.approvalTypes as Record<string, string>)[row.type] ??
                  row.type}
              </strong>
              <div className="small">{row.reason}</div>
              <div className="muted small">{formatDateTime(row.createdAt)}</div>
            </div>
            {row.amount !== null && <strong>{formatMoney(row.amount)}</strong>}
            <Button
              size="sm"
              variant="primary"
              onClick={() => void decide(row.id, 'APPROVED')}
            >
              {tr.approve}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void decide(row.id, 'REJECTED')}
            >
              {tr.reject}
            </Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ApprovalsPage() {
  return (
    <div className="stack">
      <PageHeader title={t.nav.approvals} />
      <ApprovalsSection />
    </div>
  );
}

export function TrainingPage() {
  const { data: me } = useMe();
  return (
    <div className="stack">
      <PageHeader title={tr.title} subtitle={tr.subtitle} />
      {can(me, 'training.manage') ? <ManageTraining /> : null}
      <MyTraining />
    </div>
  );
}
