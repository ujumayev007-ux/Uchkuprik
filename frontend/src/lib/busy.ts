import { useEffect, useSyncExternalStore } from 'react';

/**
 * Screens that must never be interrupted (an open payment, a sale in progress, a print
 * job, the kitchen) register themselves here. Advertisements that cover the screen wait
 * until nothing is registered and are dismissed at once if work starts.
 */
const reasons = new Map<string, number>();
const listeners = new Set<() => void>();
let snapshot = 0;

const emit = () => {
  snapshot += 1;
  for (const listener of listeners) listener();
};

export function setBusy(reason: string, active: boolean) {
  const before = reasons.get(reason) ?? 0;
  const next = Math.max(0, before + (active ? 1 : -1));
  if (next === 0) reasons.delete(reason);
  else reasons.set(reason, next);
  if ((before === 0) !== (next === 0)) emit();
}

export const isBusy = () => reasons.size > 0;

/** Marks the calling component as "do not interrupt" while `active` is true. */
export function useBusy(reason: string, active = true) {
  useEffect(() => {
    if (!active) return;
    setBusy(reason, true);
    return () => setBusy(reason, false);
  }, [reason, active]);
}

/** Re-renders when the busy state changes. */
export function useBusySignal() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
  );
}
