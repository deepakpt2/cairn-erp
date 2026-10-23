'use client';

import { useActionState, useState } from 'react';

import { createPlanRevaluationAction, type PlanRevaluationActionState } from './actions';

const INITIAL: PlanRevaluationActionState = { ok: false };

export default function RevaluationForm({
  areas,
  orderNumber,
}: {
  areas: { controllingArea: string; name: string; currency: string }[];
  orderNumber: string;
}) {
  const [state, action, pending] = useActionState(createPlanRevaluationAction, INITIAL);
  const [area, setArea] = useState(areas[0]?.controllingArea ?? '');
  const [fiscalYear, setFiscalYear] = useState('2026');
  const [periodFrom, setPeriodFrom] = useState('1');
  const [periodTo, setPeriodTo] = useState('1');
  const [planVersion, setPlanVersion] = useState('');
  const [description, setDescription] = useState('Plan revaluation');
  const [orderFrom, setOrderFrom] = useState(orderNumber);
  const [orderTo, setOrderTo] = useState(orderNumber);
  const currency = areas.find((row) => row.controllingArea === area)?.currency ?? '';
  const payload = JSON.stringify({
    controllingArea: area,
    fiscalYear: Number(fiscalYear),
    periodFrom: Number(periodFrom),
    periodTo: Number(periodTo),
    planVersion,
    description,
    orderFrom,
    orderTo,
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Controlling area</span>
          <select className="input w-full" value={area} onChange={(event) => setArea(event.target.value)}>
            {areas.map((row) => <option key={row.controllingArea} value={row.controllingArea}>{row.controllingArea} · {row.name}</option>)}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Currency</span>
          <input className="input w-full" value={currency} readOnly />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Fiscal year</span>
          <input className="input w-full" value={fiscalYear} onChange={(event) => setFiscalYear(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Plan version</span>
          <input className="input w-full" value={planVersion} maxLength={3} onChange={(event) => setPlanVersion(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Period from</span>
          <input className="input w-full" value={periodFrom} onChange={(event) => setPeriodFrom(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Period to</span>
          <input className="input w-full" value={periodTo} onChange={(event) => setPeriodTo(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order from</span>
          <input className="input w-full" value={orderFrom} maxLength={20} onChange={(event) => setOrderFrom(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order to</span>
          <input className="input w-full" value={orderTo} maxLength={20} onChange={(event) => setOrderTo(event.target.value)} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Description</span>
          <input className="input w-full" value={description} maxLength={40} onChange={(event) => setDescription(event.target.value)} />
        </label>
      </div>
      <p className="text-sm text-ink-soft">
        No percentage is entered. Saving does not change plan amounts. KOP2, KOP3, KOP4, and KOPU are not this screen.
      </p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>
        {pending ? 'Saving' : 'Create definition'}
      </button>
      {state.result && (
        <div className="text-sm">
          <p>{state.result.revaluationNumber} · not executed</p>
          <p>Orders: {state.result.orders.join(', ') || 'none'}</p>
          {state.result.excluded.map((row) => <p key={row.orderNumber}>{row.orderNumber}: {row.reason}</p>)}
        </div>
      )}
    </form>
  );
}
