/**
 * Parked journal entries — SCR-087 / R-135.
 *
 * Parking stores a preliminary G/L document in staging tables
 * without touching posted balances: a parked document may stand
 * incomplete and unbalanced, while save-as-complete is a judged
 * transition (every line complete, accounts and assignments
 * standing, debits equal credits) and final posting revalidates
 * everything through the posting engine in one transaction under
 * the header's row lock, so a retry can never post twice. The
 * parked record is retained after posting as an immutable
 * reference naming the canonical document; deletion is a logical
 * status with a mandatory reason, never a physical delete. Edits
 * are version-checked, and any edit returns a completed document
 * to PARKED for re-judging.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { costCenter, documentType, profitCenter, taxCode } from '../foundation/schema';
import { glAccount, parkedJournalHeader, parkedJournalLine } from './schema';

export const PARKED_JOURNAL_CAPABILITY = 'FIN.JOURNAL.PARK';
const PARKED_CLASS = 'parked_journal';

export class ParkedJournalError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'ParkedJournalError';
    this.remedy = remedy;
  }
}

export type ParkedStatus = 'PARKED' | 'COMPLETED' | 'POSTED' | 'DELETED';

export interface ParkedLineInput {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: number;
  costCenter?: string;
  profitCenter?: string;
  taxCode?: string;
  assignment?: string;
  lineText?: string;
}

export interface ParkedLineView {
  lineNumber: number;
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: number;
  costCenter: string | null;
  profitCenter: string | null;
  taxCode: string | null;
  assignment: string | null;
  lineText: string | null;
}

export interface ParkedJournalView {
  parkedNumber: string;
  fiscalYear: number;
  companyCode: string;
  documentType: string;
  documentDate: string;
  postingDate: string;
  currency: string;
  reference: string | null;
  headerText: string | null;
  status: ParkedStatus;
  version: number;
  parkedBy: string;
  postedDocumentNumber: string | null;
  totalDebit: number;
  totalCredit: number;
  balance: number;
  lines: ParkedLineView[];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

interface HeaderInput {
  companyCode: string;
  documentDate: string;
  postingDate: string;
  documentType: string;
  currency: string;
  reference?: string;
  headerText?: string;
  lines: ParkedLineInput[];
}

function judgeHeaderDates(input: HeaderInput) {
  for (const [label, value] of [['Document date', input.documentDate], ['Posting date', input.postingDate]] as const) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ParkedJournalError(`${label} ${value} is not a calendar date.`);
  }
  if (input.reference && input.reference.length > 16) {
    throw new ParkedJournalError('The reference may be at most 16 characters.', 'Shorten the document reference.');
  }
}

async function judgeParkableLines(tx: Tx, client: string, lines: ParkedLineInput[]) {
  if (lines.length === 0) {
    throw new ParkedJournalError('Park at least one line.', 'Enter the lines the document will post, even if it does not balance yet.');
  }
  for (const [i, line] of lines.entries()) {
    if (!line.glAccount) throw new ParkedJournalError(`Line ${i + 1} names no G/L account.`);
    if (line.debitCredit !== 'S' && line.debitCredit !== 'H') {
      throw new ParkedJournalError(`Line ${i + 1}: the debit/credit indicator is S or H.`);
    }
    if (!(line.amount > 0)) throw new ParkedJournalError(`Line ${i + 1}: the amount must stand above zero.`);
    const [account] = await tx.select({ accountNumber: glAccount.accountNumber }).from(glAccount).where(and(
      eq(glAccount.client, client), eq(glAccount.accountNumber, line.glAccount),
    ));
    if (!account) {
      throw new ParkedJournalError(
        `Line ${i + 1}: G/L account ${line.glAccount} does not stand in this tenant.`,
        'Correct the account, or create it, then park again.',
      );
    }
  }
}

async function judgeDocumentType(tx: Tx, client: string, type: string) {
  const [row] = await tx.select().from(documentType).where(and(
    eq(documentType.client, client), eq(documentType.documentType, type.toUpperCase()),
  ));
  if (!row) {
    throw new ParkedJournalError(
      `Document type ${type.toUpperCase()} is not configured for this tenant.`,
      'Configure the document type, then park again.',
    );
  }
}

type HeaderRow = typeof parkedJournalHeader.$inferSelect;
type LineRow = typeof parkedJournalLine.$inferSelect;

function toView(header: HeaderRow, lines: LineRow[]): ParkedJournalView {
  const totalDebit = round2(lines.filter((l) => l.debitCredit === 'S').reduce((s, l) => s + Number(l.amount), 0));
  const totalCredit = round2(lines.filter((l) => l.debitCredit === 'H').reduce((s, l) => s + Number(l.amount), 0));
  return {
    parkedNumber: header.parkedNumber, fiscalYear: header.fiscalYear,
    companyCode: header.companyCode, documentType: header.documentType,
    documentDate: header.documentDate, postingDate: header.postingDate,
    currency: header.currency, reference: header.reference, headerText: header.headerText,
    status: header.status as ParkedStatus, version: header.version,
    parkedBy: header.createdBy,
    postedDocumentNumber: header.postedDocumentNumber,
    totalDebit, totalCredit, balance: round2(totalDebit - totalCredit),
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, glAccount: l.glAccount,
      debitCredit: l.debitCredit as 'S' | 'H', amount: Number(l.amount),
      costCenter: l.costCenter, profitCenter: l.profitCenter,
      taxCode: l.taxCode, assignment: l.assignment, lineText: l.lineText,
    })),
  };
}

async function loadView(tx: Tx, client: string, parkedNumber: string): Promise<ParkedJournalView | null> {
  const [header] = await tx.select().from(parkedJournalHeader).where(and(
    eq(parkedJournalHeader.client, client), eq(parkedJournalHeader.parkedNumber, parkedNumber),
  ));
  if (!header) return null;
  const lines = await tx.select().from(parkedJournalLine).where(and(
    eq(parkedJournalLine.client, client), eq(parkedJournalLine.parkedNumber, parkedNumber),
  )).orderBy(parkedJournalLine.lineNumber);
  return toView(header, lines);
}

async function lockedHeader(tx: Tx, client: string, parkedNumber: string): Promise<HeaderRow> {
  const [header] = await tx.select().from(parkedJournalHeader).where(and(
    eq(parkedJournalHeader.client, client), eq(parkedJournalHeader.parkedNumber, parkedNumber),
  )).for('update');
  if (!header) {
    throw new ParkedJournalError(
      `Parked document ${parkedNumber} does not stand in this tenant.`, 'Reload the parked documents, then act again.',
    );
  }
  return header;
}

async function insertLines(tx: Tx, client: string, parkedNumber: string, fiscalYear: number, changedBy: string, lines: ParkedLineInput[]) {
  for (const [i, line] of lines.entries()) {
    await tx.insert(parkedJournalLine).values({
      client, parkedNumber, fiscalYear, lineNumber: i + 1,
      glAccount: line.glAccount, debitCredit: line.debitCredit,
      amount: String(round2(line.amount)),
      costCenter: line.costCenter || null, profitCenter: line.profitCenter || null,
      taxCode: line.taxCode || null, assignment: line.assignment || null,
      lineText: line.lineText || null, createdBy: changedBy,
    });
  }
}

async function byRequestKey(tx: Tx, client: string, requestKey: string): Promise<ParkedJournalView | null> {
  const [header] = await tx.select().from(parkedJournalHeader).where(and(
    eq(parkedJournalHeader.client, client), eq(parkedJournalHeader.requestKey, requestKey),
  ));
  return header ? loadView(tx, client, header.parkedNumber) : null;
}

export async function parkJournal(input: HeaderInput & {
  client: string; changedBy: string; requestKey: string;
}): Promise<ParkedJournalView> {
  judgeHeaderDates(input);
  return withTenant(input.client, async (tx) => {
    const replay = await byRequestKey(tx, input.client, input.requestKey);
    if (replay) return replay;
    await judgeDocumentType(tx, input.client, input.documentType);
    await judgeParkableLines(tx, input.client, input.lines);
    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.fiscalYearVariant) throw new ParkedJournalError(`Company code ${input.companyCode} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'PARKDOC', allocatedBy: input.changedBy,
    });
    const parkedNumber = allocated.display;
    await tx.insert(parkedJournalHeader).values({
      client: input.client, parkedNumber, fiscalYear: position.fiscalYear,
      companyCode: input.companyCode, documentType: input.documentType.toUpperCase(),
      documentDate: input.documentDate, postingDate: input.postingDate,
      currency: input.currency.toUpperCase(), reference: input.reference ?? null,
      headerText: input.headerText ?? null,
      status: 'PARKED', version: 1,
      requestKey: input.requestKey, createdBy: input.changedBy,
    });
    await insertLines(tx, input.client, parkedNumber, position.fiscalYear, input.changedBy, input.lines);
    await recordChange(tx, {
      client: input.client, objectClass: PARKED_CLASS,
      objectKey: `${input.companyCode}/${parkedNumber}`,
      changeType: 'CREATE', changedBy: input.changedBy, transactionCode: PARKED_JOURNAL_CAPABILITY,
      after: { status: 'PARKED', lines: input.lines.length },
    });
    return (await loadView(tx, input.client, parkedNumber))!;
  });
}

export async function editParkedJournal(input: HeaderInput & {
  client: string; changedBy: string; parkedNumber: string; expectedVersion: number;
}): Promise<ParkedJournalView> {
  judgeHeaderDates(input);
  return withTenant(input.client, async (tx) => {
    const header = await lockedHeader(tx, input.client, input.parkedNumber);
    if (header.status === 'POSTED' || header.status === 'DELETED') {
      throw new ParkedJournalError(
        `Parked document ${input.parkedNumber} stands ${header.status.toLowerCase()} and can no longer be edited.`,
      );
    }
    if (header.version !== input.expectedVersion) {
      throw new ParkedJournalError(
        `Parked document ${input.parkedNumber} has changed since it was loaded (version ${header.version}).`,
        'Reload the document, then apply your changes again.',
      );
    }
    await judgeDocumentType(tx, input.client, input.documentType);
    await judgeParkableLines(tx, input.client, input.lines);
    await tx.delete(parkedJournalLine).where(and(
      eq(parkedJournalLine.client, input.client), eq(parkedJournalLine.parkedNumber, input.parkedNumber),
    ));
    await insertLines(tx, input.client, input.parkedNumber, header.fiscalYear, input.changedBy, input.lines);
    await tx.update(parkedJournalHeader).set({
      documentDate: input.documentDate, postingDate: input.postingDate,
      documentType: input.documentType.toUpperCase(), currency: input.currency.toUpperCase(),
      reference: input.reference ?? null, headerText: input.headerText ?? null,
      status: 'PARKED', version: header.version + 1,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(parkedJournalHeader.client, input.client), eq(parkedJournalHeader.parkedNumber, input.parkedNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: PARKED_CLASS,
      objectKey: `${header.companyCode}/${input.parkedNumber}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PARKED_JOURNAL_CAPABILITY,
      after: { status: 'PARKED', version: header.version + 1, lines: input.lines.length },
    });
    return (await loadView(tx, input.client, input.parkedNumber))!;
  });
}

/** The completeness gate shared by save-as-complete and posting. */
async function judgeCompleteness(tx: Tx, client: string, view: ParkedJournalView) {
  await judgeDocumentType(tx, client, view.documentType);
  if (view.lines.length === 0) throw new ParkedJournalError('The document carries no lines.', 'Enter the lines, then complete.');
  for (const line of view.lines) {
    const [account] = await tx.select({ accountNumber: glAccount.accountNumber }).from(glAccount).where(and(
      eq(glAccount.client, client), eq(glAccount.accountNumber, line.glAccount),
    ));
    if (!account) {
      throw new ParkedJournalError(`Line ${line.lineNumber}: G/L account ${line.glAccount} does not stand in this tenant.`);
    }
    if (line.costCenter) {
      const [cc] = await tx.select({ code: costCenter.costCenter }).from(costCenter).where(and(
        eq(costCenter.client, client), eq(costCenter.costCenter, line.costCenter),
      ));
      if (!cc) throw new ParkedJournalError(`Line ${line.lineNumber}: cost centre ${line.costCenter} does not stand in this tenant.`);
    }
    if (line.profitCenter) {
      const [pc] = await tx.select({ code: profitCenter.profitCenter }).from(profitCenter).where(and(
        eq(profitCenter.client, client), eq(profitCenter.profitCenter, line.profitCenter),
      ));
      if (!pc) throw new ParkedJournalError(`Line ${line.lineNumber}: profit centre ${line.profitCenter} does not stand in this tenant.`);
    }
    if (line.taxCode) {
      const [tc] = await tx.select({ code: taxCode.taxCode }).from(taxCode).where(and(
        eq(taxCode.client, client), eq(taxCode.taxCode, line.taxCode),
      ));
      if (!tc) throw new ParkedJournalError(`Line ${line.lineNumber}: tax code ${line.taxCode} does not stand in this tenant.`);
    }
  }
  if (Math.abs(view.balance) > 0.005) {
    throw new ParkedJournalError(
      `The document does not balance: debits ${view.totalDebit.toFixed(2)} against credits ${view.totalCredit.toFixed(2)}.`,
      'Balance the document, then complete.',
    );
  }
}

export async function completeParkedJournal(input: {
  client: string; changedBy: string; parkedNumber: string;
}): Promise<ParkedJournalView> {
  return withTenant(input.client, async (tx) => {
    const header = await lockedHeader(tx, input.client, input.parkedNumber);
    if (header.status === 'COMPLETED') return (await loadView(tx, input.client, input.parkedNumber))!;
    if (header.status !== 'PARKED') {
      throw new ParkedJournalError(`Parked document ${input.parkedNumber} stands ${header.status.toLowerCase()} and cannot be completed.`);
    }
    const view = (await loadView(tx, input.client, input.parkedNumber))!;
    await judgeCompleteness(tx, input.client, view);
    await tx.update(parkedJournalHeader).set({
      status: 'COMPLETED', version: header.version + 1,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(parkedJournalHeader.client, input.client), eq(parkedJournalHeader.parkedNumber, input.parkedNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: PARKED_CLASS,
      objectKey: `${header.companyCode}/${input.parkedNumber}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PARKED_JOURNAL_CAPABILITY,
      after: { status: 'COMPLETED', version: header.version + 1 },
    });
    return (await loadView(tx, input.client, input.parkedNumber))!;
  });
}

export async function postParkedJournal(input: {
  client: string; changedBy: string; parkedNumber: string;
}): Promise<ParkedJournalView> {
  return withTenant(input.client, async (tx) => {
    const header = await lockedHeader(tx, input.client, input.parkedNumber);
    if (header.status === 'POSTED') return (await loadView(tx, input.client, input.parkedNumber))!;
    if (header.status !== 'PARKED' && header.status !== 'COMPLETED') {
      throw new ParkedJournalError(`Parked document ${input.parkedNumber} stands ${header.status.toLowerCase()} and cannot be posted.`);
    }
    const view = (await loadView(tx, input.client, input.parkedNumber))!;
    await judgeCompleteness(tx, input.client, view);
    const company = await getCompanyCode(tx, input.client, header.companyCode);
    if (!company?.fiscalYearVariant) throw new ParkedJournalError(`Company code ${header.companyCode} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, header.postingDate);
    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: header.companyCode,
      documentType: header.documentType,
      documentDate: header.documentDate,
      postingDate: header.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: header.currency,
      localCurrency: company.currency,
      reference: header.reference ?? undefined,
      headerText: header.headerText ?? undefined,
      lines: view.lines.map((l) => ({
        glAccount: l.glAccount, debitCredit: l.debitCredit,
        amount: l.amount.toFixed(2),
        costCenter: l.costCenter ?? undefined, profitCenter: l.profitCenter ?? undefined,
        taxCode: l.taxCode ?? undefined, lineText: l.lineText ?? undefined,
      })),
      origin: { documentClass: PARKED_CLASS, documentKey: input.parkedNumber },
      postedBy: input.changedBy,
      transactionCode: 'FIN.JOURNAL.POST',
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new ParkedJournalError(error.message, error.remedy);
      if (error instanceof Error && 'remedy' in error) {
        throw new ParkedJournalError(error.message, (error as { remedy?: string }).remedy);
      }
      throw error;
    });
    await tx.update(parkedJournalHeader).set({
      status: 'POSTED', version: header.version + 1,
      postedDocumentNumber: journal.documentNumber, postedFiscalYear: journal.fiscalYear,
      postedAt: new Date(), postedByUser: input.changedBy,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(parkedJournalHeader.client, input.client), eq(parkedJournalHeader.parkedNumber, input.parkedNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: PARKED_CLASS,
      objectKey: `${header.companyCode}/${input.parkedNumber}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PARKED_JOURNAL_CAPABILITY,
      after: { status: 'POSTED', postedDocumentNumber: journal.documentNumber },
    });
    return (await loadView(tx, input.client, input.parkedNumber))!;
  });
}

export async function deleteParkedJournal(input: {
  client: string; changedBy: string; parkedNumber: string; reason?: string;
}): Promise<ParkedJournalView> {
  const reason = (input.reason ?? '').trim();
  if (!reason) throw new ParkedJournalError('A reason is required to delete a parked document.', 'State why the document goes.');
  return withTenant(input.client, async (tx) => {
    const header = await lockedHeader(tx, input.client, input.parkedNumber);
    if (header.status === 'POSTED') {
      throw new ParkedJournalError(
        `Parked document ${input.parkedNumber} stands posted as ${header.postedDocumentNumber}; reverse the posted document instead.`,
      );
    }
    if (header.status === 'DELETED') return (await loadView(tx, input.client, input.parkedNumber))!;
    await tx.update(parkedJournalHeader).set({
      status: 'DELETED', statusReason: reason, version: header.version + 1,
      changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(parkedJournalHeader.client, input.client), eq(parkedJournalHeader.parkedNumber, input.parkedNumber),
    ));
    await recordChange(tx, {
      client: input.client, objectClass: PARKED_CLASS,
      objectKey: `${header.companyCode}/${input.parkedNumber}`,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: PARKED_JOURNAL_CAPABILITY,
      reason, after: { status: 'DELETED', version: header.version + 1 },
    });
    return (await loadView(tx, input.client, input.parkedNumber))!;
  });
}

export async function listParkedJournals(
  client: string, status?: ParkedStatus,
): Promise<ParkedJournalView[]> {
  return withTenant(client, async (tx) => {
    const headers = await tx.select().from(parkedJournalHeader)
      .where(eq(parkedJournalHeader.client, client))
      .orderBy(parkedJournalHeader.postingDate, parkedJournalHeader.parkedNumber);
    const views: ParkedJournalView[] = [];
    for (const header of headers) {
      if (status && header.status !== status) continue;
      const view = await loadView(tx, client, header.parkedNumber);
      if (view) views.push(view);
    }
    return views;
  });
}

export async function getParkedJournal(
  client: string, parkedNumber: string,
): Promise<ParkedJournalView | null> {
  return withTenant(client, async (tx) => loadView(tx, client, parkedNumber));
}
