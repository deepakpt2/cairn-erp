/** Shared locks and guards for writes that can change OX19 assignment compatibility. */
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import {
  chartOfAccounts,
  companyCode,
  controllingArea,
  controllingAreaCompany,
  fiscalYearVariant,
} from './schema';

export interface CompanyCodeFinancialSettings {
  chartOfAccounts: string | null | undefined;
  fiscalYearVariant: string | null | undefined;
  currency: string;
}

export class ControllingAreaCompanyCompatibilityError extends Error {
  readonly code = 'CAIRN_CONFIG';

  constructor(
    message: string,
    readonly remedy = 'Keep the Company Code financial settings compatible with every current OX19 assignment.',
  ) {
    super(message);
    this.name = 'ControllingAreaCompanyCompatibilityError';
  }
}

/**
 * Lock the Company Code first, then its currently linked Controlling Area(s) and
 * any target area. OX19 add/remove uses the same order, so financial-setting
 * changes cannot race an assignment or form a row-lock deadlock with OKKP.
 * Returns only the areas that currently have a link to this Company Code.
 */
export async function lockCompanyCodeOxxAssignments(
  tx: Tx,
  client: string,
  companyCodeKey: string,
  additionalAreaCodes: readonly string[] = [],
): Promise<string[]> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
    ${`${client}/controlling_area_company_code/${companyCodeKey}`}, 0))`);

  const currentRows = await tx.select({ controllingArea: controllingAreaCompany.controllingArea })
    .from(controllingAreaCompany)
    .where(and(
      eq(controllingAreaCompany.client, client),
      eq(controllingAreaCompany.companyCode, companyCodeKey),
    ))
    .orderBy(asc(controllingAreaCompany.controllingArea));
  const currentAreas = [...new Set(currentRows.map((row) => row.controllingArea.trim()))].sort();
  const areasToLock = [...new Set([
    ...currentAreas,
    ...additionalAreaCodes.map((code) => code.trim()).filter(Boolean),
  ])].sort();

  for (const areaCode of areasToLock) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(
      ${`${client}/controlling_area/${areaCode}`}, 0))`);
  }

  if (areasToLock.length > 0) {
    // Row locks follow the same order as OX19: Controlling Area before Company Code.
    await tx.select({ controllingArea: controllingArea.controllingArea })
      .from(controllingArea)
      .where(and(
        eq(controllingArea.client, client),
        inArray(controllingArea.controllingArea, areasToLock),
      ))
      .orderBy(asc(controllingArea.controllingArea))
      .for('share');
  }

  return currentAreas;
}

/**
 * Validate a proposed Company Code CoA/FYV/currency tuple against all current
 * OX19 links. The caller must first call `lockCompanyCodeOxxAssignments`, then
 * acquire the Company Code row lock, and pass the returned area list here.
 */
export async function assertCompanyCodeFinancialSettingsCompatible(
  tx: Tx,
  client: string,
  companyCodeKey: string,
  proposed: CompanyCodeFinancialSettings,
  lockedAreaCodes: readonly string[],
) {
  const areaCodes = [...new Set(lockedAreaCodes)].sort();
  if (areaCodes.length === 0) return;
  if (areaCodes.length > 1) {
    throw new ControllingAreaCompanyCompatibilityError(
      `Company Code ${companyCodeKey} is linked to more than one Controlling Area.`,
      'Resolve the existing OX19 assignments before changing Company Code financial settings.',
    );
  }

  const proposedChart = normalized(proposed.chartOfAccounts);
  const proposedFiscalYearVariant = normalized(proposed.fiscalYearVariant);
  const proposedCurrency = proposed.currency.trim();
  const proposedChartExists = proposedChart
    ? await chartExists(tx, client, proposedChart)
    : false;
  const proposedFiscalYearVariantExists = proposedFiscalYearVariant
    ? await fiscalYearVariantExists(tx, client, proposedFiscalYearVariant)
    : false;

  for (const areaCode of areaCodes) {
    const [area] = await tx.select({
      controllingArea: controllingArea.controllingArea,
      companyCodeScope: controllingArea.companyCodeScope,
      currency: controllingArea.currency,
      fiscalYearVariant: controllingArea.fiscalYearVariant,
    }).from(controllingArea)
      .where(and(
        eq(controllingArea.client, client),
        eq(controllingArea.controllingArea, areaCode),
      ));
    if (!area) {
      throw new ControllingAreaCompanyCompatibilityError(
        `The Controlling Area ${areaCode} linked to Company Code ${companyCodeKey} no longer exists.`,
        'Resolve the existing OX19 link before changing Company Code financial settings.',
      );
    }

    const assignments = await tx.select({
      companyCode: controllingAreaCompany.companyCode,
      chartOfAccounts: companyCode.chartOfAccounts,
      fiscalYearVariant: companyCode.fiscalYearVariant,
      currency: companyCode.currency,
      chartMaster: chartOfAccounts.chartOfAccounts,
      fiscalYearVariantMaster: fiscalYearVariant.variant,
    }).from(controllingAreaCompany)
      .innerJoin(companyCode, and(
        eq(companyCode.client, controllingAreaCompany.client),
        eq(companyCode.companyCode, controllingAreaCompany.companyCode),
      ))
      .leftJoin(chartOfAccounts, and(
        eq(chartOfAccounts.client, companyCode.client),
        eq(chartOfAccounts.chartOfAccounts, companyCode.chartOfAccounts),
      ))
      .leftJoin(fiscalYearVariant, and(
        eq(fiscalYearVariant.client, companyCode.client),
        eq(fiscalYearVariant.variant, companyCode.fiscalYearVariant),
      ))
      .where(and(
        eq(controllingAreaCompany.client, client),
        eq(controllingAreaCompany.controllingArea, areaCode),
      ))
      .orderBy(asc(controllingAreaCompany.companyCode));

    if (!assignments.some((row) => row.companyCode.trim() === companyCodeKey)) {
      throw new ControllingAreaCompanyCompatibilityError(
        `The current OX19 link for Company Code ${companyCodeKey} changed while its financial settings were being checked.`,
        'Reload the current assignments and retry the Company Code change.',
      );
    }
    if (area.companyCodeScope === 'SINGLE' && assignments.length > 1) {
      throw new ControllingAreaCompanyCompatibilityError(
        `Controlling Area ${areaCode} is configured for Same Company Code but has multiple current assignments.`,
        'Resolve the existing OX19 cardinality before changing Company Code financial settings.',
      );
    }
    if (area.companyCodeScope !== 'SINGLE' && area.companyCodeScope !== 'MULTIPLE') {
      throw new ControllingAreaCompanyCompatibilityError(
        `Controlling Area ${areaCode} has an unsupported Company Code assignment scope.`,
        'Correct the Controlling Area scope through OKKP before changing Company Code financial settings.',
      );
    }

    const areaCurrency = area.currency.trim();
    const areaFiscalYearVariant = area.fiscalYearVariant.trim();
    const currentCharts = new Set<string>();
    for (const row of assignments) {
      const isTarget = row.companyCode.trim() === companyCodeKey;
      const chart = isTarget ? proposedChart : normalized(row.chartOfAccounts);
      const year = isTarget ? proposedFiscalYearVariant : normalized(row.fiscalYearVariant);
      const currency = isTarget ? proposedCurrency : row.currency.trim();
      const chartDefined = isTarget ? proposedChartExists : Boolean(row.chartMaster);
      const yearDefined = isTarget ? proposedFiscalYearVariantExists : Boolean(row.fiscalYearVariantMaster);

      if (!chart || !chartDefined || !year || !yearDefined) {
        throw new ControllingAreaCompanyCompatibilityError(
          `A current Company Code assignment for Controlling Area ${areaCode} lacks a defined Operational Chart of Accounts or Fiscal Year Variant.`,
          'Complete the Company Code financial assignments before changing OX19-linked settings.',
        );
      }
      if (year !== areaFiscalYearVariant) {
        throw new ControllingAreaCompanyCompatibilityError(
          `Company Code ${row.companyCode.trim()} Fiscal Year Variant ${year} would not match Controlling Area ${areaCode} Fiscal Year Variant ${areaFiscalYearVariant}.`,
          'Keep every linked Company Code Fiscal Year Variant exactly aligned with its Controlling Area.',
        );
      }
      if (currency !== areaCurrency) {
        throw new ControllingAreaCompanyCompatibilityError(
          `Company Code ${row.companyCode.trim()} local currency ${currency} would not match Controlling Area ${areaCode} Currency Key ${areaCurrency}.`,
          'Keep the Company Code local currency exactly aligned with its Controlling Area Currency Key.',
        );
      }
      currentCharts.add(chart);
    }

    if (area.companyCodeScope === 'MULTIPLE' && currentCharts.size > 1) {
      throw new ControllingAreaCompanyCompatibilityError(
        `The proposed Operational Chart of Accounts would make current assignments for Controlling Area ${areaCode} inconsistent.`,
        'Keep every Company Code in a Multiple Company Codes Controlling Area on the same Operational Chart of Accounts.',
      );
    }
  }
}

async function chartExists(tx: Tx, client: string, code: string) {
  const [row] = await tx.select({ code: chartOfAccounts.chartOfAccounts })
    .from(chartOfAccounts)
    .where(and(
      eq(chartOfAccounts.client, client),
      eq(chartOfAccounts.chartOfAccounts, code),
    ))
    .limit(1);
  return Boolean(row);
}

async function fiscalYearVariantExists(tx: Tx, client: string, code: string) {
  const [row] = await tx.select({ code: fiscalYearVariant.variant })
    .from(fiscalYearVariant)
    .where(and(
      eq(fiscalYearVariant.client, client),
      eq(fiscalYearVariant.variant, code),
    ))
    .limit(1);
  return Boolean(row);
}

function normalized(value: string | null | undefined) {
  const result = value?.trim();
  return result ? result : null;
}
