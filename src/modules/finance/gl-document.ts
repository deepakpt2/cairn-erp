/**
 * G/L document entry — SCR-096 / R-144 (FB50 as a search alias
 * only).
 *
 * The judged front door of the standing posting engine for a
 * directly entered G/L document: the whole document is validated
 * against standing master data inside the posting transaction
 * before the engine writes anything, and a client-supplied request
 * key makes a duplicate submission return the document the first
 * submission produced instead of posting twice. Posted documents
 * stay immutable; reversal rides the canonical FB08-equivalent
 * workflow, never this service.
 */
import { and, eq } from 'drizzle-orm';

import { type Tx, withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode, PeriodError } from '../../platform/periods';
import {
  computeTotals, postJournalEntry, PostingError, type PostedJournal,
} from '../../platform/posting';
import { toScaled } from '../../platform/posting/decimal';
import {
  hasCompanyCodeAssignments, missingCompanyCodeAssignments, describeMissingCompanyCodeAssignments,
} from '../foundation/company-code-assignments';
import { costCenter, documentType, profitCenter } from '../foundation/schema';
import { glAccount, glAccountCompany, journalEntry, journalEntryLine, journalPostingRequest } from './schema';

export const GL_DOCUMENT_CAPABILITY = 'FIN.JOURNAL.POST';

export class GlDocumentError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GlDocumentError';
    this.remedy = remedy;
  }
}

export interface GlDocumentLineInput {
  glAccount: string;
  debitCredit: 'S' | 'H';
  amount: string;
  costCenter?: string;
  profitCenter?: string;
  assignment?: string;
  lineText?: string;
}

export interface GlDocumentInput {
  client: string;
  changedBy: string;
  requestKey: string;
  /** SCR-100 hook: runs inside the posting transaction after the journal writes. */
  onPosted?: (tx: Tx, posted: PostedJournal) => Promise<void>;
  companyCode: string;
  documentDate: string;
  postingDate: string;
  documentType: string;
  currency: string;
  reference?: string;
  headerText?: string;
  lines: GlDocumentLineInput[];
}

const CURRENCY_DECIMALS: Record<string, number> = { JPY: 0, KWD: 3, BHD: 3, OMR: 3 };

function judgeDate(label: string, value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new GlDocumentError(`${label} ${value} is not a calendar date.`, 'Enter the date as yyyy-mm-dd.');
  const [, y, m, d] = match.map(Number) as unknown as [number, number, number, number];
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw new GlDocumentError(`${label} ${value} is not a calendar date.`, 'Enter a real calendar date.');
  }
}

async function replayResult(tx: Tx, client: string, requestKey: string): Promise<PostedJournal | null> {
  const [request] = await tx.select().from(journalPostingRequest).where(and(
    eq(journalPostingRequest.client, client), eq(journalPostingRequest.requestKey, requestKey),
  ));
  if (!request) return null;
  const [header] = await tx.select().from(journalEntry).where(and(
    eq(journalEntry.client, client), eq(journalEntry.documentNumber, request.documentNumber),
    eq(journalEntry.fiscalYear, request.fiscalYear),
  ));
  const lines = await tx.select().from(journalEntryLine).where(and(
    eq(journalEntryLine.client, client), eq(journalEntryLine.documentNumber, request.documentNumber),
    eq(journalEntryLine.fiscalYear, request.fiscalYear),
  ));
  const totals = computeTotals(lines.map((l) => ({
    glAccount: l.glAccount, debitCredit: l.debitCredit as 'S' | 'H', amount: l.amountDocument,
  })));
  return {
    documentNumber: request.documentNumber, fiscalYear: request.fiscalYear,
    displayNumber: header?.displayNumber ?? request.documentNumber,
    debitTotal: totals.debit, creditTotal: totals.credit, lineCount: lines.length,
  };
}

/**
 * Post one directly entered G/L document, or return the document a
 * previous submission with the same request key produced.
 */
export async function postGlDocument(input: GlDocumentInput): Promise<PostedJournal> {
  if (!input.requestKey?.trim()) {
    throw new GlDocumentError('A request key is required.', 'Reload the entry screen, then post again.');
  }
  judgeDate('Document date', input.documentDate);
  judgeDate('Posting date', input.postingDate);
  if (input.reference && input.reference.length > 16) {
    throw new GlDocumentError('The reference may be at most 16 characters.', 'Shorten the document reference.');
  }
  if (input.headerText && input.headerText.length > 25) {
    throw new GlDocumentError('The header text may be at most 25 characters.', 'Shorten the header text.');
  }
  if (!/^[A-Z0-9]{2}$/.test(input.documentType.toUpperCase())) {
    throw new GlDocumentError(
      `Document type ${input.documentType} is not a two-character type.`,
      'Choose a configured document type.',
    );
  }
  if (input.lines.length < 2) {
    throw new GlDocumentError(
      'A document must have at least two line items.',
      'Enter at least two lines — a debit and a credit — before posting.',
    );
  }
  for (const [i, line] of input.lines.entries()) {
    if (line.assignment && line.assignment.length > 18) {
      throw new GlDocumentError(`Line ${i + 1}: the assignment may be at most 18 characters.`);
    }
    if (line.lineText && line.lineText.length > 50) {
      throw new GlDocumentError(`Line ${i + 1}: the line text may be at most 50 characters.`);
    }
  }

  return withTenant(input.client, async (tx) => {
    const replay = await replayResult(tx, input.client, input.requestKey);
    if (replay) return replay;

    const company = await getCompanyCode(tx, input.client, input.companyCode);
    if (!company?.isActive) {
      throw new GlDocumentError(
        `Company code ${input.companyCode} is not active or does not exist.`,
        'Choose an active company code in this tenant.',
      );
    }
    if (!hasCompanyCodeAssignments(company)) {
      throw new GlDocumentError(
        `Company code ${input.companyCode} is missing ${describeMissingCompanyCodeAssignments(missingCompanyCodeAssignments(company))}.`,
        'Complete the Company Code assignment steps before posting.',
      );
    }
    if (input.currency.toUpperCase() !== company.currency) {
      throw new GlDocumentError(
        `Foreign-currency entry in ${input.currency.toUpperCase()} is not available on this screen yet.`,
        `Post in the company local currency ${company.currency}; exchange-rate selection arrives with currency maintenance.`,
      );
    }
    const [type] = await tx.select().from(documentType).where(and(
      eq(documentType.client, input.client),
      eq(documentType.documentType, input.documentType.toUpperCase()),
    ));
    if (!type?.isActive) {
      throw new GlDocumentError(
        `Document type ${input.documentType.toUpperCase()} is not active or does not exist.`,
        'Choose a configured document type.',
      );
    }
    if (!type.allowedAccountTypes.includes('S')) {
      throw new GlDocumentError(
        `Document type ${type.documentType} does not permit G/L postings.`,
        'Choose a document type whose allowed account types include S.',
      );
    }

    const decimals = CURRENCY_DECIMALS[company.currency] ?? 2;
    for (const [i, line] of input.lines.entries()) {
      if (!line.glAccount?.trim()) {
        throw new GlDocumentError(`Line ${i + 1} has no G/L account.`, 'Every line must carry an account.');
      }
      let scaled: bigint;
      try {
        scaled = toScaled(line.amount);
      } catch {
        throw new GlDocumentError(`Line ${i + 1} has an invalid amount (${line.amount}).`, 'Enter a positive amount.');
      }
      if (scaled <= 0n) {
        throw new GlDocumentError(
          `Line ${i + 1} has a non-positive amount (${line.amount}).`,
          'Enter a positive amount and set the line to debit or credit.',
        );
      }
      // Precision is judged on value, not spelling: 50.0000 is a
      // two-decimal amount written at canonical scale, 100.234 is not.
      if (scaled % (10n ** BigInt(4 - decimals)) !== 0n) {
        throw new GlDocumentError(
          `Line ${i + 1}: amount ${line.amount} exceeds the ${decimals} decimal places of ${company.currency}.`,
          'Correct the amount to the currency precision.',
        );
      }
      const [account] = await tx.select().from(glAccount).where(and(
        eq(glAccount.client, input.client),
        eq(glAccount.chartOfAccounts, company.chartOfAccounts ?? ''),
        eq(glAccount.accountNumber, line.glAccount),
      ));
      if (!account) {
        throw new GlDocumentError(
          `Line ${i + 1}: G/L account ${line.glAccount} does not stand in company ${input.companyCode}'s chart of accounts.`,
          'Correct the account, or extend it to the company chart, then post again.',
        );
      }
      if (account.isBlockedPosting) {
        throw new GlDocumentError(`Line ${i + 1}: G/L account ${line.glAccount} is blocked for posting.`);
      }
      const [segment] = await tx.select().from(glAccountCompany).where(and(
        eq(glAccountCompany.client, input.client),
        eq(glAccountCompany.companyCode, input.companyCode),
        eq(glAccountCompany.glAccount, line.glAccount),
      ));
      if (segment?.isBlockedPosting) {
        throw new GlDocumentError(`Line ${i + 1}: G/L account ${line.glAccount} is blocked for posting in company ${input.companyCode}.`);
      }
      if (account.requiresCostObject && !line.costCenter && !line.profitCenter) {
        throw new GlDocumentError(
          `Line ${i + 1}: account ${line.glAccount} requires a cost object.`,
          'Enter a cost centre or profit centre on the line.',
        );
      }
      if (line.costCenter) {
        const [cc] = await tx.select().from(costCenter).where(and(
          eq(costCenter.client, input.client), eq(costCenter.costCenter, line.costCenter),
          eq(costCenter.companyCode, input.companyCode),
        ));
        if (!cc || cc.validFrom > input.postingDate || cc.validTo < input.postingDate) {
          throw new GlDocumentError(
            `Line ${i + 1}: cost centre ${line.costCenter} is not valid for company ${input.companyCode} on ${input.postingDate}.`,
          );
        }
        if (cc.isPostingLocked) {
          throw new GlDocumentError(`Line ${i + 1}: cost centre ${line.costCenter} is locked for posting.`);
        }
      }
      if (line.profitCenter) {
        const [pc] = await tx.select().from(profitCenter).where(and(
          eq(profitCenter.client, input.client), eq(profitCenter.profitCenter, line.profitCenter),
        ));
        if (!pc || pc.validFrom > input.postingDate || pc.validTo < input.postingDate) {
          throw new GlDocumentError(
            `Line ${i + 1}: profit centre ${line.profitCenter} is not valid on ${input.postingDate}.`,
          );
        }
        if (pc.isPostingLocked) {
          throw new GlDocumentError(`Line ${i + 1}: profit centre ${line.profitCenter} is locked for posting.`);
        }
      }
    }

    const totals = computeTotals(input.lines);
    if (totals.debit !== totals.credit || totals.debit === '0.0000' || totals.debit === '0') {
      throw new GlDocumentError(
        `The document does not balance. Debits ${totals.debit}, credits ${totals.credit}.`,
        'Correct the amounts so that total debits equal total credits, then post again.',
      );
    }

    let position;
    try {
      position = await derivePosition(tx, input.client, company.fiscalYearVariant!, input.postingDate);
    } catch (error) {
      if (error instanceof PeriodError) throw new GlDocumentError(error.message, error.remedy);
      throw error;
    }

    const posted = await postJournalEntry(tx, {
      client: input.client,
      companyCode: input.companyCode,
      documentType: type.documentType,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: company.currency,
      localCurrency: company.currency,
      reference: input.reference,
      headerText: input.headerText,
      lines: input.lines.map((line) => ({ ...line, glAccount: line.glAccount.trim() })),
      postedBy: input.changedBy,
      transactionCode: GL_DOCUMENT_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new GlDocumentError(error.message, error.remedy);
      if (error instanceof PeriodError) throw new GlDocumentError(error.message, error.remedy);
      throw error;
    });

    if (input.onPosted) await input.onPosted(tx, posted);
    await tx.insert(journalPostingRequest).values({
      client: input.client, requestKey: input.requestKey, actor: input.changedBy,
      documentNumber: posted.documentNumber, fiscalYear: posted.fiscalYear,
    });
    return posted;
  });
}
