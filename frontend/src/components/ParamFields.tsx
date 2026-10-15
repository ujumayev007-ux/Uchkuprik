import type { ParamDef, ParamValue } from '../lib/owner';

/**
 * Editors for the values next to a feature switch (limits, default modes, volume).
 * An empty value means "not set here": the more general value applies.
 */
export function ParamFields({
  defs,
  values,
  inherited,
  caps,
  disabled = false,
  onChange,
}: {
  defs: ParamDef[];
  values: Record<string, ParamValue>;
  // Shown as the placeholder: what applies when nothing is set at this level.
  inherited?: Record<string, ParamValue>;
  // Largest value a delegated Admin may choose (the Owner's own value).
  caps?: Record<string, ParamValue>;
  disabled?: boolean;
  onChange: (key: string, value: ParamValue | undefined) => void;
}) {
  return (
    <div className="form-grid">
      {defs.map((def) => {
        const current = values[def.key];
        const fallback = inherited?.[def.key] ?? def.default;
        const label = `${def.label}${
          def.type === 'int' && def.unit ? ` (${def.unit})` : ''
        }`;
        if (def.type === 'bool')
          return (
            <label key={def.key} className="field">
              <span className="field-label">{label}</span>
              <select
                disabled={disabled}
                value={current === undefined ? '' : current ? '1' : '0'}
                onChange={(event) =>
                  onChange(
                    def.key,
                    event.target.value === ''
                      ? undefined
                      : event.target.value === '1',
                  )
                }
              >
                <option value="">
                  {fallback ? 'Yoqilgan' : 'O‘chirilgan'} (umumiy)
                </option>
                <option value="1">Yoqilgan</option>
                <option value="0">O‘chirilgan</option>
              </select>
            </label>
          );
        if (def.type === 'enum')
          return (
            <label key={def.key} className="field">
              <span className="field-label">{label}</span>
              <select
                disabled={disabled}
                value={typeof current === 'string' ? current : ''}
                onChange={(event) =>
                  onChange(def.key, event.target.value || undefined)
                }
              >
                <option value="">
                  {def.options.find((option) => option.value === fallback)
                    ?.label ?? ''}{' '}
                  (umumiy)
                </option>
                {def.options.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
          );
        const cap = caps?.[def.key];
        const max = typeof cap === 'number' ? Math.min(def.max, cap) : def.max;
        return (
          <label key={def.key} className="field">
            <span className="field-label">{label}</span>
            <input
              type="number"
              inputMode="numeric"
              disabled={disabled}
              min={def.min}
              max={max}
              placeholder={String(fallback)}
              value={typeof current === 'number' ? current : ''}
              onChange={(event) => {
                const raw = event.target.value;
                if (raw === '') return onChange(def.key, undefined);
                const value = Math.round(Number(raw));
                if (Number.isFinite(value))
                  onChange(def.key, Math.min(max, Math.max(def.min, value)));
              }}
            />
            {def.hint && <small className="muted">{def.hint}</small>}
          </label>
        );
      })}
    </div>
  );
}
