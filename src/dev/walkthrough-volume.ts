/**
 * Development-only walkthrough volume scenario.
 *
 * The walkthrough seed proper (`walkthrough-seed.ts`) proves one complete, exactly
 * reconciled end-to-end chain: one purchase order, one receipt, one invoice, one
 * production order, one sale. It keeps every figure a literal so a reviewer can
 * follow the money. This module answers the other question — what the tenant looks
 * like when it carries realistic volume — and it is additive: it never touches the
 * three walkthrough materials (`RAW-STEEL`, `PACK-CARTON`, `FG-BRACKET`) and never
 * changes an amount the walkthrough reconciles.
 *
 * Everything here goes through the same ordinary domain services the screens use.
 * Nothing is written with SQL, no authorization check is bypassed, and the services
 * that ask for a capability are handed the capability the walkthrough administrator
 * holds. Every document carries its own request key, so a re-run with the same
 * database, tenant and date resumes where a previous attempt stopped.
 *
 * Two deliberate limits, both repeated in the seed's out-of-scope note:
 *  - Payroll *results* are not fabricated. `src/modules/people` defines pay components
 *    and their G/L mapping, but the amount paid comes from an imported payroll result
 *    or a future rule engine (DV-001 refuses guessed statutory logic for AE).
 *  - Employee records are unmistakably synthetic: numbered sample names, no realistic
 *    contact details, no national identifiers.
 */

import { sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../platform/db/client';

import { getMaterialDetail, saveMaterialView } from '../modules/inventory/materials';
import { getBusinessPartner, saveBusinessPartner } from '../modules/foundation/business-partners';
import { getCustomerCompany, saveCustomerCompany } from '../modules/foundation/customer-companies';
import { getSupplierCompany, saveSupplierCompany } from '../modules/foundation/supplier-companies';
import { getSupplierPurchasing, saveSupplierPurchasing } from '../modules/foundation/supplier-purchasing';
import { getCustomerSalesArea, saveCustomerSalesArea } from '../modules/foundation/customer-sales-areas';
import { getCustomerCredit, saveCustomerCredit } from '../modules/finance/credit';
import { listSalesConditions, saveSalesCondition } from '../modules/sales/conditions';

import { createMaterialBom, getMaterialBom } from '../modules/production/material-bom';
import { createRouting, getRouting } from '../modules/production/routing';
import { createProductionVersion, getProductionVersion } from '../modules/production/production-version';
import { createPlannedOrder } from '../modules/production/planned-order-create';
import { CONVERSION_LIMIT, convertPlannedOrders } from '../modules/production/planned-order-conversion';
import { getProductionOrder, releaseProductionOrder } from '../modules/inventory/production-orders';
import { postGoodsIssue } from '../modules/inventory/goods-issue';
import { postProductionReceipt } from '../modules/inventory/production-receipt';

import { createOrder, getOrder } from '../modules/purchasing/orders';
import { postGoodsReceipt } from '../modules/inventory/goods-receipt';
import { postSupplierInvoice } from '../modules/purchasing/invoice-verification';
import { getPayables, postOutgoingPayment } from '../modules/finance/outgoing-payment';
import { getVendorClearing } from '../modules/finance/vendor-clearing';

import { openLot } from '../modules/quality/lot';
import { listCharacteristics, listInspectionResults, recordInspectionResult, saveCharacteristic } from '../modules/quality/inspection-results';
import { getUsageDecisionView, postUsageDecisionWithStock } from '../modules/quality/usage-decision';

import { createSalesOrder, getSalesOrder } from '../modules/sales/sales-order';
import { confirmDeliveryPicks, createDelivery, getDelivery, postDeliveryGoodsIssue } from '../modules/sales/delivery';
import { createBillingFromDelivery } from '../modules/sales/billing';
import { getReceivables, postIncomingPayment } from '../modules/finance/incoming-payment';
import { getCustomerClearing } from '../modules/finance/customer-clearing';

import { listCostCenters, saveCostCenter } from '../modules/foundation/cost-center-definition';
import { createEmployee, createRecord, listEmployees } from '../modules/people/employee-master';
import { defineRecordType, getRecordType } from '../modules/people/record-types';
import { defineJob, defineOrgUnit, definePosition, listJobs, listOrgUnits, listPositions } from '../modules/people/org-structure';
import { assignmentsOf, assignPosition } from '../modules/people/assignment';
import {
  decideAbsence, defineTimeType, getTimeRecording, listTimeTypes, recordTime, requestAbsence, setLeaveQuota,
  TIME_ENTER_CAPABILITY,
} from '../modules/people/time-leave';
import { definePayComponent, listPayComponents, savePayComponentMapping } from '../modules/people/pay-components';
import {
  ASSIGNMENT_CAPABILITY, EMPLOYEE_CAPABILITY, ORG_UNIT_CAPABILITY, PAY_COMPONENT_CAPABILITY,
  POSITION_CAPABILITY, RECORD_CAPABILITY, RECORD_TYPE_CAPABILITY,
} from '../modules/people/schema';

/* ── Scenario size ──────────────────────────────────────────────────────────── */

const RAW_COUNT = 12;
const PACK_COUNT = 10;
const FG_COUNT = 30;
const SUPPLIER_COUNT = 20;
const CUSTOMER_COUNT = 50;
const PRODUCTION_ORDERS = 50;
const ORDER_QUANTITY = 10; // pieces built by each production order
const SALE_QUANTITY = 5;   // pieces per sales order; two sales orders consume one production order
const EMPLOYEE_COUNT = 25;
const ORG_UNIT_COUNT = 6;
const POSITION_COUNT = 12;

/** Purchase lots are whole multiples of this, so five per cent tax is exact to the fil. */
const LOT = 20;

/**
 * Leave quotas, in days, for the volume time types that reduce a quota. Every type an
 * absence can use needs one: approving an absence against a type with no quota row is
 * refused, whatever the entitlement of another type says.
 */
const QUOTAS = [
  { timeTypeCode: 'ANNLV', entitlement: '25.00' },
  { timeTypeCode: 'SICKL', entitlement: '10.00' },
] as const;

/* ── Deterministic master data ──────────────────────────────────────────────── */

type MaterialKind = 'RAW' | 'PACK' | 'FG';

interface MaterialSpec {
  number: string;
  description: string;
  kind: MaterialKind;
  materialType: 'RAW' | 'FIN';
  group: 'RAW' | 'PACKAGING' | 'PRODUCTS';
  unit: 'KG' | 'PC';
  procurement: 'BUY' | 'MAKE';
  priceControl: 'MOVING_AVERAGE' | 'STANDARD';
  valuationClass: 'RAW_INVENTORY' | 'FINISHED_INVENTORY';
  price: number;
}

const pad = (index: number) => String(index + 1).padStart(2, '0');

const MATERIALS: MaterialSpec[] = [
  ...Array.from({ length: RAW_COUNT }, (_, i): MaterialSpec => ({
    number: `RAW-V${pad(i)}`, description: `Volume raw material ${pad(i)}`, kind: 'RAW',
    materialType: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY',
    priceControl: 'MOVING_AVERAGE', valuationClass: 'RAW_INVENTORY', price: 4 + (i % 5),
  })),
  ...Array.from({ length: PACK_COUNT }, (_, i): MaterialSpec => ({
    number: `PACK-V${pad(i)}`, description: `Volume packaging ${pad(i)}`, kind: 'PACK',
    materialType: 'RAW', group: 'PACKAGING', unit: 'PC', procurement: 'BUY',
    priceControl: 'MOVING_AVERAGE', valuationClass: 'RAW_INVENTORY', price: 2 + (i % 3),
  })),
  ...Array.from({ length: FG_COUNT }, (_, i): MaterialSpec => ({
    number: `FG-V${pad(i)}`, description: `Volume finished good ${pad(i)}`, kind: 'FG',
    materialType: 'FIN', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE',
    priceControl: 'STANDARD', valuationClass: 'FINISHED_INVENTORY', price: 100 + 5 * i,
  })),
];

const materialOf = (kind: MaterialKind, index: number) =>
  MATERIALS.find((m) => m.kind === kind && m.number === (kind === 'RAW' ? `RAW-V${pad(index)}` : kind === 'PACK' ? `PACK-V${pad(index)}` : `FG-V${pad(index)}`))!;

const SUPPLIER_OF = (index: number) => `S-V${pad(index)}`;
const CUSTOMER_OF = (index: number) => `C-V${pad(index)}`;

const roundUpTo = (value: number, step: number) => Math.ceil(value / step) * step;
const round2 = (value: number) => Math.round(value * 100) / 100;
const salePriceOf = (standardPrice: number) => Math.max(standardPrice + 40, Math.round((standardPrice * 1.6) / LOT) * LOT);

/* ── Context and result ─────────────────────────────────────────────────────── */

export interface VolumeAuthorization { userId: string; sessionId: string }

export interface VolumeDates {
  po: string; gr: string; invoice: string; productionStart: string; productionFinish: string;
  issue: string; receipt: string; sales: string; delivery: string; billing: string;
}

export interface VolumeContext {
  tenant: string;
  /** The signed-in walkthrough administrator; used as `changedBy` on every write. */
  actor: string;
  authorization: VolumeAuthorization;
  company: string;
  plant: string;
  storage: string;
  purchasingOrg: string;
  purchasingGroup: string;
  salesOrg: string;
  channel: string;
  division: string;
  chart: string;
  currency: string;
  taxCode: string;
  creditControlArea: string;
  controllingArea: string;
  requestPrefix: string;
  dates: VolumeDates;
  record: (label: string, created: boolean) => void;
}

export interface VolumeCounts {
  materials: number;
  suppliers: number;
  customers: number;
  purchaseOrders: number;
  goodsReceipts: number;
  supplierInvoices: number;
  inspectionLots: number;
  inspectionResults: number;
  productionOrders: number;
  salesOrders: number;
  deliveries: number;
  billingDocuments: number;
  employees: number;
  orgUnits: number;
  positions: number;
  absences: number;
  timeRecordings: number;
  payComponents: number;
}

const emptyCounts = (): VolumeCounts => ({
  materials: 0, suppliers: 0, customers: 0, purchaseOrders: 0, goodsReceipts: 0, supplierInvoices: 0,
  inspectionLots: 0, inspectionResults: 0, productionOrders: 0, salesOrders: 0, deliveries: 0,
  billingDocuments: 0, employees: 0, orgUnits: 0, positions: 0, absences: 0, timeRecordings: 0,
  payComponents: 0,
});

const phase = (name: string, error: unknown): never => {
  const detail = error instanceof Error ? error.message : String(error);
  throw new Error(`Walkthrough volume ${name} failed: ${detail}`);
};

/* ── Entry point ────────────────────────────────────────────────────────────── */

export async function runWalkthroughVolume(ctx: VolumeContext): Promise<VolumeCounts> {
  const counts = emptyCounts();
  const key = (name: string) => `${ctx.requestPrefix}-vol-${name}`;

  try {
    await ensureMaterials(ctx, counts);
  } catch (error) { phase('master-data phase', error); }
  try {
    await ensurePartners(ctx, counts);
  } catch (error) { phase('business-partner phase', error); }

  const plan = productionPlan();
  const purchases = purchasePlan(plan);

  try {
    await ensureProductionMasters(ctx);
  } catch (error) { phase('production-master phase', error); }
  try {
    await ensureSalesPrices(ctx, plan);
  } catch (error) { phase('sales-price phase', error); }
  try {
    await ensureQualityCharacteristics(ctx);
  } catch (error) { phase('quality-characteristic phase', error); }

  const receipts = await runOrThrow('purchasing phase', () => runPurchasing(ctx, purchases, counts, key));

  try {
    await runQualityInspection(ctx, receipts, counts, key);
  } catch (error) { phase('quality-inspection phase', error); }
  try {
    await runProduction(ctx, plan, counts, key);
  } catch (error) { phase('production phase', error); }
  try {
    await runSales(ctx, plan, counts, key);
  } catch (error) { phase('sales phase', error); }
  try {
    await runPayments(ctx, key);
  } catch (error) { phase('payment phase', error); }
  try {
    await runPeople(ctx, counts, key);
  } catch (error) { phase('HR phase', error); }

  await assertVolumeInvariants(ctx, plan, purchases);
  return counts;
}

async function runOrThrow<T>(name: string, body: () => Promise<T>): Promise<T> {
  try {
    return await body();
  } catch (error) {
    return phase(name, error);
  }
}

/* ── Master data ────────────────────────────────────────────────────────────── */

async function ensureMaterials(ctx: VolumeContext, counts: VolumeCounts): Promise<void> {
  for (const spec of MATERIALS) {
    const common = { client: ctx.tenant, materialNumber: spec.number, changedBy: ctx.actor, reason: 'Walkthrough volume master' };
    let detail = await getMaterialDetail(ctx.tenant, spec.number);
    let added = false;

    if (!detail) {
      await saveMaterialView({ ...common, view: 'BASIC', expectedVersion: 0, description: spec.description,
        materialType: spec.materialType, materialGroup: spec.group, baseUnit: spec.unit, industrySector: 'M',
        barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false });
      added = true;
      detail = await getMaterialDetail(ctx.tenant, spec.number);
    }

    const before = detail?.plants.find((row) => row.plant === ctx.plant);
    if (!before || before.mrpStatus === 'NOT_CREATED') {
      await saveMaterialView({ ...common, view: 'MRP', expectedVersion: before?.version ?? 0, plant: ctx.plant,
        mrpType: 'REQUIREMENTS', mrpController: '001', procurementType: spec.procurement, lotSizing: 'EXACT',
        fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0',
        plannedDeliveryDays: spec.procurement === 'BUY' ? 7 : 0, inHouseProductionDays: spec.procurement === 'MAKE' ? 2 : 0 });
      if (!before) added = true;
      detail = await getMaterialDetail(ctx.tenant, spec.number);
    }

    const plantView = detail?.plants.find((row) => row.plant === ctx.plant);
    if (spec.procurement === 'BUY' && (!plantView || plantView.purchasingStatus === 'NOT_CREATED')) {
      await saveMaterialView({ ...common, view: 'PURCHASING', expectedVersion: plantView?.version ?? 0, plant: ctx.plant,
        purchasingGroup: ctx.purchasingGroup, orderUnit: spec.unit, overdeliveryTolerance: '0',
        underdeliveryTolerance: '0', manufacturerPartNumber: '' });
      added = true;
      detail = await getMaterialDetail(ctx.tenant, spec.number);
    }

    if (!detail?.valuations.some((row) => row.valuationArea === ctx.plant)) {
      await saveMaterialView({ ...common, view: 'ACCOUNTING', expectedVersion: 0, plant: ctx.plant,
        valuationClass: spec.valuationClass, priceControl: spec.priceControl,
        standardPrice: spec.priceControl === 'STANDARD' ? spec.price.toFixed(4) : '0',
        movingAveragePrice: spec.priceControl === 'MOVING_AVERAGE' ? spec.price.toFixed(4) : '0', priceUnit: '1' });
      added = true;
    }

    ctx.record(`volume material ${spec.number}`, added);
    if (added) counts.materials += 1;
  }
}

async function ensurePartners(ctx: VolumeContext, counts: VolumeCounts): Promise<void> {
  for (let i = 0; i < SUPPLIER_COUNT; i += 1) {
    const number = SUPPLIER_OF(i);
    const existing = await getBusinessPartner(ctx.tenant, number);
    if (existing) {
      ctx.record(`volume supplier ${number}`, false);
    } else {
      await saveBusinessPartner({ client: ctx.tenant, partnerNumber: number, expectedVersion: 0, changedBy: ctx.actor,
        reason: 'Walkthrough volume supplier.', category: 'ORGANIZATION', name: `Volume Supplier ${pad(i)} LLC`,
        name2: '', searchTerm: number, country: 'AE', region: 'Dubai', street: 'Trade Centre', city: 'Dubai',
        postalCode: '', taxNumber: '', email: '', phone: '', roles: ['SUPPLIER'], isBlocked: false });
      counts.suppliers += 1;
      ctx.record(`volume supplier ${number}`, true);
    }

    const company = await getSupplierCompany(ctx.tenant, number, ctx.company);
    if (!company) {
      await saveSupplierCompany({ client: ctx.tenant, partnerNumber: number, companyCode: ctx.company,
        expectedVersion: 0, changedBy: ctx.actor, reason: 'Walkthrough volume supplier company setup.',
        reconciliationAccount: '200000', paymentTermsCode: 'NET30', paymentMethods: '', isBlocked: false });
    }

    const purchasing = await getSupplierPurchasing(ctx.tenant, number, ctx.purchasingOrg);
    if (!purchasing) {
      await saveSupplierPurchasing({ client: ctx.tenant, partnerNumber: number, purchasingOrg: ctx.purchasingOrg,
        expectedVersion: 0, changedBy: ctx.actor, reason: 'Walkthrough volume supplier purchasing setup.',
        orderCurrency: ctx.currency, purchasingGroup: ctx.purchasingGroup, incotermsCode: 'EXW',
        incotermsLocation: 'Dubai', paymentTermsCode: 'NET30', isBlocked: false });
    }
  }

  for (let i = 0; i < CUSTOMER_COUNT; i += 1) {
    const number = CUSTOMER_OF(i);
    const existing = await getBusinessPartner(ctx.tenant, number);
    if (existing) {
      ctx.record(`volume customer ${number}`, false);
    } else {
      await saveBusinessPartner({ client: ctx.tenant, partnerNumber: number, expectedVersion: 0, changedBy: ctx.actor,
        reason: 'Walkthrough volume customer.', category: 'ORGANIZATION', name: `Volume Customer ${pad(i)} LLC`,
        name2: '', searchTerm: number, country: 'AE', region: 'Dubai', street: 'Trade Centre', city: 'Dubai',
        postalCode: '', taxNumber: '', email: '', phone: '', roles: ['CUSTOMER'], isBlocked: false });
      counts.customers += 1;
      ctx.record(`volume customer ${number}`, true);
    }

    const company = await getCustomerCompany(ctx.tenant, number, ctx.company);
    if (!company) {
      await saveCustomerCompany({ client: ctx.tenant, partnerNumber: number, companyCode: ctx.company,
        expectedVersion: 0, changedBy: ctx.actor, reason: 'Walkthrough volume customer company setup.',
        reconciliationAccount: '110000', paymentTermsCode: 'NET30', paymentMethods: '', dunningProcedure: '',
        isBlocked: false });
    }

    const area = await getCustomerSalesArea(ctx.tenant, number, ctx.salesOrg, ctx.channel, ctx.division);
    if (!area) {
      await saveCustomerSalesArea({ client: ctx.tenant, partnerNumber: number, salesOrg: ctx.salesOrg,
        distributionChannel: ctx.channel, division: ctx.division, expectedVersion: 0, changedBy: ctx.actor,
        reason: 'Walkthrough volume customer sales setup.', salesDistrict: 'DXB', deliveringPlant: ctx.plant,
        pricingProcedure: 'PR01', accountAssignmentGroup: '001',
        completeDelivery: false, orderCombination: false, isBlocked: false });
    }

    const credit = await getCustomerCredit(ctx.tenant, number, ctx.creditControlArea);
    if (!credit) {
      await saveCustomerCredit({ client: ctx.tenant, changedBy: ctx.actor, customer: number,
        creditControlArea: ctx.creditControlArea, creditLimit: '250000', riskCategory: 'A', isBlocked: false,
        changeReason: 'Walkthrough volume credit setup.' });
    }
  }
}

/* ── Production masters ─────────────────────────────────────────────────────── */

interface ProductionStep { index: number; fgIndex: number; quantity: number }
interface PurchaseLine { spec: MaterialSpec; quantity: number; price: number }
interface PurchaseOrder { index: number; supplier: string; lines: PurchaseLine[] }

function productionPlan(): ProductionStep[] {
  return Array.from({ length: PRODUCTION_ORDERS }, (_, k) => ({
    index: k,
    fgIndex: k < 40 ? k % 20 : 20 + (k - 40),
    quantity: ORDER_QUANTITY,
  }));
}

function purchasePlan(plan: ProductionStep[]): PurchaseOrder[] {
  const rawRequired = new Array<number>(RAW_COUNT).fill(0);
  const packRequired = new Array<number>(PACK_COUNT).fill(0);
  for (const step of plan) {
    rawRequired[step.fgIndex % RAW_COUNT] += step.quantity * 2;
    packRequired[step.fgIndex % PACK_COUNT] += step.quantity * 1;
  }

  const orders: PurchaseOrder[] = Array.from({ length: SUPPLIER_COUNT * 2 }, (_, index) => ({
    index, supplier: SUPPLIER_OF(index % SUPPLIER_COUNT), lines: [],
  }));

  // One component per order: the first eighteen ship in two deliveries, the rest in one.
  const components: Array<{ spec: MaterialSpec; required: number }> = [
    ...rawRequired.map((required, i) => ({ spec: materialOf('RAW', i), required })),
    ...packRequired.map((required, i) => ({ spec: materialOf('PACK', i), required })),
  ];
  components.forEach(({ spec, required }, m) => {
    const total = roundUpTo(required, LOT);
    const split = m < 18;
    const perOrder = split ? roundUpTo(total / 2, LOT) : total;
    orders[m].lines.push({ spec, quantity: perOrder, price: spec.price });
    if (split) orders[m + 22].lines.push({ spec, quantity: total - perOrder, price: spec.price });
  });

  return orders.filter((order) => order.lines.length > 0);
}

async function ensureProductionMasters(ctx: VolumeContext): Promise<void> {
  for (let f = 0; f < FG_COUNT; f += 1) {
    const fg = materialOf('FG', f);
    const raw = materialOf('RAW', f % RAW_COUNT);
    const pack = materialOf('PACK', f % PACK_COUNT);
    const routingGroup = String(50000100 + f);
    const groupCounter = '01';

    const routing = await getRouting(ctx.tenant, 'N', routingGroup, groupCounter, ctx.dates.po);
    if (routing) {
      ctx.record(`volume routing ${fg.number}`, false);
    } else {
      await createRouting({ client: ctx.tenant, changedBy: ctx.actor, taskListType: 'N', plant: ctx.plant, usage: '1',
        routingGroup, groupCounter, baseQuantity: '1', baseUnit: 'PC', validFrom: ctx.dates.po,
        assignments: [{ materialNumber: fg.number }],
        operations: [{ operationNumber: '0010', shortText: `Assemble ${fg.number}`, workCenter: 'WC01', controlKey: 'PP01' }] });
      ctx.record(`volume routing ${fg.number}`, true);
    }

    const bom = await getMaterialBom(ctx.tenant, fg.number, ctx.plant, 'P', '01');
    if (bom) {
      ctx.record(`volume BOM ${fg.number}`, false);
    } else {
      await createMaterialBom({ client: ctx.tenant, changedBy: ctx.actor, materialNumber: fg.number, plant: ctx.plant,
        usage: 'P', alternative: '01', baseQuantity: '1', baseUnit: 'PC', validFrom: ctx.dates.po,
        items: [
          { itemNumber: '0010', itemCategory: 'S', componentMaterial: raw.number, quantity: '2', unit: 'KG', validFrom: ctx.dates.po },
          { itemNumber: '0020', itemCategory: 'S', componentMaterial: pack.number, quantity: '1', unit: 'PC', validFrom: ctx.dates.po },
        ] });
      ctx.record(`volume BOM ${fg.number}`, true);
    }

    const version = await getProductionVersion(ctx.tenant, fg.number, ctx.plant, '0001');
    if (version) {
      ctx.record(`volume production version ${fg.number}`, false);
    } else {
      await createProductionVersion({ client: ctx.tenant, changedBy: ctx.actor, materialNumber: fg.number, plant: ctx.plant,
        productionVersion: '0001', description: `Volume build ${fg.number}`, validFrom: ctx.dates.po,
        lotFrom: '0', lotTo: '999999', lotUnit: 'PC', bomUsage: 'P', bomAlternative: '01', taskListType: 'N',
        routingGroup, groupCounter, receivingStorageLocation: ctx.storage,
        requestKey: `${ctx.requestPrefix}-vol-pv-${fg.number}` });
      ctx.record(`volume production version ${fg.number}`, true);
    }
  }
}

async function ensureSalesPrices(ctx: VolumeContext, plan: ProductionStep[]): Promise<void> {
  const wanted = new Map<string, { customer: string; material: string; amount: number }>();
  for (const step of plan) {
    // Two sales orders consume each production order; customers rotate.
    for (const half of [0, 1]) {
      const saleIndex = step.index * 2 + half;
      const customer = CUSTOMER_OF(saleIndex % CUSTOMER_COUNT);
      const fg = materialOf('FG', step.fgIndex);
      wanted.set(`${customer}/${fg.number}`, { customer, material: fg.number, amount: salePriceOf(fg.price) });
    }
  }

  for (const { customer, material, amount } of wanted.values()) {
    const standing = await listSalesConditions(ctx.tenant, { customerNumber: customer, materialNumber: material });
    if (standing.some((row) => row.validityFrom === ctx.dates.sales)) {
      ctx.record(`volume sales price ${customer}/${material}`, false);
      continue;
    }
    await saveSalesCondition({ client: ctx.tenant, changedBy: ctx.actor, salesOrg: ctx.salesOrg,
      distributionChannel: ctx.channel, division: ctx.division, customerNumber: customer, materialNumber: material,
      currency: ctx.currency, amount, priceUnit: 1, validityFrom: ctx.dates.sales, validityTo: ctx.dates.delivery,
      supersedeStanding: false });
    ctx.record(`volume sales price ${customer}/${material}`, true);
  }
}

/* ── Purchasing ─────────────────────────────────────────────────────────────── */

interface VolumeReceipt { documentNumber: string; line: number; materialNumber: string }

async function runPurchasing(
  ctx: VolumeContext, orders: PurchaseOrder[], counts: VolumeCounts, key: (name: string) => string,
): Promise<VolumeReceipt[]> {
  const receipts: VolumeReceipt[] = [];

  for (const order of orders) {
    // A purchase order carries no request key — the service has no field for one — so a
    // re-run finds its order through the payload: the supplier, company, actor, material
    // and quantity of the single line this plan gives it.
    const line = order.lines[0];
    let orderNumber = await findVolumeOrder(ctx, order.supplier, line.spec.number, line.quantity);

    if (!orderNumber) {
      const created = await createOrder({ client: ctx.tenant, changedBy: ctx.actor, supplierNumber: order.supplier,
        purchasingOrg: ctx.purchasingOrg, purchasingGroup: ctx.purchasingGroup, companyCode: ctx.company,
        currency: ctx.currency,
        items: order.lines.map((line) => ({
          materialNumber: line.spec.number, shortText: `Volume buy ${line.spec.number}`, quantity: line.quantity,
          unit: line.spec.unit, netPrice: line.price, priceUnit: 1, plant: ctx.plant, storageLocation: ctx.storage,
          taxCode: ctx.taxCode, scheduleLines: [{ deliveryDate: ctx.dates.gr, quantity: line.quantity }],
        })) });
      orderNumber = created.orderNumber;
      counts.purchaseOrders += 1;
      ctx.record(`volume purchase order ${orderNumber}`, true);
    } else {
      ctx.record(`volume purchase order ${orderNumber}`, false);
    }

    const current = await getOrder(ctx.tenant, orderNumber);
    if (!current) throw new Error(`Volume purchase order ${orderNumber} is not readable.`);

    // The receipt writes into quality-inspection stock; the inspection phase releases it.
    const receiptKey = key(`gr-${order.index}`);
    let receiptNumber = await findRequestKey(ctx, 'material_document', receiptKey, 'material_document_number');
    if (!receiptNumber) {
      const receipt = await postGoodsReceipt({ client: ctx.tenant, changedBy: ctx.actor, orderNumber,
        documentDate: ctx.dates.gr, postingDate: ctx.dates.gr, headerText: 'Volume receipt',
        stockType: 'QUALITY', requestKey: receiptKey,
        lines: current.items.map((item) => ({ itemNumber: item.itemNumber, quantity: Number(item.quantity),
          storageLocation: ctx.storage })) },
        { authorization: ctx.authorization });
      if (receipt.status !== 'POSTED') throw new Error(`Volume goods receipt ${receipt.materialDocumentNumber} stands ${receipt.status}.`);
      receiptNumber = receipt.materialDocumentNumber;
      counts.goodsReceipts += 1;
      ctx.record(`volume goods receipt ${receiptNumber}`, true);
    } else {
      ctx.record(`volume goods receipt ${receiptNumber}`, false);
    }
    receipts.push({ documentNumber: receiptNumber, line: 1, materialNumber: current.items[0]?.materialNumber ?? '' });

    const netAmount = order.lines.reduce((sum, line) => sum + line.quantity * line.price, 0);
    const invoiceKey = key(`invoice-${order.index}`);
    const invoiced = await findRequestKey(ctx, 'supplier_invoice', invoiceKey, 'invoice_number');
    if (invoiced) {
      ctx.record(`volume supplier invoice ${invoiced}`, false);
    } else {
      const invoice = await postSupplierInvoice({ client: ctx.tenant, changedBy: ctx.actor, orderNumber,
        supplierReference: `WT-VOL-${ctx.tenant}-${pad(order.index)}`, invoiceDate: ctx.dates.invoice,
        postingDate: ctx.dates.invoice, grossAmount: round2(netAmount * 1.05),
        headerText: 'Volume invoice', requestKey: invoiceKey,
        lines: current.items.map((item) => ({ itemNumber: item.itemNumber, quantity: Number(item.quantity),
          netAmount: Number(item.quantity) * Number(item.netPrice), taxCode: ctx.taxCode })) });
      if (invoice.status !== 'POSTED') throw new Error(`Volume supplier invoice ${invoice.invoiceNumber} stands ${invoice.status}.`);
      counts.supplierInvoices += 1;
      ctx.record(`volume supplier invoice ${invoice.invoiceNumber}`, true);
    }
  }

  return receipts;
}

/* ── Quality ────────────────────────────────────────────────────────────────── */

const CHARACTERISTICS = [
  { characteristicCode: 'LENGTH', description: 'Length against nominal', characteristicType: 'QUANTITATIVE' as const,
    nominalValue: 100, tolerancePlus: 1, toleranceMinus: -1, unit: 'MM' },
  { characteristicCode: 'SURFACE', description: 'Surface finish', characteristicType: 'QUALITATIVE' as const,
    nominalValue: 0, unit: '' },
];

async function ensureQualityCharacteristics(ctx: VolumeContext): Promise<void> {
  const standing = await listCharacteristics(ctx.tenant);
  const codes = new Set(standing.map((row) => row.characteristicCode));
  for (const characteristic of CHARACTERISTICS) {
    if (codes.has(characteristic.characteristicCode)) {
      ctx.record(`volume inspection characteristic ${characteristic.characteristicCode}`, false);
      continue;
    }
    await saveCharacteristic({ ...characteristic, client: ctx.tenant, changedBy: ctx.actor });
    ctx.record(`volume inspection characteristic ${characteristic.characteristicCode}`, true);
  }
}

async function runQualityInspection(
  ctx: VolumeContext, receipts: VolumeReceipt[], counts: VolumeCounts, key: (name: string) => string,
): Promise<void> {
  for (const [index, receipt] of receipts.entries()) {
    const lot = await openLot({ client: ctx.tenant, changedBy: ctx.actor,
      materialDocumentNumber: receipt.documentNumber, lineNumber: receipt.line,
      inspectionNote: 'Volume incoming inspection', requestKey: key(`lot-${index}`) });
    ctx.record(`volume inspection lot ${lot.lotNumber}`, !lot.replayed);
    if (!lot.replayed) counts.inspectionLots += 1;

    // Results and decisions carry no request key of their own; both are read back
    // through the lot before anything is written.
    const recorded = await listInspectionResults(ctx.tenant, lot.lotNumber);
    const recordedCodes = new Set(recorded.map((row) => row.characteristicCode));
    for (const characteristic of CHARACTERISTICS) {
      if (recordedCodes.has(characteristic.characteristicCode)) continue;
      await recordInspectionResult({ client: ctx.tenant, changedBy: ctx.actor, lotNumber: lot.lotNumber,
        characteristicCode: characteristic.characteristicCode,
        resultValue: characteristic.characteristicType === 'QUANTITATIVE' ? '100' : 'OK',
        measuredUnit: characteristic.characteristicType === 'QUANTITATIVE' ? characteristic.unit : '',
        resultStatus: 'ACCEPTED', requestKey: key(`result-${index}-${characteristic.characteristicCode}`) });
      counts.inspectionResults += 1;
    }

    const standing = await getUsageDecisionView(ctx.tenant, lot.lotNumber);
    if (standing) {
      ctx.record(`volume usage decision ${lot.lotNumber}`, false);
      continue;
    }
    const decision = await postUsageDecisionWithStock({ client: ctx.tenant, changedBy: ctx.actor,
      lotNumber: lot.lotNumber, decisionCode: 'ACCEPT', decisionDate: ctx.dates.gr,
      requestKey: key(`decision-${index}`) });
    if (!decision.stockPosted) throw new Error(`Usage decision for lot ${lot.lotNumber} did not release the inspection stock.`);
    ctx.record(`volume usage decision ${lot.lotNumber}`, true);
  }
}

/* ── Production ─────────────────────────────────────────────────────────────── */

async function runProduction(
  ctx: VolumeContext, plan: ProductionStep[], counts: VolumeCounts, key: (name: string) => string,
): Promise<void> {
  const plannedNumbers: string[] = [];

  for (const step of plan) {
    const fg = materialOf('FG', step.fgIndex);
    const plannedKey = key(`planned-${step.index}`);
    const existing = await findRequestKey(ctx, 'planned_order', plannedKey, 'order_number');
    if (existing) {
      plannedNumbers.push(existing);
      ctx.record(`volume planned order ${existing}`, false);
      continue;
    }
    const created = await createPlannedOrder({ client: ctx.tenant, changedBy: ctx.actor, requestKey: plannedKey,
      materialNumber: fg.number, plant: ctx.plant, quantity: String(step.quantity), unit: fg.unit,
      startDate: ctx.dates.productionStart, finishDate: ctx.dates.productionFinish });
    plannedNumbers.push(created.order.orderNumber);
    ctx.record(`volume planned order ${created.order.orderNumber}`, true);
  }

  const productionNumbers: string[] = [];
  for (let offset = 0; offset < plannedNumbers.length; offset += CONVERSION_LIMIT) {
    const batch = plannedNumbers.slice(offset, offset + CONVERSION_LIMIT);
    const converted = await convertPlannedOrders({ client: ctx.tenant, changedBy: ctx.actor, orderNumbers: batch,
      correlationId: `${ctx.requestPrefix}-vol-convert-${offset}`, orderType: 'PP01', productionVersion: '0001' });
    for (const result of converted.results) {
      if (!result.productionOrderNumber) {
        throw new Error(`Planned order ${result.plannedOrderNumber} was not converted (${result.code}): ${result.message}`);
      }
      productionNumbers.push(result.productionOrderNumber);
      if (result.status === 'CONVERTED') counts.productionOrders += 1;
      ctx.record(`volume production order ${result.productionOrderNumber}`, result.status === 'CONVERTED');
    }
  }

  for (const orderNumber of productionNumbers) {
    const order = await getProductionOrder(ctx.tenant, orderNumber);
    if (!order) throw new Error(`Volume production order ${orderNumber} is not readable.`);

    const released = await releaseProductionOrder({ client: ctx.tenant, orderNumber, releasedBy: ctx.actor });
    if (released.status !== 'RELEASED') {
      throw new Error(`Volume production order ${orderNumber} stands ${released.status} after release.`);
    }

    const issueKey = key(`issue-${order.orderNumber}`);
    const issued = await findRequestKey(ctx, 'material_document', issueKey, 'material_document_number');
    if (issued) {
      ctx.record(`volume component issue ${issued}`, false);
    } else {
      await postGoodsIssue({ client: ctx.tenant, changedBy: ctx.actor, movementTypeCode: '261',
        postingDate: ctx.dates.issue, documentDate: ctx.dates.issue, headerText: 'Volume issue',
        requestKey: issueKey,
        lines: order.components.map((component) => ({ materialNumber: component.materialNumber, plant: component.plant,
          storageLocation: component.storageLocation || ctx.storage, quantity: Number(component.requiredQuantity),
          productionOrderNumber: order.orderNumber, productionOrderItem: component.itemNumber })) }, 'MIGO',
        { authorization: ctx.authorization });
      ctx.record(`volume component issue ${issueKey}`, true);
    }

    const receiptKey = key(`receipt-${order.orderNumber}`);
    const received = await findRequestKey(ctx, 'material_document', receiptKey, 'material_document_number');
    if (received) {
      ctx.record(`volume production receipt ${received}`, false);
    } else {
      const receipt = await postProductionReceipt({ client: ctx.tenant, changedBy: ctx.actor, orderNumber: order.orderNumber,
        postingDate: ctx.dates.receipt, documentDate: ctx.dates.receipt, headerText: 'Volume output',
        requestKey: receiptKey,
        lines: [{ storageLocation: ctx.storage, quantity: Number(order.orderQuantity), entryUnit: 'PC' }] });
      if (!Number(receipt.receivedAfter)) throw new Error(`Volume production receipt for ${orderNumber} recorded no output.`);
      ctx.record(`volume production receipt ${receipt.materialDocumentNumber}`, true);
    }
  }
}

/* ── Sales ──────────────────────────────────────────────────────────────────── */

async function runSales(
  ctx: VolumeContext, plan: ProductionStep[], counts: VolumeCounts, key: (name: string) => string,
): Promise<void> {
  for (const step of plan) {
    const fg = materialOf('FG', step.fgIndex);
    for (const half of [0, 1]) {
      const saleIndex = step.index * 2 + half;
      const customer = CUSTOMER_OF(saleIndex % CUSTOMER_COUNT);

      const orderKey = key(`so-${saleIndex}`);
      let orderNumber = await findRequestKey(ctx, 'sales_order', orderKey, 'order_number');
      if (!orderNumber) {
        const created = await createSalesOrder({ client: ctx.tenant, changedBy: ctx.actor, salesOrg: ctx.salesOrg,
          distributionChannel: ctx.channel, division: ctx.division, customerNumber: customer, companyCode: ctx.company,
          currency: ctx.currency, orderDate: ctx.dates.sales, requestKey: orderKey,
          lines: [{ materialNumber: fg.number, plant: ctx.plant, orderQuantity: SALE_QUANTITY, quantityUnit: 'PC',
            taxCode: ctx.taxCode }] });
        orderNumber = created.orderNumber;
        counts.salesOrders += 1;
        ctx.record(`volume sales order ${orderNumber}`, true);
      } else {
        ctx.record(`volume sales order ${orderNumber}`, false);
      }

      const salesOrder = await getSalesOrder(ctx.tenant, orderNumber);
      if (!salesOrder || salesOrder.lines.length !== 1) {
        throw new Error(`Volume sales order ${orderNumber} is not readable or carries an unexpected line count.`);
      }

      const deliveryKey = key(`delivery-${saleIndex}`);
      let deliveryNumber = await findRequestKey(ctx, 'delivery', deliveryKey, 'delivery_number');
      if (!deliveryNumber) {
        const created = await createDelivery({ client: ctx.tenant, changedBy: ctx.actor, orderNumber,
          deliveryDate: ctx.dates.delivery, goodsMovementDate: ctx.dates.delivery,
          items: [{ orderLineNumber: salesOrder.lines[0].lineNumber, quantity: String(SALE_QUANTITY) }],
          requestKey: deliveryKey });
        deliveryNumber = created.deliveryNumber;
        counts.deliveries += 1;
        ctx.record(`volume delivery ${deliveryNumber}`, true);
      } else {
        ctx.record(`volume delivery ${deliveryNumber}`, false);
      }

      let delivery = await getDelivery(ctx.tenant, deliveryNumber);
      if (!delivery) throw new Error(`Volume delivery ${deliveryNumber} is not readable.`);
      if (delivery.status !== 'GOODS_ISSUED') {
        if (delivery.status !== 'PICKED') {
          delivery = await confirmDeliveryPicks({ client: ctx.tenant, changedBy: ctx.actor, deliveryNumber,
            expectedVersion: delivery.version, requestKey: key(`pick-${saleIndex}`),
            items: [{ lineNumber: delivery.lines[0].lineNumber, quantity: delivery.lines[0].deliveryQuantity,
              storageLocation: ctx.storage }] });
        }
        await postDeliveryGoodsIssue({ client: ctx.tenant, changedBy: ctx.actor, deliveryNumber,
          expectedVersion: delivery.version, postingDate: ctx.dates.delivery, documentDate: ctx.dates.delivery });
        delivery = await getDelivery(ctx.tenant, deliveryNumber) ?? delivery;
      }
      if (delivery.status !== 'GOODS_ISSUED') {
        throw new Error(`Volume delivery ${deliveryNumber} stands ${delivery.status} after the lifecycle steps.`);
      }

      const billingKey = key(`billing-${saleIndex}`);
      const billed = await findRequestKey(ctx, 'billing_document', billingKey, 'billing_number');
      if (billed) {
        ctx.record(`volume billing ${billed}`, false);
        continue;
      }
      const billing = await createBillingFromDelivery({ client: ctx.tenant, changedBy: ctx.actor, deliveryNumber,
        billingDate: ctx.dates.billing, requestKey: billingKey });
      if (billing.heldForCredit) throw new Error(`Volume billing for delivery ${deliveryNumber} was held for credit.`);
      if (billing.billing.status !== 'POSTED') {
        throw new Error(`Volume billing ${billing.billing.billingNumber} stands ${billing.billing.status}.`);
      }
      counts.billingDocuments += 1;
      ctx.record(`volume billing ${billing.billing.billingNumber}`, true);
    }
  }
}

/* ── Settlement ─────────────────────────────────────────────────────────────── */

async function runPayments(ctx: VolumeContext, key: (name: string) => string): Promise<void> {
  for (let i = 0; i < SUPPLIER_COUNT; i += 1) {
    const supplier = SUPPLIER_OF(i);
    const paymentKey = key(`ap-${i}`);
    const paid = await findRequestKey(ctx, 'outgoing_payment', paymentKey, 'payment_number');
    if (paid) {
      ctx.record(`volume supplier payment ${paid}`, false);
    } else {
      const payables = await getPayables(ctx.tenant, supplier, ctx.company);
      if (payables.openItems.length > 0) {
        const payment = await postOutgoingPayment({ client: ctx.tenant, changedBy: ctx.actor, vendorNumber: supplier,
          companyCode: ctx.company, documentDate: ctx.dates.billing, postingDate: ctx.dates.billing,
          clearingDate: ctx.dates.billing, bankGlAccount: '101000', amount: round2(payables.openBalance),
          currency: ctx.currency, reference: `WT-VOL-AP-${pad(i)}`, requestKey: paymentKey,
          items: payables.openItems.map((item) => ({ documentNumber: item.documentNumber, fiscalYear: item.fiscalYear,
            lineNumber: item.lineNumber })) });
        if (payment.itemsCleared < 1) throw new Error(`Volume supplier payment ${payment.paymentNumber} cleared no open item.`);
        ctx.record(`volume supplier payment ${payment.paymentNumber}`, true);
      }
    }
    const clearing = await getVendorClearing(ctx.tenant, supplier, ctx.company);
    if (clearing.openItems.length !== 0) {
      throw new Error(`Supplier ${supplier} still carries ${clearing.openItems.length} open item(s) after the volume payment.`);
    }
  }

  for (let i = 0; i < CUSTOMER_COUNT; i += 1) {
    const customer = CUSTOMER_OF(i);
    const paymentKey = key(`ar-${i}`);
    const paid = await findRequestKey(ctx, 'incoming_payment', paymentKey, 'payment_number');
    if (paid) {
      ctx.record(`volume customer payment ${paid}`, false);
    } else {
      const receivables = await getReceivables(ctx.tenant, customer, ctx.company);
      if (receivables.openItems.length > 0) {
        const payment = await postIncomingPayment({ client: ctx.tenant, changedBy: ctx.actor, customerNumber: customer,
          companyCode: ctx.company, documentDate: ctx.dates.billing, postingDate: ctx.dates.billing,
          clearingDate: ctx.dates.billing, bankGlAccount: '101000', amount: round2(receivables.openBalance),
          currency: ctx.currency, reference: `WT-VOL-AR-${pad(i)}`, requestKey: paymentKey,
          items: receivables.openItems.map((item) => ({ documentNumber: item.documentNumber, fiscalYear: item.fiscalYear,
            lineNumber: item.lineNumber })) });
        ctx.record(`volume customer payment ${payment.paymentNumber}`, true);
      }
    }
    const clearing = await getCustomerClearing(ctx.tenant, customer, ctx.company);
    if (clearing.openItems.length !== 0) {
      throw new Error(`Customer ${customer} still carries ${clearing.openItems.length} open item(s) after the volume receipt.`);
    }
  }
}

/* ── HR: master data, time and leave, pay components. No payroll results. ───── */

async function runPeople(ctx: VolumeContext, counts: VolumeCounts, key: (name: string) => string): Promise<void> {
  const costCenter = await ensureCostCenter(ctx);
  await ensureRecordType(ctx);

  const units = await listOrgUnits(ctx.tenant);
  const unitCodes = new Set(units.map((row) => row.code));
  for (let i = 0; i < ORG_UNIT_COUNT; i += 1) {
    const code = `OUV${pad(i)}`;
    if (unitCodes.has(code)) {
      ctx.record(`volume org unit ${code}`, false);
      continue;
    }
    await defineOrgUnit({ client: ctx.tenant, code, name: `Volume unit ${pad(i)}`,
      description: 'Volume organisational unit', parentCode: i === 0 ? undefined : 'OUV01',
      changedBy: ctx.actor }, [ORG_UNIT_CAPABILITY]);
    counts.orgUnits += 1;
    ctx.record(`volume org unit ${code}`, true);
  }

  const jobs = await listJobs(ctx.tenant);
  const jobCodes = new Set(jobs.map((row) => row.code));
  for (let i = 0; i < 4; i += 1) {
    const code = `JOBV${pad(i)}`;
    if (jobCodes.has(code)) {
      ctx.record(`volume job ${code}`, false);
      continue;
    }
    await defineJob({ client: ctx.tenant, code, name: `Volume job ${pad(i)}`, description: 'Volume job',
      changedBy: ctx.actor }, [POSITION_CAPABILITY]);
    ctx.record(`volume job ${code}`, true);
  }

  const positions = await listPositions(ctx.tenant);
  const positionCodes = new Set(positions.map((row) => row.code));
  const positionNumbers: string[] = [];
  for (let i = 0; i < POSITION_COUNT; i += 1) {
    const code = `POSV${pad(i)}`;
    if (positionCodes.has(code)) {
      ctx.record(`volume position ${code}`, false);
    } else {
      await definePosition({ client: ctx.tenant, code, title: `Volume position ${pad(i)}`,
        jobCode: `JOBV${pad(i % 4)}`, orgUnitCode: `OUV${pad(i % ORG_UNIT_COUNT)}`,
        description: 'Volume position', changedBy: ctx.actor }, [POSITION_CAPABILITY]);
      counts.positions += 1;
      ctx.record(`volume position ${code}`, true);
    }
    positionNumbers.push(code);
  }

  const employees = await listEmployees(ctx.tenant);
  const standing = new Set(employees.map((row) => row.personnelNumber));

  for (let i = 0; i < EMPLOYEE_COUNT; i += 1) {
    const personnelNumber = `EMPV${pad(i)}`;

    if (standing.has(personnelNumber)) {
      ctx.record(`volume employee ${personnelNumber}`, false);
    } else {
      await createEmployee({ client: ctx.tenant, personnelNumber, fullName: `SAMPLE EMPLOYEE ${pad(i)}`,
        isActive: true, changedBy: ctx.actor, requestKey: key(`employee-${i}`) }, [EMPLOYEE_CAPABILITY]);
      counts.employees += 1;
      ctx.record(`volume employee ${personnelNumber}`, true);
    }

    const recordKey = key(`employee-record-${i}`);
    if (!(await findRequestKey(ctx, 'employee_record', recordKey, 'personnel_number'))) {
      await createRecord({ client: ctx.tenant, personnelNumber, recordType: 'EMPBAS', validFrom: ctx.dates.po,
        values: { TITLE: { text: `Volume job ${pad(i % 4)}` }, GRADE: { text: `G${1 + (i % 5)}` } },
        changedBy: ctx.actor, requestKey: recordKey }, [RECORD_CAPABILITY]);
    }

    const assignments = await assignmentsOf(ctx.tenant, personnelNumber);
    if (assignments.length === 0) {
      await assignPosition({ client: ctx.tenant, personnelNumber, positionCode: positionNumbers[i % POSITION_COUNT],
        controllingArea: ctx.controllingArea, costCenter, validFrom: ctx.dates.po, changedBy: ctx.actor,
        requestKey: key(`assignment-${i}`) }, [ASSIGNMENT_CAPABILITY]);
      ctx.record(`volume assignment ${personnelNumber}`, true);
    } else {
      ctx.record(`volume assignment ${personnelNumber}`, false);
    }
  }

  const timeTypes = [
    { code: 'ANNLV', name: 'Annual leave', typeKind: 'ABSENCE' as const, reducesQuota: true },
    { code: 'SICKL', name: 'Sick leave', typeKind: 'ABSENCE' as const, reducesQuota: true },
    { code: 'OVERT', name: 'Overtime', typeKind: 'OVERTIME' as const, reducesQuota: false },
  ];
  const standingTypes = new Set((await listTimeTypes(ctx.tenant)).map((row) => row.code));
  for (const timeType of timeTypes) {
    if (standingTypes.has(timeType.code)) {
      ctx.record(`volume time type ${timeType.code}`, false);
      continue;
    }
    await defineTimeType({ client: ctx.tenant, code: timeType.code, name: timeType.name,
      description: 'Volume time type', typeKind: timeType.typeKind, reducesQuota: timeType.reducesQuota,
      changedBy: ctx.actor }, [TIME_ENTER_CAPABILITY]);
    ctx.record(`volume time type ${timeType.code}`, true);
  }

  for (let i = 0; i < EMPLOYEE_COUNT; i += 1) {
    const personnelNumber = `EMPV${pad(i)}`;
    // Both absence types need a quota of their own: approving an absence that reduces
    // quota is refused outright when no quota row stands for that type and year.
    for (const quota of QUOTAS) {
      await setLeaveQuota({ client: ctx.tenant, personnelNumber, timeTypeCode: quota.timeTypeCode,
        year: ctx.dates.po.slice(0, 4), entitlement: quota.entitlement, changedBy: ctx.actor },
        [TIME_ENTER_CAPABILITY]);
    }

    if (i % 3 === 0) {
      const timeTypeCode = i % 6 === 0 ? 'SICKL' : 'ANNLV';
      const absenceKey = key(`absence-${i}`);
      if (!(await findRequestKey(ctx, 'absence', absenceKey, 'personnel_number'))) {
        await requestAbsence({ client: ctx.tenant, personnelNumber, timeTypeCode,
          validFrom: ctx.dates.sales, validTo: ctx.dates.delivery, reason: 'Volume absence',
          changedBy: ctx.actor, requestKey: absenceKey }, [TIME_ENTER_CAPABILITY]);
        await decideAbsence({ client: ctx.tenant, personnelNumber, timeTypeCode,
          validFrom: ctx.dates.sales, status: 'APPROVED', changedBy: ctx.actor }, [TIME_ENTER_CAPABILITY]);
        counts.absences += 1;
      }
    }

    const alreadyRecorded = await getTimeRecording(ctx.tenant, personnelNumber, 'OVERT', ctx.dates.receipt).then(
      () => true, () => false,
    );
    if (!alreadyRecorded) {
      await recordTime({ client: ctx.tenant, personnelNumber, timeTypeCode: 'OVERT',
        recordingDate: ctx.dates.receipt, hours: ((i % 4) + 1).toFixed(2), changedBy: ctx.actor },
        [TIME_ENTER_CAPABILITY]);
      counts.timeRecordings += 1;
    }
  }

  const components = [
    { code: 'BASICSAL', name: 'Basic salary', componentKind: 'EARNING' as const, debitAccount: '500000' },
    { code: 'HOUSALL', name: 'Housing allowance', componentKind: 'EARNING' as const, debitAccount: '500300' },
  ];
  const standingComponents = await listPayComponents(ctx.tenant);
  const componentCodes = new Set(standingComponents.map((row) => row.code));
  for (const component of components) {
    if (componentCodes.has(component.code)) {
      ctx.record(`volume pay component ${component.code}`, false);
    } else {
      await definePayComponent({ client: ctx.tenant, code: component.code, name: component.name,
        componentKind: component.componentKind, description: 'Volume pay component',
        changedBy: ctx.actor }, [PAY_COMPONENT_CAPABILITY]);
      counts.payComponents += 1;
      ctx.record(`volume pay component ${component.code}`, true);
    }
    // A second run finds the mapping already standing, and the service refuses to
    // create over it; the change mode restates the same values instead.
    const mapping = { client: ctx.tenant, componentCode: component.code, chartOfAccounts: ctx.chart,
      debitAccount: component.debitAccount, creditAccount: null, controllingArea: ctx.controllingArea,
      costCenter, changedBy: ctx.actor, costReceiverCategory: 'FIXED' as const };
    try {
      await savePayComponentMapping(mapping, 'CREATE', [PAY_COMPONENT_CAPABILITY]);
    } catch {
      await savePayComponentMapping(mapping, 'CHANGE', [PAY_COMPONENT_CAPABILITY]);
    }
  }
}

async function ensureCostCenter(ctx: VolumeContext): Promise<string> {
  const code = 'CCV01';
  const existing = await listCostCenters(ctx.tenant, ctx.controllingArea);
  if (existing.some((row) => row.costCenter === code)) return code;
  await saveCostCenter({ client: ctx.tenant, changedBy: ctx.actor, mode: 'CREATE',
    controllingArea: ctx.controllingArea, costCenter: code, validFrom: ctx.dates.po, validTo: '9999-12-31',
    name: 'Volume assembly', personResponsible: '', category: 'PRODUCTION', companyCode: ctx.company,
    reason: 'Walkthrough volume cost centre.' });
  return code;
}

async function ensureRecordType(ctx: VolumeContext): Promise<void> {
  const existing = await getRecordType(ctx.tenant, 'EMPBAS').then((row) => row ?? null, () => null);
  if (existing) return;
  await defineRecordType({ client: ctx.tenant, code: 'EMPBAS', name: 'Employment basics',
    description: 'Volume employee record type', changedBy: ctx.actor,
    fields: [
      { code: 'TITLE', label: 'Job title', valueKind: 'TEXT', isRequired: false, displayOrder: 1 },
      { code: 'GRADE', label: 'Grade', valueKind: 'TEXT', isRequired: false, displayOrder: 2 },
    ] }, [RECORD_TYPE_CAPABILITY]);
}

/* ── Invariants ─────────────────────────────────────────────────────────────── */

/**
 * Every volume material ends where the plan says it must: each finished good is
 * produced and then sold in equal measure, and each component ends at what was
 * bought less what the production orders consumed.
 */
async function assertVolumeInvariants(
  ctx: VolumeContext, plan: ProductionStep[], purchases: PurchaseOrder[],
): Promise<void> {
  const expected = new Map<string, number>();
  const produced = new Map<string, number>();

  for (const step of plan) {
    const fg = materialOf('FG', step.fgIndex);
    produced.set(fg.number, (produced.get(fg.number) ?? 0) + step.quantity);
    const raw = materialOf('RAW', step.fgIndex % RAW_COUNT);
    const pack = materialOf('PACK', step.fgIndex % PACK_COUNT);
    expected.set(raw.number, (expected.get(raw.number) ?? 0) - step.quantity * 2);
    expected.set(pack.number, (expected.get(pack.number) ?? 0) - step.quantity * 1);
  }
  for (const order of purchases) {
    for (const line of order.lines) {
      expected.set(line.spec.number, (expected.get(line.spec.number) ?? 0) + line.quantity);
    }
  }

  const rows = await withTenant(ctx.tenant, async (tx) => await tx.execute(sql`
    select s.material_number, coalesce(sum(s.quantity), 0)::text as quantity
      from stock_quantity s
     where s.client = ${ctx.tenant}
       and s.plant = ${ctx.plant}
       and (s.material_number like 'RAW-V%' or s.material_number like 'PACK-V%' or s.material_number like 'FG-V%')
     group by s.material_number
  `) as unknown as Array<{ material_number: string; quantity: string }>);

  const actual = new Map(rows.map((row) => [row.material_number, Number(row.quantity)]));
  const drift: string[] = [];
  for (const [material, quantity] of expected) {
    if (Math.abs((actual.get(material) ?? 0) - quantity) > 0.0005) {
      drift.push(`${material}: expected ${quantity}, found ${actual.get(material) ?? 0}`);
    }
  }
  for (const [material] of produced) {
    if (Math.abs(actual.get(material) ?? 0) > 0.0005) {
      drift.push(`${material}: expected 0 after sale, found ${actual.get(material) ?? 0}`);
    }
  }
  if (drift.length > 0) throw new Error(`Volume stock did not close as planned: ${drift.join('; ')}`);
}

/* ── Replay helpers ─────────────────────────────────────────────────────────── */

/** The purchase order this plan already wrote for one supplier line, or null. */
async function findVolumeOrder(
  ctx: VolumeContext, supplier: string, materialNumber: string, quantity: number,
): Promise<string | null> {
  return withTenant(ctx.tenant, async (tx: Tx) => {
    const rows = await tx.execute(sql`
      select o.order_number
        from public.purchase_order o
        join public.purchase_order_item i
          on i.client = o.client and i.order_number = o.order_number
       where o.client = ${ctx.tenant}
         and o.company_code = ${ctx.company}
         and o.supplier_number = ${supplier}
         and o.created_by = ${ctx.actor}
         and i.material_number = ${materialNumber}
         and i.quantity = ${quantity}::numeric
       order by o.order_number
       limit 1
    `) as unknown as Array<{ order_number: string }>;
    return rows[0]?.order_number ?? null;
  });
}

/**
 * The volume tables that carry a `request_key`. Both names are fixed literals in
 * this table, never caller input, so interpolating them into the statement is safe.
 */
const REQUEST_KEY_TABLES: Record<string, string> = {
  material_document: 'material_document_number',
  supplier_invoice: 'invoice_number',
  planned_order: 'order_number',
  sales_order: 'order_number',
  delivery: 'delivery_number',
  billing_document: 'billing_number',
  outgoing_payment: 'payment_number',
  incoming_payment: 'payment_number',
  employee_record: 'personnel_number',
  absence: 'personnel_number',
};

/** The number of the document already written for this request key, or null. */
async function findRequestKey(
  ctx: VolumeContext, table: string, requestKey: string, column: string,
): Promise<string | null> {
  if (REQUEST_KEY_TABLES[table] !== column) return null;
  return withTenant(ctx.tenant, async (tx: Tx) => {
    const relation = sql.raw(`public."${table}"`);
    const selected = sql.raw(`"${column}"`);
    const rows = await tx.execute(sql`
      select ${selected} from ${relation}
       where "client" = ${ctx.tenant} and request_key = ${requestKey}
       limit 1
    `) as unknown as Array<Record<string, string>>;
    const value = rows[0]?.[column];
    return typeof value === 'string' && value.length > 0 ? value : null;
  });
}
