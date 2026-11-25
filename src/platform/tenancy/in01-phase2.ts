/**
 * Phase 2 for the India UAT dataset: master data, and nothing transactional.
 *
 * Materials with their plant views, bills of material, routings, vendors and customers with
 * their company, purchasing and sales-area views, purchasing info records, selling prices and
 * credit limits. Every write goes through the service the master-data screen calls.
 *
 * No document is created here. A company with masters and no orders is a company on its first
 * morning, which is what Phases 0 to 2 are meant to leave behind.
 */
import { and, eq } from 'drizzle-orm';

import { sql } from 'drizzle-orm';
import { withTenant } from '../db/client';
import { getBusinessPartner, saveBusinessPartner } from '../../modules/foundation/business-partners';
import { getSupplierCompany, saveSupplierCompany } from '../../modules/foundation/supplier-companies';
import { getSupplierPurchasing, saveSupplierPurchasing } from '../../modules/foundation/supplier-purchasing';
import { getCustomerCompany, saveCustomerCompany } from '../../modules/foundation/customer-companies';
import { getCustomerSalesArea, saveCustomerSalesArea } from '../../modules/foundation/customer-sales-areas';
import { saveCustomerCredit } from '../../modules/finance/credit';
import { createPurchasingInfoRecordForProvisioning as createPurchasingInfoRecord } from '../../modules/purchasing/info-record';
import {
  listSalesConditionsForProvisioning as listSalesConditions,
  saveSalesConditionForProvisioning as saveSalesCondition,
} from '../../modules/sales/conditions';
import { getMaterialDetail, saveMaterialView } from '../../modules/inventory/materials';
import { seedMrpController } from '../../modules/inventory/mrp-controller-maintenance';
import { saveMaterialGroup } from '../../modules/inventory/material-group-definition';
import type { MaterialBomView } from '../../modules/production/material-bom';
import {
  createMaterialBomForProvisioning as createMaterialBom,
  getMaterialBomForProvisioning as getMaterialBom,
  saveBomItemCategory,
  saveBomStatus,
  saveBomUsage,
} from '../../modules/production/material-bom';
import {
  createRoutingForProvisioning as createRouting,
  saveRoutingControlKey,
  saveRoutingStatus,
  saveRoutingTaskListType,
  saveRoutingUsage,
} from '../../modules/production/routing';
import { IN01_ACTOR } from './in01-phase0';
import type { FixtureSet } from './in01-fixtures';

function ignoreExisting(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (/already exists|already stands|is already|already links|changed after it was opened|already in use/i.test(message)) return;
  throw error;
}

export interface Phase2Result {
  materials: number;
  boms: number;
  routings: number;
  vendors: number;
  customers: number;
  infoRecords: number;
  sellingPrices: number;
  creditLimits: number;
}

/** The pricing procedure a normal domestic customer carries; the package determines '*' to it. */
const CUSTOMER_PRICING_PROCEDURE = '1';

export async function buildPhase2(input: {
  fixtures: FixtureSet;
  scenario: { fiscalYear: number; period: number; from: string; to: string };
}): Promise<Phase2Result> {
  const { fixtures, scenario } = input;
  const { core, country, company } = fixtures;
  const client = company.identity.clientKey;
  const structure = core.structure;

  // ── Material groups ─────────────────────────────────────────────────────────
  // The tenant is delivered five groups; the company's own are added through the service, in
  // the same key format it enforces (one to nine uppercase letters or digits).
  for (const group of company.materialGroups ?? []) {
    await saveMaterialGroup({
      client,
      changedBy: IN01_ACTOR,
      mode: 'CREATE',
      materialGroup: group.code,
      name: group.shortName,
      longDescription: group.name,
      reason: 'Phase 2 master data',
    }).catch(ignoreExisting);
  }

  // ── Materials ───────────────────────────────────────────────────────────────
  for (const material of company.materials) {
    await ensureMaterial(client, structure, material, scenario);
  }

  // ── Bills of material ───────────────────────────────────────────────────────
  await ensureBomCustomising(client);
  for (const bom of company.boms) {
    const standing = await getBom(client, bom.material, bom.plant, bom.usage);
    if (standing) continue;
    await createMaterialBom({
      client,
      changedBy: IN01_ACTOR,
      materialNumber: bom.material,
      plant: bom.plant,
      usage: bom.usage,
      alternative: '01',
      baseQuantity: bom.baseQuantity,
      baseUnit: company.materials.find((m) => m.number === bom.material)?.unit ?? 'PC',
      validFrom: scenario.from,
      items: bom.items.map((item) => ({
        itemNumber: String(item.itemNumber),
        itemCategory: 'S',
        componentMaterial: item.component,
        quantity: item.quantity,
        unit: item.unit,
      })),
    }).catch(ignoreExisting);
  }

  // ── Routings ────────────────────────────────────────────────────────────────
  await ensureRoutingCustomising(client);
  for (const routing of company.routings) {
    await createRouting({
      client,
      changedBy: IN01_ACTOR,
      plant: routing.plant,
      usage: routing.usage,
      taskListType: routing.taskListType,
      baseQuantity: '1',
      baseUnit: company.materials.find((m) => m.number === routing.material)?.unit ?? 'PC',
      validFrom: scenario.from,
      assignments: [{ materialNumber: routing.material }],
      operations: routing.operations.map((operation) => ({
        operationNumber: String(operation.operation),
        workCenter: operation.workCentre,
        shortText: operation.description,
        controlKey: operation.controlKey,
      })),
    }).catch(ignoreExisting);
  }

  // ── Vendors ─────────────────────────────────────────────────────────────────
  let infoRecords = 0;
  for (const vendor of company.vendors) {
    infoRecords += await ensureVendor(client, structure, company, vendor, scenario);
  }

  // ── Customers ───────────────────────────────────────────────────────────────
  await ensureRiskCategory(client, '001', 'Standard risk');
  await ensureRiskCategory(client, '002', 'Higher risk — monitored');

  let sellingPrices = 0;
  let creditLimits = 0;
  for (const customer of company.customers) {
    await ensureCustomer(client, structure, company, customer);
    const limit = await ensureCredit(client, structure, customer);
    if (limit) creditLimits += 1;
    sellingPrices += await ensureSellingPricesFor(client, structure, company, String(customer.number));
  }

  return {
    materials: company.materials.length,
    boms: company.boms.length,
    routings: company.routings.length,
    vendors: company.vendors.length,
    customers: company.customers.length,
    infoRecords,
    sellingPrices,
    creditLimits,
  };
}

/* ─────────────────────────────── Materials ─────────────────────────────── */

/**
 * One material, view by view, at each plant it is kept at.
 *
 * A material is not usable at a plant until the plant's views exist: an MRP view says how it
 * is replenished, a purchasing view says who buys it, an accounting view says what it is worth.
 */
async function ensureMaterial(
  client: string,
  structure: FixtureSet['core']['structure'],
  material: FixtureSet['company']['materials'][number],
  scenario: { from: string; to: string },
): Promise<void> {
  const common = { client, materialNumber: material.number, changedBy: IN01_ACTOR, reason: 'Phase 2 master data' };

  if (!(await getMaterialDetail(client, material.number))) {
    await saveMaterialView({
      ...common,
      view: 'BASIC',
      expectedVersion: 0,
      description: material.description,
      materialType: material.type,
      materialGroup: material.group,
      baseUnit: material.unit,
      industrySector: 'M',
      barcode: '',
      grossWeight: '0',
      netWeight: '0',
      weightUnit: '',
      isBlocked: false,
    }).catch(ignoreExisting);
  }

  for (const plant of material.plants) {
    const detail = await getMaterialDetail(client, material.number);
    const standing = detail?.plants.find((row) => row.plant === plant);

    if (!standing || standing.mrpStatus === 'NOT_CREATED' || standing.mrpStatus === 'INCOMPLETE') {
      await withTenant(client, (tx) =>
        seedMrpController(tx, client, plant, '001', 'Materials planner', IN01_ACTOR));
      await saveMaterialView({
        ...common,
        view: 'MRP',
        expectedVersion: standing?.version ?? 0,
        plant,
        mrpType: 'REQUIREMENTS',
        mrpController: '001',
        procurementType: material.procurement,
        lotSizing: 'EXACT',
        fixedLotSize: '0',
        minimumLotSize: '0',
        maximumLotSize: '0',
        safetyStock: material.safetyStock ?? '0',
        reorderPoint: '0',
        plannedDeliveryDays: material.procurement === 'BUY' ? 10 : 0,
        inHouseProductionDays: material.procurement === 'MAKE' ? 3 : 0,
        backflush: false,
        automaticGoodsReceipt: material.procurement === 'MAKE',
      }).catch(ignoreExisting);
    }

    const refreshed = await getMaterialDetail(client, material.number);
    const view = refreshed?.plants.find((row) => row.plant === plant);

    if (material.procurement === 'BUY' && view && view.purchasingStatus === 'NOT_CREATED') {
      await saveMaterialView({
        ...common,
        view: 'PURCHASING',
        expectedVersion: view.version,
        plant,
        purchasingGroup: '001',
        orderUnit: material.unit,
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
        valuationClass: material.valuationClass,
        priceControl: material.priceControl,
        standardPrice: material.priceControl === 'STANDARD' ? material.price : '0',
        movingAveragePrice: material.priceControl === 'MOVING_AVERAGE' ? material.price : '0',
        priceUnit: '1',
      }).catch(ignoreExisting);
    }
  }

  if (material.sellable) {
    const standing = await getMaterialDetail(client, material.number);
    const sold = standing?.sales.some(
      (row) => row.salesOrg === structure.salesOrg && row.distributionChannel === structure.distributionChannel,
    );
    if (!sold) {
      await saveMaterialView({
        ...common,
        view: 'SALES',
        expectedVersion: 0,
        salesOrg: structure.salesOrg,
        distributionChannel: structure.distributionChannel,
        salesUnit: material.unit,
        itemCategoryGroup: 'NORM',
        materialAccountAssignmentGroup: '',
        deliveringPlant: structure.distributionPlant,
        loadingGroup: '',
        availabilityCheckGroup: '',
      }).catch(ignoreExisting);
    }
  }
  void scenario;
}

/** The BOM customising a new tenant has none of: usage, status and item category. */
async function ensureBomCustomising(client: string): Promise<void> {
  await saveBomUsage({
    client,
    changedBy: IN01_ACTOR,
    usage: 'P',
    description: 'Production',
    productionRelevance: '.',
    engineeringRelevance: '.',
    costingRelevance: '.',
    salesRelevance: '.',
  }).catch(ignoreExisting);
  await saveBomStatus({
    client,
    changedBy: IN01_ACTOR,
    status: '01',
    description: 'Released',
    releasedForMrp: 'X',
    releasedForCosting: 'X',
    releasedForOrders: 'X',
  }).catch(ignoreExisting);
  await saveBomItemCategory({
    client,
    changedBy: IN01_ACTOR,
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
}

/** The routing customising a new tenant has none of: task list type, usage, status, control key. */
async function ensureRoutingCustomising(client: string): Promise<void> {
  await saveRoutingTaskListType({ client, changedBy: IN01_ACTOR, taskListType: 'N', description: 'Standard routing' })
    .catch(ignoreExisting);
  await saveRoutingUsage({ client, changedBy: IN01_ACTOR, usage: '1', description: 'Production' })
    .catch(ignoreExisting);
  await saveRoutingStatus({
    client,
    changedBy: IN01_ACTOR,
    status: '01',
    description: 'Released',
    releasedForScheduling: 'X',
    releasedForCosting: 'X',
    releasedForOrders: 'X',
  }).catch(ignoreExisting);
  await saveRoutingControlKey({
    client,
    changedBy: IN01_ACTOR,
    controlKey: 'PP01',
    description: 'Internal processing',
    scheduling: 'X',
    confirmation: 'X',
    requireWorkCenter: 'X',
  }).catch(ignoreExisting);
}

async function getBom(client: string, material: string, plant: string, usage: string): Promise<MaterialBomView | null> {
  try {
    return await getMaterialBom(client, material, plant, usage, '01');
  } catch {
    // A material with no BOM yet is the ordinary case here, not an error.
    return null;
  }
}

/* ──────────────────────────── Business partners ──────────────────────────── */

async function ensureVendor(
  client: string,
  structure: FixtureSet['core']['structure'],
  company: FixtureSet['company'],
  vendor: Record<string, unknown>,
  scenario: { from: string; to: string },
): Promise<number> {
  const number = String(vendor.number);
  const foreign = vendor.foreign === true;

  if (!(await getBusinessPartner(client, number))) {
    await saveBusinessPartner({
      client,
      partnerNumber: number,
      expectedVersion: 0,
      changedBy: IN01_ACTOR,
      reason: 'Phase 2 master data',
      category: 'ORGANIZATION',
      name: String(vendor.name),
      name2: '',
      searchTerm: '',
      country: String(vendor.country),
      region: '',
      street: String(vendor.address ?? ''),
      city: String(vendor.city),
      postalCode: '',
      taxNumber: String(vendor.gstin ?? ''),
      email: '',
      phone: '',
      roles: ['SUPPLIER'],
      isBlocked: false,
    }).catch(ignoreExisting);
  }

  if (!(await getSupplierCompany(client, number, company.identity.companyCode))) {
    await saveSupplierCompany({
      client,
      partnerNumber: number,
      companyCode: company.identity.companyCode,
      expectedVersion: 0,
      changedBy: IN01_ACTOR,
      reason: 'Phase 2 master data',
      reconciliationAccount: '200000',
      paymentTermsCode: String(vendor.terms),
      isBlocked: false,
    }).catch(ignoreExisting);
  }

  if (!(await getSupplierPurchasing(client, number, structure.purchasingOrg))) {
    await saveSupplierPurchasing({
      client,
      partnerNumber: number,
      purchasingOrg: structure.purchasingOrg,
      expectedVersion: 0,
      changedBy: IN01_ACTOR,
      reason: 'Phase 2 master data',
      // A foreign vendor orders in its own currency; the domestic ones in rupees.
      orderCurrency: foreign ? String(vendor.currency) : 'INR',
      purchasingGroup: '001',
      incotermsCode: foreign ? 'FOB' : 'DAP',
      incotermsLocation: String(vendor.city),
      paymentTermsCode: String(vendor.terms),
      isBlocked: false,
    }).catch(ignoreExisting);
  }

  let created = 0;
  for (const materialNumber of (vendor.supplies as string[]) ?? []) {
    const material = company.materials.find((row) => row.number === materialNumber);
    if (!material) continue;
    // The price the supplier charges, in the vendor's order currency.
    const price = company.purchasePrices[materialNumber];
    if (price) {
      await createPurchasingInfoRecord({
        client,
        changedBy: IN01_ACTOR,
        partnerNumber: number,
        materialNumber,
        purchasingOrg: structure.purchasingOrg,
        plant: material.plants[0] ?? structure.manufacturingPlant,
        price: {
          amount: Number(price),
          currency: foreign ? String(vendor.currency) : 'INR',
          priceUnit: 1,
          priceUnitOfMeasure: material.unit,
          validFrom: scenario.from,
          validTo: scenario.to,
        },
        plannedDeliveryDays: foreign ? 45 : 10,
        orderUnit: material.unit,
      }).then(() => { created += 1; }).catch(ignoreExisting);
    }
  }
  return created;
}

async function ensureCustomer(
  client: string,
  structure: FixtureSet['core']['structure'],
  company: FixtureSet['company'],
  customer: Record<string, unknown>,
): Promise<void> {
  const number = String(customer.number);

  if (!(await getBusinessPartner(client, number))) {
    await saveBusinessPartner({
      client,
      partnerNumber: number,
      expectedVersion: 0,
      changedBy: IN01_ACTOR,
      reason: 'Phase 2 master data',
      category: 'ORGANIZATION',
      name: String(customer.name),
      name2: '',
      searchTerm: '',
      country: String(customer.country),
      region: '',
      street: String(customer.address ?? ''),
      city: String(customer.city),
      postalCode: '',
      taxNumber: String(customer.gstin ?? ''),
      email: '',
      phone: '',
      roles: ['CUSTOMER'],
      isBlocked: false,
    }).catch(ignoreExisting);
  }

  if (!(await getCustomerCompany(client, number, company.identity.companyCode))) {
    await saveCustomerCompany({
      client,
      partnerNumber: number,
      companyCode: company.identity.companyCode,
      expectedVersion: 0,
      changedBy: IN01_ACTOR,
      reason: 'Phase 2 master data',
      reconciliationAccount: '110000',
      paymentTermsCode: String(customer.terms),
      paymentMethods: '',
      dunningProcedure: '',
      isBlocked: false,
    }).catch(ignoreExisting);
  }

  const area = await getCustomerSalesArea(
    client, number, structure.salesOrg, structure.distributionChannel, structure.division,
  );
  if (!area || area.salesStatus === 'INCOMPLETE') {
    await saveCustomerSalesArea({
      client,
      partnerNumber: number,
      salesOrg: structure.salesOrg,
      distributionChannel: structure.distributionChannel,
      division: structure.division,
      expectedVersion: area?.version ?? 0,
      changedBy: IN01_ACTOR,
      reason: 'Phase 2 master data',
      salesDistrict: '',
      deliveringPlant: String(customer.deliveringPlant),
      pricingProcedure: CUSTOMER_PRICING_PROCEDURE,
      accountAssignmentGroup: '',
      completeDelivery: false,
      orderCombination: false,
      isBlocked: false,
    }).catch(ignoreExisting);
  }
  void company;
}

/**
 * The risk category a credit record names.
 *
 * GAP (02-gap-list.md A11): the product ships no risk category and exposes no service to create
 * one — the credit master only reads them. The existing provisioner writes the row directly for
 * exactly this reason, and this installer follows that documented precedent rather than writing
 * a customer credit record against a category the screen could never have created.
 */
async function ensureRiskCategory(client: string, code: string, name: string): Promise<void> {
  await withTenant(client, async (tx) => {
    await tx.execute(sql`
      insert into credit_risk_category (client, risk_category, name, is_active, created_by)
      values (${client}, ${code}, ${name}, true, ${IN01_ACTOR})
      on conflict (client, risk_category) do nothing
    `);
  });
}

/** The credit limit the fixture gives, in the credit control area's currency. */
async function ensureCredit(
  client: string,
  structure: FixtureSet['core']['structure'],
  customer: Record<string, unknown>,
): Promise<boolean> {
  const limit = String(customer.creditLimit ?? '0');
  if (Number(limit) <= 0) return false;
  await saveCustomerCredit({
    client,
    changedBy: IN01_ACTOR,
    customer: String(customer.number),
    creditControlArea: structure.creditControlArea,
    creditLimit: limit,
    riskCategory: '001',
    isBlocked: false,
    changeReason: 'Phase 2 master data: opening credit limit',
  }).catch(ignoreExisting);
  return true;
}

/** Selling prices per material, at the distributor price level. */
async function ensureSellingPricesFor(
  client: string,
  structure: FixtureSet['core']['structure'],
  company: FixtureSet['company'],
  customerNumber: string,
): Promise<number> {
  let written = 0;
  // A price that already stands for this customer and material is adopted: a second record
  // covering the same period is an overlap the service rightly refuses.
  const standing = await listSalesConditions(client, { customerNumber }).catch(() => []);
  for (const [materialNumber, levels] of Object.entries(company.sellingPrices)) {
    const price = levels.PL02 ?? levels.PL01;
    if (!price) continue;
    if (standing.some((row) => (row as { materialNumber?: string }).materialNumber === materialNumber)) continue;
    await saveSalesCondition({
      client,
      changedBy: IN01_ACTOR,
      conditionType: 'PR00',
      materialNumber,
      customerNumber,
      salesOrg: structure.salesOrg,
      distributionChannel: structure.distributionChannel,
      division: structure.division,
      currency: 'INR',
      amount: Number(price),
      priceUnit: 1,
      validityFrom: '2026-04-01',
      validityTo: '2027-03-31',
    }).then(() => { written += 1; }).catch(ignoreExisting);
  }
  return written;
}
