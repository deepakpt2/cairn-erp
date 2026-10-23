'use client';

import { useActionState, useState } from 'react';

import { createSchedulingReleasesAction, type ReleaseActionState } from './actions';

const INITIAL: ReleaseActionState = { ok: false };

export default function ReleaseForm({ agreement }: { agreement: string }) {
  const [state, action, pending] = useActionState(createSchedulingReleasesAction, INITIAL);
  const [agreementFrom, setAgreementFrom] = useState(agreement);
  const [agreementTo, setAgreementTo] = useState(agreement);
  const [supplier, setSupplier] = useState('');
  const [org, setOrg] = useState('');
  const [group, setGroup] = useState('');
  const [plant, setPlant] = useState('');
  const [itemFrom, setItemFrom] = useState('');
  const [itemTo, setItemTo] = useState('');
  const [forecast, setForecast] = useState(true);
  const [jit, setJit] = useState(false);
  const [profile, setProfile] = useState('');
  const [generationDate, setGenerationDate] = useState('');
  const releaseTypes = [forecast ? 'FRC' : '', jit ? 'JIT' : ''].filter(Boolean);
  const payload = JSON.stringify({
    agreementFrom,
    agreementTo,
    supplierNumber: supplier,
    purchasingOrg: org,
    purchasingGroup: group,
    plant,
    itemFrom: itemFrom ? Number(itemFrom) : undefined,
    itemTo: itemTo ? Number(itemTo) : undefined,
    releaseTypes,
    profileCode: profile,
    generationDate,
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Agreement from</span>
          <input className="input w-full" value={agreementFrom} maxLength={20} onChange={(event) => setAgreementFrom(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Agreement to</span>
          <input className="input w-full" value={agreementTo} maxLength={20} onChange={(event) => setAgreementTo(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Supplier</span>
          <input className="input w-full" value={supplier} maxLength={40} onChange={(event) => setSupplier(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Purchasing organization</span>
          <input className="input w-full" value={org} maxLength={10} onChange={(event) => setOrg(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Purchasing group</span>
          <input className="input w-full" value={group} maxLength={3} onChange={(event) => setGroup(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Plant</span>
          <input className="input w-full" value={plant} maxLength={10} onChange={(event) => setPlant(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Item from</span>
          <input className="input w-full" value={itemFrom} onChange={(event) => setItemFrom(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Item to</span>
          <input className="input w-full" value={itemTo} onChange={(event) => setItemTo(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Generation date</span>
          <input className="input w-full" type="date" value={generationDate} onChange={(event) => setGenerationDate(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Release profile, optional</span>
          <input className="input w-full" value={profile} maxLength={10} onChange={(event) => setProfile(event.target.value)} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={forecast} onChange={(event) => setForecast(event.target.checked)} />
        Forecast
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={jit} onChange={(event) => setJit(event.target.checked)} />
        JIT
      </label>
      <p className="text-sm text-ink-soft">
        A release is created only when the document type uses release documentation and a release profile is configured. No horizon or tolerance is assumed. The supplier is not notified. Background execution is not available.
      </p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || releaseTypes.length === 0}>
        {pending ? 'Creating' : 'Create releases'}
      </button>
      {state.result && (
        <div className="space-y-2 text-sm">
          {state.result.created.map((row) => (
            <p key={`${row.releaseNumber}-${row.reused}`}>
              {row.reused ? 'Already created' : 'Created'} {row.releaseNumber} · {row.agreementNumber} item {row.itemNumber} · {row.releaseType} · {row.releasedQuantity}. {row.transmissionDetail}
            </p>
          ))}
          {state.result.skipped.map((row, index) => (
            <p key={`skip-${index}`}>{row.agreementNumber}{row.itemNumber ? ` item ${row.itemNumber}` : ''}{row.releaseType ? ` ${row.releaseType}` : ''}: {row.reason}</p>
          ))}
          {state.result.failed.map((row, index) => (
            <p key={`fail-${index}`} className="text-red-700">{row.agreementNumber}: {row.reason}</p>
          ))}
        </div>
      )}
    </form>
  );
}
