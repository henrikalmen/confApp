import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildApp } from '../src/app.ts';
import { fakeDatabase } from './fake-db.ts';
import { fakeAuth } from './fake-auth.ts';

/**
 * S03's Structural Criteria – the anonymity guarantee as a property of the schema and the source,
 * rather than of any request.
 *
 * ============================================================================================
 * **WHAT A GREEN RUN HERE PROVES, AND WHAT IT DOES NOT.**
 *
 * It proves that **no application path relates a Vote to its voter**: no declared column,
 * constraint, index, trigger or query available to the API associates the two tables beyond the
 * `round_id` they share, which yields the set of ballots for a Round and the set of people who
 * voted in it and never a pairing between them.
 *
 * It does **not** prove that correlation is impossible. The ballot row and the has-voted row are
 * written in one transaction and therefore carry the same `xmin`, and joining the two tables on
 * `round_id` and `xmin` returns an exact voter-to-ballot pairing. `xmin` is a system column
 * present on every table and readable by an ordinary `SELECT`; no assertion in this file inspects
 * it, and none can, because system columns are not declared anywhere a schema assertion can read.
 *
 * That residual is accepted and bounded operationally by who holds direct database credentials
 * (`docs/adrs/ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials.md`).
 * **Do not add a test that appears to cover it** – a green assertion over `xmin` would be a false
 * assurance, which is the exact failure ADR-006 exists to stop.
 * ============================================================================================
 *
 * Every assertion here guards a decision a later story could undo by writing perfectly working
 * code: a `voted_at` "for the report", a `user_sub` on the ballot "to make recounts possible", a
 * second trigger, a join added to answer a question somebody asked in a meeting. None of those
 * would fail a request-level test, and each would cost the product the one property it exists to
 * have. Per `docs/LEARNINGS.md#testing`, each file-list assertion here is paid for behaviourally in
 * `vote.integration.test.ts`, which drives the same properties through real requests against real
 * PostgreSQL - a file list is only as good as its longest omission.
 */

const here = dirname(fileURLToPath(import.meta.url));
const apiSrc = join(here, '..', 'src');
const repoRoot = join(here, '..', '..');
const webSrc = join(repoRoot, 'web', 'src');

const MIGRATION = '20260829090000000_vote.sql';

/** The ballot, and the fact that somebody voted. Named once so no assertion drifts off them. */
const BALLOT = 'vote';
const HAS_VOTED = 'round_voter';

/** Anything a ballot must never be relatable to. */
const IDENTITY_TABLES = [
  'app_user',
  HAS_VOTED,
  'membership',
  'role_assignment',
  'session_assignment',
];

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

/** The body of one `CREATE TABLE`, comments stripped. */
function tableBody(sql: string, table: string): string {
  const match = new RegExp(`create table ${table} \\(([\\s\\S]*?)\\n\\);`, 'i').exec(sql);
  expect(match, `the ${table} table should be found in the migration`).not.toBeNull();
  return match![1]!;
}

/**
 * Every migration in the directory, newest last, as `{ name, up }`.
 *
 * Read by listing the directory rather than by naming files, because the whole point is to see
 * migrations that **do not exist yet**. A guard that names the migration it checks can only ever
 * be as current as the last person who remembered to add to its list.
 *
 * Only the up section is returned. A down step legitimately drops and re-adds things, and reading
 * it would make a correct reversal look like a violation.
 */
function migrationsUp(): { name: string; up: string }[] {
  const dir = join(repoRoot, 'db', 'migrations');
  return readdirSync(dir)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const raw = read(dir, name);
      const [up] = raw.split(/^-- Down Migration$/m) as [string, string];
      return { name, up: withoutSqlComments(up) };
    });
}

/**
 * Every column any migration adds to `table` by `ALTER TABLE ... ADD COLUMN`, with the migration
 * that adds it.
 *
 * This is the half a `CREATE TABLE` reading cannot see. The ballot's column list was asserted
 * against the migration that created it, which is correct and insufficient: a **later** migration
 * adding `voter_sub`, or a neutrally named `submitted_by`, changes what the table holds without
 * touching a line this file used to read. That is the shape of the gap - the guarantee is about
 * what the table declares *now*, not about what one file once declared.
 */
function columnsAddedByAlter(table: string): { column: string; migration: string }[] {
  const pattern = new RegExp(
    `alter\\s+table\\s+(?:only\\s+)?${table}\\b[\\s\\S]*?add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?(\\w+)`,
    'gi',
  );
  return migrationsUp().flatMap(({ name, up }) =>
    [...up.matchAll(pattern)].map((match) => ({ column: match[1]!, migration: name })),
  );
}

/**
 * The column names a `CREATE TABLE` body declares.
 *
 * A declaration is a line whose first token is a name and whose second is a type; a table-level
 * `CONSTRAINT ...` line is neither. That distinction is the whole point of these criteria - they
 * are about **declared columns**, which is the surface an application can reach.
 *
 * **Indentation-agnostic on purpose.** Anchoring on exactly two spaces would make a column declared
 * at any other indentation invisible to this parser - and invisible here is invisible to the two
 * criteria that turn on it, so a neutrally named ordering column (`    ballot_no integer`, indented
 * four) would pass every assertion in this file by never being seen at all. Leading whitespace is
 * not part of what PostgreSQL reads, so it must not be part of what this reads either.
 */
function declaredColumns(body: string): string[] {
  return body
    .split('\n')
    .map((line) =>
      /^\s*(\w+)\s+(uuid|text|integer|boolean|timestamptz|timestamp|date|serial|bigserial|numeric|jsonb|bytea)\b/i.exec(
        line,
      ),
    )
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1]!);
}

/**
 * Every SQL statement written anywhere under `api/src`, as text.
 *
 * Template literals and quoted strings that name a SQL verb. Crude on purpose: a criterion about
 * "no query joins these two things" has to look at the queries as they are actually written, and
 * over-collecting costs nothing while under-collecting is the omission that lets one through.
 */
function sqlStatementsIn(source: string): string[] {
  const stripped = withoutComments(source);
  // All three quote styles. `.prettierrc` sets `singleQuote`, so Prettier keeps double quotes on
  // any string containing an apostrophe - and SQL here routinely contains `r.state = 'open'`, so
  // double-quoted is a shape this collector must see rather than a style nobody would write.
  const literals = [
    ...(stripped.match(/`[^`]*`/g) ?? []),
    ...(stripped.match(/'[^'\n]*'/g) ?? []),
    ...(stripped.match(/"[^"\n]*"/g) ?? []),
  ];
  return literals.filter((text) => /\b(select|insert into|update|delete from)\b/i.test(text));
}

// ---------- the migration: what is declared, and what deliberately is not (TI01, TI02) ----------

describe('the vote migration', () => {
  const raw = read(repoRoot, 'db', 'migrations', MIGRATION);
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];
  const ballot = tableBody(sql, BALLOT);
  const hasVoted = tableBody(sql, HAS_VOTED);

  /**
   * **The ballot declares its Round, its option, and a random key. Nothing else.**
   *
   * The absence is the guarantee: a voter reference cannot be left null "for now" or added "just in
   * case" when there is nowhere for one to live, and the API cannot leak what the row does not
   * hold.
   */
  it('declares on the ballot exactly a round reference, an option reference and a random key', () => {
    expect(declaredColumns(ballot).sort()).toEqual(['id', 'option_id', 'round_id']);

    // The composite key that makes an option belonging to *another* Poll unwritable, plus the
    // uniqueness rule it hangs off.
    expect(sql).toMatch(
      /foreign key \(option_id, round_id\)\s*references round_option \(id, round_id\)/i,
    );
    expect(sql).toMatch(/add constraint round_option_id_round_unique unique \(id, round_id\)/i);
    expect(sql).toMatch(/round_id\s+uuid\s+not null references round \(id\) on delete cascade/i);
  });

  /**
   * **And nothing has been added to either table since, by any migration.**
   *
   * The assertion above reads the migration that created the ballot, which is exactly as current as
   * that one file. A later migration doing `ALTER TABLE vote ADD COLUMN voter_sub uuid` - or
   * anything blander, `submitted_by`, `author_ref`, `by_member` - would put a voter reference on
   * the ballot without changing a character of what that assertion reads, and it would pass green.
   *
   * The live-schema check that would otherwise catch it sits behind `describe.skipIf(!reachable)`
   * in `vote.integration.test.ts`, so on a machine with no PostgreSQL it does not run at all. This
   * one needs no database: it reads the directory, so it sees migrations that do not exist yet.
   *
   * Deliberately zero-tolerance for both tables rather than a denylist of column names. A denylist
   * is a list of the names somebody thought of, and the failure mode this whole file exists against
   * is precisely the column nobody thought to name.
   */
  it('has had no column added to the ballot or the has-voted table by any later migration', () => {
    expect(columnsAddedByAlter(BALLOT)).toEqual([]);
    expect(columnsAddedByAlter(HAS_VOTED)).toEqual([]);
  });

  /**
   * **Exactly one statement in the API deletes an option, and it sits behind the freeze.**
   *
   * `vote.option_id` cascades, so deleting a `round_option` row takes its ballots with it - no
   * error, no trace, no recount. That is the one place this schema does not make the wrong state
   * unrepresentable, and the only thing standing between a bug and silently destroyed Votes is that
   * the single option-deleting path is unreachable once a ballot exists.
   *
   * The cascade is deliberately kept rather than changed to `RESTRICT`, which would collide with
   * S05's Session-delete cascade. So the protection is *reachability*, and reachability is what
   * this asserts: a second `delete from round_option` appearing anywhere - a bulk cleanup, an
   * admin path, a migration helper reusing the repository - would be outside the freeze and would
   * reopen it. The behavioural half, that the guarded path itself refuses once a Vote exists and
   * leaves the stored options byte-identical, is proved under a real row lock in
   * `vote.integration.test.ts`.
   */
  it('deletes options from exactly one place, inside the frozen-content guard', () => {
    const sources = readdirSync(join(apiSrc, 'rounds'))
      .filter((name) => name.endsWith('.ts'))
      .map((name) => ({ name, text: withoutComments(read(apiSrc, 'rounds', name)) }));

    const deleters = sources.filter(({ text }) => /delete\s+from\s+round_option/i.test(text));
    expect(deleters.map(({ name }) => name)).toEqual(['round-repository.ts']);

    const body = deleters[0]!.text;
    expect([...body.matchAll(/delete\s+from\s+round_option/gi)]).toHaveLength(1);

    // And it is inside the transaction that takes the Round row `for update` and calls the freeze
    // guard first - not merely somewhere in the same file.
    const guarded = /for update[\s\S]*?assertNotFrozen[\s\S]*?delete\s+from\s+round_option/i;
    expect(body).toMatch(guarded);

    // Nothing outside `api/src/rounds` deletes an option at all.
    const elsewhere = readdirSync(apiSrc, { recursive: true, encoding: 'utf8' })
      .filter((p) => p.endsWith('.ts') && !p.replace(/\\/g, '/').startsWith('rounds/'))
      .filter((p) => /delete\s+from\s+round_option/i.test(withoutComments(read(apiSrc, p))));
    expect(elsewhere).toEqual([]);
  });

  /**
   * **No identity of any kind on the ballot, in any form.**
   *
   * Not a `user_sub`, not an `app_user` reference, not an email, not a device or client or
   * auth-session id, and not a hash, digest or ciphertext of one - a one-way function of a `sub` is
   * still a value one `sub` produces and another does not.
   */
  it('declares no column on the ballot that could carry, derive from or match a person', () => {
    expect(ballot).not.toMatch(/user_sub|app_user|\bsub\b/i);
    expect(ballot).not.toMatch(/mail/i);
    expect(ballot).not.toMatch(/device|client_id|auth|token|session/i);
    expect(ballot).not.toMatch(/hash|digest|encrypt|hmac|pseudonym|nonce|salt/i);
    expect(ballot).not.toMatch(/voter|member|author|person|user\b/i);
  });

  /**
   * **Nothing declared on either table orders its rows by when they were written.**
   *
   * A `voted_at` on one and a `created_at` on the other would only have to be sorted the same way
   * for the two sets to be lined up, and a sequence orders rows exactly as a timestamp does. A
   * random uuid does not. *Scoped as the file note says*: `xmin` is assigned monotonically and does
   * order rows by write time, which no declaration can prevent. This asserts that nothing
   * **declared** adds a second such ordering - not that none exists.
   */
  it.each([
    ['the ballot', BALLOT],
    ['the has-voted fact', HAS_VOTED],
  ])('declares no timestamp, sequence or write-ordered column on %s', (_name, table) => {
    const body = tableBody(sql, table);
    expect(body).not.toMatch(/timestamptz|timestamp|\bdate\b|\btime\b/i);
    expect(body).not.toMatch(/serial|bigserial|identity|nextval|sequence/i);
    expect(body).not.toMatch(/now\(\)|clock_timestamp|current_timestamp/i);
    expect(body).not.toMatch(/_at\b|_on\b|\border\b|\bseq\b|position/i);

    // The key is random rather than counted, which is what makes it carry no write order.
    expect(body).toMatch(/id\s+uuid not null primary key default gen_random_uuid\(\)/i);
  });

  /**
   * **What the two tables have in common, exactly.**
   *
   * `round_id`, which yields two sets and no pairing - and `id`, which both carry because this
   * project's tables key on a random uuid and the criterion above requires one. The two `id`
   * columns are independently generated, so a join across them matches nothing; that is asserted
   * against a real Round in `vote.integration.test.ts` rather than argued for here.
   *
   * *Scoped as the file note says*: the two tables also share the system columns `xmin`, `ctid`,
   * `tableoid`, `cmin` and `cmax`, and a join on `round_id` and `xmin` does pair them exactly. This
   * assertion does not claim otherwise.
   */
  it('shares only round_id and an independently random key between the two tables', () => {
    const shared = declaredColumns(ballot).filter((column) =>
      declaredColumns(hasVoted).includes(column),
    );
    expect(shared.sort()).toEqual(['id', 'round_id']);

    // Both keys are random and defaulted independently - neither is derived from the other.
    expect(hasVoted).toMatch(/id\s+uuid not null primary key default gen_random_uuid\(\)/i);
    expect(sql).not.toMatch(/vote[\s\S]{0,80}references round_voter/i);
    expect(sql).not.toMatch(/round_voter[\s\S]{0,80}references vote\b/i);
  });

  /**
   * **Nothing declared relates the ballot to a person, or to the has-voted fact.**
   *
   * Indexes, unique constraints, foreign keys, triggers and views alike - each of them is a
   * declared relationship, and any one of them would make the pairing reachable from a query.
   */
  it('declares no index, constraint, foreign key, trigger or view relating the ballot to identity', () => {
    // No view at all: a view is a query somebody else can now write against.
    expect(sql).not.toMatch(/create (or replace )?view/i);

    for (const table of IDENTITY_TABLES) {
      // Any statement mentioning the ballot table must not also mention an identity table.
      for (const statement of sql.split(';')) {
        if (!new RegExp(`\\b${BALLOT}\\b`).test(statement)) continue;
        expect(statement, `${table} must not appear beside the ballot table`).not.toMatch(
          new RegExp(`\\b${table}\\b`),
        );
      }
    }

    // The single index-bearing statements on the ballot, named, so a third would be visible here.
    expect([...sql.matchAll(/create index (\w+) on vote \(([^)]*)\)/gi)].map((m) => m[1])).toEqual([
      'vote_by_option',
      'vote_by_round',
    ]);
    // Nothing unique per ballot: a unique value on one side is a value the other could be matched
    // against.
    expect(sql).not.toMatch(/create unique index[\s\S]*?on vote\b/i);
  });

  /**
   * **This migration attached exactly one trigger to the ballot table, and no wider one.**
   *
   * It is a reading of an *applied* file, which is why it is still here and still says one: this
   * migration is not edited (ADR-007), and what it wrote is a matter of record. That trigger no
   * longer exists - `20260831090000000_vote-advances-no-cursor.sql` drops it, and the ADR-007 block
   * at the foot of this file is what proves the ballot table now carries none. What this assertion
   * still guards is the shape: were this file ever reopened, a wider trigger on the ballot -
   * `AFTER UPDATE`, a second function, a body of its own - is a defect here too.
   */
  it('attached exactly one trigger to the ballot table, advancing only the round cursor', () => {
    const onBallot = [
      ...sql.matchAll(/create trigger (\w+)\s+([\s\S]*?)execute function (\w+)\(\);/gi),
    ].filter((match) => new RegExp(`on ${BALLOT}\\b`, 'i').test(match[2]!));

    expect(onBallot.map((match) => match[1])).toEqual(['vote_advances_activity_watermark']);
    expect(onBallot[0]![2]).toMatch(/after insert on vote\s+for each row/i);
    expect(onBallot[0]![2]).not.toMatch(/update|delete|when\s*\(/i);
    // S02's one named home for the GREATEST expression, not a copy of it.
    expect(onBallot[0]![3]).toBe('advance_round_activity_watermark');
    expect(sql).not.toMatch(/create function/i);
  });

  /**
   * Editing a Poll's options moves the same one cursor (the Discovered Requirement propagated from
   * S02's review). Without it a room reads stale option labels while voting against them.
   */
  it('advances the same cursor on an option write, through the same named function', () => {
    expect(sql).toMatch(
      /create trigger round_option_advances_activity_watermark\s+after insert or update or delete on round_option\s+for each row\s+execute function advance_round_activity_watermark\(\);/i,
    );
    // Neither of the other two cursors is touched.
    expect(sql).not.toMatch(/schedule_watermark_at/);
    expect(sql).not.toMatch(/last_updated_at/);
    expect(sql).not.toMatch(/alter table (conference|sessions)\b/i);
  });

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  /** Reversible in full: both tables, both indexes, both triggers and the unique constraint. */
  it('is reversible – every object it creates, the down step removes', () => {
    const objects = (text: string, verb: 'create' | 'drop') => ({
      tables: [...text.matchAll(new RegExp(`${verb} table (\\w+)`, 'gi'))].map((m) => m[1]),
      indexes: [...text.matchAll(new RegExp(`${verb} index (\\w+)`, 'gi'))].map((m) => m[1]),
      triggers: [...text.matchAll(new RegExp(`${verb} trigger (\\w+)`, 'gi'))].map((m) => m[1]),
      // A table constraint is added and dropped rather than created and dropped.
      constraints: [
        ...text.matchAll(
          new RegExp(`${verb === 'create' ? 'add' : 'drop'} constraint (\\w+)`, 'gi'),
        ),
      ].map((m) => m[1]),
    });

    const created = objects(up, 'create');
    const dropped = objects(down, 'drop');

    for (const key of Object.keys(created) as (keyof typeof created)[]) {
      expect(created[key].length, key).toBeGreaterThan(0);
      expect(dropped[key].sort(), key).toEqual(created[key].sort());
    }
  });

  /**
   * **The comment says what ADR-006 says, and does not say what ADR-006 forbids.**
   *
   * Correlating a ballot with a voter needs an ordinary `SELECT` on a system column. A schema
   * comment claiming it needs raw table access, superuser rights, filesystem access or a backup
   * would stand as a permanent security assurance that is false, and the next reader would build on
   * it - which ADR-006 § Decision item 4 names as worse than no comment at all.
   */
  it('states the residual in the ADR’s terms and claims nothing stronger', () => {
    /*
     * Unwrapped: the `-- ` prefixes stripped and the whitespace collapsed, so a sentence that
     * happens to wrap across two comment lines is still matched as the one sentence it is. A test
     * that only read unwrapped lines would go green the day somebody reflowed the paragraph.
     */
    const comments = raw
      .split('\n')
      .filter((line) => line.trimStart().startsWith('--'))
      .map((line) => line.trimStart().replace(/^--\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    for (const forbidden of [/raw table access/i, /superuser/i, /filesystem/i, /\bbackup/i]) {
      expect(comments, `${forbidden} must not appear`).not.toMatch(forbidden);
    }

    // And it states the reach positively, names the residual, and cites the ADR by path.
    expect(comments).toMatch(/every application path/i);
    expect(comments).toMatch(/\bxmin\b/);
    expect(comments).toMatch(/ordinary `?SELECT`?/i);
    expect(comments).toMatch(/direct database credentials/i);
    expect(comments).toMatch(
      /ADR-006-vote-anonymity-holds-against-application-paths-not-database-credentials\.md/,
    );
  });
});

// ---------- ADR-007: a Vote advances no cursor, and nothing else lost its trigger ---------------

/**
 * The migration that closes the vote-arrival channel, read as a whole.
 *
 * `activityWatermark` is `max(activity_watermark)` over the Rounds of **one Session**
 * (`api/src/rounds/round-repository.ts`), so on a Session running only a Poll nothing but a ballot
 * could move it - and the endpoint serving it is gated on Membership alone, which is exactly the
 * authority an Attendee refused the running tally already holds. Making the value opaque addressed
 * what it *says*; this migration addresses *when it moves*, by removing the producer.
 *
 * The file text is the surface here. The behaviour - no trigger on `vote`, ballots that move
 * nothing, a Poll close that still does - is proved against the real database in
 * `vote.integration.test.ts`, because a migration that reads correctly and a database that behaves
 * correctly are two different claims (`docs/LEARNINGS.md#testing`).
 */
describe('the migration that stops a vote advancing the cursor', () => {
  const raw = read(repoRoot, 'db', 'migrations', '20260831090000000_vote-advances-no-cursor.sql');
  const sql = withoutSqlComments(raw);
  const [up, down] = raw.split(/^-- Down Migration$/m) as [string, string];

  /**
   * **It drops the ballot trigger, and that is the whole of what it does going up.**
   *
   * Stated as an exact statement list rather than as "mentions DROP TRIGGER": a migration that also
   * created a column, a second cursor or a replacement trigger would be a different decision from
   * the one ADR-007 records, and would pass a looser assertion.
   */
  it('drops exactly the ballot trigger and creates nothing', () => {
    const statements = withoutSqlComments(up)
      .split(';')
      .map((statement) => statement.trim().replace(/\s+/g, ' '))
      .filter((statement) => statement !== '' && !/^-- Up Migration$/i.test(statement));

    expect(statements).toEqual(['DROP TRIGGER vote_advances_activity_watermark ON vote']);
  });

  /**
   * **The three triggers that carry Attendee propagation are not touched.**
   *
   * `post_it` writes are the Board's near-live path; `round_option` writes keep a room from voting
   * against stale labels; and `round_change_advances_activity_watermark`'s WHEN clause includes
   * `OLD.state IS DISTINCT FROM NEW.state`, which is what makes a Poll **closing** advance the
   * cursor so reveal-on-close reaches every Member near-live. Dropping any of them would trade one
   * channel for a broken product requirement.
   */
  it('leaves every other trigger on the cursor alone', () => {
    for (const trigger of [
      'post_it_advances_activity_watermark',
      'round_option_advances_activity_watermark',
      'round_change_advances_activity_watermark',
    ]) {
      expect(sql, trigger).not.toMatch(new RegExp(`drop trigger ${trigger}`, 'i'));
    }
    // Nor is the shared advance function redefined, dropped or joined by a second one.
    expect(sql).not.toMatch(/create (or replace )?function|drop function/i);
    // And neither of the other two cursors is named at all.
    expect(sql).not.toMatch(/schedule_watermark_at|last_updated_at/);
  });

  /**
   * Reversible, and reversible to the *same* trigger: the down step has to put back exactly what
   * `20260829090000000_vote.sql` created, or that migration's own down step stops finding what it
   * drops and the chain is reversible only until the next run.
   */
  it('is reversible – the down step restores the trigger in its original shape', () => {
    expect(down.replace(/\s+/g, ' ')).toMatch(
      /CREATE TRIGGER vote_advances_activity_watermark AFTER INSERT ON vote FOR EACH ROW EXECUTE FUNCTION advance_round_activity_watermark\(\);/i,
    );
    expect(withoutSqlComments(down)).not.toMatch(/drop /i);
  });

  /** Plain PostgreSQL only – portability is why PostgreSQL was chosen (ADR-003). */
  it('uses no extension and no provider-specific feature', () => {
    expect(sql).not.toMatch(/create\s+extension/i);
    expect(sql).not.toMatch(/pgcrypto|uuid-ossp|azure|citus|timescale|aurora/i);
  });

  /**
   * **The comment claims what ADR-007 claims, and no more.**
   *
   * Two things are easy to overclaim here and both would mislead the next reader. The Session
   * Assignment holder's own correlation - watching the live tally move in a room where they can see
   * who just acted - is **not** closed by this migration and is accepted open (ADR-006, amended
   * Decision 1). And ADR-006 Decision 4 forbids any document saying that pairing a ballot with a
   * voter needs raw table access, superuser rights or a filesystem: it needs an ordinary `SELECT`.
   */
  it('states what it does not close, and claims no elevated right is needed to correlate', () => {
    const comments = raw
      .split('\n')
      .filter((line) => line.trimStart().startsWith('--'))
      .map((line) => line.trimStart().replace(/^--\s?/, ''))
      .join(' ')
      .replace(/\s+/g, ' ');

    for (const forbidden of [/raw table access/i, /superuser/i, /filesystem/i, /\bbackup/i]) {
      expect(comments, `${forbidden} must not appear`).not.toMatch(forbidden);
    }

    expect(comments).toMatch(/ordinary `?SELECT`?/i);
    expect(comments).toMatch(/live tally/i);
    expect(comments).toMatch(/OLD\.state IS DISTINCT FROM NEW\.state/);
    expect(comments).toMatch(
      /ADR-007-vote-arrivals-do-not-advance-the-member-visible-cursor\.md|ADR-007/,
    );
  });
});

// ---------- the API: no application path relates a Vote to its voter (TI03, TI04, TI05) ----------

describe('the vote read and write paths', () => {
  const repository = read(apiSrc, 'votes', 'vote-repository.ts');
  const routes = read(apiSrc, 'routes', 'rounds.ts');

  /** Everything that touches the ballot table lives in one module, so there is one thing to read. */
  it('reaches the ballot and has-voted tables only from the votes module', () => {
    const offenders = sourcesUnder(apiSrc)
      .filter((path) => {
        if (relativeTo(apiSrc, path).startsWith('/votes/')) return false;
        const source = withoutComments(readFileSync(path, 'utf8'));
        return sqlStatementsIn(source).some((statement) =>
          new RegExp(`\\b(${BALLOT}|${HAS_VOTED})\\b`).test(statement),
        );
      })
      .map((path) => relativeTo(apiSrc, path));
    expect(offenders).toEqual([]);
  });

  /**
   * **No query anywhere joins the ballot table to anything that identifies a person.**
   *
   * Statement by statement rather than file by file: a module may legitimately mention both tables
   * (this one does), and what must never happen is that one *statement* names the ballot and an
   * identity-bearing table together.
   */
  it('writes no statement naming the ballot table beside an identity-bearing table', () => {
    const statements = sourcesUnder(apiSrc).flatMap((path) =>
      sqlStatementsIn(readFileSync(path, 'utf8')).map(
        (statement) => [relativeTo(apiSrc, path), statement] as const,
      ),
    );
    // The suite must not pass by finding nothing to look at.
    expect(statements.filter(([, sql]) => /\bvote\b/i.test(sql)).length).toBeGreaterThan(0);

    for (const [path, statement] of statements) {
      /*
       * Case-insensitive, here and on the identity tables below. SQL identifiers are not
       * case-sensitive, so `from VOTE v join app_user` is the same query as the lowercase one -
       * and a guard that skipped it would be answering a question about spelling rather than about
       * what the statement does.
       */
      if (!/\bvote\b/i.test(statement)) continue;
      for (const table of IDENTITY_TABLES) {
        expect(statement, `${path} joins the ballot table to ${table}`).not.toMatch(
          new RegExp(`\\b${table}\\b`, 'i'),
        );
      }
      expect(statement, path).not.toMatch(/user_sub|\bsub\b|display_name|mail/i);
    }
  });

  /**
   * **Every read of the ballot table is a count grouped by option, or an `exists` boolean.**
   *
   * No statement selects a ballot row, and none returns one to a caller. Asserted as an
   * allow-list of the shapes rather than a denylist of the ones nobody has thought of yet.
   */
  it('reads the ballot table only as a grouped count or an exists boolean', () => {
    const reads = sqlStatementsIn(repository)
      .concat(sqlStatementsIn(read(apiSrc, 'rounds', 'ballot-gate.ts')))
      .filter((statement) => /\bfrom vote\b|\bjoin vote\b/i.test(statement));
    expect(reads.length, 'the ballot reads should be found').toBeGreaterThan(0);

    for (const statement of reads) {
      const counted = /count\(v\.id\)::int as votes/.test(statement);
      const exists = /select exists \(select 1 from vote where round_id = \$1\)/.test(statement);
      /*
       * A third shape, added by S05's contribution-safe Session deletion (FR7): how many ballots a
       * whole Session holds, so the deletion guard can say how many would be lost. It is a number
       * about a *set* of ballots exactly as the other two are - reached through the Round alone,
       * grouped by nothing, selecting no ballot column - which is why it belongs on this list
       * rather than widening it. Pinned to its exact text so a later edit cannot turn it into a
       * read of ballots that happens to start with `count(`.
       */
      const perSession =
        /select count\(\*\)::int as count\s+from vote v\s+join round r on r\.id = v\.round_id\s+where r\.conference_id = \$1 and r\.session_id = \$2/.test(
          statement,
        );
      expect(counted || exists || perSession, `not a count or an exists: ${statement}`).toBe(true);
      // Never a ballot column on the way out.
      expect(statement).not.toMatch(/select v\.\*|select \*\s+from vote|v\.id\s*,|returning \*/i);
    }

    /*
     * The counting fragment is composed with a `where` and a `group by` at each call site, so the
     * "grouped by option" half of the criterion is asserted on the composition rather than on the
     * fragment - which on its own carries neither.
     */
    const compositions = [...repository.matchAll(/\$\{TALLY\}([\s\S]*?)`/g)].map((m) => m[1]!);
    expect(compositions.length, 'the tally call sites should be found').toBe(2);
    for (const composition of compositions) {
      expect(composition).toMatch(/group by o\.round_id, o\.id, o\.position/);
      expect(composition).not.toMatch(/user_sub|round_voter|app_user/);
    }

    // The insert returns nothing at all, so no ballot id can reach a caller and be correlated
    // with the response that carried it.
    expect(repository).toMatch(/insert into vote \(round_id, option_id\) values \(\$1, \$2\)/);
    expect(repository).not.toMatch(/insert into vote[\s\S]{0,120}returning/i);
  });

  /**
   * **The voter's `sub` reaches the has-voted claim and stops there.**
   *
   * The two writes are separate functions on purpose: the one that writes a ballot has no parameter
   * a `sub` could arrive through, so a ballot writer that was merely *able* to see one would fail
   * here even while it ignored it. That is the property, not "it happens not to use it".
   */
  it('gives the ballot writer no parameter a voter identity could arrive through', () => {
    const writer = /async function writeTheBallot\(([^)]*)\)/.exec(withoutComments(repository));
    expect(writer, 'writeTheBallot should be found').not.toBeNull();
    expect(writer![1]).not.toMatch(/sub|voter|user|member|caller|email/i);
    expect(writer![1]!.replace(/\s+/g, ' ').trim()).toBe(
      'tx: Queryable, roundId: string, optionId: string',
    );

    const claim = /async function claimTheVote\(([^)]*)\)/.exec(withoutComments(repository));
    expect(claim, 'claimTheVote should be found').not.toBeNull();
    // And the claim, which does take the `sub`, has no option to write it against.
    expect(claim![1]).not.toMatch(/option/i);
  });

  /**
   * Single use is the database's uniqueness rule, never a check made first.
   *
   * Two submissions from one person arriving together both pass a pre-read; only one wins a unique
   * constraint (`docs/LEARNINGS.md#concurrency`). Proved under real concurrency in
   * `vote.integration.test.ts` – this pins that the *mechanism* has not been swapped for a read.
   */
  it('enforces single use with the unique constraint and no pre-read', () => {
    expect(repository).toMatch(/'23505'/);
    expect(repository).toMatch(/round_voter_once_per_round/);

    /*
     * The has-voted table is written and never *asked about* on the cast path. Any read of it here
     * would be a pre-read standing in for the constraint - and the row lock the cast takes would
     * make such a pre-read look correct under test while leaving the guarantee in the wrong layer,
     * so this pins the mechanism rather than the outcome.
     */
    for (const statement of sqlStatementsIn(repository)) {
      if (!new RegExp(`\\b${HAS_VOTED}\\b`).test(statement)) continue;
      const written = /insert into round_voter/.test(statement);
      const ownVotedRounds = /select rv\.round_id/.test(statement);
      expect(written || ownVotedRounds, `a pre-read of the has-voted table: ${statement}`).toBe(
        true,
      );
    }
    // Nothing is retained between requests - the API runs across replicas (ADR-004).
    for (const path of [
      join(apiSrc, 'votes', 'vote-repository.ts'),
      join(apiSrc, 'routes', 'rounds.ts'),
    ]) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(/^(let|var)\s/m);
      expect(source, path).not.toMatch(/^const\s+\w+\s*=\s*new (Map|Set|WeakMap|WeakSet)\b/m);
    }
  });

  /**
   * **No refusal on this path can carry a tally.**
   *
   * A duplicate-vote refusal or an open-Poll tally refusal that helpfully returned counts would
   * hand the result to somebody it is deliberately withheld from, through the one response nobody
   * inspects. Asserted on the refusal builders themselves, which is where such a thing would be
   * added.
   */
  it('builds every vote refusal without a count, a total or per-option data', () => {
    const bodyOf = (name: string): string => {
      const at = withoutComments(routes).indexOf(`function ${name}(`);
      expect(at, `${name} should be found`).toBeGreaterThan(-1);
      const source = withoutComments(routes).slice(at);
      return source.slice(0, source.indexOf('\n}\n') + 3);
    };

    /*
     * The prose is free to *say* "votes" and "options" - it is a sentence a person reads. What may
     * never appear is a route into the data: a call to the vote repository, a tally value, a
     * per-option structure, or `withCurrent`, which is the one channel `AppError` has for putting a
     * payload on a refusal.
     */
    for (const name of ['refuseCast', 'resultsNotYetAvailable']) {
      // The displayable sentences are stripped first: they are prose a person reads, and one of
      // them ends a clause with the word "votes". What is left is the code, which is the half that
      // could reach data.
      const code = bodyOf(name).replace(/'(?:[^'\\]|\\.)*'/g, "''");
      expect(code, name).not.toMatch(/votes\.|tally|OptionTally|optionId|\bcount\b/i);
      expect(code, name).not.toMatch(/withCurrent/);
      // A refusal carries a code and a sentence. Nothing here builds an object to attach.
      expect(code, name).not.toMatch(/\.map\(|JSON\.|\[\s*\{/);
    }

    // And the cast response itself carries no tally, even to somebody entitled to read one.
    const cast = /rounds\/:roundId\/votes'[\s\S]*?^ {2}\}\);$/m.exec(withoutComments(routes))?.[0];
    expect(cast, 'the cast route should be found').toBeDefined();
    expect(cast).not.toMatch(/tally|tallyFor|votes\.tally/);
    expect(cast).toMatch(/return \{ voted: true \};/);
  });

  /** Every S03 refusal goes through the shared error envelope, one code per reason. */
  it('declares every vote refusal through the shared error envelope', () => {
    const errors = read(apiSrc, 'errors.ts');
    const raised = new Set(
      withoutComments(routes)
        .match(/ERROR_CODES\.(VOTE_\w+|VOTING_\w+|POLL_RESULTS_\w+)/g)
        ?.map((match) => match.replace('ERROR_CODES.', '')) ?? [],
    );
    expect(raised.size).toBeGreaterThan(0);
    for (const code of raised) expect(errors).toMatch(new RegExp(`^ {2}${code}:`, 'm'));
  });

  /** The cast and tally endpoints exist, and both go through the auth wrapper. */
  it('registers the cast and the tally, both authenticated', async () => {
    const app = buildApp({ db: fakeDatabase(), auth: fakeAuth() });
    try {
      const base = '/api/conferences/:conferenceId/sessions/:sessionId/rounds/:roundId';
      const urls = app.confappRoutes.map((route) => `${route.method} ${route.url}`);
      expect(urls).toContain(`POST ${base}/votes`);
      expect(urls).toContain(`GET ${base}/tally`);

      for (const route of app.confappRoutes.filter((entry) => /votes|tally/.test(entry.url))) {
        expect(route.authenticated, `${route.method} ${route.url}`).toBe(true);
      }
    } finally {
      await app.close();
    }
  });
});

// ---------- offline support and the one cursor do not widen (TI09, TI10) ----------

describe('this story widens neither offline support nor the propagation mechanism', () => {
  it('caches no vote, has-voted fact or tally, and queues none for later send', () => {
    for (const path of sourcesUnder(join(webSrc, 'offline'))) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(/\bvote\b|\btally\b|\bpoll\b|hasVoted/i);
    }

    for (const path of sourcesUnder(join(webSrc, 'activities'))
      .concat(sourcesUnder(join(webSrc, 'poll')))
      .concat([join(webSrc, 'api', 'client.ts')])) {
      const source = withoutComments(readFileSync(path, 'utf8'));
      expect(source, path).not.toMatch(/localStorage|indexedDB|caches\.|serviceWorker/);
      expect(source, path).not.toMatch(
        /outbox|replay|pendingWrite|pending[_-]?mutation|syncQueue|conflictResolution/i,
      );
    }
  });

  /**
   * **One cursor and one loop.** S03's tally is a third consumer of S02's poll, never a third
   * mechanism: no new cadence constant, no timer of its own, no socket, and no second loop keeping
   * its own overlap guard.
   */
  it('adds no second polling cadence, loop guard, timer or subscription under web/src', () => {
    /*
     * Scoped to the surfaces this story writes - the activities panel, the poll module and the API
     * client - because the assertion is that *this story* adds no second mechanism. Two unrelated
     * timers already exist elsewhere and are neither watermark polls nor this story's to move: the
     * attendee schedule's minute tick that re-highlights the current Session (S09), and the auth
     * provider's reachability-probe abort deadline.
     */
    const loop = join(webSrc, 'poll', 'use-watermark-poll.ts');
    const activities = sourcesUnder(join(webSrc, 'activities'));
    const pollModule = sourcesUnder(join(webSrc, 'poll')).filter((path) => path !== loop);
    const mine = activities.concat(pollModule).concat([join(webSrc, 'api', 'client.ts')]);
    expect(mine.length, 'this story’s web sources should be found').toBeGreaterThan(0);

    const offenders = mine
      .filter((path) => {
        const source = withoutComments(readFileSync(path, 'utf8'));
        return /setInterval|setTimeout|EventSource|new WebSocket|POLL_INTERVAL/i.test(source);
      })
      .map((path) => relativeTo(webSrc, path));
    expect(offenders).toEqual([]);

    /*
     * The loop's overlap guard belongs to the loop and to nothing else - stated as "exactly one
     * module holds it", which is **narrower than the sweep it replaces and not a deletion of it**.
     *
     * What must not appear is a second loop keeping its own "a tick is already out" latch. The
     * identifier is matched exactly - `\binFlight\b`, case-sensitive - because JavaScript
     * identifiers are case-sensitive and `inFlight` is the loop's own. `voteInFlight` on the
     * activities panel is a different identifier and a different mechanism: a write guard on a
     * button press that starts on a tap, ends on a response and schedules nothing, stopping a
     * double-tap from turning one intent into two casts of a single-use Vote.
     *
     * A second polling loop still cannot hide behind that name, because a loop needs a timer, a
     * cadence or a socket to drive it and the sweep above denies every one of those across all
     * three surfaces.
     */
    const guarding = sourcesUnder(webSrc)
      .filter((path) => /\binFlight\b|pollingRef/.test(withoutComments(readFileSync(path, 'utf8'))))
      .map((path) => relativeTo(webSrc, path));
    expect(guarding).toEqual(['/poll/use-watermark-poll.ts']);

    // And the cadence itself is declared in exactly one place in the whole application.
    const declaring = sourcesUnder(webSrc)
      .filter((path) => /export const POLL_INTERVAL_MS/.test(readFileSync(path, 'utf8')))
      .map((path) => relativeTo(webSrc, path));
    expect(declaring).toEqual(['/poll/use-watermark-poll.ts']);

    // And the loop it must use is genuinely the one this story's panel is wired to.
    const panel = withoutComments(read(webSrc, 'activities', 'SessionActivitiesPanel.tsx'));
    expect(panel).toMatch(/useWatermarkPoll\(/);
    expect(panel).not.toMatch(/roundsLastUpdatedAt/);
  });
});
