import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { ERROR_CODES } from '../src/errors.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S08's Structural Criteria – the ones that are properties of the source rather than of a request.
 *
 * Each guards a decision a later story could undo by writing code that works and passes every
 * behavioural test: a second Admin count that agrees with S07's until one of them is edited, a
 * membership delete issued outside the transaction the last-Admin rule is evaluated in, an eviction
 * channel added to make revocation "immediate", a queued leave that syncs when the phone comes back.
 * None of those fails a test of the feature.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function sourceFiles(root: string, extension = '.ts'): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(extension)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function relative(path: string, root: string): string {
  return path.replace(root, '').replace(/\\/g, '/');
}

const REVOCATION = 'conferences/membership-repository.ts';

describe('one revocation, shared by both paths', () => {
  /**
   * The Membership row is deleted in exactly one place in the API.
   *
   * Two implementations would be two places for the last-Admin rule, the no-cascade guarantee and
   * the standing clean-up to drift apart – and the drift would be invisible until the day somebody
   * left through the path that had fallen behind.
   */
  it('deletes a membership row from exactly one module', () => {
    const deleters = sourceFiles(apiSrc).filter((path) =>
      /delete from membership/i.test(withoutComments(readFileSync(path, 'utf8'))),
    );

    expect(deleters.map((path) => relative(path, apiSrc))).toEqual([
      '/conferences/membership-repository.ts',
    ]);
  });

  /** And both endpoints reach it through that one operation rather than issuing SQL of their own. */
  it('is what both the leave and the remove endpoint call', () => {
    const routes = withoutComments(read(apiSrc, 'routes', 'members.ts'));

    expect(routes).not.toMatch(/delete from/i);
    expect([...routes.matchAll(/membership\.revoke\(/g)]).toHaveLength(2);
    expect(routes).toMatch(/membership\.revoke\(conference\.id, caller\.sub, 'left'\)/);
    expect(routes).toMatch(/membership\.revoke\(conference\.id, userSub, 'removed'\)/);
  });
});

describe('the last-Admin rule is consumed, never re-implemented', () => {
  /**
   * No Admin count of this story's own. S07 owns the rule, and it already needs a row lock to be
   * correct – a second copy is how the third caller gets it subtly wrong.
   */
  it('runs no admin-count query anywhere in this story’s modules', () => {
    for (const module of [REVOCATION, 'routes/members.ts']) {
      const code = withoutComments(read(apiSrc, ...module.split('/')));

      expect(code, module).not.toMatch(/count\(\*\)/i);
      expect(code, module).not.toMatch(/role\s*=\s*'Admin'/);
    }

    const revocation = withoutComments(read(apiSrc, ...REVOCATION.split('/')));
    expect(revocation).toMatch(/assertConferenceKeepsAnAdmin\(/);
    expect(revocation).toMatch(
      /import \{ assertConferenceKeepsAnAdmin, lockConference \} from '\.\/role-repository\.ts'/,
    );
  });

  /**
   * The check and the write share one transaction, and the check comes *after* the deletes.
   *
   * A handler that checked first and revoked afterwards would be two round trips with nothing
   * holding between them: two concurrent departures would each observe the other still standing.
   * This asserts the shape that makes that impossible – lock, delete, assert, all inside one
   * `db.transaction` – rather than trusting a comment that says so.
   */
  it('evaluates it inside the revoking transaction, under S07’s lock, after the deletes', () => {
    const code = withoutComments(read(apiSrc, ...REVOCATION.split('/')));

    const transaction = code.indexOf('db.transaction(');
    const lock = code.indexOf('lockConference(');
    const membershipDelete = code.indexOf('delete from membership');
    const roleDelete = code.indexOf('delete from role_assignment');
    const assertion = code.indexOf('assertConferenceKeepsAnAdmin(');

    for (const [name, index] of Object.entries({
      transaction,
      lock,
      membershipDelete,
      roleDelete,
      assertion,
    })) {
      expect(index, name).toBeGreaterThan(-1);
    }
    expect(transaction).toBeLessThan(lock);
    expect(lock).toBeLessThan(membershipDelete);
    expect(membershipDelete).toBeLessThan(roleDelete);
    expect(roleDelete).toBeLessThan(assertion);

    // Nothing is issued against the pool inside the operation – every statement is on the `tx`.
    expect(code).not.toMatch(/db\.query\(/);
  });

  /** The rule the handlers must *not* pre-empt: no last-Admin decision above the transaction. */
  it('is not duplicated in the handlers', () => {
    const routes = withoutComments(read(apiSrc, 'routes', 'members.ts'));
    expect(routes).not.toMatch(/assertConferenceKeepsAnAdmin|LAST_ADMIN/);
  });
});

describe('the endpoints this story adds', () => {
  it('exist, and both run behind S02’s authenticated-caller wrapper', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const routes = app.confappRoutes.filter(
        (route) =>
          route.url === '/api/conferences/:conferenceId/membership' ||
          route.url === '/api/conferences/:conferenceId/members/:userSub',
      );

      expect(routes.map((route) => `${route.method} ${route.url}`).sort()).toEqual([
        'DELETE /api/conferences/:conferenceId/members/:userSub',
        'DELETE /api/conferences/:conferenceId/membership',
      ]);
      // Wrapped, so the `hd` claim is verified server-side on every request (ADR-002).
      for (const route of routes) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  /**
   * Every authorization decision goes through the canonical check.
   *
   * Including the leave endpoint, whose subject is the caller themselves: it asks for the lowest
   * rank there is rather than comparing a `sub` to a row, so there is one seam and not two.
   */
  it('decide authority only through requireConferenceRole', () => {
    const routes = withoutComments(read(apiSrc, 'routes', 'members.ts'));

    expect(routes).toMatch(/requireConferenceRole\(caller, conferenceId, 'Attendee'\)/);
    expect(routes).toMatch(/requireConferenceRole\(caller, conferenceId, 'Admin'\)/);

    // The shapes an inline comparison takes.
    expect(routes).not.toMatch(/createdBySub\s*===/);
    expect(routes).not.toMatch(/===\s*caller\.sub/);
    expect(routes).not.toMatch(/caller\.sub\s*===/);
    expect(routes).not.toMatch(/\.role\s*===/);
    expect(routes).not.toMatch(/lifecycleState\s*===\s*'archived'/);
  });

  /** The archived refusal is S03's exported guard, not a re-derived lifecycle comparison. */
  it('refuse an archived conference through S03’s guard', () => {
    const routes = withoutComments(read(apiSrc, 'routes', 'members.ts'));
    expect(routes).toMatch(/import \{ assertEditable \} from '\.\.\/conferences\/lifecycle\.ts'/);
    expect(routes).toMatch(/assertEditable\(conference\)/);
  });

  /** Every refusal leaves through S01's envelope – no module here builds a reply of its own. */
  it('emit every refusal through the shared error envelope', () => {
    for (const module of [REVOCATION, 'routes/members.ts']) {
      const code = withoutComments(read(apiSrc, ...module.split('/')));
      expect(code, module).not.toMatch(/reply\.(status|code|send)/);
    }

    // The two codes this story's refusals carry are both existing, distinct ones: the rule and the
    // guard it consumes are S07's and S03's, so neither needed a code of its own.
    expect(ERROR_CODES.CONFERENCE_LAST_ADMIN).not.toBe(ERROR_CODES.CONFERENCE_NOT_EDITABLE);
  });
});

describe('nothing is evicted, and nothing is queued', () => {
  /**
   * Access is re-derived from Membership on every request, so there is nothing to evict.
   *
   * A push, a socket teardown or a token blacklist would be new infrastructure for a guarantee the
   * PRD explicitly declines ("access ends at the next request; no live eviction"), and it would be
   * the kind of thing that gets added later "to make it immediate".
   */
  it('introduces no session invalidation, push or connection teardown in the API', () => {
    for (const path of sourceFiles(apiSrc)) {
      const code = withoutComments(readFileSync(path, 'utf8'));
      const where = relative(path, apiSrc);

      expect(code, where).not.toMatch(/websocket|socket\.io|server-sent|eventsource/i);
      expect(code, where).not.toMatch(/revokeSession|invalidateSession|blacklist|logoutUser/i);
      expect(code, where).not.toMatch(/sendPush|pushNotification|fcm|apns/i);
    }
  });

  /** Leaving is not available offline: nothing about it is queued, retried later or synced. */
  it('queues no revocation anywhere in the web client', () => {
    const webSrc = join(repoRoot, 'web', 'src');
    const leaveSurfaces = sourceFiles(webSrc)
      .concat(sourceFiles(webSrc, '.tsx'))
      .filter((path) => /leaveConference|LeaveConference/.test(readFileSync(path, 'utf8')));

    expect(leaveSurfaces.length).toBeGreaterThan(0);
    for (const path of leaveSurfaces) {
      const code = withoutComments(readFileSync(path, 'utf8'));
      const where = relative(path, webSrc);

      // Word-bounded, so `async` is not mistaken for a sync mechanism.
      expect(code, where).not.toMatch(/\b(queue|queued|outbox|retryLater|sync|resync)\b/i);
      expect(code, where).not.toMatch(/localStorage|indexedDB|serviceWorker/i);
    }
  });
});

describe('the schema', () => {
  /**
   * This story adds no migration: it revokes against the tables S03 created, and the delete rules
   * it depends on were already declared there. The assertion is that it stayed that way – a new
   * migration here would mean the revocation grew a table of its own (a tombstone, an audit row),
   * which is exactly what "no trace of having left" rules out.
   */
  it('is unchanged by this story, and uses plain PostgreSQL throughout', () => {
    const migrations = readdirSync(join(repoRoot, 'db', 'migrations')).filter((name) =>
      name.endsWith('.sql'),
    );

    expect(migrations).toEqual([
      '20260816120000000_app-meta.sql',
      '20260817090000000_app-user.sql',
      '20260817120000000_conference.sql',
      '20260817150000000_session.sql',
      '20260817180000000_join-code.sql',
      '20260817210000000_session-assignment.sql',
    ]);

    for (const name of migrations) {
      // Comments explain that the rule is followed; matching them would assert the prose.
      const sql = read(repoRoot, 'db', 'migrations', name).replace(/^\s*--.*$/gm, '');
      expect(sql, name).not.toMatch(/create extension/i);
    }
  });

  /** No cascading delete rule is *declared* against a user or a membership in any migration. */
  it('declares no new cascading rule reaching a user or a membership', () => {
    const declarations: string[] = [];

    for (const name of readdirSync(join(repoRoot, 'db', 'migrations'))) {
      if (!name.endsWith('.sql')) continue;
      const sql = read(repoRoot, 'db', 'migrations', name).replace(/^\s*--.*$/gm, '');

      for (const [line] of sql.matchAll(/^.*references\s+(app_user|membership).*$/gim)) {
        if (/on delete (cascade|set null)/i.test(line))
          declarations.push(`${name}: ${line.trim()}`);
      }
    }

    // The one exception, declared by S05 for the join limiter's own bookkeeping. It is not a record
    // of what anybody did in a conference, and no revocation path deletes an `app_user` row, so it
    // cannot fire. Named rather than filtered out, so a *new* cascading rule fails here.
    expect(declarations).toEqual([
      '20260817180000000_join-code.sql: user_sub     text        NOT NULL REFERENCES app_user (sub) ON DELETE CASCADE,',
    ]);
  });
});
