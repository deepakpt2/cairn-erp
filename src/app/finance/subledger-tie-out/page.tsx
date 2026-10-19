import { can, requireSession } from '@/platform/auth/current';
import { listCompanyCodes } from '@/modules/foundation/services';
import {
  SUBLEDGER_TIE_CAPABILITY, TIE_LEDGER, type SubledgerTieSelection,
} from '@/modules/finance/subledger-tie-out';
import SubledgerTieShell from './SubledgerTieShell';

export const dynamic = 'force-dynamic';

export default async function SubledgerTiePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireSession();
  const params = await searchParams;
  const get = (name: string, fallback = '') =>
    (typeof params[name] === 'string' ? (params[name] as string) : fallback).trim();
  const companies = (await listCompanyCodes(session.user.client)).map((c) => ({
    companyCode: c.companyCode, currency: c.currency,
  }));
  const initialSelection: SubledgerTieSelection = {
    companyCode: get('companyCode') || companies[0]?.companyCode || '',
    fiscalYear: Number(get('fiscalYear', String(new Date().getFullYear()))) || new Date().getFullYear(),
    periodTo: Number(get('periodTo', '12')) || 12,
    ledger: (get('ledger', TIE_LEDGER) || TIE_LEDGER).toUpperCase(),
    accountFrom: get('accountFrom'),
    accountTo: get('accountTo'),
  };

  return (
    <SubledgerTieShell
      canUse={can(session, `${SUBLEDGER_TIE_CAPABILITY}.read`)}
      companies={companies}
      selection={initialSelection}
      result={null}
    />
  );
}
