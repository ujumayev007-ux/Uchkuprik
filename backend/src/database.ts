import pg from 'pg';

export interface DatabaseProbe {
  check(): Promise<void>;
}

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 5,
    connectionTimeoutMillis: 2000,
    idleTimeoutMillis: 10000,
    query_timeout: 2000,
    statement_timeout: 2000,
    application_name: 'fastfood-api',
  });
  return {
    pool,
    async check(): Promise<void> {
      await pool.query('SELECT 1');
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}
