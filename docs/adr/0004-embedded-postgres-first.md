# ADR 0004 — Embedded Postgres by default, real Postgres opt-in

**Status:** Accepted · 2026-11-03

## Context

The project needs Postgres behavior because its core invariants depend on it: a partial unique index, `ON CONFLICT ... DO NOTHING`, `BIGINT` timestamps, and SQL that behaves identically in tests and production. At the same time, a reference implementation should start with `npm install && npm run demo`, without Docker, a local Postgres service or credentials. The target machine did not have Docker installed.

## Decision

Default to **PGlite** (`@electric-sql/pglite`), Postgres compiled to WASM and embedded in the Node process. Support **real Postgres** through `pg` behind the same minimal `Db` interface, selected by `DB_DRIVER` and `DATABASE_URL`. Provide `docker-compose.yml` and run the same migrations for both.

PGlite is a single connection, so `src/db.ts` funnels every statement and every transaction through one promise-chain lock. Without that, a stray query could land inside another flow's `BEGIN ... COMMIT`.

## Consequences

- Zero-setup demo and tests, with real Postgres semantics rather than a SQLite approximation.
- Single-process only for PGlite. Horizontal scaling requires `DB_DRIVER=postgres`.
- The lock reduces concurrency to one statement at a time for PGlite. That is fine for a demo and test suite, and it makes transaction isolation explicit rather than accidental.
- Features that assume multiple connections (advisory locks across sessions, `LISTEN/NOTIFY`, parallel workers) are out of scope on PGlite.
- Postgres parity is asserted by sharing SQL and migrations, but not yet by a CI matrix against a real server. That is a known gap.
- `BIGINT` values can surface as strings or BigInt depending on the driver; all row mapping goes through `Number()` helpers so the domain sees numbers.

## Alternatives rejected

- **SQLite (`node:sqlite`)** — supports partial indexes, but the SQL dialect differs from Postgres and would not validate the production path. It also splits the migration story.
- **Always Docker Postgres** — heavier setup for a teaching repo and unavailable on the target machine.
- **In-memory Maps for the demo** — would hide the database invariants that are the point of the project.
- **An ORM** — adds indirection over the few SQL statements that matter most; raw SQL keeps the partial index, conflict handling and locking visible.
