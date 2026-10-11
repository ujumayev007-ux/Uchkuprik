import { defineConfig } from 'prisma/config';
import { loadConfig } from './src/config.js';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  datasource: { url: loadConfig().DATABASE_URL },
});
