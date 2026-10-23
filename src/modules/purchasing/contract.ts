/**
 * Purchase contract — ME31K create, ME32K change, ME33K display,
 * ME35K release when a strategy claims the document, ME3N list.
 *
 * A contract is not a purchase order. Saving it does not change stock,
 * a goods receipt, or an accounting document. MK and WK are configured
 * type rows, not meanings in this service. The price is the typed price,
 * the info-record price, or the quotation price. There is no second
 * pricing calculator. A call-off is a saved purchase-order item.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { client as clientTable } from '../../platform/tables/tenancy';
import { currency as currencyTable } from '../../platform/tables/reference';
import { businessPartner } from '../foundation/business-partner-schema';
import { paymentTerms } from '../foundation/payment-terms-schema';
import {
  companyCode,
  controllingAreaCompany,
  costCenter,
  plant,
  purchasingGroup,
  purchasingOrg,
  storageLocation,
} from '../foundation/schema';
import { supplierPurchasing } from '../foundation/supplier-purchasing-schema';
import {
  assertPurchasingOrgForPlant,
  PurchasingOrgPlantAuthorizationError,
} from '../foundation/purchasing-org-plant';
import { glAccount } from '../finance/schema';
import { material, materialDocumentLine, movementType } from '../inventory/schema';
import { convertMoney, FollowOnError } from './follow-on';
import { resolvePurchasingInfoRecord } from './info-record';
import {
  ReleaseError,
  assertDocumentNotReleased,
  syncDocumentRelease,
} from './release';
import {
  documentRelease,
  purchaseContract,
  purchaseContractItem,
  purchaseOrder,
  purchaseOrderItem,
  purchaseRequisitionItem,
  purchasingContractType,
  purchasingQuotationItem,
  purchasingRfq,
  purchasingRfqEvent,
  purchasingRfqItem,
  supplierInvoice,
  supplierInvoiceItem,
} from './schema';

export const CONTRACT_MAINTAIN_CAPABILITY = 'PROC.CONTRACT.MAINTAIN';
export const CONTRACT_DISPLAY_CAPABILITY = 'PROC.CONTRACT.DISPLAY';
export const CONTRACT_LIST_CAPABILITY = 'PROC.CONTRACT.LIST';
export const CONTRACT_OBJECT_CLASS = 'purchase_contract';
const CONTRACT_CATEGORY = 'PURCHASE_CONTRACT';
const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

export class PurchaseContractError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PurchaseContractError';
    this.remedy = remedy;
  }
}

const itemInput = z.object({
  itemNumber: z.number().int().positive().nullish(),
  materialNumber: z.string().trim().max(40).optional().default(''),
  shortText: z.string().trim().max(40).optional().default(''),
  targetQuantity: z.number().positive().nullish(),
  unit: z.string().trim().max(6).optional().default(''),
  netPrice: z.number().min(0).nullish(),
  priceUnit: z.number().int().positive().optional().default(1),
  plant: z.string().trim().max(10).optional().default(''),
  storageLocation: z.string().trim().max(10).optional().default(''),
  accountAssignmentCategory: z.enum(['COST_CENTER']).nullable().optional().default(null),
  costCenter: z.string().trim().max(10).optional().default(''),
  glAccount: z.string().trim().max(10).optional().default(''),
  requisitionNumber: z.string().trim().max(10).optional().default(''),
  requisitionItem: z.number().int().positive().nullish(),
  rfqNumber: z.string().trim().max(20).optional().default(''),
  rfqItem: z.number().int().positive().nullish(),
  quotationNumber: z.string().trim().max(20).optional().default(''),
  quotationItem: z.number().int().positive().nullish(),
  markedForDeletion: z.boolean().optional().default(false),
}).strict();

const documentInput = z.object({
  client: z.string().trim().min(1).max(4),
  changedBy: z.string().trim().min(1).max(60),
  documentType: z.string().trim().min(2).max(4),
  supplierNumber: z.string().trim().min(1).max(40),
  purchasingOrg: z.string().trim().min(1).max(10),
  purchasingGroup: z.string().trim().min(1).max(3),
  companyCode: z.string().trim().min(1).max(10),
  currency: z.string().trim().max(3).optional().default(''),
  agreementDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  validityStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  validityEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  targetValue: z.number().min(0).nullish(),
  paymentTermsCode: z.string().trim().max(12).optional().default(''),
  incotermsCode: z.string().trim().max(3).optional().default(''),
  incotermsLocation: z.string().trim().max(160).optional().default(''),
  yourReference: z.string().trim().max(12).optional().default(''),
  ourReference: z.string().trim().max(12).optional().default(''),
  languageCode: z.string().trim().max(2).optional().default(''),
  sourceContractNumber: z.string().trim().max(20).optional().default(''),
  requestKey: z.string().trim().max(64).optional(),
  items: z.array(itemInput).optional().default([]),
}).strict();

export type CreateContractInput = z.input<typeof documentInput>;

export interface ContractItemRow {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  targetQuantity: string | null;
  unit: string | null;
  netPrice: string;
  priceUnit: string;
  netValue: string;
  plant: string | null;
  storageLocation: string | null;
  accountAssignmentCategory: string | null;
  costCenter: string | null;
  glAccount: string | null;
  requisitionNumber: string | null;
  requisitionItem: number | null;
  rfqNumber: string | null;
  rfqItem: number | null;
  quotationNumber: string | null;
  quotationItem: number | null;
  markedForDeletion: boolean;
  calledOffQuantity: string;
  calledOffValue: string;
  remainingQuantity: string | null;
  goodsReceiptQuantity: string;
  invoiceValue: string;
}

export interface ContractDocument {
  contractNumber: string;
  documentType: string;
  category: 'QUANTITY' | 'VALUE';
  supplierNumber: string;
  purchasingOrg: string;
  purchasingGroup: string;
  companyCode: string;
  currency: string;
  agreementDate: string;
  validityStart: string;
  validityEnd: string;
  targetValue: string | null;
  paymentTermsCode: string | null;
  incotermsCode: string | null;
  incotermsLocation: string | null;
  yourReference: string | null;
  ourReference: string | null;
  languageCode: string | null;
  sourceContractNumber: string | null;
  calledOffValue: string;
  remainingValue: string | null;
  releaseStatus: 'NOT_REQUIRED' | 'PENDING' | 'RELEASED';
  items: ContractItemRow[];
}

export interface ContractListRow {
  contractNumber: string;
  documentType: string;
  category: string;
  supplierNumber: string;
  validityStart: string;
  validityEnd: string;
  targetValue: string | null;
  calledOffValue: string;
  remainingValue: string | null;
  releaseStatus: string;
}

function blank(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed.length > 0 ? trimmed : null;
}

function shown(value: string | number | boolean | null | undefined): string {
  if (value == null || value === '') return '';
  return String(value);
}

function contractSnapshot(row: {
  purchasingGroup: string;
  agreementDate: string;
  validityStart: string;
  validityEnd: string;
  targetValue: string | null;
  paymentTermsCode: string | null;
  incotermsCode: string | null;
  incotermsLocation: string | null;
  yourReference: string | null;
  ourReference: string | null;
  languageCode: string | null;
}): Record<string, unknown> {
  return {
    purchasingGroup: row.purchasingGroup,
    agreementDate: row.agreementDate,
    validityStart: row.validityStart,
    validityEnd: row.validityEnd,
    targetValue: shown(row.targetValue),
    paymentTermsCode: shown(row.paymentTermsCode),
    incotermsCode: shown(row.incotermsCode),
    incotermsLocation: shown(row.incotermsLocation),
    yourReference: shown(row.yourReference),
    ourReference: shown(row.ourReference),
    languageCode: shown(row.languageCode),
  };
}

function itemSnapshot(rows: Array<{
  itemNumber: number;
  shortText: string;
  materialNumber: string | null;
  plant: string | null;
  unit: string | null;
  targetQuantity: string | null;
  netPrice: string;
  markedForDeletion: boolean;
}>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const row of rows) {
    const key = `item${row.itemNumber}`;
    snapshot[`${key}Text`] = row.shortText;
    snapshot[`${key}Material`] = shown(row.materialNumber);
    snapshot[`${key}Plant`] = shown(row.plant);
    snapshot[`${key}Unit`] = shown(row.unit);
    snapshot[`${key}Quantity`] = shown(row.targetQuantity);
    snapshot[`${key}Price`] = shown(row.netPrice);
    snapshot[`${key}Deleted`] = row.markedForDeletion ? 'true' : 'false';
  }
  return snapshot;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function money(quantity: number, price: number, priceUnit: number): number {
  return round2(quantity * price / priceUnit);
}

async function businessDate(tx: Tx, client: string): Promise<string> {
  const [row] = await tx.select({ timezone: clientTable.timezone }).from(clientTable)
    .where(eq(clientTable.client, client));
  const zone = row?.timezone || 'UTC';
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function releaseStatus(
  tx: Tx,
  client: string,
  contractNumber: string,
): Promise<'NOT_REQUIRED' | 'PENDING' | 'RELEASED'> {
  const [row] = await tx.select({ status: documentRelease.status }).from(documentRelease).where(and(
    eq(documentRelease.client, client),
    eq(documentRelease.documentCategory, CONTRACT_CATEGORY),
    eq(documentRelease.documentNumber, contractNumber),
  ));
  if (row?.status === 'PENDING' || row?.status === 'RELEASED') return row.status;
  return 'NOT_REQUIRED';
}

async function lockContract(tx: Tx, client: string, contractNumber: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/purchase_contract/${contractNumber}`}, 0))`);
}

interface TypeRow {
  documentType: string;
  category: 'QUANTITY' | 'VALUE';
  numberRangeSubObject: string;
  itemInterval: number;
}

async function loadType(tx: Tx, client: string, documentType: string): Promise<TypeRow> {
  const code = documentType.trim().toUpperCase();
  const [row] = await tx.select().from(purchasingContractType).where(and(
    eq(purchasingContractType.client, client),
    eq(purchasingContractType.documentType, code),
    eq(purchasingContractType.isActive, true),
  ));
  if (!row) {
    throw new PurchaseContractError(
      `Document type ${code} is not an active purchase-contract type.`,
      'Maintain the contract type. MK and WK are not assumed when they are not configured.',
    );
  }
  return {
    documentType: row.documentType,
    category: row.category as 'QUANTITY' | 'VALUE',
    numberRangeSubObject: row.numberRangeSubObject,
    itemInterval: row.itemInterval,
  };
}

async function judgeHeader(
  tx: Tx,
  client: string,
  input: z.infer<typeof documentInput>,
  type: TypeRow,
  agreementDate: string,
): Promise<{
  currency: string;
  paymentTermsCode: string | null;
  incotermsCode: string | null;
  incotermsLocation: string | null;
}> {
  if (input.validityEnd < input.validityStart) {
    throw new PurchaseContractError('The validity end is before the validity start.');
  }
  const [partner] = await tx.select().from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, input.supplierNumber),
  ));
  if (!partner) {
    throw new PurchaseContractError(
      `Supplier ${input.supplierNumber} does not exist.`,
      'Choose a business partner that already has supplier purchasing data.',
    );
  }
  if (partner.isBlocked) throw new PurchaseContractError(`Supplier ${input.supplierNumber} is blocked.`);
  const [org] = await tx.select().from(purchasingOrg).where(and(
    eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, input.purchasingOrg),
  ));
  if (!org?.isActive) throw new PurchaseContractError(`Purchasing organization ${input.purchasingOrg} does not exist or is inactive.`);
  const [supplierOrg] = await tx.select().from(supplierPurchasing).where(and(
    eq(supplierPurchasing.client, client),
    eq(supplierPurchasing.partnerNumber, input.supplierNumber),
    eq(supplierPurchasing.purchasingOrg, input.purchasingOrg),
  ));
  if (!supplierOrg) {
    throw new PurchaseContractError(
      `Supplier ${input.supplierNumber} holds no purchasing data for organization ${input.purchasingOrg}.`,
      'Maintain the supplier purchasing defaults, or choose another supplier.',
    );
  }
  if (supplierOrg.isBlocked) {
    throw new PurchaseContractError(`Supplier ${input.supplierNumber} is blocked for purchasing organization ${input.purchasingOrg}.`);
  }
  const [group] = await tx.select().from(purchasingGroup).where(and(
    eq(purchasingGroup.client, client), eq(purchasingGroup.purchasingGroup, input.purchasingGroup),
  ));
  if (!group?.isActive) throw new PurchaseContractError(`Purchasing group ${input.purchasingGroup} does not exist or is inactive.`);
  const [company] = await tx.select().from(companyCode).where(and(
    eq(companyCode.client, client), eq(companyCode.companyCode, input.companyCode),
  ));
  if (!company) throw new PurchaseContractError(`Company code ${input.companyCode} does not exist.`);
  const currency = (input.currency || supplierOrg.orderCurrency || company.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new PurchaseContractError('A currency is required.');
  const [known] = await tx.select().from(currencyTable).where(eq(currencyTable.code, currency));
  if (!known) throw new PurchaseContractError(`Currency ${currency} is not defined.`);
  const paymentTermsCode = blank(input.paymentTermsCode) ?? supplierOrg.paymentTermsCode;
  if (paymentTermsCode) {
    const [terms] = await tx.select().from(paymentTerms).where(and(
      eq(paymentTerms.client, client), eq(paymentTerms.termsCode, paymentTermsCode),
    ));
    if (!terms) throw new PurchaseContractError(`Payment terms ${paymentTermsCode} do not exist.`);
  }
  const incotermsCode = (blank(input.incotermsCode) ?? supplierOrg.incotermsCode)?.toUpperCase() ?? null;
  if (incotermsCode && !INCOTERMS.includes(incotermsCode as typeof INCOTERMS[number])) {
    throw new PurchaseContractError(`Incoterm ${incotermsCode} is not a maintained delivery term.`);
  }
  const incotermsLocation = blank(input.incotermsLocation) ?? supplierOrg.incotermsLocation;
  if (type.category === 'VALUE' && !(input.targetValue && input.targetValue > 0)) {
    throw new PurchaseContractError(
      'A value contract needs a target value.',
      'Enter the header target value. Item values are not assumed to be the commitment.',
    );
  }
  if (input.languageCode && !/^[A-Za-z]{2}$/.test(input.languageCode)) {
    throw new PurchaseContractError('Language must be two letters when it is entered.');
  }
  if (agreementDate < input.validityStart || agreementDate > input.validityEnd) {
    throw new PurchaseContractError('The agreement date is outside the validity period.');
  }
  return { currency, paymentTermsCode, incotermsCode, incotermsLocation };
}

interface JudgedContractItem {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  targetQuantity: string | null;
  unit: string | null;
  netPrice: string;
  priceUnit: string;
  netValue: string;
  plant: string | null;
  storageLocation: string | null;
  materialGroup: string | null;
  accountAssignmentCategory: string | null;
  costCenter: string | null;
  glAccount: string | null;
  requisitionNumber: string | null;
  requisitionItem: number | null;
  rfqNumber: string | null;
  rfqItem: number | null;
  quotationNumber: string | null;
  quotationItem: number | null;
  infoRecordNumber: string | null;
  priceSequence: number | null;
  markedForDeletion: boolean;
}

async function judgeItem(
  tx: Tx,
  client: string,
  header: { companyCode: string; currency: string; supplierNumber: string; purchasingOrg: string },
  type: TypeRow,
  item: z.infer<typeof itemInput>,
  agreementDate: string,
  warnings: string[],
): Promise<Omit<JudgedContractItem, 'itemNumber'>> {
  let materialNumber = blank(item.materialNumber);
  let shortText = blank(item.shortText);
  let targetQuantity = item.targetQuantity ?? undefined;
  let unit = blank(item.unit);
  let plantCode = blank(item.plant);
  let storage = blank(item.storageLocation);
  let netPrice = item.netPrice ?? undefined;
  let priceUnit = item.priceUnit;
  let infoRecordNumber: string | null = null;
  let priceSequence: number | null = null;
  const requisitionNumber = blank(item.requisitionNumber);
  const requisitionItem = item.requisitionItem ?? null;
  const rfqNumber = blank(item.rfqNumber);
  const rfqItem = item.rfqItem ?? null;
  const quotationNumber = blank(item.quotationNumber);
  const quotationItem = item.quotationItem ?? null;
  if ((requisitionNumber == null) !== (requisitionItem == null)) {
    throw new PurchaseContractError('A requisition reference needs both the number and the item.');
  }
  if ((rfqNumber == null) !== (rfqItem == null)) {
    throw new PurchaseContractError('An RFQ reference needs both the number and the item.');
  }
  if ((quotationNumber == null) !== (quotationItem == null)) {
    throw new PurchaseContractError('A quotation reference needs both the number and the item.');
  }
  if (requisitionNumber && requisitionItem) {
    const [source] = await tx.select().from(purchaseRequisitionItem).where(and(
      eq(purchaseRequisitionItem.client, client),
      eq(purchaseRequisitionItem.requisitionNumber, requisitionNumber),
      eq(purchaseRequisitionItem.itemNumber, requisitionItem),
    ));
    if (!source) throw new PurchaseContractError(`Requisition ${requisitionNumber} item ${requisitionItem} does not exist.`);
    materialNumber = materialNumber ?? source.materialNumber;
    shortText = shortText ?? source.shortText;
    targetQuantity = targetQuantity ?? Number(source.quantity);
    unit = unit ?? source.unit;
    plantCode = plantCode ?? source.plant;
    storage = storage ?? source.storageLocation;
  }
  if (rfqNumber && rfqItem) {
    const [source] = await tx.select().from(purchasingRfqItem).where(and(
      eq(purchasingRfqItem.client, client),
      eq(purchasingRfqItem.rfqNumber, rfqNumber),
      eq(purchasingRfqItem.itemNumber, rfqItem),
    ));
    if (!source) throw new PurchaseContractError(`RFQ ${rfqNumber} item ${rfqItem} does not exist.`);
    const [request] = await tx.select().from(purchasingRfq).where(and(
      eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, rfqNumber),
    ));
    if (request && request.partnerNumber !== header.supplierNumber) {
      throw new PurchaseContractError(`RFQ ${rfqNumber} belongs to supplier ${request.partnerNumber}, not ${header.supplierNumber}.`);
    }
    materialNumber = materialNumber ?? source.materialNumber;
    shortText = shortText ?? source.shortText;
    targetQuantity = targetQuantity ?? Number(source.quantity);
    unit = unit ?? source.unit;
    plantCode = plantCode ?? source.plant;
    storage = storage ?? source.storageLocation;
  }
  if (quotationNumber && quotationItem) {
    const [source] = await tx.select().from(purchasingQuotationItem).where(and(
      eq(purchasingQuotationItem.client, client),
      eq(purchasingQuotationItem.quotationNumber, quotationNumber),
      eq(purchasingQuotationItem.itemNumber, quotationItem),
    ));
    if (!source) throw new PurchaseContractError(`Quotation ${quotationNumber} item ${quotationItem} does not exist.`);
    targetQuantity = targetQuantity ?? Number(source.quantity);
    unit = unit ?? source.unit;
    if (netPrice === undefined) {
      const [request] = await tx.select().from(purchasingRfq).where(and(
        eq(purchasingRfq.client, client), eq(purchasingRfq.rfqNumber, source.rfqNumber),
      ));
      const [event] = request ? await tx.select().from(purchasingRfqEvent).where(and(
        eq(purchasingRfqEvent.client, client), eq(purchasingRfqEvent.eventNumber, request.eventNumber),
      )) : [];
      let amount = Number(source.netPrice);
      if (event && event.currency !== header.currency) {
        try {
          amount = await convertMoney(tx, client, amount, event.currency, header.currency, agreementDate);
        } catch (error) {
          if (error instanceof FollowOnError) throw new PurchaseContractError(error.message, error.remedy);
          throw error;
        }
      }
      netPrice = round2(amount);
      priceUnit = Number(source.priceUnit);
      warnings.push(`Quotation ${quotationNumber} item ${quotationItem} supplied the price. The quotation was not changed.`);
    }
  }
  if (materialNumber) {
    const [row] = await tx.select().from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, materialNumber),
    ));
    if (!row) throw new PurchaseContractError(`Material ${materialNumber} does not exist.`);
    if (row.isBlocked) throw new PurchaseContractError(`Material ${materialNumber} is blocked.`);
    shortText = shortText ?? row.description;
  }
  if (!shortText) throw new PurchaseContractError('An item needs a short text or a material.');
  if (type.category === 'QUANTITY' && !(targetQuantity && targetQuantity > 0)) {
    throw new PurchaseContractError('A quantity-contract item needs a target quantity.');
  }
  if (targetQuantity != null && !unit) throw new PurchaseContractError('A target quantity needs a unit.');
  if (plantCode) {
    const [site] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, plantCode)));
    if (!site) throw new PurchaseContractError(`Plant ${plantCode} does not exist.`);
    if (site.companyCode !== header.companyCode) {
      throw new PurchaseContractError(`Plant ${plantCode} does not belong to company code ${header.companyCode}.`);
    }
    try {
      await assertPurchasingOrgForPlant(tx, {
        client, purchasingOrg: header.purchasingOrg, plant: plantCode, documentType: 'PURCHASE_CONTRACT',
      });
    } catch (error) {
      if (error instanceof PurchasingOrgPlantAuthorizationError) {
        throw new PurchaseContractError(error.message, error.remedy);
      }
      throw error;
    }
  }
  if (storage) {
    if (!plantCode) throw new PurchaseContractError('A storage location needs a plant. The plant itself is not required.');
    const [location] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client),
      eq(storageLocation.plant, plantCode),
      eq(storageLocation.storageLocation, storage),
    ));
    if (!location?.isActive) throw new PurchaseContractError(`Storage location ${storage} does not stand at plant ${plantCode}.`);
  }
  if (netPrice === undefined && materialNumber && plantCode) {
    const record = await resolvePurchasingInfoRecord(tx, {
      client,
      partnerNumber: header.supplierNumber,
      materialNumber,
      purchasingOrg: header.purchasingOrg,
      plant: plantCode,
      pricingDate: agreementDate,
      orderCurrency: header.currency,
    });
    if (record.qualified && record.amount != null) {
      let amount = Number(record.amount);
      if (record.currency && record.currency !== header.currency) {
        try {
          amount = await convertMoney(tx, client, amount, record.currency, header.currency, agreementDate);
        } catch (error) {
          if (error instanceof FollowOnError) throw new PurchaseContractError(error.message, error.remedy);
          throw error;
        }
      }
      netPrice = round2(amount);
      priceUnit = record.priceUnit ?? priceUnit;
      infoRecordNumber = record.infoRecordNumber ?? null;
      priceSequence = record.priceSequence ?? null;
      unit = unit ?? record.orderUnit ?? null;
      warnings.push(`Info record ${record.infoRecordNumber} supplied the omitted price.`);
    } else if (record.warning) warnings.push(record.warning);
  }
  if (netPrice === undefined) {
    throw new PurchaseContractError(
      'A net price is required.',
      'Enter a price, or name a plant so an info record can supply one. Condition-based pricing is not this document.',
    );
  }
  let accountAssignmentCategory = item.accountAssignmentCategory;
  let assignedCostCenter = blank(item.costCenter);
  let assignedAccount = blank(item.glAccount);
  if (accountAssignmentCategory === 'COST_CENTER') {
    if (!assignedCostCenter || !assignedAccount) {
      throw new PurchaseContractError('A cost-centre assignment needs both the cost centre and the G/L account.');
    }
    const [company] = await tx.select().from(companyCode).where(and(
      eq(companyCode.client, client), eq(companyCode.companyCode, header.companyCode),
    ));
    const [area] = await tx.select().from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, client), eq(controllingAreaCompany.companyCode, header.companyCode),
    ));
    if (!area) throw new PurchaseContractError(`Company code ${header.companyCode} belongs to no controlling area.`);
    const centres = await tx.select().from(costCenter).where(and(
      eq(costCenter.client, client),
      eq(costCenter.controllingArea, area.controllingArea),
      eq(costCenter.costCenter, assignedCostCenter),
    ));
    const standing = centres.find((row) => row.validFrom <= agreementDate && row.validTo >= agreementDate);
    if (!standing) throw new PurchaseContractError(`Cost centre ${assignedCostCenter} is not valid on ${agreementDate}.`);
    if (standing.isPostingLocked) throw new PurchaseContractError(`Cost centre ${assignedCostCenter} is locked for postings.`);
    if (!company?.chartOfAccounts) throw new PurchaseContractError(`Company code ${header.companyCode} has no chart of accounts.`);
    const [account] = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, company.chartOfAccounts),
      eq(glAccount.accountNumber, assignedAccount),
    ));
    if (!account) throw new PurchaseContractError(`G/L account ${assignedAccount} does not exist.`);
    if (account.isBalanceSheet) throw new PurchaseContractError(`G/L account ${assignedAccount} is a balance-sheet account.`);
  } else if (assignedCostCenter || assignedAccount) {
    throw new PurchaseContractError('A cost centre or G/L account needs the cost-centre assignment category. Asset, WBS, and internal order are not assignment categories here.');
  } else {
    accountAssignmentCategory = null;
    assignedCostCenter = null;
    assignedAccount = null;
  }
  const quantity = targetQuantity ?? null;
  const value = quantity == null ? 0 : money(quantity, netPrice, priceUnit);
  return {
    materialNumber,
    shortText: shortText.slice(0, 40),
    targetQuantity: quantity == null ? null : quantity.toFixed(3),
    unit,
    netPrice: netPrice.toFixed(2),
    priceUnit: String(priceUnit),
    netValue: value.toFixed(2),
    plant: plantCode,
    storageLocation: storage,
    materialGroup: null,
    accountAssignmentCategory,
    costCenter: assignedCostCenter,
    glAccount: assignedAccount,
    requisitionNumber,
    requisitionItem,
    rfqNumber,
    rfqItem,
    quotationNumber,
    quotationItem,
    infoRecordNumber,
    priceSequence,
    markedForDeletion: item.markedForDeletion,
  };
}

async function calledOff(tx: Tx, client: string, contractNumber: string): Promise<Map<number, { quantity: number; value: number }>> {
  const rows = await tx.select({
    contractItem: purchaseOrderItem.contractItem,
    quantity: purchaseOrderItem.quantity,
    netValue: purchaseOrderItem.netValue,
    marked: purchaseOrderItem.markedForDeletion,
  }).from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client),
    eq(purchaseOrderItem.contractNumber, contractNumber),
  ));
  const map = new Map<number, { quantity: number; value: number }>();
  for (const row of rows) {
    if (row.marked || row.contractItem == null) continue;
    const current = map.get(row.contractItem) ?? { quantity: 0, value: 0 };
    current.quantity += Number(row.quantity);
    current.value += Number(row.netValue);
    map.set(row.contractItem, current);
  }
  return map;
}

function releaseAttributes(header: {
  purchasingGroup: string;
  companyCode: string;
  supplierNumber: string;
  purchasingOrg: string;
  targetValue: string | null;
}, items: Array<{ plant: string | null; netValue: string; markedForDeletion: boolean }>) {
  const standing = items.filter((item) => !item.markedForDeletion);
  const total = header.targetValue != null
    ? Number(header.targetValue)
    : standing.reduce((sum, item) => sum + Number(item.netValue), 0);
  const attributes: Record<string, string | number> = {
    TOTAL_VALUE: round2(total),
    PURCHASING_GROUP: header.purchasingGroup,
    COMPANY_CODE: header.companyCode,
    SUPPLIER: header.supplierNumber,
    PURCHASING_ORG: header.purchasingOrg,
  };
  const plants = [...new Set(standing.map((item) => item.plant).filter((value): value is string => Boolean(value)))];
  if (plants.length === 1) attributes.PLANT = plants[0];
  return attributes;
}

async function insertItem(
  tx: Tx,
  client: string,
  contractNumber: string,
  item: JudgedContractItem,
  changedBy: string,
): Promise<void> {
  await tx.insert(purchaseContractItem).values({
    client,
    contractNumber,
    ...item,
    createdBy: changedBy,
  });
}

async function copySourceItems(
  tx: Tx,
  client: string,
  sourceNumber: string,
): Promise<z.infer<typeof itemInput>[]> {
  const items = await tx.select().from(purchaseContractItem).where(and(
    eq(purchaseContractItem.client, client),
    eq(purchaseContractItem.contractNumber, sourceNumber),
    eq(purchaseContractItem.markedForDeletion, false),
  )).orderBy(asc(purchaseContractItem.itemNumber));
  return items.map((item) => ({
    materialNumber: item.materialNumber ?? '',
    shortText: item.shortText,
    targetQuantity: item.targetQuantity == null ? undefined : Number(item.targetQuantity),
    unit: item.unit ?? '',
    netPrice: Number(item.netPrice),
    priceUnit: Number(item.priceUnit),
    plant: item.plant ?? '',
    storageLocation: item.storageLocation ?? '',
    accountAssignmentCategory: item.accountAssignmentCategory === 'COST_CENTER' ? 'COST_CENTER' as const : null,
    costCenter: item.costCenter ?? '',
    glAccount: item.glAccount ?? '',
    requisitionNumber: item.requisitionNumber ?? '',
    requisitionItem: item.requisitionItem ?? undefined,
    rfqNumber: item.rfqNumber ?? '',
    rfqItem: item.rfqItem ?? undefined,
    quotationNumber: item.quotationNumber ?? '',
    quotationItem: item.quotationItem ?? undefined,
    markedForDeletion: false,
  }));
}

export async function createPurchaseContract(
  raw: CreateContractInput,
): Promise<{ contractNumber: string; warnings: string[] }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PurchaseContractError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const warnings: string[] = [];
  const contractNumber = await withTenant(input.client, async (tx) => {
    if (input.requestKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/purchase_contract/request/${input.requestKey}`}, 0))`);
      const [existing] = await tx.select().from(purchaseContract).where(and(
        eq(purchaseContract.client, input.client), eq(purchaseContract.requestKey, input.requestKey),
      ));
      if (existing) return existing.contractNumber;
    }
    const type = await loadType(tx, input.client, input.documentType);
    const agreementDate = input.agreementDate ?? await businessDate(tx, input.client);
    const header = await judgeHeader(tx, input.client, input, type, agreementDate);
    const source = blank(input.sourceContractNumber);
    if (source) {
      const [origin] = await tx.select().from(purchaseContract).where(and(
        eq(purchaseContract.client, input.client), eq(purchaseContract.contractNumber, source),
      ));
      if (!origin) throw new PurchaseContractError(`Source contract ${source} does not exist.`);
      if (origin.category !== type.category) {
        throw new PurchaseContractError(`Source contract ${source} is a ${origin.category} contract, not ${type.category}.`);
      }
    }
    const meaningful = input.items.filter((item) => Boolean(
      item.materialNumber || item.shortText || item.targetQuantity || item.requisitionNumber || item.rfqNumber || item.quotationNumber,
    ));
    const requested = meaningful.length > 0 ? meaningful : source ? await copySourceItems(tx, input.client, source) : [];
    if (requested.length === 0) throw new PurchaseContractError('A contract needs at least one item.');
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client,
        objectCode: 'PURCHCONT',
        companyCode: '*',
        subObject: type.numberRangeSubObject || '*',
        fiscalYear: 0,
        allocatedBy: input.changedBy,
      });
    } catch {
      throw new PurchaseContractError(
        'No active internal PURCHCONT number range stands, so no contract number can be drawn.',
        'Define the purchase-contract interval, then save again.',
      );
    }
    const number = drawn.display;
    await lockContract(tx, input.client, number);
    await tx.insert(purchaseContract).values({
      client: input.client,
      contractNumber: number,
      documentType: type.documentType,
      category: type.category,
      supplierNumber: input.supplierNumber,
      purchasingOrg: input.purchasingOrg,
      purchasingGroup: input.purchasingGroup,
      companyCode: input.companyCode,
      currency: header.currency,
      agreementDate,
      validityStart: input.validityStart,
      validityEnd: input.validityEnd,
      targetValue: input.targetValue == null ? null : input.targetValue.toFixed(2),
      paymentTermsCode: header.paymentTermsCode,
      incotermsCode: header.incotermsCode,
      incotermsLocation: header.incotermsLocation,
      yourReference: blank(input.yourReference),
      ourReference: blank(input.ourReference),
      languageCode: blank(input.languageCode)?.toUpperCase() ?? null,
      sourceContractNumber: source,
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy,
    });
    const judged: JudgedContractItem[] = [];
    let itemNumber = 0;
    for (const item of requested) {
      itemNumber += type.itemInterval;
      judged.push({
        itemNumber,
        ...await judgeItem(tx, input.client, {
          companyCode: input.companyCode,
          currency: header.currency,
          supplierNumber: input.supplierNumber,
          purchasingOrg: input.purchasingOrg,
        }, type, item, agreementDate, warnings),
      });
    }
    const itemValue = judged.filter((item) => !item.markedForDeletion).reduce((sum, item) => sum + Number(item.netValue), 0);
    if (input.targetValue != null && itemValue - input.targetValue > 0.005) {
      warnings.push('The item values exceed the header target value. The header target remains the value commitment. The items were not refused.');
    }
    for (const item of judged) await insertItem(tx, input.client, number, item, input.changedBy);
    await syncDocumentRelease(
      tx, input.client, CONTRACT_CATEGORY, number,
      releaseAttributes({
        purchasingGroup: input.purchasingGroup,
        companyCode: input.companyCode,
        supplierNumber: input.supplierNumber,
        purchasingOrg: input.purchasingOrg,
        targetValue: input.targetValue == null ? null : input.targetValue.toFixed(2),
      }, judged),
      input.changedBy,
    );
    await recordChange(tx, {
      client: input.client,
      objectClass: CONTRACT_OBJECT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      after: { documentType: type.documentType, category: type.category, supplier: input.supplierNumber, items: judged.length },
    });
    return number;
  });
  return { contractNumber, warnings };
}

export async function changePurchaseContract(
  raw: CreateContractInput & { contractNumber: string },
): Promise<{ contractNumber: string; warnings: string[] }> {
  const { contractNumber: suppliedNumber, ...document } = raw;
  const parsed = documentInput.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PurchaseContractError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const number = suppliedNumber.trim();
  if (!number) throw new PurchaseContractError('A contract number is required.');
  const warnings: string[] = [];
  await withTenant(input.client, async (tx) => {
    await lockContract(tx, input.client, number);
    try {
      await assertDocumentNotReleased(tx, input.client, CONTRACT_CATEGORY, number, 'Purchase contract');
    } catch (error) {
      if (error instanceof ReleaseError) throw new PurchaseContractError(error.message, error.remedy);
      throw error;
    }
    const [before] = await tx.select().from(purchaseContract).where(and(
      eq(purchaseContract.client, input.client), eq(purchaseContract.contractNumber, number),
    ));
    if (!before) throw new PurchaseContractError(`Contract ${number} does not exist.`);
    if (input.documentType.trim().toUpperCase() !== before.documentType) {
      throw new PurchaseContractError('The document type cannot be changed after the contract is saved.');
    }
    if (input.supplierNumber !== before.supplierNumber || input.purchasingOrg !== before.purchasingOrg || input.companyCode !== before.companyCode) {
      throw new PurchaseContractError('Supplier, purchasing organization, and company code stay as saved. A call-off matches those fields.');
    }
    const type = await loadType(tx, input.client, before.documentType);
    const agreementDate = input.agreementDate ?? before.agreementDate;
    const header = await judgeHeader(tx, input.client, input, type, agreementDate);
    if (header.currency !== before.currency) {
      throw new PurchaseContractError('The contract currency cannot be changed after it is saved.');
    }
    const usage = await calledOff(tx, input.client, number);
    const calledValue = [...usage.values()].reduce((sum, row) => sum + row.value, 0);
    if (type.category === 'VALUE' && input.targetValue != null && calledValue - input.targetValue > 0.005) {
      throw new PurchaseContractError(`Target value ${input.targetValue.toFixed(2)} is below the called-off value ${calledValue.toFixed(2)}.`);
    }
    const dates = await tx.select({ documentDate: purchaseOrder.documentDate }).from(purchaseOrderItem)
      .innerJoin(purchaseOrder, and(
        eq(purchaseOrder.client, purchaseOrderItem.client),
        eq(purchaseOrder.orderNumber, purchaseOrderItem.orderNumber),
      ))
      .where(and(
        eq(purchaseOrderItem.client, input.client),
        eq(purchaseOrderItem.contractNumber, number),
        eq(purchaseOrderItem.markedForDeletion, false),
      ));
    if (dates.some((row) => row.documentDate < input.validityStart || row.documentDate > input.validityEnd)) {
      throw new PurchaseContractError('The new validity period excludes a purchase order that already calls this contract.');
    }
    await tx.update(purchaseContract).set({
      purchasingGroup: input.purchasingGroup,
      agreementDate,
      validityStart: input.validityStart,
      validityEnd: input.validityEnd,
      targetValue: input.targetValue == null ? before.targetValue : input.targetValue.toFixed(2),
      paymentTermsCode: header.paymentTermsCode,
      incotermsCode: header.incotermsCode,
      incotermsLocation: header.incotermsLocation,
      yourReference: blank(input.yourReference),
      ourReference: blank(input.ourReference),
      languageCode: blank(input.languageCode)?.toUpperCase() ?? null,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(eq(purchaseContract.client, input.client), eq(purchaseContract.contractNumber, number)));
    const standing = await tx.select().from(purchaseContractItem).where(and(
      eq(purchaseContractItem.client, input.client), eq(purchaseContractItem.contractNumber, number),
    ));
    const standingNumbers = new Set(standing.map((item) => item.itemNumber));
    let maxItem = Math.max(0, ...standingNumbers);
    for (const item of input.items) {
      const isNew = item.itemNumber === undefined || !standingNumbers.has(item.itemNumber);
      const itemNumber = isNew ? (maxItem += type.itemInterval) : item.itemNumber as number;
      const judged = await judgeItem(tx, input.client, {
        companyCode: before.companyCode,
        currency: before.currency,
        supplierNumber: before.supplierNumber,
        purchasingOrg: before.purchasingOrg,
      }, type, item, agreementDate, warnings);
      const used = usage.get(itemNumber);
      const previous = standing.find((row) => row.itemNumber === itemNumber);
      if (used && used.quantity > 0 && previous) {
        if ((judged.materialNumber ?? null) !== (previous.materialNumber ?? null)) {
          throw new PurchaseContractError(
            `Item ${itemNumber} material cannot change after a call-off.`,
            'The existing purchase order keeps its material. This change does not rewrite it.',
          );
        }
        if ((judged.unit ?? null) !== (previous.unit ?? null)) {
          throw new PurchaseContractError(
            `Item ${itemNumber} unit cannot change after a call-off.`,
            'The existing purchase order keeps its unit. This change does not rewrite it.',
          );
        }
        if ((judged.plant ?? null) !== (previous.plant ?? null)) {
          throw new PurchaseContractError(
            `Item ${itemNumber} plant cannot change after a call-off.`,
            'The existing purchase order keeps its plant. This change does not rewrite it.',
          );
        }
      }
      if (used && used.quantity > 0 && judged.markedForDeletion) {
        throw new PurchaseContractError(`Item ${itemNumber} has a call-off and cannot be marked for deletion.`);
      }
      if (used && judged.targetQuantity != null && used.quantity - Number(judged.targetQuantity) > 0.0005) {
        throw new PurchaseContractError(`Item ${itemNumber} target quantity is below the called-off quantity ${used.quantity}.`);
      }
      if (isNew) {
        await insertItem(tx, input.client, number, { itemNumber, ...judged }, input.changedBy);
      } else {
        await tx.update(purchaseContractItem).set({
          ...judged,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(purchaseContractItem.client, input.client),
          eq(purchaseContractItem.contractNumber, number),
          eq(purchaseContractItem.itemNumber, itemNumber),
        ));
      }
    }
    const afterItems = await tx.select().from(purchaseContractItem).where(and(
      eq(purchaseContractItem.client, input.client), eq(purchaseContractItem.contractNumber, number),
    ));
    await syncDocumentRelease(
      tx, input.client, CONTRACT_CATEGORY, number,
      releaseAttributes({
        purchasingGroup: input.purchasingGroup,
        companyCode: before.companyCode,
        supplierNumber: before.supplierNumber,
        purchasingOrg: before.purchasingOrg,
        targetValue: input.targetValue == null ? before.targetValue : input.targetValue.toFixed(2),
      }, afterItems),
      input.changedBy,
    );
    const [savedHeader] = await tx.select().from(purchaseContract).where(and(
      eq(purchaseContract.client, input.client), eq(purchaseContract.contractNumber, number),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: CONTRACT_OBJECT_CLASS,
      objectKey: number,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'ME32K',
      before: { ...contractSnapshot(before), ...itemSnapshot(standing) },
      after: { ...contractSnapshot(savedHeader ?? before), ...itemSnapshot(afterItems) },
    });
  });
  return { contractNumber: number, warnings };
}

async function movementTotals(
  tx: Tx,
  client: string,
  contractNumber: string,
): Promise<{ goods: Map<number, number>; invoices: Map<number, number> }> {
  const goods = new Map<number, number>();
  const invoices = new Map<number, number>();
  const lines = await tx.select({
    contractItem: purchaseOrderItem.contractItem,
    document: materialDocumentLine.materialDocumentNumber,
    line: materialDocumentLine.lineNumber,
    quantity: materialDocumentLine.baseQuantity,
    direction: materialDocumentLine.lineDirection,
    movement: materialDocumentLine.movementType,
    reversalOfDocument: materialDocumentLine.reversalOfDocument,
    reversalOfLine: materialDocumentLine.reversalOfLine,
  }).from(materialDocumentLine).innerJoin(purchaseOrderItem, and(
    eq(materialDocumentLine.client, purchaseOrderItem.client),
    eq(materialDocumentLine.purchaseOrderNumber, purchaseOrderItem.orderNumber),
    eq(materialDocumentLine.purchaseOrderItem, purchaseOrderItem.itemNumber),
  )).where(and(
    eq(purchaseOrderItem.client, client),
    eq(purchaseOrderItem.contractNumber, contractNumber),
  ));
  const configured = new Map<string, string>();
  for (const row of await tx.select().from(movementType).where(eq(movementType.client, client))) {
    configured.set(row.movementType, row.direction);
  }
  const sign = new Map<string, number>();
  for (const line of lines) {
    const direction = configured.get(line.movement) ?? line.direction;
    if (direction === 'REVERSAL') continue;
    sign.set(`${line.document}/${line.line}`, direction === 'ISSUE' ? -1 : 1);
  }
  for (const line of lines) {
    const direction = configured.get(line.movement) ?? line.direction;
    if (direction !== 'REVERSAL' || !line.reversalOfDocument || line.reversalOfLine == null) continue;
    sign.set(`${line.document}/${line.line}`, -(sign.get(`${line.reversalOfDocument}/${line.reversalOfLine}`) ?? 1));
  }
  for (const line of lines) {
    if (line.contractItem == null) continue;
    const rowSign = sign.get(`${line.document}/${line.line}`) ?? 1;
    goods.set(line.contractItem, (goods.get(line.contractItem) ?? 0) + rowSign * Number(line.quantity));
  }
  const bills = await tx.select({
    contractItem: purchaseOrderItem.contractItem,
    amount: supplierInvoiceItem.netAmount,
    status: supplierInvoice.status,
    category: supplierInvoice.category,
  }).from(supplierInvoiceItem).innerJoin(supplierInvoice, and(
    eq(supplierInvoice.client, supplierInvoiceItem.client),
    eq(supplierInvoice.invoiceNumber, supplierInvoiceItem.invoiceNumber),
  )).innerJoin(purchaseOrderItem, and(
    eq(purchaseOrderItem.client, supplierInvoiceItem.client),
    eq(purchaseOrderItem.orderNumber, supplierInvoiceItem.purchaseOrderNumber),
    eq(purchaseOrderItem.itemNumber, supplierInvoiceItem.purchaseOrderItem),
  )).where(and(
    eq(purchaseOrderItem.client, client),
    eq(purchaseOrderItem.contractNumber, contractNumber),
  ));
  for (const bill of bills) {
    if (bill.contractItem == null || bill.status !== 'POSTED' || bill.category !== 'INVOICE') continue;
    invoices.set(bill.contractItem, (invoices.get(bill.contractItem) ?? 0) + Number(bill.amount));
  }
  return { goods, invoices };
}

export async function getPurchaseContract(client: string, contractNumber: string): Promise<ContractDocument | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(purchaseContract).where(and(
      eq(purchaseContract.client, client), eq(purchaseContract.contractNumber, contractNumber),
    ));
    if (!header) return null;
    const items = await tx.select().from(purchaseContractItem).where(and(
      eq(purchaseContractItem.client, client), eq(purchaseContractItem.contractNumber, contractNumber),
    )).orderBy(asc(purchaseContractItem.itemNumber));
    const usage = await calledOff(tx, client, contractNumber);
    const movement = await movementTotals(tx, client, contractNumber);
    const release = await releaseStatus(tx, client, contractNumber);
    const calledValue = [...usage.values()].reduce((sum, row) => sum + row.value, 0);
    return {
      contractNumber: header.contractNumber,
      documentType: header.documentType,
      category: header.category as 'QUANTITY' | 'VALUE',
      supplierNumber: header.supplierNumber,
      purchasingOrg: header.purchasingOrg,
      purchasingGroup: header.purchasingGroup,
      companyCode: header.companyCode,
      currency: header.currency,
      agreementDate: header.agreementDate,
      validityStart: header.validityStart,
      validityEnd: header.validityEnd,
      targetValue: header.targetValue,
      paymentTermsCode: header.paymentTermsCode,
      incotermsCode: header.incotermsCode,
      incotermsLocation: header.incotermsLocation,
      yourReference: header.yourReference,
      ourReference: header.ourReference,
      languageCode: header.languageCode,
      sourceContractNumber: header.sourceContractNumber,
      calledOffValue: calledValue.toFixed(2),
      remainingValue: header.targetValue == null ? null : (Number(header.targetValue) - calledValue).toFixed(2),
      releaseStatus: release,
      items: items.map((item) => {
        const used = usage.get(item.itemNumber) ?? { quantity: 0, value: 0 };
        const target = item.targetQuantity == null ? null : Number(item.targetQuantity);
        return {
          itemNumber: item.itemNumber,
          materialNumber: item.materialNumber,
          shortText: item.shortText,
          targetQuantity: item.targetQuantity,
          unit: item.unit,
          netPrice: item.netPrice,
          priceUnit: item.priceUnit,
          netValue: item.netValue,
          plant: item.plant,
          storageLocation: item.storageLocation,
          accountAssignmentCategory: item.accountAssignmentCategory,
          costCenter: item.costCenter,
          glAccount: item.glAccount,
          requisitionNumber: item.requisitionNumber,
          requisitionItem: item.requisitionItem,
          rfqNumber: item.rfqNumber,
          rfqItem: item.rfqItem,
          quotationNumber: item.quotationNumber,
          quotationItem: item.quotationItem,
          markedForDeletion: item.markedForDeletion,
          calledOffQuantity: used.quantity.toFixed(3),
          calledOffValue: used.value.toFixed(2),
          remainingQuantity: target == null ? null : (target - used.quantity).toFixed(3),
          goodsReceiptQuantity: (movement.goods.get(item.itemNumber) ?? 0).toFixed(3),
          invoiceValue: (movement.invoices.get(item.itemNumber) ?? 0).toFixed(2),
        };
      }),
    };
  });
}

export async function contractChoices(client: string): Promise<{
  types: Array<{ documentType: string; description: string; category: string }>;
  suppliers: Array<{ partnerNumber: string; name: string }>;
  organizations: Array<{ purchasingOrg: string; name: string }>;
  groups: Array<{ purchasingGroup: string; name: string }>;
  companies: Array<{ companyCode: string; name: string }>;
  plants: Array<{ plant: string; name: string }>;
}> {
  return withTenant(client, async (tx) => {
    const [types, suppliers, organizations, groups, companies, plants] = await Promise.all([
      tx.select().from(purchasingContractType).where(and(
        eq(purchasingContractType.client, client), eq(purchasingContractType.isActive, true),
      )).orderBy(asc(purchasingContractType.documentType)),
      tx.select().from(businessPartner).where(eq(businessPartner.client, client)).orderBy(asc(businessPartner.partnerNumber)),
      tx.select().from(purchasingOrg).where(eq(purchasingOrg.client, client)).orderBy(asc(purchasingOrg.purchasingOrg)),
      tx.select().from(purchasingGroup).where(eq(purchasingGroup.client, client)).orderBy(asc(purchasingGroup.purchasingGroup)),
      tx.select().from(companyCode).where(eq(companyCode.client, client)).orderBy(asc(companyCode.companyCode)),
      tx.select().from(plant).where(eq(plant.client, client)).orderBy(asc(plant.plant)),
    ]);
    return {
      types: types.map((row) => ({ documentType: row.documentType, description: row.description, category: row.category })),
      suppliers: suppliers.map((row) => ({ partnerNumber: row.partnerNumber, name: row.name })),
      organizations: organizations.map((row) => ({ purchasingOrg: row.purchasingOrg, name: row.name })),
      groups: groups.map((row) => ({ purchasingGroup: row.purchasingGroup, name: row.name })),
      companies: companies.map((row) => ({ companyCode: row.companyCode, name: row.name })),
      plants: plants.map((row) => ({ plant: row.plant, name: row.name })),
    };
  });
}

export async function listPurchaseContracts(client: string): Promise<ContractListRow[]> {
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(purchaseContract).where(eq(purchaseContract.client, client))
      .orderBy(asc(purchaseContract.contractNumber));
    const rows: ContractListRow[] = [];
    for (const header of headers) {
      const usage = await calledOff(tx, client, header.contractNumber);
      const calledValue = [...usage.values()].reduce((sum, row) => sum + row.value, 0);
      const release = await releaseStatus(tx, client, header.contractNumber);
      rows.push({
        contractNumber: header.contractNumber,
        documentType: header.documentType,
        category: header.category,
        supplierNumber: header.supplierNumber,
        validityStart: header.validityStart,
        validityEnd: header.validityEnd,
        targetValue: header.targetValue,
        calledOffValue: calledValue.toFixed(2),
        remainingValue: header.targetValue == null ? null : (Number(header.targetValue) - calledValue).toFixed(2),
        releaseStatus: release,
      });
    }
    return rows;
  });
}

/**
 * A saved purchase-order item consumes the contract. This does not post a
 * goods receipt or an invoice. There is no draft status to exclude.
 */
export async function assertPurchaseContractCallOff(
  tx: Tx,
  client: string,
  orderNumber: string,
  itemNumber: number,
): Promise<void> {
  const [item] = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client),
    eq(purchaseOrderItem.orderNumber, orderNumber),
    eq(purchaseOrderItem.itemNumber, itemNumber),
  ));
  if (!item?.contractNumber || item.contractItem == null || item.markedForDeletion) return;
  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
  ));
  if (!header) return;
  await lockContract(tx, client, item.contractNumber);
  const [contract] = await tx.select().from(purchaseContract).where(and(
    eq(purchaseContract.client, client), eq(purchaseContract.contractNumber, item.contractNumber),
  ));
  if (!contract) {
    throw new PurchaseContractError(`Contract ${item.contractNumber} does not exist.`);
  }
  const [contractItem] = await tx.select().from(purchaseContractItem).where(and(
    eq(purchaseContractItem.client, client),
    eq(purchaseContractItem.contractNumber, item.contractNumber),
    eq(purchaseContractItem.itemNumber, item.contractItem),
  ));
  if (!contractItem || contractItem.markedForDeletion) {
    throw new PurchaseContractError(`Contract ${item.contractNumber} item ${item.contractItem} is not open.`);
  }
  if (header.supplierNumber !== contract.supplierNumber || header.purchasingOrg !== contract.purchasingOrg || header.companyCode !== contract.companyCode) {
    throw new PurchaseContractError('The purchase order supplier, purchasing organization, and company code must match the contract.');
  }
  if (header.currency !== contract.currency) {
    throw new PurchaseContractError(`The purchase order currency ${header.currency} does not match contract currency ${contract.currency}.`);
  }
  if (header.documentDate < contract.validityStart || header.documentDate > contract.validityEnd) {
    throw new PurchaseContractError(`Purchase order date ${header.documentDate} is outside contract validity ${contract.validityStart} to ${contract.validityEnd}.`);
  }
  if (contractItem.plant && contractItem.plant !== item.plant) {
    throw new PurchaseContractError(`Contract item ${item.contractItem} is for plant ${contractItem.plant}, not ${item.plant}.`);
  }
  if (contractItem.unit && contractItem.unit !== item.unit) {
    throw new PurchaseContractError(`Contract item ${item.contractItem} is in ${contractItem.unit}, not ${item.unit}.`);
  }
  const release = await releaseStatus(tx, client, item.contractNumber);
  if (release === 'PENDING') {
    throw new PurchaseContractError(
      `Contract ${item.contractNumber} is waiting for release.`,
      'Release it with ME35K, or remove the release strategy if this contract should not require one.',
    );
  }
  const usage = await calledOff(tx, client, item.contractNumber);
  if (contractItem.targetQuantity != null) {
    const used = usage.get(item.contractItem)?.quantity ?? 0;
    if (used - Number(contractItem.targetQuantity) > 0.0005) {
      throw new PurchaseContractError(
        `Call-off quantity ${used} exceeds target quantity ${contractItem.targetQuantity} on contract ${item.contractNumber} item ${item.contractItem}.`,
        'No overdelivery tolerance is configured, so the target quantity is the limit.',
      );
    }
  }
  if (contract.category === 'VALUE' && contract.targetValue != null) {
    const used = [...usage.values()].reduce((sum, row) => sum + row.value, 0);
    if (used - Number(contract.targetValue) > 0.005) {
      throw new PurchaseContractError(
        `Call-off value ${used.toFixed(2)} exceeds target value ${contract.targetValue} on contract ${item.contractNumber}.`,
      );
    }
  }
}
