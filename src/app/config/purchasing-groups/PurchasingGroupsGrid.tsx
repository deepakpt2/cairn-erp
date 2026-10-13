'use client';

import Link from 'next/link';
import { useActionState, useEffect, useMemo, useState } from 'react';
import { t } from '@/platform/i18n';
import {
  savePurchasingGroupChangesAction,
  type PurchasingGroupActionState,
} from './actions';

export interface PurchasingGroupRecord {
  purchasingGroup: string;
  name: string;
  telNoPurchGroup: string;
  faxNumber: string;
  telephone: string;
  extension: string;
  emailAddress: string;
  version: number;
}

type Values = Omit<PurchasingGroupRecord, 'purchasingGroup' | 'version'>;
interface DraftRow extends PurchasingGroupRecord {
  id: string;
  original: Values;
  isNew: boolean;
  selected: boolean;
  deleted: boolean;
}
type PendingChange =
  | { mode: 'CREATE'; purchasingGroup: string; expectedVersion: 0; values: Values }
  | { mode: 'CHANGE'; purchasingGroup: string; expectedVersion: number; values: Values }
  | { mode: 'DELETE'; purchasingGroup: string; expectedVersion: number };

const EMPTY_VALUES: Values = {
  name: '',
  telNoPurchGroup: '',
  faxNumber: '',
  telephone: '',
  extension: '',
  emailAddress: '',
};

function rowValues(row: Pick<PurchasingGroupRecord, keyof Values>): Values {
  return {
    name: row.name,
    telNoPurchGroup: row.telNoPurchGroup,
    faxNumber: row.faxNumber,
    telephone: row.telephone,
    extension: row.extension,
    emailAddress: row.emailAddress,
  };
}

function sameValues(left: Values, right: Values): boolean {
  return Object.keys(EMPTY_VALUES).every((key) => left[key as keyof Values] === right[key as keyof Values]);
}

function toDrafts(records: PurchasingGroupRecord[]): DraftRow[] {
  return records.map((record) => ({
    ...record,
    id: `saved:${record.purchasingGroup}`,
    original: rowValues(record),
    isNew: false,
    selected: false,
    deleted: false,
  }));
}

function valuesFromOutcome(outcomeValues: Record<keyof Values, string | null>): Values {
  return {
    name: outcomeValues.name ?? '',
    telNoPurchGroup: outcomeValues.telNoPurchGroup ?? '',
    faxNumber: outcomeValues.faxNumber ?? '',
    telephone: outcomeValues.telephone ?? '',
    extension: outcomeValues.extension ?? '',
    emailAddress: outcomeValues.emailAddress ?? '',
  };
}

function applyOutcomes(rows: DraftRow[], outcomes: NonNullable<PurchasingGroupActionState['outcomes']>): DraftRow[] {
  let next = [...rows];
  for (const outcome of outcomes) {
    if (outcome.mode === 'DELETE') {
      next = next.filter((row) => row.purchasingGroup !== outcome.purchasingGroup);
      continue;
    }
    const index = next.findIndex((row) => row.purchasingGroup === outcome.purchasingGroup);
    if (index < 0 || !outcome.values) continue;
    const values = valuesFromOutcome(outcome.values);
    next[index] = {
      ...next[index],
      ...values,
      version: outcome.version,
      original: values,
      id: `saved:${outcome.purchasingGroup}`,
      isNew: false,
      selected: false,
      deleted: false,
    };
  }
  return next;
}

export function PurchasingGroupsGrid({
  records,
  canMaintain,
}: {
  records: PurchasingGroupRecord[];
  canMaintain: boolean;
}) {
  const sourceKey = JSON.stringify(records);
  const [baseline, setBaseline] = useState(() => toDrafts(records));
  const [rows, setRows] = useState(() => toDrafts(records));
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [state, action, pending] = useActionState<PurchasingGroupActionState, FormData>(
    savePurchasingGroupChangesAction,
    { ok: true },
  );

  useEffect(() => {
    const fresh = toDrafts(records);
    setBaseline(fresh);
    setRows(fresh);
  // sourceKey captures the server data values and audit versions without resetting on render identity.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceKey]);

  useEffect(() => {
    if (!state.ok || !state.outcomes) return;
    setRows((current) => applyOutcomes(current, state.outcomes!));
    setBaseline((current) => applyOutcomes(current, state.outcomes!));
  }, [state.outcomes, state.ok]);

  const pendingChanges = useMemo<PendingChange[]>(() => {
    const changes: PendingChange[] = [];
    for (const row of rows) {
      if (row.deleted && !row.isNew) {
        changes.push({ mode: 'DELETE', purchasingGroup: row.purchasingGroup, expectedVersion: row.version });
      } else if (row.isNew) {
        changes.push({ mode: 'CREATE', purchasingGroup: row.purchasingGroup, expectedVersion: 0, values: rowValues(row) });
      } else if (!sameValues(rowValues(row), row.original)) {
        changes.push({ mode: 'CHANGE', purchasingGroup: row.purchasingGroup, expectedVersion: row.version, values: rowValues(row) });
      }
    }
    return changes;
  }, [rows]);

  const selectedRows = rows.filter((row) => row.selected && !row.deleted);
  const copyableRows = selectedRows.filter((row) => !row.isNew);
  const search = searchTerm.trim().toLocaleLowerCase();
  const visibleRows = rows.filter((row) => !search ||
    `${row.purchasingGroup} ${row.name} ${row.telNoPurchGroup} ${row.faxNumber} ${row.telephone} ${row.emailAddress}`
      .toLocaleLowerCase()
      .includes(search),
  );
  const canCopy = canMaintain && copyableRows.length === 1 && selectedRows.length === 1;
  const canDelete = canMaintain && selectedRows.length > 0;
  const hasUnsavedChanges = pendingChanges.length > 0;

  function updateRow(id: string, patch: Partial<DraftRow>) {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function selectAllVisible() {
    const visibleIds = new Set(visibleRows.filter((row) => !row.deleted).map((row) => row.id));
    setRows((current) => current.map((row) => visibleIds.has(row.id) ? { ...row, selected: true } : row));
  }

  function clearSelection() {
    setRows((current) => current.map((row) => row.selected ? { ...row, selected: false } : row));
  }

  function addEntry() {
    const id = `new:${crypto.randomUUID()}`;
    setRows((current) => [
      ...current,
      {
        id,
        purchasingGroup: '',
        ...EMPTY_VALUES,
        version: 0,
        original: { ...EMPTY_VALUES },
        isNew: true,
        selected: false,
        deleted: false,
      },
    ]);
  }

  function copySelected() {
    const source = selectedRows[0];
    if (!source) return;
    const id = `new:${crypto.randomUUID()}`;
    setRows((current) => [
      ...current.map((row) => ({ ...row, selected: false })),
      {
        id,
        purchasingGroup: '',
        ...rowValues(source),
        version: 0,
        original: { ...EMPTY_VALUES },
        isNew: true,
        selected: false,
        deleted: false,
      },
    ]);
  }

  function deleteSelected() {
    setRows((current) => current.flatMap((row) => {
      if (!row.selected || row.deleted) return [row];
      if (row.isNew) return [];
      return [{ ...row, selected: false, deleted: true }];
    }));
  }

  function undoChanges() {
    setRows(toDrafts(baseline));
  }

  return (
    <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm">
      <div className="flex min-h-16 items-center gap-3 border-b border-[#9eb6c8] bg-[#c9dce9] px-4 py-2 text-[#28445b]">
        <Link href="/config" aria-label={t('nav.workbench')} className="flex h-9 w-9 items-center justify-center rounded-full bg-[#b5cddd] text-xl hover:bg-[#a9c3d5]">
          ‹
        </Link>
        <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#2d708b] font-bold tracking-tight text-white shadow-sm" aria-label={t('app.name')}>
          C
        </span>
        <h1 className="flex-1 text-center text-base font-semibold">{t('purchasingGroup.screenTitle')}</h1>
        <Link href="/config" className="hidden text-xs text-[#28445b] underline sm:inline">{t('nav.workbench')}</Link>
      </div>

      <form action={action}>
        <input type="hidden" name="changes" value={JSON.stringify(pendingChanges)} />
        <input type="hidden" name="reason" value="" />
        <div className="flex flex-wrap items-center gap-1 border-b border-[#cbd5de] bg-[#eef3f7] px-2 py-2 text-sm">
          <select aria-label={t('purchasingGroup.view')} className="h-8 w-56 border border-[#aabac6] bg-white px-2 text-xs" value="overview" disabled>
            <option value="overview"></option>
          </select>
          {canMaintain && (
            <>
              <button type="button" className="h-8 border border-transparent px-3 font-medium text-[#264e6b] hover:border-[#aabac6] hover:bg-white" onClick={addEntry}>
                {t('purchasingGroup.newEntries')}
              </button>
              <button type="button" className="h-8 w-9 border border-transparent text-lg text-[#31566f] hover:border-[#aabac6] hover:bg-white disabled:opacity-40" title={t('purchasingGroup.copy')} aria-label={t('purchasingGroup.copy')} onClick={copySelected} disabled={!canCopy}>
                ▣
              </button>
              <button type="button" className="h-8 w-9 border border-transparent text-lg text-[#31566f] hover:border-[#aabac6] hover:bg-white disabled:opacity-40" title={t('purchasingGroup.delete')} aria-label={t('purchasingGroup.delete')} onClick={deleteSelected} disabled={!canDelete}>
                ⊖
              </button>
              <button type="button" className="h-8 w-9 border border-transparent text-lg text-[#31566f] hover:border-[#aabac6] hover:bg-white disabled:opacity-40" title={t('purchasingGroup.undo')} aria-label={t('purchasingGroup.undo')} onClick={undoChanges} disabled={!hasUnsavedChanges}>
                ↶
              </button>
              <button type="button" className="h-8 w-9 border border-transparent text-sm text-[#31566f] hover:border-[#aabac6] hover:bg-white disabled:opacity-40" title={t('purchasingGroup.selectAll')} aria-label={t('purchasingGroup.selectAll')} onClick={selectAllVisible} disabled={!visibleRows.some((row) => !row.deleted)}>
                ▦
              </button>
              <button type="button" className="h-8 w-9 border border-transparent text-sm text-[#31566f] hover:border-[#aabac6] hover:bg-white disabled:opacity-40" title={t('purchasingGroup.clearSelection')} aria-label={t('purchasingGroup.clearSelection')} onClick={clearSelection} disabled={!selectedRows.length}>
                ▧
              </button>
              <button type="button" className="h-8 w-9 border border-transparent text-lg text-[#31566f] hover:border-[#aabac6] hover:bg-white" title={t('purchasingGroup.find')} aria-label={t('purchasingGroup.find')} onClick={() => setSearchOpen((open) => !open)}>
                ⌕
              </button>
              {searchOpen && (
                <input autoFocus className="h-8 w-52 border border-[#aabac6] bg-white px-2 text-xs outline-none focus:border-[#5388a8]" aria-label={t('purchasingGroup.searchPlaceholder')} placeholder={t('purchasingGroup.searchPlaceholder')} value={searchTerm} onChange={(event) => setSearchTerm(event.currentTarget.value)} />
              )}
              <button type="submit" className="h-8 border border-[#8faabd] bg-white px-3 font-medium text-[#264e6b] hover:bg-[#f8fbfd] disabled:opacity-50" disabled={pending || !hasUnsavedChanges}>
                {pending ? t('common.saving') : t('purchasingGroup.save')}
              </button>
              <details className="relative ml-auto">
                <summary className="flex h-8 cursor-pointer list-none items-center gap-1 border border-transparent px-3 text-[#264e6b] hover:border-[#aabac6] hover:bg-white">
                  {t('purchasingGroup.more')} <span aria-hidden="true">⌄</span>
                </summary>
                <div className="absolute right-0 z-10 mt-1 min-w-48 border border-[#aabac6] bg-white p-1 shadow-lg">
                  <button type="button" className="w-full px-3 py-2 text-left text-sm hover:bg-[#eef3f7]" onClick={undoChanges} disabled={!hasUnsavedChanges}>
                    {t('purchasingGroup.undo')}
                  </button>
                  <button type="submit" className="w-full px-3 py-2 text-left text-sm hover:bg-[#eef3f7] disabled:opacity-50" disabled={pending || !hasUnsavedChanges}>
                    {t('purchasingGroup.save')}
                  </button>
                </div>
              </details>
            </>
          )}
        </div>

        {state.message && (!state.ok || !hasUnsavedChanges) && (
          <div role={state.ok ? 'status' : 'alert'} className={`border-b px-4 py-2 text-sm ${state.ok ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-800'}`}>
            <p>{state.message}</p>
            {!state.ok && state.remedy && <p className="mt-1 text-xs">{state.remedy}</p>}
          </div>
        )}
        {!canMaintain && (
          <p role="status" className="border-b border-[#cbd5de] px-4 py-2 text-sm text-ink-soft">
            {t('auth.readOnly', { authority: 'CFG.PROC.PURGROUP.DEFINE' })}
          </p>
        )}

        <div className="border-b border-[#cbd5de] px-4 py-3 text-sm font-semibold text-[#334f65]">
          {t('purchasingGroup.tableHeading')}
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-[1200px] w-full border-collapse text-sm" aria-label={t('purchasingGroup.tableHeading')}>
            <thead className="bg-[#eef1f4] text-[#33414c]">
              <tr className="border-y border-[#c4ccd2]">
                <th className="w-9 px-1 py-2" aria-label={t('purchasingGroup.select')} />
                <th className="w-[52px] min-w-[52px] border-r border-[#cbd1d6] px-1 py-2 text-left"><span className="block w-[32px] truncate" title={t('purchasingGroup.code')}>{t('purchasingGroup.code')}</span></th>
                <th className="w-[168px] min-w-[168px] border-r border-[#cbd1d6] px-2 py-2 text-left">{t('purchasingGroup.description')}</th>
                <th className="w-[177px] min-w-[177px] border-r border-[#cbd1d6] px-2 py-2 text-left">{t('purchasingGroup.telNoPurchGroup')}</th>
                <th className="w-[195px] min-w-[195px] border-r border-[#cbd1d6] px-2 py-2 text-left">{t('purchasingGroup.faxNumber')}</th>
                <th className="w-[205px] min-w-[205px] border-r border-[#cbd1d6] px-2 py-2 text-left">{t('purchasingGroup.telephone')}</th>
                <th className="w-[148px] min-w-[148px] border-r border-[#cbd1d6] px-2 py-2 text-left">{t('purchasingGroup.extension')}</th>
                <th className="min-w-[220px] px-2 py-2 text-left">{t('purchasingGroup.emailAddress')}</th>
              </tr>
            </thead>
            <tbody>
              {visibleRows.map((row) => (
                <tr key={row.id} className={`border-b border-[#d6dce1] ${row.deleted ? 'bg-red-50 text-slate-500 line-through' : 'hover:bg-[#f8fbfd]'}`}>
                  <td className="border-r border-[#e1e5e8] px-1 py-1 text-center">
                    <input
                      type="checkbox"
                      aria-label={t('purchasingGroup.selectRow', { code: row.purchasingGroup || t('purchasingGroup.newRow') })}
                      checked={row.selected}
                      disabled={!canMaintain || row.deleted}
                      onChange={(event) => updateRow(row.id, { selected: event.currentTarget.checked })}
                    />
                  </td>
                  <td className="border-r border-[#e1e5e8] px-1 py-1">
                    <input
                      className="w-full border-0 bg-transparent px-1 py-1 font-mono text-sm focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500"
                      aria-label={t('purchasingGroup.code')}
                      value={row.purchasingGroup}
                      maxLength={3}
                      pattern="[A-Z0-9]{3}"
                      required={row.isNew && !row.deleted}
                      readOnly={!canMaintain || !row.isNew || row.deleted}
                      onChange={(event) => updateRow(row.id, { purchasingGroup: event.currentTarget.value.toUpperCase() })}
                    />
                  </td>
                  <td className="border-r border-[#e1e5e8] px-1 py-1">
                    <input className="w-full border-0 bg-transparent px-1 py-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500" aria-label={t('purchasingGroup.descriptionFull')} value={row.name} maxLength={120} required={!row.deleted} readOnly={!canMaintain || row.deleted} onChange={(event) => updateRow(row.id, { name: event.currentTarget.value })} />
                  </td>
                  <td className="border-r border-[#e1e5e8] px-1 py-1">
                    <input className="w-full border-0 bg-transparent px-1 py-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500" aria-label={t('purchasingGroup.telNoPurchGroup')} value={row.telNoPurchGroup} maxLength={12} readOnly={!canMaintain || row.deleted} onChange={(event) => updateRow(row.id, { telNoPurchGroup: event.currentTarget.value })} />
                  </td>
                  <td className="border-r border-[#e1e5e8] px-1 py-1">
                    <input className="w-full border-0 bg-transparent px-1 py-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500" aria-label={t('purchasingGroup.faxNumber')} value={row.faxNumber} maxLength={31} readOnly={!canMaintain || row.deleted} onChange={(event) => updateRow(row.id, { faxNumber: event.currentTarget.value })} />
                  </td>
                  <td className="border-r border-[#e1e5e8] px-1 py-1">
                    <input className="w-full border-0 bg-transparent px-1 py-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500" aria-label={t('purchasingGroup.telephone')} value={row.telephone} maxLength={30} readOnly={!canMaintain || row.deleted} onChange={(event) => updateRow(row.id, { telephone: event.currentTarget.value })} />
                  </td>
                  <td className="border-r border-[#e1e5e8] px-1 py-1">
                    <input className="w-full border-0 bg-transparent px-1 py-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500" aria-label={t('purchasingGroup.extension')} value={row.extension} maxLength={10} readOnly={!canMaintain || row.deleted} onChange={(event) => updateRow(row.id, { extension: event.currentTarget.value })} />
                  </td>
                  <td className="px-1 py-1">
                    <input type="text" inputMode="email" className="w-full border-0 bg-transparent px-1 py-1 focus:bg-white focus:outline focus:outline-1 focus:outline-[#5b94b7] disabled:text-slate-500" aria-label={t('purchasingGroup.emailAddress')} value={row.emailAddress} maxLength={241} readOnly={!canMaintain || row.deleted} onChange={(event) => updateRow(row.id, { emailAddress: event.currentTarget.value })} />
                  </td>
                </tr>
              ))}
              {visibleRows.length === 0 && (
                <tr><td colSpan={8} className="px-4 py-8 text-center text-sm text-ink-soft">{rows.length === 0 ? t('purchasingGroup.empty') : t('purchasingGroup.noSearchResults')}</td></tr>
              )}
            </tbody>
          </table>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[#cbd5de] bg-[#f7f9fb] px-4 py-3 text-xs text-ink-soft">
          <span>{t('purchasingGroup.retentionNote')}</span>
          <span className="tabular">{rows.filter((row) => !row.deleted).length}</span>
        </div>
      </form>
    </section>
  );
}
