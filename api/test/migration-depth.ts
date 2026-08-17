import type pg from 'pg';

/**
 * How many migrations must be reverted to undo a named one.
 *
 * A reversibility test is about one migration's down step, but `migrate down` counts backwards
 * from the newest. Hard-coding a count therefore states "app_user is the last migration", which
 * stops being true the moment the next story adds one – and the test then fails somewhere else
 * entirely, reporting that a perfectly good down step is broken.
 *
 * Asking the applied-migration table instead lets each test say what it means: revert far enough
 * to include *this* migration, whatever has been added on top since.
 */
export async function stepsToRevertThrough(
  client: pg.Client,
  migrationName: string,
): Promise<number> {
  const applied = await client.query<{ name: string }>('select name from pgmigrations order by id');
  const names = applied.rows.map((row) => row.name);
  const index = names.indexOf(migrationName);

  if (index === -1) {
    throw new Error(
      `Migration ${migrationName} is not applied, so there is nothing to revert through. ` +
        `Applied: ${names.join(', ') || '(none)'}.`,
    );
  }

  return names.length - index;
}
