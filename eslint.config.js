// @ts-check
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/node_modules/**',
      '**/.tsbuild/**',
      '.agent_temp/**',
      'screenshots/**',
      'test-results/**',
      'playwright-report/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
  {
    // Node-side code may read the environment and write to the process stdio.
    files: [
      'api/**/*.ts',
      'db/**/*.{ts,mjs,js}',
      'scripts/**/*.{ts,mjs,js}',
      'visual/**/*.ts',
      '*.config.{ts,js}',
      '**/vite.config.ts',
      '**/vitest.config.ts',
    ],
    languageOptions: {
      globals: { process: 'readonly', console: 'readonly' },
    },
  },
  {
    files: ['web/**/*.{ts,tsx}', 'web/public/**/*.js'],
    languageOptions: {
      globals: { window: 'readonly', document: 'readonly', console: 'readonly', fetch: 'readonly' },
    },
  },
  prettier,
);
