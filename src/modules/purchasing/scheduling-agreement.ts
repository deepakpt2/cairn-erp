/**
 * Scheduling agreement — ME31L create, ME32L change, ME33L display,
 * ME35L release when a strategy claims the document, ME3L list.
 *
 * This is not a purchase contract and not a purchase order. Saving it
 * does not create a delivery schedule line, a goods receipt, or an
 * accounting document. ME38 maintains schedule lines. ME39 displays them.
 * LP is a configured type row, not a meaning in this service. The price
 * is the typed price or the info-record price. There is no second
 * pricing calculator.
 */
import { and, asc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { currency as currencyTable, unitOfMeasure } from '../../platform/tables/reference';
import { businessPartner, bpRole } from '../foundation/business-partner-schema';
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
import { material, materialPlant } from '../inventory/schema';
import { resolvePurchasingInfoRecord } from './info-record';
import {
  ReleaseError,
  assertDocumentNotReleased,
  syncDocumentRelease,
} from './release';
import {
  documentRelease,
  purchaseRequisitionItem,
  schedulingAgreement,
  schedulingAgreementItem,
  schedulingAgreementScheduleLine,
  schedulingAgreementType,
} from './schema';

export const SCHEDULING_AGREEMENT_MAINTAIN_CAPABILITY = 'PROC.SCHEDAGREE.MAINTAIN';
export const SCHEDULING_AGREEMENT_DISPLAY_CAPABILITY = 'PROC.SCHEDAGREE.DISPLAY';
export const SCHEDULING_AGREEMENT_LIST_CAPABILITY = 'PROC.SCHEDAGREE.LIST';
export const SCHEDULING_AGREEMENT_OBJECT_CLASS = 'scheduling_agreement';
export const SCHEDULING_AGREEMENT_CATEGORY = 'SCHED_AGREEMENT';
export const SCHEDULING_AGREEMENT_ROUTE = '/purchasing/scheduling-agreements';

const INCOTERMS = ['EXW', 'FCA', 'FAS', 'FOB', 'CFR', 'CIF', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'] as const;

export class SchedulingAgreementError extends Error {
  readonly remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'SchedulingAgreementError';
    this.remedy = remedy;
  }
}

const itemInput = z.object({
  itemNumber: z.number().int().positive().optional(),
  materialNumber: z.string().trim().max(40).optional().default(''),
  shortText: z.string().trim().max(40).optional().default(''),
  targetQuantity: z.number().positive(),
  unit: z.string().trim().max(6).optional().default(''),
  netPrice: z.number().min(0).nullish(),
  priceUnit: z.number().int().positive().optional().default(1),
  plant: z.string().trim().max(10).optional().default(''),
  storageLocation: z.string().trim().max(10).optional().default(''),
  accountAssignmentCategory: z.enum(['COST_CENTER']).optional(),
  costCenter: z.string().trim().max(10).optional().default(''),
  glAccount: z.string().trim().max(10).optional().default(''),
  requisitionNumber: z.string().trim().max(10).optional().default(''),
  requisitionItem: z.number().int().positive().nullish(),
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
  paymentTermsCode: z.string().trim().max(12).optional().default(''),
  incotermsCode: z.string().trim().max(3).optional().default(''),
  incotermsLocation: z.string().trim().max(160).optional().default(''),
  yourReference: z.string().trim().max(12).optional().default(''),
  ourReference: z.string().trim().max(12).optional().default(''),
  requestKey: z.string().trim().max(64).optional(),
  items: z.array(itemInput).min(1),
}).strict();

export type CreateSchedulingAgreementInput = z.input<typeof documentInput>;

export interface SchedulingAgreementScheduleLineRow {
  itemNumber: number;
  lineNumber: number;
  deliveryDate: string;
  quantity: string;
  unit: string | null;
  markedForDeletion: boolean;
}

export interface SchedulingAgreementItemRow {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  targetQuantity: string;
  unit: string;
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
  infoRecordNumber: string | null;
  markedForDeletion: boolean;
  scheduledQuantity: string;
  remainingQuantity: string;
}

export interface SchedulingAgreementDocument {
  agreementNumber: string;
  documentType: string;
  supplierNumber: string;
  purchasingOrg: string;
  purchasingGroup: string;
  companyCode: string;
  currency: string;
  agreementDate: string;
  validityStart: string;
  validityEnd: string;
  paymentTermsCode: string | null;
  incotermsCode: string | null;
  incotermsLocation: string | null;
  yourReference: string | null;
  ourReference: string | null;
  releaseStatus: 'NOT_REQUIRED' | 'PENDING' | 'RELEASED';
  items: SchedulingAgreementItemRow[];
  scheduleLines: SchedulingAgreementScheduleLineRow[];
}

export interface SchedulingAgreementListRow {
  agreementNumber: string;
  documentType: string;
  supplierNumber: string;
  validityStart: string;
  validityEnd: string;
  targetQuantity: string;
  scheduledQuantity: string;
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

function qty(value: string | number): string {
  return fromScaled(toScaled(value, 3), 3);
}

function money(quantity: string, price: string, priceUnit: string): string {
  const unit = toScaled(priceUnit, 0);
  if (unit <= 0n) throw new SchedulingAgreementError('The price unit must be greater than zero.');
  return fromScaled((toScaled(quantity, 3) * toScaled(price, 2)) / (unit * 1000n), 2);
}

function lessThan(left: string, right: string, scale: number): boolean {
  return toScaled(left, scale) < toScaled(right, scale);
}

async function businessDate(tx: Tx, client: string): Promise<string> {
  const [row] = await tx.execute(sql`select current_date::text as today`) as unknown as Array<{ today: string }>;
  return row?.today ?? new Date().toISOString().slice(0, 10);
}

async function loadType(tx: Tx, client: string, code: string) {
  const [row] = await tx.select().from(schedulingAgreementType).where(and(
    eq(schedulingAgreementType.client, client),
    eq(schedulingAgreementType.documentType, code.trim().toUpperCase()),
    eq(schedulingAgreementType.isActive, true),
  ));
  if (!row || row.category !== 'SCHEDULING') {
    throw new SchedulingAgreementError(
      `Document type ${code} is not an active scheduling-agreement type.`,
      'Maintain the scheduling-agreement type. LP is not assumed when it is not configured.',
    );
  }
  return row;
}

async function releaseStatus(tx: Tx, client: string, agreementNumber: string) {
  const [row] = await tx.select({ status: documentRelease.status }).from(documentRelease).where(and(
    eq(documentRelease.client, client),
    eq(documentRelease.documentCategory, SCHEDULING_AGREEMENT_CATEGORY),
    eq(documentRelease.documentNumber, agreementNumber),
  ));
  if (row?.status === 'PENDING' || row?.status === 'RELEASED') return row.status;
  return 'NOT_REQUIRED' as const;
}

async function lockAgreement(tx: Tx, client: string, agreementNumber: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/scheduling_agreement/${agreementNumber}`}, 0))`);
}

async function scheduleUsage(tx: Tx, client: string, agreementNumber: string) {
  const lines = await tx.select().from(schedulingAgreementScheduleLine).where(and(
    eq(schedulingAgreementScheduleLine.client, client),
    eq(schedulingAgreementScheduleLine.agreementNumber, agreementNumber),
  ));
  const quantity = new Map<number, string>();
  for (const line of lines) {
    if (line.markedForDeletion) continue;
    const current = quantity.get(line.itemNumber) ?? '0.000';
    quantity.set(line.itemNumber, fromScaled(toScaled(current, 3) + toScaled(line.quantity, 3), 3));
  }
  return { lines, quantity };
}

function headerSnapshot(row: {
  purchasingGroup: string;
  agreementDate: string;
  validityStart: string;
  validityEnd: string;
  paymentTermsCode: string | null;
  incotermsCode: string | null;
  incotermsLocation: string | null;
  yourReference: string | null;
  ourReference: string | null;
}): Record<string, unknown> {
  return {
    purchasingGroup: row.purchasingGroup,
    agreementDate: row.agreementDate,
    validityStart: row.validityStart,
    validityEnd: row.validityEnd,
    paymentTermsCode: shown(row.paymentTermsCode),
    incotermsCode: shown(row.incotermsCode),
    incotermsLocation: shown(row.incotermsLocation),
    yourReference: shown(row.yourReference),
    ourReference: shown(row.ourReference),
  };
}

function itemSnapshot(rows: Array<{
  itemNumber: number;
  shortText: string;
  materialNumber: string | null;
  plant: string | null;
  unit: string;
  targetQuantity: string;
  netPrice: string;
  markedForDeletion: boolean;
}>): Record<string, unknown> {
  const snapshot: Record<string, unknown> = {};
  for (const row of rows) {
    const key = `item${row.itemNumber}`;
    snapshot[`${key}Text`] = row.shortText;
    snapshot[`${key}Material`] = shown(row.materialNumber);
    snapshot[`${key}Plant`] = shown(row.plant);
    snapshot[`${key}Unit`] = row.unit;
    snapshot[`${key}Quantity`] = shown(row.targetQuantity);
    snapshot[`${key}Price`] = shown(row.netPrice);
    snapshot[`${key}Deleted`] = row.markedForDeletion ? 'true' : 'false';
  }
  return snapshot;
}

async function judgeHeader(
  tx: Tx,
  client: string,
  input: z.infer<typeof documentInput>,
  agreementDate: string,
) {
  if (input.validityEnd < input.validityStart) {
    throw new SchedulingAgreementError('The validity end is before the validity start.');
  }
  const [partner] = await tx.select().from(businessPartner).where(and(
    eq(businessPartner.client, client), eq(businessPartner.partnerNumber, input.supplierNumber),
  ));
  if (!partner) throw new SchedulingAgreementError(`Supplier ${input.supplierNumber} does not exist.`);
  if (partner.isBlocked) throw new SchedulingAgreementError(`Supplier ${input.supplierNumber} is blocked.`);
  const [role] = await tx.select().from(bpRole).where(and(
    eq(bpRole.client, client),
    eq(bpRole.partnerNumber, input.supplierNumber),
    eq(bpRole.roleCode, 'SUPPLIER'),
    eq(bpRole.isActive, true),
  ));
  if (!role) throw new SchedulingAgreementError(`Partner ${input.supplierNumber} is not an active supplier.`);
  const [org] = await tx.select().from(purchasingOrg).where(and(
    eq(purchasingOrg.client, client), eq(purchasingOrg.purchasingOrg, input.purchasingOrg),
  ));
  if (!org?.isActive) throw new SchedulingAgreementError(`Purchasing organization ${input.purchasingOrg} does not exist or is inactive.`);
  const [supplierOrg] = await tx.select().from(supplierPurchasing).where(and(
    eq(supplierPurchasing.client, client),
    eq(supplierPurchasing.partnerNumber, input.supplierNumber),
    eq(supplierPurchasing.purchasingOrg, input.purchasingOrg),
  ));
  if (!supplierOrg) {
    throw new SchedulingAgreementError(`Supplier ${input.supplierNumber} holds no purchasing data for organization ${input.purchasingOrg}.`);
  }
  if (supplierOrg.isBlocked) {
    throw new SchedulingAgreementError(`Supplier ${input.supplierNumber} is blocked for purchasing organization ${input.purchasingOrg}.`);
  }
  const [group] = await tx.select().from(purchasingGroup).where(and(
    eq(purchasingGroup.client, client), eq(purchasingGroup.purchasingGroup, input.purchasingGroup),
  ));
  if (!group?.isActive) throw new SchedulingAgreementError(`Purchasing group ${input.purchasingGroup} does not exist or is inactive.`);
  const [company] = await tx.select().from(companyCode).where(and(
    eq(companyCode.client, client), eq(companyCode.companyCode, input.companyCode),
  ));
  if (!company) throw new SchedulingAgreementError(`Company code ${input.companyCode} does not exist.`);
  const currency = (input.currency || supplierOrg.orderCurrency || company.currency || '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new SchedulingAgreementError('A currency is required.');
  const [known] = await tx.select().from(currencyTable).where(eq(currencyTable.code, currency));
  if (!known) throw new SchedulingAgreementError(`Currency ${currency} is not defined.`);
  const paymentTermsCode = blank(input.paymentTermsCode) ?? supplierOrg.paymentTermsCode;
  if (paymentTermsCode) {
    const [terms] = await tx.select().from(paymentTerms).where(and(
      eq(paymentTerms.client, client), eq(paymentTerms.termsCode, paymentTermsCode),
    ));
    if (!terms) throw new SchedulingAgreementError(`Payment terms ${paymentTermsCode} do not exist.`);
  }
  const incotermsCode = (blank(input.incotermsCode) ?? supplierOrg.incotermsCode)?.toUpperCase() ?? null;
  if (incotermsCode && !INCOTERMS.includes(incotermsCode as typeof INCOTERMS[number])) {
    throw new SchedulingAgreementError(`Incoterm ${incotermsCode} is not a maintained delivery term.`);
  }
  if (agreementDate < input.validityStart || agreementDate > input.validityEnd) {
    throw new SchedulingAgreementError('The agreement date is outside the validity period.');
  }
  return {
    currency,
    paymentTermsCode,
    incotermsCode,
    incotermsLocation: blank(input.incotermsLocation) ?? supplierOrg.incotermsLocation,
  };
}

async function judgeItem(
  tx: Tx,
  client: string,
  header: { companyCode: string; currency: string; supplierNumber: string; purchasingOrg: string },
  item: z.infer<typeof itemInput>,
  agreementDate: string,
  warnings: string[],
) {
  let materialNumber = blank(item.materialNumber);
  let shortText = blank(item.shortText);
  let unit = blank(item.unit);
  const plantCode = blank(item.plant);
  const storage = blank(item.storageLocation);
  let netPrice = item.netPrice ?? undefined;
  let priceUnit = item.priceUnit;
  let infoRecordNumber: string | null = null;
  let priceSequence: number | null = null;
  const requisitionNumber = blank(item.requisitionNumber);
  const requisitionItem = item.requisitionItem ?? null;
  if ((requisitionNumber == null) !== (requisitionItem == null)) {
    throw new SchedulingAgreementError('A requisition reference needs both the number and the item.');
  }
  if (requisitionNumber && requisitionItem) {
    const [source] = await tx.select().from(purchaseRequisitionItem).where(and(
      eq(purchaseRequisitionItem.client, client),
      eq(purchaseRequisitionItem.requisitionNumber, requisitionNumber),
      eq(purchaseRequisitionItem.itemNumber, requisitionItem),
    ));
    if (!source) throw new SchedulingAgreementError(`Requisition ${requisitionNumber} item ${requisitionItem} does not exist.`);
    materialNumber = materialNumber ?? source.materialNumber;
    shortText = shortText ?? source.shortText;
    unit = unit ?? source.unit;
  }
  if (materialNumber) {
    const [row] = await tx.select().from(material).where(and(
      eq(material.client, client), eq(material.materialNumber, materialNumber),
    ));
    if (!row) throw new SchedulingAgreementError(`Material ${materialNumber} does not exist.`);
    if (row.isBlocked) throw new SchedulingAgreementError(`Material ${materialNumber} is blocked.`);
    shortText = shortText ?? row.description;
  }
  if (!shortText) throw new SchedulingAgreementError('An item needs a short text or a material.');
  if (!unit) throw new SchedulingAgreementError('A target quantity needs a unit.');
  const [knownUnit] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, unit));
  if (!knownUnit) throw new SchedulingAgreementError(`Unit ${unit} is not defined.`);
  if (plantCode) {
    const [site] = await tx.select().from(plant).where(and(eq(plant.client, client), eq(plant.plant, plantCode)));
    if (!site) throw new SchedulingAgreementError(`Plant ${plantCode} does not exist.`);
    if (site.companyCode !== header.companyCode) {
      throw new SchedulingAgreementError(`Plant ${plantCode} does not belong to company code ${header.companyCode}.`);
    }
    try {
      await assertPurchasingOrgForPlant(tx, {
        client, purchasingOrg: header.purchasingOrg, plant: plantCode, documentType: 'SCHEDULING_AGREEMENT',
      });
    } catch (error) {
      if (error instanceof PurchasingOrgPlantAuthorizationError) {
        throw new SchedulingAgreementError(error.message, error.remedy);
      }
      throw error;
    }
    if (materialNumber) {
      const [extended] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, plantCode),
      ));
      if (!extended) throw new SchedulingAgreementError(`Material ${materialNumber} is not extended to plant ${plantCode}.`);
    }
  }
  if (storage) {
    if (!plantCode) throw new SchedulingAgreementError('A storage location needs a plant. The plant itself is not required.');
    const [location] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client),
      eq(storageLocation.plant, plantCode),
      eq(storageLocation.storageLocation, storage),
    ));
    if (!location?.isActive) throw new SchedulingAgreementError(`Storage location ${storage} does not stand at plant ${plantCode}.`);
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
      netPrice = Number(record.amount);
      priceUnit = record.priceUnit ?? priceUnit;
      infoRecordNumber = record.infoRecordNumber ?? null;
      priceSequence = record.priceSequence ?? null;
      warnings.push(`Info record ${record.infoRecordNumber} supplied the omitted price. The info record was not changed.`);
    } else if (record.warning) warnings.push(record.warning);
  }
  if (netPrice === undefined) {
    throw new SchedulingAgreementError(
      'A net price is required.',
      'Enter a price, or name a plant so an info record can supply one. Condition-based pricing is not this document.',
    );
  }
  let accountAssignmentCategory = item.accountAssignmentCategory ?? null;
  let assignedCostCenter = blank(item.costCenter);
  let assignedAccount = blank(item.glAccount);
  if (accountAssignmentCategory === 'COST_CENTER') {
    if (!assignedCostCenter || !assignedAccount) {
      throw new SchedulingAgreementError('A cost-centre assignment needs both the cost centre and the G/L account.');
    }
    const [company] = await tx.select().from(companyCode).where(and(
      eq(companyCode.client, client), eq(companyCode.companyCode, header.companyCode),
    ));
    const [area] = await tx.select().from(controllingAreaCompany).where(and(
      eq(controllingAreaCompany.client, client), eq(controllingAreaCompany.companyCode, header.companyCode),
    ));
    if (!area) throw new SchedulingAgreementError(`Company code ${header.companyCode} belongs to no controlling area.`);
    const centres = await tx.select().from(costCenter).where(and(
      eq(costCenter.client, client),
      eq(costCenter.controllingArea, area.controllingArea),
      eq(costCenter.costCenter, assignedCostCenter),
    ));
    const standing = centres.find((row) => row.validFrom <= agreementDate && row.validTo >= agreementDate);
    if (!standing) throw new SchedulingAgreementError(`Cost centre ${assignedCostCenter} is not valid on ${agreementDate}.`);
    if (!company?.chartOfAccounts) throw new SchedulingAgreementError(`Company code ${header.companyCode} has no chart of accounts.`);
    const [account] = await tx.select().from(glAccount).where(and(
      eq(glAccount.client, client),
      eq(glAccount.chartOfAccounts, company.chartOfAccounts),
      eq(glAccount.accountNumber, assignedAccount),
    ));
    if (!account) throw new SchedulingAgreementError(`G/L account ${assignedAccount} does not exist.`);
  } else if (assignedCostCenter || assignedAccount) {
    throw new SchedulingAgreementError('A cost centre or G/L account needs the cost-centre assignment category.');
  } else {
    accountAssignmentCategory = null;
    assignedCostCenter = null;
    assignedAccount = null;
  }
  const targetQuantity = qty(item.targetQuantity);
  const price = fromScaled(toScaled(netPrice, 2), 2);
  return {
    materialNumber,
    shortText: shortText.slice(0, 40),
    targetQuantity,
    unit,
    netPrice: price,
    priceUnit: String(priceUnit),
    netValue: money(targetQuantity, price, String(priceUnit)),
    plant: plantCode,
    storageLocation: storage,
    accountAssignmentCategory,
    costCenter: assignedCostCenter,
    glAccount: assignedAccount,
    requisitionNumber,
    requisitionItem,
    infoRecordNumber,
    priceSequence,
    markedForDeletion: item.markedForDeletion,
  };
}

function releaseAttributes(
  header: { purchasingGroup: string; companyCode: string; supplierNumber: string; purchasingOrg: string },
  items: Array<{ plant: string | null; netValue: string; markedForDeletion: boolean }>,
) {
  const standing = items.filter((item) => !item.markedForDeletion);
  const total = standing.reduce((sum, item) => sum + toScaled(item.netValue, 2), 0n);
  const attributes: Record<string, string | number> = {
    TOTAL_VALUE: Number(fromScaled(total, 2)),
    PURCHASING_GROUP: header.purchasingGroup,
    COMPANY_CODE: header.companyCode,
    SUPPLIER: header.supplierNumber,
    PURCHASING_ORG: header.purchasingOrg,
  };
  const plants = [...new Set(standing.map((item) => item.plant).filter((value): value is string => Boolean(value)))];
  if (plants.length === 1) attributes.PLANT = plants[0];
  return attributes;
}

export async function createSchedulingAgreement(
  raw: CreateSchedulingAgreementInput,
): Promise<{ agreementNumber: string; warnings: string[] }> {
  const parsed = documentInput.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SchedulingAgreementError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const warnings: string[] = [];
  const agreementNumber = await withTenant(input.client, async (tx) => {
    if (input.requestKey) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/scheduling_agreement/request/${input.requestKey}`}, 0))`);
      const [existing] = await tx.select().from(schedulingAgreement).where(and(
        eq(schedulingAgreement.client, input.client), eq(schedulingAgreement.requestKey, input.requestKey),
      ));
      if (existing) return existing.agreementNumber;
    }
    const type = await loadType(tx, input.client, input.documentType);
    const agreementDate = input.agreementDate ?? await businessDate(tx, input.client);
    const header = await judgeHeader(tx, input.client, input, agreementDate);
    const judged = [];
    for (const item of input.items) {
      judged.push(await judgeItem(tx, input.client, {
        companyCode: input.companyCode,
        currency: header.currency,
        supplierNumber: input.supplierNumber,
        purchasingOrg: input.purchasingOrg,
      }, item, agreementDate, warnings));
    }
    let drawn: Awaited<ReturnType<typeof allocateNumber>>;
    try {
      drawn = await allocateNumber(tx, {
        client: input.client,
        objectCode: 'SCHEDAGREE',
        companyCode: '*',
        subObject: type.numberRangeSubObject || '*',
        fiscalYear: 0,
        allocatedBy: input.changedBy,
      });
    } catch {
      throw new SchedulingAgreementError(
        'No active internal SCHEDAGREE number range stands, so no agreement number can be drawn.',
        'Define the scheduling-agreement interval, then save again.',
      );
    }
    const number = drawn.display;
    await lockAgreement(tx, input.client, number);
    await tx.insert(schedulingAgreement).values({
      client: input.client,
      agreementNumber: number,
      documentType: type.documentType,
      supplierNumber: input.supplierNumber,
      purchasingOrg: input.purchasingOrg,
      purchasingGroup: input.purchasingGroup,
      companyCode: input.companyCode,
      currency: header.currency,
      agreementDate,
      validityStart: input.validityStart,
      validityEnd: input.validityEnd,
      paymentTermsCode: header.paymentTermsCode,
      incotermsCode: header.incotermsCode,
      incotermsLocation: header.incotermsLocation,
      yourReference: blank(input.yourReference),
      ourReference: blank(input.ourReference),
      requestKey: input.requestKey ?? null,
      createdBy: input.changedBy,
    });
    let itemNumber = 0;
    const saved = [];
    for (const item of judged) {
      itemNumber += type.itemInterval;
      saved.push({ itemNumber, ...item });
      await tx.insert(schedulingAgreementItem).values({
        client: input.client,
        agreementNumber: number,
        itemNumber,
        itemCategory: 'STANDARD',
        ...item,
        createdBy: input.changedBy,
      });
    }
    await syncDocumentRelease(
      tx, input.client, SCHEDULING_AGREEMENT_CATEGORY, number,
      releaseAttributes({
        purchasingGroup: input.purchasingGroup,
        companyCode: input.companyCode,
        supplierNumber: input.supplierNumber,
        purchasingOrg: input.purchasingOrg,
      }, saved),
      input.changedBy,
    );
    await recordChange(tx, {
      client: input.client,
      objectClass: SCHEDULING_AGREEMENT_OBJECT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: 'ME31L',
      after: { documentType: type.documentType, supplier: input.supplierNumber, items: saved.length },
    });
    return number;
  });
  return { agreementNumber, warnings };
}

export async function changeSchedulingAgreement(
  raw: CreateSchedulingAgreementInput & { agreementNumber: string },
): Promise<{ agreementNumber: string; warnings: string[] }> {
  const { agreementNumber: suppliedNumber, ...document } = raw;
  const parsed = documentInput.safeParse(document);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new SchedulingAgreementError(`${issue.path.join('.')}: ${issue.message}`);
  }
  const input = parsed.data;
  const number = suppliedNumber.trim();
  if (!number) throw new SchedulingAgreementError('An agreement number is required.');
  const warnings: string[] = [];
  await withTenant(input.client, async (tx) => {
    await lockAgreement(tx, input.client, number);
    try {
      await assertDocumentNotReleased(tx, input.client, SCHEDULING_AGREEMENT_CATEGORY, number, 'Scheduling agreement');
    } catch (error) {
      if (error instanceof ReleaseError) throw new SchedulingAgreementError(error.message, error.remedy);
      throw error;
    }
    const [before] = await tx.select().from(schedulingAgreement).where(and(
      eq(schedulingAgreement.client, input.client), eq(schedulingAgreement.agreementNumber, number),
    ));
    if (!before) throw new SchedulingAgreementError(`Scheduling agreement ${number} does not exist.`);
    if (input.documentType.trim().toUpperCase() !== before.documentType) {
      throw new SchedulingAgreementError('The document type cannot be changed after the agreement is saved.');
    }
    if (input.supplierNumber !== before.supplierNumber || input.purchasingOrg !== before.purchasingOrg || input.companyCode !== before.companyCode) {
      throw new SchedulingAgreementError('Supplier, purchasing organization, and company code stay as saved.');
    }
    const type = await loadType(tx, input.client, before.documentType);
    const agreementDate = input.agreementDate ?? before.agreementDate;
    const header = await judgeHeader(tx, input.client, input, agreementDate);
    if (header.currency !== before.currency) {
      throw new SchedulingAgreementError('The agreement currency cannot be changed after it is saved.');
    }
    const usage = await scheduleUsage(tx, input.client, number);
    if (usage.lines.some((line) => line.deliveryDate < input.validityStart || line.deliveryDate > input.validityEnd)) {
      throw new SchedulingAgreementError('The new validity period excludes a delivery schedule line that already stands.');
    }
    await tx.update(schedulingAgreement).set({
      purchasingGroup: input.purchasingGroup,
      agreementDate,
      validityStart: input.validityStart,
      validityEnd: input.validityEnd,
      paymentTermsCode: header.paymentTermsCode,
      incotermsCode: header.incotermsCode,
      incotermsLocation: header.incotermsLocation,
      yourReference: blank(input.yourReference),
      ourReference: blank(input.ourReference),
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(eq(schedulingAgreement.client, input.client), eq(schedulingAgreement.agreementNumber, number)));
    const standing = await tx.select().from(schedulingAgreementItem).where(and(
      eq(schedulingAgreementItem.client, input.client), eq(schedulingAgreementItem.agreementNumber, number),
    ));
    const standingNumbers = new Set(standing.map((item) => item.itemNumber));
    let maxItem = Math.max(0, ...standingNumbers);
    for (const item of input.items) {
      const isNew = item.itemNumber === undefined || !standingNumbers.has(item.itemNumber);
      const itemNumber = isNew ? (maxItem += type.itemInterval) : item.itemNumber as number;
      const previous = standing.find((row) => row.itemNumber === itemNumber);
      const scheduled = usage.quantity.get(itemNumber) ?? '0.000';
      if (!isNew && toScaled(scheduled, 3) > 0n && previous && (blank(item.plant) ?? null) !== (previous.plant ?? null)) {
        throw new SchedulingAgreementError(
          `Item ${itemNumber} plant cannot change after a delivery schedule line.`,
          'The delivery schedule keeps its plant. ME32L does not rewrite it.',
        );
      }
      const judged = await judgeItem(tx, input.client, {
        companyCode: before.companyCode,
        currency: before.currency,
        supplierNumber: before.supplierNumber,
        purchasingOrg: before.purchasingOrg,
      }, item, agreementDate, warnings);
      if (toScaled(scheduled, 3) > 0n && previous) {
        if ((judged.materialNumber ?? null) !== (previous.materialNumber ?? null)) {
          throw new SchedulingAgreementError(`Item ${itemNumber} material cannot change after a delivery schedule line.`);
        }
        if (judged.unit !== previous.unit) {
          throw new SchedulingAgreementError(`Item ${itemNumber} unit cannot change after a delivery schedule line.`);
        }
        if ((judged.plant ?? null) !== (previous.plant ?? null)) {
          throw new SchedulingAgreementError(`Item ${itemNumber} plant cannot change after a delivery schedule line.`);
        }
        if (judged.markedForDeletion) {
          throw new SchedulingAgreementError(`Item ${itemNumber} has a delivery schedule line and cannot be marked for deletion.`);
        }
      }
      if (lessThan(judged.targetQuantity, scheduled, 3)) {
        throw new SchedulingAgreementError(
          `Item ${itemNumber} target quantity is below the scheduled quantity ${scheduled}.`,
          'ME32L does not rewrite the delivery schedule. Raise the target, or maintain the schedule in ME38.',
        );
      }
      if (isNew) {
        await tx.insert(schedulingAgreementItem).values({
          client: input.client, agreementNumber: number, itemNumber, itemCategory: 'STANDARD', ...judged, createdBy: input.changedBy,
        });
      } else {
        await tx.update(schedulingAgreementItem).set({
          ...judged, changedBy: input.changedBy, changedAt: new Date(),
        }).where(and(
          eq(schedulingAgreementItem.client, input.client),
          eq(schedulingAgreementItem.agreementNumber, number),
          eq(schedulingAgreementItem.itemNumber, itemNumber),
        ));
      }
    }
    const afterItems = await tx.select().from(schedulingAgreementItem).where(and(
      eq(schedulingAgreementItem.client, input.client), eq(schedulingAgreementItem.agreementNumber, number),
    ));
    const [savedHeader] = await tx.select().from(schedulingAgreement).where(and(
      eq(schedulingAgreement.client, input.client), eq(schedulingAgreement.agreementNumber, number),
    ));
    await syncDocumentRelease(
      tx, input.client, SCHEDULING_AGREEMENT_CATEGORY, number,
      releaseAttributes({
        purchasingGroup: input.purchasingGroup,
        companyCode: before.companyCode,
        supplierNumber: before.supplierNumber,
        purchasingOrg: before.purchasingOrg,
      }, afterItems),
      input.changedBy,
    );
    await recordChange(tx, {
      client: input.client,
      objectClass: SCHEDULING_AGREEMENT_OBJECT_CLASS,
      objectKey: number,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'ME32L',
      before: { ...headerSnapshot(before), ...itemSnapshot(standing) },
      after: { ...headerSnapshot(savedHeader ?? before), ...itemSnapshot(afterItems) },
    });
  });
  return { agreementNumber: number, warnings };
}

export async function getSchedulingAgreement(
  client: string,
  agreementNumber: string,
): Promise<SchedulingAgreementDocument | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(schedulingAgreement).where(and(
      eq(schedulingAgreement.client, client), eq(schedulingAgreement.agreementNumber, agreementNumber.trim()),
    ));
    if (!header) return null;
    const items = await tx.select().from(schedulingAgreementItem).where(and(
      eq(schedulingAgreementItem.client, client), eq(schedulingAgreementItem.agreementNumber, header.agreementNumber),
    )).orderBy(asc(schedulingAgreementItem.itemNumber));
    const usage = await scheduleUsage(tx, client, header.agreementNumber);
    const release = await releaseStatus(tx, client, header.agreementNumber);
    return {
      agreementNumber: header.agreementNumber,
      documentType: header.documentType,
      supplierNumber: header.supplierNumber,
      purchasingOrg: header.purchasingOrg,
      purchasingGroup: header.purchasingGroup,
      companyCode: header.companyCode,
      currency: header.currency,
      agreementDate: header.agreementDate,
      validityStart: header.validityStart,
      validityEnd: header.validityEnd,
      paymentTermsCode: header.paymentTermsCode,
      incotermsCode: header.incotermsCode,
      incotermsLocation: header.incotermsLocation,
      yourReference: header.yourReference,
      ourReference: header.ourReference,
      releaseStatus: release,
      items: items.map((item) => {
        const scheduled = usage.quantity.get(item.itemNumber) ?? '0.000';
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
          infoRecordNumber: item.infoRecordNumber,
          markedForDeletion: item.markedForDeletion,
          scheduledQuantity: scheduled,
          remainingQuantity: fromScaled(toScaled(item.targetQuantity, 3) - toScaled(scheduled, 3), 3),
        };
      }),
      scheduleLines: usage.lines.map((line) => ({
        itemNumber: line.itemNumber,
        lineNumber: line.lineNumber,
        deliveryDate: line.deliveryDate,
        quantity: line.quantity,
        unit: line.unit,
        markedForDeletion: line.markedForDeletion,
      })),
    };
  });
}

export async function listSchedulingAgreements(client: string): Promise<SchedulingAgreementListRow[]> {
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(schedulingAgreement).where(eq(schedulingAgreement.client, client))
      .orderBy(asc(schedulingAgreement.agreementNumber));
    const rows: SchedulingAgreementListRow[] = [];
    for (const header of headers) {
      const items = await tx.select().from(schedulingAgreementItem).where(and(
        eq(schedulingAgreementItem.client, client), eq(schedulingAgreementItem.agreementNumber, header.agreementNumber),
      ));
      const usage = await scheduleUsage(tx, client, header.agreementNumber);
      const target = items.filter((item) => !item.markedForDeletion)
        .reduce((sum, item) => sum + toScaled(item.targetQuantity, 3), 0n);
      const scheduled = [...usage.quantity.values()].reduce((sum, value) => sum + toScaled(value, 3), 0n);
      rows.push({
        agreementNumber: header.agreementNumber,
        documentType: header.documentType,
        supplierNumber: header.supplierNumber,
        validityStart: header.validityStart,
        validityEnd: header.validityEnd,
        targetQuantity: fromScaled(target, 3),
        scheduledQuantity: fromScaled(scheduled, 3),
        releaseStatus: await releaseStatus(tx, client, header.agreementNumber),
      });
    }
    return rows;
  });
}

export async function schedulingAgreementChoices(client: string) {
  return withTenant(client, async (tx) => {
    const [types, suppliers, organizations, groups, companies, plants] = await Promise.all([
      tx.select().from(schedulingAgreementType).where(and(
        eq(schedulingAgreementType.client, client), eq(schedulingAgreementType.isActive, true),
      )).orderBy(asc(schedulingAgreementType.documentType)),
      tx.select().from(businessPartner).where(eq(businessPartner.client, client)).orderBy(asc(businessPartner.partnerNumber)),
      tx.select().from(purchasingOrg).where(eq(purchasingOrg.client, client)).orderBy(asc(purchasingOrg.purchasingOrg)),
      tx.select().from(purchasingGroup).where(eq(purchasingGroup.client, client)).orderBy(asc(purchasingGroup.purchasingGroup)),
      tx.select().from(companyCode).where(eq(companyCode.client, client)).orderBy(asc(companyCode.companyCode)),
      tx.select().from(plant).where(eq(plant.client, client)).orderBy(asc(plant.plant)),
    ]);
    return {
      types: types.map((row) => ({ documentType: row.documentType, description: row.description })),
      suppliers: suppliers.map((row) => ({ partnerNumber: row.partnerNumber, name: row.name })),
      organizations: organizations.map((row) => ({ purchasingOrg: row.purchasingOrg, name: row.name })),
      groups: groups.map((row) => ({ purchasingGroup: row.purchasingGroup, name: row.name })),
      companies: companies.map((row) => ({ companyCode: row.companyCode, name: row.name })),
      plants: plants.map((row) => ({ plant: row.plant, name: row.name })),
    };
  });
}
