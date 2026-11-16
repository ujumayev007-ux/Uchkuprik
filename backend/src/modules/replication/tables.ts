import type { Db, Tx } from '../../db.js';

/**
 * Which tables are replicated between a Kassa server (spoke) and the central server
 * (hub), and how. Every replicated table carries `tenantId` (or is `tenants` itself),
 * so each change belongs to exactly one restaurant.
 */

// Never replicated: per-server sessions and devices (each server approves its own
// terminals), local queues (printing, notifications, webhooks: sent once, by the server
// that produced them), secrets sealed with a server key, billing of the hosting
// service, and derived state recomputed on each side (stock alerts).
export const EXCLUDED_TABLES = new Set([
  'devices',
  'sessions',
  'audit_logs',
  'print_jobs',
  'notification_jobs',
  'webhook_deliveries',
  'webhook_endpoints',
  'api_keys',
  'telegram_configs',
  'telegram_chats',
  'notification_subscribers',
  'payment_provider_configs',
  'provider_transactions',
  'subscriptions',
  'invoices',
  'control_customers',
  'stock_alerts',
  'order_codes',
  'evidence_files',
]);

// Tables whose own id is a per-server sequence: replicated by their global `uid`.
export const UID_TABLES = new Set([
  'stock_movements',
  'order_events',
  'loyalty_entries',
]);

// Counters and balances: a change is sent as "+delta" and added on the other side,
// so concurrent sales on the Kassa and receipts on the central server both count.
export const ADDITIVE_COLUMNS: Record<string, string[]> = {
  stock_balances: ['quantity'],
  stock_batches: ['quantity'],
  customers: ['points', 'totalSpent', 'orderCount'],
  credit_accounts: ['balance'],
};

// Server-bound values: sealed or keyed with this server's APP_SECRET_KEY; never sent.
export const isServerBoundColumn = (column: string) =>
  /Enc$/.test(column) ||
  ['tokenHash', 'keyHash', 'codeHash', 'webhookSecretHash'].includes(column);

export type TableInfo = {
  name: string;
  pk: string[];
  columns: Map<string, string>; // column -> SQL type (for casts)
  excluded: string[];
  additive: string[];
  // Tables it refers to (for the first full copy: parents before children).
  parents: string[];
};

let cache: Promise<Map<string, TableInfo>> | null = null;

/** Replicated tables of this database (read from the catalogue once per process). */
export function replicatedTables(db: Db | Tx): Promise<Map<string, TableInfo>> {
  cache ??= load(db).catch((error) => {
    cache = null;
    throw error;
  });
  return cache;
}

export function clearTableCache() {
  cache = null;
}

async function load(db: Db | Tx) {
  const columns = await db.$queryRaw<
    { table: string; column: string; type: string }[]
  >`SELECT c.table_name AS "table", c.column_name AS "column",
           format_type(a.atttypid, a.atttypmod) AS type
      FROM information_schema.columns c
      JOIN pg_attribute a ON a.attrelid = (quote_ident(c.table_name))::regclass
                         AND a.attname = c.column_name
     WHERE c.table_schema = current_schema()
     ORDER BY c.table_name, c.ordinal_position`;
  const keys = await db.$queryRaw<{ table: string; column: string }[]>`
    SELECT t.relname AS "table", a.attname AS "column"
      FROM pg_index i
      JOIN pg_class t ON t.oid = i.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = current_schema()
      JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) ON true
      JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = k.attnum
     WHERE i.indisprimary
     ORDER BY t.relname, k.ord`;
  const links = await db.$queryRaw<{ child: string; parent: string }[]>`
    SELECT DISTINCT c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent
      FROM pg_constraint c WHERE c.contype = 'f'`;

  const byTable = new Map<string, Map<string, string>>();
  for (const row of columns) {
    if (!byTable.has(row.table)) byTable.set(row.table, new Map());
    byTable.get(row.table)!.set(row.column, row.type);
  }
  const result = new Map<string, TableInfo>();
  for (const [name, cols] of byTable) {
    // The replication tables themselves and anything outside a restaurant.
    if (EXCLUDED_TABLES.has(name) || name.startsWith('replication_')) continue;
    if (name !== 'tenants' && !cols.has('tenantId')) continue;
    const pk = UID_TABLES.has(name)
      ? ['uid']
      : keys.filter((key) => key.table === name).map((key) => key.column);
    if (pk.length === 0) continue;
    result.set(name, {
      name,
      pk,
      columns: cols,
      excluded: [...cols.keys()].filter(isServerBoundColumn),
      additive: (ADDITIVE_COLUMNS[name] ?? []).filter((c) => cols.has(c)),
      parents: [],
    });
  }
  for (const link of links) {
    const child = result.get(link.child.replace(/"/g, ''));
    const parent = link.parent.replace(/"/g, '');
    if (child && parent !== child.name && result.has(parent))
      child.parents.push(parent);
  }
  return result;
}

/** Parents before children (the order of a full copy). */
export function copyOrder(tables: Map<string, TableInfo>): string[] {
  const done = new Set<string>();
  const order: string[] = [];
  const visit = (name: string, path: Set<string>) => {
    if (done.has(name) || path.has(name)) return;
    path.add(name);
    for (const parent of tables.get(name)?.parents ?? []) visit(parent, path);
    path.delete(name);
    done.add(name);
    order.push(name);
  };
  for (const name of [...tables.keys()].sort()) visit(name, new Set());
  return order;
}

export const quoteIdent = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Bad identifier ${name}`);
  return `"${name}"`;
};

/**
 * Installs (or refreshes) the capture trigger on every replicated table. Idempotent;
 * the trigger records changes only for tenants listed in replication_tenants.
 */
export async function installTriggers(db: Db | Tx) {
  const tables = await replicatedTables(db);
  for (const table of tables.values()) {
    const args = [
      table.pk.join(','),
      table.excluded.join(','),
      table.additive.join(','),
    ].map((value) => `'${value.replace(/'/g, "''")}'`);
    const name = quoteIdent(table.name);
    await db.$executeRawUnsafe(
      `CREATE OR REPLACE TRIGGER ff_replicate AFTER INSERT OR UPDATE OR DELETE ON ${name}
       FOR EACH ROW EXECUTE FUNCTION ff_replicate(${args.join(', ')})`,
    );
  }
  return tables.size;
}
