import { defineConfig } from 'prisma/config';
import { loadEnvironment } from './src/config.js';

// Only the database URL is needed here; full validation runs when the API starts.
// `prisma generate` works without it, migrations fail fast when it is missing.
loadEnvironment();
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
