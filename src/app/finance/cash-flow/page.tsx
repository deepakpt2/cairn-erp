import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import {
  CASHFLOW_CAPABILITY, CASHFLOW_LEDGER,
  type CashflowResult, type CashflowSelection,
} from '@/modules/finance/cash-flow-vocabulary';
import { CashflowError, calculateCashflow } from '@/modules/finance/cash-flow';
import CashflowShell from './CashflowShell';
import { ReportExport } from '@/ui/output/ReportExport';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/finance/cash-flow';

export default async function CashflowPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession(ROUTE);
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();

  const companies = (await listCompanyCodes(session.user.client)).map((c) => ({
    companyCode: c.companyCode, name: c.name, currency: c.currency,
  }));
  const requested = get('companies')
    .split(',').map((code) => code.trim().toUpperCase()).filter(Boolean);
  const selection: CashflowSelection = {
    companyCodes: requested.length > 0 ? requested : companies.slice(0, 1).map((c) => c.companyCode),
    fiscalYear: Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear(),
    periodFrom: Number(get('periodFrom', '1')) || 1,
    periodTo: Number(get('periodTo', '12')) || 12,
    method: get('method').toUpperCase() === 'DIRECT' ? 'DIRECT' : 'INDIRECT',
    ledger: CASHFLOW_LEDGER,
    comparative: get('comparative') === '1',
  };

  const canUse = can(session, CASHFLOW_CAPABILITY) || can(session, `${CASHFLOW_CAPABILITY}.read`);
  let result: CashflowResult | null = null;
  let reportError: string | null = null;
  if (canUse && get('companies')) {
    try {
      result = await calculateCashflow({ client: session.user.client, selection });
    } catch (error) {
      reportError = error instanceof CashflowError
        ? (error.remedy ? `${error.message} ${error.remedy}` : error.message)
        : 'The cash flow statement could not be calculated.';
    }
  }

  return (
    <Page
      title="Cash Flow Statement" code="FIN.RPT.CASHFLOW · S_ALR_87012271/72/73" width="7xl" back={null}
      description="Operating, investing and financing cash flows from the posted journal, reconciled to the movement on the house-bank cash accounts."
    >
      {result && <div><ReportExport report="cash-flow" params={params} /></div>}
      <CashflowShell
        canUse={canUse}
        companies={companies}
        selection={selection}
        result={result}
        reportError={reportError}
      />
    </Page>
  );
}
