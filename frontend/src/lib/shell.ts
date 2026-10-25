/** Which desktop application hosts this page: the dedicated apps announce themselves. */
export type ShellKind =
  'admin' | 'cashier' | 'waiter' | 'kitchen' | 'tv' | 'universal' | 'pos';

export function shellKind(): ShellKind {
  const w = window as unknown as {
    fastfoodShell?: { kind?: string };
    // The Android Oshxona / TV apps answer here (the waiter app answers "").
    FastFoodAndroid?: { shellKind?: () => string };
  };
  let kind = w.fastfoodShell?.kind;
  if (!kind) {
    try {
      kind = w.FastFoodAndroid?.shellKind?.();
    } catch {
      kind = undefined;
    }
  }
  return kind === 'admin' ||
    kind === 'cashier' ||
    kind === 'waiter' ||
    kind === 'kitchen' ||
    kind === 'tv' ||
    kind === 'universal'
    ? kind
    : 'pos';
}

/** Pages each dedicated app may open; everything else stays in the Admin application. */
const allowedPaths: Partial<Record<ShellKind, string[]>> = {
  cashier: ['/kassa', '/buyurtmalar', '/printerlar', '/tv-ekran', '/bozorlik'],
  kitchen: ['/oshxona'],
  waiter: ['/ofitsiant', '/buyurtmalar'],
  // The TV application is a registered display: one PIN, then it opens by itself.
  tv: ['/navbat'],
};

/**
 * True for the Kassa, Oshxona, Ofitsiant and TV applications (PIN sign-in, single panel)
 * and for the FastFood application ("universal"): it also starts on the PIN pad, then
 * each person opens their own panel and may use every page their role allows.
 */
export const isPanelShell = () =>
  shellKind() in allowedPaths || shellKind() === 'universal';

/** The terminal panel this application serves, as the server stores it on the device. */
export function shellPanel():
  'CASHIER' | 'KITCHEN' | 'WAITER' | 'DISPLAY' | 'OTHER' {
  const kind = shellKind();
  return kind === 'cashier'
    ? 'CASHIER'
    : kind === 'kitchen'
      ? 'KITCHEN'
      : kind === 'waiter'
        ? 'WAITER'
        : kind === 'tv'
          ? 'DISPLAY'
          : 'OTHER';
}

/** Whether this application may show the given page. Admin and the browser show everything. */
export function shellAllows(path: string): boolean {
  const allowed = allowedPaths[shellKind()];
  if (!allowed) return true;
  return allowed.some((base) => path === base || path.startsWith(`${base}/`));
}
