'use client';

import { useActionState } from 'react';

import { convertPlannedOrderAction, type PlannedOrderConvertState } from './actions';

const initial: PlannedOrderConvertState = { ok: false };

export default function ConvertForm({
  orderNumber,
  expectedVersion,
}: {
  orderNumber: string;
  expectedVersion: number;
}) {
  const [state, action, pending] = useActionState(convertPlannedOrderAction, initial);
  return (
    <form action={action} className="mt-4 space-y-3 text-sm">
      <input type="hidden" name="orderNumber" value={orderNumber} />
      <input type="hidden" name="expectedVersion" value={String(expectedVersion)} />
      <label className="flex items-center gap-2">
        <input type="checkbox" name="confirm" value="X" />
        Convert the whole planned order. The quantity is not reduced.
      </label>
      <button className="btn" type="submit" disabled={pending}>Convert</button>
      {state.message && (
        <p className={state.ok ? 'text-ink' : 'text-danger'} data-co40-result={state.result?.status ?? 'FAILED'}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      {state.result?.productionOrderNumber && (
        <p data-co40-production-order={state.result.productionOrderNumber}>
          Production order {state.result.productionOrderNumber} · {state.result.productionOrderStatus}
        </p>
      )}
    </form>
  );
}
