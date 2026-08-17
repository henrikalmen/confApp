-- Up Migration

-- app_meta is deliberately not a domain table. It exists to prove the database round trip
-- end to end (SPA container -> API container -> PostgreSQL) and to carry the schema version.
-- The conference domain tables – Conference, Session, Membership, Role Assignment – belong
-- to S03-S07 and are not created here.
--
-- Plain PostgreSQL only: no CREATE EXTENSION, no provider-specific types, functions or DDL.
-- Production hosting is deliberately undecided (ADR-003) and portability is the reason
-- PostgreSQL was chosen, so nothing here may tie the schema to one managed provider.

CREATE TABLE app_meta (
  key   text PRIMARY KEY,
  value text NOT NULL
);

INSERT INTO app_meta (key, value) VALUES ('schema_version', '1');

-- Down Migration

DROP TABLE app_meta;
