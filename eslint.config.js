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
      // Capacitor's native projects (S11 TI01) are generated scaffolds that only ever *receive*
      // output: `cap sync` copies the built SPA into `android/app/src/main/assets/public` and
      // `ios/App/App/public`, so linting them re-reports every finding against a bundle that was
      // already linted at source, and reports the service worker against the wrong global scope.
      // Capacitor's own `.gitignore` files exclude the same copies from version control; this
      // keeps the lint gate agreeing with them. Hand-written native code here is Kotlin/Swift,
      // which ESLint does not lint, so nothing authored is skipped by this rule.
      'web/android/**',
      'web/ios/**',
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
  {
    // The service worker (S10 TI10) runs in a worker global scope, not a window one: no `document`
    // and no `window`, but `self`, `caches` and the URL constructor.
    files: ['web/public/sw.js'],
    languageOptions: {
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Response: 'readonly',
      },
    },
  },
  prettier,
);
