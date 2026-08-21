import type { CapacitorConfig } from '@capacitor/cli';

/**
 * Capacitor wraps the SPA that `vite build` already produces – there is no second copy of the
 * app and no mobile-only source tree. `cap sync` is the only path into `android/` and `ios/`,
 * so the shells can never drift from the web build (ADR-001).
 *
 * EVERY VALUE BELOW IS CHANGE-SENSITIVE AFTER RELEASE. The WebView serves the app from an
 * origin composed of the scheme and hostname, and that origin partitions IndexedDB – which is
 * where S10 keeps the offline Schedule cache. Changing `appId`, `iosScheme`, `androidScheme`
 * or `hostname` later orphans every cached Schedule on every installed device: the data is
 * still on disk under the old origin, unreachable, and the app silently reports conferences as
 * "not available offline". Treat any change here as a data-clearing migration, not a rename.
 */
const config: CapacitorConfig = {
  // Reverse-DNS from the company domain (it-huset.se). Hyphens are illegal in Android package
  // names and Java packages, so the domain label is flattened rather than hyphenated.
  // This is also the iOS bundle ID and the Android package name that Google binds the two
  // native OAuth clients to (TI04), so it is fixed before those clients are registered.
  appId: 'se.ithuset.confapp',
  appName: 'confApp',

  // S01's web build output, relative to this file. `cap sync` copies from here – it never
  // builds, so `npm run build --workspace web` must run first or the shells ship stale assets.
  webDir: 'dist',

  server: {
    // Both are Capacitor's defaults, set explicitly because they are load-bearing rather than
    // incidental: they decide the WebView origin, and an origin that moves takes S10's cache
    // with it. Written down here so a future change is a deliberate edit, not a silent default
    // shift on a major upgrade.
    //
    // The resulting origins are `capacitor://localhost` (iOS) and `https://localhost`
    // (Android). Neither is the API's origin, so the SPA must reach the API through S01's
    // configurable absolute base URL, and the API must allow both as CORS origins (TI02).
    iosScheme: 'capacitor',
    androidScheme: 'https',
    hostname: 'localhost',
  },
};

export default config;
