/**
 * The standard enterprise structure for a tenant, built on demand.
 *
 * Why this module exists. Tenant creation used to hand every new tenant a company
 * structure as a side effect of the standard package: a company code, a controlling
 * area, a plant with storage locations, a purchasing organisation and a sales
 * organisation, all named after the tenant and all keyed to one company code. That
 * is not how the configuration screens work — each of those objects has its own
 * screen and its own guards — and it left an empty tenant unable to exist at all.
 * The package is being reduced to data that is true for any company (charts, fiscal
 * year variants, posting period variants, document types, distribution channels,
 * divisions, purchasing groups, material types, payment terms), and this builder
 * takes over the company-specific half so that fixtures and browser targets keep the
 * structure they were written against.
 *
 * Two rules it holds itself to:
 *
 * 1. It reproduces exactly the rows the standard package used to write, with the
 *    same keys, names and defaults. It adds nothing and omits nothing, so that a
 *    tenant built here is indistinguishable from one built by the old package.
 * 2. It is existence-tolerant. Every write is `onConflictDoNothing`, and the central
 *    address is only allocated when the sales organisation is genuinely new, so
 *    calling this on a tenant that already has the structure is a no-op that reports
 *    `created: false`. That is what lets it be wired into fixtures before the package
 *    stops writing structure: today it finds the rows already there and does nothing.
 *
 * The rows are inserted directly rather than through the configuration services
 * because the services enforce what a person at a screen must supply — a reason for
 * every change, a version to compare against, retirement guards — and a fixture has
 * none of those to give. Four of these objects (the credit control area, the
 * purchasing organisation to plant link, the sales organisation text and the sales
 * organisation address) have no service at all.
 */

import {
  companyCode,
  controllingArea,
  creditControlArea,
  plant,
  purchasingOrg,
  purchasingOrgPlant,
  salesArea,
  salesOrg,
  salesOrgDistributionChannel,
  salesOrgDivision,
  salesOrgText,
  storageLocation,
} from '../../modules/foundation/schema';
import { createCentralAddress } from '../../modules/foundation/central-address-maintenance';
import { withTenant, type Tx } from '../db/client';
import { eq, and } from 'drizzle-orm';

/** The keys this builder uses. They are the keys the standard package used. */
export const STANDARD_STRUCTURE = {
  companyCode: '1000',
  controllingArea: 'A000',
  creditControlArea: '0001',
  plant: '1000',
  purchasingOrg: '1000',
  salesOrg: '1000',
  distributionChannel: '01',
  division: '01',
  intercompanyClearingAccount: '110100',
} as const;

const STANDARD_STORAGE_LOCATIONS: ReadonlyArray<{ code: string; name: string }> = [
  { code: '0001', name: 'Raw materials store' },
  { code: '0002', name: 'Production floor' },
  { code: '0003', name: 'Finished goods warehouse' },
  { code: '0099', name: 'Goods receipt area' },
];

export interface StandardStructureInput {
  /** Tenant the structure belongs to. */
  client: string;
  /**
   * Company code the structure hangs from, `1000` unless the caller says otherwise.
   * Fixtures that test a second company code pass their own, and the plant, purchasing
   * organisation and sales organisation are linked to whatever is given here.
   */
  companyCode?: string;
  /** Display name used to derive the plant and purchasing organisation names. */
  companyName: string;
  /** Two-character country, `KW` unless the fixture says otherwise. */
  country?: string;
  /** Currency for the company code, controlling area and sales organisation. */
  currency?: string;
  city?: string | null;
  /** Chart of accounts to link. Must already exist — the package provides `CA01`. */
  chartOfAccounts?: string;
  /** Fiscal year variant to link. Must already exist — the package provides `K4`. */
  fiscalYearVariant?: string;
  /** Posting period variant to link. Must already exist — the package provides `C001`. */
  postingPeriodVariant?: string;
  /** Recorded as `created_by` / `changed_by` on every row. */
  changedBy: string;
}

export interface StandardStructureResult {
  client: string;
  /** The company code the structure was built from. */
  companyCode: string;
  controllingArea: string;
  creditControlArea: string;
  plant: string;
  purchasingOrg: string;
  salesOrg: string;
  salesArea: { salesOrg: string; distributionChannel: string; division: string };
  storageLocations: number;
  /** False when the company code was already there and nothing was written. */
  created: boolean;
}

/**
 * Build the standard enterprise structure for a tenant.
 *
 * Safe to call more than once: an existing company code makes the whole call a
 * no-op. Run it inside the caller's transaction with `applyStandardStructureInTransaction`
 * when the structure has to land atomically with something else.
 */
export async function applyStandardStructure(
  input: StandardStructureInput,
): Promise<StandardStructureResult> {
  return withTenant(input.client, (tx) => applyStandardStructureInTransaction(tx, input));
}

/** Transaction-scoped form of {@link applyStandardStructure}. */
export async function applyStandardStructureInTransaction(
  tx: Tx,
  input: StandardStructureInput,
): Promise<StandardStructureResult> {
  const client = input.client;
  const changedBy = input.changedBy;
  const company = input.companyCode ?? STANDARD_STRUCTURE.companyCode;
  const country = input.country ?? 'KW';
  const currency = input.currency ?? 'KWD';
  const city = input.city ?? null;
  const chart = input.chartOfAccounts ?? 'CA01';
  const fyv = input.fiscalYearVariant ?? 'K4';
  const ppv = input.postingPeriodVariant ?? 'C001';

  const existing = await tx
    .select({ companyCode: companyCode.companyCode })
    .from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, company)))
    .limit(1);

  const result: StandardStructureResult = {
    client,
    companyCode: company,
    controllingArea: STANDARD_STRUCTURE.controllingArea,
    creditControlArea: STANDARD_STRUCTURE.creditControlArea,
    plant: STANDARD_STRUCTURE.plant,
    purchasingOrg: STANDARD_STRUCTURE.purchasingOrg,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    salesArea: {
      salesOrg: STANDARD_STRUCTURE.salesOrg,
      distributionChannel: STANDARD_STRUCTURE.distributionChannel,
      division: STANDARD_STRUCTURE.division,
    },
    storageLocations: STANDARD_STORAGE_LOCATIONS.length,
    created: existing.length === 0,
  };

  if (!result.created) {
    return result;
  }

  await tx.insert(creditControlArea).values({
    client,
    creditControlArea: STANDARD_STRUCTURE.creditControlArea,
    name: 'Standard credit control area',
    currency,
    warningThresholdPercent: 90,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(companyCode).values({
    client,
    companyCode: company,
    name: input.companyName,
    chartOfAccounts: chart,
    fiscalYearVariant: fyv,
    postingPeriodVariant: ppv,
    currency,
    country,
    city,
    creditControlArea: STANDARD_STRUCTURE.creditControlArea,
    intercompanyClearingAccount: STANDARD_STRUCTURE.intercompanyClearingAccount,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(controllingArea).values({
    client,
    controllingArea: STANDARD_STRUCTURE.controllingArea,
    name: 'Standard controlling area',
    companyCodeScope: 'SINGLE',
    currency,
    fiscalYearVariant: fyv,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(plant).values({
    client,
    plant: STANDARD_STRUCTURE.plant,
    name: `${input.companyName} — Main plant`,
    companyCode: company,
    country,
    city,
    isProductionSite: true,
    isStorageSite: true,
    defaultStorageLocation: '0001',
    createdBy: changedBy,
  }).onConflictDoNothing();

  for (const location of STANDARD_STORAGE_LOCATIONS) {
    await tx.insert(storageLocation).values({
      client,
      plant: STANDARD_STRUCTURE.plant,
      storageLocation: location.code,
      name: location.name,
      allowNegativeStock: false,
      createdBy: changedBy,
    }).onConflictDoNothing();
  }

  await tx.insert(purchasingOrg).values({
    client,
    purchasingOrg: STANDARD_STRUCTURE.purchasingOrg,
    name: `${input.companyName} — Purchasing`,
    companyCode: company,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(purchasingOrgPlant).values({
    client,
    purchasingOrg: STANDARD_STRUCTURE.purchasingOrg,
    plant: STANDARD_STRUCTURE.plant,
    createdBy: changedBy,
  }).onConflictDoNothing();

  const salesOrgExists = await tx
    .select({ salesOrg: salesOrg.salesOrg })
    .from(salesOrg)
    .where(and(eq(salesOrg.client, client), eq(salesOrg.salesOrg, STANDARD_STRUCTURE.salesOrg)))
    .limit(1);

  if (salesOrgExists.length === 0) {
    // Only a genuinely new sales organisation may allocate an address: the address
    // table has no natural key to conflict on, so a second call would otherwise
    // leave an orphaned address row behind every time.
    const addressNumber = await createCentralAddress(tx, client, changedBy, { country });
    await tx.insert(salesOrg).values({
      client,
      salesOrg: STANDARD_STRUCTURE.salesOrg,
      addressNumber,
      companyCode: company,
      currency,
      createdBy: changedBy,
    }).onConflictDoNothing();
  }

  await tx.insert(salesOrgText).values({
    client,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    languageKey: 'E',
    name: 'Standard Sales',
    formText: 'STANDARD',
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(salesOrgDistributionChannel).values({
    client,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    distributionChannel: STANDARD_STRUCTURE.distributionChannel,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(salesOrgDivision).values({
    client,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    division: STANDARD_STRUCTURE.division,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await tx.insert(salesArea).values({
    client,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    distributionChannel: STANDARD_STRUCTURE.distributionChannel,
    division: STANDARD_STRUCTURE.division,
    name: 'Direct sales — manufactured products',
    createdBy: changedBy,
  }).onConflictDoNothing();

  return result;
}
