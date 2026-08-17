-- Up Migration

-- app_user is the confApp record of a person who has signed in at least once. Users are not
-- provisioned from a directory – ADR-002 rejected directory access, so a row exists from its
-- owner's first successful sign-in and never before.
--
-- `sub` is the identity. It is the Google OIDC subject claim: stable for the life of the
-- account, and the only thing about a person that is. Every later story's foreign keys
-- reference this column (S03, S05, S06, S07 and onwards) – there is no "or id where
-- convenient". `id` is confApp's own surrogate key for this row and is carried on the
-- authenticated caller for local convenience only.
--
-- email carries NO uniqueness constraint, deliberately, and that is not an oversight:
-- addresses change (anna.smith@ becomes anna.jones@) and are reissued to different people
-- after someone leaves. A unique index here would reject the rename and would let a recycled
-- address collide two distinct employees into one row. Email is display data.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types or functions.
-- Production hosting is deliberately undecided (ADR-003) and portability is why PostgreSQL
-- was chosen. gen_random_uuid() is core since PostgreSQL 13, not the pgcrypto extension.

CREATE TABLE app_user (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  sub          text        NOT NULL UNIQUE,
  email        text        NOT NULL,
  display_name text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now()
);

-- Down Migration

DROP TABLE app_user;
