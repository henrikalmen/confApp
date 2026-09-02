import { fileURLToPath } from 'node:url';
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
          // Empty in dev: the browser is already at an http origin it can name for itself.
          webBaseUrl: process.env.WEB_BASE_URL ?? '',
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

/**
 * Serves the projected Board's own document at `/display/<token>` in **development** (S04 TI10).
 *
 * Vite's dev server has its own SPA fallback and would answer that navigation with `index.html` -
 * the signed-in app - so without this the entry-point mechanism would be wrong in exactly one of
 * the two places it has to work, and only in the one nobody ships from. The production side is
 * nginx's `location ^~ /display/` block, and both are needed.
 *
 * `req.url` is rewritten rather than the file being read here, so Vite still applies its own
 * transform pipeline to `display.html` - module resolution, HMR client injection, the lot.
 */
function displayEntry(): Plugin {
  return {
    name: 'confapp-display-entry',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const path = (request.url ?? '').split('?')[0] ?? '';
        // The prefix only, and never `/display.html` itself or an asset under the path: this
        // rewrites the *token* URLs, which name no file on disk.
        if (/^\/display\/[^/]+\/?$/.test(path)) request.url = '/display.html';
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), runtimeConfig(), displayEntry()],
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
    /*
     * **Two entry documents, two bundles** (S04 TI10).
     *
     * `display.html` is the projected Board's own document, not a route of the app: it mounts no
     * auth provider and registers no service worker, and giving it its own Rollup input is what
     * keeps the sign-in, offline and queueing code out of the bundle a room machine downloads.
     * Rollup emits `dist/display.html` referencing its own hashed entry chunk beside
     * `dist/index.html` referencing the app's; shared modules (React, the API client) are split
     * into chunks both reference, which is the point of naming them as inputs rather than building
     * twice.
     */
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('index.html', import.meta.url)),
        display: fileURLToPath(new URL('display.html', import.meta.url)),
      },
    },
  },
});
