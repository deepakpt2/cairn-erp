
import { can, requireSession } from '@/platform/auth/current';
import { loadOrgRestrictions } from '@/platform/auth/session';
import { withTenant } from '@/platform/db/client';
import {
  CREDIT_CONTROL_AREA_CAPABILITY,
  CREDIT_CONTROL_AREA_DEFAULTS,
  filterCreditControlAreaSetupByCompanyScope,
  listCreditControlAreaSetup,
} from '@/modules/finance/credit-control-area-maintenance';
import { CreditControlAreaSetup } from './CreditControlAreaSetup';
import { Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = '/config/credit-control-areas';

export default async function CreditControlAreasPage() {
  const session = await requireSession(ROUTE);
  const [allData, restrictions] = await Promise.all([
    listCreditControlAreaSetup(session.user.client),
    withTenant(session.user.client, (tx) => loadOrgRestrictions(tx, session.user.client, session.user.userId)),
  ]);
  const data = filterCreditControlAreaSetupByCompanyScope(allData, restrictions);
  const hasCompanyScope = restrictions.some(
    (restriction) => restriction.scopeType === 'COMPANY_CODE' && restriction.scopeValue.trim().length > 0,
  );
  const canMaintain = can(session, CREDIT_CONTROL_AREA_CAPABILITY);

  return (
    <Page
      title="Credit control area setup" code={<>{CREDIT_CONTROL_AREA_CAPABILITY} · FIN</>}
      description={
        <>
          <p className="max-w-3xl text-sm text-ink-soft">
              Create a credit control area and make its first assignment to an active, unassigned Company Code.
              Currency follows the Company Code. Existing CCA settings and assignments are read-only here; this
              workflow does not replace, deactivate or repair financial configuration.
            </p>
          {!canMaintain && (
              <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
                Read-only. Maintenance requires an explicit exact-code role grant for {CREDIT_CONTROL_AREA_CAPABILITY};
                broad wildcard role patterns do not grant it.
              </p>
            )}
          {canMaintain && !hasCompanyScope && (
              <p role="status" className="mt-3 border border-line bg-surface p-3 text-sm text-ink-soft">
                Read-only. CCA maintenance also requires an explicit Company Code scope assigned through user access.
              </p>
            )}
        </>
      }
    >

      <section aria-labelledby="cca-records" className="border border-line bg-surface p-4">
        <h2 id="cca-records" className="text-sm font-semibold">Credit control areas</h2>
        {data.areas.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">No credit control areas are defined for this tenant.</p>
        ) : (
          <div className="mt-3 overflow-x-auto">
            <table className="grid-table text-left text-sm">
              <thead>
                <tr className="text-xs uppercase tracking-wide text-ink-faint">
                  <th>Area</th>
                  <th>Name</th>
                  <th>Currency</th>
                  <th>Warning</th>
                  <th>Status</th>
                  <th>Company Codes</th>
                </tr>
              </thead>
              <tbody>
                {data.areas.map((area) => {
                  const mapped = data.companies.filter((company) => company.creditControlArea === area.creditControlArea);
                  return (
                    <tr key={area.creditControlArea}>
                      <td className="font-mono">{area.creditControlArea}</td>
                      <td>{area.name}</td>
                      <td>{area.currency}</td>
                      <td>{area.warningThresholdPercent}%</td>
                      <td>{area.isActive ? 'Active' : 'Inactive'}</td>
                      <td>{mapped.length ? mapped.map((company) => company.companyCode).join(', ') : '—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canMaintain && hasCompanyScope && (
        <CreditControlAreaSetup
          companies={data.availableCompanies}
          defaults={CREDIT_CONTROL_AREA_DEFAULTS}
        />
      )}
    </Page>
  );
}
