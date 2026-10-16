import { useCallback, useEffect, useState } from 'react';
import { useMe } from '../auth/session';

// Central ordering settings (SUPER_OWNER, or the restaurant Admin where delegated).
// The server enforces every one of them; this mirrors them to hide what a user
// cannot do and to apply display defaults.

export type DisplayMode = 'compact' | 'detailed' | 'grid';

export type Ordering = {
  types: { DINE_IN: boolean; TAKEAWAY: boolean; DELIVERY: boolean };
  walkin: boolean;
  tableAssign: boolean;
  singleOrderPerTable: boolean;
  discount: {
    percent: boolean;
    fixed: boolean;
    maxPercentBp: number;
    maxFixed: number;
  };
  display: { mode: DisplayMode; canChange: boolean };
  tv: {
    enabled: boolean;
    layout: 'split' | 'single';
    showPreparing: boolean;
    showReady: boolean;
    voice: {
      enabled: boolean;
      repeat: number;
      volume: number;
      phrase: 'ordinal' | 'cardinal';
    };
  };
  waiterAlerts: {
    enabled: boolean;
    sound: boolean;
    voice: boolean;
    volume: number;
    repeat: number;
    reminderSeconds: number;
  };
};

export const defaultOrdering: Ordering = {
  types: { DINE_IN: true, TAKEAWAY: true, DELIVERY: true },
  walkin: true,
  tableAssign: true,
  singleOrderPerTable: true,
  discount: {
    percent: true,
    fixed: true,
    maxPercentBp: 10_000,
    maxFixed: 100_000_000,
  },
  display: { mode: 'detailed', canChange: true },
  tv: {
    enabled: true,
    layout: 'split',
    showPreparing: true,
    showReady: true,
    voice: { enabled: true, repeat: 1, volume: 100, phrase: 'ordinal' },
  },
  waiterAlerts: {
    enabled: false,
    sound: true,
    voice: true,
    volume: 100,
    repeat: 1,
    reminderSeconds: 0,
  },
};

export function useOrdering(): Ordering {
  const { data: me } = useMe();
  return me?.ordering ?? defaultOrdering;
}

const MODES: DisplayMode[] = ['compact', 'detailed', 'grid'];

/**
 * The order display mode of this user: their own choice when the policy lets them
 * change it, otherwise the default decided centrally.
 */
export function useOrderDisplayMode() {
  const { data: me } = useMe();
  const ordering = useOrdering();
  const key = `ff-order-view:${me?.userId ?? ''}`;
  const read = useCallback((): DisplayMode | null => {
    try {
      const value = localStorage.getItem(key);
      return MODES.includes(value as DisplayMode)
        ? (value as DisplayMode)
        : null;
    } catch {
      return null;
    }
  }, [key]);
  const [chosen, setChosen] = useState<DisplayMode | null>(read);
  useEffect(() => setChosen(read()), [read]);
  const mode =
    ordering.display.canChange && chosen ? chosen : ordering.display.mode;
  const change = (next: DisplayMode) => {
    setChosen(next);
    try {
      localStorage.setItem(key, next);
    } catch {
      /* Storage blocked: the choice lasts for this page only. */
    }
  };
  return { mode, change, canChange: ordering.display.canChange };
}
