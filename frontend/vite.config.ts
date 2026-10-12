import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

export default defineConfig(({ mode }) => {
  // Only the API port is read here. No server environment is exposed to the browser.
  const env = loadEnv(
    mode,
    fileURLToPath(new URL('../', import.meta.url)),
    'PORT',
  );
  const target = `http://127.0.0.1:${env.PORT || '4000'}`;
  // Same rule as the API server so terminals can be checked for outdated builds.
  const version =
    process.env.RENDER_GIT_COMMIT?.slice(0, 7) ||
    process.env.npm_package_version ||
    'dev';
  return {
    plugins: [react()],
    define: { __APP_VERSION__: JSON.stringify(version) },
    server: {
      port: 5173,
      strictPort: true,
      proxy: { '/api': { target, ws: true } },
    },
    preview: {
      port: 4173,
      strictPort: true,
      proxy: { '/api': { target, ws: true } },
    },
  };
});
