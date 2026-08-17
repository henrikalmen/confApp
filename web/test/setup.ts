import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => {
  cleanup();
  delete window.__CONFAPP_CONFIG__;
});
