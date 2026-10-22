/** Which desktop application hosts this page: the dedicated apps announce themselves. */
export type ShellKind =
  'admin' | 'cashier' | 'waiter' | 'kitchen' | 'tv' | 'pos';

export function shellKind(): ShellKind {
  const shell = (window as unknown as { fastfoodShell?: { kind?: string } })
    .fastfoodShell;
  return shell?.kind === 'admin' ||
    shell?.kind === 'cashier' ||
    shell?.kind === 'waiter' ||
    shell?.kind === 'kitchen' ||
    shell?.kind === 'tv'
    ? shell.kind
    : 'pos';
}

/** Pages each dedicated app may open; everything else stays in the Admin application. */
const allowedPaths: Partial<Record<ShellKind, string[]>> = {
  cashier: ['/kassa', '/buyurtmalar'],
  kitchen: ['/oshxona'],
  waiter: ['/ofitsiant', '/buyurtmalar'],
  // The TV application is a registered display: one PIN, then it opens by itself.
  tv: ['/navbat'],
};

/** True for the Kassa, Oshxona, Ofitsiant and TV applications (PIN sign-in, single panel). */
export const isPanelShell = () => shellKind() in allowedPaths;

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
