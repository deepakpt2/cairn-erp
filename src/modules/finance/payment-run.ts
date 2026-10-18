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
import { postJournalEntry, PostingError } from '../../platform/posting';
import { bankAccount, houseBank, paymentMethod } from '../foundation/schema';
import { supplierCompany } from '../foundation/supplier-company-schema';
import { supplierInvoice } from '../purchasing/schema';
import {
  journalEntry, journalEntryLine, paymentDocument, paymentProposalItem,
  paymentRun, paymentRunCompany, paymentRunMethod,
} from './schema';

export const PAYMENT_RUN_CAPABILITY = 'FIN.AP.PAYMENTRUN.EXECUTE';
const JOURNAL_DOCUMENT_TYPE = 'KZ';
const RUN_CLASS = 'payment_run';

export class PaymentRunError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PaymentRunError';
    this.remedy = remedy;
  }
}

const round2 = (n: number) => Math.round(n * 100) / 100;
const runKey = (runDate: string, runId: string) => `${runDate}/${runId}`;

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
  }>;
  payableTotal: number;
  exceptionCount: number;
}

async function loadRun(tx: Tx, client: string, runDate: string, runId: string): Promise<PaymentRunView | null> {
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
    })),
    payableTotal: round2(proposal.filter((p) => !p.exceptionCode).reduce((s, p) => s + Number(p.amount), 0)),
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

interface OpenItem {
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

async function openItems(tx: Tx, client: string, run: PaymentRunView): Promise<OpenItem[]> {
  const companySet = new Set(run.companies.map((c) => c.companyCode));
  const lines = await tx.select({
    documentNumber: journalEntryLine.documentNumber,
    fiscalYear: journalEntryLine.fiscalYear,
    lineNumber: journalEntryLine.lineNumber,
    companyCode: journalEntryLine.companyCode,
    partner: journalEntryLine.businessPartner,
    glAccount: journalEntryLine.glAccount,
    currency: journalEntryLine.currency,
    amount: journalEntryLine.amountLocal,
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
      sql`${journalEntryLine.businessPartner} is not null`,
      sql`${journalEntryLine.clearingDocument} is null`,
    ));
  const invoices = new Map<string, { dueDate: string | null }>();
  for (const inv of await tx.select().from(supplierInvoice).where(eq(supplierInvoice.client, client))) {
    invoices.set(inv.invoiceNumber, { dueDate: inv.dueDate });
  }
  const items: OpenItem[] = [];
  for (const line of lines) {
    if (!companySet.has(line.companyCode)) continue;
    if (line.postingDate > run.documentCutoffDate) continue;
    if (run.supplierFrom && line.partner! < run.supplierFrom) continue;
    if (run.supplierTo && line.partner! > run.supplierTo) continue;
    const isInvoice = line.originClass === 'supplier_invoice' && line.originKey;
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

function supplierMethods(raw: string | null): string[] {
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
    return (await loadRun(tx, input.client, input.runDate, input.runId))!;
  });
}

export async function executePaymentRun(input: {
  client: string; changedBy: string; runDate: string; runId: string;
  houseBankKey: string; bankAccountId: string;
}): Promise<PaymentRunView> {
  return withTenant(input.client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/payrun/${input.runDate}/${input.runId}`}, 0))`);
    const run = await loadRun(tx, input.client, input.runDate, input.runId);
    if (!run) throw new PaymentRunError(`Payment run ${runKey(input.runDate, input.runId)} does not exist.`);
    if (run.status === 'EXECUTED') throw new PaymentRunError('This run has already been executed; payments cannot be posted twice.');
    if (run.status !== 'PROPOSAL') throw new PaymentRunError('Create the proposal before executing.', 'Generate the proposal, review it, then execute.');

    const payable = run.proposal.filter((p) => !p.exceptionCode);
    if (payable.length === 0) throw new PaymentRunError('The proposal carries no payable items.', 'Resolve the exceptions or widen the selection.');

    // Revalidate every item against its standing journal line.
    interface Entry { item: (typeof payable)[number]; glAccount: string }
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
      const key = `${item.companyCode}|${item.accountId}|${item.currency}`;
      const group = groups.get(key) ?? { company: item.companyCode, supplier: item.accountId, currency: item.currency, entries: [] as Entry[] };
      group.entries.push({ item, glAccount: line.glAccount });
      groups.set(key, group);
    }

    let paymentNumber = 0;
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
      if (bank.currency !== group.currency) {
        throw new PaymentRunError(
          `Bank account currency ${bank.currency} does not agree with the payment currency ${group.currency}.`,
          'Choose a bank account in the payment currency.',
        );
      }
      const [bankStanding] = await tx.select().from(houseBank).where(and(
        eq(houseBank.client, input.client),
        eq(houseBank.companyCode, group.company),
        eq(houseBank.houseBankKey, input.houseBankKey),
      ));
      if (!bankStanding) throw new PaymentRunError(`House bank ${input.houseBankKey} does not stand for company ${group.company}.`);

      const company = await getCompanyCode(tx, input.client, group.company);
      if (!company?.fiscalYearVariant) throw new PaymentRunError(`Company code ${group.company} is not configured.`);
      const position = await derivePosition(tx, input.client, company.fiscalYearVariant, run.postingDate);
      const total = round2(group.entries.reduce((s, e) => s + Number(e.item.amount), 0));
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
        reference: runKey(run.runDate, run.runId),
        headerText: `Payment run ${runKey(run.runDate, run.runId)}`,
        lines: [
          ...group.entries.map((e) => ({
            glAccount: e.glAccount, debitCredit: 'S' as const,
            amount: Number(e.item.amount).toFixed(2), businessPartner: e.item.accountId,
          })),
          { glAccount: bank.glAccount, debitCredit: 'H' as const, amount: total.toFixed(2) },
        ],
        origin: { documentClass: RUN_CLASS, documentKey: runKey(run.runDate, run.runId) },
        postedBy: input.changedBy,
        transactionCode: PAYMENT_RUN_CAPABILITY,
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
          journalDocumentNumber: journal.documentNumber,
          journalFiscalYear: journal.fiscalYear, journalLineNumber: index + 1,
          invoiceNumber: entry.item.invoiceNumber,
          houseBankKey: input.houseBankKey, bankAccountId: input.bankAccountId,
          createdBy: input.changedBy,
        });
      }
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
    return (await loadRun(tx, input.client, input.runDate, input.runId))!;
  });
}
