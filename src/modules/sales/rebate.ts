/**
 * Rebates — money given back.
 *
 * Everything else in Sales takes the money: a price on an order, an invoice for what went out, an
 * advance before the goods were built, a credit where the complaint was good. A rebate is the promise
 * that some of it comes back, and a promise is three acts with time between them.
 *
 * **The agreement** says who the promise was made to, over what period and priced by what rate. It is
 * maintained open and **released**, because a provision nobody authorised is worse than no provision.
 *
 * **The accrual** happens when the invoice is posted. The sale earned part of the promise, and the
 * books hear about it then, not later when the money is handed over. It is computed on the line's net
 * value — SAP's rebate basis — and posted as a provision: the sales deduction is debited, the accrual
 * is credited. The customer still pays the whole invoice; the rebate is a promise recorded beside it,
 * which is exactly what a statistical condition is for.
 *
 * **The settlement** pays it out, later: a credit memo that reverses the provision and credits the
 * customer. Settling less than stands leaves the agreement accruing; settling what stands closes it.
 *
 * Two things follow. A cancelled billing document takes its accrual with it, because a provision built
 * on a sale that was undone is an overstatement that never corrects itself — and what has already been
 * paid out is left alone, because the credit memo is a document of its own and undoing it is a separate
 * act. And nothing here stores a running total: what accrued, what was reversed and what was settled
 * are read from the accrual rows, as a receivable is read from its open items.
 */
import { z } from 'zod';
import { and, asc, eq, gte, inArray, lte } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { CustomerCreditMemoError, postCustomerCreditMemo } from '../finance/customer-credit-memo';
import { bpRole, businessPartner } from '../foundation/business-partner-schema';
import { customerSalesArea } from '../foundation/customer-sales-area-schema';
import { companyCode as companyCodeTable } from '../foundation/schema';
import { materialSales } from '../inventory/schema';
import { ACCOUNT_DETERMINATION_ROUTE, determineLineAccounts } from './account-determination';
import { DOCUMENT_TYPE_REMEDY as DOCUMENT_TYPE_REMEDY_SCREEN, salesDocumentTypeFor, STANDARD_REBATE_SETTLEMENT_TYPE } from './document-type';
import { type DocumentPartners, resolvePartners, writeDocumentPartners } from './partners';
import { type PricedCondition, roundAmount, writeDocumentConditions } from './pricing-procedure';
import {
  billingDocument, billingDocumentLine, salesConditionRecord, salesConditionType, salesOrder,
  salesRebateAccrual, salesRebateAgreement,
} from './schema';

export const REBATE_ROUTE = '/sales/rebate-agreements';
/** Maintaining an agreement posts nothing, which is why it is guarded in its own right. */
export const REBATE_CAPABILITY = 'SALES.REBATE.MAINTAIN';
/** Settling one gives the company's money away. */
export const REBATE_SETTLEMENT_CAPABILITY = 'SALES.CREDIT.MEMO.POST';
export const REBATE_TRANSACTION = 'SALES.REBATE.MAINTAIN';
export const REBATE_AGREEMENT_OBJECT_CLASS = 'sales_rebate_agreement';
export const REBATE_ACCRUAL_OBJECT_CLASS = 'sales_rebate_accrual';

/** The number range object an agreement draws its number from, delivered with the package. */
const AGREEMENT_NUMBER_OBJECT = 'REBATE_AGR';
/**
 * The account key the *deduction* side of an accrual is posted to, in SAP's terms ERS: the rebate is a
 * reduction of what the sale earned, and the ledger hears about it on the day the sale is billed.
 */
const DEDUCTION_ACCOUNT_KEY = 'ERS';
/** An accrual is a general ledger act: it names no customer open item and no payment. */
const ACCRUAL_JOURNAL_DOCUMENT_TYPE = 'SA';
/** The document a settlement is paid on: SAP's B1, and not a credit memo, which credits an invoice. */
const SETTLEMENT_DOCUMENT_TYPE = STANDARD_REBATE_SETTLEMENT_TYPE;
/**
 * The step a rebate condition is written at on the billing document. It stands clear of the procedure's
 * own steps because it was never part of the procedure: a rebate is earned over a period and not priced
 * by a document, so it is called up here rather than by the pricing engine.
 */
const REBATE_CONDITION_STEP = 900;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLIENT_KEY = /^[A-Za-z0-9]{2,4}$/;

export class RebateError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'RebateError';
    this.remedy = remedy;
  }
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function money(value: number): string {
  return round2(value).toFixed(2);
}

/* ─── Inputs ─────────────────────────────────────────────────────────────────────────────────── */

const agreementInput = z.object({
  client: z.string().regex(CLIENT_KEY, 'The client key is two to four characters.'),
  /** Named on a change; drawn from the number range on a new agreement. */
  agreementNumber: z.string().trim().min(1).max(20).optional(),
  customerNumber: z.string().trim().min(1).max(40),
  salesOrg: z.string().trim().min(1).max(4),
  distributionChannel: z.string().trim().max(2).default(''),
  division: z.string().trim().max(2).default(''),
  currency: z.string().trim().length(3).toUpperCase(),
  validFrom: z.string().regex(ISO_DATE, 'Use a date, as YYYY-MM-DD.'),
  validTo: z.string().regex(ISO_DATE, 'Use a date, as YYYY-MM-DD.'),
  conditionType: z.string().trim().min(1).max(4).toUpperCase().default('BO01'),
  changedBy: z.string().trim().min(1).max(60),
  requestKey: z.string().trim().max(64).optional(),
});
export type SaveRebateAgreementInput = z.input<typeof agreementInput>;

const settlementInput = z.object({
  client: z.string().regex(CLIENT_KEY),
  agreementNumber: z.string().trim().min(1).max(20),
  /** The day the credit memo bears and posts on. */
  settlementDate: z.string().regex(ISO_DATE, 'Use a date, as YYYY-MM-DD.'),
  /**
   * What to pay out. Left out means the whole of what stands, which settles the agreement for good.
   * Naming less pays that much out and leaves the agreement accruing.
   */
  amount: z.number().positive().optional(),
  changedBy: z.string().trim().min(1).max(60),
  requestKey: z.string().trim().max(64).optional(),
});
export type SettleRebateAgreementInput = z.input<typeof settlementInput>;

/* ─── Views ──────────────────────────────────────────────────────────────────────────────────── */

/** One accrual, as a reader of the agreement's register sees it. */
export interface RebateAccrualView {
  agreementNumber: string;
  billingNumber: string;
  lineNumber: number;
  orderNumber: string;
  orderLineNumber: number;
  materialNumber: string;
  currency: string;
  /** What the rebate was calculated on: the net value of the billing line. */
  basisAmount: string;
  /** What was provided for. */
  rebateAmount: string;
  /** What has been paid out of it. */
  settledAmount: string;
  /** What the customer is still owed out of this line. */
  outstanding: string;
  conditionNumber: string;
  journalDocumentNumber: string | null;
  reversalJournalDocumentNumber: string | null;
  settlementNumber: string | null;
  status: string;
}

export interface RebateAgreementView {
  agreementNumber: string;
  customerNumber: string;
  salesOrg: string;
  distributionChannel: string;
  division: string;
  currency: string;
  validFrom: string;
  validTo: string;
  conditionType: string;
  status: string;
  /** What the sales inside this agreement have provided for, and what is left of it. */
  accrued: string;
  reversed: string;
  settled: string;
  outstanding: string;
}

export interface RebateRegister {
  agreement: RebateAgreementView;
  accruals: RebateAccrualView[];
}

/* ─── Reading ────────────────────────────────────────────────────────────────────────────────── */

function view(row: typeof salesRebateAccrual.$inferSelect): RebateAccrualView {
  const outstanding = round2(Number(row.rebateAmount) - Number(row.settledAmount));
  return {
    agreementNumber: row.agreementNumber,
    billingNumber: row.billingNumber,
    lineNumber: row.lineNumber,
    orderNumber: row.orderNumber,
    orderLineNumber: row.orderLineNumber,
    materialNumber: row.materialNumber,
    currency: row.currency,
    basisAmount: money(Number(row.basisAmount)),
    rebateAmount: money(Number(row.rebateAmount)),
    settledAmount: money(Number(row.settledAmount)),
    outstanding: row.status === 'REVERSED' ? '0.00' : outstanding.toFixed(2),
    conditionNumber: row.conditionNumber,
    journalDocumentNumber: row.journalDocumentNumber,
    reversalJournalDocumentNumber: row.reversalJournalDocumentNumber,
    settlementNumber: row.settlementNumber,
    status: row.status,
  };
}

/**
 * The four totals a reader of an agreement asks for, read off the accrual rows rather than kept beside
 * them. A stored total is a second copy of a number that only ever has to be right once.
 */
function totalsOf(rows: RebateAccrualView[]) {
  const live = rows.filter((row) => row.status !== 'REVERSED');
  const accrued = live.reduce((sum, row) => sum + Number(row.rebateAmount), 0);
  const settled = rows.reduce((sum, row) => sum + Number(row.settledAmount), 0);
  const outstanding = live.reduce((sum, row) => sum + Number(row.outstanding), 0);
  const reversed = rows
    .filter((row) => row.status === 'REVERSED')
    .reduce((sum, row) => sum + Number(row.rebateAmount), 0);
  return {
    accrued: money(accrued),
    reversed: money(reversed),
    settled: money(settled),
    outstanding: money(outstanding),
  };
}

function agreementView(
  row: typeof salesRebateAgreement.$inferSelect,
  totals: ReturnType<typeof totalsOf>,
): RebateAgreementView {
  return {
    agreementNumber: row.agreementNumber,
    customerNumber: row.customerNumber,
    salesOrg: row.salesOrg,
    distributionChannel: row.distributionChannel,
    division: row.division,
    currency: row.currency,
    validFrom: row.validFrom,
    validTo: row.validTo,
    conditionType: row.conditionType,
    status: row.status,
    ...totals,
  };
}

async function readAgreement(tx: Tx, client: string, agreementNumber: string) {
  const [row] = await tx.select().from(salesRebateAgreement).where(and(
    eq(salesRebateAgreement.client, client),
    eq(salesRebateAgreement.agreementNumber, agreementNumber),
  )).limit(1);
  if (!row) {
    throw new RebateError(
      `Rebate agreement ${agreementNumber} does not stand for this tenant.`,
      'Read the agreements that stand, then name one of them.',
    );
  }
  return row;
}

async function accrualsOf(tx: Tx, client: string, agreementNumber: string) {
  const rows = await tx.select().from(salesRebateAccrual).where(and(
    eq(salesRebateAccrual.client, client),
    eq(salesRebateAccrual.agreementNumber, agreementNumber),
  )).orderBy(asc(salesRebateAccrual.billingNumber), asc(salesRebateAccrual.lineNumber));
  return rows.map(view);
}

/* ─── Maintenance ────────────────────────────────────────────────────────────────────────────── */

/**
 * Maintain a rebate agreement.
 *
 * A new one stands OPEN and accrues nothing until `releaseRebateAgreement` is called, which is the act
 * that says somebody with authority over the company's money agreed to it. Once sales have accrued
 * against one, the promise itself is history: the payer, the sales area and the rate cannot be
 * rewritten underneath money that has already been provided for. The period it runs to can.
 */
export async function saveRebateAgreement(
  input: SaveRebateAgreementInput,
): Promise<RebateAgreementView> {
  const parsed = agreementInput.parse(input);
  return withTenant(parsed.client, async (tx) => {
    if (parsed.validTo < parsed.validFrom) {
      throw new RebateError(
        `An agreement that ends on ${parsed.validTo} before it begins on ${parsed.validFrom} covers no days at all.`,
        'Enter the day the agreement runs to on or after the day it runs from.',
      );
    }
    const [type] = await tx.select().from(salesConditionType).where(and(
      eq(salesConditionType.client, parsed.client),
      eq(salesConditionType.conditionType, parsed.conditionType),
    )).limit(1);
    if (!type) {
      throw new RebateError(
        `Condition type ${parsed.conditionType} does not stand for this tenant, so no rebate rate can be found for this agreement.`,
        'Name a rebate condition type that stands — BO01 is delivered with the package.',
      );
    }
    if (type.conditionClass !== 'REBATE') {
      throw new RebateError(
        `Condition type ${parsed.conditionType} is a ${type.conditionClass.toLowerCase()} and not a rebate, and a rebate agreement is priced by a rebate.`,
        'Name a condition type of the rebate class.',
      );
    }
    const [partner] = await tx.select().from(businessPartner).where(and(
      eq(businessPartner.client, parsed.client),
      eq(businessPartner.partnerNumber, parsed.customerNumber),
    )).limit(1);
    if (!partner) {
      throw new RebateError(
        `Business partner ${parsed.customerNumber} does not stand for this tenant, so no rebate can be promised to them.`,
        'Name a partner who stands.',
      );
    }
    const [role] = await tx.select({ partnerNumber: bpRole.partnerNumber }).from(bpRole).where(and(
      eq(bpRole.client, parsed.client),
      eq(bpRole.partnerNumber, parsed.customerNumber),
      eq(bpRole.roleCode, 'CUSTOMER'),
    )).limit(1);
    if (!role) {
      throw new RebateError(
        `Partner ${parsed.customerNumber} does not carry the customer role, and a rebate is promised to a customer.`,
        'Extend the partner to the customer role, or name another partner.',
      );
    }

    const existing = parsed.agreementNumber
      ? await readAgreement(tx, parsed.client, parsed.agreementNumber)
      : null;

    if (existing) {
      if (existing.status === 'SETTLED' || existing.status === 'CLOSED') {
        throw new RebateError(
          `Rebate agreement ${existing.agreementNumber} stands ${existing.status.toLowerCase()} and is history: what it promised has been paid out or abandoned.`,
          'Raise a new agreement for a new period.',
        );
      }
      const accruals = await accrualsOf(tx, parsed.client, existing.agreementNumber);
      if (accruals.length > 0) {
        // What has accrued was priced by the payer, the sales area and the rate the agreement named
        // when it accrued. Rewriting them now would leave the ledger holding a provision priced by
        // terms that no longer exist anywhere.
        const fixed = [
          existing.customerNumber !== parsed.customerNumber ? 'the customer' : '',
          existing.salesOrg !== parsed.salesOrg
            || existing.distributionChannel !== parsed.distributionChannel
            || existing.division !== parsed.division ? 'the sales area' : '',
          existing.currency !== parsed.currency ? 'the currency' : '',
          existing.conditionType !== parsed.conditionType ? 'the rebate condition type' : '',
          existing.validFrom !== parsed.validFrom ? 'the day it runs from' : '',
        ].filter(Boolean);
        if (fixed.length > 0) {
          throw new RebateError(
            `Rebate agreement ${existing.agreementNumber} has already accrued ${totalsOf(accruals).accrued} against sales, so ${fixed.join(', ')} cannot be changed underneath it.`,
            'Only the day it runs to can be changed once sales have accrued; raise a new agreement for new terms.',
          );
        }
      }
      const before = {
        customerNumber: existing.customerNumber,
        validTo: existing.validTo,
        status: existing.status,
      };
      await tx.update(salesRebateAgreement).set({
        validTo: parsed.validTo,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(salesRebateAgreement.client, parsed.client),
        eq(salesRebateAgreement.agreementNumber, existing.agreementNumber),
      ));
      await recordChange(tx, {
        client: parsed.client, objectClass: REBATE_AGREEMENT_OBJECT_CLASS,
        objectKey: existing.agreementNumber, changeType: 'CHANGE',
        changedBy: parsed.changedBy, transactionCode: REBATE_TRANSACTION,
        before, after: { validTo: parsed.validTo },
        fieldLabels: { validTo: 'Runs to' },
      });
      const [updated] = await tx.select().from(salesRebateAgreement).where(and(
        eq(salesRebateAgreement.client, parsed.client),
        eq(salesRebateAgreement.agreementNumber, existing.agreementNumber),
      )).limit(1);
      return agreementView(updated, totalsOf(accruals));
    }

    let number: string;
    try {
      const drawn = await allocateNumber(tx, {
        client: parsed.client, objectCode: AGREEMENT_NUMBER_OBJECT, companyCode: '*',
        subObject: '*', fiscalYear: 0, allocatedBy: parsed.changedBy,
      });
      number = drawn.display;
    } catch {
      throw new RebateError(
        `No active internal ${AGREEMENT_NUMBER_OBJECT} number range stands, so no agreement number can be drawn.`,
        'Define or unblock the interval on the number ranges screen, then try again.',
      );
    }

    await tx.insert(salesRebateAgreement).values({
      client: parsed.client,
      agreementNumber: number,
      customerNumber: parsed.customerNumber,
      salesOrg: parsed.salesOrg,
      distributionChannel: parsed.distributionChannel,
      division: parsed.division,
      currency: parsed.currency,
      validFrom: parsed.validFrom,
      validTo: parsed.validTo,
      conditionType: parsed.conditionType,
      status: 'OPEN',
      createdBy: parsed.changedBy,
    });
    await recordChange(tx, {
      client: parsed.client, objectClass: REBATE_AGREEMENT_OBJECT_CLASS, objectKey: number,
      changeType: 'CREATE', changedBy: parsed.changedBy, transactionCode: REBATE_TRANSACTION,
      after: {
        customerNumber: parsed.customerNumber,
        salesOrg: parsed.salesOrg,
        validFrom: parsed.validFrom,
        validTo: parsed.validTo,
        conditionType: parsed.conditionType,
        currency: parsed.currency,
      },
      fieldLabels: {
        customerNumber: 'Customer', salesOrg: 'Sales organisation', validFrom: 'Runs from',
        validTo: 'Runs to', conditionType: 'Rebate condition type', currency: 'Currency',
      },
    });
    return agreementView(await readAgreement(tx, parsed.client, number), {
      accrued: '0.00', reversed: '0.00', settled: '0.00', outstanding: '0.00',
    });
  });
}

/**
 * Release an agreement: the act that lets it accrue.
 *
 * An agreement that accrues before somebody agreed to it is a provision nobody authorised, so the
 * release is recorded as its own decision rather than a flag beside the rest of the maintenance.
 */
export async function releaseRebateAgreement(input: {
  client: string;
  agreementNumber: string;
  changedBy: string;
}): Promise<RebateAgreementView> {
  return withTenant(input.client, async (tx) => {
    const agreement = await readAgreement(tx, input.client, input.agreementNumber);
    if (agreement.status === 'SETTLED' || agreement.status === 'CLOSED') {
      throw new RebateError(
        `Rebate agreement ${agreement.agreementNumber} stands ${agreement.status.toLowerCase()}, and what is paid out or abandoned is not released again.`,
        'Raise a new agreement for a new period.',
      );
    }
    if (agreement.status !== 'RELEASED') {
      await tx.update(salesRebateAgreement).set({
        status: 'RELEASED', changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(salesRebateAgreement.client, input.client),
        eq(salesRebateAgreement.agreementNumber, agreement.agreementNumber),
      ));
      await recordChange(tx, {
        client: input.client, objectClass: REBATE_AGREEMENT_OBJECT_CLASS,
        objectKey: agreement.agreementNumber, changeType: 'CHANGE',
        changedBy: input.changedBy, transactionCode: REBATE_TRANSACTION,
        before: { status: agreement.status }, after: { status: 'RELEASED' },
        fieldLabels: { status: 'Status' },
      });
    }
    const [updated] = await tx.select().from(salesRebateAgreement).where(and(
      eq(salesRebateAgreement.client, input.client),
      eq(salesRebateAgreement.agreementNumber, agreement.agreementNumber),
    )).limit(1);
    return agreementView(updated, totalsOf(await accrualsOf(tx, input.client, agreement.agreementNumber)));
  });
}

/** The agreements that stand, with what each has cost so far. */
export async function listRebateAgreements(
  client: string,
  filter?: { customerNumber?: string; status?: string },
): Promise<RebateAgreementView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesRebateAgreement).where(and(
      eq(salesRebateAgreement.client, client),
      filter?.customerNumber ? eq(salesRebateAgreement.customerNumber, filter.customerNumber) : undefined,
      filter?.status ? eq(salesRebateAgreement.status, filter.status) : undefined,
    )).orderBy(asc(salesRebateAgreement.customerNumber), asc(salesRebateAgreement.agreementNumber));
    const out: RebateAgreementView[] = [];
    for (const row of rows) {
      out.push(agreementView(row, totalsOf(await accrualsOf(tx, client, row.agreementNumber))));
    }
    return out;
  });
}

/**
 * What one billing document accrued. Read for the document itself, so a reader of an invoice can see
 * the provision it earned without going looking for the agreement behind it.
 */
export async function rebateAccrualsForBilling(
  client: string,
  billingNumber: string,
): Promise<RebateAccrualView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(salesRebateAccrual).where(and(
      eq(salesRebateAccrual.client, client),
      eq(salesRebateAccrual.billingNumber, billingNumber),
    )).orderBy(asc(salesRebateAccrual.agreementNumber), asc(salesRebateAccrual.lineNumber));
    return rows.map(view);
  });
}

/** One agreement and the register of everything that has accrued against it. */
export async function rebateRegister(
  client: string,
  agreementNumber: string,
): Promise<RebateRegister> {
  return withTenant(client, async (tx) => {
    const agreement = await readAgreement(tx, client, agreementNumber);
    const accruals = await accrualsOf(tx, client, agreementNumber);
    return { agreement: agreementView(agreement, totalsOf(accruals)), accruals };
  });
}

/**
 * The two accounts an accrual is posted through, for each material the sale was made of: the sales
 * deduction it is charged to and the provision it builds.
 *
 * Read from the determination rather than assumed, and read per material, because the material's
 * account assignment group is one of the two things the account is determined by — a provision for a
 * rebate on trading goods does not necessarily belong in the same account as one on services. Where no
 * account stands for either key, the accrual is refused by name: a rebate posted to an account nobody
 * chose is how a provision becomes a surprise.
 */
async function accountsForMaterials(tx: Tx, input: {
  client: string;
  chartOfAccounts: string;
  salesOrg: string;
  distributionChannel: string;
  customerAccountAssignmentGroup: string | null;
  conditionType: string;
  conditionClass: string;
  provisionKey: string;
  materialNumbers: string[];
}): Promise<Map<string, { deduction: string; provision: string }>> {
  const groups = new Map<string, string | null>();
  for (const materialNumber of input.materialNumbers) {
    if (groups.has(materialNumber)) continue;
    const [view] = await tx.select({ group: materialSales.materialAccountAssignmentGroup })
      .from(materialSales).where(and(
        eq(materialSales.client, input.client),
        eq(materialSales.materialNumber, materialNumber),
        eq(materialSales.salesOrg, input.salesOrg),
        eq(materialSales.distributionChannel, input.distributionChannel),
      )).limit(1);
    groups.set(materialNumber, view?.group ?? null);
  }

  const out = new Map<string, { deduction: string; provision: string }>();
  for (const [materialNumber, group] of groups) {
    const accounts = await determineLineAccounts(tx, input.client, {
      chartOfAccounts: input.chartOfAccounts,
      salesOrg: input.salesOrg,
      customerAccountAssignmentGroup: input.customerAccountAssignmentGroup,
      materialAccountAssignmentGroup: group,
      conditions: [
        {
          accountKey: DEDUCTION_ACCOUNT_KEY, amount: '1', isStatistical: false,
          conditionClass: input.conditionClass, conditionType: input.conditionType,
        },
        {
          accountKey: input.provisionKey, amount: '1', isStatistical: false,
          conditionClass: input.conditionClass, conditionType: input.conditionType,
        },
      ],
    });
    const deduction = accounts?.components
      .find((component) => component.accountKey === DEDUCTION_ACCOUNT_KEY)?.glAccount;
    const provision = accounts?.components
      .find((component) => component.accountKey === input.provisionKey)?.glAccount;
    const missing = !deduction ? DEDUCTION_ACCOUNT_KEY : !provision ? input.provisionKey : null;
    if (missing || !deduction || !provision) {
      throw new RebateError(
        `No account stands for ${missing} in chart ${input.chartOfAccounts} for material ${materialNumber}, so the rebate earned on it has nowhere to be provided for.`,
        `Maintain the account determination for the key at ${ACCOUNT_DETERMINATION_ROUTE}.`,
      );
    }
    out.set(materialNumber, { deduction, provision });
  }
  return out;
}

/**
 * The condition types an agreement may be priced by: the rebate class, and active. Which one an
 * agreement uses is what lets a tenant keep a volume rebate and a listing fee apart, priced by
 * different records and determined to different accounts.
 */
export async function rebateConditionTypes(client: string): Promise<Array<{
  conditionType: string;
  name: string;
  calculationType: string;
  accountKey: string | null;
}>> {
  return withTenant(client, (tx) => tx.select({
    conditionType: salesConditionType.conditionType,
    name: salesConditionType.name,
    calculationType: salesConditionType.calculationType,
    accountKey: salesConditionType.accountKey,
  }).from(salesConditionType).where(and(
    eq(salesConditionType.client, client),
    eq(salesConditionType.conditionClass, 'REBATE'),
    eq(salesConditionType.isActive, true),
  )).orderBy(asc(salesConditionType.conditionType)));
}

/* ─── The accrual ────────────────────────────────────────────────────────────────────────────── */

export interface RebateAccrualPosted {
  agreementNumber: string;
  /** What was provided for on this document, in its currency. */
  amount: string;
  journalDocumentNumber: string;
}

export interface AccrueRebatesInput {
  client: string;
  changedBy: string;
  billingNumber: string;
  /** The day the document bears: the agreement and its rate are read on this day, not today. */
  billingDate: string;
  postingDate: string;
  /** The payer of the document — the partner a promise can be made with. */
  customerNumber: string;
  companyCode: string;
  currency: string;
}

interface SalesArea {
  salesOrg: string;
  distributionChannel: string;
  division: string;
}

/**
 * The rate that answers for a line: the most specific record that stands on the day, the customer and
 * the material named before the general ones. Blank means "any" and is a value that is matched, never
 * an absence — the same reading every condition record is found by.
 */
async function rebateRecordFor(tx: Tx, input: {
  client: string;
  conditionType: string;
  salesArea: SalesArea;
  customerNumber: string;
  materialNumber: string;
  on: string;
}) {
  const areas = [input.salesArea, { salesOrg: '', distributionChannel: '', division: '' }];
  const keys = [
    { customerNumber: input.customerNumber, materialNumber: input.materialNumber },
    { customerNumber: input.customerNumber, materialNumber: '' },
    { customerNumber: '', materialNumber: input.materialNumber },
    { customerNumber: '', materialNumber: '' },
  ];
  for (const area of areas) {
    for (const key of keys) {
      if (key.customerNumber === '' && key.materialNumber === '') continue;
      const [row] = await tx.select().from(salesConditionRecord).where(and(
        eq(salesConditionRecord.client, input.client),
        eq(salesConditionRecord.conditionType, input.conditionType),
        eq(salesConditionRecord.salesOrg, area.salesOrg),
        eq(salesConditionRecord.distributionChannel, area.distributionChannel),
        eq(salesConditionRecord.division, area.division),
        eq(salesConditionRecord.customerNumber, key.customerNumber),
        eq(salesConditionRecord.materialNumber, key.materialNumber),
        lte(salesConditionRecord.validityFrom, input.on),
        gte(salesConditionRecord.validityTo, input.on),
      )).limit(1);
      if (row) return row;
    }
  }
  return null;
}

/**
 * Accrue the rebates a posted billing document earned.
 *
 * Called by billing, in the same breath as the receivable, because that is when the promise was partly
 * earned. It changes nothing the customer pays: the rebate is written on the document as a statistical
 * condition — shown, never charged — and carried to the ledger as a provision.
 *
 * An agreement answers only while it stands released, only inside its dates, only for the payer and the
 * sales area it names, and only where a rate stands for the day. Where nothing answers, nothing accrues:
 * a sale inside no agreement is not a rebate of zero, it is a sale with no rebate.
 */
export async function accrueRebatesForBilling(
  tx: Tx,
  input: AccrueRebatesInput,
): Promise<RebateAccrualPosted[]> {
  const [header] = await tx.select().from(billingDocument).where(and(
    eq(billingDocument.client, input.client),
    eq(billingDocument.billingNumber, input.billingNumber),
  )).limit(1);
  if (!header) {
    throw new RebateError(
      `Billing document ${input.billingNumber} does not stand, so nothing can accrue against it.`,
      'Read the document that was posted.',
    );
  }
  const lines = await tx.select().from(billingDocumentLine).where(and(
    eq(billingDocumentLine.client, input.client),
    eq(billingDocumentLine.billingNumber, input.billingNumber),
  )).orderBy(asc(billingDocumentLine.lineNumber));
  if (lines.length === 0) return [];

  // The sales area the document was made in: the one it carries, and where a document raised before the
  // header carried one stands, the one the order behind its first line was made in.
  let salesArea: SalesArea = {
    salesOrg: header.salesOrg ?? '',
    distributionChannel: header.distributionChannel ?? '',
    division: header.division ?? '',
  };
  if (!salesArea.salesOrg) {
    const [order] = await tx.select({
      salesOrg: salesOrder.salesOrg,
      distributionChannel: salesOrder.distributionChannel,
      division: salesOrder.division,
    }).from(salesOrder).where(and(
      eq(salesOrder.client, input.client), eq(salesOrder.orderNumber, lines[0].orderNumber),
    )).limit(1);
    salesArea = {
      salesOrg: order?.salesOrg ?? '',
      distributionChannel: order?.distributionChannel ?? '',
      division: order?.division ?? '',
    };
  }

  const agreements = await tx.select().from(salesRebateAgreement).where(and(
    eq(salesRebateAgreement.client, input.client),
    eq(salesRebateAgreement.customerNumber, input.customerNumber),
    eq(salesRebateAgreement.status, 'RELEASED'),
    lte(salesRebateAgreement.validFrom, input.billingDate),
    gte(salesRebateAgreement.validTo, input.billingDate),
    inArray(salesRebateAgreement.salesOrg, [salesArea.salesOrg, '']),
    inArray(salesRebateAgreement.distributionChannel, [salesArea.distributionChannel, '']),
    inArray(salesRebateAgreement.division, [salesArea.division, '']),
  )).orderBy(asc(salesRebateAgreement.agreementNumber));
  if (agreements.length === 0) return [];

  const posted: RebateAccrualPosted[] = [];
  for (const agreement of agreements) {
    // Already accrued: a retry after a crash reads what stands instead of providing twice.
    const standing = await tx.select().from(salesRebateAccrual).where(and(
      eq(salesRebateAccrual.client, input.client),
      eq(salesRebateAccrual.agreementNumber, agreement.agreementNumber),
      eq(salesRebateAccrual.billingNumber, input.billingNumber),
    ));
    if (standing.length > 0) {
      posted.push({
        agreementNumber: agreement.agreementNumber,
        amount: money(standing.reduce((sum, row) => sum + Number(row.rebateAmount), 0)),
        journalDocumentNumber: standing[0].journalDocumentNumber ?? '',
      });
      continue;
    }

    const [type] = await tx.select().from(salesConditionType).where(and(
      eq(salesConditionType.client, input.client),
      eq(salesConditionType.conditionType, agreement.conditionType),
    )).limit(1);
    if (!type) continue;
    // The provision lands on the account the condition type's own key determines — ERU for the delivered
    // rebate type — and the charge goes to the sales deduction. Neither is assumed: both are read.
    const provisionKey = type.accountKey;
    if (!provisionKey) {
      throw new RebateError(
        `Rebate condition type ${type.conditionType} carries no account key, so the accrual it produces has nowhere to land.`,
        `Name the account key the provision is determined by at ${ACCOUNT_DETERMINATION_ROUTE}.`,
      );
    }

    const rows: Array<{
      line: typeof billingDocumentLine.$inferSelect;
      conditionNumber: string;
      basis: number;
      amount: number;
      rate: string;
    }> = [];
    for (const line of lines) {
      const record = await rebateRecordFor(tx, {
        client: input.client,
        conditionType: type.conditionType,
        salesArea,
        customerNumber: agreement.customerNumber,
        materialNumber: line.materialNumber,
        on: input.billingDate,
      });
      if (!record) continue;
      // The rebate basis is the net value of the line, because that is what the customer's promise was
      // a share of and the only figure the provision can be measured against.
      const basis = Number(line.netAmount);
      let amount: number;
      if (type.calculationType === 'PERCENTAGE') {
        amount = round2((basis * Number(record.amount)) / 100);
      } else if (type.calculationType === 'FIXED') {
        amount = round2(
          (Number(line.billingQuantity) * Number(record.amount)) / (record.priceUnit || 1),
        );
      } else {
        throw new RebateError(
          `Rebate condition type ${type.conditionType} is calculated from the valuation of the material, which is a cost and not a rebate.`,
          'Maintain the rebate as a percentage of the net value or a figure per unit.',
        );
      }
      if (amount <= 0) continue;
      rows.push({
        line, conditionNumber: record.conditionNumber, basis, amount,
        rate: record.amount,
      });
    }
    if (rows.length === 0) continue;

    const total = round2(rows.reduce((sum, row) => sum + row.amount, 0));
    if (total <= 0) continue;

    const [companyRow] = await tx.select({
      chartOfAccounts: companyCodeTable.chartOfAccounts,
      currency: companyCodeTable.currency,
      fiscalYearVariant: companyCodeTable.fiscalYearVariant,
    }).from(companyCodeTable).where(and(
      eq(companyCodeTable.client, input.client),
      eq(companyCodeTable.companyCode, input.companyCode),
    )).limit(1);
    if (!companyRow?.chartOfAccounts) {
      throw new RebateError(
        `Company code ${input.companyCode} carries no chart of accounts, so the accrual has no account to land on.`,
        'Complete the company code before billing.',
      );
    }
    if (!companyRow.fiscalYearVariant) {
      throw new RebateError(
        `Company code ${input.companyCode} carries no fiscal year variant, so the accrual has no period to be posted in.`,
        'Complete the company code before billing.',
      );
    }
    const [customerArea] = await tx.select({ group: customerSalesArea.accountAssignmentGroup })
      .from(customerSalesArea).where(and(
        eq(customerSalesArea.client, input.client),
        eq(customerSalesArea.partnerNumber, agreement.customerNumber),
        eq(customerSalesArea.salesOrg, salesArea.salesOrg),
        eq(customerSalesArea.distributionChannel, salesArea.distributionChannel),
        eq(customerSalesArea.division, salesArea.division),
      )).limit(1);

    const byMaterial = await accountsForMaterials(tx, {
      client: input.client,
      chartOfAccounts: companyRow.chartOfAccounts,
      salesOrg: salesArea.salesOrg,
      distributionChannel: salesArea.distributionChannel,
      customerAccountAssignmentGroup: customerArea?.group ?? null,
      conditionType: type.conditionType,
      conditionClass: type.conditionClass,
      provisionKey,
      materialNumbers: rows.map((row) => row.line.materialNumber),
    });

    // The provision, and the deduction it is charged to: one side of the ledger per material's own
    // determination, summed by account, which is what a journal is.
    const debits = new Map<string, number>();
    const credits = new Map<string, number>();
    for (const row of rows) {
      const accounts = byMaterial.get(row.line.materialNumber);
      if (!accounts) continue;
      debits.set(accounts.deduction, round2((debits.get(accounts.deduction) ?? 0) + row.amount));
      credits.set(accounts.provision, round2((credits.get(accounts.provision) ?? 0) + row.amount));
    }

    const position = await derivePosition(tx, input.client, companyRow.fiscalYearVariant, input.postingDate);
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: ACCRUAL_JOURNAL_DOCUMENT_TYPE,
      documentDate: input.billingDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: input.currency,
      localCurrency: companyRow.currency,
      reference: input.billingNumber,
      headerText: `Rebate ${agreement.agreementNumber} on ${input.billingNumber}`.slice(0, 50),
      lines: [
        ...[...debits].map(([glAccount, amount]) => ({
          glAccount, debitCredit: 'S' as const, amount: amount.toFixed(2),
          businessPartner: agreement.customerNumber,
          lineText: `Rebate accrual ${agreement.agreementNumber}`,
        })),
        ...[...credits].map(([glAccount, amount]) => ({
          glAccount, debitCredit: 'H' as const, amount: amount.toFixed(2),
          businessPartner: agreement.customerNumber,
          lineText: `Rebate provision ${agreement.agreementNumber}`,
        })),
      ],
      origin: {
        documentClass: REBATE_ACCRUAL_OBJECT_CLASS,
        documentKey: `${agreement.agreementNumber}/${input.billingNumber}`,
      },
      postedBy: input.changedBy,
      transactionCode: REBATE_TRANSACTION,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new RebateError(error.message, error.remedy);
      throw error;
    });

    for (const row of rows) {
      await tx.insert(salesRebateAccrual).values({
        client: input.client,
        agreementNumber: agreement.agreementNumber,
        billingNumber: input.billingNumber,
        lineNumber: row.line.lineNumber,
        orderNumber: row.line.orderNumber,
        orderLineNumber: row.line.orderLineNumber,
        materialNumber: row.line.materialNumber,
        currency: input.currency,
        basisAmount: roundAmount(row.basis, 4),
        rebateAmount: row.amount.toFixed(2),
        conditionNumber: row.conditionNumber,
        journalDocumentNumber: journal.documentNumber,
        status: 'ACCRUED',
        createdBy: input.changedBy,
      });
    }

    // What the document earned, written on the document: a rebate the customer can see before they are
    // paid it, standing beside the price and never inside it.
    const items = rows.map((row) => ({
      lineNumber: row.line.lineNumber,
      conditions: [{
        lineNumber: row.line.lineNumber,
        stepNumber: REBATE_CONDITION_STEP,
        conditionType: type.conditionType,
        conditionClass: type.conditionClass,
        origin: 'ITEM' as const,
        baseValue: roundAmount(row.basis, 4),
        rate: row.rate,
        amount: row.amount.toFixed(2),
        priceUnit: 1,
        conditionNumber: row.conditionNumber,
        accountKey: provisionKey,
        isStatistical: true,
        access: null,
      } satisfies PricedCondition],
    }));
    await writeDocumentConditions(tx, {
      client: input.client, documentCategory: 'BILLING', documentNumber: input.billingNumber,
      currency: input.currency, items, changedBy: input.changedBy,
    });

    await recordChange(tx, {
      client: input.client, objectClass: REBATE_ACCRUAL_OBJECT_CLASS,
      objectKey: `${agreement.agreementNumber}/${input.billingNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: REBATE_TRANSACTION,
      after: {
        agreement: agreement.agreementNumber,
        billing: input.billingNumber,
        amount: total.toFixed(2),
        journal: journal.documentNumber,
      },
      fieldLabels: {
        agreement: 'Agreement', billing: 'Billing document', amount: 'Provided for',
        journal: 'Journal',
      },
    });

    posted.push({
      agreementNumber: agreement.agreementNumber,
      amount: total.toFixed(2),
      journalDocumentNumber: journal.documentNumber,
    });
  }
  return posted;
}

/* ─── The reversal ───────────────────────────────────────────────────────────────────────────── */

/**
 * Take back what a cancelled billing document accrued.
 *
 * A provision built on a sale that was undone is an overstatement that never corrects itself, so the
 * cancellation of the document mirrors the accrual. What has already been paid out is left where it is:
 * the credit memo that paid it is a document of its own, and undoing that is a separate act that
 * somebody has to take.
 */
export async function reverseRebateAccrualsForBilling(
  tx: Tx,
  input: { client: string; changedBy: string; billingNumber: string; postingDate: string },
): Promise<RebateAccrualPosted[]> {
  const rows = await tx.select().from(salesRebateAccrual).where(and(
    eq(salesRebateAccrual.client, input.client),
    eq(salesRebateAccrual.billingNumber, input.billingNumber),
  )).orderBy(asc(salesRebateAccrual.agreementNumber), asc(salesRebateAccrual.lineNumber));
  const live = rows.filter(
    (row) => row.status !== 'REVERSED'
      && round2(Number(row.rebateAmount) - Number(row.settledAmount)) > 0.005,
  );
  if (live.length === 0) return [];

  const byAgreement = new Map<string, typeof rows>();
  for (const row of live) {
    byAgreement.set(row.agreementNumber, [...(byAgreement.get(row.agreementNumber) ?? []), row]);
  }
  const reversed: RebateAccrualPosted[] = [];
  for (const [agreementNumber, group] of byAgreement) {
    const agreement = await readAgreement(tx, input.client, agreementNumber);
    const [type] = await tx.select().from(salesConditionType).where(and(
      eq(salesConditionType.client, input.client),
      eq(salesConditionType.conditionType, agreement.conditionType),
    )).limit(1);
    const provisionKey = type?.accountKey;
    if (!provisionKey) continue;

    const [billing] = await tx.select({
      companyCode: billingDocument.companyCode,
      currency: billingDocument.currency,
      billingDate: billingDocument.billingDate,
      salesOrg: billingDocument.salesOrg,
      distributionChannel: billingDocument.distributionChannel,
      division: billingDocument.division,
    }).from(billingDocument).where(and(
      eq(billingDocument.client, input.client),
      eq(billingDocument.billingNumber, input.billingNumber),
    )).limit(1);
    if (!billing) continue;

    const [companyRow] = await tx.select({
      chartOfAccounts: companyCodeTable.chartOfAccounts,
      currency: companyCodeTable.currency,
      fiscalYearVariant: companyCodeTable.fiscalYearVariant,
    }).from(companyCodeTable).where(and(
      eq(companyCodeTable.client, input.client),
      eq(companyCodeTable.companyCode, billing.companyCode),
    )).limit(1);
    if (!companyRow?.chartOfAccounts || !companyRow.fiscalYearVariant) continue;

    const [customerArea] = await tx.select({ group: customerSalesArea.accountAssignmentGroup })
      .from(customerSalesArea).where(and(
        eq(customerSalesArea.client, input.client),
        eq(customerSalesArea.partnerNumber, agreement.customerNumber),
        eq(customerSalesArea.salesOrg, billing.salesOrg ?? ''),
        eq(customerSalesArea.distributionChannel, billing.distributionChannel ?? ''),
        eq(customerSalesArea.division, billing.division ?? ''),
      )).limit(1);

    const byMaterial = await accountsForMaterials(tx, {
      client: input.client,
      chartOfAccounts: companyRow.chartOfAccounts,
      salesOrg: billing.salesOrg ?? '',
      distributionChannel: billing.distributionChannel ?? '',
      customerAccountAssignmentGroup: customerArea?.group ?? null,
      conditionType: type.conditionType,
      conditionClass: type.conditionClass,
      provisionKey,
      materialNumbers: group.map((row) => row.materialNumber),
    });

    // The mirror of the accrual: the provision is released and the deduction is given back, line for
    // line by the same determination that built it.
    const debits = new Map<string, number>();
    const credits = new Map<string, number>();
    for (const row of group) {
      const accounts = byMaterial.get(row.materialNumber);
      if (!accounts) continue;
      const outstanding = round2(Number(row.rebateAmount) - Number(row.settledAmount));
      if (outstanding <= 0.005) continue;
      debits.set(accounts.provision, round2((debits.get(accounts.provision) ?? 0) + outstanding));
      credits.set(accounts.deduction, round2((credits.get(accounts.deduction) ?? 0) + outstanding));
    }
    if (debits.size === 0) continue;
    // What is released is what the lines carry, which is the same figure by construction: the provision
    // that stood less anything already paid out of it.
    const released = round2([...debits.values()].reduce((sum, value) => sum + value, 0));
    const position = await derivePosition(tx, input.client, companyRow.fiscalYearVariant, input.postingDate);
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: billing.companyCode,
      documentType: ACCRUAL_JOURNAL_DOCUMENT_TYPE,
      documentDate: billing.billingDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: billing.currency,
      localCurrency: companyRow.currency,
      reference: input.billingNumber,
      headerText: `Rebate reversal ${input.billingNumber}`.slice(0, 50),
      lines: [
        ...[...debits].map(([glAccount, value]) => ({
          glAccount, debitCredit: 'S' as const, amount: value.toFixed(2),
          businessPartner: agreement.customerNumber,
          lineText: `Rebate provision released ${agreementNumber}`,
        })),
        ...[...credits].map(([glAccount, value]) => ({
          glAccount, debitCredit: 'H' as const, amount: value.toFixed(2),
          businessPartner: agreement.customerNumber,
          lineText: `Rebate deduction released ${agreementNumber}`,
        })),
      ],
      origin: {
        documentClass: REBATE_ACCRUAL_OBJECT_CLASS,
        documentKey: `${agreementNumber}/${input.billingNumber}/reversal`,
      },
      postedBy: input.changedBy,
      transactionCode: REBATE_TRANSACTION,
    });

    for (const row of group) {
      await tx.update(salesRebateAccrual).set({
        status: 'REVERSED',
        reversalJournalDocumentNumber: journal.documentNumber,
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(salesRebateAccrual.client, input.client),
        eq(salesRebateAccrual.agreementNumber, agreementNumber),
        eq(salesRebateAccrual.billingNumber, row.billingNumber),
        eq(salesRebateAccrual.lineNumber, row.lineNumber),
      ));
    }
    await recordChange(tx, {
      client: input.client, objectClass: REBATE_ACCRUAL_OBJECT_CLASS,
      objectKey: `${agreementNumber}/${input.billingNumber}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: REBATE_TRANSACTION,
      before: { status: 'ACCRUED' },
      after: { status: 'REVERSED', amount: released.toFixed(2), journal: journal.documentNumber },
      fieldLabels: { status: 'Status', amount: 'Released', journal: 'Journal' },
    });
    reversed.push({
      agreementNumber, amount: released.toFixed(2), journalDocumentNumber: journal.documentNumber,
    });
  }
  return reversed;
}

/* ─── The settlement ─────────────────────────────────────────────────────────────────────────── */

export interface RebateSettlementDocument {
  billingNumber: string;
  invoiceNumber: string;
  journalDocumentNumber: string;
  orderNumber: string;
  amount: string;
}

export interface RebateSettlement {
  agreementNumber: string;
  /** What was paid out, in the agreement's currency. */
  amount: string;
  /** FINAL where nothing is left standing, PARTIAL where the agreement goes on accruing. */
  settlementType: 'PARTIAL' | 'FINAL';
  documents: RebateSettlementDocument[];
}

/**
 * Settle a rebate agreement: the credit memo that gives the money back.
 *
 * One credit memo is raised per order whose sales earned the rebate, so that no document has to invent
 * an order it does not have. Each is posted against the provision the accrual built — the provision is
 * debited back out, and the customer's account is credited — and each accrual is stamped with what was
 * paid out of it, so a second settlement can read what is still owed rather than being told.
 *
 * Settling more than accrued is refused: a promise is not a blank cheque.
 */
export async function settleRebateAgreement(
  input: SettleRebateAgreementInput,
): Promise<RebateSettlement> {
  const parsed = settlementInput.parse(input);
  return withTenant(parsed.client, async (tx) => {
    const agreement = await readAgreement(tx, parsed.client, parsed.agreementNumber);
    if (agreement.status === 'CLOSED') {
      throw new RebateError(
        `Rebate agreement ${agreement.agreementNumber} stands closed, and an abandoned promise pays nothing out.`,
        'Raise a new agreement.',
      );
    }
    if (agreement.status === 'OPEN') {
      throw new RebateError(
        `Rebate agreement ${agreement.agreementNumber} has not been released, so nothing has accrued against it and nothing is owed.`,
        'Release the agreement first: a provision nobody authorised is worse than no provision.',
      );
    }
    const accruals = await accrualsOf(tx, parsed.client, agreement.agreementNumber);
    const open = accruals.filter((row) => row.status !== 'REVERSED' && Number(row.outstanding) > 0.005);
    const outstanding = round2(open.reduce((sum, row) => sum + Number(row.outstanding), 0));
    if (open.length === 0) {
      throw new RebateError(
        agreement.status === 'SETTLED'
          ? `Rebate agreement ${agreement.agreementNumber} is already settled: everything that accrued against it has been paid out.`
          : `Nothing has accrued against rebate agreement ${agreement.agreementNumber} that has not already been paid out, so there is nothing to settle.`,
        'Settle an agreement whose sales have earned something.',
      );
    }
    const wanted = parsed.amount === undefined ? outstanding : round2(parsed.amount);
    if (wanted > outstanding + 0.005) {
      throw new RebateError(
        `Rebate agreement ${agreement.agreementNumber} has ${outstanding.toFixed(2)} ${agreement.currency} standing, and ${wanted.toFixed(2)} was asked for.`,
        `Settle ${outstanding.toFixed(2)} or less. A promise is not a blank cheque.`,
      );
    }

    // What each order is paid, in the order the sales were made: the oldest accrual is paid first, and
    // the last one is paid in part where that is all the settlement asked for.
    let remaining = wanted;
    const allocation = new Map<string, number>();
    for (const row of open) {
      if (remaining <= 0.005) break;
      const take = Math.min(round2(Number(row.outstanding)), remaining);
      if (take <= 0.005) continue;
      allocation.set(`${row.billingNumber}|${row.lineNumber}`, round2(take));
      remaining = round2(remaining - take);
    }
    const settled = round2(wanted - remaining);
    if (settled <= 0) return {
      agreementNumber: agreement.agreementNumber,
      amount: '0.00',
      settlementType: 'PARTIAL' as const,
      documents: [],
    };

    // The company code the credit memo is raised in: the one the sales were made in. A settlement that
    // spanned two company codes would be one document crediting a customer in a company it was never
    // sold to, so it is refused rather than split in silence.
    const billingNumbers = [...new Set(open.map((row) => row.billingNumber))];
    const billings = await tx.select({
      billingNumber: billingDocument.billingNumber,
      companyCode: billingDocument.companyCode,
      orderNumber: billingDocument.orderNumber,
    }).from(billingDocument).where(and(
      eq(billingDocument.client, parsed.client),
      inArray(billingDocument.billingNumber, billingNumbers),
    ));
    const companyCodes = [...new Set(billings.map((row) => row.companyCode))];
    if (companyCodes.length !== 1) {
      throw new RebateError(
        `The accruals of agreement ${agreement.agreementNumber} were earned in ${companyCodes.join(' and ')}, and one credit memo is raised in one company code.`,
        'Settle the agreement one company code at a time.',
      );
    }
    const companyCode = companyCodes[0];

    const [type] = await tx.select().from(salesConditionType).where(and(
      eq(salesConditionType.client, parsed.client),
      eq(salesConditionType.conditionType, agreement.conditionType),
    )).limit(1);
    const provisionKey = type?.accountKey;
    if (!provisionKey) {
      throw new RebateError(
        `Rebate condition type ${agreement.conditionType} carries no account key, so the provision it built cannot be released.`,
        `Name the account key the provision is determined by at ${ACCOUNT_DETERMINATION_ROUTE}.`,
      );
    }
    const [companyRow] = await tx.select({
      chartOfAccounts: companyCodeTable.chartOfAccounts,
    }).from(companyCodeTable).where(and(
      eq(companyCodeTable.client, parsed.client),
      eq(companyCodeTable.companyCode, companyCode),
    )).limit(1);
    if (!companyRow?.chartOfAccounts) {
      throw new RebateError(
        `Company code ${companyCode} carries no chart of accounts, so the provision cannot be released.`,
        'Complete the company code.',
      );
    }
    const [customerArea] = await tx.select({ group: customerSalesArea.accountAssignmentGroup })
      .from(customerSalesArea).where(and(
        eq(customerSalesArea.client, parsed.client),
        eq(customerSalesArea.partnerNumber, agreement.customerNumber),
        eq(customerSalesArea.salesOrg, agreement.salesOrg),
        eq(customerSalesArea.distributionChannel, agreement.distributionChannel),
        eq(customerSalesArea.division, agreement.division),
      )).limit(1);
    const byMaterial = await accountsForMaterials(tx, {
      client: parsed.client,
      chartOfAccounts: companyRow.chartOfAccounts,
      salesOrg: agreement.salesOrg,
      distributionChannel: agreement.distributionChannel,
      customerAccountAssignmentGroup: customerArea?.group ?? null,
      conditionType: agreement.conditionType,
      conditionClass: type?.conditionClass ?? 'REBATE',
      provisionKey,
      materialNumbers: [...new Set(open.map((row) => row.materialNumber))],
    });

    // The settlement is paid on a document of its own (SAP's B1) and not on a credit memo: a credit
    // memo names the invoice it gives back, and a settlement was not earned by an invoice — the invoices
    // stand in full, and what is being paid out is the promise beside them.
    const memoType = await salesDocumentTypeFor(tx, parsed.client, SETTLEMENT_DOCUMENT_TYPE);
    if (!memoType) {
      throw new RebateError(
        `Billing document type ${SETTLEMENT_DOCUMENT_TYPE} does not stand for this tenant, so no rebate settlement can be raised.`,
        `Maintain the settlement document type at ${DOCUMENT_TYPE_REMEDY_SCREEN}, then settle again.`,
      );
    }

    // One credit memo per order: a document names the sale whose rebate it pays, and a settlement that
    // spans several orders raises several documents rather than one that invents an order it has not got.
    const byOrder = new Map<string, typeof accruals>();
    for (const row of open) {
      const take = allocation.get(`${row.billingNumber}|${row.lineNumber}`);
      if (!take || take <= 0.005) continue;
      byOrder.set(row.orderNumber, [...(byOrder.get(row.orderNumber) ?? []), row]);
    }

    const documents: RebateSettlementDocument[] = [];
    for (const [orderNumber, rows] of byOrder) {
      const amount = round2(rows.reduce(
        (sum, row) => sum + round2(allocation.get(`${row.billingNumber}|${row.lineNumber}`) ?? 0), 0,
      ));
      if (amount <= 0.005) continue;

      let number: string;
      try {
        const drawn = await allocateNumber(tx, {
          client: parsed.client, objectCode: memoType.numberRangeObject, companyCode: '*',
          subObject: memoType.numberRangeSubObject, fiscalYear: 0, allocatedBy: parsed.changedBy,
        });
        number = drawn.display;
      } catch {
        throw new RebateError(
          `No active internal ${memoType.numberRangeObject} number range stands for sub-object ${memoType.numberRangeSubObject}, so no settlement document can be drawn.`,
          'Define or unblock the interval on the number ranges screen, then settle again.',
        );
      }

      await tx.insert(billingDocument).values({
        client: parsed.client,
        billingNumber: number,
        documentType: memoType.documentType,
        orderNumber,
        salesOrg: agreement.salesOrg,
        distributionChannel: agreement.distributionChannel,
        division: agreement.division,
        customerNumber: agreement.customerNumber,
        companyCode,
        currency: agreement.currency,
        billingDate: parsed.settlementDate,
        postingDate: null,
        status: 'OPEN',
        netValue: money(amount),
        taxValue: '0.00',
        grossValue: money(amount),
        referenceDocumentText: `Rebate agreement ${agreement.agreementNumber}`,
        requestKey: parsed.requestKey ?? null,
        createdBy: parsed.changedBy,
      });
      let lineNumber = 10;
      for (const row of rows) {
        const lineAmount = round2(allocation.get(`${row.billingNumber}|${row.lineNumber}`) ?? 0);
        if (lineAmount <= 0.005) continue;
        await tx.insert(billingDocumentLine).values({
          client: parsed.client,
          billingNumber: number,
          lineNumber,
          deliveryNumber: null,
          deliveryLineNumber: null,
          orderNumber,
          orderLineNumber: row.orderLineNumber,
          materialNumber: row.materialNumber,
          billingQuantity: '1.000',
          netPrice: roundAmount(lineAmount, 4),
          priceUnit: 1,
          netAmount: money(lineAmount),
          taxCode: null,
          taxRate: '0.0000',
          taxAmount: '0.00',
          conditionNumber: row.conditionNumber,
          referenceBillingNumber: row.billingNumber,
          referenceBillingLineNumber: row.lineNumber,
          createdBy: parsed.changedBy,
        });
        lineNumber += 10;
      }
      const partners: DocumentPartners | null = await resolvePartners(tx, parsed.client, {
        partnerNumber: agreement.customerNumber,
        salesOrg: agreement.salesOrg,
        distributionChannel: agreement.distributionChannel,
        division: agreement.division,
      });
      if (partners) {
        await writeDocumentPartners(tx, {
          client: parsed.client, documentCategory: 'BILLING', documentNumber: number,
          partners, changedBy: parsed.changedBy,
        });
      }
      await recordChange(tx, {
        client: parsed.client, objectClass: 'billing_document', objectKey: number,
        changeType: 'CREATE', changedBy: parsed.changedBy, transactionCode: REBATE_TRANSACTION,
        after: {
          agreement: agreement.agreementNumber,
          order: orderNumber,
          amount: money(amount),
          reference: `Rebate agreement ${agreement.agreementNumber}`,
        },
        fieldLabels: {
          agreement: 'Rebate agreement', order: 'Order', amount: 'Settled', reference: 'Reference',
        },
      });

      // The credit memo is posted outside this transaction, as every credit memo is: the receivable is
      // accounting's own act, and the document stands whether or not it posts, which is what makes a
      // failed posting recoverable rather than lost.
      const credited = await postCustomerCreditMemo({
        client: parsed.client,
        changedBy: parsed.changedBy,
        customerNumber: agreement.customerNumber,
        companyCode,
        documentDate: parsed.settlementDate,
        postingDate: parsed.settlementDate,
        reference: number,
        currency: agreement.currency,
        grossAmount: amount,
        headerText: `Rebate settlement ${agreement.agreementNumber}`.slice(0, 50),
        requestKey: `rebate-settlement/${parsed.client}/${agreement.agreementNumber}/${number}`.slice(0, 64),
        lines: rows
          .filter((row) => (allocation.get(`${row.billingNumber}|${row.lineNumber}`) ?? 0) > 0.005)
          .map((row) => {
            // The provision this row built, in the account its own material determined: the settlement
            // releases what the accrual provided for, not a revenue account somebody chose for credits.
            const accounts = byMaterial.get(row.materialNumber);
            if (!accounts) {
              throw new RebateError(
                `No account stands for the provision on material ${row.materialNumber}, so the settlement cannot be posted.`,
                `Maintain the account determination for the key at ${ACCOUNT_DETERMINATION_ROUTE}.`,
              );
            }
            return {
              glAccount: accounts.provision,
              netAmount: round2(allocation.get(`${row.billingNumber}|${row.lineNumber}`) ?? 0),
              lineText: `${row.materialNumber} ${agreement.agreementNumber}`.slice(0, 50),
            };
          }),
      }).catch((error: unknown) => {
        if (error instanceof CustomerCreditMemoError) throw new RebateError(error.message, error.remedy);
        throw error;
      });

      await tx.update(billingDocument).set({
        status: 'POSTED',
        postingDate: parsed.settlementDate,
        customerInvoiceNumber: credited.invoiceNumber,
        journalDocumentNumber: credited.journalDocumentNumber ?? null,
        version: 1,
        changedBy: parsed.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(billingDocument.client, parsed.client),
        eq(billingDocument.billingNumber, number),
      ));

      for (const row of rows) {
        const lineAmount = round2(allocation.get(`${row.billingNumber}|${row.lineNumber}`) ?? 0);
        if (lineAmount <= 0.005) continue;
        const paid = round2(Number(row.settledAmount) + lineAmount);
        const full = round2(Number(row.rebateAmount) - paid) <= 0.005;
        await tx.update(salesRebateAccrual).set({
          settledAmount: money(paid),
          settlementNumber: number,
          status: full ? 'SETTLED' : 'ACCRUED',
          changedBy: parsed.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(salesRebateAccrual.client, parsed.client),
          eq(salesRebateAccrual.agreementNumber, agreement.agreementNumber),
          eq(salesRebateAccrual.billingNumber, row.billingNumber),
          eq(salesRebateAccrual.lineNumber, row.lineNumber),
        ));
      }

      documents.push({
        billingNumber: number,
        invoiceNumber: credited.invoiceNumber,
        journalDocumentNumber: credited.journalDocumentNumber ?? '',
        orderNumber,
        amount: money(amount),
      });
    }

    const after = await accrualsOf(tx, parsed.client, agreement.agreementNumber);
    const left = round2(after
      .filter((row) => row.status !== 'REVERSED')
      .reduce((sum, row) => sum + Number(row.outstanding), 0));
    const settlementType = left <= 0.005 ? 'FINAL' : 'PARTIAL';
    if (settlementType === 'FINAL' && agreement.status !== 'SETTLED') {
      await tx.update(salesRebateAgreement).set({
        status: 'SETTLED', changedBy: parsed.changedBy, changedAt: new Date(),
      }).where(and(
        eq(salesRebateAgreement.client, parsed.client),
        eq(salesRebateAgreement.agreementNumber, agreement.agreementNumber),
      ));
    }
    await recordChange(tx, {
      client: parsed.client, objectClass: REBATE_AGREEMENT_OBJECT_CLASS,
      objectKey: agreement.agreementNumber, changeType: 'CHANGE',
      changedBy: parsed.changedBy, transactionCode: REBATE_TRANSACTION,
      before: { status: agreement.status },
      after: {
        status: settlementType === 'FINAL' ? 'SETTLED' : agreement.status,
        settled: money(settled),
        outstanding: money(left),
        documents: documents.map((doc) => doc.billingNumber).join(' '),
      },
      fieldLabels: {
        status: 'Status', settled: 'Settled now', outstanding: 'Still outstanding',
        documents: 'Credit memos',
      },
    });

    return {
      agreementNumber: agreement.agreementNumber,
      amount: money(settled),
      settlementType,
      documents,
    };
  });
}
