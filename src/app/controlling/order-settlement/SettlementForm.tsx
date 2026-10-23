'use client';

import { useActionState, useState } from 'react';

import { settleOrderAction, type SettlementActionState } from './actions';

const INITIAL: SettlementActionState = { ok: false };

export default function SettlementForm({ orderNumber }: { orderNumber: string }) {
  const [state, action, pending] = useActionState(settleOrderAction, INITIAL);
  const [order, setOrder] = useState(orderNumber);
  const [fiscalYear, setFiscalYear] = useState('2026');
  const [settlementPeriod, setSettlementPeriod] = useState('1');
  const [controllingArea, setControllingArea] = useState('');
  const [testRun, setTestRun] = useState(true);
  const [checkTransactionData, setCheckTransactionData] = useState(false);
  const payload = JSON.stringify({
    orderNumber: order,
    fiscalYear: Number(fiscalYear),
    settlementPeriod: Number(settlementPeriod),
    controllingArea,
    testRun,
    checkTransactionData,
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      <p className="text-sm" role="note">
        Update posts only when a settlement rule is already stored. A receiver and a percentage are not entered here. The rule screen is /controlling/settlement-rules. KO02 and KO8B are not this screen.
      </p>
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Internal order</span>
          <input className="input w-full" value={order} maxLength={20} onChange={(event) => setOrder(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Fiscal year</span>
          <input className="input w-full" value={fiscalYear} onChange={(event) => setFiscalYear(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Settlement period</span>
          <input className="input w-full" value={settlementPeriod} onChange={(event) => setSettlementPeriod(event.target.value)} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Controlling area, only to check the order</span>
          <input className="input w-full" value={controllingArea} maxLength={4} onChange={(event) => setControllingArea(event.target.value)} />
        </label>
      </div>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={testRun} onChange={(event) => setTestRun(event.target.checked)} />
        Test run. Nothing is posted.
      </label>
      <label className="flex min-h-11 items-center gap-2 text-sm">
        <input type="checkbox" checked={checkTransactionData} onChange={(event) => setCheckTransactionData(event.target.checked)} />
        Check transaction data. That check is not configured.
      </label>
      <p className="text-sm text-ink-soft">
        Processing type, asset value date, posting period, order group, selection variant, and background execution are not configured. This screen does not send them. The year and period are what you enter.
      </p>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending}>
        {pending ? 'Checking' : testRun ? 'Simulate' : 'Update'}
      </button>
      {state.result && (
        <div className="space-y-1 text-sm">
          <p>Posted: {state.result.posted ? 'yes' : 'no'}. Settled: {state.result.settled}. Selected: {state.result.selected}.</p>
          {state.result.documents.map((document) => (
            <p key={document.documentNumber}>{document.documentNumber} · {document.amount} · {document.postingDate}</p>
          ))}
          {state.result.orders.map((row) => (
            <p key={row.orderNumber}>{row.orderNumber} · {row.companyCode} · {row.currency}: {row.reasons.join(' ')} {row.receivers.map((receiver) => `${receiver.receiver} ${receiver.amount}`).join(', ')}</p>
          ))}
          {state.result.gaps.map((gap) => <p key={gap}>{gap}</p>)}
        </div>
      )}
    </form>
  );
}
