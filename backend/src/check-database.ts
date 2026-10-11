import { loadConfig } from './config.js';
import { createDatabase } from './database.js';

const database = createDatabase(loadConfig().DATABASE_URL);
try {
  await database.check();
  console.log('PostgreSQL connectivity verified.');
} catch {
  console.error(
    'PostgreSQL connectivity failed. Check the database service and local environment.',
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
