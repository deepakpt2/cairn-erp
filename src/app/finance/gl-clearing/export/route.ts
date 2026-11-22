import { can, requireSession } from '@/platform/auth/current';
import {
  BANK_STATEMENT_DISPLAY_CAPABILITY,
  BANK_STATEMENT_ENTER_CAPABILITY,
  BANK_STATEMENT_FINALIZE_CAPABILITY,
  BANK_STATEMENT_MATCH_CAPABILITY,
  BankReconciliationError,
  bankReconciliationCsv,
} from '@/modules/finance/bank-reconciliation';

const ROUTE = '/finance/gl-clearing';

/**
 * CSV evidence for one bank reconciliation. The download re-checks the live
 * session, capability and Company Code scope through the same service as the
 * screen; a forged company/account/statement id cannot read another tenant or
 * company's figures.
 */
export async function GET(request: Request) {
  const session = await requireSession(ROUTE);
  const mayRead = can(session, BANK_STATEMENT_DISPLAY_CAPABILITY)
    || can(session, BANK_STATEMENT_ENTER_CAPABILITY)
    || can(session, BANK_STATEMENT_MATCH_CAPABILITY)
    || can(session, BANK_STATEMENT_FINALIZE_CAPABILITY);
  if (!mayRead) {
    return new Response('You do not hold a bank reconciliation capability.', { status: 403 });
  }
  const q = new URL(request.url).searchParams;
  const companyCode = q.get('companyCode')?.trim() ?? '';
  const houseBankKey = q.get('houseBankKey')?.trim().toUpperCase() ?? '';
  const accountId = q.get('accountId')?.trim().toUpperCase() ?? '';
  const statementId = q.get('statement')?.trim() ?? '';
  if (!companyCode || !houseBankKey || !accountId || !statementId) {
    return new Response('Company, house bank, account and statement are required.', { status: 400 });
  }
  try {
    const csv = await bankReconciliationCsv(
      { client: session.user.client, companyCode, houseBankKey, accountId, statementId },
      { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
    );
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="bank-reconciliation-${statementId}.csv"`,
        'cache-control': 'no-store',
      },
    });
  } catch (error) {
    if (error instanceof BankReconciliationError) {
      // The same answer for absent, out-of-scope and malformed selections: no figure and no existence leak.
      return new Response('The bank reconciliation is not available for this selection.', { status: 404 });
    }
    throw error;
  }
}
