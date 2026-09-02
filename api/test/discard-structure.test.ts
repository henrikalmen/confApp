import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S05's Structural Criteria – the ones that are properties of the source itself rather than of a
 * request.
 *
 * They read the files on disk on purpose. Each guards a decision a later story could undo **by
 * writing perfectly working code**: a `discarded_at` column added to `post_it` because it is
 * "simpler", the not-discarded conjunct removed from a Board read that was rewritten, a discarded
 * Post-it filtered out in TypeScript instead of in the statement, a `r.state = 'open'` predicate
 * copied across from the author-delete path, an offline queue item kind wired onto the Discard
 * "for consistency with the compose box", a state condition added to the Session-deletion count.
 * None of those would fail a behavioural test, and every one of them would cost the bundle a
 * property it has already decided to have (ADR-008).
 *
 * Every file-list assertion here is paid for behaviourally in `discard.integration.test.ts` and in
 * `web/test/PostItDiscard.test.tsx`, which drive the same properties through real requests against
 * real PostgreSQL and through the real component – because a file list is only as good as its
 * longest omission (`docs/LEARNINGS.md#testing`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');
const migrations = join(repoRoot, 'db', 'migrations');

const SHIPPED_POST_IT = '20260828120000000_post-it.sql';
const DISCARD_MIGRATION = '20260904090000000_post-it-discard.sql';

function read(...parts: string[]): string {
  return readFileSync(join(...parts), 'utf8');
}

/** Comments explain the rules; matching them would make these tests assert their own prose. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

function withoutSqlComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*--.*$/gm, '');
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

/**
 * Every SQL-looking string in a source file, in **all three quote styles**.
 *
 * A collector that saw only backticks would miss `db.query('select …')` entirely, and skipping
 * double quotes would miss more than it looks: `.prettierrc` sets `singleQuote`, so Prettier *keeps*
 * double quotes on any string containing an apostrophe, and SQL in these modules routinely contains
 * `r.kind = 'PostItRound'`. Over-collecting costs nothing while under-collecting is the omission
 * that lets one through (`vote-structure.test.ts`).
 */
function sqlStringsIn(source: string): string[] {
  return [
    ...source.matchAll(/`([^`]*)`/g),
    ...source.matchAll(/'([^'\n]*)'/g),
    ...source.matchAll(/"([^"\n]*)"/g),
  ].map((match) => match[1]!);
}

const repository = withoutComments(read(apiSrc, 'rounds', 'post-it-repository.ts'));
const discardRepository = withoutComments(read(apiSrc, 'rounds', 'post-it-discard-repository.ts'));
const routes = withoutComments(read(apiSrc, 'routes', 'rounds.ts'));

/**
 * A named slice of a seam, with the marker it searched for stated - so a slice that silently
 * matched nothing fails here rather than passing every rule vacuously
 * (`docs/LEARNINGS.md#testing`).
 */
function slice(source: string, pattern: RegExp, what: string): string {
  const found = pattern.exec(source)?.[0];
  expect(found, `${what} should be found`).toBeDefined();
  return found!;
}

// ---------- the shipped decision is not relaxed (Structural Criterion 2) ----------

describe('the shipped post-it migration', () => {
  const shipped = read(migrations, SHIPPED_POST_IT);

  /**
   * The one sentence this story appears to contradict, still there and still true.
   *
   * It is a statement about **author deletion**, and this story does not weaken it: the Discard is a
   * different act with the opposite requirement, stored in a different table (ADR-008). A future
   * change that answered the contradiction by editing this comment - or by adding the column it
   * refuses - fails here.
   */
  it('still refuses every tombstone, soft-delete flag and deleted_at on the post_it row', () => {
    expect(shipped).toMatch(/any tombstone, soft-delete flag or `deleted_at`/);
    expect(withoutSqlComments(shipped)).not.toMatch(/deleted_at|is_deleted|tombstone|archived/i);
  });

  it('knows nothing about discard, in any migration that touches the post_it row', () => {
    expect(shipped).not.toMatch(/discard/i);

    /*
     * And no migration anywhere puts a Discard-shaped column **on** `post_it`. The only place
     * `discard` may appear in the schema is the trace table's own migration, which adds a table and
     * one ordinary unique constraint rather than a column that says a Post-it is gone.
     */
    for (const name of readdirSync(migrations).filter((file) => file.endsWith('.sql'))) {
      const sql = withoutSqlComments(read(migrations, name));
      if (name === DISCARD_MIGRATION) continue;
      expect(sql, name).not.toMatch(/discard/i);
    }
    const trace = withoutSqlComments(read(migrations, DISCARD_MIGRATION));
    expect(trace).not.toMatch(/alter table post_it\s+add column/i);
  });
});

// ---------- the trace's own migration (TI02) ----------

describe('the discard trace migration', () => {
  const raw = read(migrations, DISCARD_MIGRATION);
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

  it('uses plain PostgreSQL only – no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure_|aws_|neon_|citus/i);
  });

  /**
   * `now()` is transaction-start time, so two writes in one transaction stamp identically and a poll
   * never sees the second (`docs/LEARNINGS.md` → PostgreSQL date/time). `clock_timestamp()` is the
   * only instant this schema takes.
   */
  it('stamps the instant with clock_timestamp() and never with now()', () => {
    expect(sql).toMatch(/discarded_at\s+timestamptz\s+not null\s+default clock_timestamp\(\)/i);
    expect(sql).not.toMatch(/\bnow\s*\(/i);
  });

  /**
   * The author-delete race outcome, as a clause rather than as code.
   *
   * `post-it-repository.ts#remove` carries no Discard predicate and gains no branch; the trace goes
   * because the foreign key says it goes. That is provable from this file alone, which is the
   * property Structural Criterion 3 asks for.
   */
  it('cascades from the post_it row, so an author delete takes the trace with it', () => {
    expect(sql).toMatch(
      /post_it_id\s+uuid\s+primary key references post_it \(id\) on delete cascade/i,
    );
    expect(sql).toMatch(/foreign key \(post_it_id, round_id\)[\s\S]*?on delete cascade/i);
    expect(sql).toMatch(/discarded_by_sub\s+text\s+not null references app_user \(sub\)/i);
  });

  /**
   * The advance is **attached**, never restated. `advance_round_activity_watermark()` is the one
   * named home for it and keys on `NEW.round_id` / `OLD.round_id`, which is why the trace carries a
   * `round_id` at all.
   */
  it('attaches to the shipped watermark function rather than restating the advance', () => {
    expect(sql).toMatch(
      /after insert or delete on post_it_discard[\s\S]*?execute function advance_round_activity_watermark\(\)/i,
    );
    expect(sql).not.toMatch(/nextval|greatest/i);
    // ADR-007 is untouched: nothing vote-derived appears anywhere on this path.
    expect(sql).not.toMatch(/\bvote\b|ballot/i);
  });

  it('is reversible – every object it creates, the down step removes', () => {
    for (const [pattern, dropped] of [
      [/create table post_it_discard/i, /drop table post_it_discard/i],
      [/create index post_it_discard_by_round/i, /drop index post_it_discard_by_round/i],
      [
        /create trigger post_it_discard_advances_activity_watermark/i,
        /drop trigger post_it_discard_advances_activity_watermark/i,
      ],
      [/add constraint post_it_id_round_unique/i, /drop constraint post_it_id_round_unique/i],
    ] as const) {
      expect(up, String(pattern)).toMatch(pattern);
      expect(down, String(dropped)).toMatch(dropped);
    }
  });
});

// ---------- one definition of "not discarded", applied in every statement (TI05) ----------

describe('the read exclusion', () => {
  /**
   * **One fragment, one definition.** The predicate is exported from the module that owns the trace
   * and spliced into every statement that needs it, so "invisible" and "unplaceable" cannot drift
   * apart. A second hand-written `not exists (… post_it_discard …)` anywhere is what this forbids.
   */
  it('is defined exactly once, and no other module writes the table’s name into SQL', () => {
    expect(discardRepository).toMatch(
      /export const NOT_DISCARDED =\s*[\s\S]{0,200}?not exists \(select 1 from post_it_discard/,
    );
    // The repository splices the fragment; it never restates the table.
    expect(repository).not.toMatch(/post_it_discard/);
    expect(routes).not.toMatch(/post_it_discard/);

    const offenders = sourcesUnder(apiSrc)
      .filter((path) => relativeTo(apiSrc, path) !== '/rounds/post-it-discard-repository.ts')
      .filter((path) => /post_it_discard/.test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual([]);
  });

  /**
   * **Every statement in the API that touches `post_it`, classified.**
   *
   * The earlier version of this guard sliced two functions out of one file by name and asserted the
   * fragment appeared in each. That could not fail for a read added anywhere else - `hydrate` in the
   * same module, the three statements in `category-repository.ts`, or anything a later story writes -
   * while its name claimed to close the whole read set. "A file list is only as good as its longest
   * omission" (`docs/LEARNINGS.md#testing`), and the sibling `display-link-structure.test.ts` guard
   * was rewritten for exactly this reason.
   *
   * So this scans **every** SQL string under `api/src`, in all three quote styles, and requires each
   * statement naming `post_it` either to carry the exclusion or to appear in the written list below
   * with a reason. A read added anywhere fails until somebody classifies it, which is the property
   * S06, S07 and S08 read this shared decision through.
   */
  it('is carried by every read that returns post-its, or is written down as an exception', () => {
    /**
     * Statements that legitimately name `post_it` without excluding discarded rows, keyed by a
     * distinctive fragment. Each entry is a claim somebody has to defend.
     */
    const EXCEPTIONS: [key: string, why: string][] = [
      // --- not reads of the Board at all ---
      [
        'count(*)::int as count',
        'the session-deletion count: a discarded post-it still counts (TI07)',
      ],
      [
        'insert into post_it\n',
        'the contribution write; a new post-it cannot already be discarded',
      ],
      ['p.submission_id = $5::uuid', 'the retry resolving onto its own already-stored row'],
      [
        'update post_it p\n            set text = $6',
        'the author’s own correction, on their own post-it',
      ],
      [
        'delete from post_it p\n          using round r',
        'the author’s own deletion – deliberately Discard-unaware (TI06)',
      ],
      [
        'select p.author_sub, r.state',
        'the author-write diagnosis, asked only after a write matched nothing',
      ],
      /*
       * S06's Permanent Removal, and it is the one statement here that must reach a *discarded*
       * Post-it. FR5 says an Admin removes any Post-it in the Conference - on the Board, in a
       * Category, or already Discarded - and the Discard trace goes with the row through S05's
       * `ON DELETE CASCADE`. Excluding discarded rows here would leave exactly the Post-its a
       * moderation act is most likely to be aimed at unreachable, and would leave an orphan trace
       * behind if it ever stopped cascading. Distinguishable from the author's delete above by its
       * own `using` layout: the two are separate statements in separate modules and each is
       * classified on its own.
       */
      [
        'delete from post_it p\n           using round r',
        'permanent removal – deliberately reaches discarded post-its too (S06 TI01)',
      ],
      [
        'where p.id = $1',
        'hydrate: one row a write just produced, returned to that write’s caller',
      ],

      // --- the discard seam’s own statements: the two writes, the diagnosis, and the one read
      //     that selects *on* the trace rather than against it ---
      ['insert into post_it_discard', 'the discard write'],
      ['delete from post_it_discard pd', 'the restore write'],
      [
        'as discarded\n         from post_it p',
        'the discard diagnosis, asked only after a write matched nothing',
      ],
      [
        'from post_it_discard pd\n           join post_it p',
        'the facilitator’s discarded list – the one read that selects on the trace',
      ],

      /*
       * --- and the three that depend on an invariant rather than on the fragment ---
       *
       * All three are correct only while a discarded post-it never carries a `category_id`. That
       * holds because the Discard clears the placement, `place` refuses a discarded post-it, and
       * `restore` clears it again (see `post-it-discard-repository.ts#restore` for the race the
       * third one closes). Written down here so the dependency is a stated claim rather than a
       * coincidence a later change could break silently.
       */
      [
        'count(*)::int as held from post_it',
        'category occupancy count – discarded post-its hold no category',
      ],
      [
        'update post_it set category_id = $2',
        'category-removal reassignment – discarded post-its hold no category',
      ],
      [
        'not exists (select 1 from post_it p where p.category_id',
        'category delete guard – discarded post-its hold no category',
      ],
    ];

    const touching: string[] = [];
    for (const path of sourcesUnder(apiSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      for (const sql of sqlStringsIn(source)) {
        if (!/\bpost_it\b/.test(sql)) continue;
        if (!/\b(from|join|into|update|delete)\b/i.test(sql)) continue;
        touching.push(sql);
      }
    }

    // The guard has to be able to see something, or it passes vacuously.
    expect(touching.length, 'statements naming post_it should be found').toBeGreaterThan(10);

    const unclassified = touching
      .filter((sql) => !sql.includes('${NOT_DISCARDED}'))
      .filter((sql) => !EXCEPTIONS.some(([key]) => sql.includes(key)))
      .map((sql) => sql.replace(/\s+/g, ' ').slice(0, 90));
    expect(
      unclassified,
      'a statement naming post_it neither excludes discarded rows nor is written down as an exception',
    ).toEqual([]);

    // A stale exception is a defect too: every entry must still match something.
    const unmatched = EXCEPTIONS.filter(([key]) => !touching.some((sql) => sql.includes(key))).map(
      ([key]) => key,
    );
    expect(unmatched, 'an exception entry no longer matches any statement').toEqual([]);

    // And the four that do carry the exclusion are still the four that must.
    const excluding = touching.filter((sql) => sql.includes('${NOT_DISCARDED}'));
    expect(excluding.length, 'the reads carrying the exclusion').toBe(4);
  });

  /**
   * In the statement, never in a handler.
   *
   * A post-filter would compute the Board's counts over the wrong set - and would have to be
   * repeated on every surface, with the first one to forget putting a discarded idea back in front
   * of the room. `board-wire.ts` is where such a filter would most naturally be added, since it is
   * the one place every Board's grouping and counting happens, so it is asserted to name Discard
   * nowhere at all.
   */
  it('is never a TypeScript filter over a result set', () => {
    for (const path of sourcesUnder(apiSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(apiSrc, path)).not.toMatch(/\.filter\([^)]*[Dd]iscard/i);
    }
    const projection = withoutComments(read(apiSrc, 'rounds', 'board-wire.ts'));
    expect(projection).not.toMatch(/discard/i);
  });
});

// ---------- placement refuses a discarded post-it at BOTH of its sites (TI03) ----------

/**
 * **The propagated constraint this story is the receiver of, pinned.**
 *
 * The `place` predicate and `diagnosePlacement` are one rule across two sites. Adding the conjunct
 * to the write alone makes a discarded Post-it match zero rows while the diagnosis SELECT still
 * finds it, so the caller is refused with `CATEGORY_NOT_FOUND` – "that category is not on this
 * board" – about a destination that was perfectly valid. Neither `tsc`, `eslint` nor S03's structure
 * guards catch that; these three assertions and
 * `discard.integration.test.ts`'s named discarded case do.
 */
describe('the placement path', () => {
  it('carries the not-discarded conjunct inside its existing predicate', () => {
    const write = slice(repository, /async place\([\s\S]*?\n {4}\},/, 'the placement write');
    expect(write).toContain('${NOT_DISCARDED}');
    // Still one statement: the conjunct is appended, not answered by a read taken first.
    expect(write.match(/update post_it p/g)?.length, 'one update, and only one').toBe(1);
    expect(write).not.toMatch(/select [\s\S]*?update post_it/);
  });

  it('answers the discarded case in the diagnosis rather than calling it a missing category', () => {
    const diagnosis = slice(
      repository,
      /async function diagnosePlacement\([\s\S]*?\n {2}\}/,
      'the placement diagnosis',
    );
    expect(diagnosis).toContain('${NOT_DISCARDED}');
    expect(diagnosis).toMatch(/outcome: 'discarded'/);
  });

  it('gives the outcome union and the route a member for it', () => {
    expect(repository).toMatch(/PlacementOutcome =[\s\S]*?\{ outcome: 'discarded' \}/);
    const refusal = slice(
      routes,
      /function refusePlacement\([\s\S]*?\n\}/,
      'the placement refusal',
    );
    expect(refusal).toMatch(/outcome === 'discarded'/);
    expect(refusal).toMatch(/POST_IT_DISCARDED/);
  });
});

// ---------- the author-delete path is unchanged (TI06, Structural Criterion 3) ----------

describe('the author-delete path', () => {
  it('carries no discard predicate and no discard-aware branch', () => {
    const remove = slice(repository, /async remove\([\s\S]*?\n {4}\},/, 'the author’s own delete');
    expect(remove).not.toMatch(/discard/i);
    expect(remove).not.toContain('${NOT_DISCARDED}');
    // The two guards it does carry are still exactly where they were.
    expect(remove).toMatch(/p\.author_sub = \$5/);
    expect(remove).toMatch(/r\.state = 'open'/);
  });

  /** And the module still refuses the vocabulary of a soft delete, unweakened by this story. */
  it('still matches no deleted_at, is_deleted, tombstone or soft', () => {
    expect(repository).not.toMatch(/deleted_at|is_deleted|tombstone|soft/i);
  });
});

// ---------- the session-deletion decision, pinned (TI07) ----------

describe('the session-deletion count', () => {
  /**
   * A discarded Post-it still counts, **by decision**: its text, its author and its attribution are
   * all intact and restorable, so deleting the Session would destroy something recoverable. The
   * delivery record chose the opposite for a withdrawn submission because there the row is already
   * gone. A later state condition added here would reverse a decision rather than fix a bug.
   */
  it('takes no discard condition, and no state condition of any kind', () => {
    const counting = sqlStringsIn(repository).filter((sql) => /\bcount\(/i.test(sql));
    expect(counting.length, 'the per-session contribution count should be the only count').toBe(1);
    expect(counting[0]).not.toMatch(/discard/i);
    expect(counting[0]).not.toMatch(/r\.state|exists|not in/i);
  });
});

// ---------- the discard seam's own shape (TI03, TI04) ----------

describe('the discard seam', () => {
  it('holds no module-level mutable state and nothing between calls', () => {
    // Module scope is column 0. A `let` or `var` there would be state two replicas disagree about.
    expect(discardRepository).not.toMatch(/^(let|var)\s/m);
    expect(discardRepository).not.toMatch(/^const \w+ = new (Map|Set|WeakMap)\(/m);
  });

  it('takes no round-state condition, unlike the author-delete path', () => {
    for (const sql of sqlStringsIn(discardRepository)) {
      expect(sql).not.toMatch(/r\.state/);
    }
  });

  /** Nothing on any Discard path reaches Vote data (Binding Constraint FR8, ADR-006). */
  it('names no vote table, ballot or per-voter fact', () => {
    for (const source of [
      discardRepository,
      withoutComments(read(webSrc, 'activities', 'DiscardedPostIts.tsx')),
    ]) {
      expect(source).not.toMatch(/\bvote\b|ballot|tally|voter/i);
    }
  });

  it('registers discard, restore and the discarded list, all authenticated', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const base = '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId';
      for (const [method, url] of [
        ['POST', `${base}/post-its/:postItId/discard`],
        ['POST', `${base}/post-its/:postItId/restore`],
        ['GET', `${base}/discarded-post-its`],
      ] as const) {
        const registered = app.confappRoutes.find(
          (route) => route.method === method && route.url === url,
        );
        expect(registered, `${method} ${url} should be registered`).toBeDefined();
        expect(registered!.authenticated).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  /**
   * The discarder is the credential and nothing else (Binding Constraint FR6). Neither write reads a
   * body at all, and neither route declares a body schema one could arrive through.
   */
  it('reads no discarder from a body or a query, and gates all three on the one authority', () => {
    for (const [pattern, what] of [
      [/app\.post\(\s*'[^']*\/discard',[\s\S]*?\n {2}\);/, 'the discard route'],
      [/app\.post\(\s*'[^']*\/restore',[\s\S]*?\n {2}\);/, 'the restore route'],
      /*
       * The list too, and under the **same** gate as the writes rather than a read's. It is the only
       * surface on which a discarded Post-it appears at all, so reading it is as much a Facilitator's
       * act as reversing from it.
       */
      [/app\.get\(\s*'[^']*\/discarded-post-its',[\s\S]*?\n {2}\}\);/, 'the discarded list route'],
    ] as const) {
      const route = slice(routes, pattern, what);
      expect(route, what).not.toMatch(/request\.body|request\.query/);
      expect(route, what).not.toMatch(/schema: \{[^}]*body/);
      expect(route, what).toContain('authorizeWrite');
    }
    expect(routes).toMatch(/discards\.discard\(\s*[\s\S]*?caller\.sub,/);
  });
});

// ---------- this story widens offline support by nothing at all (Binding Constraint FR3) ----------

describe('nothing on the discard path can queue', () => {
  const surface = withoutComments(read(webSrc, 'activities', 'DiscardedPostIts.tsx'));
  const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
  const client = withoutComments(read(webSrc, 'api', 'client.ts'));

  it('holds nothing, mints no submission identity and touches no store', () => {
    expect(surface).not.toMatch(/hold|queue|indexedDB|cache|submissionId|drain/i);

    for (const [pattern, what] of [
      [/const discard = useCallback\([\s\S]*?\n {2}\);/, 'the panel’s discard handler'],
      [/const restore = useCallback\([\s\S]*?\n {2}\);/, 'the panel’s restore handler'],
      [/export async function discardPostIt\([\s\S]*?\n\}/, 'discardPostIt'],
      [/export async function restorePostIt\([\s\S]*?\n\}/, 'restorePostIt'],
    ] as const) {
      const found = slice(pattern.source.startsWith('export') ? client : panel, pattern, what);
      expect(found, what).not.toMatch(/hold\(|mintSubmissionId|queue|drain/i);
    }
  });

  /** The shipped offline modules learn nothing about a Discard: no new item kind, no new field. */
  it('leaves the offline modules knowing nothing about a discard', () => {
    for (const path of sourcesUnder(join(webSrc, 'offline'))) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(/discard|restore/i);
    }
  });

  /** And no second cadence: the discarded list rides the one shared cursor. */
  it('introduces no interval, timer or cursor of its own', () => {
    expect(surface).not.toMatch(/setInterval|setTimeout|requestAnimationFrame/);
    expect(surface).not.toMatch(/addEventListener/);
  });
});
