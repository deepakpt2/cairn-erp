'use client';

import { useActionState } from 'react';

import { changeBatchAction, type ChangeBatchState } from './actions';
import type { BatchChangeRow } from '@/modules/inventory/batch-change';

const empty: ChangeBatchState = { ok: false };

export default function ChangeBatchForm({ batch, statusActive }: { batch: BatchChangeRow; statusActive: boolean }) {
  const [state, action, pending] = useActionState(changeBatchAction, empty);
  const version = state.version ?? batch.version;

  return (
    <form action={action} className="space-y-3 border border-line bg-white p-4">
      <p className="text-sm">
        Material <span className="code">{batch.materialNumber}</span>
        {batch.plant ? <> · Plant <span className="code">{batch.plant}</span></> : null}
        {' '}· Batch <span className="code">{batch.batchNumber}</span>
        {' '}· Version <span className="code">{version}</span>
      </p>
      <p className="text-xs text-ink-soft">The material, plant, and batch number cannot be changed. This screen does not assign a new number and does not post stock.</p>
      <input type="hidden" name="materialNumber" value={batch.materialNumber} />
      <input type="hidden" name="plant" value={batch.plant ?? ''} />
      <input type="hidden" name="batchNumber" value={batch.batchNumber} />
      <input type="hidden" name="version" value={version} />
      {statusActive && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Restricted-use indicator</legend>
          {batch.restrictedUse === null && (
            <label className="flex gap-2 text-sm">
              <input type="radio" name="restrictedUse" value="KEEP" defaultChecked />
              <span>Leave the indicator unset. This does not post movements 341 or 342.</span>
            </label>
          )}
          <label className="flex gap-2 text-sm">
            <input type="radio" name="restrictedUse" value="" defaultChecked={batch.restrictedUse === ''} />
            <span>Blank — unrestricted. Not the number 1.</span>
          </label>
          <label className="flex gap-2 text-sm">
            <input type="radio" name="restrictedUse" value="X" defaultChecked={batch.restrictedUse === 'X'} />
            <span><span className="code">X</span> — restricted. Not the number 2.</span>
          </label>
        </fieldset>
      )}
      <label className="block text-sm">
        Date of manufacture
        <input name="manufactureDate" type="date" defaultValue={batch.manufactureDate ?? ''} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Shelf-life expiration date
        <input name="shelfLifeExpirationDate" type="date" defaultValue={batch.shelfLifeExpirationDate ?? ''} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Vendor batch number
        <input name="vendorBatch" maxLength={15} defaultValue={batch.vendorBatch ?? ''} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Country of origin
        <input name="countryOfOrigin" maxLength={2} defaultValue={batch.countryOfOrigin ?? ''} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Reason
        <input name="reason" required minLength={3} maxLength={500} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <button type="submit" className="btn btn-primary min-h-11" disabled={pending}>
        {pending ? 'Saving' : 'Save batch'}
      </button>
      {state.message && (
        <div role={state.ok ? 'status' : 'alert'} className="border border-line p-3 text-sm">
          <p>{state.message}</p>
          {state.remedy && <p className="mt-1 text-xs text-ink-soft">{state.remedy}</p>}
        </div>
      )}
    </form>
  );
}
