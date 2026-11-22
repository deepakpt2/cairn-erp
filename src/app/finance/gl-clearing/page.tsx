import { can, requireSession } from '@/platform/auth/current';
import {
  GL_CLEARING_CAPABILITY, GlClearingError, getGlClearing, type GlClearingView,
} from '@/modules/finance/gl-clearing';
import {
  BANK_STATEMENT_DISPLAY_CAPABILITY,
  BANK_STATEMENT_ENTER_CAPABILITY,
  BANK_STATEMENT_FINALIZE_CAPABILITY,
  BANK_STATEMENT_MATCH_CAPABILITY,
  BankReconciliationError,
  getBankReconciliation,
  listReconcilableBankAccounts,
  type BankAccountChoice,
  type BankReconciliationView,
} from '@/modules/finance/bank-reconciliation';
import GlClearing from './GlClearing';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/gl-clearing';

/**
 * Clear G/L account (SCR-114 / F-03 as a search alias only) and the separate
 * Bank reconciliation mode added for manual bank statement reconciliation.
 */
export default async function GlClearingPage({ searchParams }: {
  searchParams: Promise<{
    mode?: string; companyCode?: string; glAccount?: string; documentNumber?: string; assignment?: string; reference?: string;
    houseBankKey?: string; accountId?: string; statement?: string;
  }>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const mode = params.mode === 'bank' ? 'bank' : 'gl';
  const authorization = { userId: session.user.userId, sessionId: session.sessionId ?? '' };

  const canBankView = can(session, BANK_STATEMENT_DISPLAY_CAPABILITY)
    || can(session, BANK_STATEMENT_ENTER_CAPABILITY)
    || can(session, BANK_STATEMENT_MATCH_CAPABILITY)
    || can(session, BANK_STATEMENT_FINALIZE_CAPABILITY);

  let view: GlClearingView | null = null;
  let loadError: string | null = null;
  if (mode === 'gl' && params.companyCode && params.glAccount) {
    try {
      view = await getGlClearing({
        client, companyCode: params.companyCode, glAccount: params.glAccount.toUpperCase(),
        filters: {
          documentNumber: params.documentNumber || undefined,
          assignment: params.assignment || undefined,
          reference: params.reference || undefined,
        },
      });
    } catch (error) {
      if (error instanceof GlClearingError) loadError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
      else throw error;
    }
  }

  let bankView: BankReconciliationView | null = null;
  let bankError: string | null = null;
  let bankAccounts: BankAccountChoice[] = [];
  if (mode === 'bank') {
    if (!canBankView) {
      bankError = 'You do not hold a bank reconciliation capability. Ask an administrator to grant bank statement display access.';
    } else {
      try {
        bankAccounts = await listReconcilableBankAccounts({ client, authorization });
      } catch (error) {
        if (error instanceof BankReconciliationError) bankError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
        else throw error;
      }
      if (params.companyCode && params.houseBankKey && params.accountId) {
        try {
          bankView = await getBankReconciliation({
            client,
            companyCode: params.companyCode,
            houseBankKey: params.houseBankKey.toUpperCase(),
            accountId: params.accountId.toUpperCase(),
            ...(params.statement ? { statementId: params.statement } : {}),
          }, { authorization });
        } catch (error) {
          if (error instanceof BankReconciliationError) bankError = error.remedy ? `${error.message} ${error.remedy}` : error.message;
          else throw error;
        }
      }
    }
  }

  const today = new Date().toISOString().slice(0, 10);

  return (
    <Page
      title={mode === 'bank' ? 'Bank Reconciliation' : 'Clear G/L Account'}
      code={mode === 'bank' ? 'FIN.BANK.STATEMENT' : 'FIN.GL.CLEAR · F-03'}
      description={mode === 'bank'
        ? 'Enter a bank statement by hand, match its transactions to the posted bank G/L, explain outstanding items and freeze a reviewed as-of reconciliation. Matching is evidence only: it posts no journal, clears no AR/AP item and marks no payment as executed. Amounts are debit-to-bank (money in positive, money out negative).'
        : 'Clear open items of an open-item-managed G/L account against each other — in full, partially (the item stays open for its balance), or residually (the item closes and its remainder re-stands as a new open item). The difference must stand at zero, or within the tolerance of the default group, before posting; cross-currency clearing translates at the clearing date and posts the realized exchange difference.'}
    >

      <GlClearing
        mode={mode}
        view={view}
        loadError={loadError}
        canClear={can(session, GL_CLEARING_CAPABILITY)}
        bankView={bankView}
        bankError={bankError}
        bankAccounts={bankAccounts}
        bankQuery={{
          companyCode: params.companyCode ?? '',
          houseBankKey: params.houseBankKey ?? '',
          accountId: params.accountId ?? '',
          statementId: params.statement ?? '',
        }}
        canBankView={canBankView}
        canBankEnter={can(session, BANK_STATEMENT_ENTER_CAPABILITY)}
        canBankMatch={can(session, BANK_STATEMENT_MATCH_CAPABILITY)}
        canBankFinalize={can(session, BANK_STATEMENT_FINALIZE_CAPABILITY)}
        today={today}
      />
    </Page>
  );
}
