import { defineConfig } from '@playwright/test';

/**
 * Visual validation for the responsive shell.
 *
 * confApp is responsive-first, so the shell is checked at phone, tablet and desktop widths
 * rather than at whatever size the developer's window happens to be. This is scripted on
 * purpose: every later UI story has to be able to repeat it.
 *
 * It runs against the composed stack, so the health panel shows a real database value.
 * Bring the stack up first: `docker compose up -d && npm run migrate:up`.
 */
export default defineConfig({
  testDir: './visual',
  outputDir: './test-results',
  reporter: [['list']],
  use: {
    baseURL: process.env.WEB_URL ?? 'http://127.0.0.1:8082',
    screenshot: 'off',
    trace: 'off',
  },
});
