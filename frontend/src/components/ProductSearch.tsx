import { useId, useMemo, useState } from 'react';
import { t } from '../i18n';
import { matchProducts, normalizeName } from '../lib/product-match';

const s = t.market;

/**
 * Bozorlik product picker for touch screens: type a few letters, tap a product, or add
 * the typed name as a new product. The chosen product shows as a large chip.
 */
export function ProductSearch<T extends { id: string; name: string }>({
  items,
  selectedId,
  newName,
  isNew,
  onPick,
  onNew,
}: {
  items: T[];
  selectedId: string;
  newName: string;
  isNew: boolean;
  onPick: (item: T) => void;
  onNew: (name: string) => void;
}) {
  const id = useId();
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const selected = items.find((item) => item.id === selectedId);
  const matches = useMemo(() => matchProducts(items, query), [items, query]);
  const exact = matches.some(
    (item) => normalizeName(item.name) === normalizeName(query),
  );
  const chosen = isNew ? newName : selected?.name;

  if (chosen && !open)
    return (
      <div className="field product-search">
        <span className="field-label">{s.product}</span>
        <button
          type="button"
          className="product-chip"
          onClick={() => {
            setQuery('');
            setOpen(true);
          }}
          title={s.change}
        >
          <strong>{chosen}</strong>
          {isNew && <span className="badge">{s.newProduct}</span>}
          <span className="product-chip-change">{s.change}</span>
        </button>
      </div>
    );

  return (
    <div className="field product-search">
      <label className="field-label" htmlFor={id}>
        {s.product}
      </label>
      <input
        id={id}
        type="search"
        className="product-search-input"
        placeholder={s.searchPlaceholder}
        autoComplete="off"
        autoFocus={open}
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            const first = matches[0];
            if (first) {
              onPick(first);
              setOpen(false);
            } else if (query.trim()) {
              onNew(query.trim());
              setOpen(false);
            }
          }
          if (event.key === 'Escape') setOpen(false);
        }}
      />
      {open && (
        <ul className="product-search-list" role="listbox">
          {matches.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={item.id === selectedId}
                className="product-search-option"
                onClick={() => {
                  onPick(item);
                  setOpen(false);
                }}
              >
                {item.name}
              </button>
            </li>
          ))}
          {matches.length === 0 && query.trim() && (
            <li className="muted small product-search-empty">{s.noMatches}</li>
          )}
          {query.trim() && !exact && (
            <li>
              <button
                type="button"
                className="product-search-option product-search-new"
                onClick={() => {
                  onNew(query.trim());
                  setOpen(false);
                }}
              >
                + {s.addNamed.replace('{name}', query.trim())}
              </button>
            </li>
          )}
          {chosen && (
            <li>
              <button
                type="button"
                className="product-search-option muted"
                onClick={() => setOpen(false)}
              >
                {t.common.cancel}
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
