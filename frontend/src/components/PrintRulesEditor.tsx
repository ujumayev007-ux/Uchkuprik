import { useState } from 'react';
import { t } from '../i18n';
import { Badge, Button, Checkbox } from './ui';

const p = t.printRules;
export type ReceiptType = keyof typeof p.types;
export type PrintRule = {
  enabled: boolean;
  copies: number;
  trigger: keyof typeof p.triggers;
  showPrices: boolean;
};
export type PrintRules = Partial<Record<ReceiptType, PrintRule>>;

const KITCHEN_TYPES: ReceiptType[] = [
  'KITCHEN',
  'KEBAB',
  'BAR',
  'MODIFICATION',
  'CANCELLATION',
];
const DEFAULT_RULE: PrintRule = {
  enabled: true,
  copies: 1,
  trigger: 'AUTO',
  showPrices: false,
};

/**
 * Chop etish qoidalari: one row per receipt type. A type gets a rule only once it is
 * changed here; untouched types keep today's printing.
 */
export function PrintRulesEditor({
  rules,
  enforced,
  busy,
  onSave,
}: {
  rules: PrintRules;
  enforced: string[];
  busy?: boolean;
  onSave: (rules: PrintRules) => void;
}) {
  const [draft, setDraft] = useState<PrintRules>(rules);
  const set = (type: ReceiptType, change: Partial<PrintRule>) =>
    setDraft({
      ...draft,
      [type]: { ...DEFAULT_RULE, ...draft[type], ...change },
    });
  return (
    <div className="stack">
      <p className="muted small">{p.hint}</p>
      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>{p.type}</th>
              <th>{p.enabled}</th>
              <th>{p.copies}</th>
              <th>{p.trigger}</th>
              <th>{p.prices}</th>
            </tr>
          </thead>
          <tbody>
            {(Object.keys(p.types) as ReceiptType[]).map((type) => {
              const rule = { ...DEFAULT_RULE, ...draft[type] };
              return (
                <tr key={type}>
                  <td>
                    {p.types[type]}{' '}
                    <Badge
                      tone={enforced.includes(type) ? 'success' : 'neutral'}
                    >
                      {enforced.includes(type) ? p.applied : p.stored}
                    </Badge>
                  </td>
                  <td>
                    <Checkbox
                      label=""
                      checked={rule.enabled}
                      onChange={(enabled) => set(type, { enabled })}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      aria-label={`${p.types[type]}: ${p.copies}`}
                      value={rule.copies}
                      onChange={(event) =>
                        set(type, { copies: Number(event.target.value) })
                      }
                    >
                      {[1, 2, 3, 4, 5].map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <select
                      className="input"
                      aria-label={`${p.types[type]}: ${p.trigger}`}
                      value={rule.trigger}
                      onChange={(event) =>
                        set(type, {
                          trigger: event.target.value as PrintRule['trigger'],
                        })
                      }
                    >
                      {(Object.keys(p.triggers) as PrintRule['trigger'][]).map(
                        (key) => (
                          <option key={key} value={key}>
                            {p.triggers[key]}
                          </option>
                        ),
                      )}
                    </select>
                  </td>
                  <td>
                    {KITCHEN_TYPES.includes(type) && (
                      <Checkbox
                        label=""
                        checked={rule.showPrices}
                        onChange={(showPrices) => set(type, { showPrices })}
                      />
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <div>
        <Button
          variant="primary"
          busy={busy ?? false}
          onClick={() => onSave(draft)}
        >
          {p.save}
        </Button>
      </div>
    </div>
  );
}
