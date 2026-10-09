/**
 * Posting engine — E6, CAIRN.md §5.2, §5.3, D-017
 *
 * Implements the posting contract from §5.3. The invariant this engine exists to
 * protect:
 *
 *     an unbalanced accounting document is structurally impossible
 *
 * It is enforced twice, on purpose. Here in the engine, so the user gets a clear
 * message naming the problem; and again as a deferred constraint in the database,
 * so that no future code path — a migration, a script, a well-meaning hotfix —
 * can write a document that does not balance. Belt and braces on the one rule the
 * whole ledger rests on.
 */
import { and, eq } from 'drizzle-orm';
import { documentType } from '../../modules/foundation/schema';
import { numberRangeAllocation } from '../tables/numbering';
import type { Tx } from '../db/client';
import { glAccount, journalEntry, journalEntryLine } from '../../modules/finance/schema';
import { allocateNumber } from '../numbering';
import { acquireLocks } from '../lock';
import { recordChange } from '../change';
import {
  indexDocument,
  linkDocuments,
  recordStatusChange,
  type DocumentRef,
} from '../document';
import { fromScaled, multiplyScaled, toScaled } from './decimal';
import {
  derivePosition,
  checkPostingAllowed,
  getCompanyCode,
  type AccountType,
} from '../periods';

export const JOURNAL_DOCUMENT_CLASS = 'journal_entry';

export interface PostingLineInput {
  glAccount: string;
  /** 'S' = debit, 'H' = credit. */
  debitCredit: 'S' | 'H';
  /** Positive decimal string. Direction lives in debitCredit, never in the sign. */
  amount: string;
  /** Account assignments — any of these may be present on a line. */
  costCenter?: string;
  profitCenter?: string;
  internalOrder?: string;
  productionOrder?: string;
  businessPartner?: string;
  material?: string;
  plant?: string;
  taxCode?: string;
  lineText?: string;
}

export interface PostJournalInput {
  client: string;
  companyCode: string;
  documentType: string;
  /** ISO date, yyyy-mm-dd. */
  documentDate: string;
  postingDate: string;
  fiscalYear: number;
  postingPeriod: number;
  currency: string;
  localCurrency: string;
  exchangeRate?: string;
  reference?: string;
  headerText?: string;
  lines: PostingLineInput[];
  /** The document that caused this posting, if any — creates the flow link. */
  origin?: DocumentRef;
  postedBy: string;
  transactionCode?: string;
}

export interface PostedJournal {
  documentNumber: string;
  fiscalYear: number;
  displayNumber: string;
  debitTotal: string;
  creditTotal: string;
  lineCount: number;
}

/**
 * Post a journal entry. One transaction, all or nothing.
 *
 * The order of operations follows §5.3 deliberately: validity is established
 * before anything is written, and the number is allocated inside the same
 * transaction so a rollback frees it rather than burning it.
 */
export async function postJournalEntry(
  tx: Tx,
  input: PostJournalInput,
): Promise<PostedJournal> {
  // ── Phase 3 · Validation ────────────────────────────────────────────────────
  assertLinesPresent(input.lines);
  assertPositiveAmounts(input.lines);
  const totals = computeTotals(input.lines);
  assertBalanced(totals);
  assertAccountsPresent(input.lines);

  // ── Phase 2 · Locking ───────────────────────────────────────────────────────
  // Lock the company code's posting period for the date being posted to, which is
  // what stops two concurrent postings racing a period-close decision.
  await acquireLocks(
    tx,
    [
      {
        objectCode: 'POSTING_PERIOD',
        keys: [input.companyCode, `${input.fiscalYear}-${input.postingPeriod}`],
      },
    ],
    { client: input.client, requestedBy: input.postedBy, transactionCode: input.transactionCode },
  );

  // ── Phase 3b · Posting period control ───────────────────────────────────────
  // SEAM (M1b): validate against the posting period variant (§14.3). The table and
  // its configuration arrive with the finance configuration module. Until then the
  // check is a documented pass-through rather than a silent omission — see CAIRN.md
  // §27.1 and the M1b scope.
  await assertPostingPeriodOpen(tx, input);

  // ── Phase 5 · Number allocation ─────────────────────────────────────────────
  const [type] = await tx.select().from(documentType).where(and(eq(documentType.client, input.client), eq(documentType.documentType, input.documentType)));
  if (!type?.isActive) throw new PostingError(`Document type ${input.documentType} is not active or does not exist.`, 'Choose a configured document type.');
  const allocated = await allocateNumber(tx, {
    client: input.client,
    objectCode: type.numberRangeObject,
    companyCode: input.companyCode,
    subObject: type.numberRangeSubObject,
    fiscalYear: input.fiscalYear,
    allocatedBy: input.postedBy,
    transactionCode: input.transactionCode,
  });

  // A display string is not a document identity: two company codes may both
  // issue 000001, and CLASSIC omits the year. Existing keys remain untouched.
  const documentNumber = `${input.companyCode}/${input.fiscalYear}/${allocated.value}`;

  // ── Phase 6 · Document creation ─────────────────────────────────────────────
  const exchangeRate = input.exchangeRate ?? '1';

  await tx.insert(journalEntry).values({
    client: input.client,
    documentNumber,
    displayNumber: allocated.display,
    fiscalYear: input.fiscalYear,
    documentType: input.documentType,
    companyCode: input.companyCode,
    documentDate: input.documentDate,
    postingDate: input.postingDate,
    postingPeriod: input.postingPeriod,
    documentCurrency: input.currency,
    localCurrency: input.localCurrency,
    exchangeRate,
    reference: input.reference,
    headerText: input.headerText,
    status: 'POSTED',
    originClass: input.origin?.documentClass,
    originKey: input.origin?.documentKey,
    createdBy: input.postedBy,
  });

  await tx.insert(journalEntryLine).values(
    input.lines.map((line, index) => {
      const amountLocal =
        input.currency === input.localCurrency
          ? line.amount
          : fromScaled(multiplyScaled(toScaled(line.amount), exchangeRate));
      return {
        client: input.client,
        documentNumber,
        fiscalYear: input.fiscalYear,
        lineNumber: index + 1,
        glAccount: line.glAccount,
        companyCode: input.companyCode,
        debitCredit: line.debitCredit,
        amountLocal,
        amountDocument: line.amount,
        currency: input.currency,
        costCenter: line.costCenter,
        profitCenter: line.profitCenter,
        internalOrder: line.internalOrder,
        productionOrder: line.productionOrder,
        businessPartner: line.businessPartner,
        material: line.material,
        plant: line.plant,
        taxCode: line.taxCode,
        lineText: line.lineText,
      };
    }),
  );

  const document: DocumentRef = {
    documentClass: JOURNAL_DOCUMENT_CLASS,
    documentKey: documentNumber,
  };

  // ── Phase 11 · Document flow ────────────────────────────────────────────────
  if (input.origin) {
    await linkDocuments(tx, {
      client: input.client,
      predecessor: input.origin,
      successor: document,
      relationType: 'ACCOUNTING_DOCUMENT',
      value: totals.debit,
      currency: input.localCurrency,
      createdBy: input.postedBy,
    });
  }

  // ── Phase 7b · Search index ─────────────────────────────────────────────────
  await indexDocument(tx, {
    client: input.client,
    document: document,
    displayNumber: allocated.display,
    documentType: input.documentType,
    companyCode: input.companyCode,
    postingDate: new Date(input.postingDate),
    status: 'POSTED',
    summary: input.headerText ?? `${input.lines.length} lines`,
    searchText: [allocated.display, input.reference, input.headerText]
      .filter(Boolean)
      .join(' '),
    metadata: {
      debitTotal: totals.debit,
      creditTotal: totals.credit,
      currency: input.localCurrency,
    },
  });

  await recordStatusChange(tx, {
    client: input.client,
    document,
    previousStatus: null,
    newStatus: 'POSTED',
    reason: 'Document created',
    changedBy: input.postedBy,
  });

  await tx.update(numberRangeAllocation).set({ documentId: documentNumber }).where(eq(numberRangeAllocation.id, allocated.allocationId));

  return {
    documentNumber,
    fiscalYear: input.fiscalYear,
    displayNumber: allocated.display,
    debitTotal: totals.debit,
    creditTotal: totals.credit,
    lineCount: input.lines.length,
  };
}

/**
 * Reverse a journal entry. The original document is never modified beyond the
 * reversal links, and never deleted (D-017). The mirror document carries swapped
 * debit and credit indicators, so the pair nets to zero without erasing history.
 */
export async function reverseJournalEntry(
  tx: Tx,
  input: {
    client: string;
    documentNumber: string;
    fiscalYear: number;
    reversalDate: string;
    reason: string;
    reversedBy: string;
    transactionCode?: string;
  },
): Promise<PostedJournal> {
  const original = await tx
    .select()
    .from(journalEntry)
    .where(
      and(
        eq(journalEntry.client, input.client),
        eq(journalEntry.documentNumber, input.documentNumber),
        eq(journalEntry.fiscalYear, input.fiscalYear),
      ),
    )
    .limit(1);

  if (original.length === 0) {
    throw new PostingError(
      `Document ${input.documentNumber} does not exist in fiscal year ${input.fiscalYear}.`,
      'Check the document number and fiscal year, or find it through the document search.',
    );
  }
  const header = original[0];

  if (header.status === 'REVERSED') {
    throw new PostingError(
      `Document ${input.documentNumber} has already been reversed by ${header.reversedBy}.`,
      'A document can only be reversed once. Post a corrective entry instead.',
    );
  }

  const lines = await tx
    .select()
    .from(journalEntryLine)
    .where(
      and(
        eq(journalEntryLine.client, input.client),
        eq(journalEntryLine.documentNumber, input.documentNumber),
        eq(journalEntryLine.fiscalYear, input.fiscalYear),
      ),
    );

  const reversalPeriod = Number(input.reversalDate.slice(5, 7));
  const reversalFiscalYear = Number(input.reversalDate.slice(0, 4));

  const reversal = await postJournalEntry(tx, {
    client: input.client,
    companyCode: header.companyCode,
    documentType: header.documentType,
    documentDate: input.reversalDate,
    postingDate: input.reversalDate,
    fiscalYear: reversalFiscalYear,
    postingPeriod: reversalPeriod,
    currency: header.documentCurrency,
    localCurrency: header.localCurrency,
    exchangeRate: header.exchangeRate,
    reference: input.documentNumber,
    headerText: `Reversal of ${input.documentNumber}: ${input.reason}`,
    origin: {
      documentClass: JOURNAL_DOCUMENT_CLASS,
      documentKey: input.documentNumber,
    },
    postedBy: input.reversedBy,
    transactionCode: input.transactionCode,
    lines: lines
      .sort((a, b) => a.lineNumber - b.lineNumber)
      .map((line) => ({
        glAccount: line.glAccount,
        // Swapping the indicator is what makes the reversal a mirror, not a deletion.
        debitCredit: line.debitCredit === 'S' ? ('H' as const) : ('S' as const),
        amount: line.amountDocument,
        costCenter: line.costCenter ?? undefined,
        profitCenter: line.profitCenter ?? undefined,
        internalOrder: line.internalOrder ?? undefined,
        productionOrder: line.productionOrder ?? undefined,
        businessPartner: line.businessPartner ?? undefined,
        material: line.material ?? undefined,
        plant: line.plant ?? undefined,
        taxCode: line.taxCode ?? undefined,
        lineText: line.lineText ?? undefined,
      })),
  });

  // Only the two links change on the original. Nothing is erased.
  await tx
    .update(journalEntry)
    .set({
      status: 'REVERSED',
      reversedBy: reversal.documentNumber,
      reversalReason: input.reason,
      changedBy: input.reversedBy,
      changedAt: new Date(),
    })
    .where(
      and(
        eq(journalEntry.client, input.client),
        eq(journalEntry.documentNumber, input.documentNumber),
        eq(journalEntry.fiscalYear, input.fiscalYear),
      ),
    );

  await recordStatusChange(tx, {
    client: input.client,
    document: {
      documentClass: JOURNAL_DOCUMENT_CLASS,
      documentKey: input.documentNumber,
    },
    previousStatus: 'POSTED',
    newStatus: 'REVERSED',
    reason: input.reason,
    changedBy: input.reversedBy,
  });

  await recordChange(tx, {
    client: input.client,
    objectClass: JOURNAL_DOCUMENT_CLASS,
    objectKey: `${input.documentNumber}/${input.fiscalYear}`,
    changeType: 'REVERSE',
    changedBy: input.reversedBy,
    transactionCode: input.transactionCode,
    reason: input.reason,
    before: { status: 'POSTED', reversedBy: null },
    after: { status: 'REVERSED', reversedBy: reversal.documentNumber },
  });

  return reversal;
}

/* ── Validation helpers ──────────────────────────────────────────────────── */

function assertLinesPresent(lines: PostingLineInput[]) {
  if (!lines || lines.length === 0) {
    throw new PostingError(
      'The document has no line items.',
      'Enter at least two lines — a debit and a credit — before posting.',
    );
  }
  if (lines.length === 1) {
    throw new PostingError(
      'A document must have at least two line items.',
      'A single-line entry cannot balance. Add the corresponding debit or credit.',
    );
  }
}

function assertPositiveAmounts(lines: PostingLineInput[]) {
  lines.forEach((line, index) => {
    const scaled = toScaled(line.amount);
    if (scaled === 0n) {
      throw new PostingError(
        `Line ${index + 1} has a zero amount.`,
        'Zero-value lines are not posted. Remove the line or enter an amount.',
      );
    }
    if (scaled < 0n) {
      throw new PostingError(
        `Line ${index + 1} has a negative amount (${line.amount}).`,
        'Enter a positive amount and set the line to debit or credit. ' +
          'The direction belongs in the debit/credit indicator, not in the sign.',
      );
    }
  });
}

function assertAccountsPresent(lines: PostingLineInput[]) {
  lines.forEach((line, index) => {
    if (!line.glAccount || line.glAccount.trim() === '') {
      throw new PostingError(
        `Line ${index + 1} has no G/L account.`,
        'Every line must carry an account. Use the account search to find the right one.',
      );
    }
  });
}

export function computeTotals(lines: PostingLineInput[]) {
  const debit = lines
    .filter((line) => line.debitCredit === 'S')
    .reduce((total, line) => total + toScaled(line.amount), 0n);
  const credit = lines
    .filter((line) => line.debitCredit === 'H')
    .reduce((total, line) => total + toScaled(line.amount), 0n);
  return { debit: fromScaled(debit), credit: fromScaled(credit) };
}

function assertBalanced(totals: { debit: string; credit: string }) {
  const debit = toScaled(totals.debit);
  const credit = toScaled(totals.credit);
  if (debit !== credit) {
    const difference = fromScaled(debit > credit ? debit - credit : credit - debit);
    throw new PostingError(
      `The document does not balance. Debits ${totals.debit}, credits ${totals.credit}, ` +
        `difference ${difference}.`,
      'Correct the amounts so that total debits equal total credits, then post again.',
    );
  }
}

/**
 * Phase 3b · Posting period control — CAIRN.md §14.3.
 *
 * The seam that was a documented pass-through in M1a is now real. It reads the
 * company code's fiscal year variant and posting period variant and refuses
 * posting to a closed period.
 *
 * Account types are collected across the whole document so one call reports every
 * problem at once: a vendor line in a closed vendor period and a GL line in an
 * open one should produce one clear message, not a partially validated document.
 *
 * Account type per line comes from the account's reconciliation type:
 *   VENDOR -> K, CUSTOMER -> D, ASSET -> A, MATERIAL -> M, otherwise S.
 */
async function assertPostingPeriodOpen(tx: Tx, input: PostJournalInput): Promise<void> {
  const company = await getCompanyCode(tx, input.client, input.companyCode);
  if (!company) {
    throw new PostingError(
      `Company code ${input.companyCode} is not configured.`,
      'Create it in Company Codes (CFG.ORG.COMPANYCODE.DEFINE) before posting.',
    );
  }

  const position = await derivePosition(
    tx,
    input.client,
    company.fiscalYearVariant,
    input.postingDate,
  );

  // The document's own fiscal year and period must agree with the derived ones.
  // Disagreement means someone typed a period that does not match the date, and
  // letting that through would corrupt every period-based report.
  if (position.fiscalYear !== input.fiscalYear) {
    throw new PostingError(
      `Posting date ${input.postingDate} belongs to fiscal year ${position.fiscalYear}, ` +
        `not ${input.fiscalYear}.`,
      'Correct the fiscal year or the posting date so that they agree.',
    );
  }
  if (position.period !== input.postingPeriod) {
    throw new PostingError(
      `Posting date ${input.postingDate} belongs to period ${position.period}, ` +
        `but the document specifies period ${input.postingPeriod}.`,
      'Correct the posting period or the posting date so that they agree.',
    );
  }

  const accountTypes = new Set<AccountType>();
  for (const line of input.lines) {
    accountTypes.add(await accountTypeFor(tx, input.client, line.glAccount));
  }

  for (const accountType of accountTypes) {
    const verdict = await checkPostingAllowed(
      tx,
      input.client,
      company.postingPeriodVariant,
      accountType,
      position,
    );
    if (!verdict.allowed) {
      throw new PostingError(verdict.reason!, verdict.remedy!);
    }
  }
}

/** Classify a G/L account into the account type that period control applies to. */
async function accountTypeFor(
  tx: Tx,
  client: string,
  accountNumber: string,
): Promise<AccountType> {
  const rows = await tx
    .select({
      reconciliationType: glAccount.reconciliationType,
      accountType: glAccount.accountType,
    })
    .from(glAccount)
    .where(and(eq(glAccount.client, client), eq(glAccount.accountNumber, accountNumber)))
    .limit(1);

  if (rows.length === 0) {
    throw new PostingError(
      `G/L account ${accountNumber} does not exist in this chart of accounts.`,
      'Create it in G/L Account Master (FIN.GL.MASTER.CREATE) or correct the account number.',
    );
  }

  switch (rows[0].reconciliationType) {
    case 'VENDOR':
      return 'K';
    case 'CUSTOMER':
      return 'D';
    case 'ASSET':
      return 'A';
    case 'MATERIAL':
      return 'M';
    default:
      return 'S';
  }
}

export class PostingError extends Error {
  readonly code = 'CAIRN_POSTING';
  constructor(message: string, readonly remedy: string) {
    super(message);
    this.name = 'PostingError';
  }
}
