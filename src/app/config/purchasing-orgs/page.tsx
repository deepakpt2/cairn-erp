import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { changeHistory } from '@/platform/change';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { t } from '@/platform/i18n';
import { getPurchasingOrgDefinitionVersion } from '@/modules/foundation/purchasing-org-maintenance';
import { purchasingOrg as purchasingOrgTable, purchasingOrgPlant as purchasingOrgPlantTable } from '@/modules/foundation/schema';
import { DeactivatePurchasingOrgForm } from './DeactivatePurchasingOrgForm';
import { PurchasingOrgDefinitionForm, type PurchasingOrgDefinitionDraft } from './PurchasingOrgDefinitionForm';

export const dynamic = 'force-dynamic';

const PURCHASING_ORG_DEFINE = 'CFG.PROC.PURORG.DEFINE';

type PageParams = {
  new?: string;
  edit?: string;
  purchasingOrg?: string;
  history?: string;
};

function detailHref(code: string) {
  return `/config/purchasing-orgs?purchasingOrg=${encodeURIComponent(code)}`;
}

function editHref(code: string) {
  return `/config/purchasing-orgs?edit=${encodeURIComponent(code)}`;
}

/** OX08 defines only code/name. Company Code and Plant assignments remain separate activities. */
export default async function PurchasingOrgsPage({
  searchParams,
}: {
  searchParams: Promise<PageParams>;
}) {
  const params = await searchParams;
  const session = await requireSession('/config/purchasing-orgs');
  // Tenant scope is always taken from the verified session, never from request parameters.
  const client = session.user.client;
  const canMaintain = can(session, PURCHASING_ORG_DEFINE);

  const organisations = await withTenant(client, async (tx) =>
    tx
      .select()
      .from(purchasingOrgTable)
      .where(eq(purchasingOrgTable.client, client))
      .orderBy(asc(purchasingOrgTable.purchasingOrg)),
  );

  const selectionRequested = Boolean(params.edit || params.purchasingOrg);
  const requestedCode = (params.edit ?? params.purchasingOrg)?.trim().toUpperCase() ?? '';
  const selected = selectionRequested
    ? organisations.find((item) => item.purchasingOrg === requestedCode)
    : undefined;
  const creating = params.new === '1' && !selectionRequested && canMaintain;
  const editing = Boolean(params.edit && selected && canMaintain);

  const version = canMaintain && selected
    ? await getPurchasingOrgDefinitionVersion(client, selected.purchasingOrg)
    : 0;
  const plantAssignments = selected
    ? await withTenant(client, async (tx) => {
        const rows = await tx
          .select({ plant: purchasingOrgPlantTable.plant })
          .from(purchasingOrgPlantTable)
          .where(and(
            eq(purchasingOrgPlantTable.client, client),
            eq(purchasingOrgPlantTable.purchasingOrg, selected.purchasingOrg),
          ))
          .orderBy(asc(purchasingOrgPlantTable.plant));
        return rows.map((row) => row.plant.trim());
      })
    : [];
  const history = selected && params.history === '1'
    ? await withTenant(client, (tx) =>
        changeHistory(tx, client, 'purchasing_org', selected.purchasingOrg),
      )
    : [];

  const emptyDraft: PurchasingOrgDefinitionDraft = { purchasingOrg: '', name: '' };
  const selectedDraft: PurchasingOrgDefinitionDraft | undefined = selected
    ? { purchasingOrg: selected.purchasingOrg.trim(), name: selected.name }
    : undefined;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{PURCHASING_ORG_DEFINE}</span>
        <div className="mt-0.5 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('purchasingOrg.title')}</h1>
          <div className="flex flex-wrap gap-2">
            <Link href="/config" className="btn btn-default">{t('nav.workbench')}</Link>
            {canMaintain && (
              <Link href="/config/purchasing-orgs?new=1" className="btn btn-primary">
                {t('purchasingOrg.create')}
              </Link>
            )}
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('purchasingOrg.subtitle')}</p>
        <p className="mt-2 max-w-3xl text-xs text-ink-soft">{t('purchasingOrg.assignmentSeparationNote')}</p>
      </header>

      {!canMaintain && (
        <p role="status" className="text-sm text-ink-soft">
          {t('auth.readOnly', { authority: PURCHASING_ORG_DEFINE })}
        </p>
      )}

      {creating && (
        <PurchasingOrgDefinitionForm
          key="CREATE:new"
          mode="CREATE"
          initial={emptyDraft}
          version={0}
        />
      )}
      {editing && selectedDraft && (
        <PurchasingOrgDefinitionForm
          key={`CHANGE:${selectedDraft.purchasingOrg}`}
          mode="CHANGE"
          initial={selectedDraft}
          version={version}
        />
      )}

      {selectionRequested && !selected && (
        <section className="panel p-4">
          <p role="status" className="text-sm text-signal-error">{t('purchasingOrg.notFound')}</p>
          <Link className="mt-2 inline-block text-sm text-accent underline" href="/config/purchasing-orgs">
            {t('purchasingOrg.backToList')}
          </Link>
        </section>
      )}

      {selected && !editing && (
        <section className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="panel-title">
                {t('purchasingOrg.detail')} · <span className="code">{selected.purchasingOrg.trim()}</span>
              </h2>
              <p className="mt-1 text-sm text-ink-soft">{selected.name}</p>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link className="text-accent underline" href="/config/purchasing-orgs">
                {t('purchasingOrg.backToList')}
              </Link>
              {canMaintain && (
                <Link className="text-accent underline" href={editHref(selected.purchasingOrg)}>
                  {t('common.change')}
                </Link>
              )}
              <Link className="text-accent underline" href={`${detailHref(selected.purchasingOrg)}&history=1`}>
                {t('purchasingOrg.history')}
              </Link>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="field-label">{t('purchasingOrg.name')}</dt><dd>{selected.name}</dd></div>
            <div>
              <dt className="field-label">{t('purchasingOrg.status')}</dt>
              <dd>
                <span className={`chip ${selected.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                  {t(selected.isActive ? 'purchasingOrg.active' : 'purchasingOrg.inactive')}
                </span>
              </dd>
            </div>
            <div><dt className="field-label">{t('purchasingOrg.assignedCompanyCode')}</dt><dd className="code">{selected.companyCode?.trim() || t('purchasingOrg.unassigned')}</dd></div>
            {canMaintain && <div><dt className="field-label">{t('purchasingOrg.version')}</dt><dd className="tabular">{version}</dd></div>}
          </dl>
          <div className="mt-4 grid gap-3 border-t border-line pt-3 sm:grid-cols-2">
            <div>
              <h3 className="field-label">{t('purchasingOrg.plantAssignments')}</h3>
              {plantAssignments.length ? (
                <ul className="mt-1 flex flex-wrap gap-2">
                  {plantAssignments.map((plant) => <li key={plant} className="chip chip-neutral code">{plant}</li>)}
                </ul>
              ) : <p className="mt-1 text-sm text-ink-soft">{t('purchasingOrg.noPlantAssignments')}</p>}
              <p className="mt-2 text-xs text-ink-soft">{t('purchasingOrg.plantAssignmentReadOnlyNote')}</p>
            </div>
            <p className="text-sm text-ink-soft">{t('purchasingOrg.companyCodePrerequisite')}</p>
          </div>
          {!selected.isActive && <p className="mt-3 text-xs text-ink-soft">{t('purchasingOrg.inactiveRetained')}</p>}
        </section>
      )}

      {selected && !editing && canMaintain && (
        <DeactivatePurchasingOrgForm
          purchasingOrg={selected.purchasingOrg.trim()}
          name={selected.name}
          version={version}
          isActive={selected.isActive}
        />
      )}

      {selected && params.history === '1' && (
        <section className="panel overflow-x-auto">
          <div className="panel-header">
            <h2 className="panel-title">
              {t('purchasingOrg.history')} · <span className="code">{selected.purchasingOrg.trim()}</span>
            </h2>
          </div>
          {history.map((entry) => (
            <article key={entry.id} className="border-b border-line p-3 text-sm">
              <p className="font-medium">{entry.changedAt.toISOString()} · {entry.changedBy} · {entry.changeType}</p>
              {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
              <ul className="mt-1 text-2xs text-ink-soft">
                {entry.items.map((item) => (
                  <li key={item.id}>
                    {item.fieldLabel}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}
                    {item.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}
                  </li>
                ))}
              </ul>
            </article>
          ))}
          {!history.length && <p className="p-3 text-sm text-ink-soft">{t('purchasingOrg.noChanges')}</p>}
        </section>
      )}

      <section className="panel overflow-x-auto">
        <div className="panel-header">
          <h2 className="panel-title">{t('purchasingOrg.list')}</h2>
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
                <th>{t('purchasingOrg.assignedCompanyCode')}</th>
                <th>{t('purchasingOrg.status')}</th>
                <th className="text-end">{t('common.actions')}</th>
              </tr>
            </thead>
            <tbody>
              {organisations.map((organisation) => (
                <tr key={organisation.purchasingOrg}>
                  <td className="code font-semibold">{organisation.purchasingOrg.trim()}</td>
                  <td>{organisation.name}</td>
                  <td className="code">{organisation.companyCode?.trim() || t('purchasingOrg.unassigned')}</td>
                  <td>
                    <span className={`chip ${organisation.isActive ? 'chip-ok' : 'chip-neutral'}`}>
                      {t(organisation.isActive ? 'purchasingOrg.active' : 'purchasingOrg.inactive')}
                    </span>
                  </td>
                  <td className="text-end whitespace-nowrap">
                    <Link className="text-accent underline" href={detailHref(organisation.purchasingOrg)}>
                      {t('purchasingOrg.open')}
                    </Link>
                    {canMaintain && (
                      <Link className="ms-3 text-accent underline" href={editHref(organisation.purchasingOrg)}>
                        {t('common.change')}
                      </Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="border-t border-line px-4 py-3 text-xs text-ink-soft">{t('purchasingOrg.retentionNote')}</p>
      </section>
    </div>
  );
}
