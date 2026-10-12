import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { t } from '../i18n';
import { errorMessage } from '../lib/api';

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md' | 'lg';
  busy?: boolean;
};

export function Button({
  variant = 'secondary',
  size = 'md',
  busy = false,
  className = '',
  children,
  disabled,
  type = 'button',
  ...rest
}: ButtonProps) {
  return (
    <button
      type={type}
      className={`btn btn-${variant} btn-${size} ${className}`}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <span className="spinner" aria-hidden="true" />}
      {children}
    </button>
  );
}

type FieldProps = {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
  children: (id: string, describedBy?: string) => ReactNode;
};

export function Field({ label, hint, error, children }: FieldProps) {
  const id = useId();
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children(id, describedBy)}
      {error ? (
        <p className="field-error" id={`${id}-error`} role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="field-hint" id={`${id}-hint`}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}

type InputFieldProps = InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  hint?: string | undefined;
  error?: string | undefined;
};

export function TextField({ label, hint, error, ...input }: InputFieldProps) {
  return (
    <Field label={label} hint={hint} error={error}>
      {(id, describedBy) => (
        <input
          id={id}
          aria-describedby={describedBy}
          aria-invalid={!!error || undefined}
          {...input}
        />
      )}
    </Field>
  );
}

type SelectFieldProps = SelectHTMLAttributes<HTMLSelectElement> & {
  label: string;
  hint?: string;
  children: ReactNode;
};

export function SelectField({
  label,
  hint,
  children,
  ...select
}: SelectFieldProps) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <select id={id} aria-describedby={describedBy} {...select}>
          {children}
        </select>
      )}
    </Field>
  );
}

export function Checkbox({
  label,
  checked,
  onChange,
  disabled,
  description,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  description?: string;
}) {
  return (
    <label className={`checkbox ${disabled ? 'is-disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {description && <small>{description}</small>}
      </span>
    </label>
  );
}

export function Dialog({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  wide = false,
}: {
  open: boolean;
  title: string;
  description?: string | undefined;
  onClose: () => void;
  children?: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className={`dialog ${wide ? 'dialog-wide' : ''}`}
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
    >
      {open && (
        <div className="dialog-body">
          <header>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
            <button
              className="icon-button dialog-close"
              onClick={onClose}
              aria-label={t.common.close}
            >
              ×
            </button>
          </header>
          <div className="dialog-content">{children}</div>
          {footer && <footer>{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

export function Badge({
  tone = 'neutral',
  children,
}: {
  tone?: 'neutral' | 'success' | 'warning' | 'danger' | 'accent';
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p>{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function LoadingState() {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner spinner-lg" aria-hidden="true" />
      <p>{t.common.loading}</p>
    </div>
  );
}

export function ErrorState({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry?: () => void;
}) {
  return (
    <div className="state state-error" role="alert">
      <span className="state-icon" aria-hidden="true">
        !
      </span>
      <h3>{t.common.errorTitle}</h3>
      <p>{errorMessage(error)}</p>
      {onRetry && <Button onClick={onRetry}>{t.common.retry}</Button>}
    </div>
  );
}

export function EmptyState({
  title = t.common.emptyTitle,
  children,
}: {
  title?: string;
  children?: ReactNode;
}) {
  return (
    <div className="state">
      <span className="state-icon" aria-hidden="true">
        ◌
      </span>
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <p className="form-error" role="alert">
      {errorMessage(error)}
    </p>
  );
}

// --- Toasts ---------------------------------------------------------------

type Toast = { id: number; message: string; tone: 'success' | 'error' };
const ToastContext = createContext<
  (message: string, tone?: Toast['tone']) => void
>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback(
    (message: string, tone: Toast['tone'] = 'success') => {
      const id = Date.now() + Math.random();
      setToasts((list) => [...list, { id, message, tone }]);
      window.setTimeout(
        () => setToasts((list) => list.filter((toast) => toast.id !== id)),
        4000,
      );
    },
    [],
  );
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);

// --- Confirmation ---------------------------------------------------------

export function useConfirm() {
  const [state, setState] = useState<{
    message: string;
    resolve: (ok: boolean) => void;
  } | null>(null);
  const confirm = (message: string) =>
    new Promise<boolean>((resolve) => setState({ message, resolve }));
  const finish = (ok: boolean) => {
    state?.resolve(ok);
    setState(null);
  };
  const element = (
    <Dialog
      open={state !== null}
      title={t.common.confirm}
      onClose={() => finish(false)}
      footer={
        <>
          <Button onClick={() => finish(false)}>{t.common.cancel}</Button>
          <Button variant="danger" onClick={() => finish(true)}>
            {t.common.confirm}
          </Button>
        </>
      }
    >
      <p>{state?.message}</p>
    </Dialog>
  );
  return { confirm, element };
}

// --- Theme ----------------------------------------------------------------

export function useTheme() {
  const [dark, setDark] = useState(() => {
    try {
      const saved = localStorage.getItem('ff-theme');
      if (saved) return saved === 'dark';
    } catch {
      /* Storage may be unavailable (private mode); fall back to the system theme. */
    }
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem('ff-theme', dark ? 'dark' : 'light');
    } catch {
      /* Non-critical preference. */
    }
  }, [dark]);
  return { dark, toggle: () => setDark((value) => !value) };
}

// --- Money input ------------------------------------------------------------

const group = (value: number) =>
  value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Integer so‘m input; shows grouped digits and returns a number (or null when empty). */
export function MoneyField({
  label,
  value,
  onChange,
  required = false,
  hint,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
  required?: boolean;
  hint?: string;
}) {
  return (
    <Field label={label} hint={hint}>
      {(id, describedBy) => (
        <input
          id={id}
          aria-describedby={describedBy}
          inputMode="numeric"
          className="money-input"
          required={required}
          value={value === null ? '' : group(value)}
          onChange={(event) => {
            const digits = event.target.value.replace(/\D/g, '').slice(0, 10);
            onChange(digits === '' ? null : Number(digits));
          }}
        />
      )}
    </Field>
  );
}
