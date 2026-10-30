import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import pg from 'pg';

/**
 * Qisman tiklash: brings back one part of the data (the menu, the floor, receipt
 * templates…) from a backup into the LIVE database, without a restart and without
 * touching anything else. Nothing is deleted: rows of the backup are put back
 * (MERGE: inserted when missing, set to the backup's values when changed) or only the
 * missing ones are inserted (MISSING: for data other records were computed from, like
 * stock costs and loyalty points). Everything runs in one transaction — a conflict
 * rolls it all back — and a dry run reports the counts without changing anything.
 */
export const PARTIAL_GROUPS = {
  MENU: {
    mode: 'MERGE',
    tables: [
      'kitchen_stations',
      'menu_categories',
      'products',
      'product_variants',
      'product_images',
      'branch_variant_prices',
      'modifier_groups',
      'modifier_options',
      'product_modifier_groups',
      'combo_components',
    ],
  },
  FLOOR: { mode: 'MERGE', tables: ['rooms', 'dining_tables'] },
  RECEIPTS: {
    mode: 'MERGE',
    tables: ['receipt_templates', 'receipt_assignments'],
  },
  INVENTORY: {
    mode: 'MISSING',
    tables: [
      'warehouses',
      'suppliers',
      'stock_items',
      'stock_units',
      'recipe_lines',
    ],
  },
  CUSTOMERS: { mode: 'MISSING', tables: ['customers', 'coupons'] },
} as const satisfies Record<
  string,
  { mode: 'MERGE' | 'MISSING'; tables: readonly string[] }
>;
export type PartialGroup = keyof typeof PARTIAL_GROUPS;
export const PARTIAL_GROUP_KEYS = Object.keys(PARTIAL_GROUPS) as PartialGroup[];

export type PartialResult = {
  dryRun: boolean;
  tables: {
    group: PartialGroup;
    table: string;
    inBackup: number;
    inserted: number;
    updated: number;
    unchanged: number;
  }[];
};

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

async function tableInfo(client: pg.Client, table: string) {
  const columns = (
    await client.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER'`,
      [table],
    )
  ).rows.map((row) => row.name);
  const keys = (
    await client.query<{ name: string }>(
      `SELECT a.attname AS name
         FROM pg_index i
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
        WHERE i.indrelid = $1::regclass AND i.indisprimary`,
      [quote(table)],
    )
  ).rows.map((row) => row.name);
  return { columns, keys };
}

export async function partialRestore(
  databaseUrl: string,
  file: string,
  groups: PartialGroup[],
  options: { dryRun: boolean },
): Promise<PartialResult> {
  const wanted = new Map<string, PartialGroup>();
  for (const group of groups)
    for (const table of PARTIAL_GROUPS[group].tables) wanted.set(table, group);
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const result: PartialResult = { dryRun: options.dryRun, tables: [] };
  try {
    await client.query('BEGIN');
    const info = new Map<string, Awaited<ReturnType<typeof tableInfo>>>();
    for (const table of wanted.keys()) {
      const exists = await client.query(
        `SELECT 1 FROM pg_tables WHERE schemaname = 'public' AND tablename = $1`,
        [table],
      );
      if (exists.rowCount) info.set(table, await tableInfo(client, table));
    }
    let table: string | null = null;
    let current: PartialResult['tables'][number] | null = null;
    const lines = createInterface({
      input: createReadStream(file).pipe(createGunzip()),
      crlfDelay: Infinity,
    });
    // The backup lists tables parents first, so foreign keys hold row by row.
    for await (const line of lines) {
      if (!line) continue;
      const item = JSON.parse(line) as {
        table?: string;
        r?: Record<string, unknown>;
      };
      if (item.table) {
        table =
          wanted.has(item.table) && info.has(item.table) ? item.table : null;
        current = table
          ? {
              group: wanted.get(table)!,
              table,
              inBackup: 0,
              inserted: 0,
              updated: 0,
              unchanged: 0,
            }
          : null;
        if (current) result.tables.push(current);
        continue;
      }
      if (!item.r || !table || !current) continue;
      const { columns, keys } = info.get(table)!;
      // Only columns this backup has (an older backup may lack newer ones).
      const cols = columns.filter((name) => name in item.r!);
      if (keys.length === 0 || !keys.every((key) => cols.includes(key)))
        continue;
      current.inBackup++;
      const list = cols.map(quote).join(', ');
      const target = quote(table);
      const conflict = `ON CONFLICT (${keys.map(quote).join(', ')})`;
      const rest = cols.filter((name) => !keys.includes(name));
      const action =
        PARTIAL_GROUPS[current.group].mode === 'MISSING' || rest.length === 0
          ? `${conflict} DO NOTHING`
          : `${conflict} DO UPDATE SET (${rest.map(quote).join(', ')}) = ROW(${rest
              .map((name) => `EXCLUDED.${quote(name)}`)
              .join(', ')})
             WHERE (${rest.map((name) => `${target}.${quote(name)}`).join(', ')})
               IS DISTINCT FROM (${rest.map((name) => `EXCLUDED.${quote(name)}`).join(', ')})`;
      const written = await client.query<{ inserted: boolean }>(
        `INSERT INTO ${target} (${list})
         SELECT ${list} FROM json_populate_record(NULL::${target}, $1::json)
         ${action}
         RETURNING (xmax = 0) AS inserted`,
        [JSON.stringify(item.r)],
      );
      const row = written.rows[0];
      if (!row) current.unchanged++;
      else if (row.inserted) current.inserted++;
      else current.updated++;
    }
    await client.query(options.dryRun ? 'ROLLBACK' : 'COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    await client.end().catch(() => undefined);
  }
}
