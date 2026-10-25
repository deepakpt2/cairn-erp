'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { OrderTypeParameterRow } from '@/modules/production/order-type-parameters';
import { saveOrderTypeParameterAction, type OrderParameterActionState } from './actions';

const INITIAL: OrderParameterActionState = { ok: false };
const LOCK_OBJECT = 'PRODUCTION_ORDER_TYPE_PARAMETER';

function selectionLabel(value: string): string {
  if (value === '0') return '0 automatic';
  if (value === '1') return '1 manual';
  return 'Blank';
}

export default function OrderTypeParameterForm({
  parameters,
  canMaintain,
}: {
  parameters: OrderTypeParameterRow[];
  canMaintain: boolean;
}) {
  const [editing, setEditing] = useState<OrderTypeParameterRow | null>(null);
  const [state, action, pending] = useActionState(saveOrderTypeParameterAction, INITIAL);
  const lock = useChangeLock(
    LOCK_OBJECT,
    editing ? `${editing.plant}/${editing.orderType}` : null,
    'OPL8',
    canMaintain && Boolean(editing),
  );

  return (
    <div className="space-y-4">
      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Plant and order type</h2>
        <p className="mt-1 text-sm text-ink-soft">Opening this list does not create a record and does not create an order.</p>
        {parameters.length === 0 ? (
          <p className="mt-2 text-sm">No order type-dependent parameters stand.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Plant</th>
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Category</th>
                <th className="px-2 py-2">Task list</th>
                <th className="px-2 py-2">Version selection</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {parameters.map((row) => (
                <tr key={`${row.plant}/${row.orderType}`} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{row.plant}</td>
                  <td className="px-2 py-2 code">{row.orderType}</td>
                  <td className="px-2 py-2 code">{row.orderCategory}</td>
                  <td className="px-2 py-2 code">{row.taskListType ?? '—'}</td>
                  <td className="px-2 py-2">{selectionLabel(row.productionVersionSelection)}</td>
                  {canMaintain && (
                    <td className="px-2 py-2">
                      <button type="button" className="btn btn-default min-h-11 sm:min-h-8" onClick={() => setEditing(row)}>Change</button>
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      {canMaintain && (
        <form key={editing ? `${editing.plant}/${editing.orderType}` : 'new'} action={action} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">{editing ? 'Change parameters' : 'Create parameters'}</h2>
          {editing && <LockNotice message={lock?.message} />}
          {state.message && (
            <p role="status" className={state.ok ? 'text-sm' : 'text-sm text-red-700'}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}
          <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={editing?.version ?? 0} />
          <label className="block text-sm">
            Plant
            <input name="plant" defaultValue={editing?.plant ?? ''} maxLength={10} className="field-input code mt-1 w-full" readOnly={Boolean(editing)} required />
          </label>
          <label className="block text-sm">
            Order type
            <input name="orderType" defaultValue={editing?.orderType ?? ''} maxLength={4} className="field-input code mt-1 w-full" readOnly={Boolean(editing)} required />
          </label>
          <label className="block text-sm">
            Task list type
            <input name="taskListType" defaultValue={editing?.taskListType ?? ''} maxLength={1} className="field-input code mt-1 w-full" />
          </label>
          <label className="block text-sm">
            Production version selection
            <select name="productionVersionSelection" defaultValue={editing?.productionVersionSelection ?? ' '} className="field-input mt-1 w-full">
              <option value=" ">Blank</option>
              <option value="0">0 — Automatic selection of production version</option>
              <option value="1">1 — Manual selection of production version</option>
            </select>
          </label>
          <p className="text-sm text-ink-soft">Blank is the initial value, not a documented selection method. Saving a value does not select a version or create an order.</p>
          <label className="block text-sm">
            Reason
            <input name="reason" className="field-input mt-1 w-full" required />
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save parameters</button>
        </form>
      )}
    </div>
  );
}
