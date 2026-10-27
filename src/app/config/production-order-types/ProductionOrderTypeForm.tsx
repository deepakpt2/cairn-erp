'use client';

import { useActionState, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { ProductionOrderTypeRow } from '@/modules/production/production-order-type';
import { saveProductionOrderTypeAction, type OrderTypeActionState } from './actions';

const INITIAL: OrderTypeActionState = { ok: false };
const LOCK_OBJECT = 'PRODUCTION_ORDER_TYPE';

export default function ProductionOrderTypeForm({
  types,
  canMaintain,
}: {
  types: ProductionOrderTypeRow[];
  canMaintain: boolean;
}) {
  const [editing, setEditing] = useState<ProductionOrderTypeRow | null>(null);
  const [state, action, pending] = useActionState(saveProductionOrderTypeAction, INITIAL);
  const lock = useChangeLock(LOCK_OBJECT, editing?.orderType ?? null, 'OPJH', canMaintain && Boolean(editing));

  return (
    <div className="space-y-4">
      <section className="border border-line bg-white p-4">
        <h2 className="text-sm font-semibold">Order types</h2>
        <p className="mt-1 text-sm text-ink-soft">Opening this list does not create a type and does not create an order.</p>
        {types.length === 0 ? (
          <p className="mt-2 text-sm">No production order type stands.</p>
        ) : (
          <table className="mt-2 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left">
                <th className="px-2 py-2">Type</th>
                <th className="px-2 py-2">Description</th>
                <th className="px-2 py-2">Category</th>
                {canMaintain && <th className="px-2 py-2">Action</th>}
              </tr>
            </thead>
            <tbody>
              {types.map((row) => (
                <tr key={row.orderType} className="border-b border-line/60">
                  <td className="px-2 py-2 code">{row.orderType}</td>
                  <td className="px-2 py-2">{row.description}</td>
                  <td className="px-2 py-2 code">{row.orderCategory}</td>
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
        <form key={editing?.orderType ?? 'new'} action={action} className="space-y-3 border border-line bg-white p-4">
          <h2 className="text-sm font-semibold">{editing ? 'Change order type' : 'Create order type'}</h2>
          {editing && <LockNotice message={lock?.message} remedy={lock?.remedy} />}
          {state.message && (
            <p role="status" className={state.ok ? 'text-sm' : 'text-sm text-red-700'}>
              {state.message}{state.remedy ? ` ${state.remedy}` : ''}
            </p>
          )}
          <input type="hidden" name="mode" value={editing ? 'CHANGE' : 'CREATE'} />
          <input type="hidden" name="version" value={editing?.version ?? 0} />
          <label className="block text-sm">
            Order type
            <input name="orderType" defaultValue={editing?.orderType ?? ''} maxLength={4} className="field-input code mt-1 w-full" readOnly={Boolean(editing)} required />
          </label>
          <label className="block text-sm">
            Description
            <input name="description" defaultValue={editing?.description ?? ''} maxLength={40} className="field-input mt-1 w-full" required />
          </label>
          <p className="text-sm text-ink-soft">Category 10 is stored. A plant, a number range, and checking control are not entered.</p>
          <label className="block text-sm">
            Reason
            <input name="reason" className="field-input mt-1 w-full" required />
          </label>
          <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>Save order type</button>
        </form>
      )}
    </div>
  );
}
