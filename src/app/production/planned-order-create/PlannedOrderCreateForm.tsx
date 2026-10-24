'use client';

import { useActionState, useMemo } from 'react';

import { createPlannedOrderAction, type PlannedOrderCreateState } from './actions';

const initial: PlannedOrderCreateState = { ok: false };

export default function PlannedOrderCreateForm({
  plant,
  materialNumber,
  quantity,
  unit,
  startDate,
  finishDate,
  referenceOrder,
}: {
  plant: string;
  materialNumber: string;
  quantity: string;
  unit: string;
  startDate: string;
  finishDate: string;
  referenceOrder: string;
}) {
  const [state, action, pending] = useActionState(createPlannedOrderAction, initial);
  const requestKey = useMemo(
    () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `planned-${Date.now()}`),
    [],
  );
  const note = state.message;

  return (
    <div className="mt-4 space-y-3">
      {note && <p className={`text-sm ${state.ok ? 'text-ink' : 'text-danger'}`}>{note}{state.remedy ? ` ${state.remedy}` : ''}</p>}
      {state.warnings?.map((warning) => <p key={warning} className="text-sm">{warning}</p>)}
      {state.order && (
        <p className="text-sm" data-md11-order={state.order.orderNumber}>
          {state.order.orderNumber} · {state.order.quantity} {state.order.unit} · {state.order.firmingStatus === 'FIRMED' ? 'firmed' : 'not firmed'} · {state.order.origin === 'MANUAL' ? 'created by hand' : state.order.origin}
        </p>
      )}
      <form action={action} className="grid gap-2 sm:grid-cols-2">
        <input type="hidden" name="requestKey" value={requestKey} />
        <label className="text-sm">Plant
          <input className="input mt-1 w-full" name="plant" defaultValue={plant} maxLength={10} required />
        </label>
        <label className="text-sm">Material
          <input className="input mt-1 w-full" name="materialNumber" defaultValue={materialNumber} maxLength={40} required />
        </label>
        <label className="text-sm">Quantity
          <input className="input mt-1 w-full" name="quantity" defaultValue={quantity} required />
        </label>
        <label className="text-sm">Unit
          <input className="input mt-1 w-full" name="unit" defaultValue={unit} maxLength={6} placeholder="Material base unit" />
        </label>
        <label className="text-sm">Start
          <input className="input mt-1 w-full" type="date" name="startDate" defaultValue={startDate} />
        </label>
        <label className="text-sm">Finish
          <input className="input mt-1 w-full" type="date" name="finishDate" defaultValue={finishDate} />
        </label>
        <label className="text-sm">Reference planned order
          <input className="input mt-1 w-full" name="referenceOrder" defaultValue={referenceOrder} maxLength={12} placeholder="Optional" />
        </label>
        <button className="btn" type="submit" disabled={pending}>{pending ? 'Creating' : 'Create'}</button>
      </form>
      <p className="text-sm text-ink-soft">
        The number is drawn from the range. The order is firmed and marked as created by hand.
        A missing date is counted from the in-house days. A factory calendar is not used.
        This save does not explode a bill of material, does not convert the order, and does not post.
      </p>
    </div>
  );
}
