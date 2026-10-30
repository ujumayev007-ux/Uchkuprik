import { useReducer, useState } from 'react';
import { t } from '../i18n';
import { Dialog, useToast } from './ui';

type Operator = '+' | '−' | '×' | '÷';
const OPERATORS: Operator[] = ['+', '−', '×', '÷'];
const isOperator = (token: string): token is Operator =>
  (OPERATORS as string[]).includes(token);

/** × and ÷ before + and − ; null when the expression can not be computed (÷ 0). */
export function evaluate(tokens: string[]): number | null {
  const items = [...tokens];
  if (items.length && isOperator(items[items.length - 1]!)) items.pop();
  if (!items.length) return 0;
  const numbers: number[] = [Number(items[0])];
  const pending: Operator[] = [];
  for (let i = 1; i < items.length; i += 2) {
    const operator = items[i] as Operator;
    const value = Number(items[i + 1]);
    if (operator === '×') numbers.push(numbers.pop()! * value);
    else if (operator === '÷') {
      if (value === 0) return null;
      numbers.push(numbers.pop()! / value);
    } else {
      numbers.push(value);
      pending.push(operator);
    }
  }
  let result = numbers[0]!;
  pending.forEach((operator, index) => {
    const value = numbers[index + 1]!;
    result = operator === '+' ? result + value : result - value;
  });
  return Number.isFinite(result) ? Math.round(result * 1e8) / 1e8 : null;
}

type CalcState = { tokens: string[]; result: string | null };

/** One key press: digits, ".", operators, "=", "C" (clear) and "⌫" (delete). */
export function calculate(state: CalcState, key: string): CalcState {
  const { tokens, result } = state;
  const last = tokens[tokens.length - 1];
  if (key === 'C') return { tokens: [], result: null };
  if (key === '=') {
    const value = evaluate(tokens);
    return { tokens, result: value === null ? t.calc.error : String(value) };
  }
  if (key === '⌫') {
    if (result !== null) return { tokens, result: null };
    if (!last) return state;
    return {
      tokens:
        isOperator(last) || last.length === 1
          ? tokens.slice(0, -1)
          : [...tokens.slice(0, -1), last.slice(0, -1)],
      result: null,
    };
  }
  if (isOperator(key)) {
    // An operator after a result goes on from that result.
    if (result !== null && result !== t.calc.error)
      return { tokens: [result, key], result: null };
    if (!last) return state;
    return {
      tokens: isOperator(last)
        ? [...tokens.slice(0, -1), key]
        : [...tokens, key],
      result: null,
    };
  }
  // A digit or the decimal point after a result starts a new calculation.
  const base = result !== null ? [] : tokens;
  const current = base[base.length - 1];
  if (current !== undefined && !isOperator(current)) {
    if (key === '.' && current.includes('.')) return state;
    const next = current === '0' && key !== '.' ? key : current + key;
    if (next.replace('.', '').length > 12) return state;
    return { tokens: [...base.slice(0, -1), next], result: null };
  }
  return { tokens: [...base, key === '.' ? '0.' : key], result: null };
}

async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    // Plain-HTTP pages and Android WebViews may have no clipboard API.
  }
  const area = document.createElement('textarea');
  area.value = text;
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.appendChild(area);
  area.select();
  document.execCommand('copy');
  area.remove();
}

/**
 * The waiter's calculator. It opens over the current screen, so the table, the order
 * and the cart under it stay exactly as they were.
 */
export function CalculatorButton() {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  // Every key works on the latest state, so quick taps are never lost.
  const [{ tokens, result }, dispatch] = useReducer(calculate, {
    tokens: [],
    result: null,
  });
  const press = (key: string) => () => dispatch(key);
  const shown = result ?? (tokens.length ? tokens.join(' ') : '0');

  const keys: [string, () => void, string?][] = [
    [t.calc.clear, press('C'), 'calc-key-muted'],
    ['⌫', press('⌫'), 'calc-key-muted'],
    ['÷', press('÷'), 'calc-key-op'],
    ['×', press('×'), 'calc-key-op'],
    ['7', press('7')],
    ['8', press('8')],
    ['9', press('9')],
    ['−', press('−'), 'calc-key-op'],
    ['4', press('4')],
    ['5', press('5')],
    ['6', press('6')],
    ['+', press('+'), 'calc-key-op'],
    ['1', press('1')],
    ['2', press('2')],
    ['3', press('3')],
    ['=', press('='), 'calc-key-equals'],
    ['0', press('0'), 'calc-key-wide'],
    ['.', press('.')],
  ];

  return (
    <>
      <button
        type="button"
        className="icon-button"
        aria-label={t.calc.open}
        title={t.calc.open}
        onClick={() => setOpen(true)}
      >
        🧮
      </button>
      <Dialog open={open} title={t.calc.open} onClose={() => setOpen(false)}>
        <div className="calc">
          {result !== null && result !== t.calc.error && (
            <div className="calc-expression">{tokens.join(' ')} =</div>
          )}
          <output className="calc-display" aria-live="polite">
            {shown}
          </output>
          <div className="calc-keys">
            {keys.map(([label, onPress, className]) => (
              <button
                key={label}
                type="button"
                className={`calc-key ${className ?? ''}`}
                aria-label={label === '⌫' ? t.calc.back : label}
                onClick={onPress}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="btn btn-secondary calc-copy"
            disabled={result === null || result === t.calc.error}
            onClick={async () => {
              if (result === null) return;
              await copyText(result);
              toast(t.calc.copied);
            }}
          >
            📋 {t.calc.copy}
          </button>
        </div>
      </Dialog>
    </>
  );
}
