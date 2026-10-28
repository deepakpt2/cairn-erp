# Migration authoring — tables, grants and the New PostgreSQL Grant Policy

Operational guide for anyone adding or changing a table. It states the rule the
database already enforces, so a migration written to it passes on the first run.
The policy decisions behind it are `drizzle/9186_default_privileges_immutable_defaults.sql`,
`drizzle/9187_immutable_record_grants.sql` and D-145; the automated check is
`tests/migration-grant-policy.test.ts`.

## The default, verified on the live database

The migration role `cairn` owns every object in `public`. The runtime role
`cairn_app` is non-owner, non-superuser, `NOBYPASSRLS`, has no role memberships
and no `CREATE` on the schema, so everything it can do is a direct grant.

Since `9186`, the only default ACL in the database is:

```
grantor  schema  type    acl
cairn    public  tables  {cairn_app=ar/cairn}
```

So **a new table receives `SELECT` and `INSERT` for `cairn_app` and nothing else.**
`UPDATE`, `DELETE` and `TRUNCATE` are not automatic, and there is no default for
sequences, functions or types — a new sequence grants the runtime role nothing.

Before `9186` the default was `arwd`, which is how `9183`'s snapshot tables
picked up mutation rights the application never asked for. Do not restore that
default, and do not add a broader one.

## The convention: a migration declares the rights its tables need

Pick the one case that matches the table and write it into the migration.

| Table kind | What the migration says | Result |
|---|---|---|
| Read/insert-only, append-only, snapshot, audit, event trail | nothing required; `revoke update, delete, truncate on table public.t from cairn_app;` to make the intent explicit and restate it if a later broad grant ever reopens the path | `cairn_app` = `SELECT, INSERT` |
| Mutable business table | `grant update, delete on table public.t to cairn_app;` — or only `update`, or only `delete`, as the verified service behaviour requires | `cairn_app` = `SELECT, INSERT` + what was granted |
| Sequence used by runtime code | `grant usage on sequence public.s to cairn_app;` | `USAGE` only, no `SELECT` on values unless needed |
| Administrative or migration-owned object (e.g. `cairn_migration`) | no grant to `cairn_app` at all | runtime role sees nothing |

Grant the privilege a service actually exercises — read the writer, do not
assume. `TRUNCATE` stays with the owner unless there is a documented reason, and
the runtime role holds it on no table today. Owner-side administration stays with
`cairn`; never solve a runtime denial by elevating `cairn_app` with `BYPASSRLS`,
`CREATE`, membership or ownership, and never fix a broken grant by editing an
applied migration.

`cairn_app` deliberately lacks `UPDATE`/`DELETE` on the append-only set protected
by `9185`, `9186` and `9187` (13 tables, including the production-order
operation snapshots). Keep it that way: a confirmation, reversal or close run
writes a new row, it does not rewrite history. Tenant deletion still works
because the `client` foreign key cascades on the owner side (`D-041`), and a
cascade removes rows in a table whose own `DELETE` is revoked.

## Keys: use identity, not serial

An identity column is gated by the table's `INSERT` privilege, so it works under
the restricted default. A `serial` column is gated by `USAGE` on its own implicit
sequence, which no table grant covers — under this policy a `serial` primary key
makes the table unwritable by the runtime role.

```sql
id integer generated always as identity primary key   -- correct
id serial                                             -- breaks the runtime insert
```

Today the schema carries no `serial` column at all, and exactly one identity
column — `supplier_invoice_payment_block_event.event_id`, whose sequence is
owner-only (`has_sequence_privilege('cairn_app', …, 'USAGE')` is false), so no
sequence grant is involved for it. That identity path is proven live in
`tests/migration-grant-policy.test.ts`: the runtime role inserts into a fresh
identity-column table and is denied `UPDATE` on it, while a fresh `serial` table
stays unwritable until its sequence is granted.

Keep it that way: business codes and caller-supplied identifiers first, `generated always as
identity` when a surrogate is genuinely needed, `serial` never.

## Adding a new mutable table — the exact steps

1. Define the table in `src/modules/<module>/schema.ts` and register it in
   `src/platform/schema.ts` (`§20.3`).
2. Generate or hand-write the migration; hand-written policy files sort `9000+`
   (`D-039`). Never edit an applied migration — the runner checks checksums and
   refuses.
3. Confirm the service behaviour: does a use case `update` or `delete` the row,
   or does it insert a new one? Read the writer.
4. Add the declaration to the same migration, naming the table and `cairn_app`,
   with the minimum privileges from step 3.
5. If the table is tenant-scoped, carry the `client` foreign key with
   `ON DELETE CASCADE` and the forced tenant policy, per `D-041`.
6. Apply with the migration role (`npm run db:migrate`) and run the database gate
   — `npm run db:verify` — plus your module's tests. Use
   `9022_central_address_sequence_grants.sql` as the worked example of a narrow
   sequence grant.

## Before deploying: the grant gate

`npm run db:verify` is the standard pre-deployment check for anything that
touches the database. It loads `.env.local` if present, then runs the two live
privilege suites:

```
npm run db:verify
  → tests/migration-grant-policy.test.ts   (the grant policy, 9 tests)
  → tests/default-privilege-audit.test.ts  (the append-only floor, 4 tests)
```

Run it after `npm run db:migrate` and before publishing, whenever a change:

- creates, drops or alters a table, column or constraint;
- grants or revokes any privilege, or touches `alter default privileges`;
- adds a sequence, an identity column, or a key generation path;
- changes `src/platform/db/client.ts`, `migrate.ts`, `sync-db-app-role.ts`, the
  Docker migration job, or the role definitions in deployment;
- adds a service that writes to a table it did not write to before.

`npm run test` already collects both files, so the whole-suite run covers the
same ground; `db:verify` exists because a migration must not wait eight minutes
for an unrelated browser-harness or UI contract to find out that a grant was
missing. It is a focused gate, not a replacement for the full suite.

**It fails closed, and it refuses the wrong target.** The first test asserts
that `DATABASE_URL` and `MIGRATION_DATABASE_URL` are both set, that they name the
same database, that `CAIRN_ENV` is development, and that the two connections
report `cairn_app` and `cairn` respectively. With no configuration at all the run
dies in `tests/global-setup.ts` against a database that does not exist; with only
the migration URL set it fails with `DATABASE_URL is unset: the runtime client
would fall back to a hard-coded development URL and the gate would judge the wrong
database`. Either way the exit code is nonzero — a green run always means real
ACLs were read from the configured database. Because the gate creates and drops
probe tables, it is never pointed at production, and no production target is
configured for it; the deployment design offers no read-only production variant
of this check, so there is none to run.

**A pending migration is applied to that target by the gate itself.**
`tests/migration-grant-policy.test.ts` calls `runMigrations()` to prove the
runner still works under the restricted default, and `runMigrations()` applies
whatever the target is missing — it does not dry-run. So running `db:verify`
while `.env.local` points `MIGRATION_DATABASE_URL` at a database you do not
intend to change (an acceptance or demo database, for instance) will migrate
it. Measured on 2026-10-28: one `db:verify` run applied a new People migration
to the browser-acceptance database, five empty tables and six registry rows,
and left no existing row altered. To run the two suites against the test
database instead, skip the `.env.local` load and give them the test env:

```sh
set -a; . ./.env.development.example; set +a
npx vitest run tests/migration-grant-policy.test.ts tests/default-privilege-audit.test.ts
```

**A `revoke … from cairn_app` line declares the table immutable, so it cannot
sit beside a `grant update`.** The gate collects every table any migration
revokes from the runtime role and asserts live that the role can do none of
UPDATE, DELETE or TRUNCATE on it — that is how 9185-9187 keep the ledger
append-only and how 9016 and 9017 keep privacy tables read-only. A table whose
rows must be written once more than inserted (a dated record that gets its last
day, a document that gets a status) therefore must not carry a revoke: it
grants the one privilege its writers exercise, and DELETE and TRUNCATE stay
denied because 9186's default for a table the migration role creates is SELECT
and INSERT. Proving "nothing may be deleted" belongs in a test that attempts
the delete and expects `permission denied`, which is what the slice tests do;
proving it with a revoke would simultaneously forbid the update the table
needs. `drizzle/9193_people_record_types_and_employee.sql` is the worked
example of that shape, and its comment block states the reasoning beside the
grants.

**Passing this gate is not passing the suite.** `db:verify` says the privilege
contract holds: the default is `SELECT` and `INSERT`, declared-immutable tables
deny mutation, and every table a service edits still has its grant. It says
nothing about business behaviour, so a module suite, the golden flows and
`npm run test` remain the acceptance signal. When `npm run test` has failures
that predate your change — today the baseline includes seed-fixture and
source-text contract failures unrelated to grants — compare file lists before and
after rather than reading a red suite as a privilege regression. The grant gate
is green or red on its own terms, and it is the one that owns this policy.

## What the automated check enforces

`tests/migration-grant-policy.test.ts` reads live catalogs — never a mock:

- the gate checks its own target first: both URLs set and naming the same
  database, `CAIRN_ENV` development, runtime connection `cairn_app` and
  non-elevated, owner connection `cairn`;

- the effective default ACL for future tables is exactly `SELECT` and `INSERT`,
  with no default for sequences, functions or types;
- every table that any applied migration revokes from `cairn_app` really denies
  `UPDATE`, `DELETE` and `TRUNCATE`, and the append-only floor still permits
  `SELECT` and `INSERT`;
- every table the application updates or deletes — derived from the services and
  resolved through the Drizzle schema — still holds that privilege, which is how
  a missing runtime grant on a new table surfaces;
- a migration written after the policy was applied must declare a table's intent
  and must not use `serial` without a sequence grant, with the file, table and
  exact fix in the failure message;
- a probe table created by `cairn` during the run confirms both halves: an
  identity-column table is insertable and un-updatable by the runtime role, and a
  `serial` table becomes insertable only after `grant usage`. Probes are dropped
  and their absence asserted.

The checks derive their expectations from applied migrations, the ledger
`applied_at` of `9186`, and the application's own SQL, so adding tables does not
require editing the test and no total table count is pinned.

## What the gate cannot see

The functional half is live: privileges, sequence access and object defaults are
read from the catalog of the database the runtime role actually connects to. The
declaration half is not — no catalog row says whether a table left at
`SELECT` and `INSERT` is intentional or forgotten, so that rule is read from the
migration file (comments stripped, so prose is never mistaken for a grant). A
table written through a `SECURITY DEFINER` function or a dynamically assembled
table name is also outside the service scan that derives the required grants.
Neither gap is closed by a broader default: the fix would be an event trigger and
a declaration ledger, which is a redesign this policy deliberately does not
attempt. Review still owns intent; the gate owns drift.
