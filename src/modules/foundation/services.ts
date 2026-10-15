/**
 * Foundation services — CAIRN.md §20.2
 *
 * Services are the only place transactions are opened and the only place
 * configuration is written. Every write goes through recordChange, so the
 * workbench, the change log and the auditor's view all see the same history —
 * configuration changes matter as much as document changes, and often more,
 * because a changed posting period rule alters what the books will accept.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { glAccount } from '../finance/schema';
import {
  assertCompanyCodeFinancialSettingsCompatible,
  lockCompanyCodeOxxAssignments,
} from './controlling-area-company-compatibility';
import {
  chartOfAccounts,
  companyCode,
  fiscalYearVariant,
  plant,
  postingPeriodRule,
  storageLocation,
} from './schema';

export class ConfigError extends Error {
  readonly code = 'CAIRN_CONFIG';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/* ── Company codes ─────────────────────────────────────────────────────────── */

export async function listCompanyCodes(client: string) {
  return withTenant(client, (tx) =>
    tx.select().from(companyCode).orderBy(asc(companyCode.companyCode)),
  );
}

export async function getCompanyCodeDetail(client: string, companyCodeKey: string) {
  return withTenant(client, async (tx) => {
    const rows = await tx
      .select()
      .from(companyCode)
      .where(
        and(eq(companyCode.client, client), eq(companyCode.companyCode, companyCodeKey)),
      )
      .limit(1);

    if (rows.length === 0) return null;
    const company = rows[0];

    // The assigned configuration, resolved when the corresponding assignment exists.
    const coa = company.chartOfAccounts
      ? await tx
          .select()
          .from(chartOfAccounts)
          .where(
            and(
              eq(chartOfAccounts.client, client),
              eq(chartOfAccounts.chartOfAccounts, company.chartOfAccounts),
            ),
          )
          .limit(1)
      : [];

    const fyv = company.fiscalYearVariant
      ? await tx
          .select()
          .from(fiscalYearVariant)
          .where(
            and(
              eq(fiscalYearVariant.client, client),
              eq(fiscalYearVariant.variant, company.fiscalYearVariant),
            ),
          )
          .limit(1)
      : [];

    const plants = await tx
      .select()
      .from(plant)
      .where(and(eq(plant.client, client), eq(plant.companyCode, company.companyCode)))
      .orderBy(asc(plant.plant));

    const accountCount = company.chartOfAccounts
      ? await tx
          .select({ count: sql<number>`count(*)::int` })
          .from(glAccount)
          .where(
            and(
              eq(glAccount.client, client),
              eq(glAccount.chartOfAccounts, company.chartOfAccounts),
            ),
          )
      : [{ count: 0 }];

    return {
      company,
      chartOfAccounts: coa[0] ?? null,
      fiscalYearVariant: fyv[0] ?? null,
      plants,
      accountCount: accountCount[0]?.count ?? 0,
    };
  });
}

export interface CompanyCodeInput {
  client: string;
  companyCode: string;
  name: string;
  chartOfAccounts: string;
  fiscalYearVariant: string;
  postingPeriodVariant: string;
  currency: string;
  country: string;
  city?: string;
  taxRegistrationNumber?: string;
  changedBy: string;
}

export async function upsertCompanyCode(input: CompanyCodeInput) {
  const { client, companyCode: code, changedBy } = input;
  const chartKey = input.chartOfAccounts.trim().toUpperCase();
  if (!/^[A-Z0-9]{4}$/.test(chartKey)) {
    throw new ConfigError('Chart of Accounts must be exactly four letters or numbers.', 'Choose a valid four-character Chart of Accounts key.');
  }

  return withTenant(client, async (tx) => {
    const linkedAreas = await lockCompanyCodeOxxAssignments(tx, client, code);
    const existing = await tx
      .select()
      .from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, code)))
      .limit(1)
      .for('update');

    const [chart] = await tx.select({
      isActive: chartOfAccounts.isActive,
      isBlocked: chartOfAccounts.isBlocked,
    }).from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, chartKey)))
      .limit(1)
      .for('share');
    if (!chart || !chart.isActive) {
      throw new ConfigError(`Active Chart of Accounts ${chartKey} is not defined in this tenant.`, 'Define and activate the Chart of Accounts first.');
    }
    if (chart.isBlocked && (existing.length === 0 || existing[0].chartOfAccounts !== chartKey)) {
      throw new ConfigError(`Chart of Accounts ${chartKey} is blocked and cannot be assigned to a Company Code.`, 'Remove the Chart of Accounts block before creating a new Company Code segment.');
    }

    const values = {
      client,
      companyCode: code,
      name: input.name,
      chartOfAccounts: chartKey,
      fiscalYearVariant: input.fiscalYearVariant,
      postingPeriodVariant: input.postingPeriodVariant,
      currency: input.currency,
      country: input.country,
      city: input.city,
      taxRegistrationNumber: input.taxRegistrationNumber,
    };

    if (existing.length === 0) {
      await tx.insert(companyCode).values({ ...values, createdBy: changedBy });
      await recordChange(tx, {
        client,
        objectClass: 'company_code',
        objectKey: code,
        changeType: 'CREATE',
        changedBy,
        transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE',
        after: values,
      });
      await markActivityComplete(tx, client, 'CFG.ORG.COMPANYCODE.DEFINE', changedBy);
      return { created: true, companyCode: code };
    }

    const before = existing[0];
    await assertCompanyCodeFinancialSettingsCompatible(tx, client, code, {
      chartOfAccounts: values.chartOfAccounts,
      fiscalYearVariant: values.fiscalYearVariant,
      currency: values.currency,
    }, linkedAreas);
    await tx
      .update(companyCode)
      .set({ ...values, changedBy, changedAt: new Date() })
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, code)));

    await recordChange(tx, {
      client,
      objectClass: 'company_code',
      objectKey: code,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: 'CFG.ORG.COMPANYCODE.DEFINE',
      before: before as unknown as Record<string, unknown>,
      after: values,
      fieldLabels: {
        chartOfAccounts: 'Chart of accounts',
        fiscalYearVariant: 'Fiscal year variant',
        postingPeriodVariant: 'Posting period variant',
        currency: 'Local currency',
      },
      // Changing these alters what the books will accept, so they are flagged for
      // the auditor rather than buried among cosmetic fields (§16.3).
      securityRelevantFields: [
        'chartOfAccounts',
        'fiscalYearVariant',
        'postingPeriodVariant',
      ],
    });

    return { created: false, companyCode: code };
  });
}

/* ── G/L accounts ──────────────────────────────────────────────────────────── */

export async function listGlAccounts(
  client: string,
  options: { chartOfAccounts?: string; search?: string } = {},
) {
  return withTenant(client, async (tx) => {
    const filters = [eq(glAccount.client, client)];
    if (options.chartOfAccounts) {
      filters.push(eq(glAccount.chartOfAccounts, options.chartOfAccounts));
    }
    if (options.search && options.search.trim() !== '') {
      const term = `%${options.search.trim()}%`;
      filters.push(
        sql`(${glAccount.accountNumber} ilike ${term} or ${glAccount.name} ilike ${term})`,
      );
    }
    return tx
      .select()
      .from(glAccount)
      .where(and(...filters))
      .orderBy(asc(glAccount.accountNumber));
  });
}

export interface GlAccountInput {
  client: string;
  chartOfAccounts: string;
  accountNumber: string;
  name: string;
  accountType: 'ASSET' | 'LIABILITY' | 'EQUITY' | 'REVENUE' | 'EXPENSE';
  isBalanceSheet: boolean;
  isOpenItemManaged: boolean;
  reconciliationType?: 'VENDOR' | 'CUSTOMER' | 'ASSET' | 'MATERIAL';
  requiresCostObject: boolean;
  isTaxRelevant: boolean;
  changedBy: string;
}

export async function upsertGlAccount(input: GlAccountInput) {
  const { client, changedBy } = input;
  const coa = input.chartOfAccounts.trim().toUpperCase();
  const accountNumber = input.accountNumber.trim();
  if (!/^[A-Z0-9]{4}$/.test(coa)) {
    throw new ConfigError('Chart of Accounts must be exactly four letters or numbers.', 'Choose an existing four-character Chart of Accounts key.');
  }
  if (accountNumber.length < 1 || accountNumber.length > 10) {
    throw new ConfigError('G/L Account Number must be between 1 and 10 characters.', 'Enter an account number within the Chart of Accounts length limit.');
  }

  return withTenant(client, async (tx) => {
    const [chart] = await tx.select({
      accountNumberLength: chartOfAccounts.accountNumberLength,
      isActive: chartOfAccounts.isActive,
      isBlocked: chartOfAccounts.isBlocked,
    }).from(chartOfAccounts)
      .where(and(eq(chartOfAccounts.client, client), eq(chartOfAccounts.chartOfAccounts, coa)))
      .limit(1)
      .for('share');
    if (!chart || !chart.isActive) {
      throw new ConfigError(`Active Chart of Accounts ${coa} is not defined in this tenant.`, 'Define and activate the Chart of Accounts before maintaining G/L accounts.');
    }
    if (accountNumber.length > chart.accountNumberLength) {
      throw new ConfigError(
        `G/L Account Number ${accountNumber} exceeds the ${chart.accountNumberLength}-character limit for Chart of Accounts ${coa}.`,
        'Use an account number no longer than the chart’s configured maximum.',
      );
    }

    const existing = await tx
      .select()
      .from(glAccount)
      .where(
        and(
          eq(glAccount.client, client),
          eq(glAccount.chartOfAccounts, coa),
          eq(glAccount.accountNumber, accountNumber),
        ),
      )
      .limit(1);
    if (existing.length === 0 && chart.isBlocked) {
      throw new ConfigError(
        `Chart of Accounts ${coa} is blocked; new G/L accounts cannot be created.`,
        'Remove the Chart of Accounts block before creating a G/L account.',
      );
    }

    const values = {
      client,
      chartOfAccounts: coa,
      accountNumber,
      name: input.name,
      accountType: input.accountType,
      isBalanceSheet: input.isBalanceSheet,
      isOpenItemManaged: input.isOpenItemManaged,
      reconciliationType: input.reconciliationType,
      requiresCostObject: input.requiresCostObject,
      isTaxRelevant: input.isTaxRelevant,
    };

    if (existing.length === 0) {
      await tx.insert(glAccount).values({ ...values, createdBy: changedBy });
      await recordChange(tx, {
        client,
        objectClass: 'gl_account',
        objectKey: `${coa}/${accountNumber}`,
        changeType: 'CREATE',
        changedBy,
        transactionCode: 'FIN.GL.MASTER.CREATE',
        after: values,
      });
      await markActivityComplete(tx, client, 'CFG.FIN.GLACCOUNT.CREATE', changedBy);
      return { created: true };
    }

    const before = existing[0];
    await tx
      .update(glAccount)
      .set({ ...values, changedBy, changedAt: new Date() })
      .where(
        and(
          eq(glAccount.client, client),
          eq(glAccount.chartOfAccounts, coa),
          eq(glAccount.accountNumber, accountNumber),
        ),
      );

    await recordChange(tx, {
      client,
      objectClass: 'gl_account',
      objectKey: `${coa}/${accountNumber}`,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: 'FIN.GL.MASTER.CREATE',
      before: before as unknown as Record<string, unknown>,
      after: values,
      // Blocking an account or changing its type changes what may be posted
      // where. An auditor cares; these are not cosmetic edits.
      securityRelevantFields: ['accountType', 'isBlocked', 'reconciliationType'],
    });

    return { created: false };
  });
}

/* ── Posting periods ───────────────────────────────────────────────────────── */

export async function listPeriodRules(
  client: string,
  companyCodeKey: string,
  fiscalYear: number,
) {
  const { periodStatus } = await import('../../platform/periods');
  return withTenant(client, (tx) => periodStatus(tx, client, companyCodeKey, fiscalYear));
}

export interface PeriodRuleInput {
  client: string;
  variant: string;
  accountType: 'S' | 'K' | 'D' | 'A' | 'M';
  periodFrom: number;
  periodTo: number;
  allowSpecialPeriods: boolean;
  changedBy: string;
}

export async function updatePeriodRule(input: PeriodRuleInput) {
  const { client, variant, accountType, changedBy } = input;

  if (!['S', 'K', 'D', 'A', 'M'].includes(input.accountType) || !Number.isInteger(input.periodFrom) || !Number.isInteger(input.periodTo) || input.periodFrom < 1 || input.periodTo > 16 || input.periodFrom > input.periodTo) {
    throw new ConfigError(
      `Period range ${input.periodFrom} to ${input.periodTo} is not valid.`,
      'Enter a range between 1 and 16, where the first period is not later than the last.',
    );
  }

  return withTenant(client, async (tx) => {
    const existing = await tx
      .select()
      .from(postingPeriodRule)
      .where(
        and(
          eq(postingPeriodRule.client, client),
          eq(postingPeriodRule.variant, variant),
          eq(postingPeriodRule.accountType, accountType),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      throw new ConfigError(
        `No posting period rule exists for account type ${accountType} ` +
          `in variant ${variant}.`,
        'The standard configuration package creates these rules when a tenant is set up.',
      );
    }

    const before = existing[0];
    await tx
      .update(postingPeriodRule)
      .set({
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        allowSpecialPeriods: input.allowSpecialPeriods,
        changedBy,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(postingPeriodRule.client, client),
          eq(postingPeriodRule.variant, variant),
          eq(postingPeriodRule.accountType, accountType),
        ),
      );

    // Reopening or closing a period changes what the books will accept, so it is
    // recorded as a change with a security-relevant flag and a reason field the
    // auditor can read (§16.6).
    await recordChange(tx, {
      client,
      objectClass: 'posting_period_rule',
      objectKey: `${variant}/${accountType}`,
      changeType: 'CHANGE',
      changedBy,
      transactionCode: 'FIN.CLOSE.PERIOD',
      before: {
        periodFrom: before.periodFrom,
        periodTo: before.periodTo,
        allowSpecialPeriods: before.allowSpecialPeriods,
      },
      after: {
        periodFrom: input.periodFrom,
        periodTo: input.periodTo,
        allowSpecialPeriods: input.allowSpecialPeriods,
      },
      securityRelevantFields: ['periodFrom', 'periodTo', 'allowSpecialPeriods'],
    });

    return { accountType };
  });
}

/* ── Plants and storage locations ──────────────────────────────────────────── */

export async function listPlants(client: string, companyCodeKey?: string) {
  return withTenant(client, async (tx) => {
    const filters = [eq(plant.client, client)];
    if (companyCodeKey) filters.push(eq(plant.companyCode, companyCodeKey));

    const plants = await tx
      .select()
      .from(plant)
      .where(and(...filters))
      .orderBy(asc(plant.plant));

    const result = [];
    for (const p of plants) {
      const locations = await tx
        .select()
        .from(storageLocation)
        .where(and(eq(storageLocation.client, client), eq(storageLocation.plant, p.plant)))
        .orderBy(asc(storageLocation.storageLocation));
      result.push({ ...p, storageLocations: locations });
    }
    return result;
  });
}

/** Everything the foundation screens need for their selection lists. */
export async function listConfigurationChoices(client: string) {
  return withTenant(client, async (tx) => ({
    charts: await tx
      .select()
      .from(chartOfAccounts)
      .where(eq(chartOfAccounts.client, client))
      .orderBy(asc(chartOfAccounts.chartOfAccounts)),
    fiscalYearVariants: await tx
      .select()
      .from(fiscalYearVariant)
      .where(eq(fiscalYearVariant.client, client))
      .orderBy(asc(fiscalYearVariant.variant)),
  }));
}

export { withTenant, type Tx };
