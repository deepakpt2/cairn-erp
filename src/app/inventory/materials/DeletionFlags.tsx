'use client';

import { useActionState, useState } from 'react';

import { t } from '@/platform/i18n';
import { setMaterialDeletionFlagAction, type MaterialState } from './actions';

/**
 * Material deletion flags (SCR-053 / MM06; live since stage 3).
 *
 * The flag status at every standing scope — the client level and each
 * plant the material is extended to — with the stock standing at the
 * scope named before confirming. Setting and cancelling are their own
 * confirmed acts with a mandatory reason; the flag itself is a marker,
 * not a posting lock, and deletes nothing.
 */
export interface DeletionFlagPlantRow {
  plant: string;
  flagged: boolean;
  stock: string;
}

function Message({ state }: { state: MaterialState }) {
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

export default function DeletionFlags({
  materialNumber,
  clientFlagged,
  clientStock,
  plants,
  canMaintain,
}: {
  materialNumber: string;
  clientFlagged: boolean;
  clientStock: string;
  plants: DeletionFlagPlantRow[];
  canMaintain: boolean;
}) {
  const [confirming, setConfirming] = useState<
    | { scope: 'CLIENT' | 'PLANT'; plant: string; flagged: boolean; stock: string }
    | null
  >(null);
  const [state, action] = useActionState<MaterialState, FormData>(
    setMaterialDeletionFlagAction,
    { ok: true },
  );

  const act = (scope: 'CLIENT' | 'PLANT', plant: string, flagged: boolean, stock: string) =>
    canMaintain ? (
      <button
        type="button"
        className="btn btn-default"
        onClick={() => setConfirming({ scope, plant, flagged, stock })}
      >
        {flagged ? 'Flag for deletion' : 'Cancel flag'}
      </button>
    ) : null;

  return (
    <section aria-labelledby="material-deletion-title" className="panel space-y-3 p-4">
      <h2 id="material-deletion-title" className="text-base font-semibold">
        {t('material.deletion')}
      </h2>
      <p className="max-w-3xl text-sm text-ink-soft">{t('material.deletionNote')}</p>
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-line text-ink-soft">
              <th className="py-2 pe-3">Scope</th>
              <th className="py-2 pe-3">{t('material.status')}</th>
              <th className="py-2 pe-3">Stock</th>
              {canMaintain && <th className="py-2">Actions</th>}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-line/60">
              <td className="py-2 pe-3 font-medium">{t('material.deletionClient')}</td>
              <td className="py-2 pe-3">
                {clientFlagged ? t('material.flagged') : t('material.notFlagged')}
              </td>
              <td className="py-2 pe-3">{clientStock}</td>
              {canMaintain && <td className="py-2">{act('CLIENT', '', !clientFlagged, clientStock)}</td>}
            </tr>
            {plants.map((row) => {
              const effective = row.flagged || clientFlagged;
              return (
                <tr key={row.plant} className="border-b border-line/60">
                  <td className="py-2 pe-3 font-medium">
                    {t('material.deletionPlant', { plant: row.plant })}
                  </td>
                  <td className="py-2 pe-3">
                    {effective ? t('material.flagged') : t('material.notFlagged')}
                    {clientFlagged && !row.flagged && (
                      <span className="block text-xs text-ink-soft">
                        Covered by the client-level flag
                      </span>
                    )}
                  </td>
                  <td className="py-2 pe-3">{row.stock}</td>
                  {canMaintain && (
                    <td className="py-2">{act('PLANT', row.plant, !row.flagged, row.stock)}</td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {confirming && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
          <div className="w-full max-w-md space-y-3 border border-line bg-white p-4 shadow-lg">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold">
                {confirming.flagged ? 'Flag for deletion' : 'Cancel deletion flag'}
                {' — '}
                {confirming.scope === 'PLANT'
                  ? t('material.deletionPlant', { plant: confirming.plant })
                  : t('material.deletionClient')}
              </h3>
              <button type="button" className="btn btn-default" onClick={() => setConfirming(null)}>
                Close
              </button>
            </div>
            <form action={action} className="space-y-3">
              <input type="hidden" name="materialNumber" value={materialNumber} />
              <input type="hidden" name="scope" value={confirming.scope} />
              <input type="hidden" name="plant" value={confirming.plant} />
              <input type="hidden" name="flagged" value={confirming.flagged ? 'true' : 'false'} />
              <p className="text-sm text-ink-soft">
                {t('material.deletionStock', { stock: confirming.stock })} The flag marks
                this scope for deletion; it stops no posting and deletes nothing, and it
                can be cancelled at any time.
              </p>
              <div>
                <label htmlFor="deletion-flag-reason" className="text-sm font-medium">
                  Reason<span className="ms-1 text-signal-error" aria-hidden="true">*</span>
                </label>
                <input
                  id="deletion-flag-reason"
                  name="reason"
                  required
                  className="input mt-1 w-full"
                />
              </div>
              <button type="submit" className="btn btn-primary">
                {confirming.flagged ? 'Flag for deletion' : 'Cancel flag'}
              </button>
              <Message state={state} />
            </form>
          </div>
        </div>
      )}
      {!confirming && <Message state={state} />}
    </section>
  );
}
