// Migration runner.
//
// Wraps node-pg-migrate's programmatic API so the project gets one command shape that works
// the same on every platform and loads the untracked `.env` itself. Migrations are plain SQL
// with an executable down step; applied migrations are recorded in the database, so a run
// against a volume that already holds the schema skips what is applied rather than
// re-executing it. That is the normal case after the first run, not the exception.
//
// Usage:  node migrate.mjs up
//         node migrate.mjs down [count]   (count defaults to 1)
//         node migrate.mjs down all       (reverts every applied migration)

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runner } from 'node-pg-migrate';

const here = dirname(fileURLToPath(import.meta.url));

const [, , rawDirection = 'up', rawCount] = process.argv;
const direction = rawDirection === 'down' ? 'down' : 'up';

if (!['up', 'down'].includes(rawDirection)) {
  console.error(`Unknown direction "${rawDirection}". Use "up" or "down".`);
  process.exit(2);
}

// `Infinity` is how node-pg-migrate expresses "as many as apply".
let count = Infinity;
if (direction === 'down') {
  count = rawCount === undefined ? 1 : rawCount === 'all' ? Infinity : Number(rawCount);
  if (!Number.isFinite(count) && rawCount !== 'all') {
    console.error(`Invalid count "${rawCount}". Use a number or "all".`);
    process.exit(2);
  }
}

// The test suite points this at its own database so a down-to-zero cycle can never destroy a
// developer's working data.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error(
    'DATABASE_URL is not set. Copy .env.example to .env, or pass it in the environment.',
  );
  process.exit(2);
}

try {
  const applied = await runner({
    databaseUrl,
    dir: join(here, 'migrations'),
    direction,
    count,
    migrationsTable: 'pgmigrations',
    verbose: true,
  });

  if (applied.length === 0) {
    console.log(`Nothing to ${direction}: the database is already at the requested state.`);
  } else {
    console.log(`Migrations ${direction}: ${applied.map((m) => m.name).join(', ')}`);
  }
  process.exit(0);
} catch (error) {
  console.error(`Migration ${direction} failed:`, error instanceof Error ? error.message : error);
  process.exit(1);
}
