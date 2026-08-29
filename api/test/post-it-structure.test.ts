import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { POST_IT_MAX_LENGTH } from '../src/rounds/post-it-validation.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S02's Structural Criteria – the ones that are properties of the source itself rather than of a
 * request.
 *
 * They read the files on disk on purpose. Each guards a decision a later story could undo by
 * writing perfectly working code: a second copy of the length cap, a second poll loop, an author
 * name copied onto the Post-it row, a Post-it write that moves the schedule watermark "so attendees
 * see it", an offline outbox for a typed contribution. None of those would fail a behavioural test,
 * and every one of them would cost the bundle a property it has already decided to have.
 *
 * Every file-list assertion here is paid for behaviourally in `post-it.integration.test.ts` and in
 * `web/test/SessionActivitiesPanel.test.tsx`, which drive the same properties through real requests
 * against real PostgreSQL and through the real poll loop – because a file list is only as good as
 * its longest omission (`docs/LEARNINGS.md#testing`).
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');

const MIGRATION = '20260828120000000_post-it.sql';

/**
 * The migration that replaced this story's timestamp cursor with an opaque counter, after the
 * security finding of 2026-08-29. The triggers stay S02's; what they write does not, so the
 * assertions about the *value* read the migration that is actually in force.
 */
const COUNTER_MIGRATION = '20260829120000000_activity-watermark-counter.sql';

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

// ---------- the migration (TI01, TI02) ----------

describe('the post-it migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', MIGRATION);
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

  // Split before the comments are stripped – `-- Down Migration` is itself a comment line.
  const counterRaw = read(repoRoot, 'db', 'migrations', COUNTER_MIGRATION);
  const counterSql = withoutSqlComments(counterRaw);
  const counterUp = withoutSqlComments(
    (counterRaw.split(/^-- Down Migration$/m) as [string, string])[0],
  );

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  /**
   * Reversible in full: the table, its index, both trigger functions, both triggers, the watermark
   * column and the unique constraint the composite key needs.
   */
  it('is reversible – every object it creates, the down step removes', () => {
    const created = {
      tables: [...up.matchAll(/create table (\w+)/gi)].map((m) => m[1]),
      indexes: [...up.matchAll(/create index (\w+)/gi)].map((m) => m[1]),
      functions: [...up.matchAll(/create function (\w+)/gi)].map((m) => m[1]),
      triggers: [...up.matchAll(/create trigger (\w+)/gi)].map((m) => m[1]),
      columns: [...up.matchAll(/add column (\w+)/gi)].map((m) => m[1]),
      constraints: [...up.matchAll(/add constraint (\w+)/gi)].map((m) => m[1]),
    };
    const dropped = {
      tables: [...down.matchAll(/drop table (\w+)/gi)].map((m) => m[1]),
      indexes: [...down.matchAll(/drop index (\w+)/gi)].map((m) => m[1]),
      functions: [...down.matchAll(/drop function (\w+)/gi)].map((m) => m[1]),
      triggers: [...down.matchAll(/drop trigger (\w+)/gi)].map((m) => m[1]),
      columns: [...down.matchAll(/drop column (\w+)/gi)].map((m) => m[1]),
      constraints: [...down.matchAll(/drop constraint (\w+)/gi)].map((m) => m[1]),
    };

    for (const key of Object.keys(created) as (keyof typeof created)[]) {
      expect(created[key].length, key).toBeGreaterThan(0);
      expect(dropped[key].sort(), key).toEqual(created[key].sort());
    }
  });

  /**
   * The composite key, carrying **both** halves of "a Post-it Round of this Conference".
   *
   * A bare `round_id REFERENCES round (id)` would leave the kind and the Conference as fields the
   * application remembers to populate correctly.
   */
  it('hangs the post-it off (round_id, round_kind, conference_id), cascading', () => {
    expect(sql).toMatch(
      /foreign key \(round_id, round_kind, conference_id\)\s*references round \(id, kind, conference_id\)\s*on delete cascade/i,
    );
    expect(sql).toMatch(/round_kind = 'PostItRound'/);
    // And the unique constraint that key needs, following the `sessions_id_conference_unique` idiom.
    expect(sql).toMatch(
      /add constraint round_id_kind_conference_unique unique \(id, kind, conference_id\)/i,
    );
    // Never a bare single-column reference to the round.
    expect(sql).not.toMatch(/round_id\s+uuid\s+not null\s+references/i);
  });

  /**
   * **The migration's CHECK is pinned to the exported constant, not to a comment.**
   *
   * This is the one unavoidable second copy of the cap (FIS → Constraints & Gotchas). Changing
   * either side alone fails here; the behavioural boundary in `post-it.integration.test.ts` proves
   * the two agree in practice as well as on paper.
   */
  it('states the length cap as exactly the exported constant', () => {
    const check = /char_length\(text\)\s*<=\s*(\d+)/.exec(sql);
    expect(check, 'the text length CHECK should be found').not.toBeNull();
    expect(Number(check![1])).toBe(POST_IT_MAX_LENGTH);

    // And it is the only number in this migration that could be mistaken for a cap.
    expect(sql).toMatch(/btrim\(text\)\s*<>\s*''/);
  });

  /**
   * The cursor advances strictly and monotonically, per row, on **every** write – and the delete is
   * the one that matters, because a removed Post-it leaves no row behind to notice.
   *
   * **The triggers are this migration's; the value they write is not.** The advance is read from
   * `COUNTER_MIGRATION`, which is what actually runs. Asserting the superseded
   * `GREATEST(clock_timestamp(), … + 1µs)` here would have stayed green against shipped behaviour
   * that had become something else entirely – and the clock is gone from this cursor on purpose.
   * The behavioural half of that guard is in `vote.integration.test.ts`.
   */
  it('advances the watermark on insert, update and delete, from one named sequence', () => {
    expect(sql).toMatch(/after insert or update or delete on post_it/i);
    expect(sql).toMatch(/before update on round/i);

    // One sequence, named once, called from the column default and from both function bodies.
    expect(counterUp).toMatch(/create sequence activity_watermark_seq/i);
    expect(counterUp.match(/nextval\('activity_watermark_seq'\)/g)?.length).toBeGreaterThanOrEqual(
      3,
    );

    // No clock reaches the value any more, under any spelling – including `now()`, which is
    // transaction-start time and would stamp two writes in one transaction identically.
    expect(counterUp).not.toMatch(/clock_timestamp|\bnow\(\)|CURRENT_TIMESTAMP|timestamptz/i);
  });

  /**
   * **One named home for the advancing logic**, so S03 attaches a trigger to it rather than copying
   * the GREATEST expression a third time (`plan.json#sharedDecisions` → "one cursor", finding H-4).
   */
  it('gives the child-table advance one trigger function keyed on round_id', () => {
    expect(sql).toMatch(/create function advance_round_activity_watermark\(\) returns trigger/i);
    expect(sql).toMatch(/NEW\.round_id/);
    expect(sql).toMatch(/OLD\.round_id/);

    // And the counter migration REPLACED that one home rather than adding a second: every trigger
    // S02 and S03 attached still points at this function, and none was repointed or recreated.
    expect(counterUp).toMatch(
      /create or replace function advance_round_activity_watermark\(\) returns trigger/i,
    );
    expect(counterUp).not.toMatch(/create function/i);
    expect(counterUp).not.toMatch(/create trigger|drop trigger/i);
  });

  /**
   * Neither of the other two cursors is touched. Moving the schedule watermark would make every
   * attendee's phone refetch the whole Schedule for a post-it; moving `sessions.last_updated_at`
   * would hand an Organizer a concurrency conflict for a Session they never edited.
   */
  it('never touches conference.schedule_watermark_at or sessions.last_updated_at', () => {
    // Both migrations: the one that created this cursor, and the one that changed what it holds.
    for (const migration of [sql, counterSql]) {
      expect(migration).not.toMatch(/schedule_watermark_at/);
      expect(migration).not.toMatch(/last_updated_at/);
      expect(migration).not.toMatch(/alter table conference/i);
      expect(migration).not.toMatch(/alter table sessions/i);
      expect(migration).not.toMatch(/on sessions/i);
    }
  });

  /** No count column, no tombstone, no offline marker, no email (FR3, edge cases, FR6, ADR-002). */
  it('declares no count, tombstone, pending marker or email column', () => {
    expect(sql).not.toMatch(/count|total|tally|quota/i);
    expect(sql).not.toMatch(/deleted_at|is_deleted|tombstone|archived/i);
    expect(sql).not.toMatch(/pending|queued|outbox|late|offline/i);
    expect(sql).not.toMatch(/mail/i);
    expect(sql).toMatch(/author_sub\s+text\s+not null\s+references app_user \(sub\)/i);
  });
});

// ---------- the length cap has exactly one authoritative definition (TI01, TI06, TI09) ----------

describe('the post-it length cap', () => {
  it('is declared once, on the API validation module, and nowhere else in api/src', () => {
    const declaring = sourcesUnder(apiSrc).filter((path) =>
      /export const POST_IT_MAX_LENGTH/.test(readFileSync(path, 'utf8')),
    );
    expect(declaring.map((path) => relativeTo(apiSrc, path))).toEqual([
      '/rounds/post-it-validation.ts',
    ]);

    // Nowhere in api/src is the number written as a literal outside that one declaration.
    const literal = new RegExp(`\\b${POST_IT_MAX_LENGTH}\\b`);
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => {
        const source = withoutComments(readFileSync(path, 'utf8'));
        if (/export const POST_IT_MAX_LENGTH/.test(source)) {
          // The declaration itself is the one permitted occurrence.
          return literal.test(source.replace(/export const POST_IT_MAX_LENGTH = \d+;/, ''));
        }
        return literal.test(source);
      })
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual([]);
  });

  /**
   * **No cap literal exists under `web/` at all.**
   *
   * `web/` cannot import from `api/src` (its `rootDir` is `src`), so a mirrored client constant
   * would be a *second source* rather than the same one. The payload is what closes the gap: the
   * compose box renders `textMaxLength` off the Session read. The behavioural half – that changing
   * the payload's cap changes what the box says – is in `web/test/SessionActivitiesPanel.test.tsx`.
   */
  it('appears in no source or test under web/', () => {
    const literal = new RegExp(`\\b${POST_IT_MAX_LENGTH}\\b`);
    const webFiles = sourcesUnder(webSrc).concat(sourcesUnder(join(repoRoot, 'web', 'test')));
    const offenders = webFiles
      .filter((path) => literal.test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relativeTo(join(repoRoot, 'web'), path));
    expect(offenders).toEqual([]);

    // And the client genuinely consumes the server's value rather than defaulting one.
    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    expect(panel).toMatch(/round\.textMaxLength/);
    expect(panel).not.toMatch(/textMaxLength\s*\?\?\s*\d/);
  });
});

// ---------- the post-it modules (TI03, TI04, TI05) ----------

describe('the post-it write path', () => {
  const repository = withoutComments(read(apiSrc, 'rounds', 'post-it-repository.ts'));
  const routes = withoutComments(read(apiSrc, 'routes', 'rounds.ts'));

  /**
   * **The guards are in the statement, not before it.** A Round closing between a check and a write
   * cannot admit the write, because the check *is* the write
   * (`docs/LEARNINGS.md#concurrency`). The behavioural half is in the integration suite.
   */
  it('carries the author and the round-is-open condition inside the update and the delete', () => {
    const update = /update post_it p[\s\S]*?returning p\.id/.exec(repository)?.[0];
    expect(update, 'the guarded update should be found').toBeDefined();
    expect(update).toMatch(/p\.author_sub = \$5/);
    expect(update).toMatch(/r\.state = 'open'/);

    const remove = /delete from post_it p[\s\S]*?returning p\.id/.exec(repository)?.[0];
    expect(remove, 'the guarded delete should be found').toBeDefined();
    expect(remove).toMatch(/p\.author_sub = \$5/);
    expect(remove).toMatch(/r\.state = 'open'/);

    // The insert's own source query carries the open condition for the same reason.
    const insert = /insert into post_it[\s\S]*?returning id/.exec(repository)?.[0];
    expect(insert, 'the guarded insert should be found').toBeDefined();
    expect(insert).toMatch(/r\.state = 'open'/);
  });

  /** A delete removes the row. No soft-delete flag, no tombstone (prd.md#edge-cases). */
  it('deletes rather than flags, and keeps no per-author or per-round count', () => {
    expect(repository).not.toMatch(/deleted_at|is_deleted|tombstone|soft/i);
    expect(repository).not.toMatch(/per_author|tally|quota/i);
    expect(routes).not.toMatch(/postItCount|contributionCount|perAuthor/i);

    /*
     * `count(` used to be forbidden outright here. S05's contribution-safe Session deletion (FR7)
     * needs one - the deletion guard says how many Post-its would be lost - and that count is a
     * different thing from the per-Member limit FR3 says does not exist: it is reached through the
     * Round, it groups by nothing, and no contribution path consults it. So the ban becomes a
     * shape: every count written in this module must be that one, and a count by author or a
     * per-Round quota still fails.
     */
    const counting = [
      /*
       * All three quote styles, case-insensitively. A collector that saw only backticks would miss
       * `db.query('select count(*) …')` entirely - and skipping double quotes would miss more than
       * it looks: `.prettierrc` sets `singleQuote`, so Prettier *keeps* double quotes on any string
       * containing an apostrophe, and SQL in this module routinely contains `r.state = 'open'`.
       * Double-quoted is therefore the shape the formatter makes natural for exactly the kind of
       * statement being guarded against. "Over-collecting costs nothing while under-collecting is
       * the omission that lets one through" (`vote-structure.test.ts`).
       */
      ...repository.matchAll(/`([^`]*)`/g),
      ...repository.matchAll(/'([^'\n]*)'/g),
      ...repository.matchAll(/"([^"\n]*)"/g),
    ]
      .map((match) => match[1]!)
      .filter((sql) => /\bcount\(/i.test(sql));
    expect(counting.length, 'the per-session contribution count should be the only count').toBe(1);
    expect(counting[0]).toMatch(/from post_it p\s+join round r on r\.id = p\.round_id/);
    expect(counting[0]).toMatch(/where r\.conference_id = \$1 and r\.session_id = \$2/);
    expect(counting[0]).not.toMatch(/author_sub|group by|having|limit/i);
  });

  /** The display name is joined at read time, never copied onto the row. */
  it('joins the author name from app_user and stores none', () => {
    expect(repository).toMatch(/join app_user u on u\.sub = p\.author_sub/);
    expect(repository).toMatch(/u\.display_name as author_name/);
    expect(repository).not.toMatch(/insert into post_it[^;]*display_name/i);
  });

  /**
   * Authorship reaches the repository as a **parameter**, and the only value the routes pass is
   * `caller.sub` (Binding Constraint FR3).
   *
   * The body's author fields are inert rather than refused, which is the stronger statement and the
   * one `post-it.integration.test.ts` proves behaviourally. What this adds is that no author-ish
   * field is ever *read* off a request body anywhere on the path.
   */
  it('takes the author from the credential on every write, and reads none from a body', () => {
    const authorArguments = [
      ...routes.matchAll(/postIts\.(contribute|edit|remove)\(([\s\S]*?)\);/g),
    ];
    expect(authorArguments.length).toBe(3);
    for (const [, name, args] of authorArguments) {
      expect(args, name).toMatch(/caller\.sub/);
    }

    // Nothing anywhere on the path pulls an author out of a request.
    for (const source of [routes, repository]) {
      expect(source).not.toMatch(/request\.body[\s\S]{0,120}?(authorSub|authorName|userSub)/);
      expect(source).not.toMatch(/body\.(authorSub|authorName|author|userSub|sub\b|email)/);
    }

    // The post-it body schema names exactly one property.
    const schema = /const postItBodySchema = \{[\s\S]*?\} as const;/.exec(routes)?.[0];
    expect(schema, 'the post-it body schema should be found').toBeDefined();
    expect(/properties: \{\s*text: \{ type: 'string' \},\s*\}/.test(schema!)).toBe(true);
    expect(schema).not.toMatch(/author|sub|email|user/i);

    /*
     * S04's contribution body is the other one, and it is held to the same rule. It names how the
     * contribution *arrived* - `offlineComposed`, and the `submissionId` a retry repeats - and
     * nothing at all about who is contributing. `\bsub\b` rather than `sub`, so `submissionId` is
     * not mistaken for a subject claim: the thing forbidden is a body field that names the actor.
     */
    const arrival = /const contributionBodySchema = \{[\s\S]*?\} as const;/.exec(routes)?.[0];
    expect(arrival, 'the contribution body schema should be found').toBeDefined();
    expect(arrival).not.toMatch(/author|\bsub\b|email|user/i);
  });

  /** No in-process state between requests (Binding Constraint FR2, ADR-004). */
  it.each([
    ['rounds/post-it-repository.ts', join(apiSrc, 'rounds', 'post-it-repository.ts')],
    ['rounds/post-it-validation.ts', join(apiSrc, 'rounds', 'post-it-validation.ts')],
    ['routes/rounds.ts', join(apiSrc, 'routes', 'rounds.ts')],
  ])('%s holds no board, watermark, cursor or per-author count between requests', (_name, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));
    expect(source, 'a module-level let is request state waiting to happen').not.toMatch(
      /^(let|var)\s/m,
    );
    expect(source, 'a module-level Map/Set is a cache').not.toMatch(
      /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
    );
  });

  /** The post-it table is reached from the rounds modules and from nowhere else. */
  it('reaches the post_it table only from the rounds modules', () => {
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => {
        if (relativeTo(apiSrc, path).startsWith('/rounds/')) return false;
        return /\bpost_it\b/.test(withoutComments(readFileSync(path, 'utf8')));
      })
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual([]);
  });

  /** No post-it source writes either of the other two cursors, from any path. */
  it('never writes conference.schedule_watermark_at or sessions.last_updated_at', () => {
    for (const path of [
      join(apiSrc, 'rounds', 'post-it-repository.ts'),
      join(apiSrc, 'rounds', 'post-it-validation.ts'),
      join(apiSrc, 'routes', 'rounds.ts'),
    ]) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(/schedule_watermark_at/);
      expect(source, path).not.toMatch(/update sessions/i);
    }
  });

  /** Every S02 refusal goes through the shared error envelope, one code per reason. */
  it('declares every post-it refusal through the shared error envelope', () => {
    const errors = read(apiSrc, 'errors.ts');
    const declared = [...errors.matchAll(/^\s{2}(POST_IT_\w+):/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);

    const raised = new Set(
      [routes, withoutComments(read(apiSrc, 'rounds', 'post-it-validation.ts'))]
        .join('\n')
        .match(/ERROR_CODES\.(POST_IT_\w+)/g)
        ?.map((match) => match.replace('ERROR_CODES.', '')) ?? [],
    );
    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect(declared).toContain(code);
  });
});

// ---------- offline support does not widen (Binding Constraint FR6) ----------

describe('this story widens offline support by nothing at all', () => {
  /**
   * **S10's schedule modules**, named rather than "everything under `offline/`".
   *
   * The scan used to be the whole folder, which stated something true of S02 and false of the
   * product: `AGENTS.md` licenses **two** offline capabilities, and S04 built the second one -
   * `post-it-queue.ts` and `use-post-it-queue.ts`, whose whole subject is a Post-it and a Round it
   * belongs to. Scoping to the schedule path keeps S02's actual claim intact and stops it forbidding
   * a story the product had already decided to have. What S02 says is unchanged: *this* story wrote
   * no post-it into the cache and introduced no deferred write, and the schedule cache still knows
   * nothing about a Round.
   *
   * `schedule-cache.ts` is deliberately **not** here. It names the queue's store, because it owns
   * the database the store lives in - one upgrade, one purge, one owner claim - and that is the
   * arrangement that keeps a shared tablet safe. Its schedule half is covered by the two assertions
   * below, which are about the *cache*, not about the file.
   */
  const EXEMPT = new Set([
    // S04's queue, whose whole subject is a Post-it and the Round it belongs to.
    'post-it-queue.ts',
    'use-post-it-queue.ts',
    // Owns the database the queue's store lives in, so it names that store - see below.
    'schedule-cache.ts',
  ]);

  /**
   * **Still a sweep of the whole folder**, minus three files named one by one.
   *
   * A hard-coded list of the modules to *check* would stop catching the thing this guard exists
   * for: a fourth offline capability, added later, would simply not be on it. Subtracting the
   * exemptions instead means any new module in `web/src/offline/` trips this assertion and forces
   * a deliberate decision, which is what `AGENTS.md`'s "never widen offline support beyond schedule
   * reads and post-it queueing" needs a guard to do.
   */
  const scheduleModules = sourcesUnder(join(webSrc, 'offline')).filter(
    (path) => !EXEMPT.has(basename(path)),
  );

  it('writes no post-it to S10’s cache and introduces no outbox, queue or replay buffer', () => {
    // The exemptions are exactly three files that exist. A stale name here would silently shrink
    // the sweep, which is the failure mode a subtractive list has.
    const offline = sourcesUnder(join(webSrc, 'offline')).map((path) => basename(path));
    for (const name of EXEMPT) expect(offline, `${name} should still exist`).toContain(name);
    expect(scheduleModules.length).toBeGreaterThan(0);

    for (const path of scheduleModules) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(/post[\s_-]?it/i);
      expect(source, path).not.toMatch(/\bround\b/i);
    }

    // And the cached Schedule itself still holds only what a read returned: no post-it text, no
    // Round, nothing queued for sending, in the entry shape or in what writes it.
    const cache = withoutComments(read(webSrc, 'offline', 'schedule-cache.ts'));
    const entry = /export interface CachedSchedule \{[\s\S]*?\n\}/.exec(cache)?.[0];
    expect(entry, 'the cached schedule entry shape should be found').toBeDefined();
    expect(entry).not.toMatch(/post[\s_-]?it|\bround\b|text/i);
    expect(cache).not.toMatch(/contributePostIt|apiRequest|\bfetch\(/);

    const suspects = sourcesUnder(join(webSrc, 'activities'))
      .concat(sourcesUnder(join(webSrc, 'poll')))
      .concat([join(webSrc, 'api', 'client.ts')]);
    for (const path of suspects) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(
        /outbox|replay|pendingWrite|pending[_-]?mutation|syncQueue|conflictResolution/i,
      );
      // No storage of any kind: the schedule cache is S10's and nothing here writes one.
      expect(source, path).not.toMatch(/localStorage|indexedDB|caches\./);
    }
  });
});

// ---------- registration and authentication (TI04, TI05, TI07) ----------

describe('the post-it routes are registered and authenticated', () => {
  it('registers the board’s three writes and the activity watermark poll, all through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);
      const base = '/api/conferences/:conferenceId/sessions/:sessionId';
      const board = `${base}/rounds/:roundId/post-its`;

      for (const url of [
        `POST ${board}`,
        `PATCH ${board}/:postItId`,
        `DELETE ${board}/:postItId`,
        `GET ${base}/activities/watermark`,
      ]) {
        expect(urls).toContain(url);
      }

      for (const route of app.confappRoutes.filter((entry) =>
        /post-its|activities\/watermark/.test(entry.url),
      )) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});
