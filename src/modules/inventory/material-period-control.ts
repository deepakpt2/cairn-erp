import { and, eq } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { markActivityComplete } from '../../platform/tenancy';
import { companyCode, fiscalYearVariant } from '../foundation/schema';
import { materialPeriodControl } from './schema';

/**
 * Material period control (SCR-054 / OMSY; R-102).
 *
 * One control record per company code: the current and previous
 * material posting periods and the two backposting indicators, kept
 * separate as the reference keeps them. A record is initialized once —
 * to a year/period judged against the company's fiscal-year variant,
 * regular periods only — and afterwards advances only through the
 * shift act, which moves exactly one period under lock and, where the
 * disallow-after-change indicator stands, clears the backposting
 * allowance as it goes. Standing periods are never edited directly and
 * records are never deleted. Every act writes one change document.
 */

export const ACTIVITY = 'CFG.INV.MATPERIOD.DEFINE';

export class MaterialPeriodError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'MaterialPeriodError';
  }
}

const OBJECT_CLASS = 'material_period_control';
const PRODUCTION = process.env.NODE_ENV === 'production';

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new MaterialPeriodError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new MaterialPeriodError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new MaterialPeriodError(
      'A reason is required for every material period change.',
      'State why this change is being made.',
    );
  }
  return value;
}

// ── Reads ────────────────────────────────────────────────────────────────

export interface MaterialPeriodRow {
  companyCode: string;
  companyName: string;
  initialized: boolean;
  currentYear: number | null;
  currentPeriod: number | null;
  previousYear: number | null;
  previousPeriod: number | null;
  previousYearRefYear: number | null;
  previousYearRefPeriod: number | null;
  allowBackposting: boolean;
  disallowBackpostingAfterChange: boolean;
  lastChangedBy: string | null;
}

export async function listMaterialPeriodControl(client: string): Promise<MaterialPeriodRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const companies = await tx
      .select()
      .from(companyCode)
      .where(eq(companyCode.client, tenant))
      .orderBy(companyCode.companyCode);
    const records = await tx
      .select()
      .from(materialPeriodControl)
      .where(eq(materialPeriodControl.client, tenant));
    const byCompany = new Map(records.map((r) => [r.companyCode, r]));
    return companies.map((c) => {
      const r = byCompany.get(c.companyCode);
      return {
        companyCode: c.companyCode,
        companyName: c.name,
        initialized: !!r,
        currentYear: r?.currentFiscalYear ?? null,
        currentPeriod: r?.currentPeriod ?? null,
        previousYear: r?.previousFiscalYear ?? null,
        previousPeriod: r?.previousPeriod ?? null,
        previousYearRefYear: r?.previousYearRefYear ?? null,
        previousYearRefPeriod: r?.previousYearRefPeriod ?? null,
        allowBackposting: r?.allowBackposting ?? false,
        disallowBackpostingAfterChange: r?.disallowBackpostingAfterChange ?? false,
        lastChangedBy: r?.changedBy ?? r?.createdBy ?? null,
      };
    });
  });
}

export interface MaterialPeriodRecord {
  companyCode: string;
  currentFiscalYear: number;
  currentPeriod: number;
  previousFiscalYear: number;
  previousPeriod: number;
  allowBackposting: boolean;
  disallowBackpostingAfterChange: boolean;
}

export async function getMaterialPeriodControl(
  client: string,
  company: string,
): Promise<MaterialPeriodRecord | null> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const [r] = await tx
      .select()
      .from(materialPeriodControl)
      .where(
        and(
          eq(materialPeriodControl.client, tenant),
          eq(materialPeriodControl.companyCode, company),
        ),
      );
    return r ?? null;
  });
}

/**
 * The posting judge the goods-movement round will call: the current
 * period always stands open; the previous period only where
 * backposting is allowed (the shift act applies the
 * disallow-after-change indicator by clearing that allowance); every
 * other period is closed. An uninitialized company opens nothing.
 */
export function materialPeriodAllows(
  record: MaterialPeriodRecord | null,
  fiscalYear: number,
  period: number,
): boolean {
  if (!record) return false;
  if (record.currentFiscalYear === fiscalYear && record.currentPeriod === period) return true;
  if (record.previousFiscalYear === fiscalYear && record.previousPeriod === period) {
    return record.allowBackposting;
  }
  return false;
}

// ── Writes ───────────────────────────────────────────────────────────────

async function companyVariant(tx: Tx, client: string, company: string) {
  const [rowCompany] = await tx
    .select()
    .from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, company)));
  if (!rowCompany) {
    throw new MaterialPeriodError(`Company code ${company} does not stand.`);
  }
  if (!rowCompany.fiscalYearVariant) {
    throw new MaterialPeriodError(
      `Company code ${company} has no fiscal year variant assigned.`,
      'Assign a fiscal year variant to the company code first, then initialize its material period.',
    );
  }
  const [variant] = await tx
    .select()
    .from(fiscalYearVariant)
    .where(
      and(
        eq(fiscalYearVariant.client, client),
        eq(fiscalYearVariant.variant, rowCompany.fiscalYearVariant),
      ),
    );
  if (!variant?.isActive) {
    throw new MaterialPeriodError(
      `Fiscal year variant ${rowCompany.fiscalYearVariant} does not stand active.`,
      'Reactivate the variant, then initialize the material period.',
    );
  }
  return variant;
}

function judgeYearPeriod(fiscalYear: number, period: number, regularPeriods: number) {
  if (!Number.isInteger(fiscalYear) || fiscalYear < 1000 || fiscalYear > 9999) {
    throw new MaterialPeriodError(
      'The fiscal year must be a four-digit year.',
      'Enter the year the material period starts in.',
    );
  }
  if (!Number.isInteger(period) || period < 1 || period > regularPeriods) {
    throw new MaterialPeriodError(
      `The material period must stand between 1 and ${regularPeriods} for this fiscal-year variant.`,
      'Special periods are never material periods; pick a regular period.',
    );
  }
}

function previousOf(year: number, period: number, regularPeriods: number) {
  return period > 1
    ? { year, period: period - 1 }
    : { year: year - 1, period: regularPeriods };
}

export interface InitializeMaterialPeriodInput {
  client: string;
  changedBy: string;
  companyCode: string;
  fiscalYear: number;
  period: number;
  reason: string;
}

export async function initializeMaterialPeriodControl(input: InitializeMaterialPeriodInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const company = (input.companyCode ?? '').trim();
  return withTenant(client, async (tx) => {
    const variant = await companyVariant(tx, client, company);
    judgeYearPeriod(input.fiscalYear, input.period, variant.regularPeriods);
    const [existing] = await tx
      .select()
      .from(materialPeriodControl)
      .where(
        and(
          eq(materialPeriodControl.client, client),
          eq(materialPeriodControl.companyCode, company),
        ),
      )
      .for('update');
    if (existing) {
      throw new MaterialPeriodError(
        `Company code ${company} is already initialized at ${existing.currentFiscalYear} / ${existing.currentPeriod}.`,
        'An established material period is never reinitialized; advance it with the period shift instead.',
      );
    }
    const previous = previousOf(input.fiscalYear, input.period, variant.regularPeriods);
    await tx.insert(materialPeriodControl).values({
      client,
      companyCode: company,
      currentFiscalYear: input.fiscalYear,
      currentPeriod: input.period,
      previousFiscalYear: previous.year,
      previousPeriod: previous.period,
      allowBackposting: false,
      disallowBackpostingAfterChange: false,
      createdBy: changedBy,
    });
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: company,
      changeType: 'CREATE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      after: {
        currentFiscalYear: input.fiscalYear,
        currentPeriod: input.period,
        previousFiscalYear: previous.year,
        previousPeriod: previous.period,
      },
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { companyCode: company, changed: true };
  });
}

export interface MaterialPeriodIndicatorsInput {
  client: string;
  changedBy: string;
  companyCode: string;
  allowBackposting: boolean;
  disallowBackpostingAfterChange: boolean;
  reason: string;
}

export async function setMaterialPeriodIndicators(input: MaterialPeriodIndicatorsInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const company = (input.companyCode ?? '').trim();
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialPeriodControl)
      .where(
        and(
          eq(materialPeriodControl.client, client),
          eq(materialPeriodControl.companyCode, company),
        ),
      )
      .for('update');
    if (!existing) {
      throw new MaterialPeriodError(
        `Company code ${company} has no material period control record.`,
        'Initialize the record first, then maintain its indicators.',
      );
    }
    if (
      existing.allowBackposting === input.allowBackposting &&
      existing.disallowBackpostingAfterChange === input.disallowBackpostingAfterChange
    ) {
      return { companyCode: company, changed: false };
    }
    await tx
      .update(materialPeriodControl)
      .set({
        allowBackposting: input.allowBackposting,
        disallowBackpostingAfterChange: input.disallowBackpostingAfterChange,
        changedBy,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(materialPeriodControl.client, client),
          eq(materialPeriodControl.companyCode, company),
        ),
      );
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: company,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: {
        allowBackposting: existing.allowBackposting,
        disallowBackpostingAfterChange: existing.disallowBackpostingAfterChange,
      },
      after: {
        allowBackposting: input.allowBackposting,
        disallowBackpostingAfterChange: input.disallowBackpostingAfterChange,
      },
      securityRelevantFields: ['allowBackposting', 'disallowBackpostingAfterChange'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { companyCode: company, changed: true };
  });
}

export interface ShiftMaterialPeriodInput {
  client: string;
  changedBy: string;
  companyCode: string;
  reason: string;
}

export async function shiftMaterialPeriod(input: ShiftMaterialPeriodInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const company = (input.companyCode ?? '').trim();
  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(materialPeriodControl)
      .where(
        and(
          eq(materialPeriodControl.client, client),
          eq(materialPeriodControl.companyCode, company),
        ),
      )
      .for('update');
    if (!existing) {
      throw new MaterialPeriodError(
        `Company code ${company} has no material period control record.`,
        'Initialize the record first; there is no period to shift.',
      );
    }
    const variant = await companyVariant(tx, client, company);
    const yearBoundary = existing.currentPeriod >= variant.regularPeriods;
    const next = yearBoundary
      ? { year: existing.currentFiscalYear + 1, period: 1 }
      : { year: existing.currentFiscalYear, period: existing.currentPeriod + 1 };
    // Where backposting after a period change is disallowed, the shift
    // itself clears the allowance — the indicators never merge.
    const allowBackposting = existing.disallowBackpostingAfterChange
      ? false
      : existing.allowBackposting;
    await tx
      .update(materialPeriodControl)
      .set({
        previousFiscalYear: existing.currentFiscalYear,
        previousPeriod: existing.currentPeriod,
        currentFiscalYear: next.year,
        currentPeriod: next.period,
        previousYearRefYear: yearBoundary
          ? existing.currentFiscalYear
          : existing.previousYearRefYear,
        previousYearRefPeriod: yearBoundary
          ? variant.regularPeriods
          : existing.previousYearRefPeriod,
        allowBackposting,
        changedBy,
        changedAt: new Date(),
      })
      .where(
        and(
          eq(materialPeriodControl.client, client),
          eq(materialPeriodControl.companyCode, company),
        ),
      );
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: company,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: {
        currentFiscalYear: existing.currentFiscalYear,
        currentPeriod: existing.currentPeriod,
        previousFiscalYear: existing.previousFiscalYear,
        previousPeriod: existing.previousPeriod,
        allowBackposting: existing.allowBackposting,
      },
      after: {
        currentFiscalYear: next.year,
        currentPeriod: next.period,
        previousFiscalYear: existing.currentFiscalYear,
        previousPeriod: existing.currentPeriod,
        allowBackposting,
      },
      securityRelevantFields: ['currentFiscalYear', 'currentPeriod', 'allowBackposting'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return {
      companyCode: company,
      changed: true,
      currentFiscalYear: next.year,
      currentPeriod: next.period,
      previousFiscalYear: existing.currentFiscalYear,
      previousPeriod: existing.currentPeriod,
    };
  });
}
