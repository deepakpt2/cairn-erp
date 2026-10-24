'use client';

import { useActionState } from 'react';

import { ChangeLock } from '@/ui/lock/ChangeLock';
import { PLANNED_ORDER_LOCK } from '@/modules/production/planned-order-change';
import type { PlannedOrderView } from '@/modules/production/planned-order-display';
import { changePlannedOrderAction, type PlannedOrderChangeState } from './actions';

const initial: PlannedOrderChangeState = { ok: false };

export default function PlannedOrderForm({ document }: { document: PlannedOrderView }) {
  const [state, action, pending] = useActionState(changePlannedOrderAction, initial);
  const shown = state.order ?? document;
  const note = state.message;

  return (
    <div className="mt-4 space-y-3">
      <ChangeLock lockObject={PLANNED_ORDER_LOCK} argument={document.orderNumber} />
      {note && <p className={`text-sm ${state.ok ? 'text-ink' : 'text-danger'}`}>{note}{state.remedy ? ` ${state.remedy}` : ''}</p>}
      {state.warnings?.map((warning) => <p key={warning} className="text-sm">{warning}</p>)}
      <form key={shown.version} action={action} className="grid gap-2 sm:grid-cols-2">
        <input type="hidden" name="orderNumber" value={shown.orderNumber} />
        <input type="hidden" name="version" value={shown.version} />
        <input type="hidden" name="materialNumber" value={shown.materialNumber} />
        <input type="hidden" name="plant" value={shown.plant} />
        <input type="hidden" name="unit" value={shown.unit} />
        <label className="text-sm">Quantity
          <input className="input mt-1 w-full" name="quantity" defaultValue={shown.quantity} required />
        </label>
        <p className="text-sm">Unit {shown.unit}. A different unit is not substituted.</p>
        <label className="text-sm">Start
          <input className="input mt-1 w-full" type="date" name="startDate" defaultValue={shown.startDate} required />
        </label>
        <label className="text-sm">Finish
          <input className="input mt-1 w-full" type="date" name="finishDate" defaultValue={shown.finishDate} required />
        </label>
        <label className="text-sm">Firming
          <select className="input mt-1 w-full" name="firmingStatus" defaultValue={shown.firmingStatus}>
            <option value="OPEN">Not firmed</option>
            <option value="FIRMED">Firmed</option>
          </select>
        </label>
        <button className="btn" type="submit" disabled={pending}>{pending ? 'Saving' : 'Save'}</button>
      </form>
      <p className="text-sm text-ink-soft">A change of quantity or dates firms the order. Unfirming is a later save. This save does not convert the order and does not post.</p>
    </div>
  );
}
