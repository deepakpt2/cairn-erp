'use client';

import { useActionState } from 'react';

import { createCostEstimateAction, type CostEstimateActionState } from './actions';

const initial: CostEstimateActionState = { ok: false };

export function CostEstimateForm({ plants, plant, materialNumber, costingDate, costingLotSize, planVersion, requestKey }: {
  plants: Array<{ plant: string; name: string }>; plant: string; materialNumber: string; costingDate: string;
  costingLotSize: string; planVersion: string; requestKey: string;
}) {
  const [state, action, pending] = useActionState(createCostEstimateAction, initial);
  return (
    <form action={action} className="panel space-y-3 p-3" aria-label="Create a cost estimate">
      <h2 className="panel-title">Create a standard cost estimate (CK11N)</h2>
      <input type="hidden" name="requestKey" value={requestKey} />
      <div className="flex flex-wrap items-end gap-3">
        <label>
          <span className="field-label">Material</span>
          <input name="materialNumber" defaultValue={materialNumber} required maxLength={40} className="field-input code w-36" />
        </label>
        <label>
          <span className="field-label">Plant</span>
          <select name="plant" defaultValue={plant} className="field-input">
            {plants.map((p) => <option key={p.plant} value={p.plant}>{p.plant} — {p.name}</option>)}
          </select>
        </label>
        <label>
          <span className="field-label">Costing date</span>
          <input type="date" name="costingDate" defaultValue={costingDate} required className="field-input" />
        </label>
        <label>
          <span className="field-label">Costing lot size</span>
          <input name="costingLotSize" defaultValue={costingLotSize} inputMode="decimal" className="field-input w-28" placeholder="BOM base qty" />
        </label>
        <label>
          <span className="field-label">Costing version</span>
          <input name="costingVersion" maxLength={2} className="field-input code w-16" placeholder="auto" />
        </label>
        <label>
          <span className="field-label">Plan version</span>
          <input name="planVersion" defaultValue={planVersion} maxLength={3} className="field-input code w-16" />
        </label>
        <button type="submit" disabled={pending} className="btn btn-primary min-h-11 sm:min-h-8">{pending ? 'Costing…' : 'Cost and save'}</button>
      </div>
      <p className="text-xs text-ink-soft">
        The estimate is saved and nothing else happens: no price is changed. Releasing an estimate to the material master is a separate step.
      </p>
      {state.message && (
        <p role="alert" className="text-sm text-signal-error">{state.message}{state.remedy ? ` ${state.remedy}` : ''}</p>
      )}
    </form>
  );
}
