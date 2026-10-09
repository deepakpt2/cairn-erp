/**
 * Test helpers — a fresh tenant per test file, so tests cannot contaminate each
 * other and the "two tenants must not see each other" property is exercised by
 * construction rather than by a special fixture.
 */
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db, withTenant } from '@/platform/db/client';
import { client as clientTable, clientSettings } from '@/platform/tables/tenancy';
import { defineRange } from '@/platform/numbering';
import { applyStandardPackage } from '@/modules/foundation/standard-config';

/** Four-character tenant key, T + three digits. The reference model uses three characters; ours is longer and its own. */
export function testClientId(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return `T${String(hash % 1000).padStart(3, '0')}`;
}

export interface TestTenant {
  client: string;
  companyCode: string;
  currency: string;
}

/**
 * Create a tenant the same way the application does — through a tenant-scoped
 * transaction. This matters: it proves the row-level security policy permits
 * INSERT into `client` when the session key matches the row being written.
 *
 * The standard configuration package is activated by default, so every test runs
 * against the same fixture the product owner's tenant receives (§24.3). A test
 * that passes here and fails in production would mean the fixture and the real
 * configuration had drifted, which is exactly what this arrangement prevents.
 */
export async function createTenant(
  seed: string,
  options: { currency?: string; companyCode?: string; withConfiguration?: boolean } = {},
): Promise<TestTenant> {
  const client = testClientId(seed);
  const companyCode = options.companyCode ?? '1000';
  const currency = options.currency ?? 'USD';

  await withTenant(client, async (tx) => {
    const existing = await tx.select().from(clientTable).where(eq(clientTable.client, client));
    if (existing.length && (existing[0].name !== `Test tenant ${client}` || !existing[0].isDevelopment)) {
      throw new Error(`Test key ${client} belongs to a non-fixture tenant; refusing to modify it.`);
    }
    await tx
      .insert(clientTable)
      .values({
        client,
        name: `Test tenant ${client}`,
        country: 'KW',
        currency,
        status: 'ACTIVE',
        isDevelopment: true,
        createdBy: 'TEST',
      })
      .onConflictDoNothing();

    await tx
      .insert(clientSettings)
      .values({ client, createdBy: 'TEST' })
      .onConflictDoNothing();

    if (options.withConfiguration !== false) {
      await applyStandardPackage(tx, {
        client,
        companyCode,
        companyName: `Test company ${client}`,
        currency,
        country: 'KW',
        fiscalYearVariant: 'K4',
        activatedBy: 'TEST',
      });
    }
  });

  return { client, companyCode, currency };
}

/** Define the number ranges a tenant needs for the flows under test. */
export async function defineTestRanges(
  tenant: TestTenant,
  options: { journalTo?: number; fiscalYear?: number } = {},
): Promise<void> {
  const fiscalYear = options.fiscalYear ?? new Date().getUTCFullYear();
  await withTenant(tenant.client, async (tx) => {
    await defineRange(tx, {
      client: tenant.client,
      objectCode: 'JOURNAL_ENTRY',
      companyCode: tenant.companyCode,
      subObject: 'GENERAL',
      fiscalYear,
      prefix: 'JE',
      fromNumber: 1,
      toNumber: options.journalTo ?? 999_999,
      createdBy: 'TEST',
    });
  });
}

/**
 * Accounts come from the standard package now, so tests reference the same
 * account numbers a user would. This helper remains for the rare test that needs
 * an account outside the standard chart.
 */
export async function seedAccounts(tenant: TestTenant, accounts: string[]): Promise<void> {
  const { glAccount } = await import('@/modules/finance/schema');
  await withTenant(tenant.client, async (tx) => {
    for (const accountNumber of accounts) {
      await tx
        .insert(glAccount)
        .values({
          client: tenant.client,
          chartOfAccounts: 'CAIRN',
          accountNumber,
          name: `Custom test account ${accountNumber}`,
          accountType: 'EXPENSE',
          isBalanceSheet: false,
          createdBy: 'TEST',
        })
        .onConflictDoNothing();
    }
  });
}

/**
 * Remove a tenant and everything belonging to it. Cascades do the work.
 *
 * Runs INSIDE withTenant, and that is not incidental. An earlier version ran
 * unscoped, and row-level security silently refused the delete: with no tenant
 * scope set, the policy matched nothing, so the statement succeeded while
 * deleting zero rows. Tests then leaked exhausted number ranges into the next
 * run and failed for reasons that had nothing to do with the code under test.
 *
 * The explicit check below exists so that a silent no-op can never recur. A
 * cleanup routine that cannot tell "deleted" from "did nothing" is worse than
 * no cleanup at all.
 */
export async function destroyTenant(client: string): Promise<void> {
  const removed = (await withTenant(client, (tx) =>
    tx.execute(sql`delete from client where client = ${client} returning client`),
  )) as unknown as Array<{ client: string }>;

  if (removed.length === 0) {
    throw new Error(
      `destroyTenant: tenant ${client} was not deleted. ` +
        `Check the tenant scope and the row-level security policy — silently leaking ` +
        `test state into the next run is worse than failing here.`,
    );
  }
}

export { db, withTenant, closeDb, and, eq, sql };
