import type pg from 'pg';

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

export type TerminalReconcile = {
  // Terminals as they are today (status, Owner approval, key, panel).
  kept: number;
  // In the backup but removed since: blocked, never back in use.
  revoked: number;
  // Added since in a branch the backup does not have: pair again.
  needRepair: number;
  // Sign-ins carried over (their user still exists).
  sessions: number;
};

/**
 * Terminals and sign-ins after a full restore are today's, not the backup's: a terminal
 * keeps working with its key and its Owner approval (PENDING stays PENDING, nothing is
 * approved here), one removed or blocked since the backup never comes back, and
 * sessions ended since stay ended. Runs inside the restore's transaction.
 */
export async function reconcileTerminals(
  check: pg.Client,
  live: pg.Client,
): Promise<TerminalReconcile> {
  const result: TerminalReconcile = {
    kept: 0,
    revoked: 0,
    needRepair: 0,
    sessions: 0,
  };
  const columns = (
    await check.query<{ name: string }>(
      `SELECT column_name AS name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'devices' AND column_name <> 'id'`,
    )
  ).rows.map((row) => quote(row.name));
  const devices = (
    await live.query<{
      r: { id: string; tenantId: string; branchId: string };
    }>('SELECT row_to_json(t) AS r FROM devices t')
  ).rows.map((row) => row.r);
  const kept: string[] = [];
  for (const device of devices) {
    const branch = await check.query(
      'SELECT 1 FROM branches WHERE id = $1::uuid AND "tenantId" = $2::uuid',
      [device.branchId, device.tenantId],
    );
    if (!branch.rowCount) {
      result.needRepair++;
      continue;
    }
    await check.query(
      `INSERT INTO devices SELECT * FROM json_populate_record(NULL::devices, $1::json)
       ON CONFLICT (id) DO UPDATE SET (${columns.join(', ')}) = ROW(${columns
         .map((column) => `EXCLUDED.${column}`)
         .join(', ')})`,
      [JSON.stringify(device)],
    );
    kept.push(device.id);
    result.kept++;
  }
  result.revoked =
    (
      await check.query(
        `UPDATE devices SET status = 'REVOKED', "revokedAt" = now()
          WHERE NOT (id = ANY($1::uuid[])) AND status <> 'REVOKED'`,
        [kept],
      )
    ).rowCount ?? 0;
  await check.query('DELETE FROM sessions');
  const sessions = (
    await live.query<{
      r: {
        tenantId: string;
        userId: string;
        deviceId: string | null;
        branchId: string | null;
      };
    }>(
      `SELECT row_to_json(t) AS r FROM sessions t
        WHERE "revokedAt" IS NULL AND "expiresAt" > now()`,
    )
  ).rows.map((row) => row.r);
  for (const session of sessions) {
    const fits = await check.query(
      `SELECT 1 FROM users u
        WHERE u.id = $1::uuid AND u."tenantId" = $2::uuid
          AND ($3::uuid IS NULL OR EXISTS (
            SELECT 1 FROM devices d WHERE d.id = $3::uuid AND d.status = 'ACTIVE'))
          AND ($4::uuid IS NULL OR EXISTS (
            SELECT 1 FROM branches b WHERE b.id = $4::uuid))`,
      [session.userId, session.tenantId, session.deviceId, session.branchId],
    );
    if (!fits.rowCount) continue;
    await check.query(
      'INSERT INTO sessions SELECT * FROM json_populate_record(NULL::sessions, $1::json)',
      [JSON.stringify(session)],
    );
    result.sessions++;
  }
  return result;
}
