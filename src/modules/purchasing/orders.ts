/**
 * Purchase orders — SCR-056 / R-104 (ME21N create, ME22N change,
 * ME23N display).
 *
 * A header with items, schedule lines and account assignments. The
 * supplier stands through its purchasing-organization data; every item
 * plant belongs to the header company; an item may convert a
 * requisition item, the ordered total never exceeding the requisitioned
 * quantity. The item net value is the stated baseline — quantity × net
 * price ÷ price unit, currency-rounded; condition-based pricing is a
 * later round. A purchasing info record, when one qualifies, may fill an
 * omitted price. It does not replace a price the buyer typed, and a
 * later change of the record does not rewrite this order. A source list,
 * when one requires a source, must qualify the named supplier. The order
 * stores that source and does not replace the supplier. A later change of
 * the item keeps the source and the supplier the order used. PO creation
 * posts nothing, so neither the FI periods
 * nor the material period control is consulted on save (R-104).
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { unitOfMeasure } from '../../platform/tables/reference';
import {
  companyCode, controllingAreaCompany, costCenter, plant, purchasingGroup, purchasingOrg,
  storageLocation, taxCode,
} from '../foundation/schema';
import { businessPartner } from '../foundation/business-partner-schema';
import { BatchPostingError, resolvePostingBatch } from '../inventory/batch-posting';
import {
  assertPurchasingOrgForPlant,
  PurchasingOrgPlantAuthorizationError,
} from '../foundation/purchasing-org-plant';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import { glAccount } from '../finance/schema';
import { material, materialGroup, materialPlant } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { FollowOnError, adoptQuotation, convertMoney, settleQuota, updateInfoRecordFromOrder } from './follow-on';
import { resolvePurchasingInfoRecord } from './info-record';
import { resolveSourceList, SourceListError } from './source-list';
import {
  documentRelease,
  purchaseOrder, purchaseOrderAssignment, purchaseOrderItem, purchaseOrderScheduleLine,
  purchaseRequisitionItem,
} from './schema';
import {
  ReleaseError, assertDocumentNotReleased, orderAttributes, syncDocumentRelease,
} from './release';

export const PO_CREATE_CAPABILITY = 'PROC.PO.CREATE';
export const PO_OBJECT_CLASS = 'purchase_order';

/** Delivered document types this round; a maintenance screen is deferred (R-104). */
export const ORDER_TYPES = [
  { code: 'STANDARD', name: 'Standard purchase order', rangeSubObject: 'POF' },
] as const;

export class PurchaseOrderError extends Error {
  remedy?: string;
  code?: string;

  constructor(message: string, remedy?: string, code?: string) {
    super(message);
    this.name = 'PurchaseOrderError';
    this.remedy = remedy;
    this.code = code;
  }
}

const assignmentInput = z.object({
  glAccount: z.string().trim().min(1).max(10),
  costCenter: z.string().trim().min(1).max(10),
  distributionPercentage: z.coerce.number().positive().max(100),
});

const scheduleInput = z.object({
  deliveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'a delivery date is required'),
  quantity: z.coerce.number().positive(),
});

const itemInput = z.object({
  itemNumber: z.coerce.number().int().positive().optional(),
  materialNumber: z.string().trim().max(40).optional().default(''),
  shortText: z.string().trim().max(40).optional().default(''),
  quantity: z.coerce.number().positive(),
  unit: z.string().trim().max(6).optional().default(''),
  netPrice: z.coerce.number().min(0).optional(),
  priceUnit: z.coerce.number().int().positive().optional().default(1),
  /** Asks for the info-record lead time. A sent delivery date is kept unless this is set. */
  applyLeadTime: z.boolean().optional().default(false),
  taxCode: z.string().trim().max(4).optional().default(''),
  plant: z.string().trim().min(1).max(10),
  storageLocation: z.string().trim().max(10).optional().default(''),
  /** A batch that already stands. The order does not create it. */
  batch: z.string().trim().max(10).optional().default(''),
  accountAssignmentCategory: z.enum(['COST_CENTER']).nullable().optional().default(null),
  markedForDeletion: z.boolean().optional().default(false),
  requisitionNumber: z.string().trim().max(10).optional().default(''),
  requisitionItem: z.coerce.number().int().positive().optional(),
  quotationNumber: z.string().trim().max(20).optional().default(''),
  quotationItem: z.coerce.number().int().positive().optional(),
  scheduleLines: z.array(scheduleInput).min(1, 'an item needs at least one schedule line'),
  assignments: z.array(assignmentInput).optional().default([]),
});

const documentInput = z.object({
  client: z.string().min(1),
  changedBy: z.string().min(1),
  documentType: z.string().trim().min(1).max(20).optional().default('STANDARD'),
  supplierNumber: z.string().trim().min(1).max(40),
  purchasingOrg: z.string().trim().min(1).max(10),
  purchasingGroup: z.string().trim().min(1).max(3),
  companyCode: z.string().trim().min(1).max(10),
  currency: z.string().trim().max(5).optional().default(''),
  items: z.array(itemInput).min(1, 'a purchase order needs at least one item'),
});

export type CreateOrderInput = z.input<typeof documentInput>;

export interface OrderItemRow {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  quantity: string;
  unit: string;
  netPrice: string;
  priceUnit: string;
  netValue: string;
  taxCode: string | null;
  plant: string;
  storageLocation: string | null;
  materialGroup: string | null;
  accountAssignmentCategory: string | null;
  markedForDeletion: boolean;
  requisitionNumber: string | null;
  requisitionItem: number | null;
  quotationNumber: string | null;
  quotationItem: number | null;
  infoUpdate: boolean;
  quotaNumber: string | null;
  quotaItem: string | null;
  infoRecordNumber: string | null;
  priceSequence: number | null;
  sourceNumber: string | null;
  scheduleLines: Array<{ lineNumber: number; deliveryDate: string; quantity: string }>;
  assignments: Array<{ lineNumber: number; glAccount: string; costCenter: string; distributionPercentage: string }>;
}

export interface OrderDocument {
  orderNumber: string;
  documentType: string;
  supplierNumber: string;
  supplierName: string;
  purchasingOrg: string;
  purchasingGroup: string;
  companyCode: string;
  currency: string;
  documentDate: string;
  releaseStatus: string;
  createdBy: string;
  items: OrderItemRow[];
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDays(iso: string, days: number): string {
  const [year, month, day] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function round2(value: number): string {
  return (Math.round(value * 100) / 100).toFixed(2);
}

async function priceFromRecord(
  tx: Tx,
  client: string,
  materialNumber: string,
  orderUnit: string,
  orderCurrency: string,
  documentDate: string,
  record: { amount?: string; currency?: string; priceUnit?: number; priceUnitOfMeasure?: string },
): Promise<{ netPrice: number; priceUnit: number; rounded: boolean; converted: boolean }> {
  let amount = Number(record.amount);
  let converted = false;
  if (record.currency && record.currency.trim().toUpperCase() !== orderCurrency.trim().toUpperCase()) {
    try {
      amount = await convertMoney(tx, client, amount, record.currency, orderCurrency, documentDate);
      converted = true;
    } catch (error) {
      if (error instanceof FollowOnError) throw new PurchaseOrderError(error.message, error.remedy);
      throw error;
    }
  }
  const recordUnit = Number(record.priceUnit);
  let perOrderUnit = amount;
  let storedUnit = recordUnit;
  if (record.priceUnitOfMeasure !== orderUnit) {
    try {
      const oneOrder = await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: orderUnit });
      const onePrice = await toBaseQuantity(tx, client, { materialNumber, quantity: 1, entryUnit: record.priceUnitOfMeasure });
      if (onePrice.baseQuantity === 0) {
        throw new PurchaseOrderError(`Material ${materialNumber} has no base quantity for ${record.priceUnitOfMeasure}.`);
      }
      perOrderUnit = amount * (oneOrder.baseQuantity / onePrice.baseQuantity) / recordUnit;
      storedUnit = 1;
    } catch (error) {
      if (error instanceof UnitConversionError) throw new PurchaseOrderError(error.message, error.remedy);
      throw error;
    }
  }
  const rounded = round2(storedUnit === 1 && record.priceUnitOfMeasure !== orderUnit ? perOrderUnit : amount);
  return {
    netPrice: Number(rounded),
    priceUnit: storedUnit,
    rounded: Math.abs((storedUnit === 1 && record.priceUnitOfMeasure !== orderUnit ? perOrderUnit : amount) - Number(rounded)) > 0.0000001,
    converted,
  };
}

interface JudgedItem {
  values: typeof purchaseOrderItem.$inferInsert;
  scheduleLines: Array<{ deliveryDate: string; quantity: string }>;
  assignments: z.infer<typeof assignmentInput>[];
}

async function judgeItem(
  tx: Tx,
  client: string,
  header: { companyCode: string; currency: string; supplierNumber: string; purchasingOrg: string },
  item: z.infer<typeof itemInput>,
  documentDate: string,
  excludeOrder: string | null,
  warnings: string[],
  applyRecord: boolean,
): Promise<JudgedItem> {
  const [company] = await tx.select().from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, header.companyCode)));
  if (!company) throw new PurchaseOrderError(`Company code ${header.companyCode} does not exist.`);

  const [plantRow] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, item.plant)));
  if (!plantRow) throw new PurchaseOrderError(`Plant ${item.plant} does not exist.`);
  if (plantRow.companyCode !== header.companyCode) {
    throw new PurchaseOrderError(
      `Plant ${item.plant} belongs to company code ${plantRow.companyCode ?? 'none'}, not the order's company code ${header.companyCode}.`,
      'Order for the plant under its own company code, or choose a plant of this company.',
    );
  }
  try {
    await assertPurchasingOrgForPlant(tx, {
      client,
      purchasingOrg: header.purchasingOrg,
      plant: item.plant,
      documentType: 'PURCHASE_ORDER',
    });
  } catch (error) {
    if (error instanceof PurchasingOrgPlantAuthorizationError) {
      throw new PurchaseOrderError(error.message, error.remedy, error.code);
    }
    throw error;
  }
  if (item.storageLocation) {
    const [sl] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client), eq(storageLocation.plant, item.plant),
      eq(storageLocation.storageLocation, item.storageLocation),
    ));
    if (!sl?.isActive) throw new PurchaseOrderError(`Storage location ${item.storageLocation} does not stand active at plant ${item.plant}.`);
  }

  let shortText = item.shortText;
  let unit = item.unit;
  let group9: string | null = null;
  let record: Awaited<ReturnType<typeof resolvePurchasingInfoRecord>> | null = null;
  let sourceNumber: string | null = null;
  if (item.materialNumber) {
    const [mat] = await tx.select().from(material)
      .where(and(eq(material.client, client), eq(material.materialNumber, item.materialNumber)));
    if (!mat) throw new PurchaseOrderError(`Material ${item.materialNumber} does not exist.`);
    const [ext] = await tx.select().from(materialPlant).where(and(
      eq(materialPlant.client, client), eq(materialPlant.materialNumber, item.materialNumber),
      eq(materialPlant.plant, item.plant),
    ));
    if (!ext) {
      throw new PurchaseOrderError(
        `Material ${item.materialNumber} is not extended to plant ${item.plant}.`,
        'Extend the material to the plant on the material master, or choose another plant.',
      );
    }
    if (mat.markedForDeletion || ext.markedForDeletion) {
      warnings.push(`Material ${item.materialNumber} is flagged for deletion (SCR-053) — the flag warns here; it does not block an order.`);
    }
    if (applyRecord) {
      try {
        const source = await resolveSourceList(tx, {
          client,
          materialNumber: item.materialNumber,
          plant: item.plant,
          purchasingOrg: header.purchasingOrg,
          partnerNumber: header.supplierNumber,
          documentDate,
        });
        sourceNumber = source.sourceNumber;
      } catch (error) {
        if (error instanceof SourceListError) throw new PurchaseOrderError(error.message, error.remedy);
        throw error;
      }
    }
    if (applyRecord) {
      record = await resolvePurchasingInfoRecord(tx, {
        client,
        partnerNumber: header.supplierNumber,
        materialNumber: item.materialNumber,
        purchasingOrg: header.purchasingOrg,
        plant: item.plant,
        pricingDate: documentDate,
        orderCurrency: header.currency,
      });
      if (record.warning) warnings.push(record.warning);
      if (!unit && record.qualified && record.orderUnit) unit = record.orderUnit;
    }
    if (!shortText) shortText = mat.description;
    if (!unit) unit = mat.baseUnit ?? '';
    if (mat.materialGroup) {
      const [g] = await tx.select().from(materialGroup)
        .where(and(eq(materialGroup.client, client), eq(materialGroup.materialGroup, mat.materialGroup)));
      if (g?.isActive) group9 = g.materialGroup;
    }
  }
  if (!shortText) throw new PurchaseOrderError('A short text is required — from the material master or entered for a text item.');
  if (!unit) throw new PurchaseOrderError('An order unit is required.');
  let netPrice = item.netPrice;
  let priceUnit = item.priceUnit;
  let quotationNumber: string | null = null;
  let quotationItem: number | null = null;
  let infoUpdate = false;
  let requisitionNumber = item.requisitionNumber || '';
  let requisitionItem = item.requisitionItem;
  if (item.quotationNumber) {
    try {
      const adopted = await adoptQuotation(tx, client, header, {
        quotationNumber: item.quotationNumber,
        quotationItem: item.quotationItem,
        materialNumber: item.materialNumber,
        plant: item.plant,
        quantity: item.quantity,
        unit,
        markedForDeletion: item.markedForDeletion,
        requisitionNumber: item.requisitionNumber,
        requisitionItem: item.requisitionItem,
      }, documentDate, excludeOrder);
      if (adopted) {
        quotationNumber = adopted.quotationNumber;
        quotationItem = adopted.quotationItem;
        infoUpdate = adopted.infoUpdate;
        if (netPrice === undefined) {
          netPrice = adopted.currency.trim().toUpperCase() === header.currency.trim().toUpperCase()
            ? adopted.netPrice
            : await convertMoney(tx, client, adopted.netPrice, adopted.currency, header.currency, documentDate);
          priceUnit = adopted.priceUnit;
        }
        if (!requisitionNumber && adopted.requisitionNumber && adopted.requisitionItem != null) {
          requisitionNumber = adopted.requisitionNumber;
          requisitionItem = adopted.requisitionItem;
        }
        if (!shortText) shortText = adopted.shortText;
      }
    } catch (error) {
      if (error instanceof FollowOnError) throw new PurchaseOrderError(error.message, error.remedy);
      throw error;
    }
  }
  let storeReference = Boolean(applyRecord && record?.qualified);
  if (applyRecord && record?.qualified && item.materialNumber) {
    if (netPrice === undefined) {
      const filled = await priceFromRecord(tx, client, item.materialNumber, unit, header.currency, documentDate, record);
      netPrice = filled.netPrice;
      priceUnit = filled.priceUnit;
      if (filled.converted) {
        warnings.push(
          `Info record ${record.infoRecordNumber} price ${record.amount} ${record.currency} was converted to ${header.currency}.`,
        );
      }
      if (filled.rounded) {
        warnings.push(
          `Info record ${record.infoRecordNumber} price ${record.amount} ${record.currency} is stored with more than two decimal places. The order snapshot rounds it to ${filled.netPrice}.`,
        );
      }
    } else if (record.priceUnitOfMeasure !== unit) {
      try {
        await toBaseQuantity(tx, client, { materialNumber: item.materialNumber, quantity: 1, entryUnit: unit });
        await toBaseQuantity(tx, client, { materialNumber: item.materialNumber, quantity: 1, entryUnit: record.priceUnitOfMeasure });
        warnings.push(
          `Info record ${record.infoRecordNumber} prices ${record.priceUnitOfMeasure}, and the order is in ${unit}. The order keeps the price that was typed.`,
        );
      } catch (error) {
        if (!(error instanceof UnitConversionError)) throw error;
        storeReference = false;
        warnings.push(`${error.message} The info record reference is not stored.`);
      }
    } else {
      const recorded = Number(record.amount) / Number(record.priceUnit);
      const sent = netPrice / priceUnit;
      if (Math.abs(recorded - sent) > 0.0001) {
        warnings.push(
          `Info record ${record.infoRecordNumber} qualified at ${record.amount} ${record.currency} per ${record.priceUnit} ${record.priceUnitOfMeasure}. The order keeps the price that was typed.`,
        );
      }
    }
    if (record.minimumOrderQuantity != null && record.minimumOrderUnit) {
      try {
        const ordered = await toBaseQuantity(tx, client, { materialNumber: item.materialNumber, quantity: item.quantity, entryUnit: unit });
        const minimum = await toBaseQuantity(tx, client, {
          materialNumber: item.materialNumber,
          quantity: Number(record.minimumOrderQuantity),
          entryUnit: record.minimumOrderUnit,
        });
        if (ordered.baseQuantity + 0.0000001 < minimum.baseQuantity) {
          warnings.push(
            `The order quantity is below the info record minimum of ${record.minimumOrderQuantity} ${record.minimumOrderUnit}. The order is not refused.`,
          );
        }
      } catch (error) {
        if (error instanceof UnitConversionError) warnings.push(error.message);
        else throw error;
      }
    }
  }
  if (netPrice === undefined) {
    throw new PurchaseOrderError(
      record?.warning ?? 'A net price is required.',
      'Enter a price, or maintain an info record that applies to this item.',
    );
  }
  const [unitRow] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit));
  if (!unitRow) throw new PurchaseOrderError(`Unit ${unit} is not a standing unit of measure.`);

  if (item.taxCode) {
    const [tc] = await tx.select().from(taxCode).where(and(
      eq(taxCode.client, client), eq(taxCode.country, company.country), eq(taxCode.taxCode, item.taxCode),
    ));
    if (!tc) throw new PurchaseOrderError(`Tax code ${item.taxCode} does not stand for country ${company.country}.`);
  }

  const scheduleTotal = item.scheduleLines.reduce((sum, line) => sum + line.quantity, 0);
  if (Math.abs(scheduleTotal - item.quantity) > 0.0005) {
    throw new PurchaseOrderError(
      `Schedule lines total ${scheduleTotal.toFixed(3)}, not the order quantity ${item.quantity.toFixed(3)}.`,
      'Reconcile the schedule lines with the order quantity.',
    );
  }

  let storedRequisition: string | null = null;
  let storedRequisitionItem: number | null = null;
  if (requisitionNumber) {
    if (!requisitionItem) throw new PurchaseOrderError('A requisition reference needs both the number and the item.');
    const [pr] = await tx.select().from(purchaseRequisitionItem).where(and(
      eq(purchaseRequisitionItem.client, client),
      eq(purchaseRequisitionItem.requisitionNumber, requisitionNumber),
      eq(purchaseRequisitionItem.itemNumber, requisitionItem),
    ));
    if (!pr) throw new PurchaseOrderError(`Requisition item ${requisitionNumber} / ${requisitionItem} does not exist.`);
    if (pr.markedForDeletion) throw new PurchaseOrderError(`Requisition item ${requisitionNumber} / ${requisitionItem} is marked for deletion and cannot be converted.`);
    const [release] = await tx.select().from(documentRelease).where(and(
      eq(documentRelease.client, client),
      eq(documentRelease.documentCategory, 'PURCHASE_REQUISITION'),
      eq(documentRelease.documentNumber, requisitionNumber),
    ));
    if (release && release.status !== 'RELEASED') {
      throw new PurchaseOrderError(
        `Requisition ${requisitionNumber} is not released.`,
        'Release the requisition, then create the order. A request is not required.',
      );
    }
    if (pr.materialNumber && item.materialNumber && pr.materialNumber !== item.materialNumber) {
      throw new PurchaseOrderError(`The order item buys ${item.materialNumber}; requisition item ${requisitionNumber} / ${requisitionItem} asks for ${pr.materialNumber}.`);
    }
    const orderedRows = await tx.execute(sql`
      select coalesce(sum(quantity), 0) as ordered from purchase_order_item
      where client = ${client} and requisition_number = ${requisitionNumber}
        and requisition_item = ${requisitionItem} and not marked_for_deletion
        and (${excludeOrder}::varchar is null or order_number <> ${excludeOrder})
    `);
    const already = Number((orderedRows as unknown as Array<{ ordered: string }>)[0]?.ordered ?? 0);
    if (!item.markedForDeletion && already + item.quantity > Number(pr.quantity) + 0.0005) {
      throw new PurchaseOrderError(
        `Ordering ${item.quantity} more against requisition ${requisitionNumber} / ${requisitionItem} exceeds it: ${already} of ${pr.quantity} already ordered.`,
        'Reduce the order quantity to the open remainder, or order without the requisition reference.',
      );
    }
    storedRequisition = requisitionNumber;
    storedRequisitionItem = requisitionItem;
  }
  let quotaNumber: string | null = null;
  let quotaItem: string | null = null;
  if (item.materialNumber) {
    try {
      const settled = await settleQuota(tx, client, {
        materialNumber: item.materialNumber,
        plant: item.plant,
        supplierNumber: header.supplierNumber,
        purchasingOrg: header.purchasingOrg,
        documentDate,
        quantity: item.quantity,
        unit,
        markedForDeletion: item.markedForDeletion,
        orderNumber: excludeOrder,
        itemNumber: item.itemNumber ?? null,
      });
      if (settled.warning) warnings.push(settled.warning);
      quotaNumber = settled.quotaNumber;
      quotaItem = settled.quotaItem;
    } catch (error) {
      if (error instanceof FollowOnError) throw new PurchaseOrderError(error.message, error.remedy);
      throw error;
    }
  }

  if (item.accountAssignmentCategory === 'COST_CENTER') {
    if (item.assignments.length === 0) throw new PurchaseOrderError('A cost-centre item needs at least one account assignment row.');
    const total = item.assignments.reduce((sum, row) => sum + row.distributionPercentage, 0);
    if (Math.abs(total - 100) > 0.005) {
      throw new PurchaseOrderError(`Assignment percentages total ${total.toFixed(2)}, not 100.`);
    }
    const [area] = await tx.select().from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, client), eq(controllingAreaCompany.companyCode, header.companyCode),
    ));
    for (const row of item.assignments) {
      if (!area) throw new PurchaseOrderError(`Company code ${header.companyCode} belongs to no controlling area.`);
      const centres = await tx.select().from(costCenter).where(and(
        eq(costCenter.client, client), eq(costCenter.controllingArea, area.controllingArea),
        eq(costCenter.costCenter, row.costCenter),
      ));
      const standing = centres.find((c) => c.validFrom <= documentDate && c.validTo >= documentDate);
      if (!standing) throw new PurchaseOrderError(`Cost centre ${row.costCenter} does not stand valid on ${documentDate} in controlling area ${area.controllingArea}.`);
      if (standing.isPostingLocked) throw new PurchaseOrderError(`Cost centre ${row.costCenter} is locked for postings.`);
      if (!company.chartOfAccounts) throw new PurchaseOrderError(`Company code ${header.companyCode} has no chart of accounts assigned.`);
      const [account] = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, client), eq(glAccount.chartOfAccounts, company.chartOfAccounts),
        eq(glAccount.accountNumber, row.glAccount),
      ));
      if (!account) throw new PurchaseOrderError(`G/L account ${row.glAccount} does not exist in chart ${company.chartOfAccounts}.`);
      if (account.isBalanceSheet) throw new PurchaseOrderError(`G/L account ${row.glAccount} is a balance-sheet account; a consumption assignment needs a P&L account.`);
    }
  } else if (item.assignments.length > 0) {
    throw new PurchaseOrderError('A stock item carries no account assignments.');
  }

  if (
    applyRecord && item.applyLeadTime && record?.qualified && record.plannedDeliveryDays != null
    && item.scheduleLines.length !== 1
  ) {
    warnings.push(
      `Info record ${record.infoRecordNumber} lead time was not applied because the item has more than one schedule line. The sent dates stand.`,
    );
  }

  let batchNumber = '';
  const typedBatch = (item.batch ?? '').trim();
  if (typedBatch && !item.materialNumber) {
    throw new PurchaseOrderError(
      'A batch was entered on an item with no material. No order was saved.',
      'Leave the batch empty, or name the material.',
    );
  }
  if (typedBatch) {
    try {
      batchNumber = await resolvePostingBatch(tx, {
        client, materialNumber: item.materialNumber, plant: item.plant, batch: typedBatch,
      });
    } catch (caught) {
      if (caught instanceof BatchPostingError) throw new PurchaseOrderError(caught.message, caught.remedy);
      throw caught;
    }
  }

  return {
    values: {
      client,
      orderNumber: '',
      itemNumber: 0,
      itemCategory: 'STANDARD',
      accountAssignmentCategory: item.accountAssignmentCategory,
      materialNumber: item.materialNumber || null,
      shortText,
      quantity: String(item.quantity),
      unit,
      netPrice: String(netPrice),
      priceUnit: String(priceUnit),
      netValue: round2((item.quantity * netPrice) / priceUnit),
      infoRecordNumber: storeReference ? record?.infoRecordNumber ?? null : null,
      priceSequence: storeReference ? record?.priceSequence ?? null : null,
      sourceNumber,
      taxCode: item.taxCode || null,
      plant: item.plant,
      storageLocation: item.storageLocation || null,
      batchNumber,
      materialGroup: group9,
      requisitionNumber: storedRequisition,
      requisitionItem: storedRequisitionItem,
      quotationNumber,
      quotationItem,
      infoUpdate,
      quotaNumber,
      quotaItem,
      markedForDeletion: item.markedForDeletion,
    },
    scheduleLines: item.scheduleLines.map((line) => ({
      deliveryDate: applyRecord && item.applyLeadTime && record?.qualified && record.plannedDeliveryDays != null && item.scheduleLines.length === 1
        ? addDays(documentDate, record.plannedDeliveryDays)
        : line.deliveryDate,
      quantity: String(line.quantity),
    })),
    assignments: item.assignments,
  };
}

async function loadDocument(tx: Tx, client: string, orderNumber: string): Promise<OrderDocument | null> {
  const [header] = await tx.select().from(purchaseOrder)
    .where(and(eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber)));
  if (!header) return null;
  const [supplier] = await tx.select().from(businessPartner)
    .where(and(eq(businessPartner.client, client), eq(businessPartner.partnerNumber, header.supplierNumber)));
  const items = await tx.select().from(purchaseOrderItem)
    .where(and(eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber)))
    .orderBy(asc(purchaseOrderItem.itemNumber));
  const schedules = await tx.select().from(purchaseOrderScheduleLine)
    .where(and(eq(purchaseOrderScheduleLine.client, client), eq(purchaseOrderScheduleLine.orderNumber, orderNumber)))
    .orderBy(asc(purchaseOrderScheduleLine.itemNumber), asc(purchaseOrderScheduleLine.lineNumber));
  const assignments = await tx.select().from(purchaseOrderAssignment)
    .where(and(eq(purchaseOrderAssignment.client, client), eq(purchaseOrderAssignment.orderNumber, orderNumber)))
    .orderBy(asc(purchaseOrderAssignment.itemNumber), asc(purchaseOrderAssignment.lineNumber));
  return {
    orderNumber,
    documentType: header.documentType,
    supplierNumber: header.supplierNumber,
    supplierName: supplier?.name ?? '',
    purchasingOrg: header.purchasingOrg,
    purchasingGroup: header.purchasingGroup,
    companyCode: header.companyCode,
    currency: header.currency,
    documentDate: header.documentDate,
    releaseStatus: header.releaseStatus,
    createdBy: header.createdBy,
    items: items.map((item) => ({
      itemNumber: item.itemNumber,
      materialNumber: item.materialNumber,
      shortText: item.shortText,
      quantity: item.quantity,
      unit: item.unit,
      netPrice: item.netPrice,
      priceUnit: item.priceUnit,
      netValue: item.netValue,
      taxCode: item.taxCode,
      plant: item.plant,
      storageLocation: item.storageLocation,
      batch: item.batchNumber,
      materialGroup: item.materialGroup,
      accountAssignmentCategory: item.accountAssignmentCategory,
      markedForDeletion: item.markedForDeletion,
      requisitionNumber: item.requisitionNumber,
      requisitionItem: item.requisitionItem,
      quotationNumber: item.quotationNumber,
      quotationItem: item.quotationItem,
      infoUpdate: item.infoUpdate,
      quotaNumber: item.quotaNumber,
      quotaItem: item.quotaItem,
      infoRecordNumber: item.infoRecordNumber,
      priceSequence: item.priceSequence,
      sourceNumber: item.sourceNumber,
      scheduleLines: schedules.filter((s) => s.itemNumber === item.itemNumber)
        .map((s) => ({ lineNumber: s.lineNumber, deliveryDate: s.deliveryDate, quantity: s.quantity })),
      assignments: assignments.filter((a) => a.itemNumber === item.itemNumber)
        .map((a) => ({
          lineNumber: a.lineNumber, glAccount: a.glAccount, costCenter: a.costCenter,
          distributionPercentage: a.distributionPercentage,
        })),
    })),
  };
}

export async function listOrders(client: string): Promise<OrderDocument[]> {
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(purchaseOrder)
      .where(eq(purchaseOrder.client, client))
      .orderBy(asc(purchaseOrder.orderNumber));
    const docs: OrderDocument[] = [];
    for (const header of headers.slice(-100)) {
      const doc = await loadDocument(tx, client, header.orderNumber);
      if (doc) docs.push(doc);
    }
    return docs.reverse();
  });
}

export async function getOrder(client: string, orderNumber: string): Promise<OrderDocument | null> {
  return withTenant(client, (tx) => loadDocument(tx, client, orderNumber));
}

async function judgeHeader(
  tx: Tx,
  client: string,
  input: z.infer<typeof documentInput>,
): Promise<{ currency: string }> {
  const [partner] = await tx.select().from(businessPartner)
    .where(and(eq(businessPartner.client, client), eq(businessPartner.partnerNumber, input.supplierNumber)));
  if (!partner) throw new PurchaseOrderError(`Supplier ${input.supplierNumber} does not exist.`, 'Pick a standing business partner with supplier purchasing data.');
  if (partner.isBlocked) throw new PurchaseOrderError(`Supplier ${input.supplierNumber} is blocked.`);
  const [org] = await tx.select().from(purchasingOrg)
    .where(and(eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, input.purchasingOrg)));
  if (!org?.isActive) throw new PurchaseOrderError(`Purchasing organization ${input.purchasingOrg} does not exist or is inactive.`);
  const [supplierOrg] = await tx.select().from(supplierPurchasing).where(and(
    eq(supplierPurchasing.client, client), eq(supplierPurchasing.partnerNumber, input.supplierNumber),
    eq(supplierPurchasing.purchasingOrg, input.purchasingOrg),
  ));
  if (!supplierOrg) {
    throw new PurchaseOrderError(
      `Supplier ${input.supplierNumber} holds no purchasing data for organization ${input.purchasingOrg}.`,
      'Maintain the supplier purchasing defaults for this organization, or choose another supplier.',
    );
  }
  if (supplierOrg.isBlocked) throw new PurchaseOrderError(`Supplier ${input.supplierNumber} is blocked for purchasing organization ${input.purchasingOrg}.`);
  const [group] = await tx.select().from(purchasingGroup)
    .where(and(eq(purchasingGroup.client, client), eq(purchasingGroup.purchasingGroup, input.purchasingGroup)));
  if (!group?.isActive) throw new PurchaseOrderError(`Purchasing group ${input.purchasingGroup} does not exist or is inactive.`);
  const [company] = await tx.select().from(companyCode)
    .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, input.companyCode)));
  if (!company) throw new PurchaseOrderError(`Company code ${input.companyCode} does not exist.`);
  return { currency: input.currency || supplierOrg.orderCurrency || company.currency };
}

async function writeInfoUpdates(
  tx: Tx,
  client: string,
  changedBy: string,
  supplierNumber: string,
  purchasingOrg: string,
  currency: string,
  documentDate: string,
  saved: JudgedItem[],
  warnings: string[],
): Promise<void> {
  for (const judged of saved) {
    const row = judged.values;
    if (!row.infoUpdate || !row.materialNumber || row.markedForDeletion) continue;
    try {
      const warning = await updateInfoRecordFromOrder(tx, {
        client,
        changedBy,
        supplierNumber,
        materialNumber: row.materialNumber,
        purchasingOrg,
        plant: row.plant,
        amount: Number(row.netPrice),
        currency,
        priceUnit: Number(row.priceUnit),
        unit: row.unit,
        documentDate,
      });
      if (warning) warnings.push(warning);
    } catch (error) {
      if (error instanceof FollowOnError) throw new PurchaseOrderError(error.message, error.remedy);
      throw error;
    }
  }
}

async function writeItem(
  tx: Tx,
  client: string,
  orderNumber: string,
  itemNumber: number,
  judged: JudgedItem,
  changedBy: string,
  isNew: boolean,
  documentDate: string,
  preserveInfoRecordReference: boolean,
): Promise<void> {
  const values = { ...judged.values };
  if (preserveInfoRecordReference) {
    delete values.infoRecordNumber;
    delete values.priceSequence;
    delete values.sourceNumber;
  }
  if (isNew) {
    await tx.insert(purchaseOrderItem).values({
      ...values, orderNumber, itemNumber, createdBy: changedBy,
    });
  } else {
    await tx.update(purchaseOrderItem).set({
      ...values, orderNumber, itemNumber, changedBy, changedAt: new Date(),
    }).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
      eq(purchaseOrderItem.itemNumber, itemNumber),
    ));
    await tx.delete(purchaseOrderScheduleLine).where(and(
      eq(purchaseOrderScheduleLine.client, client), eq(purchaseOrderScheduleLine.orderNumber, orderNumber),
      eq(purchaseOrderScheduleLine.itemNumber, itemNumber),
    ));
    await tx.delete(purchaseOrderAssignment).where(and(
      eq(purchaseOrderAssignment.client, client), eq(purchaseOrderAssignment.orderNumber, orderNumber),
      eq(purchaseOrderAssignment.itemNumber, itemNumber),
    ));
  }
  let line = 0;
  for (const schedule of judged.scheduleLines) {
    line += 1;
    await tx.insert(purchaseOrderScheduleLine).values({
      client, orderNumber, itemNumber, lineNumber: line,
      deliveryDate: schedule.deliveryDate, quantity: schedule.quantity, createdBy: changedBy,
    });
  }
  line = 0;
  for (const row of judged.assignments) {
    line += 1;
    await tx.insert(purchaseOrderAssignment).values({
      client, orderNumber, itemNumber, lineNumber: line,
      glAccount: row.glAccount, costCenter: row.costCenter,
      distributionPercentage: String(row.distributionPercentage), createdBy: changedBy,
    });
  }
  void documentDate;
}

export async function createOrder(
  raw: CreateOrderInput,
): Promise<{ orderNumber: string; warnings: string[] }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PurchaseOrderError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const type = ORDER_TYPES.find((t) => t.code === input.documentType);
  if (!type) throw new PurchaseOrderError(`Document type ${input.documentType} does not stand.`);
  const warnings: string[] = [];
  const documentDate = today();

  const orderNumber = await withTenant(input.client, async (tx) => {
    const { currency } = await judgeHeader(tx, input.client, input);
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client, objectCode: 'PURCHORD', companyCode: '*',
        subObject: type.rangeSubObject, fiscalYear: 0, allocatedBy: input.changedBy,
      });
    } catch {
      throw new PurchaseOrderError(
        'No active internal PURCHORD number range stands, so no order number can be drawn.',
        'Define or unblock the interval on the number ranges screen, then save again.',
      );
    }
    const number = drawn.display;
    await tx.insert(purchaseOrder).values({
      client: input.client,
      orderNumber: number,
      documentType: type.code,
      supplierNumber: input.supplierNumber,
      purchasingOrg: input.purchasingOrg,
      purchasingGroup: input.purchasingGroup,
      companyCode: input.companyCode,
      currency,
      documentDate,
      releaseStatus: 'UNRELEASED',
      createdBy: input.changedBy,
    });
    let itemNumber = 0;
    const saved: JudgedItem[] = [];
    for (const item of input.items) {
      itemNumber += 10;
      const judged = await judgeItem(tx, input.client, {
        companyCode: input.companyCode, currency, supplierNumber: input.supplierNumber, purchasingOrg: input.purchasingOrg,
      }, item, documentDate, null, warnings, true);
      await writeItem(tx, input.client, number, itemNumber, judged, input.changedBy, true, documentDate, false);
      saved.push(judged);
    }
    await writeInfoUpdates(tx, input.client, input.changedBy, input.supplierNumber, input.purchasingOrg, currency, documentDate, saved, warnings);
    await recordChange(tx, {
      client: input.client, objectClass: PO_OBJECT_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: input.changedBy,
      after: { documentType: type.code, supplier: input.supplierNumber, items: input.items.length, currency },
    });
    await syncDocumentRelease(
      tx, input.client, 'PURCHASE_ORDER', number,
      await orderAttributes(tx, input.client, number), input.changedBy,
    );
    return number;
  });
  return { orderNumber, warnings };
}

export async function changeOrder(
  raw: CreateOrderInput & { orderNumber: string },
): Promise<{ orderNumber: string; warnings: string[] }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PurchaseOrderError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const warnings: string[] = [];

  await withTenant(input.client, async (tx) => {
    const before = await loadDocument(tx, input.client, raw.orderNumber);
    if (!before) throw new PurchaseOrderError(`Purchase order ${raw.orderNumber} does not exist.`);
    try {
      await assertDocumentNotReleased(tx, input.client, 'PURCHASE_ORDER', raw.orderNumber, 'Purchase order');
    } catch (error) {
      if (error instanceof ReleaseError) throw new PurchaseOrderError(error.message, error.remedy);
      throw error;
    }
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/purchase-order/${raw.orderNumber}`}, 0))`);
    const { currency } = await judgeHeader(tx, input.client, input);
    await tx.update(purchaseOrder).set({
      supplierNumber: input.supplierNumber,
      purchasingOrg: input.purchasingOrg,
      purchasingGroup: input.purchasingGroup,
      companyCode: input.companyCode,
      currency,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(eq(purchaseOrder.client, input.client), eq(purchaseOrder.orderNumber, raw.orderNumber)));

    const standingNumbers = new Set(before.items.map((i) => i.itemNumber));
    let maxItem = Math.max(0, ...standingNumbers);
    const saved: JudgedItem[] = [];
    for (const item of input.items) {
      const isNew = item.itemNumber === undefined || !standingNumbers.has(item.itemNumber);
      const itemNumber = isNew ? (maxItem += 10) : (item.itemNumber as number);
      const judged = await judgeItem(tx, input.client, {
        companyCode: input.companyCode, currency, supplierNumber: input.supplierNumber, purchasingOrg: input.purchasingOrg,
      }, item, before.documentDate, raw.orderNumber, warnings, isNew);
      await writeItem(tx, input.client, raw.orderNumber, itemNumber, judged, input.changedBy, isNew, before.documentDate, !isNew);
      saved.push(judged);
    }
    await writeInfoUpdates(tx, input.client, input.changedBy, input.supplierNumber, input.purchasingOrg, currency, before.documentDate, saved, warnings);
    await syncDocumentRelease(
      tx, input.client, 'PURCHASE_ORDER', raw.orderNumber,
      await orderAttributes(tx, input.client, raw.orderNumber), input.changedBy,
    );
    const after = await loadDocument(tx, input.client, raw.orderNumber);
    await recordChange(tx, {
      client: input.client, objectClass: PO_OBJECT_CLASS, objectKey: raw.orderNumber,
      changeType: 'CHANGE', changedBy: input.changedBy,
      before: { items: before.items.map((i) => ({ item: i.itemNumber, qty: i.quantity, value: i.netValue, deleted: i.markedForDeletion })) },
      after: { items: after?.items.map((i) => ({ item: i.itemNumber, qty: i.quantity, value: i.netValue, deleted: i.markedForDeletion })) },
    });
  });
  return { orderNumber: raw.orderNumber, warnings };
}

export interface OrderChoices {
  suppliers: Array<{ partnerNumber: string; name: string; purchasingOrg: string; orderCurrency: string | null }>;
  purchasingOrgs: Array<{ purchasingOrg: string; name: string }>;
  purchasingGroups: Array<{ purchasingGroup: string; name: string }>;
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  plants: Array<{ plant: string; name: string; companyCode: string | null }>;
  storageLocations: Array<{ plant: string; storageLocation: string; name: string }>;
  units: string[];
}

export async function orderChoices(client: string): Promise<OrderChoices> {
  return withTenant(client, async (tx) => {
    const supplierRows = await tx.select().from(supplierPurchasing).where(eq(supplierPurchasing.client, client));
    const partners = await tx.select().from(businessPartner).where(eq(businessPartner.client, client));
    const orgRows = await tx.select().from(purchasingOrg).where(eq(purchasingOrg.client, client));
    const groupRows = await tx.select().from(purchasingGroup).where(eq(purchasingGroup.client, client));
    const companyRows = await tx.select().from(companyCode).where(eq(companyCode.client, client));
    const plantRows = await tx.select().from(plant).where(eq(plant.client, client));
    const slRows = await tx.select().from(storageLocation).where(eq(storageLocation.client, client));
    const unitRows = await tx.select().from(unitOfMeasure).orderBy(asc(unitOfMeasure.code));
    return {
      suppliers: supplierRows.filter((s) => !s.isBlocked).map((s) => ({
        partnerNumber: s.partnerNumber,
        name: partners.find((p) => p.partnerNumber === s.partnerNumber)?.name ?? '',
        purchasingOrg: s.purchasingOrg,
        orderCurrency: s.orderCurrency,
      })),
      purchasingOrgs: orgRows.filter((o) => o.isActive).map((o) => ({ purchasingOrg: o.purchasingOrg, name: o.name })),
      purchasingGroups: groupRows.filter((g) => g.isActive).map((g) => ({
        purchasingGroup: g.purchasingGroup, name: g.name,
      })),
      companies: companyRows.map((c) => ({ companyCode: c.companyCode, name: c.name, currency: c.currency })),
      plants: plantRows.map((p) => ({ plant: p.plant, name: p.name, companyCode: p.companyCode })),
      storageLocations: slRows.filter((s) => s.isActive).map((s) => ({
        plant: s.plant, storageLocation: s.storageLocation, name: s.name,
      })),
      units: unitRows.map((u) => u.code),
    };
  });
}
