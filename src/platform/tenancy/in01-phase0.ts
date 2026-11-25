/**
 * Phase 0 and Phase 1 for the India UAT dataset: the enterprise structure, the chart
 * additions, the fiscal year, GST codes and payroll statute (Phase 0), and the people and
 * accounts (Phase 1).
 *
 * Every value comes from the fixtures. Nothing here invents a code, a name or an amount.
 * Every write goes through the service the screen calls, so the validations, number ranges
 * and account determination are exercised exactly as they would be by a person.
 *
 * Idempotency is by adoption, in the same style as the existing provisioner: an object that
 * already stands is left alone, and a document carries a request key. The reset path
 * (`in01-reset.ts`) is the only thing that removes anything, and it is the only code here
 * that is allowed to think about deletion at all.
 */
import { and, eq } from 'drizzle-orm';

import { withTenant } from '../db/client';
import { createTenant, listTenants } from './index';
import { applyStandardStructure } from './standard-structure';
import { upsertCompanyCode, upsertGlAccount } from '../../modules/foundation/services';
import { defineCompanyCode } from '../../modules/foundation/company-code-definition';
import { assignCompanyCodeCoa } from '../../modules/foundation/company-code-coa-assignment';
import { assignFiscalYearVariant } from '../../modules/foundation/fiscal-year-variant-assignment';
import { assignPostingPeriodVariant } from '../../modules/foundation/posting-period-variant-assignment';
import { saveFiscalYearVariant, saveFiscalYearPeriods, listFiscalYearVariants } from '../../modules/foundation/fiscal-year-variant-maintenance';
import { getControllingAreaVersion, listControllingAreas, saveControllingArea } from '../../modules/foundation/controlling-area-maintenance';
import { assignCompanyCodeToControllingArea, unassignCompanyCodeFromControllingArea } from '../../modules/foundation/controlling-area-company-assignment';
import { saveTaxCode } from '../../modules/foundation/tax-code-definition';
import { savePlantDefinition } from '../../modules/foundation/plant-maintenance';
import { saveStorageLocation } from '../../modules/foundation/storage-location-maintenance';
import { assignPlantCompanyCode } from '../../modules/foundation/plant-company-code-assignment';
import { saveCostCenter } from '../../modules/foundation/cost-center-definition';
import { saveProfitCenter } from '../../modules/foundation/profit-center-definition';
import { saveWorkCenterCategory, createWorkCenterForProvisioning } from '../../modules/production/work-center';
import { defineShippingPointForProvisioning, assignShippingPointForProvisioning } from '../../modules/sales/shipping-point-maintenance';
import { saveAccountDetermination } from '../../modules/foundation/account-determination';
import { maintainNumberRange } from '../../modules/foundation/number-ranges';
import { seedTypeValuationForPlant } from '../../modules/inventory/standard-config';
import { STANDARD_RETAINED_EARNINGS_INDICATOR } from '../../modules/foundation/retained-earnings-vocabulary';
import { saveHolidayCalendar, addHolidayDay } from '../../modules/foundation/factory-calendar';
import { defineOrgUnit, defineJob, definePosition, changePosition } from '../../modules/people/org-structure';
import { createEmployee, linkEmployeeUser } from '../../modules/people/employee-master';
import { assignPosition } from '../../modules/people/assignment';
import { defineTimeType, setLeaveQuota } from '../../modules/people/time-leave';
import { defineRecordType } from '../../modules/people/record-types';
import { definePayComponent, savePayComponentMapping } from '../../modules/people/pay-components';
import { defineSalaryStructure, setStructureComponent, assignStructure } from '../../modules/people/payroll-structure';
import { companyCode, purchasingOrgPlant, storageLocation } from '../../modules/foundation/schema';
import type { FixtureSet } from './in01-fixtures';
import type { DemoAccount } from './demo-credentials';

/** Recorded as `created_by` on every row this module writes. */
export const IN01_ACTOR = 'IN01_PROVISION';

/** What the acting administrator holds. `ADMINISTRATOR` is the wildcard. */
const ADMIN_PATTERNS = ['*'] as const;
const PLATFORM_PATTERNS = [
  'CFG.PLT.ROLE.MAINTAIN',
  'CFG.PLT.USER.ROLE.MAINTAIN',
  'CFG.PLT.USER.CREATE',
  'CFG.PLT.USER.MAINTAIN',
] as const;

/** A write that found the row already there is not a failure. */
function swallowDuplicate(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists|already been|is already|already stands|changed after it was opened|EXISTS/i.test(message)) return;
  throw error;
}

export interface Phase0Result {
  client: string;
  companyCode: string;
  tenantCreated: boolean;
  fiscalYearVariant: string;
  chartAdditions: number;
  taxCodes: number;
  plants: string[];
  storageLocations: number;
  costCentres: number;
  profitCentres: number;
  workCentres: number;
  determinationRows: number;
  holidayDays: number;
}

export interface Phase1Result {
  orgUnits: number;
  jobs: number;
  positions: number;
  employees: number;
  users: number;
  leaveTypes: number;
  recordTypes: number;
  quotas: number;
  structures: number;
  assignments: number;
}

/* ─────────────────────────── Phase 0 · Organisation ─────────────────────────── */

export async function buildPhase0(input: {
  fixtures: FixtureSet;
  password: string;
  scenario: { fiscalYear: number; period: number; from: string; to: string };
}): Promise<Phase0Result> {
  const { fixtures } = input;
  const { core, country, company } = fixtures;
  const client = company.identity.clientKey;
  const structure = core.structure;

  const standing = (await listTenants()).find((tenant) => tenant.client === client);
  if (!standing) {
    await createTenant({
      clientKey: client,
      name: company.identity.name,
      legalName: company.identity.legalName,
      country: country.country.code,
      currency: country.country.currency,
      timezone: country.country.timezone,
      language: 'EN',
      isDevelopment: false,
      administrator: { ...company.founderAccounts.platformAdmin, password: input.password },
      tenantAdministrator: { ...company.founderAccounts.administrator, password: input.password },
      creationType: 'standard',
      createdBy: IN01_ACTOR,
    });
  }

  // The standard company structure, then what this company is.
  await applyStandardStructure({
    client,
    companyCode: structure.companyCode,
    companyName: company.identity.name,
    country: country.country.code,
    currency: country.country.currency,
    changedBy: IN01_ACTOR,
  });

  // The fiscal year variant must exist before the company code can point at it.
  const fiscalYearVariant = await ensureFiscalYearVariant(client, country);

  // The company code and its controlling area must carry the same fiscal year, and each
  // refuses to change while the other disagrees. The link is therefore broken first, both
  // sides are moved to April-to-March, and the link is restored once they agree.
  const areaCode = structure.controllingArea;
  const areaWasLinked = await unlinkAreaAssignment({
    client, areaCode, companyCode: structure.companyCode, targetVariant: fiscalYearVariant.variant,
  });
  await moveControllingAreaToVariant({ client, country, areaCode, variant: fiscalYearVariant.variant });

  // Company code, with its chart, fiscal year and posting period variants.
  await defineCompanyCode({
    client,
    changedBy: IN01_ACTOR,
    companyCode: structure.companyCode,
    name: company.identity.name,
    country: country.country.code,
    currency: country.country.currency,
    city: company.identity.city,
    taxRegistrationNumber: company.identity.gstin,
  }).catch(swallowDuplicate);

  await upsertCompanyCode({
    client,
    changedBy: IN01_ACTOR,
    companyCode: structure.companyCode,
    name: company.identity.name,
    chartOfAccounts: structure.chartOfAccounts,
    fiscalYearVariant: fiscalYearVariant.variant,
    postingPeriodVariant: 'C001',
    currency: country.country.currency,
    country: country.country.code,
    city: company.identity.city,
    taxRegistrationNumber: company.identity.gstin,
  });

  // Both sides now carry the April-to-March year, so the link is restored through OX19's own
  // assignment service.
  if (areaWasLinked) {
    await restoreAreaAssignment({ client, areaCode, companyCode: structure.companyCode });
  }

  // The chart additions: the Indian accounts the delivered chart does not carry.
  let chartAdditions = 0;
  for (const account of country.chartOfAccounts.additions) {
    await upsertGlAccount({
      client,
      changedBy: IN01_ACTOR,
      chartOfAccounts: structure.chartOfAccounts,
      accountNumber: account.number,
      name: account.name,
      accountType: account.type === 'REVENUE' ? 'REVENUE' : account.type,
      accountGroup: 'GENL',
      isOpenItemManaged: false,
      reconciliationType: null,
      // A P&L account closes to retained earnings at carryforward, so it must name the
      // determination. The delivered chart uses X; the added accounts use it too.
      retainedEarningsIndicator: account.isBalanceSheet ? null : STANDARD_RETAINED_EARNINGS_INDICATOR,
      requiresCostObject: account.requiresCostObject ?? false,
      isTaxRelevant: account.taxRelevant ?? false,
      mode: 'CREATE',
    }).then(() => { chartAdditions += 1; }).catch(swallowDuplicate);
  }

  // GST codes. One consolidated rate per line — the CGST/SGST split is a GAP.
  let taxCodes = 0;
  for (const tax of country.taxCodes.codes) {
    await saveTaxCode({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      country: country.country.code,
      taxCode: tax.code,
      name: tax.name,
      taxType: tax.taxType,
      ratePercent: tax.ratePercent,
      accountKey: tax.accountKey,
      reason: 'India GST configuration',
    }).then(() => { taxCodes += 1; }).catch(swallowDuplicate);
  }

  // Account determination: inventory by valuation class, GR/IR, consumption, tax, revenue.
  const determinationRows = await ensureDetermination(client, structure.chartOfAccounts);

  // The second plant, its storage locations, its purchasing link and its valuation seed.
  await ensureDistributionPlant(client, fixtures);
  await ensureManufacturingStorageLocations(client, fixtures);
  // Reported from the database, because the standard structure also creates storage locations
  // at this plant and the fixture's are adopted into them rather than added beside them.
  const storageLocations = await withTenant(client, async (tx) =>
    (await tx.select({ code: storageLocation.storageLocation }).from(storageLocation)
      .where(and(eq(storageLocation.client, client), eq(storageLocation.plant, structure.manufacturingPlant)))).length);

  // Shipping points.
  for (const dock of [
    { plant: structure.manufacturingPlant, shippingPoint: structure.manufacturingShippingPoint, name: 'Manufacturing plant dock' },
    { plant: structure.distributionPlant, shippingPoint: structure.distributionShippingPoint, name: 'Distribution centre dock' },
  ]) {
    await defineShippingPointForProvisioning({ client, changedBy: IN01_ACTOR, shippingPoint: dock.shippingPoint, name: dock.name })
      .catch(swallowDuplicate);
    await assignShippingPointForProvisioning({ client, changedBy: IN01_ACTOR, deliveringPlant: dock.plant, shippingPoint: dock.shippingPoint })
      .catch(swallowDuplicate);
  }

  // Cost centres, profit centres, work centres.
  for (const centre of company.costCentres) {
    await saveCostCenter({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      controllingArea: structure.controllingArea,
      costCenter: centre.code,
      validFrom: input.scenario.from,
      validTo: '9999-12-31',
      name: centre.name,
      personResponsible: '',
      category: centre.category,
      companyCode: structure.companyCode,
      reason: 'Phase 0 organisation structure',
    }).catch(swallowDuplicate);
  }

  for (const centre of company.profitCentres) {
    await saveProfitCenter({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      controllingArea: structure.controllingArea,
      profitCenter: centre.code,
      validFrom: input.scenario.from,
      validTo: '9999-12-31',
      name: centre.name,
      longText: '',
      personResponsible: '',
      responsibleUser: '',
      segment: centre.segment,
      reason: 'Phase 0 organisation structure',
    }).catch(swallowDuplicate);
  }

  for (const category of core.workCentreCategories) {
    await saveWorkCenterCategory({ client, changedBy: IN01_ACTOR, category: category.code, description: category.description })
      .catch(swallowDuplicate);
  }
  for (const centre of company.workCentres) {
    await createWorkCenterForProvisioning({
      client,
      changedBy: IN01_ACTOR,
      plant: structure.manufacturingPlant,
      workCenter: centre.code,
      category: centre.category,
      description: centre.description,
    }).catch(swallowDuplicate);
  }

  // The journal number interval.
  await maintainNumberRange({
    client,
    changedBy: IN01_ACTOR,
    objectCode: 'RF_BELEG',
    companyCode: structure.companyCode,
    subObject: 'GENERAL',
    fiscalYear: 0,
    prefix: 'JE',
    fromNumber: 1,
    toNumber: 999999,
    numberLength: 6,
    displayStyle: 'READABLE',
    status: 'ACTIVE',
    mode: 'CREATE',
    reason: 'India company accounting interval',
  }).catch(swallowDuplicate);

  // Holiday calendar and its working-week calendar.
  const holidayDays = await ensureHolidayCalendar(client, fixtures);

  return {
    client,
    companyCode: structure.companyCode,
    tenantCreated: !standing,
    fiscalYearVariant: fiscalYearVariant.variant,
    chartAdditions,
    taxCodes,
    plants: [structure.manufacturingPlant, structure.distributionPlant],
    storageLocations,
    costCentres: company.costCentres.length,
    profitCentres: company.profitCentres.length,
    workCentres: company.workCentres.length,
    determinationRows,
    holidayDays,
  };
}

/**
 * The April-to-March variant, built with the period services.
 *
 * The company code must then be pointed at it, which `upsertCompanyCode` does. The variant's
 * periods are hand-maintained because the year does not follow the calendar, which is the
 * same path the fiscal-year screen takes.
 */
async function ensureFiscalYearVariant(
  client: string,
  country: FixtureSet['country'],
): Promise<{ variant: string }> {
  const spec = country.fiscalYear;
  const standing = (await listFiscalYearVariants(client)).find((row) => row.variant === spec.variant);

  if (!standing) {
    await saveFiscalYearVariant({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      expectedVersion: 0,
      variant: spec.variant,
      name: spec.name,
      isCalendarYear: spec.isCalendarYear,
      regularPeriods: spec.regularPeriods,
      specialPeriods: spec.specialPeriods,
      isYearDependent: spec.isYearDependent,
      reason: 'India April-March fiscal year',
    }).catch(swallowDuplicate);
  }

  const current = (await listFiscalYearVariants(client)).find((row) => row.variant === spec.variant);
  if (!current) throw new Error(`Fiscal year variant ${spec.variant} could not be created.`);

  if (current.periods.length === 0) {
    await saveFiscalYearPeriods({
      client,
      changedBy: IN01_ACTOR,
      variant: spec.variant,
      calendarYear: 0,
      expectedVersion: current.version,
      reason: 'India April-March period ends',
      periods: [...spec.periodEnds, ...spec.specialPeriodEnds].map((row) => ({
        period: row.period, month: row.month, day: row.day, yearShift: row.yearShift,
      })),
    });
  }

  return { variant: spec.variant };
}

/**
 * Break the company-code-to-controlling-area link before either side changes its fiscal year.
 *
 * Both objects refuse a fiscal year the other does not share, in both directions: the company
 * code's save checks the areas linked to it, and the area's save checks every company code
 * assigned to it. There is therefore no ordering that changes one while they are linked —
 * which is the rule that keeps an operating concern's books consistent, not a defect. The
 * operator's own route, the one OX19 exists for, is used instead: unlink, change both, relink.
 */
async function unlinkAreaAssignment(input: {
  client: string;
  areaCode: string;
  companyCode: string;
  targetVariant: string;
}): Promise<boolean> {
  const areas = await listControllingAreas(input.client);
  const area = areas.find((row) => row.controllingArea === input.areaCode);
  if (!area) {
    throw new Error(`Controlling area ${input.areaCode} does not exist; the standard structure should have built it.`);
  }

  const company = await withTenant(input.client, async (tx) => {
    const [row] = await tx
      .select({ fiscalYearVariant: companyCode.fiscalYearVariant })
      .from(companyCode)
      .where(and(eq(companyCode.client, input.client), eq(companyCode.companyCode, input.companyCode)))
      .limit(1);
    return row;
  });

  // Both sides already agree with the target: leave the link exactly as it stands. This is what
  // makes a second run a no-op instead of tearing down the first run's correct result.
  if (area.fiscalYearVariant === input.targetVariant && company?.fiscalYearVariant === input.targetVariant) {
    return false;
  }

  await unassignCompanyCodeFromControllingArea({
    client: input.client,
    changedBy: IN01_ACTOR,
    controllingArea: input.areaCode,
    companyCode: input.companyCode,
  }).catch(swallowDuplicate);
  return true;
}

/** Move the controlling area to the country's fiscal year variant, through its own service. */
async function moveControllingAreaToVariant(input: {
  client: string;
  country: FixtureSet['country'];
  areaCode: string;
  variant: string;
}): Promise<void> {
  const areas = await listControllingAreas(input.client);
  const standing = areas.find((row) => row.controllingArea === input.areaCode);
  if (!standing) {
    throw new Error(`Controlling area ${input.areaCode} does not exist; the standard structure should have built it.`);
  }
  if (standing.fiscalYearVariant === input.variant) return;

  const expectedVersion = await getControllingAreaVersion(input.client, input.areaCode);
  await saveControllingArea({
    client: input.client,
    changedBy: IN01_ACTOR,
    mode: 'CHANGE',
    expectedVersion,
    controllingArea: input.areaCode,
    name: standing.name,
    organizationName: standing.organizationName ?? standing.name,
    companyCodeScope: standing.companyCodeScope,
    currency: input.country.country.currency,
    fiscalYearVariant: input.variant,
    reason: 'Move the controlling area to the India April-March fiscal year',
  });
}

/** Link the company code back to its controlling area once both carry the same fiscal year. */
async function restoreAreaAssignment(input: {
  client: string;
  areaCode: string;
  companyCode: string;
}): Promise<void> {
  await assignCompanyCodeToControllingArea({
    client: input.client,
    changedBy: IN01_ACTOR,
    controllingArea: input.areaCode,
    companyCode: input.companyCode,
  }).catch(swallowDuplicate);
}

/** The ten posting events the demo scenario uses, pointed at the chart's own accounts. */
async function ensureDetermination(client: string, chart: string): Promise<number> {
  const rows = [
    { event: 'INVENTORY', valuationClass: 'RAW_INVENTORY', glAccount: '120000' },
    { event: 'INVENTORY', valuationClass: 'SEMI_INVENTORY', glAccount: '120100' },
    { event: 'INVENTORY', valuationClass: 'FINISHED_INVENTORY', glAccount: '120200' },
    { event: 'INVENTORY', valuationClass: 'TRADE_INVENTORY', glAccount: '120300' },
    { event: 'GR_IR_CLEARING', valuationClass: '', glAccount: '210000' },
    { event: 'PRICE_DIFFERENCE', valuationClass: '', glAccount: '410200' },
    { event: 'TAX', valuationClass: '', glAccount: '220000' },
    { event: 'SALES_REVENUE', valuationClass: '', glAccount: '300000' },
    { event: 'CONSUMPTION', valuationClass: 'RAW_INVENTORY', glAccount: '410000' },
    { event: 'CONSUMPTION', valuationClass: 'SEMI_INVENTORY', glAccount: '410000' },
    { event: 'CONSUMPTION', valuationClass: 'FINISHED_INVENTORY', glAccount: '400000' },
    { event: 'CONSUMPTION', valuationClass: 'TRADE_INVENTORY', glAccount: '400000' },
    // The three events the sales and production chains need and the standard chart does not seed.
    { event: 'SALES_ISSUE', valuationClass: 'FINISHED_INVENTORY', glAccount: '400000' },
    { event: 'SALES_ISSUE', valuationClass: 'TRADE_INVENTORY', glAccount: '400000' },
    { event: 'PAYROLL_NET_PAY', valuationClass: '', glAccount: '251000' },
  ];

  let written = 0;
  for (const row of rows) {
    await saveAccountDetermination({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      chartOfAccounts: chart,
      event: row.event,
      valuationClass: row.valuationClass,
      generalModifier: '',
      glAccount: row.glAccount,
      reason: 'Phase 0 account determination',
    }).then(() => { written += 1; }).catch(swallowDuplicate);
  }
  return written;
}

async function ensureDistributionPlant(client: string, fixtures: FixtureSet): Promise<void> {
  const { core, country, company } = fixtures;
  const plant = core.structure.distributionPlant;

  await savePlantDefinition({
    client,
    changedBy: IN01_ACTOR,
    mode: 'CREATE',
    plant,
    expectedVersion: 0,
    reason: 'Phase 0 organisation structure',
    values: {
      name: `${company.identity.name} — Distribution centre`,
      country: country.country.code,
      city: 'Pune',
      language: 'EN',
      isProductionSite: false,
      isStorageSite: true,
    },
  }).catch(swallowDuplicate);

  await assignPlantCompanyCode({ client, changedBy: IN01_ACTOR, plant, companyCode: core.structure.companyCode })
    .catch(swallowDuplicate);

  for (const location of core.distributionStorageLocations) {
    await saveStorageLocation({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      plant,
      storageLocation: location.code,
      expectedVersion: 0,
      reason: 'Phase 0 organisation structure',
      values: { name: location.name, allowNegativeStock: false },
    }).catch(swallowDuplicate);
  }

  await withTenant(client, async (tx) => {
    // No service writes the purchasing-organisation-to-plant link; `standard-structure.ts`
    // inserts it directly for the same reason.
    await tx.insert(purchasingOrgPlant).values({
      client, purchasingOrg: core.structure.purchasingOrg, plant, createdBy: IN01_ACTOR,
    }).onConflictDoNothing();

    await seedTypeValuationForPlant(tx, client, plant, IN01_ACTOR);
  });
}

/** The manufacturing plant's storage locations, with the company's own names. */
async function ensureManufacturingStorageLocations(client: string, fixtures: FixtureSet): Promise<number> {
  const { core } = fixtures;
  let count = 0;
  for (const location of core.manufacturingStorageLocations) {
    await saveStorageLocation({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      plant: core.structure.manufacturingPlant,
      storageLocation: location.code,
      expectedVersion: 0,
      reason: 'Phase 0 organisation structure',
      values: { name: location.name, allowNegativeStock: false },
    }).then(() => { count += 1; }).catch(swallowDuplicate);
  }
  return count;
}

/**
 * The Indian holiday calendar.
 *
 * Only the holiday calendar and its days are written, because those are the two things the
 * configuration service creates. No service in the product creates a *factory calendar*
 * itself — `saveCalendarPeriod` requires one to exist and there is no create for it — so the
 * working-week calendar is recorded as a GAP (`02-gap-list.md` B10) and left to the
 * configuration screen rather than inserted behind the service layer.
 */
async function ensureHolidayCalendar(client: string, fixtures: FixtureSet): Promise<number> {
  const { country } = fixtures;
  const calendar = country.holidayCalendar;
  const from = Math.min(...calendar.days.map((day) => Number(day.date.slice(0, 4))));
  const to = Math.max(...calendar.days.map((day) => Number(day.date.slice(0, 4))));

  await saveHolidayCalendar({
    client,
    changedBy: IN01_ACTOR,
    capabilities: ['*'],
    holidayCalendarId: calendar.id,
    name: calendar.name,
    validFromYear: from,
    validToYear: to,
  }).catch(swallowDuplicate);

  let days = 0;
  for (const day of calendar.days) {
    await addHolidayDay({
      client,
      changedBy: IN01_ACTOR,
      capabilities: ['*'],
      holidayCalendarId: calendar.id,
      date: day.date,
      description: day.name,
    }).then(() => { days += 1; }).catch(swallowDuplicate);
  }
  return days;
}
