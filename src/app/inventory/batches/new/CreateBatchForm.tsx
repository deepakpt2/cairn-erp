'use client';

import { useActionState, useEffect, useState } from 'react';

import { useChangeLock } from '@/ui/lock/ChangeLock';

import { createBatchAction, type CreateBatchState } from './actions';

const empty: CreateBatchState = { ok: false };

export default function CreateBatchForm({
  plantRequired,
  statusActive,
  canCreate,
}: {
  plantRequired: boolean;
  statusActive: boolean;
  canCreate: boolean;
}) {
  const [materialNumber, setMaterialNumber] = useState('');
  const [plant, setPlant] = useState('');
  const [batchNumber, setBatchNumber] = useState('');
  const lockArgument = [materialNumber, plantRequired ? plant : '', batchNumber].filter(Boolean).join('/');
  const lock = useChangeLock('BATCH', lockArgument || null, 'MSC1N', canCreate && lockArgument.length > 0);
  const writable = canCreate && lock?.mode !== 'DISPLAY';
  const [requestKey, setRequestKey] = useState('');
  const [state, action, pending] = useActionState(createBatchAction, empty);

  useEffect(() => {
    setRequestKey((key) => key || crypto.randomUUID());
  }, []);

  return (
    <form action={action} className="space-y-3 border border-line bg-white p-4">
      {lock?.mode === 'DISPLAY' && lock.message && (
        <p role="status" className="border border-line p-3 text-sm">{lock.message}</p>
      )}
      <label className="block text-sm">
        Material
        <input name="materialNumber" required maxLength={40} value={materialNumber} onChange={(event) => setMaterialNumber(event.target.value)} disabled={!canCreate} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      {plantRequired && (
        <label className="block text-sm">
          Plant
          <input name="plant" required maxLength={10} value={plant} onChange={(event) => setPlant(event.target.value)} disabled={!canCreate} className="mt-1 w-full border border-line px-2 py-1" />
        </label>
      )}
      <label className="block text-sm">
        Batch number
        <input name="batchNumber" required maxLength={10} value={batchNumber} onChange={(event) => setBatchNumber(event.target.value)} disabled={!canCreate} className="mt-1 w-full border border-line px-2 py-1" />
        <span className="mt-1 block text-xs text-ink-soft">Type the number. Internal assignment is not active. Leading zeros are kept.</span>
      </label>
      {statusActive && (
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">Restricted-use indicator</legend>
          <label className="flex gap-2 text-sm">
            <input type="radio" name="restrictedUse" value="DERIVE" defaultChecked />
            <span>Material-type initial status. Leave this selected unless you are overriding it.</span>
          </label>
          <label className="flex gap-2 text-sm">
            <input type="radio" name="restrictedUse" value="" />
            <span>Blank — unrestricted. Not the number 1.</span>
          </label>
          <label className="flex gap-2 text-sm">
            <input type="radio" name="restrictedUse" value="X" />
            <span><span className="code">X</span> — restricted. Not the number 2.</span>
          </label>
        </fieldset>
      )}
      <label className="block text-sm">
        Date of manufacture
        <input name="manufactureDate" type="date" disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Shelf-life expiration date
        <input name="shelfLifeExpirationDate" type="date" disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Vendor batch number
        <input name="vendorBatch" maxLength={15} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Country of origin
        <input name="countryOfOrigin" maxLength={2} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <label className="block text-sm">
        Reason
        <input name="reason" required minLength={3} maxLength={500} disabled={!writable} className="mt-1 w-full border border-line px-2 py-1" />
      </label>
      <input type="hidden" name="requestKey" value={requestKey} />
      <button type="submit" className="btn btn-primary min-h-11" disabled={!writable || pending}>
        {pending ? 'Creating' : 'Create batch'}
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
