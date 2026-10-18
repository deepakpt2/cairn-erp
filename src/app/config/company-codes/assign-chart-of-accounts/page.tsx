import Link from 'next/link';
import { asc, eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { chartOfAccounts as chartOfAccountsTable, companyCode } from '@/modules/foundation/schema';
import { CoaAssignmentForm } from './CoaAssignmentForm';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/company-codes/assign-chart-of-accounts';
const ACTIVITY = 'CFG.ORG.COMPANYCODE.ASSIGN_COA';

/**
 * Assign chart of accounts to company code — the dedicated screen.
 *
 * The act is SCR-013's, separated from Company Code definition by its
 * own capability; until now it lived only as a per-row control inside
 * the Company Codes table, invisible once a chart stood assigned and
 * unfindable by search. This screen names every company and the chart
 * it holds, offers only active unblocked charts, and requires a reason
 * that stands on the change document. Initial assignment only: a
 * different chart cannot replace a standing one, and repeating the
 * standing chart changes nothing.
 */
export default async function AssignChartOfAccountsPage() {
  const session = await requireSession(ROUTE);
  const client = session.user.client;
  const canAssign = can(session, ACTIVITY);

  const companies = await withTenant(client, (tx) => tx
    .select({
      code: companyCode.companyCode,
      name: companyCode.name,
      chartOfAccounts: companyCode.chartOfAccounts,
    })
    .from(companyCode)
    .where(eq(companyCode.client, client))
    .orderBy(asc(companyCode.companyCode)));

  // Only active, unblocked charts may be assigned.
  const assignable = await withTenant(client, async (tx) => {
    const rows = await tx
      .select({
        code: chartOfAccountsTable.chartOfAccounts,
        name: chartOfAccountsTable.name,
        isActive: chartOfAccountsTable.isActive,
        isBlocked: chartOfAccountsTable.isBlocked,
      })
      .from(chartOfAccountsTable)
      .where(eq(chartOfAccountsTable.client, client))
      .orderBy(asc(chartOfAccountsTable.chartOfAccounts));
    return rows.filter((r) => r.isActive && !r.isBlocked).map(({ code, name }) => ({ code, name }));
  });

  const companyRows = companies.map((c) => ({
    code: c.code.trim(),
    name: c.name.trim(),
    chartOfAccounts: c.chartOfAccounts?.trim() ?? null,
  }));

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('coaAssign.title')}</h1>
          <div className="flex gap-2">
            <Link href="/config/company-codes" className="btn btn-default min-h-11 sm:min-h-8">
              {t('coaAssign.backToCompanyCodes')}
            </Link>
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">
              {t('nav.workbench')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('coaAssign.subtitle')}</p>
      </header>

      {!canAssign && (
        <p role="status" className="rounded-card border border-line bg-surface p-4 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      {canAssign && assignable.length === 0 && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('cc.noActiveCharts')}
        </p>
      )}

      <section aria-labelledby="coa-assign" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="coa-assign" className="text-sm font-semibold">{t('coaAssign.assignHeading')}</h2>
        <div className="mt-3">
          {canAssign ? (
            <CoaAssignmentForm companies={companyRows} charts={assignable} />
          ) : (
            <p className="text-sm text-ink-soft">{t('coaAssign.readOnlyNote')}</p>
          )}
        </div>
      </section>

      <section aria-labelledby="coa-standing" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="coa-standing" className="text-sm font-semibold">{t('coaAssign.standingHeading')}</h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-ink-faint">
              <th className="py-1 pr-3">{t('cc.code')}</th>
              <th className="py-1 pr-3">{t('cc.name')}</th>
              <th className="py-1 pr-3">{t('cc.coa')}</th>
            </tr>
          </thead>
          <tbody>
            {companyRows.map((c) => (
              <tr key={c.code} className="border-b border-line/60">
                <td className="code py-1 pr-3 font-semibold">{c.code}</td>
                <td className="py-1 pr-3">{c.name}</td>
                <td className="code py-1 pr-3">{c.chartOfAccounts ?? t('cc.unassigned')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-sm text-ink-soft">{t('cc.initialCoaNote')}</p>
      </section>
    </div>
  );
}
