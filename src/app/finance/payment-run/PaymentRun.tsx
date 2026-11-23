'use client';

import { fmtFlex } from '@/ui/money';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';
import { LockNotice, useChangeLock } from '@/ui/lock/ChangeLock';

import type { BankChoice, PaymentRunView } from '@/modules/finance/payment-run';
import { paymentInstructionCanonical } from '@/modules/finance/payment-run-instruction';
import type { PaymentOperationView } from '@/modules/finance/payment-run-background';
import type { DocumentReleaseState } from '@/modules/purchasing/release';
import { ReleasePanel } from '@/ui/release/ReleasePanel';
import {
  cancelOperationAction, paymentOperationStatusAction,
  cancelRunAction, cancelRunReleaseAction, createRunAction, executeAction, proposalAction, releaseRunAction,
  type PaymentRunActionState,
} from './actions';

const INITIAL: PaymentRunActionState = { ok: false, message: '' };

function Message({ state }: { state: PaymentRunActionState }) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

const ACTIVE = ['QUEUED', 'RUNNING'];

type BankGroup = PaymentRunView['proposal'][number];

/**
 * One actual-bank-amount field per company/supplier/currency group. This component is deliberately
 * keyed by the complete instruction canonical: any bank, proposal, source-journal, amount or release
 * change unmounts it, so returning to an earlier selection cannot resurrect an old amount.
 */
function ActualBankAmountFields({
  groups, banks, houseBankKey, bankAccountId, instructionKey,
}: {
  groups: BankGroup[];
  banks: BankChoice[];
  houseBankKey: string;
  bankAccountId: string;
  instructionKey: string;
}) {
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const bankFor = (companyCode: string) => banks.find((b) => b.companyCode === companyCode
    && b.houseBankKey === houseBankKey && b.accountId === bankAccountId);
  return (
    <div className="contents" data-instruction-key={instructionKey}>
      {groups.map((g) => {
        const groupKey = `${g.companyCode}|${g.accountId}|${g.currency}`;
        const bank = bankFor(g.companyCode);
        const bankCurrency = bank?.currency?.trim().toUpperCase() ?? null;
        const sameCurrency = bankCurrency !== null && bankCurrency === g.currency.trim().toUpperCase();
        return (
          <label
            key={groupKey}
            className="block"
            data-bank-amount-group={groupKey}
            data-bank-currency={bankCurrency ?? ''}
            data-payment-currency={g.currency}
          >
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">
              Actual bank amount · {g.companyCode}/{g.accountId} · payment {g.currency} → bank {bankCurrency ?? 'select bank'}
            </span>
            {sameCurrency ? (
              <span className="text-xs text-ink-soft" data-bank-same-currency>
                Same currency — the bank movement is the payment amount; no separate entry.
              </span>
            ) : (
              <input
                name={`bankAmount~${g.companyCode}~${g.accountId}~${g.currency}`}
                className="input w-40"
                placeholder={`In ${bankCurrency ?? 'bank currency'}`}
                aria-label={`Actual bank amount in ${bankCurrency ?? 'bank currency'} for supplier ${g.accountId} paying ${g.currency}`}
                value={amounts[groupKey] ?? ''}
                onChange={(event) => setAmounts((previous) => ({
                  ...previous, [groupKey]: event.target.value,
                }))}
              />
            )}
          </label>
        );
      })}
    </div>
  );
}

/**
 * The latest background operation of the run: status, real progress (the item count is frozen when a
 * proposal starts), the reason it failed, and a cancel. It polls one small row and refreshes the page when
 * the operation ends, so a reload recovers the same view.
 */
function OperationPanel({ operation, canExecute }: { operation: PaymentOperationView | null; canExecute: boolean }) {
  const router = useRouter();
  const [op, setOp] = useState(operation);
  const [cancel, cancelAction, cancelling] = useActionState(cancelOperationAction, INITIAL);
  useEffect(() => setOp(operation), [operation]);
  const active = op ? ACTIVE.includes(op.status) : false;
  useEffect(() => {
    if (!active || !op) return;
    const id = op.operationId;
    const timer = setInterval(async () => {
      try {
        const next = await paymentOperationStatusAction(id);
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
  const label = op.kind === 'EXECUTE' ? 'Execution' : 'Proposal';
  return (
    <section aria-label="Background operation" className="border border-line bg-surface p-4" data-payment-operation={op.operationId}>
      <h2 className="text-sm font-semibold">{label} <span data-payment-operation-status>{op.status.toLowerCase()}</span></h2>
      {active && op.kind === 'PROPOSAL' && (
        <p className="mt-2 text-sm" data-payment-operation-progress>
          {op.itemsTotal > 0 ? `Prepared ${op.itemsDone} of ${op.itemsTotal} items.` : 'Waiting for the worker to select the open items.'}
        </p>
      )}
      {active && op.kind === 'EXECUTE' && (
        <p className="mt-2 text-sm">Waiting for the worker. Nothing is posted until it finishes, and then it is all of it or none.</p>
      )}
      {op.status === 'SUCCEEDED' && <p className="mt-2 text-sm">Finished.</p>}
      {(op.status === 'FAILED' || op.status === 'CANCELLED') && (
        <p role="alert" className={`mt-2 text-sm ${op.status === 'FAILED' ? 'text-signal-error' : ''}`} data-payment-operation-error>
          {op.errorText ?? `The ${label.toLowerCase()} ${op.status.toLowerCase()}.`}{' '}
          {op.kind === 'EXECUTE' ? 'No payment was posted.' : 'The run keeps the proposal and release it had before.'}
        </p>
      )}
      {active && (
        <form action={cancelAction} className="mt-2 flex flex-wrap items-center gap-3">
          <input type="hidden" name="operationId" value={op.operationId} />
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canExecute || cancelling}>Cancel {label.toLowerCase()}</button>
          <span className="text-xs text-ink-soft">A proposal stops at its next chunk. An execution already inside its transaction finishes or rolls back whole.</span>
        </form>
      )}
      <Message state={cancel} />
    </section>
  );
}

export default function PaymentRun({ run, runs, banks, canExecute, today, release, canRelease, operation = null }: {
  run: PaymentRunView | null;
  runs: Array<{ runDate: string; runId: string; status: string; postingDate: string }>;
  banks: BankChoice[];
  canExecute: boolean;
  today: string;
  release: DocumentReleaseState | null;
  canRelease: boolean;
  operation?: PaymentOperationView | null;
}) {
  const [createState, createAction, creating] = useActionState(createRunAction, INITIAL);
  const [proposalState, proposalActionState, proposing] = useActionState(proposalAction, INITIAL);
  const [executeState, executeActionState, executing] = useActionState(executeAction, INITIAL);
  const [cancelState, cancelActionState, cancelling] = useActionState(cancelRunAction, INITIAL);
  const busy = operation ? ACTIVE.includes(operation.status) : false;
  // One bank movement per proposal group (company, supplier, currency). The actual bank amount is
  // only required when that group's currency differs from the selected bank account's currency.
  const bankGroups = run
    ? [...new Map(run.proposal.filter((p) => !p.exceptionCode)
      .map((p) => [`${p.companyCode}|${p.accountId}|${p.currency}`, p])).values()]
    : [];
  const [houseBankKey, setHouseBankKey] = useState('');
  const [bankAccountId, setBankAccountId] = useState('');
  const bankFor = (companyCode: string) => banks.find((b) => b.companyCode === companyCode
    && b.houseBankKey === houseBankKey && b.accountId === bankAccountId);
  // The complete material instruction, including every source journal identity and the release
  // state. The amount component is keyed by this, so a same-looking replacement invoice, a changed
  // bank, or an A→B→A bank switch starts from a fresh, empty confirmation.
  const instructionKey = run
    ? paymentInstructionCanonical({
      runDate: run.runDate, runId: run.runId, houseBankKey, bankAccountId,
      bankCurrencies: run.companies.map((company) => ({
        companyCode: company.companyCode,
        currency: bankFor(company.companyCode)?.currency ?? '',
        glAccount: bankFor(company.companyCode)?.glAccount ?? '',
      })),
      items: run.proposal,
      release,
    })
    : '';
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
      <section aria-labelledby="pr-status" className="border border-line bg-surface p-4">
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
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canExecute || cancelling || !runHeld || busy}>
              Cancel run
            </button>
          </form>
        )}
      </section>

      <OperationPanel operation={operation} canExecute={canExecute} />

      <section aria-labelledby="pr-parameters" className="border border-line bg-surface p-4">
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
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canExecute || proposing || !runHeld || busy}>
              Create proposal
            </button>
          </form>
        )}
        <Message state={proposalState} />
      </section>

      {run && run.status === 'PROPOSAL' && release && (
        <ReleasePanel
          id="pr-release"
          label="payment run"
          fields={{ runDate: run.runDate, runId: run.runId }}
          state={release}
          canRelease={canRelease}
          releaseAction={releaseRunAction}
          cancelAction={cancelRunReleaseAction}
          hint="It cannot be executed until it is fully released, and you cannot release a proposal you generated. Generating the proposal again starts the release over."
        />
      )}

      {run && (run.status === 'PROPOSAL' || run.status === 'EXECUTED') && (
        <section aria-labelledby="pr-proposal" className="border border-line bg-surface p-4">
          <h2 id="pr-proposal" className="text-sm font-semibold">Proposal</h2>
          {run.proposal.length === 0 ? (
            <p className="mt-2 text-sm text-ink-soft">The proposal is empty: no open items match the selection.</p>
          ) : (
            <div className="mt-3 overflow-x-auto">
              <table className="grid-table text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th>Supplier</th><th>Invoice</th>
                    <th>Due</th><th>Amount</th>
                    <th>Method</th><th>Exception</th>
                  </tr>
                </thead>
                <tbody>
                  {run.proposal.map((item) => (
                    <tr key={item.itemNumber}>
                      <td>{item.accountId}</td>
                      <td>{item.invoiceNumber ?? item.journalDocumentNumber}</td>
                      <td>{item.dueDate}</td>
                      <td>{item.amount} {item.currency}</td>
                      <td>{item.paymentMethod ?? '—'}</td>
                      <td>{item.exceptionText ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="mt-2 text-sm text-ink-soft">
            Payable total {fmtFlex(run.payableTotal)} · {run.exceptionCount} exceptions.
          </p>
          <Message state={executeState} />
          {run.status === 'PROPOSAL' && run.payments.length === 0 && (
            <form action={executeActionState} className="mt-3 flex flex-wrap items-end gap-3">
              <input type="hidden" name="runDate" value={run.runDate} />
              <input type="hidden" name="runId" value={run.runId} />
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">House bank / account</span>
                <select
                  className="input"
                  value={houseBankKey && bankAccountId ? `${houseBankKey}/${bankAccountId}` : ''}
                  onChange={(event) => {
                    const [key, account] = event.target.value.split('/');
                    setHouseBankKey(key ?? '');
                    setBankAccountId(account ?? '');
                  }}
                  data-bank-choice
                >
                  <option value="">Choose a house bank account</option>
                  {[...new Map(banks.map((b) => [`${b.houseBankKey}/${b.accountId}`, b])).values()].map((b) => (
                    <option key={`${b.houseBankKey}-${b.accountId}`} value={`${b.houseBankKey}/${b.accountId}`}>
                      {b.houseBankKey}/{b.accountId} ({b.currency})
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">House bank</span>
                <input
                  name="houseBankKey" className="input w-24" placeholder="HB01" required
                  value={houseBankKey}
                  onChange={(event) => setHouseBankKey(event.target.value.toUpperCase())}
                  data-bank-key
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Account ID</span>
                <input
                  name="bankAccountId" className="input w-24" placeholder="MAIN" required
                  value={bankAccountId}
                  onChange={(event) => setBankAccountId(event.target.value.toUpperCase())}
                  data-bank-account
                />
              </label>
              <ActualBankAmountFields
                key={instructionKey}
                instructionKey={instructionKey}
                groups={bankGroups}
                banks={banks}
                houseBankKey={houseBankKey}
                bankAccountId={bankAccountId}
              />
              <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canExecute || executing || !runHeld || busy}>
                Execute payments
              </button>
              <p className="w-full text-xs text-ink-soft">
                Each entry is in the <strong>bank account currency</strong>, not the payment currency. It is
                required when the selected bank is held in the company local currency and a group pays in
                another currency. Changing the bank or the proposal discards previously typed amounts. A
                missing or conflicting amount refuses the whole run; same-currency groups need no entry.
              </p>
            </form>
          )}
          {run.payments.length > 0 && (
            <div className="mt-3 overflow-x-auto">
              <table className="grid-table text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-ink-faint">
                    <th>Supplier</th><th>Invoice</th>
                    <th>Amount</th><th>Bank movement</th><th>Journal</th>
                    <th>Bank</th>
                  </tr>
                </thead>
                <tbody>
                  {run.payments.map((p) => (
                    <tr key={p.itemNumber}>
                      <td>{p.accountId}</td>
                      <td>{p.invoiceNumber ?? '—'}</td>
                      <td>{p.amount} {p.currency}</td>
                      <td>{p.bankAmount} {p.bankCurrency ?? p.currency} <span className="text-ink-faint">({p.bankAmountSource})</span></td>
                      <td>{p.journalDocumentNumber}</td>
                      <td>{p.houseBankKey}/{p.bankAccountId}</td>
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
