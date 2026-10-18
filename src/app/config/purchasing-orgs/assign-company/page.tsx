import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { companyCode, purchasingOrg } from '@/modules/foundation/schema';
import { PurchasingOrgCompanyCodeAssignmentForm } from './PurchasingOrgCompanyCodeAssignmentForm';

export const dynamic = 'force-dynamic';

const ASSIGNMENT = 'CFG.PROC.PURORG.ASSIGN_COMPANY';

/** Separate SCR-018 assignment activity; OX08 remains code/name definition only. */
export default async function AssignPurchasingOrgCompanyCodePage() {
  const session = await requireSession('/config/purchasing-orgs/assign-company');
  const client = session.user.client;
  const canAssign = can(session, ASSIGNMENT);

  const organisations = await withTenant(client, (tx) =>
    tx
      .select({
        purchasingOrg: purchasingOrg.purchasingOrg,
        name: purchasingOrg.name,
        companyCode: purchasingOrg.companyCode,
        isActive: purchasingOrg.isActive,
      })
      .from(purchasingOrg)
      .where(eq(purchasingOrg.client, client))
      .orderBy(asc(purchasingOrg.purchasingOrg)),
  );

  const hasEligibleOrganisations = organisations.some((item) => item.isActive && item.companyCode === null);
  // Do not expose Company Code choices to a user without the exact assignment capability.
  const companyCodes = canAssign && hasEligibleOrganisations
    ? await withTenant(client, (tx) =>
        tx
          .select({ code: companyCode.companyCode, name: companyCode.name })
          .from(companyCode)
          .where(and(eq(companyCode.client, client), eq(companyCode.isActive, true)))
          .orderBy(asc(companyCode.companyCode)),
      )
    : [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <span className="code text-ink-faint">{ASSIGNMENT}</span>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight">
              {t('purchasingOrg.companyAssignmentTitle')}
            </h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default">{t('nav.workbench')}</Link>
            <Link href="/config/purchasing-orgs" className="btn btn-default">
              {t('purchasingOrg.backToDefinitions')}
            </Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          {t('purchasingOrg.companyAssignmentSubtitle')}
        </p>
        <p className="mt-2 max-w-3xl text-xs text-ink-soft">
          {t('purchasingOrg.companyAssignmentInitialOnly')}
        </p>
      </header>

      {!canAssign && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: ASSIGNMENT })}
        </p>
      )}

      {canAssign && hasEligibleOrganisations && companyCodes.length === 0 && (
        <p role="status" className="border border-signal-warn/30 bg-signal-warn-soft p-3 text-sm text-signal-warn">
          {t('purchasingOrg.noActiveCompanyCodes')}
        </p>
      )}

      <section className="panel overflow-x-auto">
        <div className="panel-header">
          <h2 className="panel-title">{t('purchasingOrg.assignmentList')}</h2>
          <span className="text-2xs text-ink-faint tabular">{organisations.length}</span>
        </div>
        {organisations.length === 0 ? (
          <p className="p-4 text-sm text-ink-soft">{t('purchasingOrg.empty')}</p>
        ) : (
          <table className="grid-table">
            <thead>
              <tr>
                <th>{t('purchasingOrg.code')}</th>
                <th>{t('purchasingOrg.name')}</th>
                <th>{t('purchasingOrg.status')}</th>
                <th>{t('purchasingOrg.assignedCompanyCode')}</th>
                <th>{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {organisations.map((organisation) => {
                const canInitialAssign = canAssign && organisation.isActive && organisation.companyCode === null;
                return (
                  <tr key={organisation.purchasingOrg}>
                    <td className="code font-semibold">{organisation.purchasingOrg.trim()}</td>
                    <td>{organisation.name}</td>
                    <td>
                      <span className={`chip ${organisation.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                        {t(organisation.isActive ? 'purchasingOrg.active' : 'purchasingOrg.inactive')}
                      </span>
                    </td>
                    <td className="code">
                      {organisation.companyCode?.trim() || t('purchasingOrg.unassigned')}
                    </td>
                    <td className="min-w-80">
                      {canInitialAssign ? (
                        <PurchasingOrgCompanyCodeAssignmentForm
                          purchasingOrg={organisation.purchasingOrg.trim()}
                          companyCodes={companyCodes.map(({ code, name }) => ({ code: code.trim(), name }))}
                        />
                      ) : (
                        <Link
                          className="text-accent underline"
                          href={`/config/purchasing-orgs?purchasingOrg=${encodeURIComponent(organisation.purchasingOrg.trim())}`}
                        >
                          {t('purchasingOrg.open')}
                        </Link>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-soft">
          {t('purchasingOrg.companyAssignmentRetentionNote')}
        </p>
      </section>
    </div>
  );
}
