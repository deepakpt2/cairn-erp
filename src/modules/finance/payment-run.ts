/**
 * Payment run — SCR-063 / R-111.
 *
 * Parameters gather into a proposal over the open supplier items;
 * exceptions are named, never dropped. Execution revalidates under
 * lock and posts one balanced journal per supplier and bank,
 * clearing the paid lines in place. An executed run is history.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { MONEY_SCALE, fromScaled, roundToScale, toScaled } from '../../platform/posting/decimal';
import { MoneyError, moneyFor } from '../../platform/posting/money';
import { requireExchangeRate } from './exchange-rate-lookup';
import {
  activeValuationConflict, fxDifferenceAccount, localUnitsOf, lockValuationSettlement,
} from './fx-settlement';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { bankAccount, houseBank, paymentMethod } from '../foundation/schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { dropDocumentRelease } from '../purchasing/release';
import {
  PAYMENT_RUN_RELEASE_CATEGORY, assertPaymentRunReleased, paymentRunReleaseKey, syncPaymentRunRelease,
} from './payment-run-release';
import { activeBlockedInvoiceNumbers } from '../purchasing/blocked-invoice';
import { supplierInvoice } from '../purchasing/schema';
import {
  journalEntry, journalEntryLine, paymentDocument, paymentProposalItem,
  paymentRun, paymentRunCompany, paymentRunMethod,
} from './schema';

export const PAYMENT_RUN_CAPABILITY = 'FIN.AP.PAYMENTRUN.EXECUTE';
const JOURNAL_DOCUMENT_TYPE = 'KZ';
export const RUN_CLASS = 'payment_run';

export class PaymentRunError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PaymentRunError';
    this.remedy = remedy;
  }
}

export const runKey = (runDate: string, runId: string) => `${runDate}/${runId}`;

/** The proposal or execution currently queued or running for a run. At most one can exist (unique index). */
export async function activePaymentOperation(tx: Tx, client: string, runDate: string, runId: string): Promise<{
  operationId: string; kind: string; status: string;
  houseBankKey: string | null; bankAccountId: string | null;
  bankAmounts: Array<{ companyCode: string; supplier: string; currency: string; amount: string }> | null;
} | null> {
  const rows = (await tx.execute(sql`
    select operation_id, kind, status, house_bank_key, bank_account_id, bank_amounts from payment_run_operation
     where client = ${client} and run_date = ${runDate} and run_id = ${runId} and status in ('QUEUED', 'RUNNING')
     limit 1
  `)) as unknown as Array<{
    operation_id: string; kind: string; status: string; house_bank_key: string | null;
    bank_account_id: string | null;
    bank_amounts: Array<{ companyCode: string; supplier: string; currency: string; amount: string }> | null;
  }>;
  return rows[0] ? {
    operationId: rows[0].operation_id, kind: rows[0].kind, status: rows[0].status,
    houseBankKey: rows[0].house_bank_key, bankAccountId: rows[0].bank_account_id,
    bankAmounts: rows[0].bank_amounts,
  } : null;
}

/** Canonical evidence signature, so a replay is distinguished from a materially different request. */
export function bankAmountSignature(rows: Array<{ companyCode: string; supplier: string; currency: string; amount: string }> | null | undefined): string {
  const normalized = (rows ?? []).map((row) => {
    let amount = String(row.amount).trim();
    try { amount = fromScaled(toScaled(amount)); } catch { /* judged at execution */ }
    return {
      companyCode: row.companyCode.trim().toUpperCase(),
      supplier: row.supplier.trim().toUpperCase(),
      currency: row.currency.trim().toUpperCase(),
      amount,
    };
  }).sort((a, b) => `${a.companyCode}|${a.supplier}|${a.currency}`.localeCompare(`${b.companyCode}|${b.supplier}|${b.currency}`));
  return JSON.stringify(normalized);
}

/** Refuse while a background proposal or execution is queued or running for this run. */
export async function assertNoActivePaymentOperation(tx: Tx, client: string, runDate: string, runId: string, verb: string, exceptOperationId?: string): Promise<void> {
  const active = await activePaymentOperation(tx, client, runDate, runId);
  if (active && active.operationId !== exceptOperationId) {
    throw new PaymentRunError(
      `Payment run ${runKey(runDate, runId)} cannot be ${verb} while a background ${active.kind.toLowerCase()} is ${active.status.toLowerCase()}.`,
      'Wait for it to finish, or cancel it first.',
    );
  }
}


export interface PaymentRunView {
  runDate: string;
  runId: string;
  postingDate: string;
  documentCutoffDate: string;
  nextPaymentDate: string;
  supplierFrom: string | null;
  supplierTo: string | null;
  status: string;
  companies: Array<{ companyCode: string; payingCompanyCode: string }>;
  methods: string[];
  proposal: Array<{
    itemNumber: number; companyCode: string; accountId: string;
    journalDocumentNumber: string; journalFiscalYear: number; journalLineNumber: number; invoiceNumber: string | null;
    currency: string; amount: string; dueDate: string | null;
    paymentMethod: string | null; exceptionCode: string | null; exceptionText: string | null;
  }>;
  payments: Array<{
    itemNumber: number; accountId: string; currency: string; amount: string;
    journalDocumentNumber: string; journalFiscalYear: number; journalLineNumber: number; invoiceNumber: string | null;
    houseBankKey: string; bankAccountId: string;
    bankAmount: string; bankCurrency: string | null; bankAmountSource: string;
  }>;
  payableTotal: number;
  exceptionCount: number;
}

export async function loadRun(tx: Tx, client: string, runDate: string, runId: string): Promise<PaymentRunView | null> {
  const [run] = await tx.select().from(paymentRun).where(and(
    eq(paymentRun.client, client), eq(paymentRun.runDate, runDate), eq(paymentRun.runId, runId),
  ));
  if (!run) return null;
  const companies = await tx.select().from(paymentRunCompany).where(and(
    eq(paymentRunCompany.client, client), eq(paymentRunCompany.runDate, runDate), eq(paymentRunCompany.runId, runId),
  ));
  const methods = await tx.select().from(paymentRunMethod).where(and(
    eq(paymentRunMethod.client, client), eq(paymentRunMethod.runDate, runDate), eq(paymentRunMethod.runId, runId),
  ));
  const proposal = await tx.select().from(paymentProposalItem).where(and(
    eq(paymentProposalItem.client, client),
    eq(paymentProposalItem.runDate, runDate), eq(paymentProposalItem.runId, runId),
  )).orderBy(paymentProposalItem.itemNumber);
  const payments = await tx.select().from(paymentDocument).where(and(
    eq(paymentDocument.client, client),
    eq(paymentDocument.runDate, runDate), eq(paymentDocument.runId, runId),
  )).orderBy(paymentDocument.itemNumber);
  return {
    runDate: run.runDate, runId: run.runId, postingDate: run.postingDate,
    documentCutoffDate: run.documentCutoffDate, nextPaymentDate: run.nextPaymentDate,
    supplierFrom: run.supplierFrom, supplierTo: run.supplierTo, status: run.status,
    companies: companies.map((c) => ({ companyCode: c.companyCode, payingCompanyCode: c.payingCompanyCode })),
    methods: methods.map((m) => m.paymentMethod),
    proposal: proposal.map((p) => ({
      itemNumber: p.itemNumber, companyCode: p.companyCode, accountId: p.accountId,
      journalDocumentNumber: p.journalDocumentNumber, journalFiscalYear: p.journalFiscalYear, journalLineNumber: p.journalLineNumber, invoiceNumber: p.invoiceNumber,
      currency: p.currency, amount: p.amount, dueDate: p.dueDate,
      paymentMethod: p.paymentMethod, exceptionCode: p.exceptionCode, exceptionText: p.exceptionText,
    })),
    payments: payments.map((p) => ({
      itemNumber: p.itemNumber, accountId: p.accountId, currency: p.currency,
      amount: p.amount, journalDocumentNumber: p.journalDocumentNumber,
      journalFiscalYear: p.journalFiscalYear, journalLineNumber: p.journalLineNumber,
      invoiceNumber: p.invoiceNumber, houseBankKey: p.houseBankKey, bankAccountId: p.bankAccountId,
      bankAmount: p.bankAmount, bankCurrency: p.bankCurrency?.trim() ?? null,
      bankAmountSource: p.bankAmountSource,
    })),
    // A sum across the proposed items is exact at the storage scale (a run can span currencies, so no single minor unit applies).
    payableTotal: Number(fromScaled(proposal.filter((p) => !p.exceptionCode).reduce((s, p) => s + roundToScale(p.amount, MONEY_SCALE), 0n))),
    exceptionCount: proposal.filter((p) => p.exceptionCode).length,
  };
}

export async function getPaymentRun(client: string, runDate: string, runId: string): Promise<PaymentRunView | null> {
  return withTenant(client, (tx) => loadRun(tx, client, runDate, runId));
}

export async function listPaymentRuns(client: string): Promise<Array<{ runDate: string; runId: string; status: string; postingDate: string }>> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(paymentRun).where(eq(paymentRun.client, client));
    return rows.map((r) => ({ runDate: r.runDate, runId: r.runId, status: r.status, postingDate: r.postingDate }));
  });
}

export interface BankChoice {
  companyCode: string; houseBankKey: string; accountId: string; currency: string; glAccount: string;
}

export async function listBankChoices(client: string): Promise<BankChoice[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(bankAccount).where(eq(bankAccount.client, client));
    return rows.map((r) => ({
      companyCode: r.companyCode, houseBankKey: r.houseBankKey, accountId: r.accountId,
      currency: r.currency, glAccount: r.glAccount,
    }));
  });
}

export interface CreateRunInput {
  client: string;
  changedBy: string;
  runDate: string;
  runId: string;
  postingDate: string;
  documentCutoffDate: string;
  nextPaymentDate: string;
  companies: Array<{ companyCode: string; payingCompanyCode: string }>;
  methods: string[];
  supplierFrom?: string;
  supplierTo?: string;
}

export async function createPaymentRun(input: CreateRunInput): Promise<PaymentRunView> {
  return withTenant(input.client, async (tx) => {
    const runId = input.runId.trim().toUpperCase();
    if (!/^[A-Z0-9]{1,5}$/.test(runId)) {
      throw new PaymentRunError('The run identification is at most five letters or digits.', 'Choose a short identification such as APR01.');
    }
    if (input.companies.length === 0) throw new PaymentRunError('At least one company code is required.');
    if (input.methods.length === 0) throw new PaymentRunError('At least one payment method is required.');
    const [existing] = await tx.select().from(paymentRun).where(and(
      eq(paymentRun.client, input.client), eq(paymentRun.runDate, input.runDate), eq(paymentRun.runId, runId),
    ));
    if (existing) throw new PaymentRunError(`Payment run ${runKey(input.runDate, runId)} already stands in status ${existing.status}.`);

    for (const company of input.companies) {
      const row = await getCompanyCode(tx, input.client, company.companyCode);
      if (!row?.country) throw new PaymentRunError(`Company code ${company.companyCode} is not configured.`);
      if (company.payingCompanyCode !== company.companyCode) {
        throw new PaymentRunError(
          `Paying company ${company.payingCompanyCode} differs from ${company.companyCode}.`,
          'Central payment from another company is a later round; the paying company is the company itself this round.',
        );
      }
      for (const method of input.methods) {
        const [standing] = await tx.select().from(paymentMethod).where(and(
          eq(paymentMethod.client, input.client),
          eq(paymentMethod.country, row.country),
          eq(paymentMethod.methodCode, method),
        ));
        if (!standing || !standing.isActive || standing.allowedDirection === 'INCOMING') {
          throw new PaymentRunError(
            `Payment method ${method} does not stand active for outgoing payments in country ${row.country}.`,
            'Maintain the payment method for the company country first.',
          );
        }
      }
    }

    await tx.insert(paymentRun).values({
      client: input.client, runDate: input.runDate, runId,
      postingDate: input.postingDate, documentCutoffDate: input.documentCutoffDate,
      nextPaymentDate: input.nextPaymentDate,
      supplierFrom: input.supplierFrom ?? null, supplierTo: input.supplierTo ?? null,
      status: 'PARAMETERS', createdBy: input.changedBy,
    });
    for (const company of input.companies) {
      await tx.insert(paymentRunCompany).values({
        client: input.client, runDate: input.runDate, runId, ...company, createdBy: input.changedBy,
      });
    }
    for (const method of input.methods) {
      await tx.insert(paymentRunMethod).values({
        client: input.client, runDate: input.runDate, runId, paymentMethod: method, createdBy: input.changedBy,
      });
    }
    await recordChange(tx, {
      client: input.client, objectClass: RUN_CLASS, objectKey: runKey(input.runDate, runId),
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: PAYMENT_RUN_CAPABILITY,
      after: { status: 'PARAMETERS', companies: input.companies.length, methods: input.methods },
    });
    return (await loadRun(tx, input.client, input.runDate, runId))!;
  });
}

export interface OpenItem {
  journalDocumentNumber: string;
  journalFiscalYear: number;
  journalLineNumber: number;
  companyCode: string;
  accountId: string;
  glAccount: string;
  currency: string;
  amount: number;
  journalPostingDate: string;
  invoiceNumber: string | null;
  dueDate: string | null;
}

export async function openItems(tx: Tx, client: string, run: PaymentRunView): Promise<OpenItem[]> {
  const companySet = new Set(run.companies.map((c) => c.companyCode));
  const lines = await tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    companyCode: journalEntryLine.companyCode,
    partner: journalEntryLine.businessPartner,
    glAccount: journalEntryLine.glAccount,
    currency: journalEntryLine.currency,
    // The payment settles the item in its own (document) currency, so its open amount is the document amount.
    amount: journalEntryLine.amountDocument,
    originClass: journalEntry.originClass,
    originKey: journalEntry.originKey,
    postingDate: journalEntry.postingDate,
  }).from(journalEntryLine)
    .innerJoin(journalEntry, and(
      eq(journalEntry.client, journalEntryLine.client),
      eq(journalEntry.documentNumber, journalEntryLine.documentNumber),
      eq(journalEntry.fiscalYear, journalEntryLine.fiscalYear),
    ))
    .where(and(
      eq(journalEntryLine.client, client),
      eq(journalEntryLine.debitCredit, 'H'),
      eq(journalEntry.status, 'POSTED'),
      sql`${journalEntry.reversalOf} is null`,
      sql`${journalEntryLine.businessPartner} is not null`,
      sql`${journalEntryLine.clearingDocument} is null`,
    ));
  const invoices = new Map<string, { dueDate: string | null }>();
  for (const inv of await tx.select().from(supplierInvoice).where(eq(supplierInvoice.client, client))) {
    invoices.set(inv.invoiceNumber, { dueDate: inv.dueDate });
  }
  const blocked = await activeBlockedInvoiceNumbers(tx, client);
  const items: OpenItem[] = [];
  for (const line of lines) {
    if (!companySet.has(line.companyCode)) continue;
    if (line.postingDate > run.documentCutoffDate) continue;
    if (run.supplierFrom && line.partner! < run.supplierFrom) continue;
    if (run.supplierTo && line.partner! > run.supplierTo) continue;
    const isInvoice = line.originClass === 'supplier_invoice' && line.originKey;
    // The same manual hold MRBR releases. The line stays open and is not proposed.
    if (isInvoice && blocked.has(line.originKey!)) continue;
    const invoice = isInvoice ? invoices.get(line.originKey!) : undefined;
    items.push({
      journalDocumentNumber: line.documentNumber,
      journalFiscalYear: line.fiscalYear,
      journalLineNumber: line.lineNumber,
      companyCode: line.companyCode,
      accountId: line.partner!,
      glAccount: line.glAccount,
      currency: line.currency,
      amount: Number(line.amount),
      journalPostingDate: line.postingDate as unknown as string,
      invoiceNumber: isInvoice ? line.originKey! : null,
      dueDate: invoice?.dueDate ?? (line.postingDate as unknown as string),
    });
  }
  return items;
}

export function supplierMethods(raw: string | null): string[] {
  if (!raw) return [];
  return raw.split(/[,\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export async function generateProposal(input: {
  client: string; changedBy: string; runDate: string; runId: string;
}): Promise<PaymentRunView> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/payrun/${input.runDate}/${input.runId}`}, 0))`);
    const run = await loadRun(tx, input.client, input.runDate, input.runId);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} does not exist.`);
    if (run.status === 'EXECUTED') throw new PaymentRunError('An executed run is history; its proposal cannot be regenerated.');
    if (run.status === 'CANCELLED') throw new PaymentRunError('A cancelled run cannot propose payments.');
    await assertNoActivePaymentOperation(tx, input.client, input.runDate, input.runId, 'regenerated');

    const items = await openItems(tx, input.client, run);
    await tx.delete(paymentProposalItem).where(and(
      eq(paymentProposalItem.client, input.client),
      eq(paymentProposalItem.runDate, input.runDate), eq(paymentProposalItem.runId, input.runId),
    ));
    let number = 0;
    for (const item of items) {
      if (item.dueDate && item.dueDate > run.nextPaymentDate) continue;
      number += 1;
      let exceptionCode: string | null = null;
      let exceptionText: string | null = null;
      let method: string | null = null;
      const [supplier] = await tx.select().from(supplierCompany).where(and(
        eq(supplierCompany.client, input.client),
        eq(supplierCompany.partnerNumber, item.accountId),
        eq(supplierCompany.companyCode, item.companyCode),
      ));
      if (supplier?.isBlocked) {
        exceptionCode = 'SUPPLIER_BLOCKED';
        exceptionText = `Supplier ${item.accountId} is blocked for company ${item.companyCode}.`;
      } else {
        const allowed = supplierMethods(supplier?.paymentMethods ?? null);
        method = run.methods.find((m) => allowed.length === 0 || allowed.includes(m)) ?? null;
        if (!method) {
          exceptionCode = 'NO_PAYMENT_METHOD';
          exceptionText = `None of the run's methods stands for supplier ${item.accountId}.`;
        }
      }
      await tx.insert(paymentProposalItem).values({
        client: input.client, runDate: input.runDate, runId: input.runId, itemNumber: number,
        companyCode: item.companyCode,
        payingCompanyCode: run.companies.find((c) => c.companyCode === item.companyCode)?.payingCompanyCode ?? item.companyCode,
        accountType: 'K', accountId: item.accountId,
        journalDocumentNumber: item.journalDocumentNumber,
        journalFiscalYear: item.journalFiscalYear, journalLineNumber: item.journalLineNumber,
        invoiceNumber: item.invoiceNumber, currency: item.currency,
        amount: String(item.amount), dueDate: item.dueDate, paymentMethod: method,
        exceptionCode, exceptionText, createdBy: input.changedBy,
      });
    }
    await tx.update(paymentRun).set({
      status: 'PROPOSAL', changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(paymentRun.client, input.client),
      eq(paymentRun.runDate, input.runDate), eq(paymentRun.runId, input.runId),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: RUN_CLASS, objectKey: runKey(input.runDate, input.runId),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PAYMENT_RUN_CAPABILITY,
      after: { status: 'PROPOSAL', items: number },
    });
    const proposed = (await loadRun(tx, input.client, input.runDate, input.runId))!;
    await syncPaymentRunRelease(tx, input.client, proposed, input.changedBy);
    return proposed;
  });
}

export async function executePaymentRun(input: {
  client: string; changedBy: string; runDate: string; runId: string;
  houseBankKey: string; bankAccountId: string;
  /**
   * The complete actual bank-account-currency evidence, one entry per resulting bank movement.
   * Required for every group when the bank account is held in the company local currency and the
   * payment is in another currency; a missing or conflicting entry refuses the whole run.
   */
  bankAmounts?: Array<{ companyCode: string; supplier: string; currency: string; amount: string }>;
  /** The background execution operation that is itself the active one, so it does not block itself. */
  exceptOperationId?: string;
  /**
   * Called first in the execution's own transaction, after the run lock. The background job uses it to
   * fence itself against a lost lease and to re-judge the submitting user against current grants.
   */
  beforeExecute?: (tx: Tx) => Promise<void>;
  /**
   * Called last, in the same transaction, once everything is posted and cleared. The background job
   * records the operation as SUCCEEDED here, so the payments and the record that they were made commit
   * together or not at all.
   */
  afterExecute?: (tx: Tx) => Promise<void>;
}): Promise<PaymentRunView> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/payrun/${input.runDate}/${input.runId}`}, 0))`);
    await input.beforeExecute?.(tx);
    const run = await loadRun(tx, input.client, input.runDate, input.runId);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} does not exist.`);
    await assertNoActivePaymentOperation(tx, input.client, input.runDate, input.runId, 'executed', input.exceptOperationId);
    if (run.status === 'EXECUTED') throw new PaymentRunError('This run has already been executed; payments cannot be posted twice.');
    if (run.status !== 'PROPOSAL') throw new PaymentRunError('Create the proposal before executing.', 'Generate the proposal, review it, then execute.');

    const payable = run.proposal.filter((p) => !p.exceptionCode);
    if (payable.length === 0) throw new PaymentRunError('The proposal carries no payable items.', 'Resolve the exceptions or widen the selection.');
    await assertPaymentRunReleased(tx, input.client, input.runDate, input.runId).catch((error: unknown) => {
      if (error instanceof Error && error.name === 'ReleaseError') {
        throw new PaymentRunError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });

    // Serialize with period-end valuation for every company the run touches. A stable order across
    // runs avoids a deadlock between two executions covering the same companies.
    for (const companyCode of [...new Set(payable.map((p) => p.companyCode))].sort()) {
      await lockValuationSettlement(tx, input.client, companyCode);
    }

    const groupKeyOf = (companyCode: string, supplier: string, currency: string) =>
      `${companyCode.trim().toUpperCase()}|${supplier.trim().toUpperCase()}|${currency.trim().toUpperCase()}`;

    // Revalidate every item against its standing journal line.
    interface Entry { item: (typeof payable)[number]; glAccount: string; amountLocal: string }
    interface Group { company: string; supplier: string; currency: string; entries: Entry[] }
    const groups = new Map<string, Group>();
    for (const item of payable) {
      const [line] = await tx.select().from(journalEntryLine).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, item.journalDocumentNumber),
        eq(journalEntryLine.fiscalYear, item.journalFiscalYear),
        eq(journalEntryLine.lineNumber, item.journalLineNumber),
      ));
      if (!line || line.clearingDocument) {
        throw new PaymentRunError(`The item for supplier ${item.accountId} no longer stands open.`, 'Regenerate the proposal, then execute.');
      }
      const [supplier] = await tx.select().from(supplierCompany).where(and(
        eq(supplierCompany.client, input.client),
        eq(supplierCompany.partnerNumber, item.accountId),
        eq(supplierCompany.companyCode, item.companyCode),
      ));
      if (supplier?.isBlocked) throw new PaymentRunError(`Supplier ${item.accountId} is blocked.`, 'Regenerate the proposal, then execute.');
      const key = groupKeyOf(item.companyCode, item.accountId, item.currency);
      const group = groups.get(key) ?? { company: item.companyCode, supplier: item.accountId, currency: item.currency, entries: [] as Entry[] };
      group.entries.push({ item, glAccount: line.glAccount, amountLocal: line.amountLocal });
      groups.set(key, group);
    }

    // The complete actual-bank-amount set, keyed unambiguously to a resulting movement (company,
    // supplier, currency). Duplicates and unknown keys are refused before anything is posted.
    const evidence = new Map<string, string>();
    for (const row of input.bankAmounts ?? []) {
      const key = groupKeyOf(row.companyCode, row.supplier, row.currency);
      if (evidence.has(key)) {
        throw new PaymentRunError(
          `The actual bank amount for ${row.companyCode}/${row.supplier}/${row.currency} was stated more than once.`,
          'State exactly one actual bank amount for each resulting bank movement.',
        );
      }
      evidence.set(key, String(row.amount));
    }
    for (const key of evidence.keys()) {
      if (!groups.has(key)) {
        throw new PaymentRunError(
          `The actual bank amount for ${key.replaceAll('|', '/')} names no proposed payment group.`,
          'Reload the proposal and state the actual bank amounts against its groups.',
        );
      }
    }

    interface Prepared {
      group: Group;
      bank: typeof bankAccount.$inferSelect;
      company: NonNullable<Awaited<ReturnType<typeof getCompanyCode>>>;
      money: Awaited<ReturnType<typeof moneyFor>>;
      localMoney: Awaited<ReturnType<typeof moneyFor>>;
      rate: Awaited<ReturnType<typeof requireExchangeRate>>;
      totalUnits: bigint;
      bankLocalUnits: bigint;
      bankAccountAmount: string;
      bankAccountCurrency: string;
      bankAmountSource: string;
    }
    const prepared: Prepared[] = [];
    for (const group of groups.values()) {
      const [bank] = await tx.select().from(bankAccount).where(and(
        eq(bankAccount.client, input.client),
        eq(bankAccount.companyCode, group.company),
        eq(bankAccount.houseBankKey, input.houseBankKey),
        eq(bankAccount.accountId, input.bankAccountId),
      ));
      if (!bank) {
        throw new PaymentRunError(
          `House bank ${input.houseBankKey} account ${input.bankAccountId} does not stand for company ${group.company}.`,
          'Choose a standing house-bank account for the paying company.',
        );
      }
      const company = await getCompanyCode(tx, input.client, group.company);
      if (!company?.fiscalYearVariant) throw new PaymentRunError(`Company code ${group.company} is not configured.`);
      const [bankStanding] = await tx.select().from(houseBank).where(and(
        eq(houseBank.client, input.client),
        eq(houseBank.companyCode, group.company),
        eq(houseBank.houseBankKey, input.houseBankKey),
      ));
      if (!bankStanding) throw new PaymentRunError(`House bank ${input.houseBankKey} does not stand for company ${group.company}.`);

      const groupCurrency = group.currency.trim().toUpperCase();
      const bankCurrency = bank.currency.trim().toUpperCase();
      const localCurrency = company.currency.trim().toUpperCase();
      // The account must be held in the payment currency or in the company local currency; a third
      // currency would need a bank movement the journal cannot state.
      if (bankCurrency !== groupCurrency && bankCurrency !== localCurrency) {
        throw new PaymentRunError(
          `Bank account currency ${bankCurrency} is neither the payment currency ${groupCurrency} nor the company local currency (${localCurrency}).`,
          'Choose a bank account in the payment currency or the local currency.',
        );
      }
      // Exact at the payment currency's decimals: each item is rounded once, the bank line is their exact sum.
      const money = await moneyFor(tx, groupCurrency).catch((error: unknown) => {
        if (error instanceof MoneyError) throw new PaymentRunError(error.message, error.remedy);
        throw error;
      });
      const localMoney = await moneyFor(tx, localCurrency).catch((error: unknown) => {
        if (error instanceof MoneyError) throw new PaymentRunError(error.message, error.remedy);
        throw error;
      });
      const rate = await requireExchangeRate(
        tx, input.client, groupCurrency, localCurrency, run.postingDate,
      ).catch((error: unknown) => {
        if (error instanceof Error && 'remedy' in error) {
          throw new PaymentRunError(error.message, (error as { remedy?: string }).remedy);
        }
        throw error;
      });
      const totalUnits = group.entries.reduce((s, e) => s + money.units(e.item.amount), 0n);
      const key = groupKeyOf(group.company, group.supplier, group.currency);
      const stated = evidence.get(key);
      let bankLocalUnits: bigint;
      let bankAccountAmount: string;
      let bankAmountSource: string;
      if (bankCurrency === localCurrency && groupCurrency !== localCurrency) {
        if (stated === undefined || stated.trim() === '') {
          throw new PaymentRunError(
            `Bank account ${input.houseBankKey}/${input.bankAccountId} is held in ${localCurrency}, but group ${group.company}/${group.supplier} pays in ${groupCurrency}. The actual bank amount is required.`,
            `Enter the amount the bank actually moves for ${group.supplier}, in ${localCurrency}. Nothing has been posted.`,
          );
        }
        let enteredUnits: bigint;
        try {
          enteredUnits = localMoney.entered(stated, `The actual bank amount for ${group.supplier}`);
        } catch (error) {
          if (error instanceof MoneyError) throw new PaymentRunError(error.message, error.remedy);
          throw error;
        }
        if (enteredUnits <= 0n) {
          throw new PaymentRunError(`The actual bank amount for ${group.supplier} must stand above zero.`);
        }
        bankLocalUnits = enteredUnits * 10n ** BigInt(MONEY_SCALE - localMoney.scale);
        bankAccountAmount = localMoney.fromUnits(enteredUnits);
        bankAmountSource = 'USER_ACTUAL';
      } else {
        if (stated !== undefined && stated.trim() !== '') {
          let statedUnits: bigint;
          try { statedUnits = money.entered(stated, `The actual bank amount for ${group.supplier}`); } catch (error) {
            if (error instanceof MoneyError) throw new PaymentRunError(error.message, error.remedy);
            throw error;
          }
          if (statedUnits !== totalUnits) {
            throw new PaymentRunError(
              `The actual bank amount for ${group.supplier} (${money.fromUnits(statedUnits)} ${groupCurrency}) does not equal the proposed ${money.fromUnits(totalUnits)} ${groupCurrency}.`,
              'When the bank is held in the payment currency, its movement is the proposal total; do not restate it.',
            );
          }
        }
        bankLocalUnits = localUnitsOf(totalUnits, money.scale, localMoney.scale, rate);
        bankAccountAmount = money.fromUnits(totalUnits);
        bankAmountSource = bankCurrency === localCurrency ? 'SAME_CURRENCY' : 'PAYMENT_CURRENCY';
      }
      prepared.push({
        group, bank, company, money, localMoney, rate, totalUnits, bankLocalUnits,
        bankAccountAmount, bankAccountCurrency: bankCurrency, bankAmountSource,
      });
    }

    let paymentNumber = 0;
    for (const p of prepared) {
      const { group, bank, company, money, localMoney, rate, totalUnits, bankLocalUnits } = p;
      const position = await derivePosition(tx, input.client, company.fiscalYearVariant!, run.postingDate);

      for (const entry of group.entries) {
        const conflict = await activeValuationConflict(tx, input.client, group.company, {
          documentNumber: entry.item.journalDocumentNumber,
          lineNumber: entry.item.journalLineNumber,
          accountNumber: entry.glAccount,
          currency: group.currency,
        }, run.postingDate);
        if (conflict) {
          throw new PaymentRunError(
            `Item ${entry.item.invoiceNumber} was valued at period end by run ${conflict.runId} (key date ${conflict.valuationKeyDate}).`,
            'Reverse that FX valuation document first, then execute the run. Settling over an active valuation would count the same exchange difference twice.',
          );
        }
      }

      const lines: Array<{
        glAccount: string; debitCredit: 'S' | 'H'; amount: string; amountLocal: string;
        localOnly?: boolean; businessPartner?: string; lineText?: string;
      }> = group.entries.map((e) => ({
        glAccount: e.glAccount, debitCredit: 'S' as const,
        amount: money.text(e.item.amount), amountLocal: e.amountLocal,
        businessPartner: e.item.accountId,
      }));
      lines.push({
        glAccount: bank.glAccount, debitCredit: 'H' as const, amount: money.fromUnits(totalUnits),
        amountLocal: fromScaled(bankLocalUnits),
      });
      const localSigned = lines.reduce(
        (total, line) => total + (line.debitCredit === 'S' ? toScaled(line.amountLocal) : -toScaled(line.amountLocal)),
        0n,
      );
      if (localSigned !== 0n) {
        const event = localSigned > 0n ? 'FXGAIN' : 'FXLOSS';
        const account = await fxDifferenceAccount(tx, input.client, company.chartOfAccounts ?? '', event);
        if (!account) {
          throw new PaymentRunError(
            `Account determination for ${event} does not stand in chart ${company.chartOfAccounts ?? ''}, so the realized exchange difference cannot be posted.`,
            `Maintain the ${event} account determination, then execute the run. Nothing has been posted.`,
          );
        }
        lines.push({
          glAccount: account,
          debitCredit: localSigned > 0n ? 'H' : 'S',
          amount: '0',
          amountLocal: fromScaled(localSigned < 0n ? -localSigned : localSigned),
          localOnly: true,
          lineText: localSigned > 0n ? 'Realized exchange gain' : 'Realized exchange loss',
        });
      }

      const journal = await postJournalEntry(tx, {
        client: input.client,
        companyCode: group.company,
        documentType: JOURNAL_DOCUMENT_TYPE,
        documentDate: run.postingDate,
        postingDate: run.postingDate,
        fiscalYear: position.fiscalYear,
        postingPeriod: position.period,
        currency: group.currency,
        localCurrency: company.currency,
        rate,
        reference: runKey(run.runDate, run.runId),
        headerText: `Payment run ${runKey(run.runDate, run.runId)}`,
        lines,
        origin: { documentClass: RUN_CLASS, documentKey: runKey(run.runDate, run.runId) },
        postedBy: input.changedBy,
        transactionCode: PAYMENT_RUN_CAPABILITY,
        precision: 'CURRENCY',
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new PaymentRunError(error.message, error.remedy);
        throw error;
      });

      for (const [index, entry] of group.entries.entries()) {
        await tx.update(journalEntryLine).set({
          clearingDocument: journal.documentNumber, clearingDate: run.postingDate,
        }).where(and(
          eq(journalEntryLine.client, input.client),
          eq(journalEntryLine.documentNumber, entry.item.journalDocumentNumber),
          eq(journalEntryLine.fiscalYear, entry.item.journalFiscalYear),
          eq(journalEntryLine.lineNumber, entry.item.journalLineNumber),
        ));
        paymentNumber += 1;
        await tx.insert(paymentDocument).values({
          client: input.client, runDate: input.runDate, runId: input.runId,
          itemNumber: paymentNumber, companyCode: group.company,
          payingCompanyCode: group.company, accountId: group.supplier,
          currency: group.currency, amount: entry.item.amount,
          bankAmount: p.bankAccountAmount, bankCurrency: p.bankAccountCurrency,
          bankAmountSource: p.bankAmountSource,
          journalDocumentNumber: journal.documentNumber,
          journalFiscalYear: journal.fiscalYear, journalLineNumber: index + 1,
          invoiceNumber: entry.item.invoiceNumber,
          houseBankKey: input.houseBankKey, bankAccountId: input.bankAccountId,
          createdBy: input.changedBy,
        });
      }
      // The payment document clears its own vendor lines too (SCR-120):
      // like F-53/F-28, the clearing stamps the payment side as well as
      // the invoices, so a paid vendor's payment never stands open in
      // ageing or open-item displays. The bank line carries no partner
      // and is untouched.
      await tx.update(journalEntryLine).set({
        clearingDocument: journal.documentNumber, clearingDate: run.postingDate,
      }).where(and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, journal.documentNumber),
        eq(journalEntryLine.fiscalYear, journal.fiscalYear),
        sql`${journalEntryLine.businessPartner} is not null`,
        sql`${journalEntryLine.clearingDocument} is null`,
      ));
    }

    await tx.update(paymentRun).set({
      status: 'EXECUTED', changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(paymentRun.client, input.client),
      eq(paymentRun.runDate, input.runDate), eq(paymentRun.runId, input.runId),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: RUN_CLASS, objectKey: runKey(input.runDate, input.runId),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PAYMENT_RUN_CAPABILITY,
      after: { status: 'EXECUTED', payments: paymentNumber },
    });
    await input.afterExecute?.(tx);
    return (await loadRun(tx, input.client, input.runDate, input.runId))!;
  });
}

export async function cancelPaymentRun(input: {
  client: string; changedBy: string; runDate: string; runId: string;
}): Promise<PaymentRunView> {
  return withTenant(input.client, async (tx) => {
    const run = await loadRun(tx, input.client, input.runDate, input.runId);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} does not exist.`);
    if (run.status === 'EXECUTED') throw new PaymentRunError('An executed run is history; it cannot be cancelled or deleted.');
    await assertNoActivePaymentOperation(tx, input.client, input.runDate, input.runId, 'cancelled');
    await tx.update(paymentRun).set({
      status: 'CANCELLED', changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(paymentRun.client, input.client),
      eq(paymentRun.runDate, input.runDate), eq(paymentRun.runId, input.runId),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: RUN_CLASS, objectKey: runKey(input.runDate, input.runId),
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PAYMENT_RUN_CAPABILITY,
      after: { status: 'CANCELLED' },
    });
    await dropDocumentRelease(tx, input.client, PAYMENT_RUN_RELEASE_CATEGORY, paymentRunReleaseKey(input.runDate, input.runId));
    return (await loadRun(tx, input.client, input.runDate, input.runId))!;
  });
}
