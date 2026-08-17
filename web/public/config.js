// Default runtime configuration, used by `vite dev` and baked into the build as the
// fallback. The SPA container overwrites this file at start from its API_BASE_URL
// environment variable – see web/docker-entrypoint.d/40-runtime-config.sh.
window.__CONFAPP_CONFIG__ = { apiBaseUrl: '/api' };
