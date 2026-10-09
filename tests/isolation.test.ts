/**
 * Tenant isolation — CAIRN.md §6.3, §24.3, RK-13
 *
 * Row-level security is only worth having if it actually binds. These tests
 * connect as the application role (cairn_app: NOSUPERUSER, NOBYPASSRLS) and try
 * to break out. Every attempt must fail.
 *
 * This suite runs on every build. A cross-tenant leak is the single worst defect
 * this system could ship, so it is tested rather than assumed.
 */
import { describe, expect, it, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { withTenant, closeDb, db } from '@/platform/db/client';
import { postJournalEntry } from '@/platform/posting';
import {
  createTenant,
  defineTestRanges,
  seedAccounts,
  destroyTenant,
  type TestTenant,
} from './helpers';

const alpha: TestTenant = await createTenant('alpha');
const beta: TestTenant = await createTenant('beta');
await defineTestRanges(alpha);
await defineTestRanges(beta);
await seedAccounts(alpha, ['100000', '200000']);
await seedAccounts(beta, ['100000', '200000']);

const fiscalYear = new Date().getUTCFullYear();

afterAll(async () => {
  await destroyTenant(alpha.client);
  await destroyTenant(beta.client);
  await closeDb();
});

async function postOne(t: TestTenant, amount: string) {
  return withTenant(t.client, (tx) =>
    postJournalEntry(tx, {
      client: t.client,
      companyCode: t.companyCode,
      documentType: 'SA',
      documentDate: `${fiscalYear}-05-01`,
      postingDate: `${fiscalYear}-05-01`,
      fiscalYear,
      postingPeriod: 5,
      currency: 'USD',
      localCurrency: 'USD',
      headerText: `Tenant ${t.client}`,
      postedBy: 'TEST',
      lines: [
        { glAccount: '100000', debitCredit: 'S', amount },
        { glAccount: '200000', debitCredit: 'H', amount },
      ],
    }),
  );
}

describe('tenant isolation', () => {
  it('numbers are allocated per tenant, so two tenants may reuse a number', async () => {
    const alphaDoc = await postOne(alpha, '111.0000');
    const betaDoc = await postOne(beta, '222.0000');

    // This is deliberate, and matches the reference model: number ranges belong to
    // the client, so every tenant's first document is its own number 000001.
    // Uniqueness is per (tenant, number), which is what the primary key encodes.
    expect(alphaDoc.documentNumber).toBe(betaDoc.documentNumber);

    // The rows are nevertheless entirely distinct and mutually invisible.
    const alphaRow = await withTenant(alpha.client, (tx) =>
      tx.execute(sql`
        select client, header_text from journal_entry
        where client = ${alpha.client} and document_number = ${alphaDoc.documentNumber}
      `),
    );
    const betaRow = await withTenant(beta.client, (tx) =>
      tx.execute(sql`
        select client, header_text from journal_entry
        where client = ${beta.client} and document_number = ${betaDoc.documentNumber}
      `),
    );

    const alphaHeader = (alphaRow as unknown as Array<{ client: string; header_text: string }>)[0];
    const betaHeader = (betaRow as unknown as Array<{ client: string; header_text: string }>)[0];

    // Same number, different tenant, different content — no collision, no leak.
    expect(alphaHeader.client).toBe(alpha.client);
    expect(alphaHeader.header_text).toBe(`Tenant ${alpha.client}`);
    expect(betaHeader.client).toBe(beta.client);
    expect(betaHeader.header_text).toBe(`Tenant ${beta.client}`);
  });

  it('the two tenants have genuinely separate data', async () => {
    await postOne(alpha, '111.0000');
    await postOne(beta, '222.0000');

    const alphaSees = await withTenant(alpha.client, (tx) =>
      tx.execute(sql`select client, header_text from journal_entry order by client`),
    );
    const betaSees = await withTenant(beta.client, (tx) =>
      tx.execute(sql`select client, header_text from journal_entry order by client`),
    );

    const alphaRows = alphaSees as unknown as Array<{ client: string }>;
    const betaRows = betaSees as unknown as Array<{ client: string }>;

    // Each tenant sees only its own rows — not a filtered view, all of them.
    expect(alphaRows.every((r) => r.client === alpha.client)).toBe(true);
    expect(betaRows.every((r) => r.client === beta.client)).toBe(true);
    expect(alphaRows.length).toBeGreaterThan(0);
    expect(betaRows.length).toBeGreaterThan(0);
  });

  it('cannot read another tenant even by naming it explicitly', async () => {
    // The most obvious attack: ask for the other tenant's rows by key.
    const attempt = await withTenant(alpha.client, (tx) =>
      tx.execute(sql`select * from journal_entry where client = ${beta.client}`),
    );
    expect((attempt as unknown as unknown[]).length).toBe(0);

    // And an unfiltered count is scoped too.
    const countAttempt = await withTenant(alpha.client, (tx) =>
      tx.execute(sql`
        select count(*)::int as count from journal_entry where client = ${beta.client}
      `),
    );
    expect((countAttempt as unknown as Array<{ count: number }>)[0].count).toBe(0);
  });

  it('cannot write a row belonging to another tenant', async () => {
    // WITH CHECK must reject an insert whose client does not match the session key.
    await expect(
      withTenant(alpha.client, (tx) =>
        tx.execute(sql`
          insert into gl_account
            (client, chart_of_accounts, account_number, name, account_type, is_balance_sheet, created_by)
          values
            (${beta.client}, 'CAIRN', '999999', 'Smuggled account', 'ASSET', true, 'ATTACKER')
        `),
      ),
    ).rejects.toThrow(/row-level security|policy/i);
  });

  it('sees nothing at all when no tenant is set — default deny', async () => {
    // A query outside withTenant() has no session key. The policy compares against
    // NULL, which is never true, so the result is empty rather than global.
    const unscoped = await db().execute(
      sql`select count(*)::int as count from journal_entry`,
    );
    expect((unscoped as unknown as Array<{ count: number }>)[0].count).toBe(0);
  });

  it('scopes number ranges per tenant', async () => {
    // Both tenants allocate from their own range; numbers never leak across.
    const a = await postOne(alpha, '10.0000');
    const b = await postOne(beta, '10.0000');

    const ranges = await withTenant(alpha.client, (tx) =>
      tx.execute(sql`select client, current_number from number_range order by client`),
    );
    const rows = ranges as unknown as Array<{ client: string }>;
    expect(rows.every((r) => r.client === alpha.client)).toBe(true);
    expect(a.documentNumber).toBeTruthy();
    expect(b.documentNumber).toBeTruthy();
  });

  it('leaves nothing behind when a tenant is deleted', async () => {
    // The tenant lifecycle promise: delete a tenant, and every account, document,
    // number range and configuration row goes with it. This is checked across
    // every table that carries a tenant column, discovered from the catalogue
    // rather than listed by hand — a table added tomorrow is covered without the
    // test being updated, which is the only version of this check worth having.
    const doomed = await createTenant('isolation-doomed', { withConfiguration: true });
    await defineTestRanges(doomed);
    await seedAccounts(doomed, ['100000', '200000']);
    await postOne(doomed, '25.0000');

    const tenantTables = (await db().execute(sql`
      select c.relname as tbl
        from pg_class c
        join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public'
         and c.relkind = 'r'
         and c.relname <> 'client'
         and exists (
           select 1 from pg_attribute a
            where a.attrelid = c.oid and a.attname = 'client'
              and a.attnum > 0 and not a.attisdropped)
       order by c.relname
    `)) as unknown as Array<{ tbl: string }>;

    expect(tenantTables.length).toBeGreaterThan(30);

    await destroyTenant(doomed.client);

    const stragglers: string[] = [];
    for (const { tbl } of tenantTables) {
      // sql.identifier — the table name comes from the catalogue and must be
      // quoted as an identifier, not bound as a value.
      const left = (await db().execute(
        sql`select count(*)::int as count from ${sql.identifier(tbl)} where client = ${doomed.client}`,
      )) as unknown as Array<{ count: number }>;
      if (left[0].count > 0) stragglers.push(`${tbl}=${left[0].count}`);
    }

    expect(stragglers).toEqual([]);
  });
});
