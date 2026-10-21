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
  cashier: ['/kassa'],
  kitchen: ['/oshxona'],
  waiter: ['/ofitsiant', '/buyurtmalar'],
};

/** True for the Kassa, Oshxona and Ofitsiant applications (PIN sign-in, single panel). */
export const isPanelShell = () => shellKind() in allowedPaths;

/** The terminal panel this application serves, as the server stores it on the device. */
export function shellPanel(): 'CASHIER' | 'KITCHEN' | 'WAITER' | 'OTHER' {
  const kind = shellKind();
  return kind === 'cashier'
    ? 'CASHIER'
    : kind === 'kitchen'
      ? 'KITCHEN'
      : kind === 'waiter'
        ? 'WAITER'
        : 'OTHER';
}

/** Whether this application may show the given page. Admin and the browser show everything. */
export function shellAllows(path: string): boolean {
  const allowed = allowedPaths[shellKind()];
  if (!allowed) return true;
  return allowed.some((base) => path === base || path.startsWith(`${base}/`));
}
