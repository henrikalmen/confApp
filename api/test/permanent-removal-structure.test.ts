import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * S06's Structural Criteria – the decisions working code could quietly undo (FR5, TI07).
 *
 * Each one guards something a later story could break by writing a perfectly correct-looking
 * change: a second deletion path for the Discard trace, an audit row remembering who removed what,
 * the removal statement drifting back into `post-it-repository.ts` and dragging the author delete's
 * guards with it, a client-side Admin test, a migration nobody needs.
 *
 * Two disciplines from `docs/LEARNINGS.md#testing` run through the file:
 *
 *   - **A SQL-scanning guard reads all three quote styles.** `.prettierrc` sets `singleQuote`, so
 *     Prettier *keeps* double quotes on any string containing an apostrophe - and SQL in these
 *     modules routinely contains `r.state = 'open'`. Under-collecting is the omission that lets one
 *     through.
 *   - **Every file-list assertion is paid for behaviourally.** The claims here are proved through
 *     real requests against real PostgreSQL in `permanent-removal.integration.test.ts`; this file
 *     states the *shape* those requests cannot see.
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

/** All three quote styles, case preserved. See the file note for why all three. */
function sqlStringsIn(source: string): string[] {
  return [
    ...source.matchAll(/`([^`]*)`/g),
    ...source.matchAll(/'([^'\n]*)'/g),
    ...source.matchAll(/"([^"\n]*)"/g),
  ].map((match) => match[1]!);
}

/**
 * A named slice of a file, with the marker it searched for stated - so a slice that silently
 * matched nothing fails here rather than passing every rule vacuously.
 */
function slice(source: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(source)?.[0];
  expect(found, `${what} should be found`).toBeDefined();
  return found!;
}

const removalModule = withoutComments(read(apiSrc, 'rounds', 'permanent-removal-repository.ts'));
const repository = withoutComments(read(apiSrc, 'rounds', 'post-it-repository.ts'));
const routes = withoutComments(read(apiSrc, 'routes', 'rounds.ts'));

/** The removal route's own handler, so nothing below is satisfied by a neighbouring route. */
const removalRoute = slice(
  routes,
  /app\.post\(\s*'[^']*\/permanent-removal',[\s\S]*?\n {2}\);/,
  'the permanent-removal route',
);

// ---------- where the statement lives (TI01, TI07) ----------

describe('the permanent-removal statement', () => {
  /**
   * **Its own module, and the author delete's guards stay on the author delete.**
   *
   * `post-it-structure.test.ts` matches the author's delete with a *first-match* regex,
   * `/delete from post_it p[\s\S]*?returning p\.id/`, and asserts it carries `p.author_sub = $5`
   * and `r.state = 'open'`. A second `delete from post_it` written into that file above it would be
   * matched instead - and would fail a guard that is describing a different statement, or worse
   * pass it by acquiring conditions Permanent Removal must not have.
   */
  it('is outside post-it-repository.ts, where the author delete keeps its own guards', () => {
    expect(repository).not.toMatch(/permanent/i);

    const authorDelete = slice(
      repository,
      /delete from post_it p[\s\S]*?returning p\.id/,
      'the author delete',
    );
    expect(authorDelete).toMatch(/p\.author_sub = \$5/);
    expect(authorDelete).toMatch(/r\.state = 'open'/);

    // And exactly one delete against post_it lives in that file.
    expect([...repository.matchAll(/delete from post_it\b/gi)].length).toBe(1);
  });

  /**
   * **No author condition and no Round-state condition** - the two the author delete has and this
   * one must not (FR5: any Post-it, at any Round state).
   *
   * Copying them across while following the write-path idiom is the mistake this guard exists for,
   * and it is a *silent* one: the removal would keep working for the common case and would quietly
   * stop reaching the Post-its moderation is aimed at.
   */
  it('carries the board identity and neither an author nor a round-state condition', () => {
    const statement = sqlStringsIn(removalModule).find((sql) => /delete from post_it\b/i.test(sql));
    expect(statement, 'the removal statement should be found').toBeDefined();

    // The identity conditions are in the statement, never in a read taken before it.
    expect(statement).toMatch(/\$\{ON_THIS_BOARD\}/);
    expect(removalModule).toMatch(/p\.id = \$4 and p\.round_id = \$3 and p\.conference_id = \$1/);
    expect(removalModule).toMatch(/r\.session_id = \$2/);

    expect(statement).not.toMatch(/author_sub/);
    expect(statement).not.toMatch(/r\.state/);
    expect(removalModule).not.toMatch(/author_sub|r\.state = /);
  });

  /** A delete removes the row. No soft-delete flag, no tombstone, no "removed by" record (FR5). */
  it('deletes rather than flags, and records nothing about the act', () => {
    expect(removalModule).not.toMatch(/deleted_at|is_deleted|tombstone|soft|removed_by|audit/i);
    expect(removalModule).not.toMatch(/insert into|update /i);
    expect(removalRoute).not.toMatch(/removed_by|audit|moderation_log/i);
  });

  /** The post_it table stays reachable from the rounds modules alone – S02's boundary, unmoved. */
  it('lives under rounds/, where the post_it table is reachable', () => {
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => {
        if (relativeTo(apiSrc, path).startsWith('/rounds/')) return false;
        return /\bpost_it\b/.test(withoutComments(readFileSync(path, 'utf8')));
      })
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual([]);
  });

  /** No in-process state between requests (ADR-004). */
  it('holds nothing between requests', () => {
    expect(removalModule, 'a module-level let is request state waiting to happen').not.toMatch(
      /^(let|var)\s/m,
    );
    expect(removalModule, 'a module-level Map/Set is a cache').not.toMatch(
      /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
    );
  });
});

// ---------- the discard trace goes by cascade, not by a second delete (TI02) ----------

describe('the discard trace', () => {
  /**
   * **No source on this path names `post_it_discard`.**
   *
   * S05's `ON DELETE CASCADE` removes the trace with the row. A delete issued here would make one
   * fact true two ways and could drift - and the drift would be invisible, because both versions
   * pass the behavioural test. The behavioural half is
   * `permanent-removal.integration.test.ts`, which reads the cascade off `information_schema`.
   */
  it('is never deleted by this story: the cascade is the only path', () => {
    expect(removalModule).not.toMatch(/post_it_discard/);
    expect(removalRoute).not.toMatch(/post_it_discard|discards\./);

    // And the one delete against the trace in the whole API is still the restore's.
    const traceDeletes = sourcesUnder(apiSrc)
      .flatMap((path) => sqlStringsIn(withoutComments(readFileSync(path, 'utf8'))))
      .filter((sql) => /delete from post_it_discard/i.test(sql));
    expect(traceDeletes.length, 'the restore should be the only delete against the trace').toBe(1);
  });
});

// ---------- one authority path, and none of it on the client (TI03, TI04) ----------

describe('who may remove permanently', () => {
  /**
   * Two primitives decide it and nothing else: the shipped role check and the shipped lifecycle
   * guard. No inline comparison, no second gate, no third concept.
   */
  it('reuses requireConferenceRole and assertEditable and adds no third decision', () => {
    expect(removalRoute).toMatch(/requireConferenceRole\(/);
    expect(removalRoute).toMatch(/holdsConferenceAdmin\(/);
    expect(removalRoute).toMatch(/assertEditable\(/);

    // Nothing in the route decides authority for itself.
    expect(removalRoute).not.toMatch(/role_assignment|session_assignment|\bmembership\b/);
    expect(removalRoute).not.toMatch(/===\s*caller\.sub|caller\.sub\s*===|\.role\s*===/);
    expect(removalRoute).not.toMatch(/ROLE_RANK|rank/);
  });

  /**
   * **The order is what decides which sentence each caller reads**, and it is asserted as an order
   * rather than as a set of ingredients.
   *
   * Sorting authority first, so a caller with no standing learns nothing; the Admin question next,
   * so a Presenter/Facilitator gets the one refusal that offers Discard; editability last, so only
   * an Admin ever learns the Conference is archived.
   */
  it('asks sorting authority, then admin, then editability – in that order', () => {
    const gate = removalRoute.indexOf('requireConferenceRole(');
    const admin = removalRoute.indexOf('holdsConferenceAdmin(');
    const editable = removalRoute.indexOf('assertEditable(');
    const write = removalRoute.indexOf('permanentRemovals.remove(');
    for (const [what, at] of [
      ['the sorting-authority gate', gate],
      ['the admin check', admin],
      ['the editability guard', editable],
      ['the write', write],
    ] as const) {
      expect(at, `${what} should be found`).toBeGreaterThan(-1);
    }
    expect(gate).toBeLessThan(admin);
    expect(admin).toBeLessThan(editable);
    expect(editable).toBeLessThan(write);
  });

  /**
   * **The acting identity is the credential.** The seam has no parameter for an actor, so no body
   * field could reach a column even if the schema admitted one (Binding Constraint FR6). The body
   * schema is deliberately not `additionalProperties: false`: ignored is the stronger statement,
   * and `permanent-removal.integration.test.ts` proves it behaviourally.
   */
  it('takes no actor from the request, and the seam has nowhere to put one', () => {
    expect(removalRoute).not.toMatch(/request\.body|body\./);
    expect(removalRoute).not.toMatch(/schema: \{[^}]*body/);

    const signature = slice(
      removalModule,
      /remove\(\s*conferenceId: string,[\s\S]*?\): Promise<PermanentRemovalOutcome>;/,
      'the seam signature',
    );
    expect(signature).not.toMatch(/sub|actor|admin|author/i);
  });

  /**
   * **The client holds no second opinion**, and the guard is written to survive the fact that
   * `web/` legitimately *names* Admin in places: `MembersPanel` sends `'Admin'` as the value of a
   * grant, and `client.ts` types the role union. Neither is an authority decision. What is
   * forbidden is a *test* - a comparison, a rank, a role read to decide what this client may do.
   */
  it('is decided nowhere under web/', () => {
    const webFiles = sourcesUnder(webSrc);

    const comparing = webFiles
      .filter((path) => {
        const source = withoutComments(readFileSync(path, 'utf8'));
        return (
          /(===|!==|==)\s*['"]Admin['"]/.test(source) ||
          /['"]Admin['"]\s*(===|!==|==)/.test(source) ||
          /\bROLE_RANK\b|\broleRank\b/.test(source)
        );
      })
      .map((path) => relativeTo(webSrc, path));
    expect(comparing, 'a client-side authority comparison').toEqual([]);

    /*
     * And the Board surface names no role at all - not even as a value. It has no grant form and no
     * roster, so any role name appearing there would be one of exactly two things: a comparison, or
     * copy telling somebody what they hold. Both are the second opinion this rule removes.
     */
    for (const path of sourcesUnder(join(webSrc, 'activities'))) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(
        /\bAdmin\b|\bPresenterFacilitator\b|\bAttendee\b/,
      );
    }
  });

  /**
   * The flag is the **server's** answer, consumed exactly as `canRun` is: read off the payload,
   * never defaulted to something computed and never re-derived.
   */
  it('is rendered from a server-supplied flag the client never re-derives', () => {
    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    expect(panel).toMatch(/payload\?\.canRemovePermanently === true/);
    /*
     * No fallback: a `??` or `||` here would be the client inventing an authority answer. Swept
     * across the whole directory, because the flag is no longer read in one file - the control
     * moved into `PermanentRemoval.tsx` and is consumed again by `DiscardedPostIts.tsx`. A guard
     * named "the client never re-derives" has to cover the client, not the file that used to be
     * the client.
     */
    for (const path of sourcesUnder(join(webSrc, 'activities'))) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(/canRemovePermanently\s*(\?\?|\|\|)/);
    }
    // And the server derives it from the same question the write enforces with.
    expect(routes).toMatch(/canRemovePermanently: mayRemovePermanently\(/);
    const flag = slice(
      routes,
      /function mayRemovePermanently\([\s\S]*?\n {2}\}/,
      'the capability flag',
    );
    expect(flag).toMatch(/isEditable\(conference\)/);
    expect(flag).toMatch(/admin/);
  });
});

// ---------- what this story does not touch ----------

describe('this story adds no schema, no vote path and no offline scope', () => {
  /**
   * **No migration.** Everything FR5 needs already falls out of the schema S05 left, so a new
   * table, column, trigger or constraint here would be state duplicating a fact the row's absence
   * already states.
   *
   * Asserted as "the newest migration is still S05's", which is the only form that actually fails
   * when one is added. A later story that legitimately needs a migration updates this line and says
   * why in its own guard.
   */
  it('adds no migration – the newest is still S05’s discard table', () => {
    const migrations = readdirSync(join(repoRoot, 'db', 'migrations'))
      .filter((name) => name.endsWith('.sql'))
      .sort();
    expect(migrations.at(-1)).toBe('20260904090000000_post-it-discard.sql');
    for (const name of migrations) {
      expect(read(repoRoot, 'db', 'migrations', name)).not.toMatch(/permanent/i);
    }
  });

  /** Binding Constraint FR8: nothing added here reads, joins to or exposes vote data (ADR-006). */
  it('reaches no vote table, ballot or per-voter fact', () => {
    for (const [what, source] of [
      ['the removal module', removalModule],
      ['the removal route', removalRoute],
    ] as const) {
      expect(source, what).not.toMatch(/\bvote\b|ballot|tally|voter|has_voted|option/i);
    }
  });

  /**
   * **Binding Constraint FR3: offline support widens by nothing.** A failed Permanent Removal is
   * stated, never held - the sentence the client shows is its own and the device keeps nothing.
   *
   * Both halves: the queue's item kinds are unchanged, and the removal path never reaches it.
   */
  it('queues nothing – the offline post-it queue gained no kind and is not reached', () => {
    /*
     * Every removal handler, not just the panel's: `DiscardedPostIts.tsx` now declares a second
     * `const removePermanently = useCallback(` of its own, and a guard that slices one file by a
     * name two files use is checking whichever one it was written against.
     */
    let handlersChecked = 0;
    for (const path of sourcesUnder(join(webSrc, 'activities'))) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      if (!/const removePermanently = useCallback\(/.test(source)) continue;
      const handler = slice(
        source,
        /const removePermanently = useCallback\([\s\S]*?\n {2}\);/,
        `the removal handler in ${relativeTo(webSrc, path)}`,
      );
      expect(handler, relativeTo(webSrc, path)).not.toMatch(/hold|drain|queue|submissionId|cache/i);
      handlersChecked += 1;
    }
    // Both of them, so this cannot pass by finding none.
    expect(handlersChecked).toBe(2);

    const queue = withoutComments(read(webSrc, 'offline', 'post-it-queue.ts'));
    expect(queue).not.toMatch(/permanent|removePostItPermanently/i);

    const client = withoutComments(read(webSrc, 'api', 'client.ts'));
    const call = slice(
      client,
      /export async function removePostItPermanently\([\s\S]*?\n\}/,
      'the removal client call',
    );
    expect(call).not.toMatch(/hold|queue|submissionId|drain/i);
    expect(call).toMatch(/permanent-removal/);
  });

  /**
   * **The Session-deletion count is untouched.** The behaviour change is a consequence of the row
   * being gone, asserted rather than coded - the statement has no state condition in it at all, and
   * `permanent-removal.integration.test.ts` pins both of its opposite answers.
   */
  it('leaves the session-deletion count unconditional', () => {
    const counting = sqlStringsIn(repository).filter((sql) => /\bcount\(/i.test(sql));
    expect(counting.length, 'the per-session contribution count should be the only count').toBe(1);
    expect(counting[0]).not.toMatch(/discard|deleted|removed|state/i);

    const deletion = withoutComments(read(apiSrc, 'sessions', 'session-deletion.ts'));
    expect(deletion).not.toMatch(/permanent|post_it_discard/i);
  });
});
