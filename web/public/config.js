// Default runtime configuration, used by `vite dev` and baked into the build as the
// fallback. The SPA container overwrites this file at start from its environment – see
// web/docker-entrypoint.d/40-runtime-config.sh.
//
// This file is served to the browser, so it holds public values only: an OAuth client ID and
// a hosted-domain hint are not secrets. The web client SECRET is never here – the API holds
// it and brokers the code exchange so it never reaches a browser.
//
// The auth values are blank by default: with no client ID the app says sign-in is not
// configured, which is a clearer first-run experience than a redirect to Google that fails.
window.__CONFAPP_CONFIG__ = {
  apiBaseUrl: '/api',
  // Where a *room machine* reaches this SPA, for building Display Link URLs (S04).
  // Empty is correct for a browser served at this origin - it can name itself. The
  // Capacitor shells (S11) must set it: their WebView origin is capacitor://localhost
  // or https://localhost, which no other machine can open.
  webBaseUrl: '',
  auth: {
    clientId: '',
    hostedDomain: '',
    redirectUri: '',
  },
};
