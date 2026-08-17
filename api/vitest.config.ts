import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'api',
    environment: 'node',
    include: ['test/**/*.test.ts'],
    setupFiles: ['./test/setup.ts'],
    // Integration tests bring a database up and down; they must not race each other.
    fileParallelism: false,
    testTimeout: 30_000,
  },
});
