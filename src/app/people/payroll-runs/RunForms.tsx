'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

import type { PayrollOperationView } from '@/modules/people/payroll-background';
import {
  cancelOperationAction,
  payrollOperationStatusAction,
  cancelRunAction,
  paySalaryRunAction,
  postPayrollRunAction,
  proposeRunAction,
  recalculateRunAction,
  releaseRunAction,
  type PayrollRunActionState,
} from './actions';

function Status({ state }: { state: PayrollRunActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
      {state.ok && state.runId ? (
        <> <Link href={`/people/payroll-runs?run=${state.runId}`} className="underline">Open the run</Link></>
      ) : null}
    </p>
  );
}

const ACTIVE = ['QUEUED', 'RUNNING'];

/**
 * The latest background operation of the run: status, real progress (the employee count is frozen when
 * the calculation starts), the reason it failed, and a cancel. Polling reads one small row every few
 * seconds and refreshes the page when the operation ends, so a reload recovers the same view.
 */
export function OperationPanel({ operation }: { operation: PayrollOperationView | null }) {
  const router = useRouter();
  const [op, setOp] = useState(operation);
  const [cancel, cancelAction, cancelling] = useActionState(cancelOperationAction, { ok: false });
  useEffect(() => setOp(operation), [operation]);
  const active = op ? ACTIVE.includes(op.status) : false;
  useEffect(() => {
    if (!active || !op) return;
    const id = op.operationId;
    const timer = setInterval(async () => {
      try {
        const next = await payrollOperationStatusAction(id);
        if (!next) return;
        setOp(next);
        if (!ACTIVE.includes(next.status)) {
          clearInterval(timer);
          router.refresh();
        }
      } catch {
        // A failed poll is not a failed operation; the next tick tries again.
      }
    }, 3000);
    return () => clearInterval(timer);
  }, [active, op?.operationId, router]);
  if (!op) return null;
  const label = op.kind === 'POST' ? 'Posting' : op.kind === 'PROPOSE' ? 'Proposal' : 'Recalculation';
  return (
    <section className="panel space-y-2 p-4" aria-label="Background operation" data-payroll-operation={op.operationId}>
      <h2 className="panel-title">{label} <span className="chip ml-1" data-payroll-operation-status>{op.status.toLowerCase()}</span></h2>
      {active && op.kind !== 'POST' && (
        <p className="text-sm" data-payroll-operation-progress>
          {op.employeesTotal > 0 ? `Calculated ${op.employeesDone} of ${op.employeesTotal} employees.` : 'Waiting for the worker to select the employees.'}
        </p>
      )}
      {active && op.kind === 'POST' && <p className="text-sm">Waiting for the worker. Nothing is posted until it finishes, and then it is one document or none.</p>}
      {op.status === 'SUCCEEDED' && <p className="text-sm">Finished.</p>}
      {(op.status === 'FAILED' || op.status === 'CANCELLED') && (
        <p role="alert" className={`text-sm ${op.status === 'FAILED' ? 'text-signal-error' : ''}`} data-payroll-operation-error>
          {op.errorText ?? `The ${label.toLowerCase()} ${op.status.toLowerCase()}.`}{' '}
          {op.kind === 'POST' ? 'The run is not posted.' : 'The run keeps the proposal it had before.'}
        </p>
      )}
      {active && (
        <form action={cancelAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="operationId" value={op.operationId} />
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={cancelling}>Cancel {label.toLowerCase()}</button>
          <span className="text-xs text-ink-soft">A calculation stops at its next chunk. A posting already inside its transaction finishes or rolls back whole.</span>
        </form>
      )}
      <Status state={cancel} />
    </section>
  );
}

export function ProposeRunForm({
  companies,
  defaultCompany,
  defaultYear,
  defaultPeriod,
  requestKey,
}: {
  companies: Array<{ companyCode: string; name: string; currency: string }>;
  defaultCompany: string;
  defaultYear: number;
  defaultPeriod: number;
  requestKey: string;
}) {
  const [state, action, pending] = useActionState(proposeRunAction, { ok: false, requestKey });
  return (
    <form action={action} className="panel space-y-3 p-4">
      <h2 className="panel-title">Propose a run</h2>
      <input type="hidden" name="requestKey" value={state.requestKey ?? requestKey} />
      <div className="grid gap-3 sm:grid-cols-3">
        <label>
          <span className="field-label">Company code</span>
          <select name="companyCode" className="field-input w-full" defaultValue={defaultCompany} required>
            {companies.map((c) => (
              <option key={c.companyCode} value={c.companyCode}>{c.companyCode} — {c.name} ({c.currency})</option>
            ))}
          </select>
        </label>
        <label>
          <span className="field-label">Fiscal year</span>
          <input type="number" name="fiscalYear" className="field-input w-full" required min={1900} max={9999} defaultValue={defaultYear} />
        </label>
        <label>
          <span className="field-label">Period</span>
          <select name="period" className="field-input w-full" defaultValue={String(defaultPeriod)} required>
            {Array.from({ length: 16 }, (_, i) => i + 1).map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <p className="text-xs text-ink-soft">
        Every employee holding a position in the company during the period is selected. Employees who are not ready are
        listed as exceptions with the reason; nothing is posted.
      </p>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending}>Propose</button>
      <Status state={state} />
    </form>
  );
}

export function RunActions({ runId, status, exceptionCount, mayPost, busy = false }: { runId: string; status: string; exceptionCount: number; mayPost: boolean; busy?: boolean }) {
  const [recalc, recalcAction, recalcPending] = useActionState(recalculateRunAction, { ok: false });
  const [post, postAction, postPending] = useActionState(postPayrollRunAction, { ok: false });
  const [release, releaseAction, releasePending] = useActionState(releaseRunAction, { ok: false });
  const [cancel, cancelAction, cancelPending] = useActionState(cancelRunAction, { ok: false });
  const proposed = status === 'PROPOSED';
  const cancellable = status === 'PROPOSED' || status === 'RELEASED';
  return (
    <section className="panel space-y-3 p-4" aria-label="Run actions">
      <h2 className="panel-title">Actions</h2>
      {proposed && (
        <div className="flex flex-wrap gap-3">
          <form action={recalcAction}>
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={recalcPending || busy}>Recalculate</button>
          </form>
          <form action={releaseAction}>
            <input type="hidden" name="runId" value={runId} />
            <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={releasePending || busy}>Release</button>
          </form>
          {exceptionCount > 0 && (
            <p className="self-center text-xs text-ink-soft">Release is refused while {exceptionCount} employee{exceptionCount === 1 ? '' : 's'} stand{exceptionCount === 1 ? 's' : ''} as exceptions.</p>
          )}
        </div>
      )}
      <Status state={recalc} />
      <Status state={release} />
      {status === 'RELEASED' && mayPost && (
        <form action={postAction} className="flex flex-wrap items-center gap-3">
          <input type="hidden" name="runId" value={runId} />
          <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={postPending || busy}>Post to G/L</button>
          <span className="text-xs text-ink-soft">One PR document, dated the last day of the period. A posted run cannot be cancelled or posted again.</span>
        </form>
      )}
      {status === 'RELEASED' && !mayPost && (
        <p className="text-sm text-ink-soft">Posting this run needs PEOPLE.PAYROLL.POST and FIN.JOURNAL.POST.</p>
      )}
      <Status state={post} />
      {cancellable && (
        <form action={cancelAction} className="flex flex-wrap items-end gap-3">
          <input type="hidden" name="runId" value={runId} />
          <label className="min-w-64 flex-1">
            <span className="field-label">Reason for cancelling</span>
            <input name="reason" className="field-input w-full" required maxLength={200} />
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={cancelPending || busy}>Cancel run</button>
        </form>
      )}
      <Status state={cancel} />
      {!proposed && !cancellable && <p className="text-sm text-ink-soft">This run is {status.toLowerCase()}; nothing more can be done to it here.</p>}
      {status === 'RELEASED' && <p className="text-sm text-ink-soft">Released runs are frozen: they are never recalculated.</p>}
      {status === 'POSTED' && <p className="text-sm text-ink-soft">A posted run is never cancelled or re-run. A correction is a reversal of its document and a new run in a later period.</p>}
    </section>
  );
}

/**
 * Pay a posted run from one house-bank account. One option per house-bank/account pair; the choice is
 * submitted as two named inputs, `houseBankKey` and `bankAccountId`, as the payment run screen does.
 */
export function PaySalaryForm({
  runId,
  defaultDate,
  banks,
}: {
  runId: string;
  defaultDate: string;
  banks: Array<{ houseBankKey: string; accountId: string; currency: string; glAccount: string }>;
}) {
  const [state, action, pending] = useActionState(paySalaryRunAction, { ok: false });
  const [first] = banks;
  const [houseBankKey, setHouseBankKey] = useState(first?.houseBankKey ?? '');
  const [accountId, setAccountId] = useState(first?.accountId ?? '');
  return (
    <form action={action} className="panel space-y-3 p-4" aria-label="Pay salaries">
      <h2 className="panel-title">Pay salaries</h2>
      <input type="hidden" name="runId" value={runId} />
      <input type="hidden" name="houseBankKey" value={houseBankKey} />
      <input type="hidden" name="bankAccountId" value={accountId} />
      {banks.length === 0 ? (
        <p className="text-sm text-ink-soft">
          The company has no house-bank account to pay from. Define one at <Link href="/config/house-banks" className="underline">/config/house-banks</Link>.
        </p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          <label>
            <span className="field-label">Payment date</span>
            <input type="date" name="paymentDate" className="field-input w-full" required defaultValue={defaultDate} />
          </label>
          <label>
            <span className="field-label">Pay from</span>
            <select
              className="field-input w-full"
              value={`${houseBankKey}/${accountId}`}
              onChange={(event) => {
                const [bank = '', account = ''] = event.target.value.split('/');
                setHouseBankKey(bank);
                setAccountId(account);
              }}
            >
              {banks.map((b) => (
                <option key={`${b.houseBankKey}/${b.accountId}`} value={`${b.houseBankKey}/${b.accountId}`}>
                  {b.houseBankKey} / {b.accountId} — {b.currency} (G/L {b.glAccount})
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
      <p className="text-xs text-ink-soft">
        One PY document: a debit per employee on the net pay payable, one credit to the bank. The payroll document&apos;s
        payable is cleared. A run is paid once.
      </p>
      <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={pending || banks.length === 0}>Pay</button>
      <Status state={state} />
    </form>
  );
}
