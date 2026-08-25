import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'web',
    environment: 'jsdom',
    include: ['test/**/*.test.{ts,tsx}'],
    setupFiles: ['./test/setup.ts'],
    /*
     * Room for a test that legitimately waits.
     *
     * Several of these suites drive a reconnect end to end – a watermark read, a schedule read, an
     * IndexedDB write and a re-render – and a couple do it more than once. Vitest's five-second
     * default is the same as the longest single `waitFor` the setup file allows, so one slow wait
     * could consume the whole budget and the test would report "timed out" rather than the
     * assertion that was actually unmet. On a machine running every file in parallel that showed up
     * as a different reconnect test failing on each run while all of them passed in isolation.
     *
     * It weakens nothing: a test that never satisfies its condition still fails, just later.
     */
    testTimeout: 30_000,
  },
});
