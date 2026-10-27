'use client';

import { useActionState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { BankChoice, PaymentRunView } from '@/modules/finance/payment-run';
import {
  cancelRunAction, createRunAction, executeAction, proposalAction,
  type PaymentRunActionState,
} from './actions';

const INITIAL: PaymentRunActionState = { ok: false, message: '' };

function Message({ state }: { state: PaymentRunActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-red-700'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

export default function PaymentRun({ run, runs, banks, canExecute, today }: {
  run: PaymentRunView | null;
  runs: Array<{ runDate: string; runId: string; status: string; postingDate: string }>;
  banks: BankChoice[];
  canExecute: boolean;
  today: string;
}) {
  const [createState, createAction, creating] = useActionState(createRunAction, INITIAL);
  const [proposalState, proposalActionState, proposing] = useActionState(proposalAction, INITIAL);
  const [executeState, executeActionState, executing] = useActionState(executeAction, INITIAL);
  const [cancelState, cancelActionState, cancelling] = useActionState(cancelRunAction, INITIAL);
  const editable = run && run.status !== 'EXECUTED' && run.status !== 'CANCELLED';
  const runLock = useChangeLock(
    'PAYMENT_RUN',
    run ? `${run.runDate}/${run.runId}` : '',
    'FIN.AP.PAYMENTRUN.EXECUTE',
    Boolean(run && editable && canExecute),
  );
  const runHeld = runLock?.mode === 'CHANGE';

  return (
    <>
      <section aria-labelledby="pr-status" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-status" className="text-sm font-semibold">Status</h2>
        <form method="get" action="/finance/payment-run" className="mt-3 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Run date</span>
            <input type="date" name="runDate" className="input" defaultValue={run?.runDate ?? today} />
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Identification</span>
            <input name="runId" className="input w-28" maxLength={5} defaultValue={run?.runId ?? ''} placeholder="APR01" />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load run</button>
        </form>
        {runs.length > 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            Standing runs: {runs.map((r) => `${r.runDate}/${r.runId} (${r.status})`).join(' · ')}
          </p>
        )}
        {run ? (
          <p className="mt-2 text-sm">
            Run <strong>{run.runDate}/{run.runId}</strong> stands <strong>{run.status}</strong>;
            posting date {run.postingDate}, documents entered up to {run.documentCutoffDate},
            next payment date {run.nextPaymentDate}.
          </p>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">No payment run stands selected.</p>
        )}
        <Message state={cancelState} />
        <LockNotice message={runLock?.mode === 'DISPLAY' ? runLock.message : null} remedy={runLock?.remedy} />
        {editable && (
          <form action={cancelActionState} className="mt-2">
            <input type="hidden" name="runDate" value={run.runDate} />
            <input type="hidden" name="runId" value={run.runId} />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canExecute || cancelling || !runHeld}>
              Cancel run
            </button>
          </form>
        )}
      </section>

      <section aria-labelledby="pr-parameters" className="rounded-card border border-line bg-surface p-4 shadow-card">
        <h2 id="pr-parameters" className="text-sm font-semibold">Parameters</h2>
        <Message state={createState} />
        <form action={createAction}>
          <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Run date</span>
              <input type="date" name="runDate" className="input w-full" defaultValue={run?.runDate ?? today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Identification</span>
              <input name="runId" className="input w-full" maxLength={5} placeholder="APR01" defaultValue={run?.runId ?? ''} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Posting date</span>
              <input type="date" name="postingDate" className="input w-full" defaultValue={run?.postingDate ?? today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Documents entered up to</span>
              <input type="date" name="documentCutoffDate" className="input w-full" defaultValue={run?.documentCutoffDate ?? today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Next payment date</span>
              <input type="date" name="nextPaymentDate" className="input w-full" defaultValue={run?.nextPaymentDate ?? today} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company codes</span>
              <input name="companies" className="input w-full" placeholder="1000" defaultValue={run?.companies.map((c) => c.companyCode).join(', ') ?? ''} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Payment methods</span>
              <input name="methods" className="input w-full" placeholder="T" defaultValue={run?.methods.join(', ') ?? ''} required />
            </label>
            <label className="block">
              <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Supplier range</span>
              <input name="supplierFrom" className="input w-full" placeholder="From supplier" defaultValue={run?.supplierFrom ?? ''} />
            </label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canExecute || creating}>
              Save parameters
            </button>
          </div>
        </form>
        {run && editable && (
          <form action={proposalActionState} className="mt-2">
            <input type="hidden" name="runDate" value={run.runDate} />
            <input type="hidden" name="runId" value={run.runId} />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canExecute || proposing || !runHeld}>
              Create proposal
            </button>
          </form>
        )}
        <Message state={proposalState} />
      </section>

      {run && (run.status === 'PROPOSAL' || run.status === 'EXECUTED') && (
        <section aria-labelledby="pr-proposal" className="rounded-card border border-line bg-surface p-4 shadow-card">
          <h2 id="pr-proposal" className="text-sm font-semibold">Proposal</h2>
          {run.proposal.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">The proposal is empty: no open items match the selection.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Supplier</th><th className="px-2 py-2">Invoice</th>
                    <th className="px-2 py-2">Due</th><th className="px-2 py-2">Amount</th>
                    <th className="px-2 py-2">Method</th><th className="px-2 py-2">Exception</th>
                  </tr>
                </thead>
                <tbody>
                  {run.proposal.map((item) => (
                    <tr key={item.itemNumber} className="border-t border-line">
                      <td className="px-2 py-2">{item.accountId}</td>
                      <td className="px-2 py-2">{item.invoiceNumber ?? item.journalDocumentNumber}</td>
                      <td className="px-2 py-2">{item.dueDate}</td>
                      <td className="px-2 py-2">{item.amount} {item.currency}</td>
                      <td className="px-2 py-2">{item.paymentMethod ?? '—'}</td>
                      <td className="px-2 py-2">{item.exceptionText ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-sm text-ink-soft">
            Payable total {run.payableTotal.toFixed(2)} · {run.exceptionCount} exceptions.
          </p>
          <Message state={executeState} />
          {run.status === 'PROPOSAL' && run.payments.length === 0 && (
            <form action={executeActionState} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="runDate" value={run.runDate} />
              <input type="hidden" name="runId" value={run.runId} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">House bank / account</span>
                <select name="bankChoice" className="input" disabled>
                  {banks.map((b) => (
                    <option key={`${b.companyCode}-${b.houseBankKey}-${b.accountId}`}>
                      {b.companyCode} · {b.houseBankKey}/{b.accountId} ({b.currency})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">House bank</span>
                <input name="houseBankKey" className="input w-24" placeholder="HB01" required />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Account ID</span>
                <input name="bankAccountId" className="input w-24" placeholder="MAIN" required />
              </label>
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canExecute || executing || !runHeld}>
                Execute payments
              </button>
            </form>
          )}
          {run.payments.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th className="px-2 py-2">Supplier</th><th className="px-2 py-2">Invoice</th>
                    <th className="px-2 py-2">Amount</th><th className="px-2 py-2">Journal</th>
                    <th className="px-2 py-2">Bank</th>
                  </tr>
                </thead>
                <tbody>
                  {run.payments.map((p) => (
                    <tr key={p.itemNumber} className="border-t border-line">
                      <td className="px-2 py-2">{p.accountId}</td>
                      <td className="px-2 py-2">{p.invoiceNumber ?? '—'}</td>
                      <td className="px-2 py-2">{p.amount} {p.currency}</td>
                      <td className="px-2 py-2">{p.journalDocumentNumber}</td>
                      <td className="px-2 py-2">{p.houseBankKey}/{p.bankAccountId}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </>
  );
}
