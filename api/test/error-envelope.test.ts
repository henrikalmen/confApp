import { describe, expect, it, afterEach } from 'vitest';
import Fastify from 'fastify';
import { buildApp, installErrorHandling } from '../src/app.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * Acceptance Scenario S02 – unknown API route is refused in the standard error envelope –
 * plus TI05's second half: an unhandled throw leaves through the same envelope and leaks
 * nothing. The envelope is the contract S03–S09 consume, so its exact shape is asserted.
 */
describe('the shared error envelope', () => {
  const apps: { close(): Promise<void> }[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  it('refuses an unknown route with 404 ROUTE_NOT_FOUND and a displayable message', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/does-not-exist' });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');

    const body = response.json();
    expect(body.error.code).toBe('ROUTE_NOT_FOUND');
    // A displayable sentence, not a status word and not framework default HTML.
    expect(body.error.message).toMatch(/\.$/);
    expect(body.error.message.length).toBeGreaterThan(10);
    expect(body.error).not.toHaveProperty('details');
  });

  it('maps an unhandled throw to 500 INTERNAL_ERROR without leaking the exception', async () => {
    const app = Fastify({ logger: false });
    installErrorHandling(app);
    app.get('/api/boom', async () => {
      throw new Error('secret internal detail: postgres://user:pw@db:5432/confapp');
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/boom' });

    expect(response.statusCode).toBe(500);
    const body = response.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(response.payload).not.toContain('secret internal detail');
    expect(response.payload).not.toContain('postgres://');
    expect(response.payload.toLowerCase()).not.toContain('at object');
  });

  it('keeps every refusal in the same envelope shape', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    apps.push(app);

    const refusals = await Promise.all([
      app.inject({ method: 'GET', url: '/api/nope' }),
      app.inject({ method: 'GET', url: '/api/health?verbose=maybe' }),
    ]);

    for (const response of refusals) {
      const body = response.json();
      expect(Object.keys(body)).toEqual(['error']);
      expect(typeof body.error.code).toBe('string');
      expect(body.error.code).toMatch(/^[A-Z][A-Z_]*$/);
      expect(typeof body.error.message).toBe('string');
    }
  });
});
