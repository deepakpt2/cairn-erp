'use client';

import { useActionState, useState } from 'react';

import type { MaterialPeriodRow } from '@/modules/inventory/material-period-control';
import {
  initializeMaterialPeriodAction,
  setMaterialPeriodIndicatorsAction,
  shiftMaterialPeriodAction,
  type MaterialPeriodActionState,
} from './actions';

function RequiredMark() {
  return (
    <span className="ms-1 text-signal-error" aria-hidden="true">*</span>
  );
}

function Message({ state }: { state: MaterialPeriodActionState }) {
  if (!state.message) return null;
  return (
    <div
      role={state.ok ? 'status' : 'alert'}
      className="border border-line bg-white p-3 text-sm text-ink"
    >
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

function ReasonInput({ id }: { id: string }) {
  return (
    <div>
      <label htmlFor={id} className="text-sm font-medium">
        Reason<RequiredMark />
      </label>
      <input id={id} name="reason" required className="input mt-1 w-full" />
    </div>
  );
}

function DialogShell({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
      <div className="w-full max-w-md space-y-3 border border-line bg-white p-4 shadow-lg">
        <div className="flex items-center justify-between">
          <h3 className="text-base font-semibold">{title}</h3>
          <button type="button" className="btn btn-default" onClick={onClose}>
            Close
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function period(year: number | null, periodValue: number | null): string {
  if (year === null || periodValue === null) return '—';
  return `${year} / ${String(periodValue).padStart(2, '0')}`;
}

export default function MaterialPeriodControl({
  rows,
  canMaintain,
}: {
  rows: MaterialPeriodRow[];
  canMaintain: boolean;
}) {
  const [dialog, setDialog] = useState<
    | { kind: 'initialize'; row: MaterialPeriodRow }
    | { kind: 'indicators'; row: MaterialPeriodRow }
    | { kind: 'shift'; row: MaterialPeriodRow }
    | null
  >(null);

  const [initState, initAction] = useActionState<MaterialPeriodActionState, FormData>(
    initializeMaterialPeriodAction,
    { ok: true },
  );
  const [indState, indAction] = useActionState<MaterialPeriodActionState, FormData>(
    setMaterialPeriodIndicatorsAction,
    { ok: true },
  );
  const [shiftState, shiftAction] = useActionState<MaterialPeriodActionState, FormData>(
    shiftMaterialPeriodAction,
    { ok: true },
  );

  return (
    <div className="space-y-6">
      <section aria-labelledby="material-period-grid" className="space-y-3">
        <h2 id="material-period-grid" className="text-base font-semibold">
          Company control records
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-faint">No company codes stand yet.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead>
                <tr className="border-b border-line text-ink-soft">
                  <th className="py-2 pe-3">Company code</th>
                  <th className="py-2 pe-3">Current period</th>
                  <th className="py-2 pe-3">Previous period</th>
                  <th className="py-2 pe-3">Backposting to previous</th>
                  <th className="py-2 pe-3">Disallow after change</th>
                  <th className="py-2 pe-3">Last changed by</th>
                  {canMaintain && <th className="py-2">Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.companyCode} className="border-b border-line/60">
                    <td className="py-2 pe-3 font-medium">
                      {row.companyCode}
                      <span className="block text-xs font-normal text-ink-soft">
                        {row.companyName}
                      </span>
                    </td>
                    {row.initialized ? (
                      <>
                        <td className="py-2 pe-3">{period(row.currentYear, row.currentPeriod)}</td>
                        <td className="py-2 pe-3">
                          {period(row.previousYear, row.previousPeriod)}
                        </td>
                        <td className="py-2 pe-3">{row.allowBackposting ? 'Allowed' : 'No'}</td>
                        <td className="py-2 pe-3">
                          {row.disallowBackpostingAfterChange ? 'Yes' : 'No'}
                        </td>
                        <td className="py-2 pe-3">{row.lastChangedBy ?? '—'}</td>
                        {canMaintain && (
                          <td className="py-2">
                            <div className="flex flex-wrap gap-2">
                              <button
                                type="button"
                                className="btn btn-default"
                                onClick={() => setDialog({ kind: 'shift', row })}
                              >
                                Shift period
                              </button>
                              <button
                                type="button"
                                className="btn btn-default"
                                onClick={() => setDialog({ kind: 'indicators', row })}
                              >
                                Indicators
                              </button>
                            </div>
                          </td>
                        )}
                      </>
                    ) : (
                      <>
                        <td className="py-2 pe-3 text-ink-faint" colSpan={5}>
                          Not initialized
                        </td>
                        {canMaintain && (
                          <td className="py-2">
                            <button
                              type="button"
                              className="btn btn-default"
                              onClick={() => setDialog({ kind: 'initialize', row })}
                            >
                              Initialize
                            </button>
                          </td>
                        )}
                      </>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {dialog?.kind === 'initialize' && (
        <DialogShell
          title={`Initialize material period — ${dialog.row.companyCode}`}
          onClose={() => setDialog(null)}
        >
          <form action={initAction} className="space-y-3">
            <input type="hidden" name="companyCode" value={dialog.row.companyCode} />
            <p className="text-sm text-ink-soft">
              Initialization happens once. Afterwards the period advances only
              through the shift; it is never edited or reinitialized here.
            </p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label htmlFor="mp-year" className="text-sm font-medium">
                  Fiscal year<RequiredMark />
                </label>
                <input
                  id="mp-year"
                  name="fiscalYear"
                  required
                  inputMode="numeric"
                  maxLength={4}
                  className="input mt-1 w-full"
                />
              </div>
              <div>
                <label htmlFor="mp-period" className="text-sm font-medium">
                  Period<RequiredMark />
                </label>
                <input
                  id="mp-period"
                  name="period"
                  required
                  inputMode="numeric"
                  maxLength={2}
                  className="input mt-1 w-full"
                />
              </div>
            </div>
            <ReasonInput id="mp-init-reason" />
            <button type="submit" className="btn btn-primary">
              Initialize
            </button>
            <Message state={initState} />
          </form>
        </DialogShell>
      )}

      {dialog?.kind === 'indicators' && (
        <DialogShell
          title={`Backposting indicators — ${dialog.row.companyCode}`}
          onClose={() => setDialog(null)}
        >
          <form action={indAction} className="space-y-3">
            <input type="hidden" name="companyCode" value={dialog.row.companyCode} />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="allowBackposting"
                value="true"
                defaultChecked={dialog.row.allowBackposting}
                className="mt-0.5"
              />
              <span>
                Allow posting to the previous period
                <span className="block text-xs text-ink-soft">
                  The previous period ({period(dialog.row.previousYear, dialog.row.previousPeriod)})
                  stands open for material postings beside the current one.
                </span>
              </span>
            </label>
            <input type="hidden" name="allowBackposting" value="" />
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                name="disallowBackpostingAfterChange"
                value="true"
                defaultChecked={dialog.row.disallowBackpostingAfterChange}
                className="mt-0.5"
              />
              <span>
                Disallow backposting after a period change
                <span className="block text-xs text-ink-soft">
                  Each period shift then clears the allowance above, so the period
                  just closed never reopens.
                </span>
              </span>
            </label>
            <input type="hidden" name="disallowBackpostingAfterChange" value="" />
            <ReasonInput id="mp-ind-reason" />
            <button type="submit" className="btn btn-primary">
              Save indicators
            </button>
            <Message state={indState} />
          </form>
        </DialogShell>
      )}

      {dialog?.kind === 'shift' && (
        <DialogShell
          title={`Shift material period — ${dialog.row.companyCode}`}
          onClose={() => setDialog(null)}
        >
          <form action={shiftAction} className="space-y-3">
            <input type="hidden" name="companyCode" value={dialog.row.companyCode} />
            <p className="text-sm text-ink-soft">
              The current period {period(dialog.row.currentYear, dialog.row.currentPeriod)}{' '}
              becomes the previous period and the next period opens. The shift moves
              exactly one period and cannot be undone here.
              {dialog.row.disallowBackpostingAfterChange &&
                ' Backposting is disallowed after a change, so this shift also closes the previous period for good.'}
            </p>
            <ReasonInput id="mp-shift-reason" />
            <button type="submit" className="btn btn-primary">
              Shift period
            </button>
            <Message state={shiftState} />
          </form>
        </DialogShell>
      )}
    </div>
  );
}
