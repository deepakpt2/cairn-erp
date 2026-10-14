import Link from 'next/link';
import { and, asc, eq } from 'drizzle-orm';
import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import { changeHistory } from '@/platform/change';
import { t } from '@/platform/i18n';
import { division as divisionTable } from '@/modules/foundation/schema';
import { getDivisionDefinitionVersion } from '@/modules/foundation/distribution-channel-division-maintenance';
import { DeactivateDivisionForm } from './DeactivateDivisionForm';
import { DivisionDefinitionForm, type DivisionDraft } from './DivisionDefinitionForm';

export const dynamic = 'force-dynamic';
const ACTIVITY = 'CFG.ORG.DIVISION.DEFINE';
const ASSIGN_SALES_ORG = 'CFG.ORG.SALESORG.ASSIGN_DIVISION';
type PageParams = { new?: string; edit?: string; division?: string; history?: string; q?: string; copy?: string };

function detailHref(code: string) { return `/config/divisions?division=${encodeURIComponent(code)}`; }
function editHref(code: string) { return `/config/divisions?edit=${encodeURIComponent(code)}`; }
function copyHref(code: string) { return `/config/divisions?new=1&copy=${encodeURIComponent(code)}`; }

export default async function DivisionsPage({ searchParams }: { searchParams: Promise<PageParams> }) {
  const params = await searchParams;
  const session = await requireSession('/config/divisions');
  const client = session.user.client;
  const canMaintain = can(session, ACTIVITY);
  const canAssignSalesOrg = can(session, ASSIGN_SALES_ORG);
  const rows = await withTenant(client, (tx) => tx.select().from(divisionTable)
    .where(eq(divisionTable.client, client)).orderBy(asc(divisionTable.division)));
  const entries = rows.map((row) => ({ ...row, division: row.division.trim() }));

  const selectionRequested = Boolean(params.edit || params.division);
  const requestedCode = (params.edit ?? params.division)?.trim().toUpperCase() ?? '';
  const selected = selectionRequested ? entries.find((entry) => entry.division === requestedCode) : undefined;
  const copySource = !selectionRequested && params.copy
    ? entries.find((entry) => entry.division === params.copy?.trim().toUpperCase() && entry.isActive)
    : undefined;
  const creating = canMaintain && !selectionRequested && (params.new === '1' || Boolean(copySource));
  const editing = Boolean(params.edit && selected && canMaintain);
  const version = canMaintain && selected
    ? await getDivisionDefinitionVersion(client, selected.division)
    : 0;
  const initial: DivisionDraft = creating
    ? { division: '', name: copySource?.name ?? '' }
    : selected ? { division: selected.division, name: selected.name } : { division: '', name: '' };
  const history = selected && params.history === '1'
    ? await withTenant(client, (tx) => changeHistory(tx, client, 'division', selected.division))
    : [];
  const search = params.q?.trim().toLocaleLowerCase() ?? '';
  const visibleEntries = entries.filter((entry) => !search || `${entry.division} ${entry.name}`.toLocaleLowerCase().includes(search));

  return (
    <div className="mx-auto max-w-6xl space-y-4 px-3 py-4 sm:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{ACTIVITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">{t('division.title')}</h1>
          <div className="flex flex-wrap gap-2">
            {canAssignSalesOrg && <Link href="/config/sales-orgs/assign-division" className="btn btn-default min-h-11 sm:min-h-8">{t('salesOrgDivision.navLink')}</Link>}
            <Link href="/config" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.workbench')}</Link>
            {canMaintain && <Link href="/config/divisions?new=1" className="btn btn-primary min-h-11 sm:min-h-8">{t('orgDefinition.create')} · {t('division.singular')}</Link>}
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">{t('division.subtitle')}</p>
      </header>

      {!canMaintain && <p role="status" className="text-sm text-ink-soft">{t('auth.readOnly', { authority: ACTIVITY })}</p>}

      <section className="panel overflow-hidden">
        <div className="flex flex-wrap items-center gap-3 border-b border-line bg-sunken px-3 py-3 sm:px-4">
          <h2 className="min-w-0 flex-1 font-semibold">{t('division.title')}</h2>
          <form action="/config/divisions" className="flex w-full items-center gap-2 sm:w-auto">
            <input className="field-input h-11 min-w-0 flex-1 sm:h-8 sm:w-56 sm:flex-none" name="q" defaultValue={params.q ?? ''} placeholder={t('orgDefinition.searchPlaceholder')} aria-label={t('orgDefinition.searchPlaceholder')} />
            <button type="submit" className="btn btn-default h-11 shrink-0 sm:h-8">{t('orgDefinition.find')}</button>
          </form>
        </div>

        <div className="divide-y divide-line sm:hidden" role="list" aria-label={t('division.title')}>
          {visibleEntries.map((entry) => (
            <article key={entry.division} role="listitem" className="p-3">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link className="font-mono font-semibold text-accent underline" href={detailHref(entry.division)}>{entry.division}</Link>
                    <span className={`chip ${entry.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(entry.isActive ? 'orgDefinition.active' : 'orgDefinition.inactive')}</span>
                  </div>
                  <p className="mt-1 break-words text-sm font-medium">{entry.name}</p>
                </div>
                <div className="flex shrink-0 flex-col gap-2">
                  <Link className="inline-flex min-h-11 items-center justify-center rounded border border-line bg-white px-3 text-sm text-accent" href={detailHref(entry.division)}>{t('orgDefinition.open')}</Link>
                  {canMaintain && entry.isActive && <Link className="inline-flex min-h-11 items-center justify-center rounded border border-line bg-white px-3 text-sm text-accent" href={copyHref(entry.division)}>{t('orgDefinition.copy')}</Link>}
                </div>
              </div>
            </article>
          ))}
          {visibleEntries.length === 0 && <p role="status" className="px-4 py-8 text-center text-sm text-ink-soft">{search ? t('orgDefinition.noSearchResults') : t('division.empty')}</p>}
        </div>

        <div className="hidden overflow-x-auto sm:block">
          <table className="min-w-full border-collapse text-sm" aria-label={t('division.title')}>
            <thead className="bg-sunken text-ink-soft"><tr className="border-y border-line">
              <th className="w-40 border-r border-line px-3 py-2 text-left">{t('division.code')}</th>
              <th className="px-3 py-2 text-left">{t('orgDefinition.name')}</th>
              <th className="w-28 px-3 py-2 text-left">{t('orgDefinition.status')}</th>
              <th className="w-44 px-3 py-2 text-end">{t('common.actions')}</th>
            </tr></thead>
            <tbody>
              {visibleEntries.map((entry) => (
                <tr key={entry.division} className="border-b border-line hover:bg-sunken">
                  <td className="border-r border-line px-3 py-2 font-mono"><Link className="text-accent underline" href={detailHref(entry.division)}>{entry.division}</Link></td>
                  <td className="px-3 py-2">{entry.name}</td>
                  <td className="px-3 py-2"><span className={`chip ${entry.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(entry.isActive ? 'orgDefinition.active' : 'orgDefinition.inactive')}</span></td>
                  <td className="whitespace-nowrap px-3 py-2 text-end"><Link className="text-accent underline" href={detailHref(entry.division)}>{t('orgDefinition.open')}</Link>{canMaintain && entry.isActive && <Link className="ms-3 text-accent underline" href={copyHref(entry.division)}>{t('orgDefinition.copy')}</Link>}</td>
                </tr>
              ))}
              {visibleEntries.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-sm text-ink-soft">{search ? t('orgDefinition.noSearchResults') : t('division.empty')}</td></tr>}
            </tbody>
          </table>
        </div>
        <div className="flex flex-col gap-1 border-t border-line bg-sunken px-3 py-3 text-xs text-ink-soft sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <span>{t('orgDefinition.retentionNote')}</span><span className="tabular">{visibleEntries.length}</span>
        </div>
      </section>

      {creating && <DivisionDefinitionForm key={`CREATE:${copySource?.division ?? 'new'}`} mode="CREATE" initial={initial} version={0} />}
      {editing && selected && <DivisionDefinitionForm key={`CHANGE:${selected.division}`} mode="CHANGE" initial={initial} version={version} />}

      {selectionRequested && !selected && (
        <section className="panel p-4"><p role="status" className="text-sm text-signal-error">{t('division.notFound')}</p><Link className="mt-2 inline-block text-sm text-accent underline" href="/config/divisions">{t('orgDefinition.backToList')}</Link></section>
      )}
      {params.new === '1' && params.copy && !copySource && !selectionRequested && (
        <section className="panel p-4"><p role="status" className="text-sm text-signal-error">{t('division.notFound')}</p><Link className="mt-2 inline-block text-sm text-accent underline" href="/config/divisions">{t('orgDefinition.backToList')}</Link></section>
      )}

      {selected && !editing && (
        <section className="panel p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><h2 className="panel-title">{t('orgDefinition.detail')} · <span className="code">{selected.division}</span></h2><p className="mt-1 text-sm text-ink-soft">{selected.name}</p></div>
            <div className="flex flex-wrap gap-3 text-sm">
              <Link className="text-accent underline" href="/config/divisions">{t('orgDefinition.backToList')}</Link>
              {canMaintain && <Link className="text-accent underline" href={editHref(selected.division)}>{t('common.change')}</Link>}
              {canMaintain && selected.isActive && <Link className="text-accent underline" href={copyHref(selected.division)}>{t('orgDefinition.copy')}</Link>}
              <Link className="text-accent underline" href={`${detailHref(selected.division)}&history=1`}>{t('orgDefinition.history')}</Link>
            </div>
          </div>
          <dl className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div><dt className="field-label">{t('division.code')}</dt><dd className="code">{selected.division}</dd></div>
            <div><dt className="field-label">{t('orgDefinition.name')}</dt><dd>{selected.name}</dd></div>
            <div><dt className="field-label">{t('orgDefinition.status')}</dt><dd><span className={`chip ${selected.isActive ? 'chip-ok' : 'chip-neutral'}`}>{t(selected.isActive ? 'orgDefinition.active' : 'orgDefinition.inactive')}</span></dd></div>
            {canMaintain && <div><dt className="field-label">{t('orgDefinition.version')}</dt><dd className="tabular">{version}</dd></div>}
          </dl>
          {!selected.isActive && !canMaintain && <p className="mt-3 text-xs text-ink-soft">{t('orgDefinition.inactiveRetained')}</p>}
        </section>
      )}
      {selected && !editing && canMaintain && <DeactivateDivisionForm division={selected.division} name={selected.name} version={version} isActive={selected.isActive} />}
      {selected && params.history === '1' && (
        <section className="panel overflow-x-auto">
          <div className="panel-header"><h2 className="panel-title">{t('orgDefinition.history')} · <span className="code">{selected.division}</span></h2></div>
          {history.map((entry) => (
            <article key={entry.id} className="border-b border-line p-3 text-sm">
              <p className="font-medium">{entry.changedAt.toISOString()} · {entry.changedBy} · {entry.changeType}</p>
              {entry.reason && <p className="text-ink-soft">{entry.reason}</p>}
              <ul className="mt-1 text-2xs text-ink-soft">{entry.items.map((item) => <li key={item.id}>{item.fieldLabel}: {item.oldValue ?? '—'} → {item.newValue ?? '—'}{item.isSecurityRelevant === 'true' ? ` · ${t('nr.controlChange')}` : ''}</li>)}</ul>
            </article>
          ))}
          {!history.length && <p className="p-3 text-sm text-ink-soft">{t('orgDefinition.noChanges')}</p>}
        </section>
      )}
    </div>
  );
}
