import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import {
  CATEGORY_LIMIT_PER_BOARD,
  CATEGORY_NAME_MAX_LENGTH,
} from '../src/rounds/category-validation.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * This story's Structural Criteria – the ones that are properties of the source itself rather than
 * of a request.
 *
 * They read the files on disk on purpose. Each guards a decision a later story could undo **by
 * writing perfectly working code**: a second copy of the name cap, a reserved identifier for
 * Uncategorised, a second poll loop for Category changes, a tombstone column added to `post_it`
 * "while we are in there", a Category write queued on a device, a drag handle offered as the only
 * way to reorder. None of those would fail a behavioural test, and every one of them would cost the
 * bundle a property it has already decided to have.
 *
 * Every file-list assertion here is paid for behaviourally in `category.integration.test.ts` and in
 * `web/test/CategoryBoard.test.tsx`, which drive the same properties through real requests against
 * real PostgreSQL and through the real component – because a file list is only as good as its
 * longest omission (`docs/LEARNINGS.md#testing`).
 *
 * **The one-read-per-Board criterion is not here.** It is counted across a whole request at the
 * `Database` seam in `category.integration.test.ts` ("answers a session and everything on its boards
 * in the same number of statements"), because the property is about a request rather than about a
 * file - and this suite builds no recording `Database`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');

const MIGRATION = '20260902090000000_category-and-placement.sql';

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

/** The two modules this story introduced. */
const CATEGORY_MODULES = [
  join(apiSrc, 'rounds', 'category-validation.ts'),
  join(apiSrc, 'rounds', 'category-repository.ts'),
];

/** The modules this story's Category rules could plausibly be copied into. */
const CATEGORY_PATH = [
  join(apiSrc, 'rounds', 'category-validation.ts'),
  join(apiSrc, 'rounds', 'category-repository.ts'),
  join(apiSrc, 'routes', 'rounds.ts'),
  join(apiSrc, 'rounds', 'board-wire.ts'),
  join(apiSrc, 'rounds', 'post-it-repository.ts'),
];

// ---------- the migration (TI01) ----------

describe('the category migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', MIGRATION);
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];
  const upSql = withoutSqlComments(up);

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  /**
   * Reversible in full: the table, both indexes, the trigger, the placement column and the
   * placement's own constraint. The behavioural half – that `migrate down` then `migrate up`
   * leaves the shipped schema intact – is in `category.integration.test.ts`.
   */
  it('is reversible – every object it creates, the down step removes', () => {
    const created = {
      tables: [...up.matchAll(/create table (\w+)/gi)].map((m) => m[1]),
      indexes: [...up.matchAll(/create index (\w+)/gi)].map((m) => m[1]),
      triggers: [...up.matchAll(/create trigger (\w+)/gi)].map((m) => m[1]),
      columns: [...up.matchAll(/add column (\w+)/gi)].map((m) => m[1]),
      /*
       * Both spellings. `ALTER TABLE … ADD CONSTRAINT` is one of them; the six constraints declared
       * inline in `CREATE TABLE category` are the other, and a guard that saw only the first
       * checked one of seven objects while reporting that it had checked them all.
       */
      constraints: [
        ...[...up.matchAll(/add constraint (\w+)/gi)].map((m) => m[1]),
        ...[...up.matchAll(/^\s*CONSTRAINT (\w+)/gim)].map((m) => m[1]),
      ],
    };
    const dropped = {
      tables: [...down.matchAll(/drop table (\w+)/gi)].map((m) => m[1]),
      indexes: [...down.matchAll(/drop index (\w+)/gi)].map((m) => m[1]),
      triggers: [...down.matchAll(/drop trigger (\w+)/gi)].map((m) => m[1]),
      columns: [...down.matchAll(/drop column (\w+)/gi)].map((m) => m[1]),
      /*
       * The inline ones need no `DROP CONSTRAINT`: they go with `DROP TABLE category`, which the
       * table assertion above already pairs. So they are subtracted here rather than demanded of
       * the down step - the pairing that matters is that nothing survives the revert.
       */
      constraints: [...down.matchAll(/drop constraint (\w+)/gi)].map((m) => m[1]),
    };
    const droppedWithTheirTable = new Set(
      [...up.matchAll(/^\s*CONSTRAINT (\w+)/gim)].map((m) => m[1]),
    );
    created.constraints = created.constraints.filter((name) => !droppedWithTheirTable.has(name));
    expect(droppedWithTheirTable.size, 'the inline constraints should be found').toBeGreaterThan(0);

    for (const key of Object.keys(created) as (keyof typeof created)[]) {
      expect(created[key].length, key).toBeGreaterThan(0);
      expect(dropped[key].sort(), key).toEqual(created[key].sort());
    }
  });

  /**
   * The composite key, carrying **both** halves of "a Post-it Round of this Conference".
   *
   * A bare `round_id REFERENCES round (id)` would leave the kind and the Conference as fields the
   * application remembers to populate correctly - and a Category on a Poll would be writable.
   */
  it('hangs the category off (round_id, round_kind, conference_id), cascading', () => {
    expect(sql).toMatch(
      /foreign key \(round_id, round_kind, conference_id\)\s*references round \(id, kind, conference_id\)\s*on delete cascade/i,
    );
    expect(sql).toMatch(/round_kind = 'PostItRound'/);
    expect(sql).not.toMatch(/round_id\s+uuid\s+not null\s+references/i);
  });

  /**
   * **The cap is two constraints, and neither is arithmetic in a handler.**
   *
   * `CHECK (position BETWEEN 1 AND 20)` refuses a 21st outright, and the deferred
   * `UNIQUE (round_id, position)` refuses the loser of a concurrent create at COMMIT. `DEFERRABLE
   * INITIALLY DEFERRED` is what also lets one statement renumber a whole ordering without colliding
   * with itself mid-pass.
   */
  it('states the cap and the ordering as constraints, with the unique one deferred', () => {
    const check = /position between 1 and (\d+)/i.exec(sql);
    expect(check, 'the position cap CHECK should be found').not.toBeNull();
    expect(Number(check![1])).toBe(CATEGORY_LIMIT_PER_BOARD);

    expect(sql).toMatch(/unique \(round_id, position\) deferrable initially deferred/i);
    // And the key `post_it (category_id, round_id)` needs to exist to point at.
    expect(sql).toMatch(/unique \(id, round_id\)/i);
  });

  /**
   * **The migration's name CHECK is pinned to the exported constant, not to a comment.**
   *
   * This is the one permitted second copy of the cap. Changing either side alone fails here; the
   * behavioural boundary in `category.integration.test.ts` proves the two agree in practice as well
   * as on paper.
   */
  it('states the name cap as exactly the exported constant, counted in code points', () => {
    const check = /char_length\(btrim\(name\)\)\s*<=\s*(\d+)/.exec(sql);
    expect(check, 'the name length CHECK should be found').not.toBeNull();
    expect(Number(check![1])).toBe(CATEGORY_NAME_MAX_LENGTH);
    expect(sql).toMatch(/btrim\(name\)\s*<>\s*''/);
  });

  /**
   * **The placement foreign key is `NO ACTION`, and stating that is the point.**
   *
   * `RESTRICT` fires immediately and would break Round - and so Session and Conference - deletion,
   * because one statement cascades to `post_it` and `category` together. `NO ACTION` is checked at
   * end of statement, which is also what makes "an occupied Category cannot be removed" a storage
   * guarantee. Both halves are proved behaviourally in `category.integration.test.ts`.
   */
  it('adds one nullable placement column with no on-delete action', () => {
    expect(upSql).toMatch(/alter table post_it\s+add column category_id uuid;/i);
    expect(upSql).toMatch(
      /foreign key \(category_id, round_id\) references category \(id, round_id\)/i,
    );
    const placement = /add constraint post_it_placed_on_its_own_round[\s\S]*?;/i.exec(upSql)?.[0];
    expect(placement, 'the placement constraint should be found').toBeDefined();
    expect(placement).not.toMatch(/restrict|cascade|set null|set default/i);
  });

  /**
   * **One column on `post_it`, and nothing else** (Binding Constraint FR4).
   *
   * No tombstone, no soft-delete flag, no `deleted_at` – author deletion still leaves no trace at
   * all, and Discard is S05's and is stored elsewhere. The column list of the real table is
   * asserted in `post-it.integration.test.ts`.
   */
  it('adds no tombstone, soft-delete flag or removal marker to post_it', () => {
    expect(
      [...upSql.matchAll(/alter table post_it\s+add column (\w+)/gi)].map((m) => m[1]),
    ).toEqual(['category_id']);
    expect(sql).not.toMatch(/deleted_at|is_deleted|tombstone|discard|removed_at|soft/i);
  });

  /**
   * **The cursor advance is attached, never copied** (`plan.json#sharedDecisions` → one cursor).
   *
   * This migration defines no function and creates no sequence: it hangs a trigger on the
   * `advance_round_activity_watermark` that already exists. A placement change needs no trigger of
   * its own either - it is an UPDATE on `post_it`, which the shipped trigger already covers, and
   * `category.integration.test.ts` confirms that by watching the value rather than the schema.
   */
  it('attaches the category trigger to the existing advance function and defines no second one', () => {
    expect(sql).toMatch(
      /create trigger category_advances_activity_watermark\s+after insert or update or delete on category\s+for each row\s+execute function advance_round_activity_watermark\(\)/i,
    );
    expect(sql).not.toMatch(/create (or replace )?function/i);
    expect(sql).not.toMatch(/create sequence/i);
    expect(sql).not.toMatch(/nextval/i);
  });

  /**
   * Neither of the other two cursors is touched, and no vote table is named.
   *
   * Moving the schedule watermark would make every attendee's phone refetch the whole Schedule for
   * a Category rename; moving `sessions.last_updated_at` would hand an Organizer a concurrency
   * conflict for a Session they never edited. And nothing this story adds reads, joins to or
   * exposes Vote data (Binding Constraint FR8).
   */
  it('touches no other cursor and names no vote table', () => {
    expect(sql).not.toMatch(/schedule_watermark_at/);
    expect(sql).not.toMatch(/last_updated_at/);
    expect(sql).not.toMatch(/alter table conference/i);
    expect(sql).not.toMatch(/alter table sessions/i);
    expect(sql).not.toMatch(/\bvote\b|ballot|round_option/i);
  });
});

// ---------- the two caps have exactly one authoritative definition each (TI02) ----------

describe('the category caps', () => {
  it('are declared once, on the API validation module, and nowhere else in api/src', () => {
    for (const name of ['CATEGORY_NAME_MAX_LENGTH', 'CATEGORY_LIMIT_PER_BOARD']) {
      const declaring = sourcesUnder(apiSrc).filter((path) =>
        new RegExp(`export const ${name}`).test(readFileSync(path, 'utf8')),
      );
      expect(
        declaring.map((path) => relativeTo(apiSrc, path)),
        name,
      ).toEqual(['/rounds/category-validation.ts']);
    }

    /*
     * And neither number is written as a literal anywhere else **on the category path**.
     *
     * Scoped to those modules rather than to all of `api/src`, because 60 and 20 are ordinary
     * numbers elsewhere (seconds in a minute, a truncation length) and a repo-wide scan would
     * report those as cap copies. What the criterion is actually about is a second statement of
     * *these* rules beside the code that enforces them, which is exactly this list.
     */
    for (const path of CATEGORY_PATH) {
      const source = withoutComments(readFileSync(path, 'utf8')).replace(
        /export const CATEGORY_(NAME_MAX_LENGTH|LIMIT_PER_BOARD) = \d+;/g,
        '',
      );
      expect(source, relativeTo(apiSrc, path)).not.toMatch(
        new RegExp(`\\b${CATEGORY_NAME_MAX_LENGTH}\\b`),
      );
      expect(source, relativeTo(apiSrc, path)).not.toMatch(
        new RegExp(`\\b${CATEGORY_LIMIT_PER_BOARD}\\b`),
      );
    }
  });

  /**
   * **No copy exists under `web/`.**
   *
   * `web/` cannot import from `api/src` (its `rootDir` is `src`), so a mirrored client constant
   * would be a *second source* rather than the same one - and unlike the Post-it text cap there is
   * no payload field carrying these, deliberately: the surface states no limit at all and shows the
   * server's refusal, which names both numbers. The behavioural half is in
   * `web/test/CategoryBoard.test.tsx`, where the refusal is what the person reads.
   *
   * Any line mentioning a category is checked, rather than every bare number in the tree: 20 and 60
   * are ordinary numbers in a stylesheet or a clock, and a repo-wide scan would report those.
   */
  it('appear on no category-related line under web/src', () => {
    const offenders: string[] = [];
    for (const path of sourcesUnder(webSrc)) {
      const lines = withoutComments(readFileSync(path, 'utf8')).split('\n');
      lines.forEach((line, index) => {
        if (!/categor/i.test(line)) return;
        if (
          new RegExp(`\\b${CATEGORY_NAME_MAX_LENGTH}\\b`).test(line) ||
          new RegExp(`\\b${CATEGORY_LIMIT_PER_BOARD}\\b`).test(line)
        ) {
          offenders.push(`${relativeTo(webSrc, path)}:${index + 1}`);
        }
      });
    }
    expect(offenders).toEqual([]);

    // And the surface genuinely states no limit of its own: no "up to N characters", no "N of N".
    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    expect(panel).not.toMatch(/of \d+ categor/i);
    expect(panel).not.toMatch(/categoryNameMaxLength|categoryLimit/i);
  });
});

// ---------- Uncategorised is an absence, never an identifier (TI01, TI04, TI05, TI07) ----------

describe('Uncategorised', () => {
  /**
   * **There is no sentinel, reserved or magic identifier for Uncategorised anywhere.**
   *
   * Absence of a placement (`post_it.category_id IS NULL`) is its only representation. A reserved
   * id would be addressable, and every rename, reorder and delete path would then need a refusal
   * for a row that should not exist - which is precisely the shape this story rejected. The
   * behavioural half is in `category.integration.test.ts`, where three category endpoints called
   * with an id that names nothing all answer "no such category on this round".
   */
  it('is named by no constant, no id and no comparison anywhere in api/src', () => {
    expect(sourcesUnder(apiSrc).length, 'api/src should hold sources').toBeGreaterThan(0);
    for (const path of sourcesUnder(apiSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      const name = relativeTo(apiSrc, path);
      // No constant standing in for it, under any spelling.
      expect(source, name).not.toMatch(/UNCATEGORI[SZ]ED[_A-Z]*\s*=/);
      // No comparison against a magic value, and no string literal naming it at all: the API's
      // only word for Uncategorised is a wire *key*, which carries no id.
      expect(source, name).not.toMatch(/['"`]uncategori[sz]ed['"`]/i);
    }

    // The wire key exists and is exactly that - a key with no id, name or position beside it.
    // The projection moved to `rounds/board-wire.ts` when S04 needed it on the anonymous display
    // route without dragging `routes/rounds.ts`'s vote repository onto that route's module graph.
    const boardWire = withoutComments(read(apiSrc, 'rounds', 'board-wire.ts'));
    expect(boardWire).toMatch(/uncategorised: \{ postIts: uncategorised, postItCount:/);
    const projection = /function toBoardWire\([\s\S]*?^\}/m.exec(boardWire)?.[0];
    expect(projection, 'the board projection should be found').toBeDefined();
    expect(projection).not.toMatch(/uncategorised: \{[^}]*\bid\b/);
    expect(projection).not.toMatch(/uncategorised: \{[^}]*\bname\b/);
    expect(projection).not.toMatch(/uncategorised: \{[^}]*position/);

    /*
     * And the **absence** is what the read actually branches on - both kinds of it. A placement of
     * `null` is Uncategorised, and so is a placement naming a Category this read did not list,
     * which is what keeps a Post-it from landing in neither bucket when a removal lands between the
     * two statements (Discovered Requirement, proved in `category.integration.test.ts`).
     */
    expect(projection).toMatch(/const placement = postIt\.categoryId;/);
    expect(projection).toMatch(/const listed = new Set\(/);
    expect(projection).toMatch(/placement === null \|\| !listed\.has\(placement\)/);
  });

  it('is seeded by no row and defaulted by no value in the schema', () => {
    const sql = withoutSqlComments(read(repoRoot, 'db', 'migrations', MIGRATION));
    expect(sql).not.toMatch(/insert into category/i);
    expect(sql).not.toMatch(/category_id\s+uuid\s+not null/i);
    expect(sql).not.toMatch(/default\s+'[0-9a-f-]{36}'/i);
  });

  it('is compared against no identifier in the SPA', () => {
    expect(sourcesUnder(webSrc).length, 'web/src should hold sources').toBeGreaterThan(0);
    for (const path of sourcesUnder(webSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      const name = relativeTo(webSrc, path);
      expect(source, name).not.toMatch(/UNCATEGORI[SZ]ED[_A-Z]*\s*=/);
      // The word appears as copy, as a wire key and in testids. It is never one side of an
      // identity comparison, which is what a sentinel would have to be.
      expect(source, name).not.toMatch(/===\s*['"`]uncategori/i);
      expect(source, name).not.toMatch(/categoryId\s*(===|!==)\s*['"`]/);
    }
  });
});

// ---------- one cursor, one poll loop, nothing queued (TI09, Binding Constraint FR3) ----------

describe('this story adds no second near-live mechanism and queues nothing', () => {
  it('introduces no watermark column, endpoint or poll loop', () => {
    const sql = withoutSqlComments(read(repoRoot, 'db', 'migrations', MIGRATION));
    expect(sql).not.toMatch(/watermark\s+(bigint|timestamptz|integer)/i);
    expect(sql).not.toMatch(/add column \w*watermark/i);

    // Exactly one poll loop under web/, and it is the shipped one.
    const definitions = sourcesUnder(webSrc).filter((path) =>
      /export function useWatermarkPoll/.test(readFileSync(path, 'utf8')),
    );
    expect(definitions.map((path) => relativeTo(webSrc, path))).toEqual([
      '/poll/use-watermark-poll.ts',
    ]);

    // And the panel mounts it once. A second instance is a second cadence, whatever it polls.
    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    expect(panel.match(/useWatermarkPoll\(/g)?.length).toBe(1);
    expect(panel).not.toMatch(/setInterval|setTimeout/);

    // No second watermark route: the two shipped ones are the schedule's and the activities' one.
    const routes = withoutComments(read(apiSrc, 'routes', 'rounds.ts'));
    expect(routes.match(/activities\/watermark/g)?.length).toBe(1);
    expect(routes).not.toMatch(/categories\/watermark|board\/watermark/);
  });

  /**
   * **No Category write reaches the shipped offline queue** (Binding Constraint FR3).
   *
   * Sorting is online-only, so a Category write that cannot be delivered fails visibly and the
   * Board stays as it was. The queue's own modules know nothing about a Category, and the panel's
   * Category path holds nothing: only `contribute` may hold, and only a Post-it.
   */
  it('writes no category into the offline queue or the schedule cache', () => {
    const offline = sourcesUnder(join(webSrc, 'offline'));
    expect(offline.length, 'the offline modules should be found').toBeGreaterThan(0);
    for (const path of offline) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(/categor/i);
    }

    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    const writer = /const writeCategory = useCallback\([\s\S]*?\n {2}\);/.exec(panel)?.[0];
    expect(writer, 'the category write path should be found').toBeDefined();
    expect(writer).not.toMatch(/hold\(|mintSubmissionId|submissionId|queue/i);

    const client = withoutComments(read(webSrc, 'api', 'client.ts'));
    const category =
      /function categoryPath\([\s\S]*?export async function deleteCategory[\s\S]*?\n\}/.exec(
        client,
      )?.[0];
    expect(category, 'the category client functions should be found').toBeDefined();
    expect(category).not.toMatch(/localStorage|indexedDB|caches\.|queue|outbox|retry/i);
  });
});

// ---------- vote anonymity is untouched (Binding Constraint FR8) ----------

describe('nothing this story adds reaches vote data', () => {
  it('names no vote table, ballot or per-voter fact in the modules it introduced', () => {
    for (const path of CATEGORY_MODULES) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(apiSrc, path)).not.toMatch(
        /\bvote\b|votes\b|ballot|voter|has_voted|tally/i,
      );
    }

    // And the Board projection - the one function the whole bundle reads through - carries none.
    const boardWire = withoutComments(read(apiSrc, 'rounds', 'board-wire.ts'));
    const projection = /function toBoardWire\([\s\S]*?^\}/m.exec(boardWire)?.[0];
    expect(projection).toBeDefined();
    expect(projection).not.toMatch(/vote|ballot|tally/i);
  });
});

// ---------- sorting is operable without a pointer (Binding Constraint FR3) ----------

describe('nothing in this story is drag-only', () => {
  /**
   * No drag affordance exists at any width, and the reorder controls are ordinary buttons.
   *
   * The PRD permits drag as an *additional* wide-viewport affordance; this story declines to build
   * it, so the keyboard path is the one that ships and gets proved. The behavioural half - that
   * every control is reachable and operable by keyboard alone - is in
   * `web/test/CategoryBoard.test.tsx`.
   */
  it('offers no drag handle, drop target or pointer-only reorder anywhere in the SPA', () => {
    expect(sourcesUnder(webSrc).length, 'web/src should hold sources').toBeGreaterThan(0);
    for (const path of sourcesUnder(webSrc)) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, relativeTo(webSrc, path)).not.toMatch(
        /draggable|onDrag[A-Z]|onDrop|dataTransfer|dragstart|dragover/i,
      );
    }
  });

  /**
   * **The control at the end of the order is `aria-disabled`, never `disabled`.**
   *
   * `disabled` removes the control from the tab order, so the sequence a keyboard user has learned
   * would change shape exactly when a Category reaches the end of the order - the opposite of what
   * this control set is for
   * (`docs/wireframes/facilitator-board-and-categorisation/design-decisions.md`).
   */
  it('marks the reorder control at the end of the order aria-disabled rather than disabled', () => {
    const panel = read(webSrc, 'activities', 'SessionActivitiesPanel.tsx');
    // Split on the opening tag so each chunk is exactly one control, rather than trusting a
    // non-greedy match to stop at the right closing tag - it does not, and a window that ran on
    // into the next element would find `disabled` on a control this rule is not about.
    const buttons = panel.split('<button');

    for (const [control, edge] of [
      ['category-up', 'first'],
      ['category-down', 'last'],
    ]) {
      const button = buttons.find((chunk) => chunk.includes(`${control}-`));
      expect(button, `${control} should be found`).toBeDefined();
      expect(button, control).toContain(`aria-disabled={${edge} ? 'true' : undefined}`);

      /*
       * **The end of the order is never expressed with `disabled`.** That is the whole rule: a
       * disabled button leaves the tab order, so the control sequence a keyboard user has learned
       * would change shape exactly as a Category reaches the end. `disabled={busy}` is permitted
       * beside it and is a different thing - this control's own write being out, momentary rather
       * than positional - so the guard is about what `disabled` is bound *to*, not about whether it
       * appears.
       */
      const real = button!.replace(/aria-disabled=/g, '');
      expect(real, control).not.toContain(`disabled={${edge}`);
      expect(button, control).toContain('disabled={busy}');
    }
  });
});

// ---------- refusals name the rule that refused, not the class it belongs to ----------

describe('the category write seam', () => {
  const repository = withoutComments(read(apiSrc, 'rounds', 'category-repository.ts'));

  /**
   * **Every SQLSTATE check names its constraint.**
   *
   * Two rules in this schema raise 23503 and two raise 23514, and they mean opposite things to the
   * person reading the refusal - "the round is gone" and "this category still holds post-its" are
   * not interchangeable sentences. A check on the class alone answered all of them with whichever
   * sentence was written first, which is how a Facilitator came to be told a Category had vanished
   * while it sat there holding four post-its.
   */
  it('matches every sqlstate together with the constraint that raised it', () => {
    const checks = [...repository.matchAll(/violated\(error, '(\d{5})', '(\w+)'\)/g)];
    expect(checks.length, 'the constraint checks should be found').toBeGreaterThanOrEqual(4);

    // And no bare comparison against a SQLSTATE survives beside them.
    expect(repository).not.toMatch(/\.code === '\d{5}'/);
  });

  /**
   * **The occupancy guard is a condition on the DELETE**, not a count taken before it.
   *
   * The count decides which question to put to the Facilitator; the predicate decides whether the
   * row may go. Only the second has no window after it (`docs/LEARNINGS.md#concurrency`).
   */
  it('carries the occupancy guard inside the delete statement itself', () => {
    const remove = /delete from category c[\s\S]*?returning c\.id/.exec(repository)?.[0];
    expect(remove, 'the guarded delete should be found').toBeDefined();
    expect(remove).toMatch(/not exists \(select 1 from post_it p where p\.category_id = c\.id\)/);
  });

  /**
   * **A renumber writes the whole ordering.**
   *
   * Touching only the rows whose position changed is a per-Category merge: two concurrent reorders
   * with disjoint changed sets never block one another and the Board settles on a composition of
   * the two moves that neither Facilitator asked for (`prd.md#edge-cases`: last write wins for the
   * ordering *as a whole*). The behavioural half is in `category.integration.test.ts`.
   */
  it('renumbers every row in the ordering, not only the ones that moved', () => {
    const renumber = /update category c\s+set position = ranked\.position[\s\S]*?`/.exec(
      repository,
    )?.[0];
    expect(renumber, 'the renumber statement should be found').toBeDefined();
    expect(renumber).not.toMatch(/is distinct from/);
  });
});

// ---------- registration and authentication (TI06) ----------

describe('the category routes are registered and authenticated', () => {
  it('registers the three category writes, all through withAuth', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);
      const categories =
        '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId/categories';

      for (const url of [
        `POST ${categories}`,
        `PATCH ${categories}/:categoryId`,
        `DELETE ${categories}/:categoryId`,
      ]) {
        expect(urls).toContain(url);
      }

      // And no fourth address for a Category: no per-Category read, and no bulk reorder endpoint.
      expect(urls.filter((url) => /categories/.test(url)).length).toBe(3);

      for (const route of app.confappRoutes.filter((entry) => /categories/.test(entry.url))) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });

  /** Every Category refusal goes through the shared error envelope, one code per reason. */
  it('declares every category refusal through the shared error envelope', () => {
    const errors = read(apiSrc, 'errors.ts');
    const declared = [...errors.matchAll(/^\s{2}(CATEGORY_\w+):/gm)].map((match) => match[1]);
    expect(declared.length).toBeGreaterThan(0);

    const raised = new Set(
      [
        withoutComments(read(apiSrc, 'routes', 'rounds.ts')),
        withoutComments(read(apiSrc, 'rounds', 'category-validation.ts')),
      ]
        .join('\n')
        .match(/ERROR_CODES\.(CATEGORY_\w+)/g)
        ?.map((match) => match.replace('ERROR_CODES.', '')) ?? [],
    );
    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect(declared).toContain(code);
  });

  /** No in-process state between requests (Binding Constraint FR1, ADR-004). */
  it.each([
    ['rounds/category-repository.ts', join(apiSrc, 'rounds', 'category-repository.ts')],
    ['rounds/category-validation.ts', join(apiSrc, 'rounds', 'category-validation.ts')],
  ])('%s holds no category list, count or authority between requests', (_name, path) => {
    const source = withoutComments(readFileSync(path, 'utf8'));
    expect(source, 'a module-level let is request state waiting to happen').not.toMatch(
      /^(let|var)\s/m,
    );
    expect(source, 'a module-level Map/Set is a cache').not.toMatch(
      /^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m,
    );
  });

  /** The category table is reached from the rounds modules and from nowhere else. */
  it('reaches the category table only from the rounds modules', () => {
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => {
        if (relativeTo(apiSrc, path).startsWith('/rounds/')) return false;
        return /\bfrom category\b|\binto category\b|\bupdate category\b/.test(
          withoutComments(readFileSync(path, 'utf8')),
        );
      })
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual([]);
  });
});

// ---------- the Ubiquitous Language holds on the new surface ----------

describe('the board surface uses the canonical terms', () => {
  /**
   * "Column", "bucket", "tag", "swimlane", "inbox", "backlog" and "unsorted category" are named
   * synonyms to avoid (`docs/UBIQUITOUS_LANGUAGE.md`). They are checked where they would actually
   * mislead - in testids, in CSS class names and in the copy a person reads - rather than in prose
   * comments or in `grid-template-columns`, which is a stylesheet talking about a stylesheet.
   */
  it('uses no avoided synonym in a testid, a class name or the copy', () => {
    /*
     * All of them, and across every file this story wrote under `web/` rather than the panel alone.
     * `docs/UBIQUITOUS_LANGUAGE.md` names column, bucket, cluster, theme, tag, swimlane, inbox,
     * backlog and "unsorted category"; a guard that listed six of them read as though it covered
     * the rule.
     *
     * `column` is checked only in identifiers, never in prose or CSS: `grid-template-columns` is a
     * stylesheet talking about a stylesheet, and `column_name` is PostgreSQL's own word.
     */
    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    const client = withoutComments(read(webSrc, 'api', 'client.ts'));
    const avoided = /\b(bucket|swimlane|inbox|backlog|unsorted|cluster|theme)\b/i;

    const testids = [...panel.matchAll(/data-testid=\{?[`'"]([^`'"]+)/g)].map((m) => m[1]!);
    expect(testids.length).toBeGreaterThan(0);
    for (const id of testids) expect(id, id).not.toMatch(avoided);

    const classNames = [...panel.matchAll(/className="([^"]+)"/g)].map((m) => m[1]!);
    expect(classNames.length).toBeGreaterThan(0);
    for (const name of classNames) expect(name, name).not.toMatch(avoided);

    // The copy a person reads, and the wire types beside it - both are read by a person, and the
    // second is where a synonym survives longest because nothing renders it.
    expect(panel).not.toMatch(avoided);
    expect(client).not.toMatch(avoided);

    // Identifiers only, for the one term that is also an ordinary CSS and SQL word.
    for (const identifier of testids.concat(classNames)) {
      expect(identifier, identifier).not.toMatch(/\bcolumns?\b/i);
    }

    const css = read(webSrc, 'styles.css');
    const selectors = [...css.matchAll(/^\.([\w-]+)/gm)].map((m) => m[1]!);
    expect(selectors.length, 'the stylesheet should declare class selectors').toBeGreaterThan(0);
    for (const selector of selectors) expect(selector, selector).not.toMatch(avoided);
  });
});
