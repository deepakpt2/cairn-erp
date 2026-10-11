import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  closeDb,
  createTenant,
  destroyTenant,
  sql,
  type TestTenant,
  withTenant,
} from './helpers';

let tenant: TestTenant | undefined;

function getTenant(): TestTenant {
  if (!tenant) throw new Error('The append-only audit-log test tenant was not initialized.');
  return tenant;
}

beforeAll(async () => {
  tenant = await createTenant('audit-access-log-append-only', { withConfiguration: false });
});

afterAll(async () => {
  try {
    if (tenant) await destroyTenant(tenant.client);
  } finally {
    await closeDb();
  }
});

describe('audit_access_log runtime append-only privileges', () => {
  it('keeps reads and inserts while revoking update, delete, and truncate', async () => {
    const client = getTenant().client;
    const result = (await withTenant(client, (tx) => tx.execute(sql`
      select current_user as role,
             has_table_privilege(current_user, 'public.audit_access_log', 'SELECT') as can_select,
             has_table_privilege(current_user, 'public.audit_access_log', 'INSERT') as can_insert,
             has_table_privilege(current_user, 'public.audit_access_log', 'UPDATE') as can_update,
             has_table_privilege(current_user, 'public.audit_access_log', 'DELETE') as can_delete,
             has_table_privilege(current_user, 'public.audit_access_log', 'TRUNCATE') as can_truncate
    `))) as unknown as Array<{
      role: string;
      can_select: boolean;
      can_insert: boolean;
      can_update: boolean;
      can_delete: boolean;
      can_truncate: boolean;
    }>;

    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('cairn_app');
    expect(result[0].can_select).toBe(true);
    expect(result[0].can_insert).toBe(true);
    expect(result[0].can_update).toBe(false);
    expect(result[0].can_delete).toBe(false);
    expect(result[0].can_truncate).toBe(false);
  });

  it('allows a runtime append but rejects direct row mutation', async () => {
    const client = getTenant().client;
    const id = randomUUID();
    await withTenant(client, (tx) => tx.execute(sql`
      insert into audit_access_log
        (id, client, event_type, transaction_code, object_type, object_key, detail)
      values
        (${id}, ${client}, 'READ', 'TEST.APPEND_ONLY', 'test_object', 'opaque-fixture', 'before')
    `));

    await expect(withTenant(client, (tx) => tx.execute(sql`
      update audit_access_log set detail = 'tampered' where id = ${id}
    `))).rejects.toThrow(/permission denied|insufficient privilege/i);

    await expect(withTenant(client, (tx) => tx.execute(sql`
      delete from audit_access_log where id = ${id}
    `))).rejects.toThrow(/permission denied|insufficient privilege/i);

    const rows = (await withTenant(client, (tx) => tx.execute(sql`
      select detail from audit_access_log where id = ${id}
    `))) as unknown as Array<{ detail: string }>;
    expect(rows).toEqual([{ detail: 'before' }]);
  });
});
