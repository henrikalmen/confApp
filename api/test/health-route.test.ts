import { describe, expect, it, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.ts';
import { createDatabase } from '../src/db.ts';
import { fakeDatabase } from './fake-db.ts';

describe('GET /api/health', () => {
  const apps: FastifyInstance[] = [];

  afterEach(async () => {
    await Promise.all(apps.splice(0).map((app) => app.close()));
  });

  /**
   * Acceptance Scenario S03 – an invalid query parameter is rejected by the validation entry
   * point *before* handler logic runs, which is why the database must not have been touched.
   */
  it('rejects verbose=maybe with VALIDATION_FAILED naming the field, issuing no query', async () => {
    const db = fakeDatabase();
    const app = buildApp({ db });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health?verbose=maybe' });

    expect(response.statusCode).toBe(400);
    const body = response.json();
    expect(body.error.code).toBe('VALIDATION_FAILED');
    expect(body.error.message).toMatch(/\.$/);
    expect(body.error.details).toEqual([
      { field: 'verbose', message: expect.stringContaining('true') },
    ]);
    // The whole point of a shared entry point: handler logic never ran.
    expect(db.calls).toHaveLength(0);
  });

  it('accepts verbose=true', async () => {
    const app = buildApp({ db: fakeDatabase() });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health?verbose=true' });

    expect(response.statusCode).toBe(200);
    expect(response.json().database.reachable).toBe(true);
  });

  /**
   * Acceptance Scenario S01 (handler half) – the schema version is read from the database
   * rather than being a handler-side constant, and an omitted `verbose` gives the concise
   * payload instead of erroring.
   */
  it('returns the schema version the database supplied, not a constant', async () => {
    const db = fakeDatabase(() => [{ value: '99-from-the-database' }]);
    const app = buildApp({ db });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.schemaVersion).toBe('99-from-the-database');
    expect(db.calls[0]?.values).toEqual(['schema_version']);
    // Concise by default.
    expect(body).not.toHaveProperty('database');
    expect(body).not.toHaveProperty('uptimeSeconds');
    expect(Number.isNaN(Date.parse(body.serverTime))).toBe(false);
  });

  /**
   * Acceptance Scenario S07 – consecutive requests to the same long-lived process do not leak
   * state between each other. Under a long-running container this is the tempting mistake, and
   * S05's rate limiter later depends on the rule holding from the start.
   */
  it('does not let a previous verbose=true request influence the next request', async () => {
    const app = buildApp({ db: fakeDatabase() });
    apps.push(app);

    const verbose = await app.inject({ method: 'GET', url: '/api/health?verbose=true' });
    const concise = await app.inject({ method: 'GET', url: '/api/health' });

    expect(verbose.json()).toHaveProperty('database');
    expect(concise.json()).not.toHaveProperty('database');
    expect(concise.json()).not.toHaveProperty('uptimeSeconds');
  });

  it('computes each response timestamp for its own request', async () => {
    const app = buildApp({ db: fakeDatabase() });
    apps.push(app);

    const first = await app.inject({ method: 'GET', url: '/api/health' });
    await new Promise((resolve) => setTimeout(resolve, 15));
    const second = await app.inject({ method: 'GET', url: '/api/health' });

    expect(Date.parse(second.json().serverTime)).toBeGreaterThan(
      Date.parse(first.json().serverTime) - 1,
    );
    expect(second.json().serverTime).not.toBe(first.json().serverTime);
  });

  /**
   * Acceptance Scenario S09 – after `docker compose down -v` the database comes up empty and
   * migrate-up is required before health returns 200. A reachable-but-unmigrated database is a
   * readiness state, so it is a refusal rather than an internal error.
   */
  it('reports an unmigrated database as 503, not as an internal error', async () => {
    const undefinedTable = Object.assign(new Error('relation "app_meta" does not exist'), {
      code: '42P01',
    });
    const db = fakeDatabase(() => {
      throw undefinedTable;
    });
    const app = buildApp({ db });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe('DATABASE_UNAVAILABLE');
    expect(response.json().error.message).toMatch(/migrat/i);
  });

  it('still reports an unexpected database error as INTERNAL_ERROR', async () => {
    // A mistyped table name in a later story must not be disguised as an outage.
    const db = fakeDatabase(() => {
      throw Object.assign(new Error('syntax error at or near "slect"'), { code: '42601' });
    });
    const app = buildApp({ db });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(500);
    expect(response.json().error.code).toBe('INTERNAL_ERROR');
  });

  /**
   * Acceptance Scenario S04 – database unavailability is a refusal, not a crash or an
   * internal-detail leak. Per the FIS testing strategy the connection points at a closed port
   * rather than stopping a container, so the whole suite still runs in one command.
   */
  it('reports an unreachable database as 503 DATABASE_UNAVAILABLE and keeps serving', async () => {
    const silent = { error: () => {} };
    // Port 1 is reserved and never listening.
    const db = createDatabase('postgres://confapp:confapp@127.0.0.1:1/confapp', silent);
    const app = buildApp({ db });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(503);
    const body = response.json();
    expect(body.error.code).toBe('DATABASE_UNAVAILABLE');
    expect(body.error.message).toMatch(/\.$/);

    // No driver text, connection string, host name, or stack trace.
    const payload = response.payload;
    expect(payload).not.toMatch(/ECONNREFUSED|127\.0\.0\.1|postgres:\/\/|password|at Socket/i);

    // The process is still serving: a second request gets the same well-formed refusal.
    const again = await app.inject({ method: 'GET', url: '/api/health' });
    expect(again.statusCode).toBe(503);
    expect(again.json().error.code).toBe('DATABASE_UNAVAILABLE');
  });
});
