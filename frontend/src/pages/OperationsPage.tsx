import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { can, useMe } from '../auth/session';
import {
  Badge,
  Button,
  Checkbox,
  Dialog,
  EmptyState,
  ErrorState,
  Field,
  FormError,
  LoadingState,
  PageHeader,
  SelectField,
  TextField,
  useToast,
} from '../components/ui';
import { t } from '../i18n';
import { api, errorMessage, patch, post, uploadEvidence } from '../lib/api';
import { formatDateTime } from '../lib/format';

const o = t.operations;
type Tab = keyof typeof o.tabs;

type ChecklistItem = { label: string; requiresPhoto: boolean };
type Template = {
  id: string;
  name: string;
  kind: keyof typeof o.kind;
  branchId: string | null;
  items: ChecklistItem[];
  isActive: boolean;
};
type RunResult = ChecklistItem & {
  done: boolean;
  note: string | null;
  evidenceId: string | null;
};
type Run = {
  id: string;
  status: keyof typeof o.runStatus;
  results: RunResult[];
  completedById: string | null;
};

function Loader<T>({
  query,
  children,
}: {
  query: {
    isPending: boolean;
    error: unknown;
    data: T | undefined;
    refetch: () => unknown;
  };
  children: (data: T) => React.ReactNode;
}) {
  if (query.isPending) return <LoadingState />;
  if (query.error || query.data === undefined)
    return (
      <ErrorState error={query.error} onRetry={() => void query.refetch()} />
    );
  return <>{children(query.data)}</>;
}

function useAction() {
  const toast = useToast();
  const client = useQueryClient();
  return async (run: () => Promise<unknown>, done: string = t.common.saved) => {
    try {
      await run();
      toast(done);
      await client.invalidateQueries({ queryKey: ['operations'] });
      return true;
    } catch (caught) {
      toast(errorMessage(caught), 'error');
      return false;
    }
  };
}

function TextArea({
  label,
  value,
  onChange,
  hint,
  rows = 4,
  required,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  hint?: string;
  rows?: number;
  required?: boolean;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <textarea
          id={id}
          aria-describedby={describedBy}
          rows={rows}
          value={value}
          required={required}
          onChange={(event) => onChange(event.target.value)}
        />
      )}
    </Field>
  );
}

/** Camera/file picker that uploads a photo and returns its evidence id. */
function PhotoButton({
  label,
  onUploaded,
}: {
  label: string;
  onUploaded: (id: string) => void;
}) {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  return (
    <label className="btn btn-secondary btn-sm file-button">
      {busy ? t.common.loading : label}
      <input
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        aria-label={label}
        disabled={busy}
        onChange={async (event) => {
          const file = event.target.files?.[0];
          event.target.value = '';
          if (!file) return;
          setBusy(true);
          try {
            onUploaded(await uploadEvidence(file));
          } catch (caught) {
            toast(errorMessage(caught), 'error');
          } finally {
            setBusy(false);
          }
        }}
      />
    </label>
  );
}

// ------------------------------------------------------------------ today

function ChecklistCard({
  template,
  run,
}: {
  template: Template;
  run: Run | null;
}) {
  const { data: me } = useMe();
  const action = useAction();
  const update = (index: number, body: object) =>
    action(
      () => patch(`/operations/checklist-runs/${run!.id}/items/${index}`, body),
      t.common.saved,
    );
  const editable = run?.status === 'IN_PROGRESS';
  return (
    <section className="card stack">
      <div className="toolbar">
        <h3>{template.name}</h3>
        <Badge tone="accent">{o.kind[template.kind]}</Badge>
        <Badge
          tone={
            !run
              ? 'neutral'
              : run.status === 'APPROVED'
                ? 'success'
                : run.status === 'COMPLETED'
                  ? 'accent'
                  : 'warning'
          }
        >
          {run ? o.runStatus[run.status] : o.notStarted}
        </Badge>
      </div>
      {!run ? (
        <div>
          <Button
            variant="primary"
            onClick={() =>
              void action(() =>
                post(`/operations/checklists/${template.id}/start`, {}),
              )
            }
          >
            {o.start}
          </Button>
        </div>
      ) : (
        <>
          <ul className="ops-list">
            {run.results.map((item, index) => (
              <li key={item.label} className="ops-item">
                <div className="grow">
                  <Checkbox
                    label={item.label}
                    checked={item.done}
                    disabled={!editable}
                    description={
                      item.requiresPhoto
                        ? item.evidenceId
                          ? o.photoAttached
                          : o.photoRequired
                        : undefined
                    }
                    onChange={(done) => void update(index, { done })}
                  />
                </div>
                {item.evidenceId && (
                  <a
                    className="text-link small"
                    href={`/api/operations/evidence/${item.evidenceId}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {o.photo}
                  </a>
                )}
                {editable && item.requiresPhoto && (
                  <PhotoButton
                    label={o.addPhoto}
                    onUploaded={(evidenceId) =>
                      void update(index, { done: true, evidenceId })
                    }
                  />
                )}
              </li>
            ))}
          </ul>
          <div className="form-actions">
            {editable && (
              <Button
                variant="primary"
                onClick={() =>
                  void action(() =>
                    post(`/operations/checklist-runs/${run.id}/complete`),
                  )
                }
              >
                {o.complete}
              </Button>
            )}
            {run.status === 'COMPLETED' &&
              can(me, 'operations.manage') &&
              run.completedById !== me?.userId && (
                <Button
                  variant="primary"
                  onClick={() =>
                    void action(() =>
                      post(`/operations/checklist-runs/${run.id}/approve`),
                    )
                  }
                >
                  {o.approve}
                </Button>
              )}
          </div>
        </>
      )}
    </section>
  );
}

function TodayTab() {
  const summary = useQuery({
    queryKey: ['operations', 'summary'],
    queryFn: () =>
      api<{
        checklists: { total: number; done: number };
        openIncidents: number;
        overdueTasks: number;
        temperatureAlarms24h: number;
        expiringBatches: number;
      }>('/operations/summary'),
  });
  const checklists = useQuery({
    queryKey: ['operations', 'checklists'],
    queryFn: () =>
      api<{ checklists: { template: Template; run: Run | null }[] }>(
        '/operations/checklists',
      ).then((data) => data.checklists),
  });
  return (
    <div className="stack">
      {summary.data && (
        <div className="stat-grid">
          {(
            [
              [
                o.summary.checklists,
                `${summary.data.checklists.done} / ${summary.data.checklists.total}`,
              ],
              [o.summary.incidents, summary.data.openIncidents],
              [o.summary.overdue, summary.data.overdueTasks],
              [o.summary.alarms, summary.data.temperatureAlarms24h],
              [o.summary.expiring, summary.data.expiringBatches],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="stat">
              <small className="muted">{label}</small>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      )}
      <Loader query={checklists}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {rows.map(({ template, run }) => (
                <ChecklistCard
                  key={template.id}
                  template={template}
                  run={run}
                />
              ))}
            </>
          )
        }
      </Loader>
    </div>
  );
}

// ----------------------------------------------------------- temperatures

type TemperatureLog = {
  id: string;
  point: string;
  value: string;
  minValue: string;
  maxValue: string;
  outOfRange: boolean;
  recordedAt: string;
  note: string | null;
};

function TemperaturesTab() {
  const toast = useToast();
  const client = useQueryClient();
  const [form, setForm] = useState({
    point: '',
    value: '',
    minValue: '0',
    maxValue: '5',
    note: '',
  });
  const [error, setError] = useState<unknown>(null);
  const logs = useQuery({
    queryKey: ['operations', 'temperatures'],
    queryFn: () =>
      api<{ logs: TemperatureLog[] }>('/operations/temperatures').then(
        (data) => data.logs,
      ),
  });
  const set =
    (key: keyof typeof form) => (event: React.ChangeEvent<HTMLInputElement>) =>
      setForm({ ...form, [key]: event.target.value });
  const num = (value: string) => Number(value.replace(',', '.'));
  return (
    <div className="stack">
      <form
        className="card stack"
        onSubmit={async (event) => {
          event.preventDefault();
          setError(null);
          try {
            const result = await post<{ outOfRange: boolean }>(
              '/operations/temperatures',
              {
                point: form.point,
                value: num(form.value),
                minValue: num(form.minValue),
                maxValue: num(form.maxValue),
                note: form.note.trim() || null,
              },
            );
            toast(
              result.outOfRange ? o.alarmCreated : t.common.saved,
              result.outOfRange ? 'error' : undefined,
            );
            setForm({ ...form, value: '', note: '' });
            await client.invalidateQueries({ queryKey: ['operations'] });
          } catch (caught) {
            setError(caught);
          }
        }}
      >
        <div className="form-grid">
          <TextField
            label={o.point}
            value={form.point}
            onChange={set('point')}
            minLength={2}
            required
          />
          <TextField
            label={o.value}
            inputMode="decimal"
            pattern="-?\d{1,3}([.,]\d)?"
            value={form.value}
            onChange={set('value')}
            required
          />
          <TextField
            label={o.min}
            inputMode="decimal"
            pattern="-?\d{1,3}([.,]\d)?"
            value={form.minValue}
            onChange={set('minValue')}
            required
          />
          <TextField
            label={o.max}
            inputMode="decimal"
            pattern="-?\d{1,3}([.,]\d)?"
            value={form.maxValue}
            onChange={set('maxValue')}
            required
          />
          <TextField
            label={`${o.note} (${t.common.optional})`}
            value={form.note}
            onChange={set('note')}
          />
        </div>
        <FormError error={error} />
        <div className="form-actions">
          <Button type="submit" variant="primary">
            {o.record}
          </Button>
        </div>
      </form>
      <Loader query={logs}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="ops-list">
              {rows.map((log) => (
                <li
                  key={log.id}
                  className={`ops-item ${log.outOfRange ? 'alarm' : ''}`}
                >
                  <div className="grow">
                    <strong>{log.point}</strong>{' '}
                    <span className="muted small">
                      {formatDateTime(log.recordedAt)}
                    </span>
                    {log.note && <div className="small">{log.note}</div>}
                  </div>
                  <strong>{Number(log.value)} °C</strong>
                  <span className="muted small">
                    {Number(log.minValue)}…{Number(log.maxValue)} °C
                  </span>
                  <Badge tone={log.outOfRange ? 'danger' : 'success'}>
                    {log.outOfRange ? o.outOfRange : o.inRange}
                  </Badge>
                </li>
              ))}
            </ul>
          )
        }
      </Loader>
    </div>
  );
}

// -------------------------------------------------------------- incidents

type Incident = {
  id: string;
  type: keyof typeof o.incidentType;
  severity: keyof typeof o.severity;
  title: string;
  description: string;
  status: keyof typeof o.incidentStatus;
  rootCause: string | null;
  correctiveAction: string | null;
  preventiveAction: string | null;
  evidenceIds: string[];
  createdAt: string;
};

function IncidentForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    type: 'FOOD_SAFETY' as keyof typeof o.incidentType,
    severity: 'MEDIUM' as keyof typeof o.severity,
    title: '',
    description: '',
  });
  const [evidenceIds, setEvidenceIds] = useState<string[]>([]);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await post('/operations/incidents', { ...form, evidenceIds });
          onDone();
        } catch (caught) {
          setError(caught);
        } finally {
          setBusy(false);
        }
      }}
    >
      <div className="form-grid">
        <SelectField
          label={o.type}
          value={form.type}
          onChange={(event) =>
            setForm({
              ...form,
              type: event.target.value as keyof typeof o.incidentType,
            })
          }
        >
          {Object.entries(o.incidentType).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
        <SelectField
          label={o.level}
          value={form.severity}
          onChange={(event) =>
            setForm({
              ...form,
              severity: event.target.value as keyof typeof o.severity,
            })
          }
        >
          {Object.entries(o.severity).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
      </div>
      <TextField
        label={o.incidentTitle}
        value={form.title}
        minLength={3}
        onChange={(event) => setForm({ ...form, title: event.target.value })}
        required
      />
      <TextArea
        label={o.description}
        value={form.description}
        onChange={(description) => setForm({ ...form, description })}
        required
      />
      <div className="toolbar">
        <PhotoButton
          label={o.addPhoto}
          onUploaded={(id) => setEvidenceIds([...evidenceIds, id])}
        />
        {evidenceIds.length > 0 && (
          <span className="muted small">
            {o.photoAttached}: {evidenceIds.length}
          </span>
        )}
      </div>
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary" busy={busy}>
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function CapaDialog({
  incident,
  onClose,
}: {
  incident: Incident;
  onClose: () => void;
}) {
  const action = useAction();
  const [form, setForm] = useState({
    rootCause: incident.rootCause ?? '',
    correctiveAction: incident.correctiveAction ?? '',
    preventiveAction: incident.preventiveAction ?? '',
  });
  const next =
    incident.status === 'OPEN'
      ? (['INVESTIGATING', 'RESOLVED'] as const)
      : incident.status === 'INVESTIGATING'
        ? (['RESOLVED'] as const)
        : (['CLOSED'] as const);
  const labels = {
    INVESTIGATING: o.investigate,
    RESOLVED: o.resolve,
    CLOSED: o.close,
  };
  return (
    <Dialog
      open
      wide
      title={incident.title}
      description={incident.description}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>{t.common.cancel}</Button>
          {next.map((status) => (
            <Button
              key={status}
              variant="primary"
              onClick={async () => {
                if (
                  await action(() =>
                    patch(`/operations/incidents/${incident.id}`, {
                      status,
                      ...form,
                    }),
                  )
                )
                  onClose();
              }}
            >
              {labels[status]}
            </Button>
          ))}
        </>
      }
    >
      <div className="stack">
        {incident.evidenceIds.map((id, index) => (
          <a
            key={id}
            className="text-link small"
            href={`/api/operations/evidence/${id}`}
            target="_blank"
            rel="noreferrer"
          >
            {o.photo} {index + 1}
          </a>
        ))}
        <TextArea
          label={o.rootCause}
          rows={2}
          value={form.rootCause}
          onChange={(rootCause) => setForm({ ...form, rootCause })}
        />
        <TextArea
          label={o.corrective}
          rows={2}
          value={form.correctiveAction}
          onChange={(correctiveAction) =>
            setForm({ ...form, correctiveAction })
          }
        />
        <TextArea
          label={o.preventive}
          rows={2}
          value={form.preventiveAction}
          onChange={(preventiveAction) =>
            setForm({ ...form, preventiveAction })
          }
        />
      </div>
    </Dialog>
  );
}

function IncidentsTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const [reporting, setReporting] = useState(false);
  const [selected, setSelected] = useState<Incident | null>(null);
  const incidents = useQuery({
    queryKey: ['operations', 'incidents'],
    queryFn: () =>
      api<{ incidents: Incident[] }>('/operations/incidents').then(
        (data) => data.incidents,
      ),
  });
  const tone = (severity: Incident['severity']) =>
    severity === 'CRITICAL' || severity === 'HIGH'
      ? 'danger'
      : severity === 'MEDIUM'
        ? 'warning'
        : 'neutral';
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => setReporting(true)}>
          + {o.reportIncident}
        </Button>
      </div>
      <Loader query={incidents}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="ops-list">
              {rows.map((incident) => (
                <li key={incident.id} className="ops-item">
                  <div className="grow">
                    <strong>{incident.title}</strong>
                    <div className="muted small">
                      {o.incidentType[incident.type]} ·{' '}
                      {formatDateTime(incident.createdAt)}
                    </div>
                  </div>
                  <Badge tone={tone(incident.severity)}>
                    {o.severity[incident.severity]}
                  </Badge>
                  <Badge
                    tone={
                      incident.status === 'CLOSED'
                        ? 'success'
                        : incident.status === 'RESOLVED'
                          ? 'accent'
                          : 'warning'
                    }
                  >
                    {o.incidentStatus[incident.status]}
                  </Badge>
                  {can(me, 'operations.manage') &&
                    incident.status !== 'CLOSED' && (
                      <Button size="sm" onClick={() => setSelected(incident)}>
                        {t.common.edit}
                      </Button>
                    )}
                </li>
              ))}
            </ul>
          )
        }
      </Loader>
      <Dialog
        open={reporting}
        title={o.reportIncident}
        onClose={() => setReporting(false)}
        wide
      >
        {reporting && (
          <IncidentForm
            onDone={() => {
              setReporting(false);
              void client.invalidateQueries({ queryKey: ['operations'] });
            }}
          />
        )}
      </Dialog>
      {selected && (
        <CapaDialog incident={selected} onClose={() => setSelected(null)} />
      )}
    </div>
  );
}

// ------------------------------------------------------------------ tasks

type Task = {
  id: string;
  title: string;
  description: string | null;
  dueAt: string;
  recurrence: keyof typeof o.recurrence;
  requiresPhoto: boolean;
};

function TaskForm({ onDone }: { onDone: () => void }) {
  const [form, setForm] = useState({
    title: '',
    description: '',
    dueAt: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16),
    recurrence: 'NONE' as keyof typeof o.recurrence,
    requiresPhoto: false,
  });
  const [error, setError] = useState<unknown>(null);
  return (
    <form
      className="stack"
      onSubmit={async (event) => {
        event.preventDefault();
        setError(null);
        try {
          await post('/operations/tasks', {
            ...form,
            description: form.description.trim() || null,
            dueAt: new Date(form.dueAt).toISOString(),
          });
          onDone();
        } catch (caught) {
          setError(caught);
        }
      }}
    >
      <TextField
        label={o.taskTitle}
        value={form.title}
        minLength={2}
        onChange={(event) => setForm({ ...form, title: event.target.value })}
        required
      />
      <TextArea
        label={`${o.description} (${t.common.optional})`}
        rows={2}
        value={form.description}
        onChange={(description) => setForm({ ...form, description })}
      />
      <div className="form-grid">
        <TextField
          label={o.dueAt}
          type="datetime-local"
          value={form.dueAt}
          onChange={(event) => setForm({ ...form, dueAt: event.target.value })}
          required
        />
        <SelectField
          label={o.repeat}
          value={form.recurrence}
          onChange={(event) =>
            setForm({
              ...form,
              recurrence: event.target.value as keyof typeof o.recurrence,
            })
          }
        >
          {Object.entries(o.recurrence).map(([key, label]) => (
            <option key={key} value={key}>
              {label}
            </option>
          ))}
        </SelectField>
      </div>
      <Checkbox
        label={o.requiresPhoto}
        checked={form.requiresPhoto}
        onChange={(requiresPhoto) => setForm({ ...form, requiresPhoto })}
      />
      <FormError error={error} />
      <div className="form-actions">
        <Button type="submit" variant="primary">
          {t.common.save}
        </Button>
      </div>
    </form>
  );
}

function TasksTab() {
  const { data: me } = useMe();
  const client = useQueryClient();
  const action = useAction();
  const [adding, setAdding] = useState(false);
  const tasks = useQuery({
    queryKey: ['operations', 'tasks'],
    queryFn: () => api<{ tasks: Task[]; now: string }>('/operations/tasks'),
  });
  const complete = (task: Task, evidenceId?: string) =>
    action(() =>
      post(`/operations/tasks/${task.id}/complete`, {
        ...(evidenceId ? { evidenceId } : {}),
      }),
    );
  return (
    <div className="stack">
      {can(me, 'operations.manage') && (
        <div className="toolbar">
          <Button variant="primary" onClick={() => setAdding(true)}>
            + {o.addTask}
          </Button>
        </div>
      )}
      <Loader query={tasks}>
        {(data) =>
          data.tasks.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="ops-list">
              {data.tasks.map((task) => {
                const overdue = new Date(task.dueAt) < new Date(data.now);
                return (
                  <li
                    key={task.id}
                    className={`ops-item ${overdue ? 'alarm' : ''}`}
                  >
                    <div className="grow">
                      <strong>{task.title}</strong>
                      <div className="muted small">
                        {formatDateTime(task.dueAt)} ·{' '}
                        {o.recurrence[task.recurrence]}
                        {overdue ? ` · ${o.overdue}` : ''}
                      </div>
                      {task.description && (
                        <div className="small">{task.description}</div>
                      )}
                    </div>
                    {task.requiresPhoto ? (
                      <PhotoButton
                        label={`${o.done} (${o.photo})`}
                        onUploaded={(id) => void complete(task, id)}
                      />
                    ) : (
                      <Button size="sm" onClick={() => void complete(task)}>
                        {o.done}
                      </Button>
                    )}
                  </li>
                );
              })}
            </ul>
          )
        }
      </Loader>
      <Dialog open={adding} title={o.addTask} onClose={() => setAdding(false)}>
        {adding && (
          <TaskForm
            onDone={() => {
              setAdding(false);
              void client.invalidateQueries({ queryKey: ['operations'] });
            }}
          />
        )}
      </Dialog>
    </div>
  );
}

// --------------------------------------------------------------- handovers

type Handover = {
  id: string;
  fromUserId: string;
  fromName: string | null;
  notes: string;
  openIssues: string | null;
  acknowledgedAt: string | null;
  acknowledgedByName: string | null;
  createdAt: string;
};

function HandoversTab() {
  const { data: me } = useMe();
  const action = useAction();
  const [notes, setNotes] = useState('');
  const [openIssues, setOpenIssues] = useState('');
  const handovers = useQuery({
    queryKey: ['operations', 'handovers'],
    queryFn: () =>
      api<{ handovers: Handover[] }>('/operations/handovers').then(
        (data) => data.handovers,
      ),
  });
  return (
    <div className="stack">
      <form
        className="card stack"
        onSubmit={async (event) => {
          event.preventDefault();
          if (
            await action(() =>
              post('/operations/handovers', {
                notes,
                openIssues: openIssues.trim() || null,
              }),
            )
          ) {
            setNotes('');
            setOpenIssues('');
          }
        }}
      >
        <TextArea
          label={o.handoverNotes}
          value={notes}
          onChange={setNotes}
          rows={3}
          required
        />
        <TextArea
          label={`${o.openIssues} (${t.common.optional})`}
          value={openIssues}
          onChange={setOpenIssues}
          rows={2}
        />
        <div className="form-actions">
          <Button type="submit" variant="primary">
            {o.submitHandover}
          </Button>
        </div>
      </form>
      <Loader query={handovers}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="ops-list">
              {rows.map((row) => (
                <li key={row.id} className="ops-item">
                  <div className="grow">
                    <strong>{row.fromName}</strong>{' '}
                    <span className="muted small">
                      {formatDateTime(row.createdAt)}
                    </span>
                    <p className="sop-body">{row.notes}</p>
                    {row.openIssues && (
                      <p className="sop-body small">⚠ {row.openIssues}</p>
                    )}
                  </div>
                  {row.acknowledgedAt ? (
                    <Badge tone="success">
                      {o.acknowledged}: {row.acknowledgedByName}
                    </Badge>
                  ) : row.fromUserId === me?.userId ? (
                    <Badge tone="warning">{o.waiting}</Badge>
                  ) : (
                    <Button
                      size="sm"
                      variant="primary"
                      onClick={() =>
                        void action(() =>
                          post(`/operations/handovers/${row.id}/acknowledge`),
                        )
                      }
                    >
                      {o.acknowledge}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )
        }
      </Loader>
    </div>
  );
}

// ---------------------------------------------------------------- batches

type Batch = {
  id: string;
  lotNumber: string;
  quantity: string;
  expiresAt: string | null;
  receivedAt: string;
  status: keyof typeof o.batchStatus;
  statusReason: string | null;
  stockItem: { name: string; baseUnit: string };
  branch: { name: string };
};

function BatchesTab() {
  const { data: me } = useMe();
  const action = useAction();
  const [lot, setLot] = useState('');
  const [changing, setChanging] = useState<{
    batch: Batch;
    status: Batch['status'];
  } | null>(null);
  const [reason, setReason] = useState('');
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({
    stockItemId: '',
    lotNumber: '',
    expiresAt: '',
    quantity: '',
  });
  const items = useQuery({
    queryKey: ['operations', 'stock-items'],
    queryFn: () =>
      api<{ items: { id: string; name: string }[] }>('/inventory/items').then(
        (data) => data.items,
      ),
    enabled: adding,
  });
  const batches = useQuery({
    queryKey: ['operations', 'batches', lot],
    queryFn: () =>
      api<{ batches: Batch[] }>(
        `/operations/batches${lot ? `?lot=${encodeURIComponent(lot)}` : ''}`,
      ).then((data) => data.batches),
  });
  const transitions: Record<Batch['status'], Batch['status'][]> = {
    ACTIVE: ['QUARANTINED', 'RECALLED', 'DISPOSED'],
    QUARANTINED: ['ACTIVE', 'RECALLED', 'DISPOSED'],
    RECALLED: ['DISPOSED'],
    DISPOSED: [],
  };
  const labels = {
    ACTIVE: o.release,
    QUARANTINED: o.quarantine,
    RECALLED: o.recall,
    DISPOSED: o.dispose,
  };
  const stockItemId = form.stockItemId || items.data?.[0]?.id || '';
  return (
    <div className="stack">
      <div className="toolbar">
        <TextField
          label={o.searchLot}
          value={lot}
          onChange={(event) => setLot(event.target.value.trim())}
        />
        <Button variant="primary" onClick={() => setAdding(true)}>
          + {o.addBatch}
        </Button>
      </div>
      <Loader query={batches}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="ops-list">
              {rows.map((batch) => (
                <li
                  key={batch.id}
                  className={`ops-item ${batch.status === 'ACTIVE' ? '' : 'alarm'}`}
                >
                  <div className="grow">
                    <strong>{batch.stockItem.name}</strong> · {batch.lotNumber}
                    <div className="muted small">
                      {batch.branch.name} · {Number(batch.quantity)}{' '}
                      {batch.stockItem.baseUnit} · {o.expires}:{' '}
                      {batch.expiresAt ? batch.expiresAt.slice(0, 10) : '—'}
                    </div>
                    {batch.statusReason && (
                      <div className="small">{batch.statusReason}</div>
                    )}
                  </div>
                  <Badge
                    tone={batch.status === 'ACTIVE' ? 'success' : 'danger'}
                  >
                    {o.batchStatus[batch.status]}
                  </Badge>
                  {can(me, 'operations.manage') &&
                    transitions[batch.status].map((status) => (
                      <Button
                        key={status}
                        size="sm"
                        variant={status === 'ACTIVE' ? 'secondary' : 'ghost'}
                        onClick={() => {
                          setReason('');
                          setChanging({ batch, status });
                        }}
                      >
                        {labels[status]}
                      </Button>
                    ))}
                </li>
              ))}
            </ul>
          )
        }
      </Loader>
      <Dialog
        open={changing !== null}
        title={
          changing
            ? `${labels[changing.status]}: ${changing.batch.lotNumber}`
            : ''
        }
        onClose={() => setChanging(null)}
        footer={
          <>
            <Button onClick={() => setChanging(null)}>{t.common.cancel}</Button>
            <Button
              variant="danger"
              disabled={reason.trim().length < 3}
              onClick={async () => {
                const { batch, status } = changing!;
                if (
                  await action(() =>
                    post(`/operations/batches/${batch.id}/status`, {
                      status,
                      reason,
                    }),
                  )
                )
                  setChanging(null);
              }}
            >
              {t.common.confirm}
            </Button>
          </>
        }
      >
        <TextField
          label={o.reason}
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </Dialog>
      <Dialog open={adding} title={o.addBatch} onClose={() => setAdding(false)}>
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            if (
              await action(() =>
                post('/operations/batches', {
                  stockItemId,
                  lotNumber: form.lotNumber,
                  expiresAt: form.expiresAt || null,
                  quantity: Number(form.quantity.replace(',', '.')),
                }),
              )
            ) {
              setAdding(false);
              setForm({
                stockItemId: '',
                lotNumber: '',
                expiresAt: '',
                quantity: '',
              });
            }
          }}
        >
          <SelectField
            label={o.stockItem}
            value={stockItemId}
            onChange={(event) =>
              setForm({ ...form, stockItemId: event.target.value })
            }
          >
            {(items.data ?? []).map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label={o.lot}
            value={form.lotNumber}
            onChange={(event) =>
              setForm({ ...form, lotNumber: event.target.value })
            }
            required
          />
          <TextField
            label={`${o.expires} (${t.common.optional})`}
            type="date"
            value={form.expiresAt}
            onChange={(event) =>
              setForm({ ...form, expiresAt: event.target.value })
            }
          />
          <TextField
            label={o.quantity}
            inputMode="decimal"
            pattern="\d+([.,]\d{1,3})?"
            value={form.quantity}
            onChange={(event) =>
              setForm({ ...form, quantity: event.target.value })
            }
            required
          />
          <div className="form-actions">
            <Button type="submit" variant="primary" disabled={!stockItemId}>
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

// ------------------------------------------------------------------- SOPs

type Sop = {
  id: string;
  title: string;
  category: string;
  body: string;
  version: number;
  isActive: boolean;
};

function SopsTab() {
  const { data: me } = useMe();
  const action = useAction();
  const [editing, setEditing] = useState<Sop | 'new' | null>(null);
  const [form, setForm] = useState({ title: '', category: '', body: '' });
  const sops = useQuery({
    queryKey: ['operations', 'sops'],
    queryFn: () =>
      api<{ sops: Sop[] }>('/operations/sops').then((data) => data.sops),
  });
  const open = (sop: Sop | 'new') => {
    setForm(
      sop === 'new'
        ? { title: '', category: '', body: '' }
        : { title: sop.title, category: sop.category, body: sop.body },
    );
    setEditing(sop);
  };
  return (
    <div className="stack">
      {can(me, 'operations.manage') && (
        <div className="toolbar">
          <Button variant="primary" onClick={() => open('new')}>
            + {o.addSop}
          </Button>
        </div>
      )}
      <Loader query={sops}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <>
              {rows.map((sop) => (
                <details key={sop.id} className="card">
                  <summary>
                    <strong>{sop.title}</strong>{' '}
                    <span className="muted small">
                      {sop.category} · {o.version} {sop.version}
                    </span>
                  </summary>
                  <p className="sop-body">{sop.body}</p>
                  {can(me, 'operations.manage') && (
                    <Button size="sm" onClick={() => open(sop)}>
                      {t.common.edit}
                    </Button>
                  )}
                </details>
              ))}
            </>
          )
        }
      </Loader>
      <Dialog
        open={editing !== null}
        title={o.addSop}
        onClose={() => setEditing(null)}
        wide
      >
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const body = { ...form, isActive: true };
            if (
              await action(() =>
                editing === 'new' || !editing
                  ? post('/operations/sops', body)
                  : api(`/operations/sops/${editing.id}`, {
                      method: 'PUT',
                      body,
                    }),
              )
            )
              setEditing(null);
          }}
        >
          <div className="form-grid">
            <TextField
              label={t.common.name}
              value={form.title}
              minLength={2}
              onChange={(event) =>
                setForm({ ...form, title: event.target.value })
              }
              required
            />
            <TextField
              label={o.category}
              value={form.category}
              minLength={2}
              onChange={(event) =>
                setForm({ ...form, category: event.target.value })
              }
              required
            />
          </div>
          <TextArea
            label={o.body}
            rows={10}
            value={form.body}
            onChange={(body) => setForm({ ...form, body })}
            required
          />
          <div className="form-actions">
            <Button type="submit" variant="primary">
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

// -------------------------------------------------------------- allergens

function AllergensTab() {
  const matrix = useQuery({
    queryKey: ['operations', 'allergens'],
    queryFn: () =>
      api<{
        allergens: string[];
        products: { id: string; name: string; allergens: string[] }[];
      }>('/operations/allergens'),
  });
  return (
    <Loader query={matrix}>
      {(data) =>
        data.allergens.length === 0 ? (
          <p className="muted">{o.noAllergens}</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>{o.product}</th>
                  {data.allergens.map((allergen) => (
                    <th key={allergen} className="center">
                      {allergen}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.products
                  .filter((product) => product.allergens.length > 0)
                  .map((product) => (
                    <tr key={product.id}>
                      <td>{product.name}</td>
                      {data.allergens.map((allergen) => (
                        <td key={allergen} className="center">
                          {product.allergens.includes(allergen) ? '●' : ''}
                        </td>
                      ))}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )
      }
    </Loader>
  );
}

// -------------------------------------------------------------- templates

function TemplatesTab() {
  const action = useAction();
  const [editing, setEditing] = useState<Template | 'new' | null>(null);
  const [form, setForm] = useState({
    name: '',
    kind: 'OPENING' as Template['kind'],
    items: '',
    isActive: true,
  });
  const templates = useQuery({
    queryKey: ['operations', 'templates'],
    queryFn: () =>
      api<{ templates: Template[] }>('/operations/checklist-templates').then(
        (data) => data.templates,
      ),
  });
  const marker = '[rasm]';
  const open = (template: Template | 'new') => {
    setForm(
      template === 'new'
        ? { name: '', kind: 'OPENING', items: '', isActive: true }
        : {
            name: template.name,
            kind: template.kind,
            items: template.items
              .map((item) =>
                item.requiresPhoto ? `${item.label} ${marker}` : item.label,
              )
              .join('\n'),
            isActive: template.isActive,
          },
    );
    setEditing(template);
  };
  return (
    <div className="stack">
      <div className="toolbar">
        <Button variant="primary" onClick={() => open('new')}>
          + {o.addTemplate}
        </Button>
      </div>
      <Loader query={templates}>
        {(rows) =>
          rows.length === 0 ? (
            <EmptyState />
          ) : (
            <ul className="ops-list">
              {rows.map((template) => (
                <li key={template.id} className="ops-item">
                  <div className="grow">
                    <strong>{template.name}</strong>
                    <div className="muted small">
                      {o.kind[template.kind]} · {o.items}:{' '}
                      {template.items.length}
                    </div>
                  </div>
                  {!template.isActive && <Badge>{t.common.inactive}</Badge>}
                  <Button size="sm" onClick={() => open(template)}>
                    {t.common.edit}
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </Loader>
      <Dialog
        open={editing !== null}
        title={o.addTemplate}
        onClose={() => setEditing(null)}
        wide
      >
        <form
          className="stack"
          onSubmit={async (event) => {
            event.preventDefault();
            const body = {
              name: form.name,
              kind: form.kind,
              isActive: form.isActive,
              items: form.items
                .split('\n')
                .map((line) => line.trim())
                .filter(Boolean)
                .map((line) => ({
                  label: line.replace(marker, '').trim(),
                  requiresPhoto: line.includes(marker),
                })),
            };
            if (
              await action(() =>
                editing === 'new' || !editing
                  ? post('/operations/checklist-templates', body)
                  : api(`/operations/checklist-templates/${editing.id}`, {
                      method: 'PUT',
                      body,
                    }),
              )
            )
              setEditing(null);
          }}
        >
          <div className="form-grid">
            <TextField
              label={t.common.name}
              value={form.name}
              minLength={2}
              onChange={(event) =>
                setForm({ ...form, name: event.target.value })
              }
              required
            />
            <SelectField
              label={o.type}
              value={form.kind}
              onChange={(event) =>
                setForm({
                  ...form,
                  kind: event.target.value as Template['kind'],
                })
              }
            >
              {Object.entries(o.kind).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </SelectField>
          </div>
          <TextArea
            label={o.items}
            hint={o.itemsHint}
            rows={8}
            value={form.items}
            onChange={(items) => setForm({ ...form, items })}
            required
          />
          <Checkbox
            label={t.common.active}
            checked={form.isActive}
            onChange={(isActive) => setForm({ ...form, isActive })}
          />
          <div className="form-actions">
            <Button type="submit" variant="primary">
              {t.common.save}
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

export function OperationsPage() {
  const { data: me } = useMe();
  const [tab, setTab] = useState<Tab>('today');
  const tabs = (Object.keys(o.tabs) as Tab[]).filter(
    (key) => key !== 'templates' || can(me, 'operations.manage'),
  );
  return (
    <>
      <PageHeader title={o.title} subtitle={o.subtitle} />
      <div className="tabs" role="tablist">
        {tabs.map((key) => (
          <button
            key={key}
            role="tab"
            aria-selected={tab === key}
            className={`tab ${tab === key ? 'active' : ''}`}
            onClick={() => setTab(key)}
          >
            {o.tabs[key]}
          </button>
        ))}
      </div>
      {tab === 'today' && <TodayTab />}
      {tab === 'temperatures' && <TemperaturesTab />}
      {tab === 'incidents' && <IncidentsTab />}
      {tab === 'tasks' && <TasksTab />}
      {tab === 'handovers' && <HandoversTab />}
      {tab === 'batches' && <BatchesTab />}
      {tab === 'sops' && <SopsTab />}
      {tab === 'allergens' && <AllergensTab />}
      {tab === 'templates' && <TemplatesTab />}
    </>
  );
}
