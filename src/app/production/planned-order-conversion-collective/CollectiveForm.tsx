'use client';

import { useActionState, useMemo } from 'react';

import { conversionOutcomeText } from '@/modules/production/conversion-outcome';
import { convertPlannedOrdersAction, type CollectiveConvertState } from './actions';
import type { ConversionPreview } from '@/modules/production/planned-order-conversion';

const initial: CollectiveConvertState = { ok: false };

export default function CollectiveForm({ rows }: { rows: ConversionPreview[] }) {
  const [state, action, pending] = useActionState(convertPlannedOrdersAction, initial);
  const correlationId = useMemo(
    () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `co41-${Date.now()}`),
    [],
  );
  return (
    <form action={action} className="mt-4 space-y-3 text-sm">
      <input type="hidden" name="correlationId" value={correlationId} />
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-ink-faint">
            <th>Select</th>
            <th>Order</th>
            <th>Material</th>
            <th>Quantity</th>
            <th>Eligibility</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.orderNumber} data-co41-order={row.orderNumber}>
              <td><input type="checkbox" name="orderNumber" value={row.orderNumber} /></td>
              <td>{row.orderNumber}</td>
              <td>{row.materialNumber}</td>
              <td>{row.quantity} {row.unit}</td>
              <td>{row.productionOrderNumber ? `Converted ${row.productionOrderNumber}` : row.eligible ? 'Eligible' : row.blockedReason}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <label className="block">
        Order type
        <input name="orderType" maxLength={4} className="input code mt-1" required />
      </label>
      <p className="text-ink-soft">One type is applied to every selected order. It is not taken from the material or from the first standing type.</p>
      <label className="block">
        Production version
        <input name="productionVersion" maxLength={4} className="input code mt-1" />
      </label>
      <p className="text-ink-soft">One version is applied to every selected order when the parameters use manual selection. It is checked against each order. Automatic selection does not require it.</p>
      <label className="flex items-center gap-2">
        <input type="checkbox" name="confirm" value="X" />
        Convert the selected orders. Each order is saved on its own. The quantity is not reduced.
      </label>
      <button className="btn" type="submit" disabled={pending}>Convert selected</button>
      {state.message && <p className={state.ok ? 'text-ink' : 'text-danger'}>{state.message}{state.remedy ? ` ${state.remedy}` : ''}</p>}
      {state.correlationId && <p>Batch {state.correlationId}. This is the audit correlation, not a second order.</p>}
      {state.results?.map((result) => (
        <div key={result.plannedOrderNumber}>
          <p data-co41-result={result.status} data-co41-reconciliation={result.reconciliation}>
            {result.plannedOrderNumber ? `${result.plannedOrderNumber} · ` : ''}{result.status} · {result.productionOrderNumber ?? result.message}
            {' · '}{conversionOutcomeText(result.status, result.reconciliation)}
          </p>
          {result.warnings.map((warning, index) => (
            <p key={`${result.plannedOrderNumber}-${index}`} data-co41-warning>{warning}</p>
          ))}
        </div>
      ))}
    </form>
  );
}
