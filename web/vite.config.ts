import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The dev server proxies /api to the locally running API so the browser sees one origin,
// exactly as the static-file container does in the composed stack. Keeping both entry points
// on the same path means the API owns the /api prefix and nothing strips it.
const apiTarget = process.env.VITE_DEV_API_TARGET ?? 'http://localhost:8080';

/**
 * Serves `/config.js` from the environment in dev, exactly as the SPA container's entrypoint
 * writes it at start. Without this a developer would have to edit `web/public/config.js` –
 * a tracked file – to sign in locally, which is how environment values end up in a commit.
 *
 * Public values only, for the same reason as the container: the browser downloads this.
 */
function runtimeConfig(): Plugin {
  return {
    name: 'confapp-runtime-config',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/config.js', (_request, response) => {
        const config = {
          apiBaseUrl: process.env.API_BASE_URL ?? '/api',
          auth: {
            clientId: process.env.GOOGLE_WEB_CLIENT_ID ?? '',
            hostedDomain: process.env.GOOGLE_HOSTED_DOMAIN ?? '',
            redirectUri: process.env.GOOGLE_REDIRECT_URI ?? '',
          },
        };
        response.setHeader('content-type', 'application/javascript');
        response.setHeader('cache-control', 'no-store');
        response.end(`window.__CONFAPP_CONFIG__ = ${JSON.stringify(config)};`);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), runtimeConfig()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
