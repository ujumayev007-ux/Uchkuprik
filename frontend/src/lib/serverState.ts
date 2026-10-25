import { useSyncExternalStore } from 'react';

/**
 * Is the server reachable? A cold-starting host answers with its own interstitial page
 * or with 502/503/504; the application then shows its own branded "reconnecting" screen
 * and tries again by itself instead of an error or someone else's loading page.
 */
let down = false;
let failures = 0;
const listeners = new Set<() => void>();
const emit = () => {
  for (const listener of listeners) listener();
};

export function reportFailure() {
  failures += 1;
  // Two failures in a row: a single dropped request must not cover the screen.
  if (failures >= 2 && !down) {
    down = true;
    emit();
  }
}

export function reportOk() {
  failures = 0;
  if (down) {
    down = false;
    emit();
  }
}

export function useServerDown() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => down,
  );
}

/** True only for our own server's health answer (not a hosting interstitial page). */
export async function pingHealth(): Promise<boolean> {
  try {
    // AbortSignal.timeout is missing in older TV browsers (WebView before Chrome 103).
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    const response = await fetch('/api/health/live', {
      cache: 'no-store',
      signal: controller.signal,
    }).finally(() => clearTimeout(timer));
    if (!response.ok) return false;
    const body = (await response.json()) as { status?: string };
    return body.status === 'ok';
  } catch {
    return false;
  }
}
