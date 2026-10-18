/**
 * Test helpers — a fresh tenant per test file, so tests cannot contaminate each
 * other and the "two tenants must not see each other" property is exercised by
 * construction rather than by a special fixture.
 */
import { and, eq, sql } from 'drizzle-orm';
import { closeDb, db, withTenant } from '@/platform/db/client';
import { client as clientTable, clientSettings } from '@/platform/tables/tenancy';
import { defineRange } from '@/platform/numbering';
import { applyStandardPackage, STANDARD_ACCOUNT_GROUP } from '@/modules/foundation/standard-config';
import { applyStandardStructureInTransaction } from '@/platform/tenancy/standard-structure';
import { glAccountGroup } from '@/modules/finance/gl-account-group-schema';
import { chartOfAccounts, distributionChannel, division, salesOrgDistributionChannel, salesOrgDivision } from '@/modules/foundation/schema';
import { deriveGlAccountType, deriveIsBalanceSheet } from '@/modules/finance/gl-account-vocabulary';

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
        currency,
        fiscalYearVariant: 'K4',
        activatedBy: 'TEST',
      });
      // The enterprise structure a configured test tenant is expected to have. While
      // the standard package still writes it this call finds the rows already there
      // and does nothing; when the package is reduced to general data this is what
      // keeps the eighteen structure-dependent test files unchanged.
      await applyStandardStructureInTransaction(tx, {
        client,
        companyCode,
        companyName: `Test company ${client}`,
        currency,
        country: 'KW',
        changedBy: 'TEST',
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
      objectCode: 'RF_BELEG',
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
  const accountType = 'EXPENSE' as const;
  const glAccountType = deriveGlAccountType(accountType);
  await withTenant(tenant.client, async (tx) => {
    for (const accountNumber of accounts) {
      await tx
        .insert(glAccount)
        .values({
          client: tenant.client,
          chartOfAccounts: 'CA01',
          accountNumber,
          name: `Custom test account ${accountNumber}`,
          accountType,
          accountGroup: STANDARD_ACCOUNT_GROUP,
          glAccountType,
          isBalanceSheet: deriveIsBalanceSheet(glAccountType),
          createdBy: 'TEST',
        })
        .onConflictDoNothing();
    }
  });
}

/**
 * Give an ad-hoc chart an Account Group, because FS00 cannot store an account without
 * one: `account_group` is mandatory and the group owns the number range the account must
 * fall inside.
 *
 * The group spans the chart's whole account-number width, which is what migration 0036
 * and the standard package both do, so any account number the chart accepts also falls
 * inside the range. Returns the group code to pass to `upsertGlAccount`.
 */
export async function ensureAccountGroup(
  tenant: TestTenant,
  chart: string,
  code: string = STANDARD_ACCOUNT_GROUP,
): Promise<string> {
  await withTenant(tenant.client, async (tx) => {
    const [definition] = await tx
      .select({ accountNumberLength: chartOfAccounts.accountNumberLength })
      .from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.client, tenant.client), eq(chartOfAccounts.chartOfAccounts, chart)))
      .limit(1);
    if (!definition) throw new Error(`Chart of Accounts ${chart} was not created for ${tenant.client}.`);
    await tx
      .insert(glAccountGroup)
      .values({
        client: tenant.client,
        chartOfAccounts: chart,
        accountGroup: code,
        description: `Test Account Group ${code}`,
        fromAccountNumber: '0'.repeat(definition.accountNumberLength),
        toAccountNumber: '9'.repeat(definition.accountNumberLength),
        createdBy: 'TEST',
      })
      .onConflictDoNothing();
  });
  return code;
}

/**
 * Give a Sales Area fixture the assignments it needs.
 *
 * Migration 0030 (OVXG) made a Sales Area reference both assignment sets — the
 * (sales organization, distribution channel) pair from OVXK and the (sales
 * organization, division) pair from OVXA — and each assignment in turn references its
 * own definition. The standard package defines channels and divisions `01`–`03` but
 * assigns only `1000`/`01`/`01`, so a fixture that inserts a Sales Area directly has to
 * supply its own dimensions first. Without them the insert fails on the foreign key, and
 * where it happens at module scope it takes the whole file's tests with it.
 *
 * Definitions are created only when missing and are never updated, so a test that owns
 * a definition — its name, version and lifecycle — keeps ownership of it.
 */
export async function assignSalesAreaDimensions(
  tenant: TestTenant,
  salesOrg: string,
  dimensions: Array<{ distributionChannel?: string; division?: string }>,
): Promise<void> {
  await withTenant(tenant.client, async (tx) => {
    for (const dimension of dimensions) {
      if (dimension.distributionChannel) {
        await tx
          .insert(distributionChannel)
          .values({
            client: tenant.client,
            distributionChannel: dimension.distributionChannel,
            name: `Test channel ${dimension.distributionChannel}`,
            createdBy: 'TEST',
          })
          .onConflictDoNothing();
        await tx
          .insert(salesOrgDistributionChannel)
          .values({
            client: tenant.client,
            salesOrg,
            distributionChannel: dimension.distributionChannel,
            createdBy: 'TEST',
          })
          .onConflictDoNothing();
      }
      if (dimension.division) {
        await tx
          .insert(division)
          .values({
            client: tenant.client,
            division: dimension.division,
            name: `Test division ${dimension.division}`,
            createdBy: 'TEST',
          })
          .onConflictDoNothing();
        await tx
          .insert(salesOrgDivision)
          .values({
            client: tenant.client,
            salesOrg,
            division: dimension.division,
            createdBy: 'TEST',
          })
          .onConflictDoNothing();
      }
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
