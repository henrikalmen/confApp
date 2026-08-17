import type { Database } from '../db.ts';
import type { VerifiedClaims } from './verify-id-token.ts';

/**
 * The `app_user` repository.
 *
 * A user exists from their first verified sign-in. Nothing else creates one: a refused token
 * never reaches this module, which is what makes "a wrong-domain token creates no user row"
 * a property of the call graph rather than of a check someone remembered to write.
 *
 * The upsert conflicts on `sub` – the identity – and refreshes email and display name, which
 * are display data that follows whatever Google currently says. A rename therefore updates one
 * row instead of creating a second, and two people who have at some point shared an address
 * stay two rows.
 */

export interface AppUser {
  id: string;
  sub: string;
  email: string;
  displayName: string;
}

interface AppUserRow {
  id: string;
  sub: string;
  email: string;
  display_name: string;
}

const UPSERT = `
  insert into app_user (sub, email, display_name)
  values ($1, $2, $3)
  on conflict (sub) do update
    set email        = excluded.email,
        display_name = excluded.display_name,
        last_seen_at = now()
  returning id, sub, email, display_name
`;

export interface UserRepository {
  upsertFromClaims(claims: VerifiedClaims): Promise<AppUser>;
}

export function createUserRepository(db: Database): UserRepository {
  return {
    async upsertFromClaims(claims: VerifiedClaims): Promise<AppUser> {
      const rows = await db.query<AppUserRow>(UPSERT, [
        claims.sub,
        claims.email,
        claims.displayName,
      ]);

      const row = rows[0];
      if (row === undefined) {
        // `returning` on an upsert always yields a row; if it did not, something is wrong with
        // the statement rather than with the caller, so this must not be reported as a refusal.
        throw new Error('The app_user upsert returned no row.');
      }

      return { id: row.id, sub: row.sub, email: row.email, displayName: row.display_name };
    },
  };
}
