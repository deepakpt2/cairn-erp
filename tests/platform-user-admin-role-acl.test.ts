import { afterAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import { db, closeDb } from '@/platform/db/client';

const AUTH_TABLES = ['app_user', 'user_session', 'password_reset_token'] as const;

afterAll(closeDb);

describe('central user-administration database-role boundary', () => {
  it('runs as the restricted application role with no memberships or schema creation rights', async () => {
    const result = await db().execute(sql`
      select current_user as role, current_database() as database,
             r.rolsuper, r.rolbypassrls, r.rolinherit,
             has_database_privilege(current_user, current_database(), 'CONNECT') as can_connect,
             has_schema_privilege(current_user, 'public', 'USAGE') as can_use_schema,
             has_schema_privilege(current_user, 'public', 'CREATE') as can_create_schema,
             (select count(*) from pg_auth_members m
               join pg_roles member on member.oid = m.member
              where member.rolname = current_user) as memberships
        from pg_roles r where r.rolname = current_user
    `);
    const row = (result as unknown as Array<Record<string, unknown>>)[0];
    expect(row?.role).toBe('cairn_app');
    expect(row?.rolsuper).toBe(false);
    expect(row?.rolbypassrls).toBe(false);
    expect(row?.rolinherit).toBe(false);
    expect(row?.can_connect).toBe(true);
    expect(row?.can_use_schema).toBe(true);
    expect(row?.can_create_schema).toBe(false);
    expect(Number(row?.memberships)).toBe(0);
  });

  it('holds exactly SELECT, INSERT, UPDATE on the three account lifecycle tables', async () => {
    const result = await db().execute(sql`
      select c.relname,
             has_table_privilege(current_user, c.oid, 'SELECT') as can_select,
             has_table_privilege(current_user, c.oid, 'INSERT') as can_insert,
             has_table_privilege(current_user, c.oid, 'UPDATE') as can_update,
             has_table_privilege(current_user, c.oid, 'DELETE') as can_delete,
             has_table_privilege(current_user, c.oid, 'TRUNCATE') as can_truncate,
             has_table_privilege(current_user, c.oid, 'REFERENCES') as can_references,
             has_table_privilege(current_user, c.oid, 'TRIGGER') as can_trigger
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relname in ('app_user', 'user_session', 'password_reset_token')
         and c.relkind in ('r', 'p')
    `);
    const rows = result as unknown as Array<Record<string, unknown>>;
    expect(rows.map((row) => row.relname).sort()).toEqual([...AUTH_TABLES].sort());
    for (const row of rows) {
      expect(row.can_select, String(row.relname)).toBe(true);
      expect(row.can_insert, String(row.relname)).toBe(true);
      expect(row.can_update, String(row.relname)).toBe(true);
      expect(row.can_delete, String(row.relname)).toBe(false);
      expect(row.can_truncate, String(row.relname)).toBe(false);
      expect(row.can_references, String(row.relname)).toBe(false);
      expect(row.can_trigger, String(row.relname)).toBe(false);
    }
  });

  it('the runtime role is actually refused DELETE and TRUNCATE on account lifecycle tables', async () => {
    for (const table of AUTH_TABLES) {
      await expect(
        db().execute(sql.raw(`delete from public.${table} where false`)),
        `${table} DELETE must be denied even when the predicate would match no rows`,
      ).rejects.toThrow(/permission denied/i);
      await expect(
        db().execute(sql.raw(`truncate table public.${table}`)),
        `${table} TRUNCATE must be denied`,
      ).rejects.toThrow(/permission denied/i);
    }
  });
});
