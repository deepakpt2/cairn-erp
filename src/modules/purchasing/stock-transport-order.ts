/**
 * Stock transport order (STO) create and change — ITEM-22 (ME21N / ME22N, order type UB).
 *
 * An STO is a real purchase order header and items with schedule lines, but it has no supplier and no price:
 * the receiving plant orders, the supplying plant issues. The header company is the RECEIVING company; the
 * supplying plant may stand in the same company or in another company of the tenant. Nothing is invented to
 * fill the supplier column (it is null; a CHECK pins the shape) and no net value is invented either.
 *
 * Judged here, at the service boundary and not only on the screen: both plants exist, are active storage
 * sites and differ; the receiving plant belongs to the header company and is assigned to the purchasing
 * organisation; the material is extended to BOTH plants, converts into its base unit, and any stored batch
 * stands; the schedule lines sum to the item quantity exactly. Fields a stock transport order does not carry
 * (supplier, price, tax, conditions, quotation, contract, info record, account assignment, invoice control,
 * requisition, tolerances) are REFUSED by name, never ignored.
 *
 * Once stock has moved, the order is frozen where it matters: the supplying plant, the receiving plant,
 * the material, the unit and the batch of a moved item cannot change, the quantity cannot fall below what is
 * net issued, and an item with issued quantity cannot be flagged for deletion. A released order is not edited;
 * the existing release framework governs it (cancel the release, change, release again). A strategy that
 * judges on a value or a supplier cannot be evaluated for an STO and the order is refused rather than
 * treated as approved (`assertStoReleaseEvaluable`).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { companyCode, plant, purchasingGroup, purchasingOrg, storageLocation } from '../foundation/schema';
import {
  assertPurchasingOrgForPlant, PurchasingOrgPlantAuthorizationError,
} from '../foundation/purchasing-org-plant';
import { BatchPostingError, resolvePostingBatch } from '../inventory/batch-posting';
import { material, materialPlant } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import {
  ReleaseError, assertDocumentNotReleased, assertStoReleaseEvaluable, orderAttributes, syncDocumentRelease,
} from './release';
import {
  purchaseOrder, purchaseOrderItem, purchaseOrderScheduleLine,
} from './schema';
import { STO_ORDER_TYPE } from './sto-guard';

export { STO_ORDER_TYPE };
export const STO_RANGE_SUB_OBJECT = 'POF';
const PO_OBJECT_CLASS = 'purchase_order';

export class StoOrderError extends Error {
  remedy?: string;
  code?: string;

  constructor(message: string, remedy?: string, code?: string) {
    super(message);
    this.name = 'StoOrderError';
    this.remedy = remedy;
    this.code = code;
  }
}

/** The fields an STO does not carry, with the reason a person reads. Unknown fields are refused too. */
const UNSUPPORTED_FIELDS: Record<string, string> = {
  supplierNumber: 'it has no supplier; the supply source is the supplying plant',
  currency: 'it carries no price, so no order currency (the receiving company currency is used)',
  paymentTermsCode: 'it is never invoiced',
  incotermsCode: 'it carries no delivery terms in this process',
  incotermsLocation: 'it carries no delivery terms in this process',
  netPrice: 'supply is valued from the issuing plant, not from a price',
  priceUnit: 'supply is valued from the issuing plant, not from a price',
  taxCode: 'it is not invoiced, so no tax code',
  accountAssignmentCategory: 'it buys stock and has no account assignment',
  assignments: 'it buys stock and has no account assignment',
  requisitionNumber: 'a requisition does not convert into a stock transport order here',
  requisitionItem: 'a requisition does not convert into a stock transport order here',
  quotationNumber: 'it has no quotation', quotationItem: 'it has no quotation',
  contractNumber: 'it has no contract', contractItem: 'it has no contract',
  infoUpdate: 'it has no info record', applyLeadTime: 'it has no info record lead time',
  overdeliveryTolerance: 'over-issue is not supported', underdeliveryTolerance: 'under-delivery tolerance is not supported',
  unlimitedOverdelivery: 'over-issue is not supported',
  invoiceReceiptIndicator: 'it is never invoiced', grBasedInvoiceVerification: 'it is never invoiced',
  finalInvoiceIndicator: 'it is never invoiced', goodsReceiptIndicator: 'its receipt is always from transit',
  shortText: 'the text is taken from the material', deliveryCompleted: 'close the item through its own screen',
  deliveryAddress: 'delivery and billing documents (641/643/645/647) are not part of this process',
  deliveryNumber: 'delivery and billing documents (641/643/645/647) are not part of this process',
  specialStock: 'special stock is not supported', serialNumbers: 'serialised stock is not supported',
  freight: 'freight charges are not supported',
};

const scheduleInput = z.object({
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a delivery date is required'),
  quantity: z.union([z.string(), z.number()]),
}).strict();

const itemInput = z.object({
  itemNumber: z.coerce.number().int().positive().optional(),
  materialNumber: z.string().trim().min(1, 'a material is required').max(40),
  quantity: z.union([z.string(), z.number()]),
  unit: z.string().trim().min(1, 'a unit is required').max(6),
  plant: z.string().trim().min(1, 'the receiving plant is required').max(10),
  storageLocation: z.string().trim().max(10).optional().default(''),
  batch: z.string().trim().max(10).optional().default(''),
  markedForDeletion: z.boolean().optional().default(false),
  scheduleLines: z.array(scheduleInput).min(1, 'an item needs at least one schedule line'),
}).strict();

const headerInput = z.object({
  client: z.string().min(1),
  changedBy: z.string().min(1),
  documentType: z.literal(STO_ORDER_TYPE),
  supplyingPlant: z.string().trim().min(1, 'the supplying plant is required').max(10),
  purchasingOrg: z.string().trim().min(1).max(10),
  purchasingGroup: z.string().trim().min(1).max(3),
  companyCode: z.string().trim().min(1).max(10),
  items: z.array(itemInput).min(1, 'a stock transport order needs at least one item'),
}).strict();

export type StoOrderInput = z.input<typeof headerInput>;
type ParsedStoOrder = z.output<typeof headerInput>;
type ParsedStoItem = z.output<typeof itemInput>;

function parse(raw: unknown): ParsedStoOrder {
  const parsed = headerInput.safeParse(raw);
  if (parsed.success) return parsed.data;
  const refused: string[] = [];
  for (const issue of parsed.error.issues) {
    if (issue.code === 'unrecognized_keys') {
      for (const key of issue.keys) {
        refused.push(`${key} (${UNSUPPORTED_FIELDS[key] ?? 'it is not a field of a stock transport order'})`);
      }
    }
  }
  if (refused.length > 0) {
    throw new StoOrderError(
      `A stock transport order does not take: ${refused.join('; ')}.`,
      'Remove those fields. A stock transport order names the supplying plant, the receiving plant, the material, the quantity and the schedule.',
    );
  }
  const issue = parsed.error.issues[0];
  throw new StoOrderError(`${issue.path.join('.') || 'order'}: ${issue.message}`);
}

const Q = 3;
function scaled(value: string | number, label: string): bigint {
  const text = typeof value === 'number' ? String(value) : String(value ?? '').trim();
  if (!/^\d+(\.\d{1,3})?$/.test(text) || toScaled(text, Q) <= 0n) {
    throw new StoOrderError(`${label} ${text || '(empty)'} is not a positive quantity with at most three decimals.`, 'Enter a quantity such as 10 or 2.5.');
  }
  return toScaled(text, Q);
}
const text3 = (value: bigint) => fromScaled(value, Q);

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

interface JudgedStoItem {
  item: ParsedStoItem;
  quantity: bigint;
  baseQuantity: bigint;
  baseUnit: string;
  description: string;
  batch: string;
  schedules: Array<{ deliveryDate: string; quantity: bigint }>;
}

async function judgePlant(tx: Tx, client: string, plantCode: string, role: string) {
  const [row] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, plantCode)));
  if (!row) throw new StoOrderError(`The ${role} plant ${plantCode} does not exist.`, 'Choose a plant of the enterprise structure.');
  if (!row.isActive) throw new StoOrderError(`The ${role} plant ${plantCode} is not active.`, 'Choose an active plant.');
  if (!row.companyCode) throw new StoOrderError(`The ${role} plant ${plantCode} carries no company code.`, 'Assign the plant to a company code first.');
  if (!row.isStorageSite) throw new StoOrderError(`The ${role} plant ${plantCode} is not a storage site.`, 'Choose a plant that carries storage locations.');
  return row;
}

async function judgeHeader(tx: Tx, client: string, input: ParsedStoOrder) {
  const [org] = await tx.select().from(purchasingOrg)
    .where(and(eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, input.purchasingOrg)));
  if (!org?.isActive) throw new StoOrderError(`Purchasing organization ${input.purchasingOrg} does not exist or is inactive.`);
  const [group] = await tx.select().from(purchasingGroup)
    .where(and(eq(purchasingGroup.client, client), eq(purchasingGroup.purchasingGroup, input.purchasingGroup)));
  if (!group?.isActive) throw new StoOrderError(`Purchasing group ${input.purchasingGroup} does not exist or is inactive.`);
  const [company] = await tx.select().from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, input.companyCode)));
  if (!company) throw new StoOrderError(`Company code ${input.companyCode} does not exist.`);
  if (!company.currency) throw new StoOrderError(`Company code ${input.companyCode} carries no currency.`);
  const supplying = await judgePlant(tx, client, input.supplyingPlant, 'supplying');
  return { company, supplying };
}

async function judgeItem(
  tx: Tx, client: string, header: ParsedStoOrder, item: ParsedStoItem,
): Promise<JudgedStoItem> {
  if (item.plant === header.supplyingPlant) {
    throw new StoOrderError(
      `Item ${item.materialNumber}: the receiving plant ${item.plant} is also the supplying plant.`,
      'A stock transport order moves stock between two different plants; move inside one plant with a storage location transfer.',
    );
  }
  const receiving = await judgePlant(tx, client, item.plant, 'receiving');
  if (receiving.companyCode !== header.companyCode) {
    throw new StoOrderError(
      `Receiving plant ${item.plant} belongs to company code ${receiving.companyCode}, not the order's company code ${header.companyCode}.`,
      'The header company is the receiving company: order for a plant of that company, or change the company code.',
    );
  }
  try {
    await assertPurchasingOrgForPlant(tx, {
      client, purchasingOrg: header.purchasingOrg, plant: item.plant, documentType: 'PURCHASE_ORDER',
    });
  } catch (error) {
    if (error instanceof PurchasingOrgPlantAuthorizationError) throw new StoOrderError(error.message, error.remedy, error.code);
    throw error;
  }
  const [mat] = await tx.select().from(material).where(and(
    eq(material.client, client), eq(material.materialNumber, item.materialNumber),
  ));
  if (!mat) throw new StoOrderError(`Material ${item.materialNumber} does not exist.`);
  if (mat.markedForDeletion) throw new StoOrderError(`Material ${item.materialNumber} is flagged for deletion.`);
  if (!mat.baseUnit) throw new StoOrderError(`Material ${item.materialNumber} carries no base unit.`, 'Complete the material master.');
  for (const [plantCode, role] of [[header.supplyingPlant, 'supplying'], [item.plant, 'receiving']] as const) {
    const [ext] = await tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, client), eq(materialPlant.materialNumber, item.materialNumber), eq(materialPlant.plant, plantCode),
    ));
    if (!ext) {
      throw new StoOrderError(
        `Material ${item.materialNumber} is not extended to the ${role} plant ${plantCode}.`,
        `Extend the material to plant ${plantCode}; a stock transport order needs it in both plants.`,
      );
    }
    if (ext.markedForDeletion) {
      throw new StoOrderError(`Material ${item.materialNumber} is flagged for deletion in the ${role} plant ${plantCode}.`, 'Cancel the plant deletion flag first.');
    }
  }
  if (item.storageLocation) {
    const [sl] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client), eq(storageLocation.plant, item.plant), eq(storageLocation.storageLocation, item.storageLocation),
    ));
    if (!sl?.isActive) {
      throw new StoOrderError(`Storage location ${item.storageLocation} does not stand active at receiving plant ${item.plant}.`);
    }
  }
  const quantity = scaled(item.quantity, `Quantity of ${item.materialNumber}`);
  let baseQuantity = quantity;
  if (item.unit !== mat.baseUnit) {
    try {
      const conversion = await toBaseQuantity(tx, client, {
        materialNumber: item.materialNumber, quantity: Number(text3(quantity)), entryUnit: item.unit,
      });
      const rendered = conversion.baseQuantity.toFixed(Q);
      if (Math.abs(Number(rendered) - conversion.baseQuantity) > 1e-9) {
        throw new StoOrderError(
          `${text3(quantity)} ${item.unit} of ${item.materialNumber} does not convert to a base quantity of at most three decimals.`,
          'Order a quantity that converts exactly, or order in the base unit.',
        );
      }
      baseQuantity = toScaled(rendered, Q);
    } catch (caught) {
      if (caught instanceof UnitConversionError) throw new StoOrderError(caught.message, caught.remedy);
      throw caught;
    }
  }
  let batch = '';
  if (item.batch) {
    try {
      batch = await resolvePostingBatch(tx, { client, materialNumber: item.materialNumber, plant: header.supplyingPlant, batch: item.batch });
      await resolvePostingBatch(tx, { client, materialNumber: item.materialNumber, plant: item.plant, batch: item.batch });
    } catch (caught) {
      if (caught instanceof BatchPostingError) throw new StoOrderError(caught.message, caught.remedy);
      throw caught;
    }
  }
  const schedules = item.scheduleLines.map((line) => ({
    deliveryDate: line.deliveryDate, quantity: scaled(line.quantity, 'A schedule quantity'),
  }));
  const total = schedules.reduce((s, l) => s + l.quantity, 0n);
  if (total !== quantity) {
    throw new StoOrderError(
      `Item ${item.materialNumber}: the schedule lines total ${text3(total)}, not the item quantity ${text3(quantity)}.`,
      'Make the schedule quantities add up to the item quantity exactly.',
    );
  }
  return {
    item, quantity, baseQuantity, baseUnit: mat.baseUnit, description: (mat.description ?? item.materialNumber).slice(0, 40),
    batch, schedules,
  };
}

async function writeItem(
  tx: Tx, client: string, orderNumber: string, itemNumber: number, judged: JudgedStoItem, changedBy: string, isNew: boolean,
): Promise<void> {
  const values = {
    client, orderNumber, itemNumber, itemCategory: 'STANDARD', accountAssignmentCategory: null,
    materialNumber: judged.item.materialNumber, shortText: judged.description,
    quantity: text3(judged.quantity), unit: judged.item.unit,
    // No price and no value: supply is valued from the issuing plant at the moment of issue.
    netPrice: '0', priceUnit: '1', netValue: '0',
    plant: judged.item.plant, storageLocation: judged.item.storageLocation || null, batchNumber: judged.batch,
    markedForDeletion: judged.item.markedForDeletion,
    overdeliveryTolerance: '0', underdeliveryTolerance: '0', unlimitedOverdelivery: false, deliveryCompleted: false,
    goodsReceiptIndicator: true, invoiceReceiptIndicator: false, grBasedInvoiceVerification: false, finalInvoiceIndicator: false,
  };
  if (isNew) {
    await tx.insert(purchaseOrderItem).values({ ...values, createdBy: changedBy });
  } else {
    await tx.update(purchaseOrderItem).set({ ...values, changedBy, changedAt: new Date() }).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber), eq(purchaseOrderItem.itemNumber, itemNumber),
    ));
    await tx.delete(purchaseOrderScheduleLine).where(and(
      eq(purchaseOrderScheduleLine.client, client), eq(purchaseOrderScheduleLine.orderNumber, orderNumber),
      eq(purchaseOrderScheduleLine.itemNumber, itemNumber),
    ));
  }
  let line = 0;
  for (const schedule of judged.schedules) {
    await tx.insert(purchaseOrderScheduleLine).values({
      client, orderNumber, itemNumber, lineNumber: ++line,
      deliveryDate: schedule.deliveryDate, quantity: text3(schedule.quantity), createdBy: changedBy,
    });
  }
}

async function markPlanning(tx: Tx, client: string, by: string, materialNumber: string, plantCode: string, reason: string) {
  await tx.execute(sql`
    insert into planning_file (client, material_number, plant, net_change, reason, last_changed_by)
    values (${client}, ${materialNumber}, ${plantCode}, true, ${reason}, ${by})
    on conflict (client, material_number, plant)
    do update set net_change = true, reason = excluded.reason, last_changed_at = now(), last_changed_by = excluded.last_changed_by
  `);
}

export async function createStockTransportOrder(raw: unknown): Promise<{ orderNumber: string; warnings: string[] }> {
  const input = parse(raw);
  const documentDate = today();
  const orderNumber = await withTenant(input.client, async (tx) => {
    try {
      await assertStoReleaseEvaluable(tx, input.client);
    } catch (error) {
      if (error instanceof ReleaseError) throw new StoOrderError(error.message, error.remedy);
      throw error;
    }
    const { company } = await judgeHeader(tx, input.client, input);
    const judgedItems: JudgedStoItem[] = [];
    for (const item of input.items) judgedItems.push(await judgeItem(tx, input.client, input, item));
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client, objectCode: 'PURCHORD', companyCode: '*',
        subObject: STO_RANGE_SUB_OBJECT, fiscalYear: 0, allocatedBy: input.changedBy,
      });
    } catch {
      throw new StoOrderError(
        'No active internal PURCHORD number range stands, so no order number can be drawn.',
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }
    const number = drawn.display;
    await tx.insert(purchaseOrder).values({
      client: input.client, orderNumber: number, documentType: STO_ORDER_TYPE,
      supplierNumber: null, supplyingPlant: input.supplyingPlant,
      purchasingOrg: input.purchasingOrg, purchasingGroup: input.purchasingGroup, companyCode: input.companyCode,
      currency: company.currency, documentDate, releaseStatus: 'UNRELEASED', createdBy: input.changedBy,
    });
    let itemNumber = 0;
    for (const judged of judgedItems) {
      itemNumber += 10;
      await writeItem(tx, input.client, number, itemNumber, judged, input.changedBy, true);
      await markPlanning(tx, input.client, input.changedBy, judged.item.materialNumber, judged.item.plant, `STO ${number}`);
      await markPlanning(tx, input.client, input.changedBy, judged.item.materialNumber, input.supplyingPlant, `STO ${number}`);
    }
    await recordChange(tx, {
      client: input.client, objectClass: PO_OBJECT_CLASS, objectKey: number, changeType: 'CREATE', changedBy: input.changedBy,
      after: {
        documentType: STO_ORDER_TYPE, supplyingPlant: input.supplyingPlant, receivingCompany: input.companyCode,
        items: input.items.length,
      },
    });
    await syncDocumentRelease(
      tx, input.client, 'PURCHASE_ORDER', number, await orderAttributes(tx, input.client, number), input.changedBy,
    );
    return number;
  });
  return { orderNumber, warnings: [] };
}

export async function changeStockTransportOrder(
  raw: unknown, orderNumber: string,
): Promise<{ orderNumber: string; warnings: string[] }> {
  const input = parse(raw);
  await withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/purchase-order/${orderNumber}`}, 0))`);
    const [header] = await tx.select().from(purchaseOrder).where(and(
      eq(purchaseOrder.client, input.client), eq(purchaseOrder.orderNumber, orderNumber),
    ));
    if (!header) throw new StoOrderError(`Purchase order ${orderNumber} does not exist.`);
    if (header.documentType !== STO_ORDER_TYPE) {
      throw new StoOrderError(
        `Purchase order ${orderNumber} is a ${header.documentType} order and cannot become a stock transport order.`,
        'An order is never converted between a supplier order and a stock transport order; create a new one.',
      );
    }
    try {
      await assertDocumentNotReleased(tx, input.client, 'PURCHASE_ORDER', orderNumber, 'Stock transport order');
      await assertStoReleaseEvaluable(tx, input.client);
    } catch (error) {
      if (error instanceof ReleaseError) throw new StoOrderError(error.message, error.remedy);
      throw error;
    }
    const standing = await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, input.client), eq(purchaseOrderItem.orderNumber, orderNumber),
    )).orderBy(asc(purchaseOrderItem.itemNumber));
    await tx.execute(sql`
      select 1 from purchase_order_item where client = ${input.client} and order_number = ${orderNumber}
       order by item_number for update
    `);
    const moved = await tx.execute(sql`
      select item_number, sum(issued_quantity - reversed_quantity)::text as net_issued,
             sum(issued_quantity - reversed_quantity - received_quantity)::text as in_transit,
             count(*)::int as issues
        from sto_transit_allocation where client = ${input.client} and order_number = ${orderNumber}
       group by item_number
    `) as unknown as Array<{ item_number: number; net_issued: string; in_transit: string; issues: number }>;
    const movedBy = new Map(moved.map((m) => [m.item_number, m]));
    if (moved.length > 0 && header.supplyingPlant !== input.supplyingPlant) {
      throw new StoOrderError(
        `Stock has already moved against order ${orderNumber}; its supplying plant ${header.supplyingPlant} cannot change.`,
        'Reverse the goods issues first, or create a new order for the other supplying plant.',
      );
    }
    const { company } = await judgeHeader(tx, input.client, input);
    const standingNumbers = new Set(standing.map((i) => i.itemNumber));
    let maxItem = Math.max(0, ...standingNumbers);
    const judgedAll: Array<{ judged: JudgedStoItem; itemNumber: number; isNew: boolean }> = [];
    for (const item of input.items) {
      const isNew = item.itemNumber === undefined || !standingNumbers.has(item.itemNumber);
      const itemNumber = isNew ? (maxItem += 10) : (item.itemNumber as number);
      const judged = await judgeItem(tx, input.client, input, item);
      const was = standing.find((s) => s.itemNumber === itemNumber);
      const activity = movedBy.get(itemNumber);
      if (was && activity && Number(activity.issues) > 0) {
        const netIssued = toScaled(activity.net_issued ?? '0', Q);
        const frozen: string[] = [];
        if (was.materialNumber !== judged.item.materialNumber) frozen.push('material');
        if (was.plant !== judged.item.plant) frozen.push('receiving plant');
        if (was.unit !== judged.item.unit) frozen.push('unit');
        if (was.batchNumber !== judged.batch) frozen.push('batch');
        if (frozen.length > 0) {
          throw new StoOrderError(
            `Item ${itemNumber} has stock issued against it; its ${frozen.join(', ')} cannot change.`,
            'Reverse the goods movements first, or add a new item.',
          );
        }
        if (judged.baseQuantity < netIssued) {
          throw new StoOrderError(
            `Item ${itemNumber}: the quantity cannot fall below the ${text3(netIssued)} already issued.`,
            'Reverse the goods issue first, or keep the quantity at or above what is issued.',
          );
        }
        if (judged.item.markedForDeletion && netIssued > 0n) {
          throw new StoOrderError(
            `Item ${itemNumber} has ${text3(netIssued)} issued (${text3(toScaled(activity.in_transit ?? '0', Q))} still in transit) and cannot be flagged for deletion.`,
            'Receive or reverse the issued quantity first.',
          );
        }
      }
      judgedAll.push({ judged, itemNumber, isNew });
    }
    await tx.update(purchaseOrder).set({
      supplyingPlant: input.supplyingPlant, purchasingOrg: input.purchasingOrg, purchasingGroup: input.purchasingGroup,
      companyCode: input.companyCode, currency: company.currency, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(eq(purchaseOrder.client, input.client), eq(purchaseOrder.orderNumber, orderNumber)));
    for (const { judged, itemNumber, isNew } of judgedAll) {
      await writeItem(tx, input.client, orderNumber, itemNumber, judged, input.changedBy, isNew);
      await markPlanning(tx, input.client, input.changedBy, judged.item.materialNumber, judged.item.plant, `STO ${orderNumber} change`);
      await markPlanning(tx, input.client, input.changedBy, judged.item.materialNumber, input.supplyingPlant, `STO ${orderNumber} change`);
    }
    // An item the change dropped from its plants or its supply no longer plans there: both plants are re-planned.
    for (const was of standing) {
      if (was.materialNumber) {
        await markPlanning(tx, input.client, input.changedBy, was.materialNumber, was.plant, `STO ${orderNumber} change`);
        await markPlanning(tx, input.client, input.changedBy, was.materialNumber, header.supplyingPlant!, `STO ${orderNumber} change`);
      }
    }
    await syncDocumentRelease(
      tx, input.client, 'PURCHASE_ORDER', orderNumber, await orderAttributes(tx, input.client, orderNumber), input.changedBy,
      { restart: true },
    );
    await recordChange(tx, {
      client: input.client, objectClass: PO_OBJECT_CLASS, objectKey: orderNumber, changeType: 'CHANGE', changedBy: input.changedBy,
      before: { items: standing.map((i) => ({ item: i.itemNumber, qty: i.quantity, plant: i.plant, deleted: i.markedForDeletion })), supplyingPlant: header.supplyingPlant },
      after: { items: judgedAll.map((j) => ({ item: j.itemNumber, qty: text3(j.judged.quantity), plant: j.judged.item.plant, deleted: j.judged.item.markedForDeletion })), supplyingPlant: input.supplyingPlant },
    });
  });
  return { orderNumber, warnings: [] };
}
