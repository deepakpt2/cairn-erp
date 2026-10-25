/**
 * Grant-policy checks for future ERP tables (drizzle/9186, drizzle/9187).
 *
 * The policy: a new table in schema `public` created by the migration role
 * receives SELECT and INSERT for the runtime role `cairn_app` and nothing
 * else. UPDATE, DELETE, TRUNCATE and sequence USAGE are never automatic — a
 * migration that needs them must say so on the same table. These tests hold
 * that rule against the live database, not against migration text alone:
 * every privilege fact below is read from the catalog through the runtime
 * connection, so a change to the server configuration fails here even if the
 * SQL files still look correct.
 *
 * Two checks derive their expectations instead of hard-coding them:
 *   * the protected set is the set of tables that any applied migration
 *     revokes from `cairn_app` (9185/9186/9187 today, anything later as well);
 *   * the required-mutable set is derived from what the application actually
 *     updates and deletes.
 * Neither pins the total table count, so adding tables is not a failure.
 *
 * The authoring rule for a new table is documented in docs/migration-authoring.md.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getTableName, sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { db } from '../src/platform/db/client';
import { runMigrations } from '../src/platform/db/migrate';
import * as schemaRoot from '../src/platform/schema';
import { closeDb } from './helpers';

const MIGRATION_DIR = join(process.cwd(), 'drizzle');
const RUNTIME_ROLE = 'cairn_app';
const OWNER_ROLE = 'cairn';

/**
 * The tables the policy protects today. This is a floor, not a census: the
 * enforced set is derived from the migrations below, so a new revoke is
 * covered automatically and a removed one fails loudly.
 */
const PROTECTED_FLOOR = [
  'production_order_operation',
  'production_order_operation_value',
  'supplier_invoice_payment_block_event',
  'credit_change_audit',
  'credit_release_event',
  'consolidation_execution_log',
  'clearing_reset',
  'credit_determination',
  'internal_order_original_budget',
  'internal_order_original_budget_year',
  'closing_task_event',
  'document_status_history',
  'document_flow_link',
];

/** Object-type keywords that follow `on` in a default-privilege statement. */
const NOT_A_TABLE = new Set(['tables', 'sequences', 'functions', 'types', 'schemas']);

/** Remove `--` line comments so prose about a privilege is not read as a grant. */
function stripComments(text: string): string {
  return text.replace(/--[^\n]*/g, '');
}

function matches(pattern: RegExp, text: string): string[] {
  const out: string[] = [];
  pattern.lastIndex = 0;
  let hit: RegExpExecArray | null;
  while ((hit = pattern.exec(text)) !== null) {
    const name = hit[1]?.toLowerCase();
    if (name && !NOT_A_TABLE.has(name)) out.push(name);
  }
  return out;
}

/** Tables a file revokes from the runtime role — an immutability declaration. */
export function revokedTables(text: string): string[] {
  return matches(
    /\brevoke\s+(?:grant\s+)?[^;]*?\bon\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+from\s+cairn_app/gi,
    stripComments(text),
  );
}

/** Tables a file grants to the runtime role — a mutability declaration. */
export function grantedTables(text: string): string[] {
  return matches(
    /\bgrant\s+[^;]*?\bon\s+(?:table\s+)?(?:public\.)?([a-z_][a-z0-9_]*)\s+to\s+cairn_app/gi,
    stripComments(text),
  );
}

/** Tables a file creates, with or without a schema qualifier. */
export function createdTables(text: string): string[] {
  const body = stripComments(text);
  return [
    ...matches(/\bcreate\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi, body),
    ...matches(/\bcreate\s+foreign\s+table\s+(?:public\.)?([a-z_][a-z0-9_]*)/gi, body),
  ];
}

/**
 * A table created from here on must declare its runtime permissions, and must
 * not rely on a table grant to cover a sequence.
 */
export function auditMigrationGrantPolicy(text: string): string[] {
  const problems: string[] = [];
  const body = stripComments(text);
  const created = createdTables(text);
  if (created.length === 0) return problems;

  const revoked = new Set(revokedTables(text));
  const granted = new Set(grantedTables(text));
  for (const table of created) {
    if (!revoked.has(table) && !granted.has(table)) {
      problems.push(
        `${table}: created with no cairn_app privilege declaration. State the intent — ` +
          `append-only: "revoke update, delete, truncate on table public.${table} from cairn_app;" ` +
          `or mutable: "grant update, delete on table public.${table} to cairn_app;" ` +
          `(the default after 9186 is SELECT and INSERT only).`,
      );
    }
  }

  // A `serial` column owns a sequence, and a table grant never covers it.
  // Identity columns are exempt: PostgreSQL checks the table, not the sequence.
  const serials = matches(/\b([a-z_][a-z0-9_]*)\s+(?:big|small)?serial\b/gi, body);
  for (const column of serials) {
    problems.push(
      `${column}: uses a serial column. Its implicit sequence is not covered by the table grant, ` +
        `so the runtime role cannot insert. Use "integer generated always as identity", or grant ` +
        `USAGE on the named sequence to cairn_app in the same migration.`,
    );
  }

  if (/\balter\s+default\s+privileges\b[^;]*?\bgrant\b[^;]*?\bto\s+cairn_app/gi.test(body)) {
    problems.push(
      'grants a default privilege to cairn_app. The default for future tables is SELECT and INSERT; ' +
        'widen it per table, never per schema.',
    );
  }
  return problems;
}

/** Resolves a Drizzle export name to its table name, for both module and platform tables. */
function schemaTables(): Map<string, string> {
  const root = schemaRoot as unknown as Record<string, unknown>;
  const entries: [string, unknown][] = [
    ...Object.entries(root),
    ...(root.default && typeof root.default === 'object'
      ? Object.entries(root.default as Record<string, unknown>)
      : []),
  ];
  const byName = new Map<string, string>();
  for (const [name, value] of entries) {
    try {
      byName.set(name, getTableName(value as never));
    } catch {
      // Not a table: a helper, a type, or a re-exported enum.
    }
  }
  return byName;
}

/**
 * Which tables the application itself updates and deletes. Read from the
 * services, because "the permissions their existing services require" is only
 * answerable from the services.
 */
function requiredRuntimeGrants(): { update: Map<string, string[]>; delete: Map<string, string[]> } {
  const tables = schemaTables();
  const known = new Set(tables.values());
  const resolve = (id: string): string | null =>
    tables.get(id) ?? (known.has(id.toLowerCase()) ? id.toLowerCase() : null);
  const out = {
    update: new Map<string, Set<string>>(),
    delete: new Map<string, Set<string>>(),
  };
  const patterns = {
    update: [
      /\.update\(\s*([A-Za-z_$][\w$]*)/g,
      /\bupdate\s+([a-z_][a-z0-9_]*)\s+set\b/gi,
    ],
    delete: [
      /\.delete\(\s*([A-Za-z_$][\w$]*)\s*\)/g,
      /\bdelete\s+from\s+([a-z_][a-z0-9_]*)\b/gi,
    ],
  } as const;
  for (const file of readdirSync(join(process.cwd(), 'src'), { recursive: true })) {
    const path = file.toString();
    if (!path.endsWith('.ts')) continue;
    const text = readFileSync(join(process.cwd(), 'src', path), 'utf8');
    for (const kind of ['update', 'delete'] as const) {
      for (const pattern of patterns[kind]) {
        pattern.lastIndex = 0;
        let hit: RegExpExecArray | null;
        while ((hit = pattern.exec(text)) !== null) {
          const table = resolve(hit[1]!);
          if (!table) continue;
          if (!out[kind].has(table)) out[kind].set(table, new Set());
          out[kind].get(table)!.add(`src/${path}`);
        }
      }
    }
  }
  const toArrays = <T,>(map: Map<T, Set<string>>) =>
    new Map([...map].map(([key, files]) => [key, [...files].sort()] as const));
  return { update: toArrays(out.update), delete: toArrays(out.delete) };
}

interface GrantRow {
  relname: string;
  can_select: boolean;
  can_insert: boolean;
  can_update: boolean;
  can_delete: boolean;
  can_truncate: boolean;
}

/** Effective privileges of the runtime role on every table in `public`. */
async function runtimeTableGrants(): Promise<Map<string, GrantRow>> {
  const rows = await db().execute(sql`
    select c.relname,
           has_table_privilege(current_user, c.oid, 'SELECT')   as can_select,
           has_table_privilege(current_user, c.oid, 'INSERT')   as can_insert,
           has_table_privilege(current_user, c.oid, 'UPDATE')   as can_update,
           has_table_privilege(current_user, c.oid, 'DELETE')   as can_delete,
           has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r'
  `);
  return new Map((rows as unknown as GrantRow[]).map((row) => [row.relname, row]));
}

function describeGrants(table: string, row: GrantRow | undefined): string {
  if (!row) return `${table}: not present as a table in schema public`;
  const held = (['can_select', 'can_insert', 'can_update', 'can_delete', 'can_truncate'] as const)
    .filter((key) => row[key])
    .map((key) => key.replace('can_', '').toUpperCase());
  return `${table}: cairn_app holds ${held.length > 0 ? held.join(', ') : 'nothing'}`;
}

describe('future-table grant policy', () => {
  afterAll(closeDb);

  /**
   * The gate reads live ACLs, so it is only worth anything if it is reading
   * the database the deployment will use. This runs first: a missing variable,
   * a runtime URL pointing at the owner role, or two URLs naming different
   * databases fails here, loudly, instead of producing a green run against the
   * wrong target. `tests/global-setup.ts` already refuses a non-development
   * `CAIRN_ENV`; that refusal is restated here so the focused command cannot be
   * aimed at production by someone who sets the variable back.
   */
  it('is pointed at one development database with the intended roles', async () => {
    const appUrl = process.env.DATABASE_URL;
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    expect(
      appUrl,
      'DATABASE_URL is unset: the runtime client would fall back to a hard-coded development URL and the gate would judge the wrong database',
    ).toBeTruthy();
    expect(
      ownerUrl,
      'MIGRATION_DATABASE_URL is unset: future-object probes must run as the owner role, not through the runtime fallback',
    ).toBeTruthy();

    const databaseOf = (value: string) => new URL(value).pathname.replace(/^\//, '');
    const runtimeDatabase = databaseOf(appUrl!);
    expect(
      databaseOf(ownerUrl!),
      'the migration URL and the runtime URL must name the same database, or the probe and the ACL it checks are unrelated objects',
    ).toBe(runtimeDatabase);
    expect(
      process.env.CAIRN_ENV ?? 'development',
      'this gate writes probe tables, so it runs only against the development database',
    ).toBe('development');

    const [runtime] = await db().execute(sql`
      select current_user as role, current_database() as database,
             (rolsuper or rolbypassrls) as elevated
        from pg_roles where rolname = current_user
    `);
    const row = runtime as unknown as { role: string; database: string; elevated: boolean };
    expect(row.role, 'the runtime connection must be the application role the ERP actually runs as').toBe(RUNTIME_ROLE);
    expect(row.database).toBe(runtimeDatabase);
    expect(row.elevated, 'an elevated runtime role would make every privilege check here meaningless').toBe(false);

    const owner = postgres(ownerUrl!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const [ownerRow] = await owner<{ role: string; database: string }[]>`
        select current_user as role, current_database() as database
      `;
      expect(ownerRow?.role, 'migrations run as the owner role, and so must this gate').toBe(OWNER_ROLE);
      expect(ownerRow?.database).toBe(runtimeDatabase);
    } finally {
      await owner.end();
    }
  });

  it('the effective default for a future table is SELECT and INSERT only', async () => {
    const rows = await db().execute(sql`
      select pg_get_userbyid(d.defaclrole) as grantor,
             n.nspname                     as schema_name,
             d.defaclobjtype               as object_type,
             d.defaclacl::text             as acl
        from pg_default_acl d
        left join pg_namespace n on n.oid = d.defaclnamespace
       order by 2, 3
    `);
    const defaults = rows as unknown as Array<Record<string, string | null>>;

    // One default ACL row, for tables, in public — and nothing defaulted for
    // sequences, functions or types, which is what keeps this narrow.
    expect(defaults, `unexpected default ACL rows: ${JSON.stringify(defaults)}`).toHaveLength(1);
    const [only] = defaults;
    expect(only?.grantor).toBe(OWNER_ROLE);
    expect(only?.schema_name).toBe('public');
    expect(only?.object_type).toBe('r');
    expect(
      only?.acl,
      'the runtime default must be SELECT and INSERT; any w, d, or x here is the bug this policy closes',
    ).toBe(`{${RUNTIME_ROLE}=ar/${OWNER_ROLE}}`);

    // No PUBLIC default either, and no default that widens the runtime role.
    const broad = defaults.filter((row) => /[udxt]/.test(String(row.acl?.split('=')[1] ?? '')));
    expect(broad, `default ACLs grant mutation: ${JSON.stringify(broad)}`).toEqual([]);
  });

  it('every table a migration declares immutable is denied mutation live', async () => {
    const declared = new Map<string, string>();
    for (const file of readdirSync(MIGRATION_DIR).filter((name) => name.endsWith('.sql')).sort()) {
      for (const table of revokedTables(readFileSync(join(MIGRATION_DIR, file), 'utf8'))) {
        declared.set(table, file);
      }
    }
    for (const table of PROTECTED_FLOOR) {
      expect(declared.has(table), `${table} lost its immutability declaration in drizzle/`).toBe(true);
    }

    const grants = await runtimeTableGrants();
    const problems: string[] = [];
    for (const [table, file] of declared) {
      const row = grants.get(table);
      if (!row) {
        problems.push(`${table}: revoked by ${file} but no longer a table in public`);
        continue;
      }
      // A revoke in a migration is a promise the runtime role cannot mutate the
      // rows. This holds for every such table, whether it is append-only
      // (9185-9187) or read-only privacy data (9016, 9017).
      if (row.can_update || row.can_delete || row.can_truncate) {
        problems.push(`${describeGrants(table, row)} — ${file} revoked mutation and something granted it back`);
      }
      // Only the append-only set must also keep its write path open, because
      // those services insert. A SELECT-only table is correct with INSERT absent.
      if (PROTECTED_FLOOR.includes(table) && (!row.can_select || !row.can_insert)) {
        problems.push(`${describeGrants(table, row)} — the writers still need SELECT and INSERT (${file})`);
      }
    }
    expect(
      problems,
      `tables declared immutable must deny UPDATE, DELETE and TRUNCATE to ${RUNTIME_ROLE}:\n${problems.join('\n')}`,
    ).toEqual([]);
  });

  it('every table the application updates or deletes still holds that grant', async () => {
    const required = requiredRuntimeGrants();
    const grants = await runtimeTableGrants();
    const problems: string[] = [];
    for (const [kind, map] of [['UPDATE', required.update], ['DELETE', required.delete]] as const) {
      for (const [table, files] of map) {
        const row = grants.get(table);
        const held = row ? row[kind === 'UPDATE' ? 'can_update' : 'can_delete'] : false;
        if (!held) {
          problems.push(
            `${describeGrants(table, row)} but the service code needs ${kind}\n  via: ${files.slice(0, 3).join('\n       ')}` +
              (files.length > 3 ? `\n       and ${files.length - 3} more` : ''),
          );
        }
      }
    }
    // A protected append-only table must never appear in this set: if one does,
    // a writer has grown that edits history, and the fix is the writer, not the grant.
    const protectedWrites = [...required.update.keys(), ...required.delete.keys()].filter((table) =>
      PROTECTED_FLOOR.includes(table),
    );
    expect(
      problems,
      `a table whose rows the application edits is missing its runtime grant:\n${problems.join('\n')}`,
    ).toEqual([]);
    expect(
      protectedWrites,
      `append-only tables are written with ${protectedWrites.join(', ')} — restore insert-only semantics`,
    ).toEqual([]);
  });

  it('a new migration must declare the runtime grants its tables need', async () => {
    // Grandfather only what predates the policy: the ledger's own applied_at for
    // 9186 is the boundary, so any newly written migration is checked whatever
    // number it carries — including a drizzle-kit `0042` that sorts before it.
    const ledger = await db().execute(sql`
      select filename, applied_at::text as applied_at
        from public.cairn_migration
    `);
    const rows = ledger as unknown as Array<{ filename: string; applied_at: string }>;
    const policy = rows.find((row) => row.filename.startsWith('9186'));
    expect(policy, 'drizzle/9186 is not applied: the grant policy is not in force on this database').toBeDefined();
    const policyAt = Date.parse(policy!.applied_at);
    const appliedAt = new Map(rows.map((row) => [row.filename, Date.parse(row.applied_at)]));

    const files = readdirSync(MIGRATION_DIR).filter((name) => name.endsWith('.sql')).sort();
    const policed = files.filter((name) => {
      const when = appliedAt.get(name);
      return when === undefined || when >= policyAt;
    });
    const problems: string[] = [];
    for (const file of policed) {
      for (const problem of auditMigrationGrantPolicy(readFileSync(join(MIGRATION_DIR, file), 'utf8'))) {
        problems.push(`${file}: ${problem}`);
      }
    }
    expect(problems, `migrations after the policy must be explicit:\n${problems.join('\n')}`).toEqual([]);
  });

  it('the declaration check rejects an undeclared mutable table and accepts an explicit one', () => {
    const undeclared = `create table public.widget_ledger (
  client varchar(4) not null,
  widget_id varchar(10) not null
);`;
    expect(auditMigrationGrantPolicy(undeclared)).toEqual([
      expect.stringContaining('widget_ledger: created with no cairn_app privilege declaration'),
    ]);

    const declaredImmutable = `${undeclared}
revoke update, delete, truncate on table public.widget_ledger from cairn_app;`;
    expect(auditMigrationGrantPolicy(declaredImmutable)).toEqual([]);

    const declaredMutable = `${undeclared}
grant update, delete on table public.widget_ledger to cairn_app;`;
    expect(auditMigrationGrantPolicy(declaredMutable)).toEqual([]);

    const serialTable = `create table public.widget_counter (
  widget_id serial not null,
  note text
);
grant update, delete on table public.widget_counter to cairn_app;`;
    expect(auditMigrationGrantPolicy(serialTable).join('\n')).toMatch(/serial column/);

    const broadened = `alter default privileges in schema public
  grant update, delete on tables to cairn_app;`;
    expect(auditMigrationGrantPolicy(`${undeclared}\n${broadened}`).join('\n')).toMatch(/never per schema/);

    // Prose about a privilege is not a privilege: comments are stripped first.
    const commentOnly = `${undeclared}
-- A later migration may grant update, delete on table public.widget_ledger to cairn_app.`;
    expect(auditMigrationGrantPolicy(commentOnly)).toEqual([
      expect.stringContaining('no cairn_app privilege declaration'),
    ]);
  });

  it('a new sequence needs its own grant, while an identity column does not', async () => {
    const ownerUrl = process.env.MIGRATION_DATABASE_URL;
    expect(ownerUrl, 'MIGRATION_DATABASE_URL is required to exercise future-object behavior').toBeTruthy();
    const owner = postgres(ownerUrl!, { max: 1, prepare: false, onnotice: () => {} });
    const app = postgres(process.env.DATABASE_URL!, { max: 1, prepare: false, onnotice: () => {} });
    const stamp = Date.now();
    const identity = `grant_policy_identity_${stamp}`;
    const serial = `grant_policy_serial_${stamp}`;
    try {
      const [role] = await owner<{ current_user: string }[]>`select current_user`;
      expect(role?.current_user, 'migrations must run as the owner role, not the runtime role').toBe(OWNER_ROLE);
      const [appRole] = await app<{ current_user: string }[]>`select current_user`;
      expect(
        appRole?.current_user,
        'the probe must be written by the runtime role the ERP uses, not by a fallback connection',
      ).toBe(RUNTIME_ROLE);

      // Clear anything an aborted run left behind, so this gate cannot be
      // pinned red by a stale probe it did not create in this run.
      const stale = await owner<{ name: string }[]>`
        select c.relname as name from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'grant_policy_%'
      `;
      for (const row of stale) await owner.unsafe(`drop table if exists public.${row.name}`);

      await owner.unsafe(
        `create table public.${identity} (id integer generated always as identity primary key, note text)`,
      );
      await owner.unsafe(`create table public.${serial} (id serial primary key, note text)`);

      // The table grant is what gates an identity column: no sequence grant is
      // needed, so the restricted default still leaves the writer working.
      await app.unsafe(`insert into public.${identity} (note) values ('runtime role')`);
      const denied = await app
        .unsafe(`insert into public.${serial} (note) values ('runtime role')`)
        .then(() => null)
        .catch((error: Error) => error.message);
      expect(denied, 'a serial column must not inherit access from its table grant').toMatch(
        /permission denied for sequence/,
      );

      // Declaring the sequence privilege is all it takes — the convention works.
      await owner.unsafe(`grant usage on sequence public.${serial}_id_seq to ${RUNTIME_ROLE}`);
      await app.unsafe(`insert into public.${serial} (note) values ('after the grant')`);

      const mutations = await owner<{ identity_update: boolean; serial_update: boolean }[]>`
        select has_table_privilege(${RUNTIME_ROLE}, ${`public.${identity}`}, 'UPDATE') as identity_update,
               has_table_privilege(${RUNTIME_ROLE}, ${`public.${serial}`}, 'UPDATE') as serial_update
      `;
      expect(mutations[0]?.identity_update).toBe(false);
      expect(mutations[0]?.serial_update).toBe(false);
    } finally {
      // Isolated and always cleaned up — including when an assertion above
      // failed and when the insert probe left the connection mid-transaction.
      await app.end({ timeout: 5 });
      await owner.unsafe(`drop table if exists public.${identity}`);
      await owner.unsafe(`drop table if exists public.${serial}`);
      const left = await owner<{ count: string }[]>`
        select count(*)::text as count from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and (c.relname like 'grant_policy_%' or c.relname like 'default_privilege_probe_%')
      `;
      await owner.end();
      expect(left[0]?.count, 'probe objects must not survive the run').toBe('0');
    }
  });

  it('no column-default sequence in public is left ungranted to the runtime role', async () => {
    const rows = await db().execute(sql`
      select s.relname as sequence, t.relname as table_name, a.attname as column_name,
             has_sequence_privilege(current_user, s.oid, 'USAGE') as can_use
        from pg_class s
        join pg_namespace n on n.oid = s.relnamespace
        join pg_depend d on d.objid = s.oid and d.deptype = 'a'
        join pg_class t on t.oid = d.refobjid
        join pg_attribute a on a.attrelid = t.oid and a.attnum = d.refobjsubid
       where s.relkind = 'S' and n.nspname = 'public' and t.relkind = 'r'
    `);
    const unusable = (rows as unknown as Array<Record<string, string | boolean>>)
      .filter((row) => row.can_use !== true)
      .map((row) => `public.${row.table_name}.${row.column_name} uses sequence ${row.sequence}, which ${RUNTIME_ROLE} cannot use`);
    expect(
      unusable,
      `a serial default is not covered by the table grant; grant USAGE on the sequence or switch the column to identity:\n${unusable.join('\n')}`,
    ).toEqual([]);
  });

  it('the migration runner still works as the owner under the restricted default', async () => {
    const result = await runMigrations();
    // Every checked-in migration is applied, so a re-run must be a clean skip:
    // the restricted default does not stop the owner from reading or writing
    // the ledger, and it does not invalidate an applied file.
    expect(result.applied, `unexpected pending migrations: ${result.applied.join(', ')}`).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
    expect(OWNER_ROLE).toBe('cairn');
  });
});
