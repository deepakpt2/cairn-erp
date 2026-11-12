/**
 * The demo company's masters — provisioning phase `C_MASTERS`.
 *
 * Everything a document needs before it can be written: the materials the company
 * makes and buys, the partners it buys from and sells to, what things cost, and the
 * bills of material and routings that say how a finished biscuit is made.
 *
 * It creates no documents. A biscuit factory with no orders is not an inconsistency,
 * it is a company on its first morning, and that is the state Phase D starts from.
 *
 * Two things this phase has to supply before it can write anything else, because
 * nothing in the product seeds them:
 *
 * 1. **The production configuration masters.** BOM usages, BOM item categories,
 *    routing task list types, routing usages and control keys are all empty in a new
 *    tenant. A BOM cannot be written without a usage, and a routing cannot be written
 *    without a task list type, so they are defined first.
 * 2. **Tax codes.** Empty in a new tenant, and every purchasing info record names one.
 *
 * Every write goes through the product's own service for the object. The phase is
 * idempotent by adoption: a material, partner, price, BOM or routing that already
 * stands is left exactly as it is, so a resumed run continues rather than refusing on
 * its own work.
 */

import { applyMaterialDefaults } from '../../modules/inventory/standard-config';
import { getMaterialDetail, saveMaterialView } from '../../modules/inventory/materials';
import { getBusinessPartner, saveBusinessPartner } from '../../modules/foundation/business-partners';
import { getSupplierCompany, saveSupplierCompany } from '../../modules/foundation/supplier-companies';
import { getSupplierPurchasing, saveSupplierPurchasing } from '../../modules/foundation/supplier-purchasing';
import { getCustomerCompany, saveCustomerCompany } from '../../modules/foundation/customer-companies';
import { getCustomerSalesArea, saveCustomerSalesArea } from '../../modules/foundation/customer-sales-areas';
import { saveTaxCode } from '../../modules/foundation/tax-code-definition';
import { createPurchasingInfoRecord } from '../../modules/purchasing/info-record';
import { listSalesConditions, saveSalesCondition } from '../../modules/sales/conditions';
import {
  createMaterialBom,
  getMaterialBom,
  saveBomItemCategory,
  saveBomStatus,
  saveBomUsage,
} from '../../modules/production/material-bom';
import {
  createRouting,
  resolveRouting,
  saveRoutingControlKey,
  saveRoutingStatus,
  saveRoutingTaskListType,
  saveRoutingUsage,
} from '../../modules/production/routing';
import { createProductionVersion, getProductionVersion } from '../../modules/production/production-version';
import { withTenant } from '../db/client';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import type { DemoTimeline } from './demo-provisioning';

// ─────────────────────────────────────────────────────────────────────────────
// Tax codes
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Three rates, named for what they do rather than for any jurisdiction.
 *
 * The company is fictional and so are these. They are not a statement about Kuwait's
 * tax regime or anyone else's — a demo that quietly asserted a real country's rates
 * would be wrong in a way a reader could not check.
 */
const TAX_CODES = [
  { code: 'S5', name: 'Standard rate', type: 'OUT', rate: '5.00' },
  { code: 'Z0', name: 'Zero-rated — export', type: 'OUT', rate: '0.00' },
  { code: 'E0', name: 'Exempt', type: 'OUT', rate: '0.00' },
] as const;

/** The rate an ordinary domestic purchase and sale carries. Exported for the document phases. */
export const STANDARD_TAX_CODE = 'S5';

// ─────────────────────────────────────────────────────────────────────────────
// Materials
// ─────────────────────────────────────────────────────────────────────────────

type Procurement = 'BUY' | 'MAKE';

interface MaterialSpec {
  number: string;
  description: string;
  /** One of the material types the standard package defines: RAW, SEMI, FIN, TRAD. */
  type: string;
  group: string;
  unit: string;
  procurement: Procurement;
  /** The plants this material is kept at. Raw materials never reach the distribution centre. */
  plants: readonly string[];
  valuationClass: string;
  priceControl: 'MOVING_AVERAGE' | 'STANDARD';
  price: string;
  /** Safety stock, in the material's own unit. */
  safetyStock?: string;
  /** Set for anything the company sells. */
  sellable?: boolean;
}

/**
 * Twelve materials: four raw, two packaging, one semi-finished, three finished and
 * two traded.
 *
 * The two plants are what make the set interesting. Raw materials live only where
 * they are turned into something; finished goods live at the factory and at the
 * distribution centre, because the whole reason the second plant exists is that
 * finished stock is held somewhere other than where it is made.
 */
const MATERIALS: readonly MaterialSpec[] = [
  { number: 'RAW-FLOUR', description: 'Wheat flour, milled', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', plants: ['1000'], valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '0.4500', safetyStock: '2000' },
  { number: 'RAW-SUGAR', description: 'Caster sugar', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', plants: ['1000'], valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '0.3200', safetyStock: '800' },
  { number: 'RAW-FAT', description: 'Vegetable shortening', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', plants: ['1000'], valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '0.9100', safetyStock: '600' },
  { number: 'RAW-COCOA', description: 'Cocoa powder', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY', plants: ['1000'], valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '4.4500', safetyStock: '250' },
  { number: 'PACK-CARTON', description: 'Shipping carton, 24 units', type: 'RAW', group: 'PACKAGING', unit: 'PC', procurement: 'BUY', plants: ['1000'], valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '0.6200', safetyStock: '1200' },
  { number: 'PACK-WRAP', description: 'Printed wrapper, 200 g', type: 'RAW', group: 'PACKAGING', unit: 'PC', procurement: 'BUY', plants: ['1000'], valuationClass: 'RAW_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '0.0850', safetyStock: '9000' },
  { number: 'SEMI-DOUGH', description: 'Biscuit dough, mixed', type: 'SEMI', group: 'PRODUCTS', unit: 'KG', procurement: 'MAKE', plants: ['1000'], valuationClass: 'SEMI_INVENTORY', priceControl: 'STANDARD', price: '1.7200', safetyStock: '500' },
  { number: 'FG-CREAM', description: 'Cream biscuit 200 g', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', plants: ['1000', '2000'], valuationClass: 'FINISHED_INVENTORY', priceControl: 'STANDARD', price: '0.4120', safetyStock: '4000', sellable: true },
  { number: 'FG-CHOC', description: 'Chocolate biscuit 200 g', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', plants: ['1000', '2000'], valuationClass: 'FINISHED_INVENTORY', priceControl: 'STANDARD', price: '0.4680', safetyStock: '4000', sellable: true },
  { number: 'FG-WAFER', description: 'Wafer roll 150 g', type: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE', plants: ['1000', '2000'], valuationClass: 'FINISHED_INVENTORY', priceControl: 'STANDARD', price: '0.3510', safetyStock: '2500', sellable: true },
  { number: 'TRAD-JUICE', description: 'Imported fruit juice 1 L', type: 'TRAD', group: 'PRODUCTS', unit: 'BOX', procurement: 'BUY', plants: ['1000', '2000'], valuationClass: 'TRADE_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '6.7500', safetyStock: '300', sellable: true },
  { number: 'TRAD-CRATE', description: 'Returnable plastic crate', type: 'TRAD', group: 'PACKAGING', unit: 'PC', procurement: 'BUY', plants: ['2000'], valuationClass: 'TRADE_INVENTORY', priceControl: 'MOVING_AVERAGE', price: '3.2000', safetyStock: '150' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Business partners
// ─────────────────────────────────────────────────────────────────────────────

interface SupplierSpec {
  number: string;
  name: string;
  city: string;
  /** The materials this supplier is the normal source for. */
  supplies: readonly string[];
  terms: string;
}

interface CustomerSpec {
  number: string;
  name: string;
  city: string;
  country: string;
  terms: string;
  /** Where the goods ship from. Export customers take theirs from the distribution centre. */
  deliveringPlant: string;
}

const SUPPLIERS: readonly SupplierSpec[] = [
  { number: 'SUP-1000', name: 'Al-Rashid Flour Mills', city: 'Shuwaikh', supplies: ['RAW-FLOUR', 'RAW-SUGAR'], terms: 'NET30' },
  { number: 'SUP-2000', name: 'Gulf Edible Oils Co', city: 'Al Ahmadi', supplies: ['RAW-FAT', 'RAW-COCOA'], terms: 'NET30' },
  { number: 'SUP-3000', name: 'Levant Packaging Industries', city: 'Al Jahra', supplies: ['PACK-CARTON', 'PACK-WRAP', 'TRAD-CRATE'], terms: 'NET60' },
  { number: 'SUP-4000', name: 'Nordic Beverages Trading', city: 'Doha', supplies: ['TRAD-JUICE'], terms: 'IMMEDIATE' },
];

const CUSTOMERS: readonly CustomerSpec[] = [
  { number: 'CUS-1000', name: 'Kuwait Co-operative Union', city: 'Kuwait City', country: 'KW', terms: 'NET30', deliveringPlant: '2000' },
  { number: 'CUS-2000', name: 'Gulf Hypermarkets WLL', city: 'Salmiya', country: 'KW', terms: 'NET15', deliveringPlant: '2000' },
  { number: 'CUS-3000', name: 'Doha Food Distributors', city: 'Doha', country: 'QA', terms: 'NET30', deliveringPlant: '2000' },
];

/**
 * Selling prices, in KWD, per material.
 *
 * Deliberately above the standard cost, because a demo where a company sells at
 * cost is a demo with nothing to say about margin.
 */
const SELLING_PRICES: Readonly<Record<string, string>> = {
  'FG-CREAM': '0.780',
  'FG-CHOC': '0.890',
  'FG-WAFER': '0.650',
  'TRAD-JUICE': '9.950',
};

/** Purchase prices, in KWD, per material — what the info record says the supplier charges. */
const PURCHASE_PRICES: Readonly<Record<string, string>> = {
  'RAW-FLOUR': '0.4120',
  'RAW-SUGAR': '0.2950',
  'RAW-FAT': '0.8700',
  'RAW-COCOA': '4.1800',
  'PACK-CARTON': '0.5800',
  'PACK-WRAP': '0.0790',
  'TRAD-JUICE': '6.4000',
  'TRAD-CRATE': '3.0500',
};

// ─────────────────────────────────────────────────────────────────────────────
// Bills of material and routings
// ─────────────────────────────────────────────────────────────────────────────

interface BomComponent {
  component: string;
  quantity: string;
  unit: string;
}

interface BomSpec {
  material: string;
  /** Base quantity the component quantities are quoted against, in the header unit. */
  baseQuantity: string;
  baseUnit: string;
  components: readonly BomComponent[];
}

/**
 * Four bills of material.
 *
 * The dough is made from the four raw materials; each finished biscuit is made from
 * dough plus packaging. Chocolate gets cocoa on top of that, which is the only reason
 * its bill differs from the cream biscuit's.
 */
const BOMS: readonly BomSpec[] = [
  {
    material: 'SEMI-DOUGH',
    baseQuantity: '100',
    baseUnit: 'KG',
    components: [
      { component: 'RAW-FLOUR', quantity: '62.000', unit: 'KG' },
      { component: 'RAW-SUGAR', quantity: '18.000', unit: 'KG' },
      { component: 'RAW-FAT', quantity: '17.000', unit: 'KG' },
      { component: 'RAW-COCOA', quantity: '3.000', unit: 'KG' },
    ],
  },
  // One thousand two hundred packs is twenty-four cartons' worth, and it divides
  // exactly — which a base quantity only has to do because a carton is a whole
  // thing and a BOM that needed half of one would be nonsense.
  {
    material: 'FG-CREAM',
    baseQuantity: '1200',
    baseUnit: 'PC',
    components: [
      { component: 'SEMI-DOUGH', quantity: '244.000', unit: 'KG' },
      { component: 'PACK-WRAP', quantity: '1200', unit: 'PC' },
      { component: 'PACK-CARTON', quantity: '50', unit: 'PC' },
    ],
  },
  {
    material: 'FG-CHOC',
    baseQuantity: '1200',
    baseUnit: 'PC',
    components: [
      { component: 'SEMI-DOUGH', quantity: '244.000', unit: 'KG' },
      { component: 'RAW-COCOA', quantity: '5.400', unit: 'KG' },
      { component: 'PACK-WRAP', quantity: '1200', unit: 'PC' },
      { component: 'PACK-CARTON', quantity: '50', unit: 'PC' },
    ],
  },
  {
    material: 'FG-WAFER',
    baseQuantity: '1200',
    baseUnit: 'PC',
    components: [
      { component: 'SEMI-DOUGH', quantity: '183.000', unit: 'KG' },
      { component: 'PACK-WRAP', quantity: '1200', unit: 'PC' },
      { component: 'PACK-CARTON', quantity: '50', unit: 'PC' },
    ],
  },
];

/** One routing per made material: mix at WC01, then pack at WC02. */
const ROUTINGS: readonly string[] = ['SEMI-DOUGH', 'FG-CREAM', 'FG-CHOC', 'FG-WAFER'];

/** Where a finished goods receipt lands. */
const RECEIVING_STORAGE_LOCATION = '0001';

// ─────────────────────────────────────────────────────────────────────────────

export interface DemoMastersResult {
  client: string;
  materials: number;
  suppliers: number;
  customers: number;
  infoRecords: number;
  salesPrices: number;
  boms: number;
  routings: number;
  productionVersions: number;
  taxCodes: number;
}

export interface BuildDemoMastersInput {
  client: string;
  timeline: DemoTimeline;
}

/**
 * Build the masters.
 *
 * Order matters and is not decorative: the production configuration masters come
 * first because a BOM cannot be written without a usage; materials come before
 * partners because an info record names both; BOMs and routings come before
 * production versions, which point at them.
 */
export async function buildDemoMasters(input: BuildDemoMastersInput): Promise<DemoMastersResult> {
  const client = input.client;
  const from = input.timeline.startDate;
  const to = '9999-12-31';

  await withTenant(client, (tx) => applyMaterialDefaults(tx, client, DEMO_ACTOR));
  await ensureProductionConfiguration(client);
  await ensureTaxCodes(client);

  for (const material of MATERIALS) {
    await ensureMaterial(client, material, from);
  }

  for (const supplier of SUPPLIERS) {
    await ensureSupplier(client, supplier, from, to);
  }

  for (const customer of CUSTOMERS) {
    await ensureCustomer(client, customer);
  }

  let salesPrices = 0;
  for (const customer of CUSTOMERS) {
    for (const [materialNumber, price] of Object.entries(SELLING_PRICES)) {
      const created = await ensureSalesPrice(client, customer.number, materialNumber, price, from, to);
      if (created) salesPrices += 1;
    }
  }

  let boms = 0;
  for (const bom of BOMS) {
    if (await ensureBom(client, bom, from, to)) boms += 1;
  }

  let routings = 0;
  for (const materialNumber of ROUTINGS) {
    if (await ensureRouting(client, materialNumber, from, to)) routings += 1;
  }

  let productionVersions = 0;
  for (const materialNumber of ROUTINGS) {
    if (await ensureProductionVersion(client, materialNumber, from)) productionVersions += 1;
  }

  return {
    client,
    materials: MATERIALS.length,
    suppliers: SUPPLIERS.length,
    customers: CUSTOMERS.length,
    infoRecords: Object.keys(PURCHASE_PRICES).length,
    salesPrices,
    boms,
    routings,
    productionVersions,
    taxCodes: TAX_CODES.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration the transactions need and nothing seeds
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The production configuration masters.
 *
 * A new tenant has none of these, and without them a BOM cannot be written (no
 * usage, no item category) and neither can a routing (no task list type, no usage,
 * no control key). The product leaves them empty because a tenant that has never
 * configured production should be refused rather than given a guess; the demo
 * configures production, so it names them.
 */
async function ensureProductionConfiguration(client: string): Promise<void> {
  await saveBomUsage({
    client,
    changedBy: DEMO_ACTOR,
    usage: 'P',
    description: 'Production',
    productionRelevance: '.',
    engineeringRelevance: '.',
    costingRelevance: '.',
    salesRelevance: '.',
  }).catch(ignoreExisting);

  await saveBomItemCategory({
    client,
    changedBy: DEMO_ACTOR,
    category: 'S',
    description: 'Stock item',
    materialEntry: '+',
    quantityEntry: '+',
    allowFixedQuantity: 'X',
    allowBulk: 'X',
    allowPhantom: 'X',
    allowCoproduct: 'X',
    allowFollowUp: 'X',
    allowSpecialProcurement: 'X',
    allowNegativeQuantity: ' ',
  }).catch(ignoreExisting);

  await saveRoutingTaskListType({ client, changedBy: DEMO_ACTOR, taskListType: 'N', description: 'Routing' }).catch(ignoreExisting);
  await saveRoutingUsage({ client, changedBy: DEMO_ACTOR, usage: '1', description: 'Production' }).catch(ignoreExisting);
  await saveBomStatus({
    client,
    changedBy: DEMO_ACTOR,
    status: '01',
    description: 'Released',
    releasedForMrp: 'X',
    releasedForCosting: 'X',
    releasedForOrders: 'X',
  }).catch(ignoreExisting);
  await saveRoutingStatus({
    client,
    changedBy: DEMO_ACTOR,
    status: '01',
    description: 'Released',
    releasedForScheduling: 'X',
    releasedForCosting: 'X',
    releasedForOrders: 'X',
  }).catch(ignoreExisting);
  await saveRoutingControlKey({
    client,
    changedBy: DEMO_ACTOR,
    controlKey: 'PP01',
    description: 'Internal processing',
  }).catch(ignoreExisting);
}

async function ensureTaxCodes(client: string): Promise<void> {
  for (const tax of TAX_CODES) {
    await saveTaxCode({
      client,
      changedBy: DEMO_ACTOR,
      mode: 'CREATE',
      country: DEMO_IDENTITY.country,
      taxCode: tax.code,
      name: tax.name,
      taxType: tax.type,
      ratePercent: tax.rate,
      accountKey: '',
      reason: 'Demo company tax codes',
    }).catch(ignoreExisting);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Materials
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One material, view by view, at each plant it is kept at.
 *
 * A material is not usable at a plant until the plant's views exist — an MRP view
 * says how it is replenished, a purchasing view says who buys it, an accounting view
 * says what it is worth. A material with only a basic view is a material that can be
 * named but not moved, which is why every plant gets every view it needs.
 */
async function ensureMaterial(client: string, spec: MaterialSpec, from: string): Promise<void> {
  const common = { client, materialNumber: spec.number, changedBy: DEMO_ACTOR, reason: 'Demo company masters' };

  // Only when the material is not there at all.
  //
  // The basic view carries the material's version, and it is written against
  // version 0 — the version of a material that does not exist yet. Saving it over
  // one that stands would be optimistically refused, and rightly so.
  if (!(await getMaterialDetail(client, spec.number))) {
    await saveMaterialView({
      ...common,
      view: 'BASIC',
      expectedVersion: 0,
      description: spec.description,
      materialType: spec.type,
      materialGroup: spec.group,
      baseUnit: spec.unit,
      industrySector: 'M',
      barcode: '',
      grossWeight: '0',
      netWeight: '0',
      weightUnit: '',
      isBlocked: false,
    });
  }

  for (const plant of spec.plants) {
    const detail = await getMaterialDetail(client, spec.number);
    const standing = detail?.plants.find((row) => row.plant === plant);

    if (!standing || standing.mrpStatus === 'NOT_CREATED' || standing.mrpStatus === 'INCOMPLETE') {
      await saveMaterialView({
        ...common,
        view: 'MRP',
        expectedVersion: standing?.version ?? 0,
        plant,
        mrpType: 'REQUIREMENTS',
        mrpController: '001',
        procurementType: spec.procurement,
        lotSizing: 'EXACT',
        fixedLotSize: '0',
        minimumLotSize: '0',
        maximumLotSize: '0',
        safetyStock: spec.safetyStock ?? '0',
        reorderPoint: '0',
        plannedDeliveryDays: spec.procurement === 'BUY' ? 7 : 0,
        inHouseProductionDays: spec.procurement === 'MAKE' ? 2 : 0,
        backflush: true,
        automaticGoodsReceipt: spec.procurement === 'MAKE',
      }).catch(ignoreExisting);
    }

    const refreshed = await getMaterialDetail(client, spec.number);
    const view = refreshed?.plants.find((row) => row.plant === plant);

    if (spec.procurement === 'BUY' && view && view.purchasingStatus === 'NOT_CREATED') {
      await saveMaterialView({
        ...common,
        view: 'PURCHASING',
        expectedVersion: view.version,
        plant,
        purchasingGroup: '001',
        orderUnit: spec.unit,
        overdeliveryTolerance: '5.00',
        underdeliveryTolerance: '5.00',
        manufacturerPartNumber: '',
      }).catch(ignoreExisting);
    }

    if (refreshed && !refreshed.valuations.some((row) => row.valuationArea === plant)) {
      await saveMaterialView({
        ...common,
        view: 'ACCOUNTING',
        expectedVersion: 0,
        plant,
        valuationClass: spec.valuationClass,
        priceControl: spec.priceControl,
        standardPrice: spec.priceControl === 'STANDARD' ? spec.price : '0',
        movingAveragePrice: spec.priceControl === 'MOVING_AVERAGE' ? spec.price : '0',
        priceUnit: '1',
      }).catch(ignoreExisting);
    }
  }

  if (spec.sellable) {
    const standing = await getMaterialDetail(client, spec.number);
    const sold = standing?.sales.some(
      (row) => row.salesOrg === DEMO_STRUCTURE.salesOrg && row.distributionChannel === DEMO_STRUCTURE.distributionChannel,
    );
    if (!sold) {
      await saveMaterialView({
        ...common,
        view: 'SALES',
        expectedVersion: 0,
        salesOrg: DEMO_STRUCTURE.salesOrg,
        distributionChannel: DEMO_STRUCTURE.distributionChannel,
        salesUnit: spec.unit,
        itemCategoryGroup: 'NORM',
        materialAccountAssignmentGroup: '',
        deliveringPlant: DEMO_STRUCTURE.distributionPlant,
        loadingGroup: '',
        availabilityCheckGroup: '',
      });
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Partners
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A supplier: the general partner, then the company code view that carries the
 * reconciliation account, then the purchasing organisation view that carries the
 * terms, then an info record for every material it is the normal source for.
 *
 * A partner with only its general data is a name. The company view is what lets a
 * payable be posted against it, the purchasing view is what lets an order be placed,
 * and the info record is what gives the order a price.
 */
async function ensureSupplier(client: string, spec: SupplierSpec, from: string, to: string): Promise<void> {
  if (!(await getBusinessPartner(client, spec.number))) {
    await saveBusinessPartner({
      client,
      partnerNumber: spec.number,
      expectedVersion: 0,
      changedBy: DEMO_ACTOR,
      reason: 'Demo company masters',
      category: 'ORGANIZATION',
      name: spec.name,
      name2: '',
      searchTerm: '',
      country: DEMO_IDENTITY.country,
      region: '',
      street: '',
      city: spec.city,
      postalCode: '',
      taxNumber: '',
      email: '',
      phone: '',
      roles: ['SUPPLIER'],
      isBlocked: false,
    });
  }

  if (!(await getSupplierCompany(client, spec.number, DEMO_STRUCTURE.companyCode))) {
    await saveSupplierCompany({
      client,
      partnerNumber: spec.number,
      companyCode: DEMO_STRUCTURE.companyCode,
      expectedVersion: 0,
      changedBy: DEMO_ACTOR,
      reason: 'Demo company masters',
      reconciliationAccount: '200000',
      paymentTermsCode: spec.terms,
      isBlocked: false,
    });
  }

  if (!(await getSupplierPurchasing(client, spec.number, DEMO_STRUCTURE.purchasingOrg))) {
    await saveSupplierPurchasing({
      client,
      partnerNumber: spec.number,
      purchasingOrg: DEMO_STRUCTURE.purchasingOrg,
      expectedVersion: 0,
      changedBy: DEMO_ACTOR,
      reason: 'Demo company masters',
      orderCurrency: DEMO_IDENTITY.currency,
      purchasingGroup: '001',
      incotermsCode: spec.number === 'SUP-4000' ? 'CIF' : 'DAP',
      incotermsLocation: spec.city,
      paymentTermsCode: spec.terms,
      isBlocked: false,
    });
  }

  for (const materialNumber of spec.supplies) {
    const price = PURCHASE_PRICES[materialNumber];
    if (!price) continue;
    const material = MATERIALS.find((row) => row.number === materialNumber);
    await createPurchasingInfoRecord({
      client,
      changedBy: DEMO_ACTOR,
      partnerNumber: spec.number,
      materialNumber,
      purchasingOrg: DEMO_STRUCTURE.purchasingOrg,
      plant: material?.plants[0] ?? DEMO_STRUCTURE.manufacturingPlant,
      price: {
        amount: Number(price),
        currency: DEMO_IDENTITY.currency,
        priceUnit: 1,
        priceUnitOfMeasure: material?.unit ?? 'PC',
        validFrom: from,
        validTo: to,
      },
      plannedDeliveryDays: 7,
      orderUnit: material?.unit ?? 'PC',
    }).catch(ignoreExisting);
  }
}

async function ensureCustomer(client: string, spec: CustomerSpec): Promise<void> {
  if (!(await getBusinessPartner(client, spec.number))) {
    await saveBusinessPartner({
      client,
      partnerNumber: spec.number,
      expectedVersion: 0,
      changedBy: DEMO_ACTOR,
      reason: 'Demo company masters',
      category: 'ORGANIZATION',
      name: spec.name,
      name2: '',
      searchTerm: '',
      country: spec.country,
      region: '',
      street: '',
      city: spec.city,
      postalCode: '',
      taxNumber: '',
      email: '',
      phone: '',
      roles: ['CUSTOMER'],
      isBlocked: false,
    });
  }

  if (!(await getCustomerCompany(client, spec.number, DEMO_STRUCTURE.companyCode))) {
    await saveCustomerCompany({
      client,
      partnerNumber: spec.number,
      companyCode: DEMO_STRUCTURE.companyCode,
      expectedVersion: 0,
      changedBy: DEMO_ACTOR,
      reason: 'Demo company masters',
      reconciliationAccount: '110000',
      paymentTermsCode: spec.terms,
      paymentMethods: '',
      dunningProcedure: '',
      isBlocked: false,
    });
  }

  const area = await getCustomerSalesArea(
    client,
    spec.number,
    DEMO_STRUCTURE.salesOrg,
    DEMO_STRUCTURE.distributionChannel,
    DEMO_STRUCTURE.division,
  );
  if (!area) {
    await saveCustomerSalesArea({
      client,
      partnerNumber: spec.number,
      salesOrg: DEMO_STRUCTURE.salesOrg,
      distributionChannel: DEMO_STRUCTURE.distributionChannel,
      division: DEMO_STRUCTURE.division,
      expectedVersion: 0,
      changedBy: DEMO_ACTOR,
      reason: 'Demo company masters',
      salesDistrict: '',
      deliveringPlant: spec.deliveringPlant,
      pricingProcedure: '',
      accountAssignmentGroup: '',
      completeDelivery: false,
      orderCombination: false,
      isBlocked: false,
    });
  }
}

/** One price per customer and material. Returns true when a price was written. */
async function ensureSalesPrice(
  client: string,
  customerNumber: string,
  materialNumber: string,
  price: string,
  from: string,
  to: string,
): Promise<boolean> {
  // The standing record is read first, because saving the same price twice is not
  // a no-op: the service treats a second record over the same period as a
  // replacement and refuses it unless the caller says it meant to supersede.
  const standing = await listSalesConditions(client, { customerNumber, materialNumber });
  const priced = standing.some(
    (row) =>
      row.salesOrg === DEMO_STRUCTURE.salesOrg &&
      row.distributionChannel === DEMO_STRUCTURE.distributionChannel &&
      row.division === DEMO_STRUCTURE.division &&
      row.validityFrom === from &&
      row.validityTo === to,
  );
  if (priced) return false;

  try {
    await saveSalesCondition({
      client,
      changedBy: DEMO_ACTOR,
      salesOrg: DEMO_STRUCTURE.salesOrg,
      distributionChannel: DEMO_STRUCTURE.distributionChannel,
      division: DEMO_STRUCTURE.division,
      customerNumber,
      materialNumber,
      currency: DEMO_IDENTITY.currency,
      amount: Number(price),
      priceUnit: 1,
      validityFrom: from,
      validityTo: to,
      supersedeStanding: false,
    });
    return true;
  } catch (error) {
    ignoreExisting(error);
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Production masters
// ─────────────────────────────────────────────────────────────────────────────

/** Returns true when a bill of material was written. */
async function ensureBom(client: string, spec: BomSpec, from: string, to: string): Promise<boolean> {
  const standing = await getMaterialBom(client, spec.material, DEMO_STRUCTURE.manufacturingPlant, 'P', '01').catch(() => null);
  if (standing) return false;

  await createMaterialBom({
    client,
    changedBy: DEMO_ACTOR,
    materialNumber: spec.material,
    plant: DEMO_STRUCTURE.manufacturingPlant,
    usage: 'P',
    alternative: '01',
    status: '01',
    baseQuantity: spec.baseQuantity,
    baseUnit: spec.baseUnit,
    validFrom: from,
    validTo: to,
    headerText: `Demo bill of material — ${spec.material}`,
    requestKey: `DEMO-BOM-${spec.material}`,
    items: spec.components.map((component, index) => ({
      itemNumber: String((index + 1) * 10).padStart(4, '0'),
      itemCategory: 'S',
      componentMaterial: component.component,
      quantity: component.quantity,
      unit: component.unit,
      validFrom: from,
      validTo: to,
    })),
  });
  return true;
}

/** Returns true when a routing was written. */
async function ensureRouting(client: string, materialNumber: string, from: string, to: string): Promise<boolean> {
  const standing = await resolveStandingRouting(client, materialNumber);
  if (standing) return false;

  // The routing's base quantity is quoted in the material's own unit: a batch of
  // dough is weighed, a batch of biscuits is counted, and a routing that mixed the
  // two would need a conversion the material does not carry.
  const unit = MATERIALS.find((row) => row.number === materialNumber)?.unit ?? 'PC';

  await createRouting({
    client,
    changedBy: DEMO_ACTOR,
    taskListType: 'N',
    plant: DEMO_STRUCTURE.manufacturingPlant,
    description: `Demo routing — ${materialNumber}`,
    usage: '1',
    status: '01',
    baseQuantity: '1200',
    baseUnit: unit,
    validFrom: from,
    validTo: to,
    requestKey: `DEMO-RTG-${materialNumber}`,
    assignments: [{ materialNumber, plant: DEMO_STRUCTURE.manufacturingPlant, validFrom: from, validTo: to }],
    operations: [
      { operationNumber: '0010', shortText: 'Mix', workCenter: 'WC01', controlKey: 'PP01', validFrom: from, validTo: to },
      { operationNumber: '0020', shortText: 'Pack', workCenter: 'WC02', controlKey: 'PP01', validFrom: from, validTo: to },
    ],
  });
  return true;
}

/**
 * The routing a material already has, if it has one.
 *
 * The routing service resolves a task list by the material it is assigned to; there
 * is no lookup by material alone, so adoption goes through the same door an order
 * would.
 */
async function resolveStandingRouting(
  client: string,
  materialNumber: string,
): Promise<{ routingGroup: string; groupCounter: string } | null> {
  const found = await resolveRouting(client, {
    materialNumber,
    plant: DEMO_STRUCTURE.manufacturingPlant,
    taskListType: 'N',
  }).catch(() => null);
  if (!found) return null;
  return { routingGroup: found.routingGroup, groupCounter: found.groupCounter };
}

/** Returns true when a production version was written. */
async function ensureProductionVersion(client: string, materialNumber: string, from: string): Promise<boolean> {
  const standing = await getProductionVersion(client, materialNumber, DEMO_STRUCTURE.manufacturingPlant, '0001').catch(() => null);
  if (standing) return false;

  const routing = await resolveStandingRouting(client, materialNumber);
  if (!routing) {
    // A production version points at a routing; without one there is nothing to link.
    return false;
  }

  await createProductionVersion({
    client,
    changedBy: DEMO_ACTOR,
    materialNumber,
    plant: DEMO_STRUCTURE.manufacturingPlant,
    productionVersion: '0001',
    description: `Demo build — ${materialNumber}`,
    validFrom: from,
    lotFrom: '0',
    lotTo: '999999',
    // The lot-size interval is stated in the material's own unit, for the same
    // reason the routing's base quantity is: a conversion the material does not
    // carry is not something a master may assume.
    lotUnit: MATERIALS.find((row) => row.number === materialNumber)?.unit ?? 'PC',
    bomUsage: 'P',
    bomAlternative: '01',
    taskListType: 'N',
    routingGroup: routing.routingGroup,
    groupCounter: routing.groupCounter,
    receivingStorageLocation: RECEIVING_STORAGE_LOCATION,
    requestKey: `DEMO-PV-${materialNumber}`,
  });
  return true;
}

/**
 * A write that found the row already there is not a failure.
 *
 * Only duplicate refusals are forgiven. A refusal that means the value is wrong, or
 * that a prerequisite is missing, still stops the run — a demo that quietly skipped
 * a master it could not write would fail later, in a document, for a reason nobody
 * could trace back to here.
 */
function ignoreExisting(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/already (exists|stands|been|holds|links|carries|covers|assigned)|is already|EXISTS|duplicate/i.test(message)) return;
  throw error;
}
