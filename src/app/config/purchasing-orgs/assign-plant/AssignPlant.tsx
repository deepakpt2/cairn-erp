'use client';

import { useActionState, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { PurchasingOrgPlantRow } from '@/modules/purchasing/purchasing-org-plant-assignment';
import {
  assignPurchasingOrgPlantAction,
  checkPurchasingOrgPlantAction,
  removePurchasingOrgPlantAction,
  type PurchasingOrgPlantActionState,
} from './actions';

function RequiredMark() {
  return <span className="ms-1 text-signal-error" aria-hidden="true">*</span>;
}

function Message({ state }: { state: PurchasingOrgPlantActionState }) {
  if (!state.message) return null;
  return (
    <div role={state.ok ? 'status' : 'alert'} className="border border-line bg-white p-3 text-sm text-ink">
      <p>{state.message}</p>
      {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
    </div>
  );
}

const empty: PurchasingOrgPlantActionState = { ok: false };

export default function AssignPlant({
  assignments,
  organisations,
  plants,
  canAssign,
}: {
  assignments: PurchasingOrgPlantRow[];
  organisations: Array<{ purchasingOrg: string; name: string; companyCode: string | null }>;
  plants: Array<{ plant: string; name: string; companyCode: string | null }>;
  canAssign: boolean;
}) {
  const router = useRouter();
  const [selected, setSelected] = useState<string | null>(null);
  const [requestKey, setRequestKey] = useState('');
  const [removeKey, setRemoveKey] = useState('');
  const [saveState, saveAction, savePending] = useActionState(assignPurchasingOrgPlantAction, empty);
  const [checkState, checkAction, checkPending] = useActionState(checkPurchasingOrgPlantAction, empty);
  const [removeState, removeAction, removePending] = useActionState(removePurchasingOrgPlantAction, empty);
  const row = assignments.find((item) => `${item.purchasingOrg}/${item.plant}` === selected) ?? null;
  const assignmentLock = useChangeLock(
    'PURCHASING_ORG_PLANT',
    row ? `${row.purchasingOrg}/${row.plant}` : '',
    'CFG.PROC.PURORG.ASSIGN_PLANT',
    Boolean(row) && canAssign,
  );

  useEffect(() => {
    setRequestKey((current) => current || crypto.randomUUID());
    setRemoveKey((current) => current || crypto.randomUUID());
  }, []);

  useEffect(() => {
    if (saveState.ok || removeState.ok) router.refresh();
  }, [saveState, removeState, router]);

  return (
    <div className="space-y-4">
      <Message state={saveState} />
      <Message state={checkState} />
      <Message state={removeState} />

      <section aria-labelledby="plant-assignments-heading" className="space-y-3">
        <h2 id="plant-assignments-heading" className="text-base font-semibold">Standing assignments</h2>
        {assignments.length === 0 ? (
          <p className="text-sm text-ink-soft">No purchasing organisation is assigned to a plant.</p>
        ) : (
          <div className="overflow-x-auto border border-line">
            <table className="w-full text-sm">
              <thead className="bg-paper text-left text-ink-soft">
                <tr>
                  <th className="px-3 py-2 font-medium">Purchasing organisation</th>
                  <th className="px-3 py-2 font-medium">Plant</th>
                  <th className="px-3 py-2 font-medium">Plant company code</th>
                  <th className="px-3 py-2 font-medium">Cited</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((item) => (
                  <tr key={`${item.purchasingOrg}/${item.plant}`} className="border-t border-line">
                    <td className="px-3 py-2">
                      <button type="button" className="code text-left underline" onClick={() => setSelected(`${item.purchasingOrg}/${item.plant}`)}>
                        {item.purchasingOrg}
                      </button>
                      <span className="ms-2 text-ink-soft">{item.purchasingOrgName}</span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="code">{item.plant}</span>
                      <span className="ms-2 text-ink-soft">{item.plantName}</span>
                    </td>
                    <td className="px-3 py-2">{item.plantCompanyCode ?? '—'}</td>
                    <td className="px-3 py-2">{item.citations.purchaseOrders + item.citations.requestsForQuotation + item.citations.sourceList + item.citations.infoRecords + item.citations.quotas || 'No'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {canAssign && (
        <form action={saveAction} className="space-y-3 border border-line p-3">
          <h2 className="text-base font-semibold">Assign</h2>
          <p className="text-sm text-ink-soft">
            The company code is read from the plant. It is not entered here. One organisation may buy for several plants of its company. A closed posting period does not block this assignment.
          </p>
          <input type="hidden" name="requestKey" value={requestKey} />
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="assign-plant-org" className="text-sm font-medium">
                Purchasing organisation<RequiredMark />
              </label>
              <select id="assign-plant-org" name="purchasingOrg" required className="input mt-1 w-full" defaultValue="">
                <option value="">Choose</option>
                {organisations.map((item) => (
                  <option key={item.purchasingOrg} value={item.purchasingOrg}>
                    {item.purchasingOrg} · {item.name}{item.companyCode ? ` · ${item.companyCode}` : ''}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="assign-plant-plant" className="text-sm font-medium">
                Plant<RequiredMark />
              </label>
              <select id="assign-plant-plant" name="plant" required className="input mt-1 w-full" defaultValue="">
                <option value="">Choose</option>
                {plants.map((item) => (
                  <option key={item.plant} value={item.plant}>
                    {item.plant} · {item.name}{item.companyCode ? ` · ${item.companyCode}` : ' · no company code'}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label htmlFor="assign-plant-reason" className="text-sm font-medium">
              Reason<RequiredMark />
            </label>
            <input id="assign-plant-reason" name="reason" required className="input mt-1 w-full" />
          </div>
          <button type="submit" className="btn btn-primary min-h-11" disabled={savePending}>
            Save
          </button>
        </form>
      )}

      {canAssign && row && (
        <div className="flex flex-wrap gap-2">
          <form action={checkAction}>
            <input type="hidden" name="purchasingOrg" value={row.purchasingOrg} />
            <input type="hidden" name="plant" value={row.plant} />
            <button type="submit" className="btn btn-default min-h-11" disabled={checkPending}>Check</button>
          </form>
          <form
            action={removeAction}
            className="flex flex-wrap items-end gap-2"
            onSubmit={(event) => {
              if (assignmentLock?.mode !== 'CHANGE') event.preventDefault();
            }}
          >
            <input type="hidden" name="purchasingOrg" value={row.purchasingOrg} />
            <input type="hidden" name="plant" value={row.plant} />
            <input type="hidden" name="requestKey" value={removeKey} />
            <div>
              <label htmlFor="assign-plant-remove-reason" className="text-sm font-medium">
                Remove reason<RequiredMark />
              </label>
              <input id="assign-plant-remove-reason" name="reason" required className="input mt-1" />
            </div>
            <LockNotice message={assignmentLock?.mode === 'DISPLAY' ? assignmentLock.message : null} remedy={assignmentLock?.remedy} />
            <button type="submit" className="btn btn-default min-h-11" disabled={removePending || assignmentLock?.mode !== 'CHANGE'}>Remove</button>
          </form>
        </div>
      )}
    </div>
  );
}
