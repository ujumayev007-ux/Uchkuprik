import { useQuery } from '@tanstack/react-query';
import type {
  PrintRule,
  PrintRules,
  ReceiptType,
} from '../components/PrintRulesEditor';
import { api } from './api';

/**
 * Chop etish qoidalari as the printing pages apply them (the same fallbacks as the
 * server: Kabob / Bar follow the kitchen rule; bill, paid and credit receipts the sales
 * receipt rule). Without a rule a type prints as before.
 */
const FALLBACK: Partial<Record<ReceiptType, ReceiptType>> = {
  KEBAB: 'KITCHEN',
  BAR: 'KITCHEN',
  PRELIM_BILL: 'SALES',
  PAID: 'SALES',
  CREDIT: 'SALES',
};

export type PrintPlan = {
  type: string;
  enabled: boolean;
  copies: number;
  trigger: PrintRule['trigger'];
  printerId: string | null;
};

export function planOf(rules: PrintRules, type: ReceiptType): PrintPlan {
  const fallback = FALLBACK[type];
  const rule = rules[type] ?? (fallback ? rules[fallback] : undefined);
  return {
    type,
    enabled: rule?.enabled ?? true,
    copies: rule?.copies ?? 1,
    trigger: rule?.trigger ?? 'AUTO',
    printerId: rule?.printerId ?? null,
  };
}

export function usePrintRules() {
  return useQuery({
    // Not the editor's key: that one holds { rules, enforced }.
    queryKey: ['print-rules', 'plan'],
    queryFn: () =>
      api<{ rules: PrintRules }>('/print-rules').then((data) => data.rules),
    staleTime: 60_000,
    retry: 1,
  });
}

/** n copies of something to print (at least one). */
export const copiesOf = (count: number) =>
  Array.from({ length: Math.max(1, count) }, (_, index) => index);
