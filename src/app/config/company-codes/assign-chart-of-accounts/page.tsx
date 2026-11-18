import { asc, eq } from 'drizzle-orm';

import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { chartOfAccounts as chartOfAccountsTable, companyCode } from '@/modules/foundation/schema';
import { CoaAssignmentForm } from './CoaAssignmentForm';
import { LinkButton, Page } from '@/ui/kit';

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
    <Page
      title={t('coaAssign.title')} code={ACTIVITY} back={null}
      description={t('coaAssign.subtitle')}
      actions={
        <>
          <LinkButton href="/config/company-codes">
                        {t('coaAssign.backToCompanyCodes')}
                      </LinkButton>
          <LinkButton href="/config">
                        {t('nav.workbench')}
                      </LinkButton>
        </>
      }
    >

      {!canAssign && (
        <p role="status" className="border border-line bg-surface p-4 text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ACTIVITY })}
        </p>
      )}

      {canAssign && assignable.length === 0 && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('cc.noActiveCharts')}
        </p>
      )}

      <section aria-labelledby="coa-assign" className="border border-line bg-surface p-4">
        <h2 id="coa-assign" className="text-sm font-semibold">{t('coaAssign.assignHeading')}</h2>
        <div className="mt-3">
          {canAssign ? (
            <CoaAssignmentForm companies={companyRows} charts={assignable} />
          ) : (
            <p className="text-sm text-ink-soft">{t('coaAssign.readOnlyNote')}</p>
          )}
        </div>
      </section>

      <section aria-labelledby="coa-standing" className="border border-line bg-surface p-4">
        <h2 id="coa-standing" className="text-sm font-semibold">{t('coaAssign.standingHeading')}</h2>
        <table className="grid-table mt-3 text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-ink-faint">
              <th>{t('cc.code')}</th>
              <th>{t('cc.name')}</th>
              <th>{t('cc.coa')}</th>
            </tr>
          </thead>
          <tbody>
            {companyRows.map((c) => (
              <tr key={c.code}>
                <td className="code font-semibold">{c.code}</td>
                <td>{c.name}</td>
                <td className="code">{c.chartOfAccounts ?? t('cc.unassigned')}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-2 text-sm text-ink-soft">{t('cc.initialCoaNote')}</p>
      </section>
    </Page>
  );
}
