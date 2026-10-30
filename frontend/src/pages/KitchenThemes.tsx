import { Button, Dialog } from '../components/ui';
import { t } from '../i18n';
import { KITCHEN_THEMES, type KitchenTheme } from '../lib/ordering';

const text = t.kitchenTheme;

/** A small drawing of the design: how cards and columns sit on the screen. */
function ThemePreview({ theme }: { theme: KitchenTheme }) {
  const cards = theme === 'compact' ? 6 : theme === 'minimal' ? 2 : 3;
  return (
    <div className={`theme-preview preview-${theme}`} aria-hidden="true">
      {theme === 'smart' && <div className="preview-stats" />}
      <div className="preview-cards">
        {Array.from({ length: cards }, (_, index) => (
          <div key={index} className="preview-card">
            <b>{index + 12}</b>
            {theme === 'smart' && <i />}
          </div>
        ))}
      </div>
    </div>
  );
}

/** "Sozlamalar → Ko‘rinish va dizayn": six designs, one tap applies one. */
export function KitchenThemeDialog({
  theme,
  previous,
  onChange,
  onClose,
}: {
  theme: KitchenTheme;
  previous: KitchenTheme | null;
  onChange: (theme: KitchenTheme) => void;
  onClose: () => void;
}) {
  return (
    <Dialog
      open
      wide
      title={text.title}
      description={text.hint}
      onClose={onClose}
      footer={
        previous && previous !== theme ? (
          <Button onClick={() => onChange(previous)}>
            ↩ {text.back}: {text.names[previous]}
          </Button>
        ) : undefined
      }
    >
      <div className="theme-grid">
        {KITCHEN_THEMES.map((item) => (
          <button
            key={item}
            type="button"
            className={`theme-option ${item === theme ? 'active' : ''}`}
            aria-pressed={item === theme}
            onClick={() => onChange(item)}
          >
            <ThemePreview theme={item} />
            <strong>
              {text.names[item]}
              {item === theme && <span className="theme-current"> ✓ {text.current}</span>}
            </strong>
            <small className="muted">{text.about[item]}</small>
          </button>
        ))}
      </div>
    </Dialog>
  );
}

type StatTicket = {
  stage: 'NEW' | 'ACCEPTED' | 'PREPARING' | 'READY' | 'REJECTED';
  placedAt: string;
  limitMs: number;
};

/** "Aqlli oshxona": what the kitchen is doing now, from the tickets on screen. */
export function KitchenStats({
  tickets,
  now,
}: {
  tickets: StatTicket[];
  now: number;
}) {
  const active = tickets.filter(
    (ticket) => ticket.stage !== 'READY' && ticket.stage !== 'REJECTED',
  );
  const ages = active.map((ticket) => now - new Date(ticket.placedAt).getTime());
  const late = active.filter(
    (ticket, index) => (ages[index] ?? 0) > ticket.limitMs,
  ).length;
  const minutes = (ms: number) => {
    const total = Math.max(0, Math.round(ms / 60_000));
    return total < 60
      ? text.minutes.replace('{n}', String(total))
      : text.hours
          .replace('{h}', String(Math.floor(total / 60)))
          .replace('{m}', String(total % 60));
  };
  const average = ages.length
    ? ages.reduce((sum, age) => sum + age, 0) / ages.length
    : 0;
  const stats: [string, string, string][] = [
    [text.statsActive, String(active.length), ''],
    [
      text.statsNew,
      String(tickets.filter((ticket) => ticket.stage === 'NEW').length),
      'stat-new',
    ],
    [text.statsLate, String(late), late ? 'stat-late' : ''],
    [text.statsAvg, minutes(average), ''],
    [text.statsOldest, minutes(ages.length ? Math.max(...ages) : 0), ''],
    [
      text.statsReady,
      String(tickets.filter((ticket) => ticket.stage === 'READY').length),
      'stat-ready',
    ],
  ];
  return (
    <div className="kds-stats" role="status">
      {stats.map(([label, value, tone]) => (
        <div key={label} className={`kds-stat ${tone}`}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}
