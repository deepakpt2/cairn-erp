'use client';

import { useActionState, useState } from 'react';

import type { OriginalBudgetView } from '@/modules/foundation/internal-order-budget';
import { saveOriginalBudgetAction, type BudgetActionState } from './actions';

const INITIAL: BudgetActionState = { ok: false };

export default function BudgetForm({ budget }: { budget: OriginalBudgetView }) {
  const [state, action, pending] = useActionState(saveOriginalBudgetAction, INITIAL);
  const [overall, setOverall] = useState(budget.overallAmount ?? '');
  const [documentDate, setDocumentDate] = useState('2026-04-01');
  const [text, setText] = useState('');
  const [years, setYears] = useState(budget.annual.map((row) => ({ fiscalYear: String(row.fiscalYear), amount: row.amount })));
  const payload = JSON.stringify({
    orderNumber: budget.orderNumber,
    documentDate,
    overallAmount: overall,
    documentText: text,
    annual: years.filter((row) => row.fiscalYear && row.amount).map((row) => ({
      fiscalYear: Number(row.fiscalYear),
      amount: row.amount,
    })),
  });

  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="payload" value={payload} />
      {state.message && (
        <p className={state.ok ? 'text-sm' : 'text-sm text-red-700'} role={state.ok ? 'status' : 'alert'}>{state.message}</p>
      )}
      <p className="text-sm text-ink-soft">
        Currency {budget.currency}. Profile {budget.budgetProfile ?? 'none'}. Availability control is {budget.availabilityControl ? 'marked on the profile and is not executed' : 'not active'}. Supplements, returns, and carryforward are not this screen.
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Document date</span>
          <input className="input w-full" type="date" value={documentDate} onChange={(event) => setDocumentDate(event.target.value)} />
        </label>
        <label className="block text-sm">
          <span className="mb-1 block text-ink-soft">Overall original budget</span>
          <input className="input w-full" value={overall} onChange={(event) => setOverall(event.target.value)} />
        </label>
        <label className="block text-sm sm:col-span-2">
          <span className="mb-1 block text-ink-soft">Text</span>
          <input className="input w-full" value={text} maxLength={50} onChange={(event) => setText(event.target.value)} />
        </label>
      </div>
      <div className="space-y-2">
        <h2 className="text-sm font-semibold">Annual original budget</h2>
        {years.map((row, index) => (
          <div key={index} className="flex gap-2">
            <input className="input w-28" value={row.fiscalYear} onChange={(event) => setYears(years.map((item, itemIndex) => itemIndex === index ? { ...item, fiscalYear: event.target.value } : item))} />
            <input className="input" value={row.amount} onChange={(event) => setYears(years.map((item, itemIndex) => itemIndex === index ? { ...item, amount: event.target.value } : item))} />
          </div>
        ))}
        <button className="btn btn-default min-h-11 sm:min-h-8" type="button" onClick={() => setYears([...years, { fiscalYear: '', amount: '' }])}>Add year</button>
      </div>
      <button className="btn btn-primary min-h-11 sm:min-h-8" type="submit" disabled={pending || !budget.changeAllowed}>
        {pending ? 'Saving' : 'Save original budget'}
      </button>
    </form>
  );
}
