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
  // Kitchen screen: current workflow, all active orders, or automatic.
  kitchen: {
    mode: 'current' | 'all' | 'auto';
    design?: {
      enabled: boolean;
      defaultTheme: KitchenTheme;
      whoCanChange: 'all' | 'admin';
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
  kitchen: {
    mode: 'current',
    design: { enabled: true, defaultTheme: 'classic', whoCanChange: 'all' },
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

export const KITCHEN_THEMES = [
  'classic',
  'dark',
  'columns',
  'compact',
  'smart',
  'minimal',
] as const;
export type KitchenTheme = (typeof KITCHEN_THEMES)[number];

const THEME_KEY = 'ff-kitchen-theme';
const PREVIOUS_KEY = 'ff-kitchen-theme-previous';
const readTheme = (key: string): KitchenTheme | null => {
  try {
    const value = localStorage.getItem(key);
    return (KITCHEN_THEMES as readonly string[]).includes(value ?? '')
      ? (value as KitchenTheme)
      : null;
  } catch {
    return null;
  }
};

/**
 * The kitchen screen design on this device. SUPER_OWNER decides whether designs may be
 * changed, the default one and who may change it (Admin only, or kitchen staff too);
 * the choice is remembered on the device together with the previous one.
 */
export function useKitchenTheme() {
  const { data: me } = useMe();
  const design = useOrdering().kitchen.design ?? defaultOrdering.kitchen.design!;
  const [chosen, setChosen] = useState<KitchenTheme | null>(() =>
    readTheme(THEME_KEY),
  );
  const [previous, setPrevious] = useState<KitchenTheme | null>(() =>
    readTheme(PREVIOUS_KEY),
  );
  const permissions = me?.permissions ?? [];
  const canChange =
    design.enabled &&
    (permissions.includes('settings.manage') ||
      (design.whoCanChange === 'all' && permissions.includes('kitchen.access')));
  const theme: KitchenTheme =
    design.enabled && chosen ? chosen : design.defaultTheme;
  const change = (next: KitchenTheme) => {
    if (next === theme) return;
    setPrevious(theme);
    setChosen(next);
    try {
      localStorage.setItem(PREVIOUS_KEY, theme);
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* Storage blocked: the choice lasts for this page only. */
    }
  };
  return { theme, change, previous, canChange };
}
