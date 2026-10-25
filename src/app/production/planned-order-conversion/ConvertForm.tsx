'use client';

import { useActionState } from 'react';

import { conversionOutcomeText } from '@/modules/production/conversion-outcome';
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
      <label className="block">
        Order type
        <input name="orderType" maxLength={4} className="input code mt-1" required />
      </label>
      <p className="text-ink-soft">No scheduling profile, scheduler, MRP group, or plant parameter supplies a type. The material does not imply one. The first type is not chosen.</p>
      <label className="block">
        Production version
        <input name="productionVersion" maxLength={4} className="input code mt-1" />
      </label>
      <p className="text-ink-soft">Required when the order type parameters use manual selection. Automatic selection does not require it and does not take the first of several matches. This is not a search filter.</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="confirm" value="X" />
        Convert the whole planned order. The quantity is not reduced.
      </label>
      <button className="btn" type="submit" disabled={pending}>Convert</button>
      {state.message && (
        <p className={state.result?.reconciliation === 'PARTIAL' || !state.ok ? 'text-danger' : 'text-ink'} data-co40-result={state.result?.status ?? ''} data-co40-reconciliation={state.result?.reconciliation ?? ''}>
          {state.message}{state.remedy ? ` ${state.remedy}` : ''}
        </p>
      )}
      {state.result && (
        <p data-co40-outcome={state.result.reconciliation}>
          {conversionOutcomeText(state.result.status, state.result.reconciliation)}
        </p>
      )}
      {state.result?.warnings && state.result.warnings.length > 0 && (
        <ul data-co40-warnings>
          {state.result.warnings.map((warning) => <li key={warning}>{warning}</li>)}
        </ul>
      )}
      {state.result?.productionOrderNumber && (
        <p data-co40-production-order={state.result.productionOrderNumber}>
          Production order {state.result.productionOrderNumber} · {state.result.productionOrderStatus}
        </p>
      )}
    </form>
  );
}
