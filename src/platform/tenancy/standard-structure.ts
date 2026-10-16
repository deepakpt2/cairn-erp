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
 * Most rows are inserted directly rather than through the configuration services,
 * because the services enforce what a person at a screen must supply — a reason for
 * every change, a version to compare against, retirement guards — and a fixture has
 * none of those to give. Four of these objects (the credit control area, the
 * purchasing organisation to plant link, the sales organisation text and the sales
 * organisation address) have no service at all.
 *
 * Two things are deliberately *not* direct inserts, because the package did not write
 * them directly either and a snapshot comparison says so. The controlling area to
 * company code link goes through `assignCompanyCodeToControllingAreaInTransaction`,
 * which validates the chart of accounts against the area's existing assignments and
 * records its own change document; and the two sales organisation assignment links and
 * the sales area each get a change document from `recordChange`, exactly as the package
 * gave them. Omitting either would leave a fixture tenant with rows the old package
 * provided and the new one does not.
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
import { assignCompanyCodeToControllingAreaInTransaction } from '../../modules/foundation/controlling-area-company-assignment';
import { recordChange } from '../change';
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

  // The package created this link through the OX19 service rather than by insert, and
  // the service records a change document and checks the company code's chart against
  // the area's other assignments. Calling it keeps both.
  await assignCompanyCodeToControllingAreaInTransaction(tx, {
    client,
    changedBy,
    controllingArea: STANDARD_STRUCTURE.controllingArea,
    companyCode: company,
  });

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

  await recordChange(tx, {
    client,
    objectClass: 'sales_org_distribution_channel',
    objectKey: `${STANDARD_STRUCTURE.salesOrg}/${STANDARD_STRUCTURE.distributionChannel}`,
    changeType: 'CREATE',
    changedBy,
    transactionCode: 'CFG.ORG.SALESORG.ASSIGN_DISTCHANNEL',
    after: {
      salesOrg: STANDARD_STRUCTURE.salesOrg,
      distributionChannel: STANDARD_STRUCTURE.distributionChannel,
    },
    securityRelevantFields: ['salesOrg', 'distributionChannel'],
    fieldLabels: {
      salesOrg: 'Sales Organization',
      distributionChannel: 'Distribution Channel',
    },
  });

  await tx.insert(salesOrgDivision).values({
    client,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    division: STANDARD_STRUCTURE.division,
    createdBy: changedBy,
  }).onConflictDoNothing();

  await recordChange(tx, {
    client,
    objectClass: 'sales_org_division',
    objectKey: `${STANDARD_STRUCTURE.salesOrg}/${STANDARD_STRUCTURE.division}`,
    changeType: 'CREATE',
    changedBy,
    transactionCode: 'CFG.ORG.SALESORG.ASSIGN_DIVISION',
    after: { salesOrg: STANDARD_STRUCTURE.salesOrg, division: STANDARD_STRUCTURE.division },
    securityRelevantFields: ['salesOrg', 'division'],
    fieldLabels: {
      salesOrg: 'Sales Organization',
      division: 'Division',
    },
  });

  await tx.insert(salesArea).values({
    client,
    salesOrg: STANDARD_STRUCTURE.salesOrg,
    distributionChannel: STANDARD_STRUCTURE.distributionChannel,
    division: STANDARD_STRUCTURE.division,
    name: 'Direct sales — manufactured products',
    createdBy: changedBy,
  }).onConflictDoNothing();

  await recordChange(tx, {
    client,
    objectClass: 'sales_area',
    objectKey: `${STANDARD_STRUCTURE.salesOrg}/${STANDARD_STRUCTURE.distributionChannel}/${STANDARD_STRUCTURE.division}`,
    changeType: 'CREATE',
    changedBy,
    transactionCode: 'CFG.ORG.SALESAREA.DEFINE',
    after: {
      salesOrg: STANDARD_STRUCTURE.salesOrg,
      distributionChannel: STANDARD_STRUCTURE.distributionChannel,
      division: STANDARD_STRUCTURE.division,
      name: 'Direct sales — manufactured products',
      isActive: true,
    },
    securityRelevantFields: ['salesOrg', 'distributionChannel', 'division', 'isActive'],
    fieldLabels: {
      salesOrg: 'Sales Organization',
      distributionChannel: 'Distribution Channel',
      division: 'Division',
      name: 'Sales Area Name',
      isActive: 'Active',
    },
  });

  return result;
}
