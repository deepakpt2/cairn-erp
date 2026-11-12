/**
 * The demo company's enterprise structure — provisioning phase `B_ORGANISATION`.
 *
 * One fictional company: one company code, two plants, and the storage locations,
 * purchasing and sales organisations, cost and profit centres and work centres a
 * company needs before a single document can be posted.
 *
 * Everything here is created through the same services the configuration screens
 * call, with two deliberate exceptions, and both are recorded where they happen.
 * The exceptions are rows no service writes — the purchasing organisation to plant
 * link and the plant's type valuation seed — which `standard-structure.ts` also
 * writes directly, for the same reason.
 *
 * The tenant is adopted rather than recreated when one already stands: a run that
 * died after this phase finished and before the next began resumes into the
 * company it already built instead of refusing on a name it gave itself.
 */

import { sql, withTenant, type Tx } from '../db/client';
import { createTenant, listTenants } from './index';
import { applyStandardStructure } from './standard-structure';
import { assignPlantCompanyCode } from '../../modules/foundation/plant-company-code-assignment';
import { savePlantDefinition } from '../../modules/foundation/plant-maintenance';
import { saveStorageLocation } from '../../modules/foundation/storage-location-maintenance';
import { saveCostCenter } from '../../modules/foundation/cost-center-definition';
import { saveProfitCenter } from '../../modules/foundation/profit-center-definition';
import { purchasingOrgPlant } from '../../modules/foundation/schema';
import { maintainNumberRange } from '../../modules/foundation/number-ranges';
import { createWorkCenter, saveWorkCenterCategory } from '../../modules/production/work-center';
import { assignShippingPoint, defineShippingPoint } from '../../modules/sales/shipping-point-maintenance';
import { seedTypeValuationForPlant } from '../../modules/inventory/standard-config';
import type { DemoTimeline } from './demo-provisioning';

/** Recorded as `created_by` on every row this module writes. */
export const DEMO_ACTOR = 'DEMO_PROVISION';

/**
 * The fictional company.
 *
 * A made-up name, a made-up legal form, and a currency and country the deployment
 * actually runs in. Nothing here resembles a real undertaking, and the credential
 * report says so at the top.
 */
export const DEMO_IDENTITY = {
  clientKey: 'DMO1',
  name: 'Vantage Foods',
  legalName: 'Vantage Foods Manufacturing and Trading WLL',
  country: 'KW',
  currency: 'KWD',
  timezone: 'Asia/Kuwait',
  language: 'EN',
} as const;

/**
 * The enterprise structure keys.
 *
 * They are the standard keys, because every screen, report and test in the product
 * is written against them and a demo that invented its own numbering would be a
 * demo that could not use the product. The second plant is the one addition.
 */
export const DEMO_STRUCTURE = {
  companyCode: '1000',
  companyName: 'Vantage Foods',
  /** The plant the standard structure builds: where the goods are made. */
  manufacturingPlant: '1000',
  /** The plant this module adds: where the finished goods are held and shipped. */
  distributionPlant: '2000',
  purchasingOrg: '1000',
  salesOrg: '1000',
  distributionChannel: '01',
  division: '01',
  controllingArea: 'A000',
  creditControlArea: '0001',
  shippingPoint: '1000',
  distributionShippingPoint: '2000',
} as const;

/**
 * The two administrator accounts the tenant is created with.
 *
 * `createTenant` makes both in one transaction, and it has to: `ADMINISTRATOR` is a
 * protected role, so the moment the tenant exists is the only moment the working
 * administrator can be given it. The platform administrator is the actor this
 * provisioner then signs in as, because user creation and role administration are
 * its job and nobody else's.
 */
export const DEMO_FOUNDER_ACCOUNTS = {
  platformAdmin: {
    username: 'demo.owner',
    fullName: 'Demo Platform Administrator',
    email: 'owner@vantage-demo.test',
  },
  administrator: {
    username: 'demo.admin',
    fullName: 'Demo Administrator',
    email: 'admin@vantage-demo.test',
  },
} as const;

/** Storage locations for the distribution plant. The manufacturing plant keeps the standard four. */
const DISTRIBUTION_STORAGE_LOCATIONS = [
  { code: '0001', name: 'Finished goods hall' },
  { code: '0002', name: 'Dispatch bay' },
  { code: '0099', name: 'Goods receipt area' },
] as const;

/**
 * Cost centres, by what the money is spent on rather than by who spends it.
 *
 * Every one is valid from the first day of the timeline, because a cost centre that
 * starts after the first posting is a posting that has nowhere to go.
 */
const COST_CENTRES = [
  { code: 'CC1000', name: 'Mixing', category: 'PRODUCTION' },
  { code: 'CC1010', name: 'Packing', category: 'PRODUCTION' },
  { code: 'CC2000', name: 'Warehousing', category: 'SERVICE' },
  { code: 'CC3000', name: 'Procurement', category: 'SUPPORT' },
  { code: 'CC4000', name: 'Sales', category: 'SALES' },
  { code: 'CC5000', name: 'Administration', category: 'ADMINISTRATION' },
  { code: 'CC6000', name: 'Quality', category: 'SERVICE' },
] as const;

/** Profit centres: what the company sells, split by whether it made it. */
const PROFIT_CENTRES = [
  { code: 'PC1000', name: 'Manufactured', segment: 'FOOD' },
  { code: 'PC2000', name: 'Traded goods', segment: 'FOOD' },
] as const;

/**
 * Work centre categories.
 *
 * Nothing seeds these — a tenant that has never opened the work centre screen has
 * none — and `createWorkCenter` refuses a category it cannot find. So the demo
 * defines the two it uses before it uses them.
 */
const WORK_CENTRE_CATEGORIES = [
  { code: 'MACH', description: 'Machine' },
  { code: 'LINE', description: 'Production line' },
] as const;

/** Work centres at the manufacturing plant. */
const WORK_CENTRES = [
  { code: 'WC01', description: 'Mixing line', category: 'MACH' },
  { code: 'WC02', description: 'Packing line', category: 'LINE' },
] as const;

export interface DemoOrganisationResult {
  client: string;
  companyCode: string;
  plants: string[];
  storageLocations: number;
  costCentres: number;
  profitCentres: number;
  workCentres: number;
  /** True when the tenant was created by this call; false when an earlier run's was adopted. */
  tenantCreated: boolean;
}

export interface BuildDemoOrganisationInput {
  /**
   * The shared demo password. Used for the two accounts the tenant is created with;
   * it is hashed by `createTenant` and never stored anywhere in the clear.
   */
  password: string;
  timeline: DemoTimeline;
}

/**
 * Build the demo company's enterprise structure.
 *
 * Idempotent in the way a resumed run needs: an existing `DMO1` tenant is adopted,
 * and every structural write that follows is either existence-tolerant or a service
 * call that refuses a duplicate, so a second pass over this phase changes nothing.
 */
export async function buildDemoOrganisation(
  input: BuildDemoOrganisationInput,
): Promise<DemoOrganisationResult> {
  const standing = (await listTenants()).find((tenant) => tenant.client === DEMO_IDENTITY.clientKey);

  if (!standing) {
    await createTenant({
      clientKey: DEMO_IDENTITY.clientKey,
      name: DEMO_IDENTITY.name,
      legalName: DEMO_IDENTITY.legalName,
      country: DEMO_IDENTITY.country,
      currency: DEMO_IDENTITY.currency,
      timezone: DEMO_IDENTITY.timezone,
      language: DEMO_IDENTITY.language,
      // A demo tenant is a company, not a fixture. It is not marked as development
      // data, because the point of it is that it behaves like the real thing.
      isDevelopment: false,
      administrator: { ...DEMO_FOUNDER_ACCOUNTS.platformAdmin, password: input.password },
      tenantAdministrator: { ...DEMO_FOUNDER_ACCOUNTS.administrator, password: input.password },
      // The standard package supplies what is true of any company: the chart of
      // accounts, the fiscal year variant, the posting period rules, the document
      // types, the payment terms. This module adds what is true of this one.
      creationType: 'standard',
      createdBy: DEMO_ACTOR,
    });
  }

  const client = DEMO_IDENTITY.clientKey;
  const company = DEMO_STRUCTURE.companyCode;

  await applyStandardStructure({
    client,
    companyCode: company,
    companyName: DEMO_STRUCTURE.companyName,
    country: DEMO_IDENTITY.country,
    currency: DEMO_IDENTITY.currency,
    changedBy: DEMO_ACTOR,
  });

  // The company's own journal number range. `createTenant` defines the operational
  // ranges; the accounting interval is the company's to declare, and without it the
  // first posting has no number to take.
  await ensureJournalRange(client, company);

  await ensureSecondPlant(client, company);

  for (const centre of COST_CENTRES) {
    await saveCostCenter({
      client,
      changedBy: DEMO_ACTOR,
      mode: 'CREATE',
      controllingArea: DEMO_STRUCTURE.controllingArea,
      costCenter: centre.code,
      validFrom: input.timeline.startDate,
      validTo: '9999-12-31',
      name: centre.name,
      personResponsible: '',
      category: centre.category,
      companyCode: company,
      reason: 'Demo company structure',
    }).catch(swallowDuplicate);
  }

  for (const centre of PROFIT_CENTRES) {
    await saveProfitCenter({
      client,
      changedBy: DEMO_ACTOR,
      mode: 'CREATE',
      controllingArea: DEMO_STRUCTURE.controllingArea,
      profitCenter: centre.code,
      validFrom: input.timeline.startDate,
      validTo: '9999-12-31',
      name: centre.name,
      longText: '',
      personResponsible: '',
      responsibleUser: '',
      segment: centre.segment,
      reason: 'Demo company structure',
    }).catch(swallowDuplicate);
  }

  for (const category of WORK_CENTRE_CATEGORIES) {
    await saveWorkCenterCategory({
      client,
      changedBy: DEMO_ACTOR,
      category: category.code,
      description: category.description,
    });
  }

  for (const centre of WORK_CENTRES) {
    await createWorkCenter({
      client,
      changedBy: DEMO_ACTOR,
      plant: DEMO_STRUCTURE.manufacturingPlant,
      workCenter: centre.code,
      category: centre.category,
      description: centre.description,
    }).catch(swallowDuplicate);
  }

  return {
    client,
    companyCode: company,
    plants: [DEMO_STRUCTURE.manufacturingPlant, DEMO_STRUCTURE.distributionPlant],
    storageLocations: DISTRIBUTION_STORAGE_LOCATIONS.length,
    costCentres: COST_CENTRES.length,
    profitCentres: PROFIT_CENTRES.length,
    workCentres: WORK_CENTRES.length,
    tenantCreated: !standing,
  };
}

/**
 * A write that found the row already there is not a failure.
 *
 * The alternative — checking before every call — would double the round trips and
 * still race. What must not happen is that a genuine refusal is swallowed, so only
 * the two refusals that mean "already stands" are forgiven.
 */
function swallowDuplicate(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists|already been|is already/i.test(message)) return;
  throw error;
}

/** The accounting number interval, created once. */
async function ensureJournalRange(client: string, companyCode: string): Promise<void> {
  await maintainNumberRange({
    client,
    objectCode: 'RF_BELEG',
    companyCode,
    subObject: 'GENERAL',
    fiscalYear: 0,
    prefix: 'JE',
    fromNumber: 1,
    toNumber: 999999,
    numberLength: 6,
    displayStyle: 'READABLE',
    status: 'ACTIVE',
    mode: 'CREATE',
    reason: 'Demo company accounting interval',
    changedBy: DEMO_ACTOR,
  }).catch(swallowDuplicate);
}

/**
 * The second plant, and everything a plant has to have before it can hold stock.
 *
 * The standard structure builds the manufacturing plant with its storage locations,
 * its purchasing organisation and its shipping point; this one has to be built the
 * same way, because a plant that exists but cannot receive, store or dispatch is a
 * plant that breaks the first document that touches it.
 */
async function ensureSecondPlant(client: string, companyCode: string): Promise<void> {
  const plant = DEMO_STRUCTURE.distributionPlant;

  await savePlantDefinition({
    client,
    changedBy: DEMO_ACTOR,
    mode: 'CREATE',
    plant,
    expectedVersion: 0,
    reason: 'Demo company structure',
    values: {
      name: 'Vantage Foods — Distribution centre',
      country: DEMO_IDENTITY.country,
      city: 'Al Jahra',
      language: 'EN',
      isProductionSite: false,
      isStorageSite: true,
    },
  }).catch(swallowDuplicate);

  await assignPlantCompanyCode({ client, changedBy: DEMO_ACTOR, plant, companyCode });

  for (const location of DISTRIBUTION_STORAGE_LOCATIONS) {
    await saveStorageLocation({
      client,
      changedBy: DEMO_ACTOR,
      mode: 'CREATE',
      plant,
      storageLocation: location.code,
      expectedVersion: 0,
      reason: 'Demo company structure',
      values: { name: location.name, allowNegativeStock: false },
    }).catch(swallowDuplicate);
  }

  await ensureShippingPoints(client);

  await withTenant(client, async (tx) => {
    // No service writes this link — `purchasing-org-plant.ts` only reads it — so it
    // is inserted here exactly as `standard-structure.ts` inserts the first one.
    await tx
      .insert(purchasingOrgPlant)
      .values({
        client,
        purchasingOrg: DEMO_STRUCTURE.purchasingOrg,
        plant,
        createdBy: DEMO_ACTOR,
      })
      .onConflictDoNothing();

    // A plant with no valuation seed cannot carry a material at a price.
    await seedTypeValuationForPlant(tx, client, plant, DEMO_ACTOR);
  });

}

/**
 * A dock at each plant, and the row that says each plant loads from its own.
 *
 * Neither the standard package nor the standard structure writes a shipping point:
 * the product seeds none, on the principle that a plant that cannot ship should be
 * refused rather than silently given a dock. A demo whose deliveries all fail on a
 * missing dock is not a demo, so both are declared here — the manufacturing plant
 * the standard structure built, and the distribution centre this module added.
 */
async function ensureShippingPoints(client: string): Promise<void> {
  const docks = [
    {
      plant: DEMO_STRUCTURE.manufacturingPlant,
      shippingPoint: DEMO_STRUCTURE.shippingPoint,
      name: 'Manufacturing plant dock',
    },
    {
      plant: DEMO_STRUCTURE.distributionPlant,
      shippingPoint: DEMO_STRUCTURE.distributionShippingPoint,
      name: 'Distribution centre dock',
    },
  ];

  for (const dock of docks) {
    await defineShippingPoint({
      client,
      changedBy: DEMO_ACTOR,
      shippingPoint: dock.shippingPoint,
      name: dock.name,
    }).catch(swallowDuplicate);

    // Blank condition and blank loading group: the row answers for every customer
    // and every material, which is what a single-dock plant wants.
    await assignShippingPoint({
      client,
      changedBy: DEMO_ACTOR,
      deliveringPlant: dock.plant,
      shippingPoint: dock.shippingPoint,
    }).catch(swallowDuplicate);
  }
}

/** The tenant key the demo owns, for callers that need to name it. */
export function demoClientKey(): string {
  return DEMO_IDENTITY.clientKey;
}

export type { Tx };
