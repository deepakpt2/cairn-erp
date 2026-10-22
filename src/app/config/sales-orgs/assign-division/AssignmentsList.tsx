'use client';

import { useActionState, useState } from 'react';
import { t } from '@/platform/i18n';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';
import {
  unassignSalesOrgDivisionAction,
  type SalesOrgDivisionAssignmentState,
} from './actions';

export interface SalesOrgDivisionAssignmentRow {
  salesOrg: string;
  salesOrgName: string;
  salesOrgActive: boolean;
  division: string;
  divisionName: string;
  divisionActive: boolean;
}

export function SalesOrgDivisionAssignmentsList({
  assignments,
  canRemove,
}: {
  assignments: SalesOrgDivisionAssignmentRow[];
  canRemove: boolean;
}) {
  const [state, unassignAction, pending] = useActionState<SalesOrgDivisionAssignmentState, FormData>(
    unassignSalesOrgDivisionAction,
    { ok: true },
  );
  const [confirmationFor, setConfirmationFor] = useState<string | null>(null);
  const removeLock = useChangeLock(
    'SALES_ORG_DIVISION',
    confirmationFor ?? '',
    'CFG.ORG.SALESORG.ASSIGN_DIVISION',
    Boolean(confirmationFor) && canRemove,
  );

  return (
    <section className="overflow-hidden border border-[#9eb6c8] bg-white shadow-sm" aria-labelledby="ovxa-assignment-list-title">
      <div className="flex items-center gap-2 border-b border-[#cbd5de] bg-[#eef3f7] px-3 py-3 sm:px-4">
        <h2 id="ovxa-assignment-list-title" className="min-w-0 flex-1 text-sm font-semibold text-[#334f65]">
          {t('salesOrgDivision.assignmentListTitle')}
        </h2>
        <span className="code text-xs text-ink-faint tabular">{assignments.length}</span>
      </div>

      {state.message && (
        <div
          role={state.ok ? 'status' : 'alert'}
          className={`border-b px-3 py-3 text-sm sm:px-4 ${state.ok
            ? 'border-[#a8c9b1] bg-[#f3faf4] text-[#285d37]'
            : 'border-signal-error/30 bg-signal-error-soft text-signal-error'}`}
        >
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1">{state.remedy}</p>}
        </div>
      )}

      {assignments.length === 0 ? (
        <p className="p-4 text-sm text-ink-soft">{t('salesOrgDivision.assignmentListEmpty')}</p>
      ) : (
        <>
          <div className="hidden grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] gap-4 border-b border-[#cbd5de] bg-[#f7f9fa] px-4 py-2 text-xs font-semibold text-[#52697a] sm:grid">
            <span>{t('salesOrgDivision.salesOrgField')}</span>
            <span>{t('salesOrgDivision.divisionField')}</span>
            <span>{t('common.actions')}</span>
          </div>
          <ul className="divide-y divide-[#d6dce1]" aria-label={t('salesOrgDivision.assignmentListTitle')}>
            {assignments.map((item) => {
              const pair = `${item.salesOrg}/${item.division}`;
              const confirming = confirmationFor === pair;
              return (
                <li key={pair} className="grid gap-3 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center sm:gap-4 sm:px-4">
                  <div className="min-w-0">
                    <p className="field-label sm:hidden">{t('salesOrgDivision.salesOrgField')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="code font-semibold">{item.salesOrg}</span>
                      <span className={`chip ${item.salesOrgActive ? 'chip-ok' : 'chip-neutral'}`}>
                        {t(item.salesOrgActive ? 'salesOrg.active' : 'salesOrg.inactive')}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-sm text-[#263b4d]">{item.salesOrgName}</p>
                  </div>

                  <div className="min-w-0">
                    <p className="field-label sm:hidden">{t('salesOrgDivision.divisionField')}</p>
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="code font-semibold">{item.division}</span>
                      <span className={`chip ${item.divisionActive ? 'chip-ok' : 'chip-neutral'}`}>
                        {t(item.divisionActive ? 'orgDefinition.active' : 'orgDefinition.inactive')}
                      </span>
                    </div>
                    <p className="mt-1 break-words text-sm text-[#263b4d]">{item.divisionName}</p>
                  </div>

                  <div className="sm:text-end">
                    {canRemove && (
                      <form action={unassignAction} className="space-y-2">
                        <input type="hidden" name="salesOrg" value={item.salesOrg} />
                        <input type="hidden" name="division" value={item.division} />
                        {confirming ? (
                          <div className="space-y-2 sm:max-w-sm">
                            <p className="text-xs text-ink-soft">
                              {t('salesOrgDivision.confirmRemoveText', {
                                salesOrg: item.salesOrg,
                                division: item.division,
                              })}
                            </p>
                            <LockNotice message={removeLock?.mode === 'DISPLAY' ? removeLock.message : null} />
                            <div className="flex flex-wrap gap-2 sm:justify-end">
                              <button type="submit" className="btn btn-danger min-h-11 sm:min-h-9" disabled={pending || removeLock?.mode !== 'CHANGE'}>
                                {pending ? t('common.saving') : t('salesOrgDivision.confirmRemove')}
                              </button>
                              <button
                                type="button"
                                className="btn btn-default min-h-11 sm:min-h-9"
                                onClick={() => setConfirmationFor(null)}
                                disabled={pending}
                              >
                                {t('salesOrgDivision.cancelRemove')}
                              </button>
                            </div>
                          </div>
                        ) : (
                          <button
                            type="button"
                            className="inline-flex min-h-11 items-center justify-center border border-[#8faabd] bg-white px-3 text-sm font-medium text-[#264e6b] hover:bg-[#f4f8fa] disabled:opacity-50 sm:min-h-9"
                            onClick={() => setConfirmationFor(pair)}
                            disabled={pending}
                          >
                            {t('salesOrgDivision.remove')}
                          </button>
                        )}
                      </form>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </>
      )}

      <div className="border-t border-[#cbd5de] bg-[#f7f9fa] px-3 py-3 text-xs text-ink-soft sm:px-4">
        {t('salesOrgDivision.listRule')}
      </div>
    </section>
  );
}
