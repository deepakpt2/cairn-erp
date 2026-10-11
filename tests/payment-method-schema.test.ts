import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { createTenant, destroyTenant, withTenant, closeDb, db, type TestTenant } from './helpers';
import { paymentMethod } from '@/platform/schema';

let alpha: TestTenant;
let beta: TestTenant;

beforeAll(async () => {
  alpha = await createTenant('payment-method-schema-alpha', { withConfiguration: false });
  beta = await createTenant('payment-method-schema-beta', { withConfiguration: false });
});

afterAll(async () => {
  if (beta) await destroyTenant(beta.client);
  if (alpha) await destroyTenant(alpha.client);
  await closeDb();
});

function insertMethod(client: string, country: string, methodCode: string, direction: string, description = 'Test method') {
  return withTenant(client, (tx) => tx.execute(sql`
    insert into payment_method (client, country, method_code, description, allowed_direction)
    values (${client}, ${country}, ${methodCode}, ${description}, ${direction})
  `));
}

describe('Payment Methods schema and tenant RLS', () => {
  it('allows a country-scoped code to be reused in another country', async () => {
    await insertMethod(alpha.client, 'KW', 'T', 'OUTGOING', 'Kuwait transfer');
    await insertMethod(alpha.client, 'US', 'T', 'BOTH', 'US method');

    const rows = await withTenant(alpha.client, (tx) => tx.select().from(paymentMethod)
      .where(eq(paymentMethod.methodCode, 'T')).orderBy(paymentMethod.country));
    expect(rows.map((row) => row.country)).toEqual(['KW', 'US']);
    expect(rows[0].allowedDirection).toBe('OUTGOING');
    expect(rows[1].allowedDirection).toBe('BOTH');
    expect(rows[0].isActive).toBe(true);
    expect(rows[0].version).toBe(1);

    await expect(insertMethod(alpha.client, 'KW', 'T', 'INCOMING', 'Duplicate key')).rejects.toThrow();
  });

  it('enforces the approved code, country, description, direction and version constraints', async () => {
    for (const invalid of [
      { country: 'KW', code: 't', description: 'lowercase', direction: 'OUTGOING' },
      { country: 'KW', code: 'ABC', description: 'too long', direction: 'OUTGOING' },
      { country: 'ZZ', code: 'Z', description: 'unknown country', direction: 'OUTGOING' },
      { country: 'KW', code: 'D', description: '   ', direction: 'OUTGOING' },
      { country: 'KW', code: 'I', description: 'invalid direction', direction: 'SIDEWAYS' },
    ]) {
      await expect(insertMethod(alpha.client, invalid.country, invalid.code, invalid.direction, invalid.description)).rejects.toThrow();
    }

    await expect(withTenant(alpha.client, (tx) => tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction, version)
      values (${alpha.client}, 'KW', 'V', 'Invalid version', 'BOTH', 0)
    `))).rejects.toThrow();
  });

  it('default-denies unscoped and cross-tenant reads/writes, with forced RLS', async () => {
    await insertMethod(alpha.client, 'KW', 'R', 'BOTH', 'RLS fixture');

    const alphaRows = await withTenant(alpha.client, (tx) => tx.select().from(paymentMethod)
      .where(eq(paymentMethod.methodCode, 'R')));
    const betaRows = await withTenant(beta.client, (tx) => tx.select().from(paymentMethod)
      .where(eq(paymentMethod.methodCode, 'R')));
    const unscopedRows = await db().select().from(paymentMethod)
      .where(eq(paymentMethod.methodCode, 'R'));
    expect(alphaRows).toHaveLength(1);
    expect(betaRows).toHaveLength(0);
    expect(unscopedRows).toHaveLength(0);

    await expect(withTenant(alpha.client, (tx) => tx.execute(sql`
      insert into payment_method (client, country, method_code, description, allowed_direction)
      values (${beta.client}, 'KW', 'F', 'Forged tenant row', 'BOTH')
    `))).rejects.toThrow(/row-level security|policy/i);

    const flags = await db().execute(sql`
      select relrowsecurity, relforcerowsecurity
        from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relname = 'payment_method'
    `) as unknown as Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>;
    expect(flags).toHaveLength(1);
    expect(flags[0].relrowsecurity).toBe(true);
    expect(flags[0].relforcerowsecurity).toBe(true);
  });
});
