import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { ERROR_CODES } from '../src/errors.ts';
import { CONFERENCE_ROLES } from '../src/conferences/authorization.ts';
import { GRANTABLE_ROLES } from '../src/conferences/role-repository.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S07's Structural Criteria – the ones that are properties of the source rather than of a request.
 *
 * Each guards a decision a later story could undo by writing perfectly working code: a second role
 * check, a fourth role, a permission cache, a directory-group lookup. None of those would fail a
 * behavioural test, which is exactly why they are asserted against the files themselves.
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

function withoutSqlComments(source: string): string {
  return source.replace(/^\s*--.*$/gm, '');
}

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith('.ts')) found.push(path);
    }
  };
  walk(apiSrc);
  return found;
}

function relative(path: string): string {
  return path.replace(apiSrc, '').replace(/\\/g, '/');
}

/** Every module that handles a request for a conference-scoped surface (S03–S07). */
const HANDLER_MODULES = [
  'routes/conferences.ts',
  'routes/sessions.ts',
  'routes/join-code.ts',
  'routes/attendee.ts',
  'routes/members.ts',
];

describe('one canonical role check, and only one', () => {
  it('implements requireConferenceRole exactly once in the whole API', () => {
    const definitions = sourceFiles().filter((path) =>
      /async requireConferenceRole\(/.test(withoutComments(readFileSync(path, 'utf8'))),
    );

    expect(definitions.map(relative)).toEqual(['/conferences/authorization.ts']);
  });

  /** The signature S03 pinned, unchanged – that is what made this story an implementation swap. */
  it('keeps the signature S03 pinned, options and all', () => {
    const helper = read(apiSrc, 'conferences', 'authorization.ts');

    expect(helper).toMatch(/requireConferenceRole\(\s*caller: AuthenticatedCaller,/);
    expect(helper).toMatch(/conferenceId: string,/);
    expect(helper).toMatch(/required: ConferenceRole,/);
    expect(helper).toMatch(/sessionId\?: string/);
  });

  /**
   * No handler decides for itself. A comparison grown inside one of these modules is the failure
   * this seam was created to prevent, and it would still pass every behavioural test.
   */
  it('makes no inline creator or role comparison in any handler module', () => {
    for (const module of HANDLER_MODULES) {
      const code = withoutComments(read(apiSrc, ...module.split('/')));

      expect(code, module).not.toMatch(/createdBySub\s*===/);
      expect(code, module).not.toMatch(/===\s*caller\.sub/);
      expect(code, module).not.toMatch(/caller\.sub\s*===/);
      expect(code, module).not.toMatch(/\.role\s*===/);
      expect(code, module).not.toMatch(/roles\.includes\(/);
    }
  });

  /** And no handler reaches the role tables directly – authority comes through the check. */
  it('reaches the role and membership tables only from the modules that own them', () => {
    // S08's revocation module is an owner too: ending a Membership clears the standing that went
    // with it, and it does so through S07's exported lock and last-Admin rule rather than a role
    // check of its own (`conferences/membership-repository.ts`).
    const owners = [
      '/conferences/authorization.ts',
      '/conferences/role-repository.ts',
      '/conferences/membership-repository.ts',
    ];

    const offenders = sourceFiles().filter((path) => {
      if (owners.includes(relative(path))) return false;
      if (relative(path) === '/conferences/conference-repository.ts') return false;
      return /from role_assignment|into role_assignment|from session_assignment|into session_assignment/.test(
        withoutComments(readFileSync(path, 'utf8')),
      );
    });

    expect(offenders.map(relative)).toEqual([]);
  });
});

describe('three roles, and Presenter/Facilitator is one of them', () => {
  it('has exactly three roles in the TypeScript type', () => {
    expect([...CONFERENCE_ROLES]).toEqual(['Admin', 'PresenterFacilitator', 'Attendee']);
  });

  /** Two grantable roles: Attendee is not granted, it *is* Membership. */
  it('offers exactly two of them on the wire, and neither is a split role', () => {
    expect([...GRANTABLE_ROLES]).toEqual(['Admin', 'PresenterFacilitator']);
  });

  it('constrains the same three in the database', () => {
    const sql = withoutSqlComments(
      read(repoRoot, 'db', 'migrations', '20260817120000000_conference.sql'),
    );
    expect(sql).toMatch(/role IN \('Admin', 'PresenterFacilitator', 'Attendee'\)/);
  });

  /**
   * The role set is not widened by the migration that adds Session Assignment. Splitting the role
   * later would cost a migration, and this is what makes that visible rather than incidental.
   */
  it('is not widened by this story’s migration', () => {
    const sql = withoutSqlComments(
      read(repoRoot, 'db', 'migrations', '20260817210000000_session-assignment.sql'),
    );
    expect(sql).not.toMatch(/role_assignment_role_known/);
    expect(sql).not.toMatch(/ALTER TABLE role_assignment/i);
  });

  /** No separate Presenter or Facilitator role exists as a value anywhere in the API. */
  it('names no Presenter or Facilitator role anywhere in the source', () => {
    for (const path of sourceFiles()) {
      const code = withoutComments(readFileSync(path, 'utf8'));
      expect(code, relative(path)).not.toMatch(/['"]Presenter['"]/);
      expect(code, relative(path)).not.toMatch(/['"]Facilitator['"]/);
    }
  });

  /**
   * A Session's kind never decides authority. Presenting and facilitating are the same role, so a
   * branch on `kind` inside the authorization path would be the split arriving through the back
   * door even with the enum intact.
   */
  it('never consults a session kind when deciding authority', () => {
    for (const module of ['conferences/authorization.ts', 'conferences/role-repository.ts']) {
      const code = withoutComments(read(apiSrc, ...module.split('/')));
      expect(code, module).not.toMatch(/\bkind\b/);
      expect(code, module).not.toMatch(/Presentation|Workshop/);
    }
  });
});

describe('authority comes from confApp’s own rows', () => {
  /**
   * No directory group, anywhere in the authorization path. A directory cannot express "facilitates
   * one workshop, attends the rest" (ADR-002), and the moment a group claim is read the roles stop
   * being confApp's data.
   */
  it('reads no directory group and no group claim', () => {
    for (const module of ['conferences/authorization.ts', 'conferences/role-repository.ts']) {
      const code = withoutComments(read(apiSrc, ...module.split('/')));
      expect(code, module).not.toMatch(/claims\.groups|\.groups\b/);
      expect(code, module).not.toMatch(/directory|admin\.googleapis|cloudidentity/i);
    }
  });

  /** And none is requested at sign-in, so there is no group claim to be tempted by. */
  it('requests no directory scope at sign-in', () => {
    const session = read(repoRoot, 'web', 'src', 'auth', 'session.ts');
    const scope = /scope:\s*'([^']+)'/.exec(session)?.[1];

    expect(scope).toBe('openid email profile');
    expect(scope).not.toMatch(/group|directory|admin/i);
  });

  /**
   * Nothing is remembered between requests. The API runs as several replicas with no request
   * affinity (ADR-004), so a cache here would be wrong on the next replica even if it were fresh
   * on this one – and a revoked role has to bite on the very next call.
   */
  it('holds no role, membership or permission cache in module scope', () => {
    const code = withoutComments(read(apiSrc, 'conferences', 'authorization.ts'));

    // Module-level mutable bindings, and the usual shapes a cache takes.
    expect(code).not.toMatch(/^\s*(let|var)\s/m);
    expect(code).not.toMatch(/new Map\(|new Set\(|new WeakMap\(/);
    expect(code).not.toMatch(/cache/i);

    // The rows are read inside the call, on every call.
    expect(code).toMatch(/await db\.query<GrantRow>\(GRANTS/);
  });
});

describe('the refusals this story introduces', () => {
  /** One code per reason: each names a different thing for the Admin to do next. */
  it('carry a distinct machine code each', () => {
    const codes = [
      ERROR_CODES.CONFERENCE_LAST_ADMIN,
      ERROR_CODES.ROLE_TARGET_NOT_SIGNED_IN,
      ERROR_CODES.ROLE_TARGET_AMBIGUOUS,
      ERROR_CODES.ROLE_TARGET_NOT_A_MEMBER,
      ERROR_CODES.ROLE_ASSIGNMENT_NOT_FOUND,
      ERROR_CODES.SESSION_ASSIGNMENT_ROLE_REQUIRED,
      ERROR_CODES.CONFERENCE_ROLE_REQUIRED,
      ERROR_CODES.CONFERENCE_NOT_EDITABLE,
    ];

    expect(new Set(codes).size).toBe(codes.length);
  });

  /** Every one of them leaves through S01's envelope – no module builds a reply of its own. */
  it('are raised as AppError and never as a bespoke reply', () => {
    for (const module of ['routes/members.ts', 'conferences/role-repository.ts']) {
      const code = withoutComments(read(apiSrc, ...module.split('/')));
      expect(code, module).not.toMatch(/reply\.(status|code|send)/);
      expect(code, module).toMatch(/new AppError\(/);
    }
  });
});

describe('the session assignment migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', '20260817210000000_session-assignment.sql');
  const sql = withoutSqlComments(raw);

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale/i);
  });

  it('is reversible – what it creates it drops again', () => {
    const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

    const created = [...up.matchAll(/create table (\w+)/gi)].map((match) => match[1]);
    const dropped = [...down.matchAll(/drop table (\w+)/gi)].map((match) => match[1]);

    expect(created).toEqual(['session_assignment']);
    expect(new Set(dropped)).toEqual(new Set(created));

    // The constraint it adds to an existing table is dropped again too.
    expect(up).toMatch(/ADD CONSTRAINT sessions_id_conference_unique/);
    expect(down).toMatch(/DROP CONSTRAINT sessions_id_conference_unique/);
  });

  /** Keyed on `sub`, never on email – addresses change and are reissued. */
  it('keys the assignment on the sub claim alone', () => {
    expect(sql).toMatch(/user_sub\s+text\s+NOT NULL REFERENCES app_user \(sub\)/);
    expect(sql).not.toMatch(/email/i);
  });

  /** Scoped to exactly one Conference – no nullable column, no wildcard. */
  it('scopes every row to one conference', () => {
    expect(sql).toMatch(/conference_id\s+uuid\s+NOT NULL/);
    expect(sql).not.toMatch(/conference_id\s+uuid\s+NULL/i);
  });
});

describe('the member routes', () => {
  it('are all registered through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const routes = app.confappRoutes.filter(
        (route) => route.url.includes('/members') || route.url.includes('/assignments'),
      );

      expect(routes.length).toBeGreaterThan(0);
      for (const route of routes) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  it('expose the member list, the grants and the session assignments', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);

      expect(urls).toContain('GET /api/conferences/:conferenceId/members');
      expect(urls).toContain('POST /api/conferences/:conferenceId/members/roles');
      expect(urls).toContain('DELETE /api/conferences/:conferenceId/members/:userSub/roles/:role');
      expect(urls).toContain('POST /api/conferences/:conferenceId/sessions/:sessionId/assignments');
      expect(urls).toContain(
        'DELETE /api/conferences/:conferenceId/sessions/:sessionId/assignments/:userSub',
      );
    } finally {
      await app.close();
    }
  });
});
