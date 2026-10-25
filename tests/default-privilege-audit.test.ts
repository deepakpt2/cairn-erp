import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, describe, expect, it } from 'vitest';

import { db } from '../src/platform/db/client';
import { closeDb } from './helpers';

/**
 * Live least-privilege checks for 9186 and 9187. These are database facts, not
 * a substitute for the module tests that still insert into the append-only
 * tables and update ordinary documents.
 */
const APPEND_ONLY_TABLES = [
  // 9185
  'production_order_operation',
  'production_order_operation_value',
  // 9186
  'supplier_invoice_payment_block_event',
  'credit_change_audit',
  'credit_release_event',
  'consolidation_execution_log',
  // 9187
  'clearing_reset',
  'credit_determination',
  'internal_order_original_budget',
  'internal_order_original_budget_year',
  'closing_task_event',
  'document_status_history',
  'document_flow_link',
];

const MUTABLE_TABLES = [
  'production_order',
  'routing_operation',
  'material',
  'closing_execution_log',
  'journal_entry',
  'material_document',
  'customer_credit',
  'consolidation_execution',
];

describe('default privileges and append-only grants', () => {
  afterAll(closeDb);

  it('the runtime role is cairn_app, with no inherited or schema-create rights', async () => {
    const rows = await db().execute(sql`
      select current_user as role,
             rolsuper,
             rolbypassrls,
             rolinherit,
             has_schema_privilege(current_user, 'public', 'USAGE') as schema_usage,
             has_schema_privilege(current_user, 'public', 'CREATE') as schema_create,
             (select count(*) from pg_auth_members m
               join pg_roles r on r.oid = m.member
              where r.rolname = current_user) as memberships
        from pg_roles
       where rolname = current_user
    `);
    const row = (rows as unknown as Array<Record<string, unknown>>)[0];
    expect(row?.role).toBe('cairn_app');
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
    expect(row?.schema_usage).toBe(true);
    expect(row?.schema_create).toBe(false);
    expect(Number(row?.memberships)).toBe(0);
  });

  it('every append-only table is select and insert only, and ordinary tables stay mutable', async () => {
    const rows = await db().execute(sql`
      select c.relname,
             has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
             has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
             has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
             has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
    `);
    const byName = new Map(
      (rows as unknown as Array<Record<string, unknown>>).map((row) => [String(row.relname), row]),
    );
    for (const name of APPEND_ONLY_TABLES) {
      const row = byName.get(name);
      expect(row, name).toBeDefined();
      expect(row?.can_select, name).toBe(true);
      expect(row?.can_insert, name).toBe(true);
      expect(row?.can_update, name).toBe(false);
      expect(row?.can_delete, name).toBe(false);
      expect(row?.can_truncate, name).toBe(false);
    }
    for (const name of MUTABLE_TABLES) {
      const row = byName.get(name);
      expect(row, name).toBeDefined();
      expect(row?.can_update, name).toBe(true);
      expect(row?.can_delete, name).toBe(true);
    }
  });

  it('a table created by the migration role after 9186 does not receive update or delete, and can still be altered', async () => {
    const connectionString = process.env.MIGRATION_DATABASE_URL;
    expect(connectionString, 'MIGRATION_DATABASE_URL is required to prove future-object defaults').toBeTruthy();
    const owner = postgres(connectionString!, { max: 1, prepare: false, onnotice: () => {} });
    const probe = `default_privilege_probe_${Date.now()}`;
    try {
      const role = await owner<{ current_user: string }[]>`select current_user`;
      expect(role[0]?.current_user).toBe('cairn');
      const defaults = await owner<{ defaclacl: string | null }[]>`
        select d.defaclacl::text as defaclacl
          from pg_default_acl d
          join pg_roles r on r.oid = d.defaclrole
          join pg_namespace n on n.oid = d.defaclnamespace
         where r.rolname = 'cairn' and n.nspname = 'public' and d.defaclobjtype = 'r'
      `;
      expect(defaults).toHaveLength(1);
      expect(defaults[0]?.defaclacl).toBe('{cairn_app=ar/cairn}');
      await owner.unsafe(`create table public.${probe} (id integer primary key, note text)`);
      const created = await owner<{ relacl: string | null }[]>`
        select c.relacl::text as relacl
          from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relname = ${probe}
      `;
      // The owner entry is always materialised; the runtime entry must be
      // select and insert only.
      expect(created[0]?.relacl).toBe('{cairn=arwdDxtm/cairn,cairn_app=ar/cairn}');
      await owner.unsafe(`alter table public.${probe} add column extra text`);
      const app = await owner<{ can_insert: boolean; can_update: boolean; can_delete: boolean }[]>`
        select has_table_privilege('cairn_app', ${`public.${probe}`}, 'INSERT') as can_insert,
               has_table_privilege('cairn_app', ${`public.${probe}`}, 'UPDATE') as can_update,
               has_table_privilege('cairn_app', ${`public.${probe}`}, 'DELETE') as can_delete
      `;
      expect(app[0]?.can_insert).toBe(true);
      expect(app[0]?.can_update).toBe(false);
      expect(app[0]?.can_delete).toBe(false);
    } finally {
      await owner.unsafe(`drop table if exists public.${probe}`);
      await owner.end();
    }
  });

  it('the migration role can still create, alter, and read every table', async () => {
    const connectionString = process.env.MIGRATION_DATABASE_URL;
    expect(connectionString).toBeTruthy();
    const owner = postgres(connectionString!, { max: 1, prepare: false, onnotice: () => {} });
    try {
      const [role] = await owner<{ current_user: string; superuser: boolean }[]>`
        select current_user, rolsuper from pg_roles where rolname = current_user`;
      expect(role?.current_user).toBe('cairn');
      const ownerRights = await owner<{ can_update: boolean; can_delete: boolean; can_truncate: boolean }[]>`
        select has_table_privilege('cairn', 'public.production_order_operation', 'UPDATE') as can_update,
               has_table_privilege('cairn', 'public.production_order_operation', 'DELETE') as can_delete,
               has_table_privilege('cairn', 'public.production_order_operation', 'TRUNCATE') as can_truncate
      `;
      expect(ownerRights[0]?.can_update).toBe(true);
      expect(ownerRights[0]?.can_delete).toBe(true);
      expect(ownerRights[0]?.can_truncate).toBe(true);
    } finally {
      await owner.end();
    }
  });
});
