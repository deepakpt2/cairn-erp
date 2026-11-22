'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  GL_CLEARING_CAPABILITY, GlClearingError, clearGlItems,
} from '@/modules/finance/gl-clearing';
import {
  BANK_STATEMENT_ENTER_CAPABILITY,
  BANK_STATEMENT_FINALIZE_CAPABILITY,
  BANK_STATEMENT_MATCH_CAPABILITY,
  BankReconciliationError,
  finalizeBankStatement,
  matchBankStatement,
  reopenBankStatement,
  saveBankStatement,
  unmatchBankStatement,
  type BankStatementLineInput,
} from '@/modules/finance/bank-reconciliation';

export interface GlClearingActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

export interface BankReconciliationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  statementId?: string;
}

const ROUTE = '/finance/gl-clearing';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): GlClearingActionState {
  if (error instanceof GlClearingError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function wrapBank(error: unknown): BankReconciliationActionState {
  if (error instanceof BankReconciliationError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

function authorityOf(session: Awaited<ReturnType<typeof requireSession>>) {
  return { userId: session.user.userId, sessionId: session.sessionId ?? '' };
}

export async function clearAction(
  _previous: GlClearingActionState,
  form: FormData,
): Promise<GlClearingActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, GL_CLEARING_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the G/L clearing capability.' };
  }
  try {
    await assertChangeForSession(session, {
      lockObject: 'GL_ACCOUNT',
      argument: `${text(form, 'companyCode')}/${text(form, 'glAccount')}`,
    });
    const items = form.getAll('item').map((value) => {
      const key = String(value);
      const [documentNumber, fiscalYear, lineNumber] = key.split('|');
      const settlement = text(form, `settlement:${key}`);
      return {
        documentNumber, fiscalYear: Number(fiscalYear), lineNumber: Number(lineNumber),
        ...(settlement ? { settlementAmount: settlement } : {}),
      };
    });
    const methodValue = text(form, 'method');
    const method = methodValue === 'PARTIAL' || methodValue === 'RESIDUAL' ? methodValue : 'STANDARD';
    const result = await clearGlItems({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'), glAccount: text(form, 'glAccount').toUpperCase(),
      documentType: text(form, 'documentType').toUpperCase(),
      clearingDate: text(form, 'clearingDate'), postingDate: text(form, 'postingDate'),
      documentDate: text(form, 'documentDate'),
      confirmed: text(form, 'confirmed') === 'yes',
      requestKey: text(form, 'requestKey'),
      items,
      method,
      ...(text(form, 'residualReasonCode') ? { residualReasonCode: text(form, 'residualReasonCode').toUpperCase() } : {}),
      crossCurrency: text(form, 'crossCurrency') === 'yes',
      inheritPaymentTerms: text(form, 'inheritPaymentTerms') === 'yes',
      inheritAssignment: text(form, 'inheritAssignment') === 'yes',
      ...(text(form, 'fxDifferenceAccount') ? { fxDifferenceAccount: text(form, 'fxDifferenceAccount').toUpperCase() } : {}),
      ...(text(form, 'exchangeRateSpreadTolerancePercent')
        ? { exchangeRateSpreadTolerancePercent: Number(text(form, 'exchangeRateSpreadTolerancePercent')) }
        : {}),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Clearing posted as document ${result.clearingDocumentNumber} (fiscal year ${result.clearingFiscalYear}): ${items.length} items settled on ${text(form, 'clearingDate')} by ${method.toLowerCase()} clearing`
        + (result.residualItems.length
          ? `, ${result.residualItems.length} residual item(s) re-stood (${result.residualItems.map((r) => `${r.amount} ${r.reasonCode}`).join(', ')}).`
          : method === 'PARTIAL'
            ? ', the short-settled items standing open.'
            : '.'),
    };
  } catch (error) {
    return wrap(error);
  }
}

function parseLines(raw: string): BankStatementLineInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw || '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.map((line) => {
    const row = line as Record<string, unknown>;
    return {
      ...(typeof row.lineId === 'string' && row.lineId.trim() ? { lineId: row.lineId.trim() } : {}),
      direction: row.direction === 'OUT' ? 'OUT' : 'IN',
      amount: String(row.amount ?? ''),
      valueDate: String(row.valueDate ?? ''),
      ...(row.transactionDate ? { transactionDate: String(row.transactionDate) } : {}),
      ...(row.bankReference ? { bankReference: String(row.bankReference) } : {}),
      ...(row.description ? { description: String(row.description) } : {}),
    };
  });
}

export async function saveBankStatementAction(
  _previous: BankReconciliationActionState,
  form: FormData,
): Promise<BankReconciliationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BANK_STATEMENT_ENTER_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the bank statement entry capability.' };
  }
  try {
    const lines = parseLines(text(form, 'lines'));
    if (lines.length === 0) {
      return { ok: false, message: 'A statement needs at least one line.', remedy: 'Add the statement lines, then save.' };
    }
    const result = await saveBankStatement({
      client: session.user.client,
      ...(text(form, 'statementId') ? { statementId: text(form, 'statementId') } : {}),
      companyCode: text(form, 'companyCode'),
      houseBankKey: text(form, 'houseBankKey').toUpperCase(),
      accountId: text(form, 'accountId').toUpperCase(),
      statementReference: text(form, 'statementReference'),
      fromDate: text(form, 'fromDate'),
      toDate: text(form, 'toDate'),
      currency: text(form, 'currency').toUpperCase(),
      openingBalance: text(form, 'openingBalance'),
      closingBalance: text(form, 'closingBalance'),
      baseline: text(form, 'baseline') === 'yes',
      baselineAmount: text(form, 'baselineAmount') || '0',
      ...(text(form, 'baselineReason') ? { baselineReason: text(form, 'baselineReason') } : {}),
      ...(text(form, 'requestKey') ? { requestKey: text(form, 'requestKey') } : {}),
      lines,
    }, { authorization: authorityOf(session) });
    revalidatePath(ROUTE);
    return {
      ok: true,
      statementId: result.statementId,
      message: result.arithmeticValid
        ? 'Statement saved; its opening balance and signed lines equal the closing balance.'
        : `Statement saved as a draft, but it does not add up yet (difference ${result.arithmeticDifference}). It cannot be finalized until it balances.`,
    };
  } catch (error) {
    return wrapBank(error);
  }
}

export async function matchBankStatementAction(
  _previous: BankReconciliationActionState,
  form: FormData,
): Promise<BankReconciliationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BANK_STATEMENT_MATCH_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the bank reconciliation matching capability.' };
  }
  try {
    let allocations: Array<{
      statementLineId: string; ledgerDocumentNumber: string; ledgerFiscalYear: number;
      ledgerLineNumber: number; amount: string;
    }>;
    try {
      allocations = JSON.parse(text(form, 'allocations') || '[]') as typeof allocations;
    } catch {
      return { ok: false, message: 'The allocation selection could not be read.', remedy: 'Reload the statement and try again.' };
    }
    const result = await matchBankStatement({
      client: session.user.client,
      statementId: text(form, 'statementId'),
      ...(text(form, 'requestKey') ? { requestKey: text(form, 'requestKey') } : {}),
      allocations: allocations.map((allocation) => ({
        statementLineId: String(allocation.statementLineId ?? ''),
        ledgerDocumentNumber: String(allocation.ledgerDocumentNumber ?? ''),
        ledgerFiscalYear: Number(allocation.ledgerFiscalYear),
        ledgerLineNumber: Number(allocation.ledgerLineNumber),
        amount: String(allocation.amount ?? ''),
      })),
    }, { authorization: authorityOf(session) });
    revalidatePath(ROUTE);
    return { ok: true, statementId: result.statementId, message: `Matched ${result.matchIds.length} allocation(s) as reconciliation evidence. No journal was posted and no AR/AP item was cleared.` };
  } catch (error) {
    return wrapBank(error);
  }
}

export async function unmatchBankStatementAction(
  _previous: BankReconciliationActionState,
  form: FormData,
): Promise<BankReconciliationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BANK_STATEMENT_MATCH_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the bank reconciliation matching capability.' };
  }
  try {
    const result = await unmatchBankStatement({
      client: session.user.client,
      matchId: text(form, 'matchId'),
      reason: text(form, 'reason'),
    }, { authorization: authorityOf(session) });
    revalidatePath(ROUTE);
    return { ok: true, statementId: result.statementId, message: 'Match withdrawn. The original allocation remains as history; no journal was changed.' };
  } catch (error) {
    return wrapBank(error);
  }
}

export async function finalizeBankStatementAction(
  _previous: BankReconciliationActionState,
  form: FormData,
): Promise<BankReconciliationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BANK_STATEMENT_FINALIZE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the bank reconciliation finalization capability.' };
  }
  try {
    const result = await finalizeBankStatement({
      client: session.user.client,
      statementId: text(form, 'statementId'),
      confirmed: text(form, 'confirmed') === 'yes',
    }, { authorization: authorityOf(session) });
    revalidatePath(ROUTE);
    return {
      ok: true,
      statementId: result.statementId,
      message: result.snapshotId
        ? `Reconciliation finalized and frozen as snapshot ${result.snapshotId}. Outstanding items remain open for later matching.`
        : 'The reconciliation already stands finalized.',
    };
  } catch (error) {
    return wrapBank(error);
  }
}

export async function reopenBankStatementAction(
  _previous: BankReconciliationActionState,
  form: FormData,
): Promise<BankReconciliationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, BANK_STATEMENT_FINALIZE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the bank reconciliation finalization capability.' };
  }
  try {
    const result = await reopenBankStatement({
      client: session.user.client,
      statementId: text(form, 'statementId'),
      reason: text(form, 'reason'),
    }, { authorization: authorityOf(session) });
    revalidatePath(ROUTE);
    return { ok: true, statementId: result.statementId, message: 'Statement reopened for correction. The previous snapshot stays as evidence; a new finalization appends another snapshot.' };
  } catch (error) {
    return wrapBank(error);
  }
}
