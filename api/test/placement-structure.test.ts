import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S03's Structural Criteria – the ones that are properties of the source itself rather than of a
 * request.
 *
 * They read the files on disk on purpose. Each guards a decision a later story could undo **by
 * writing perfectly working code**: a "currently somewhere else" condition added to the placement
 * predicate so a repeat stops succeeding, a pre-check read taken before the write, an offline
 * outbox wired onto the sorting path "for consistency with the compose box", a second cadence for
 * the Board, a drag handle offered as the wide-viewport affordance and then relied on, an author
 * gate relaxed because the two writes now sit on adjacent addresses. None of those would fail a
 * behavioural test, and every one of them would cost the bundle a property it has already decided
 * to have.
 *
 * Every file-list assertion here is paid for behaviourally in `placement.integration.test.ts` and in
 * `web/test/PostItPlacement.test.tsx`, which drive the same properties through real requests against
 * real PostgreSQL and through the real component – because a file list is only as good as its
 * longest omission (`docs/LEARNINGS.md#testing`).
 *
 * **This story adds no migration.** The placement column, its composite foreign key and the trigger
 * that advances the activity cursor on an UPDATE are all S02's
 * (`db/migrations/20260902090000000_category-and-placement.sql`), so there is no schema object here
 * to guard – which is itself asserted below.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Every `.ts`/`.tsx` file under a directory, as absolute paths. */
function sourcesUnder(root: string): string[] {
  const found: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(entry.name)) found.push(path);
    }
  };
  walk(root);
  return found;
}

function relativeTo(root: string, path: string): string {
  return path.replace(root, '').replace(/\\/g, '/');
}

const repository = withoutComments(read(apiSrc, 'rounds', 'post-it-repository.ts'));
const routes = withoutComments(read(apiSrc, 'routes', 'rounds.ts'));
const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
const client = withoutComments(read(webSrc, 'api', 'client.ts'));

/**
 * The placement write, sliced out of the seam that owns it.
 *
 * Every assertion below names the marker it searched for, so a slice that silently matched nothing
 * fails here rather than passing every rule vacuously (`docs/LEARNINGS.md#testing`).
 */
function placementWrite(): string {
  const slice = /async place\([\s\S]*?\n {4}\},/.exec(repository)?.[0];
  expect(slice, 'the placement write should be found in post-it-repository.ts').toBeDefined();
  return slice!;
}

/** The panel's placement handler, sliced out of the surface that owns it. */
function placementHandler(): string {
  const slice = /const place = useCallback\([\s\S]*?\n {2}\);/.exec(panel)?.[0];
  expect(slice, 'the panel’s placement handler should be found').toBeDefined();
  return slice!;
}

/** The client's placement call, sliced out of the module that owns it. */
function placementCall(): string {
  const slice = /export async function placePostIt\([\s\S]*?\n\}/.exec(client)?.[0];
  expect(slice, 'placePostIt should be found in client.ts').toBeDefined();
  return slice!;
}

/** The placement route's registration and handler. */
function placementRoute(): string {
  const slice = /app\.patch\(\s*'[^']*\/placement',[\s\S]*?\n {2}\);/.exec(routes)?.[0];
  expect(slice, 'the placement route should be found in routes/rounds.ts').toBeDefined();
  return slice!;
}

// ---------- the predicate carries every condition, and only the right ones (TI01) --------------

describe('the placement write', () => {
  it('is one guarded statement whose predicate is a flat conjunction of placement conditions', () => {
    const write = placementWrite();

    // Exactly one SQL statement in the write itself. A second one here would be the pre-check read
    // whose window this shape exists to remove.
    expect(write.match(/update post_it p/g)?.length, 'one update, and only one').toBe(1);
    expect(write, 'no read is taken before the write').not.toMatch(/select [\s\S]*?update post_it/);

    // Identity: this Post-it, on this Round, of this Session, in this Conference.
    for (const condition of [
      'p.id = $4',
      'p.round_id = $3',
      'p.conference_id = $1',
      'r.session_id = $2',
    ]) {
      expect(write, condition).toContain(condition);
    }

    // The destination is a Category of this Round's own Board, checked in the statement itself -
    // never by a read the route makes first, which two replicas would each pass.
    expect(write).toMatch(/from category c\s*\n?\s*where c\.id = \$5::uuid and c\.round_id/);
    // Uncategorised is the absence of a placement and is admitted as one: no sentinel id anywhere.
    expect(write).toContain('$5::uuid is null');
  });

  /**
   * **The no-op placement is not expressed as a predicate**, which is the single easiest way to get
   * this write wrong.
   *
   * A statement conditioned on the Post-it not already being in the destination matches zero rows
   * on a repeat, which is indistinguishable from "the Post-it is gone" - and FR3 says the repeat
   * **succeeds**. Proved behaviourally in `placement.integration.test.ts`; pinned here because the
   * condition would be a natural-looking optimisation to add.
   */
  it('carries no “currently somewhere else” condition, so a repeat matches its own row', () => {
    const write = placementWrite();
    expect(write).not.toMatch(/category_id\s*(<>|!=|is distinct from)/i);
    expect(write).not.toMatch(/category_id\s*is not null/i);
  });

  /**
   * **No author condition and no Round-state condition**, and each absence is a rule.
   *
   * Sorting is not the author's write - a Facilitator places other people's ideas - and it is
   * permitted while the Round is open, after it closes and after a reopen (FR3). A conjunct of
   * either kind would silently narrow the feature to a subset of what the PRD asks for.
   */
  it('carries no author condition and no round-state condition', () => {
    const write = placementWrite();
    expect(write).not.toMatch(/author_sub/);
    expect(write).not.toMatch(/r\.state/);
    expect(write).not.toMatch(/closed_at/);
  });

  /**
   * **No version predicate.** Concurrent placements are last-write-wins per Post-it with no conflict
   * UI (`prd.md#edge-cases`), so optimistic concurrency is the wrong tool here - and a version
   * compared in the predicate would make one of two simultaneous sorters read a refusal the product
   * says they must not be shown.
   */
  it('holds no version, revision or precondition token', () => {
    const write = placementWrite();
    expect(write).not.toMatch(/\bversion\b|\brevision\b|if_match|expected_/i);
  });

  it('uses plain PostgreSQL only', () => {
    const write = placementWrite();
    expect(write).not.toMatch(/create\s+extension/i);
    expect(write).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  /**
   * **This story adds no schema object, and could not need one.**
   *
   * The placement column, the composite foreign key that makes a cross-Board destination unwritable
   * and the trigger that advances the activity cursor on an UPDATE are all S02's, defined exactly
   * once. A second definition of any of them - a duplicate column, a placement-specific trigger -
   * would be the second mechanism this bundle's shared decisions removed, and it would be invisible
   * to every behavioural test because it would work.
   */
  it('leaves the placement column, its foreign key and its cursor trigger defined exactly once', () => {
    const migrations = readdirSync(join(repoRoot, 'db', 'migrations')).filter((name) =>
      name.endsWith('.sql'),
    );
    expect(migrations.length, 'the migrations should be found').toBeGreaterThan(0);

    const ups = migrations.map((name) => {
      const raw = read(repoRoot, 'db', 'migrations', name);
      // Split before comments are stripped - `-- Down Migration` is itself a comment line.
      const [up] = raw.split(/^-- Down Migration$/m) as [string, string];
      return up.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
    });

    const occurrences = (pattern: RegExp): number =>
      ups.reduce((total, up) => total + (up.match(pattern)?.length ?? 0), 0);

    expect(occurrences(/add column category_id/gi), 'the placement column').toBe(1);
    expect(occurrences(/post_it_placed_on_its_own_round/gi), 'its foreign key').toBe(1);
    // One trigger on `post_it`, and it is S02's - a placement is an UPDATE it already covers.
    expect(occurrences(/create trigger \w+ *\n? *after[\s\S]{0,80}on post_it\b/gi)).toBe(1);
  });
});

// ---------- the author's own writes are untouched (Structural Criterion) -----------------------

describe('the shipped author paths are unchanged', () => {
  it('keeps the authorship and open-round guards inside the author writes’ own predicates', () => {
    for (const [name, marker] of [
      ['edit', /update post_it p\s*\n\s*set text = \$6[\s\S]*?returning p\.id/],
      ['remove', /delete from post_it p[\s\S]*?returning p\.id/],
    ] as [string, RegExp][]) {
      const statement = marker.exec(repository)?.[0];
      expect(statement, `the ${name} statement should be found`).toBeDefined();
      expect(statement, name).toContain('p.author_sub = $5');
      expect(statement, name).toContain("r.state = 'open'");
    }
  });

  /**
   * **The two authorities stay apart**, which is the whole reason placement is its own route.
   *
   * Contributing, correcting and removing a Post-it are the author's writes under Membership;
   * placing one is the Facilitator's under the sorting-authority gate. One address carrying both is
   * how a Facilitator ends up able to edit somebody's words.
   */
  it('gates the author writes on membership and the placement on sorting authority', () => {
    expect(placementRoute()).toContain('await authorizeWrite(request, caller)');
    expect(placementRoute()).not.toContain('authorizeContribution');

    for (const marker of [
      /app\.post\('\/api[^']*\/post-its',[\s\S]*?\n {2}\}\);/,
      /app\.patch\(\s*'\/api[^']*\/post-its\/:postItId',[\s\S]*?\n {2}\);/,
      /app\.delete\(\s*'\/api[^']*\/post-its\/:postItId',[\s\S]*?\n {2}\);/,
    ]) {
      const route = marker.exec(routes)?.[0];
      expect(route, 'each author route should be found').toBeDefined();
      expect(route).toContain('authorizeContribution(request, caller)');
    }
  });
});

// ---------- sorting is online-only: the queueing seam is unreachable from it -------------------

describe('nothing on the placement path can queue', () => {
  /**
   * **No placement path reaches `web/src/offline/`.**
   *
   * Sorting is online-only (Binding Constraint FR3), so a placement that cannot be delivered fails
   * visibly and the Board stays as it was. The panel does import from that folder - `contribute` is
   * the one write on the surface with somewhere to go - so the guard is scoped to the placement
   * handler and the client call rather than to the file, exactly as S02's Category guard is.
   */
  it('holds nothing, mints no submission identity and touches no store', () => {
    for (const [name, slice] of [
      ['the panel’s placement handler', placementHandler()],
      ['the client’s placement call', placementCall()],
      ['the placement route', placementRoute()],
      ['the placement write', placementWrite()],
    ] as [string, string][]) {
      expect(slice, name).not.toMatch(/hold\(|holdPostIt|mintSubmissionId|submissionId/i);
      expect(slice, name).not.toMatch(/mayStillBeDelivered|queue|outbox|replay|pendingWrite/i);
      expect(slice, name).not.toMatch(/localStorage|indexedDB|caches\./);
    }
  });

  /** And the queue's own modules know nothing about a placement. */
  it('leaves the offline modules knowing nothing about a placement', () => {
    const offline = sourcesUnder(join(webSrc, 'offline'));
    expect(offline.length, 'the offline modules should be found').toBeGreaterThan(0);
    for (const path of offline) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(/placement|placePostIt|categor/i);
    }
    // The list is not stale: the two modules the queue is actually built from are still there.
    const names = offline.map((path) => basename(path));
    for (const name of ['post-it-queue.ts', 'use-post-it-queue.ts']) {
      expect(names, `${name} should still exist`).toContain(name);
    }
  });
});

// ---------- one cadence, one cursor (Structural Criterion) -------------------------------------

describe('this story adds no second near-live mechanism', () => {
  it('introduces no interval, timer or cursor of its own', () => {
    // Exactly one poll loop under web/, and it is the shipped one.
    const definitions = sourcesUnder(webSrc).filter((path) =>
      /export function useWatermarkPoll/.test(readFileSync(path, 'utf8')),
    );
    expect(definitions.map((path) => relativeTo(webSrc, path))).toEqual([
      '/poll/use-watermark-poll.ts',
    ]);

    // The panel mounts it once. A second instance is a second cadence, whatever it polls.
    expect(panel.match(/useWatermarkPoll\(/g)?.length).toBe(1);
    expect(panel).not.toMatch(/setInterval|setTimeout/);

    // No second watermark route, and none scoped to a Post-it or a placement.
    expect(routes.match(/activities\/watermark/g)?.length).toBe(1);
    expect(routes).not.toMatch(/post-its\/watermark|placement\/watermark|board\/watermark/);

    // And nothing on the placement path carries a cursor of its own for a client to poll.
    expect(placementRoute()).not.toMatch(/watermark|cursor|since|etag/i);
    expect(placementCall()).not.toMatch(/watermark|cursor|since|etag/i);
  });
});

// ---------- vote anonymity is untouched (Binding Constraint FR8) -------------------------------

describe('nothing on the placement path reaches vote data', () => {
  it('names no vote table, ballot or per-voter fact', () => {
    for (const [name, slice] of [
      ['the placement write', placementWrite()],
      ['the placement route', placementRoute()],
      ['the placement refusal', /function refusePlacement\([\s\S]*?\n\}/.exec(routes)?.[0] ?? ''],
      ['the client’s placement call', placementCall()],
      ['the panel’s placement handler', placementHandler()],
    ] as [string, string][]) {
      expect(slice.length, `${name} should be found`).toBeGreaterThan(0);
      expect(slice, name).not.toMatch(/\bvote\b|votes\b|ballot|voter|has_voted|tally/i);
    }
  });
});

// ---------- refusals, and the body that names nobody (TI02) ------------------------------------

describe('the placement route', () => {
  it('declares every refusal it adds through the shared error envelope', () => {
    const errors = read(apiSrc, 'errors.ts');
    const refusal = /function refusePlacement\([\s\S]*?\n\}/.exec(routes)?.[0];
    expect(refusal, 'the placement refusal should be found').toBeDefined();

    const raised = [...refusal!.matchAll(/ERROR_CODES\.(\w+)/g)].map((match) => match[1]!);
    // `postItNotFound()` is the shared builder, so the slice names one code directly and reuses one.
    expect(refusal).toContain('postItNotFound()');
    expect(raised.length).toBeGreaterThan(0);
    for (const code of raised) {
      expect(errors, `${code} should be declared in errors.ts`).toMatch(
        new RegExp(`^\\s{2}${code}:`, 'm'),
      );
    }

    /*
     * **No refusal on this path carries a count**, and none discloses anything about a Board the
     * caller has no authority over. A cross-Board refusal that named the other Board's Category
     * would hand a Facilitator a fact about a Session they may not run.
     */
    const messages = [...refusal!.matchAll(/'([^']*)'/g)].map((match) => match[1]!).join(' ');
    expect(messages).not.toMatch(/\$\{|\d/);
  });

  /**
   * The body names the destination and **nothing about who is acting**.
   *
   * Deliberately not `additionalProperties: false`: a request carrying an `actorSub` is accepted and
   * never read, which is the stronger statement and the one asserted behaviourally in
   * `placement.integration.test.ts`. What is pinned here is that the schema declares no such
   * property for one to arrive through.
   */
  it('takes a body naming one destination and no actor', () => {
    const schema = /const placementBodySchema = \{[\s\S]*?\} as const;/.exec(routes)?.[0];
    expect(schema, 'the placement body schema should be found').toBeDefined();
    expect(schema).toContain('categoryId');
    expect(schema).not.toMatch(/author|actor|\bsub\b|email|user|facilitator/i);
    // `null` is admitted so it stays `null` - Uncategorised travels as an absence, never as an id.
    expect(schema).toContain("{ type: 'null' }");

    // And the handler takes the actor from the credential, never from the body.
    const route = placementRoute();
    expect(route).toContain('caller.sub');
    expect(route).not.toMatch(/body[\s\S]*?(actorSub|authorSub|userSub|email)/);
  });

  it('is registered under the sorting-authority gate and authenticated', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const base = '/api/conferences/:conferenceId/sessions/:sessionId';
      const url = `${base}/rounds/:roundId/post-its/:postItId/placement`;
      const registered = app.confappRoutes.find(
        (route) => route.method === 'PATCH' && route.url === url,
      );
      expect(registered, `PATCH ${url} should be registered`).toBeDefined();
      expect(registered!.authenticated).toBe(true);
    } finally {
      await app.close();
    }
  });
});

// ---------- the interaction model has no pointer-only half (Binding Constraint FR3) ------------

describe('the placement control is not drag-driven', () => {
  it('offers no drag handle, drop target or pointer-only affordance anywhere in the SPA', () => {
    expect(sourcesUnder(webSrc).length, 'web/src should hold sources').toBeGreaterThan(0);
    for (const path of sourcesUnder(webSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(
        /draggable|onDrag[A-Z]|onDrop|dataTransfer|dragstart|dragover/i,
      );
    }
  });

  /**
   * The control is a labelled destination list and a button, and both name the Post-it they act on.
   *
   * The accessible name is the part a later change is most likely to drop - it is invisible on
   * screen - and S02's review already found every Category control missing one. This story does not
   * compound that gap.
   */
  it('gives the destination control a label and the commit control an accessible name', () => {
    const markup = /<div className="move"[\s\S]*?<\/div>/.exec(panel)?.[0];
    expect(markup, 'the placement control should be found in the panel').toBeDefined();

    expect(markup).toMatch(/htmlFor=\{`move-to-\$\{postIt\.id\}`\}/);
    expect(markup, 'the label names the post-it it moves').toMatch(/Move “\{label\}” to/);
    expect(markup, 'the commit control carries a name of its own').toMatch(
      /aria-label=\{`Move “\$\{label\}”/,
    );
    expect(markup).not.toMatch(/draggable|onDrag|onDrop/i);
  });
});
