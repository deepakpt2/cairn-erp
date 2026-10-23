'use client';

import { useActionState, useState } from 'react';

import { settleOrdersCollectiveAction, type CollectiveSettlementActionState } from './actions';

const INITIAL: CollectiveSettlementActionState = { ok: false };

export default function CollectiveForm({
  areas,
}: {
  areas: { controllingArea: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(settleOrdersCollectiveAction, INITIAL);
  const [area, setArea] = useState(areas[0]?.controllingArea ?? '');
  const [orderFrom, setOrderFrom] = useState('');
  const [orderTo, setOrderTo] = useState('');
  const [orderType, setOrderType] = useState('');
  const [fiscalYear, setFiscalYear] = useState('2026');
  const [settlementPeriod, setSettlementPeriod] = useState('1');
  const [testRun, setTestRun] = useState(true);
  const payload = JSON.stringify({
    controllingArea: area,
    orderFrom,
    orderTo,
    orderType,
    fiscalYear: Number(fiscalYear),
    settlementPeriod: Number(settlementPeriod),
    testRun,
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <p className="text-sm" role="note">
        A collective update posts only an order that already has a settlement rule. No receiver is assumed. This is not KO88.
      </p>
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Controlling area</span>
          <select className="input w-full" value={area} onChange={(event) => setArea(event.target.value)}>
            {areas.map((row) => (
              <option key={row.controllingArea} value={row.controllingArea}>{row.controllingArea} · {row.name}</option>
            ))}
          </select>
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order from</span>
          <input className="input w-full" value={orderFrom} maxLength={20} onChange={(event) => setOrderFrom(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order to</span>
          <input className="input w-full" value={orderTo} maxLength={20} onChange={(event) => setOrderTo(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Order type, optional</span>
          <input className="input w-full" value={orderType} maxLength={4} onChange={(event) => setOrderType(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Fiscal year</span>
          <input className="input w-full" value={fiscalYear} onChange={(event) => setFiscalYear(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Settlement period</span>
          <input className="input w-full" value={settlementPeriod} onChange={(event) => setSettlementPeriod(event.target.value)} />
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={testRun} onChange={(event) => setTestRun(event.target.checked)} />
        Test run. Nothing is posted.
      </label>
      <p className="text-sm text-ink-soft">
        Order groups, selection variants, processing type, and background execution are not configured. The year and period are what you enter.
      </p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>
        {pending ? 'Checking' : testRun ? 'Simulate' : 'Update'}
      </button>
      {state.result && (
        <div className="space-y-1 text-sm">
          <p>Posted: {state.result.posted ? 'yes' : 'no'}. Settled: {state.result.settled}. Selected: {state.result.selected}.</p>
          {state.result.documents.map((document) => (
            <p key={document.documentNumber}>{document.orderNumber} · {document.documentNumber} · {document.amount}</p>
          ))}
          {state.result.orders.map((row) => (
            <p key={row.orderNumber}>{row.orderNumber} · {row.companyCode} · {row.currency}: {row.reasons.join(' ')}</p>
          ))}
          {state.result.gaps.map((gap) => <p key={gap}>{gap}</p>)}
        </div>
      )}
    </form>
  );
}
