'use client';

import { useActionState, useMemo, useState } from 'react';

import type {
  BankAccountChoice,
  BankReconciliationView,
  BankStatementLineView,
} from '@/modules/finance/bank-reconciliation';
import {
  finalizeBankStatementAction,
  matchBankStatementAction,
  reopenBankStatementAction,
  saveBankStatementAction,
  unmatchBankStatementAction,
  type BankReconciliationActionState,
} from './actions';

const INITIAL: BankReconciliationActionState = { ok: false, message: '' };

const STATUS_STYLE: Record<string, string> = {
  DRAFT: 'text-ink-soft',
  FINALIZED: 'text-signal-success',
  REOPENED: 'text-signal-warning',
  SUPERSEDED: 'text-ink-faint',
};

interface Query {
  companyCode: string;
  houseBankKey: string;
  accountId: string;
  statementId: string;
}

function amountValue(value: string): string {
  return value.startsWith('-') ? value.slice(1) : value;
}

function ledgerKey(line: { documentNumber: string; fiscalYear: number; lineNumber: number }): string {
  return `${line.documentNumber}|${line.fiscalYear}|${line.lineNumber}`;
}

function stateMessage(state: BankReconciliationActionState) {
  if (!state.message) return null;
  return (
    <p role="status" className={`mt-2 text-sm ${state.ok ? 'text-ink' : 'text-signal-error'}`}>
      {state.message}{state.remedy ? ` ${state.remedy}` : ''}
    </p>
  );
}

/**
 * Bank reconciliation mode of the G/L clearing screen. Separate from G/L open-item
 * clearing by design: a match here is evidence, never a posting or an AR/AP clearing.
 */
export default function BankReconciliation({
  view, loadError, accounts, query, canEnter, canMatch, canFinalize, today,
}: {
  view: BankReconciliationView | null;
  loadError: string | null;
  accounts: BankAccountChoice[];
  query: Query;
  canEnter: boolean;
  canMatch: boolean;
  canFinalize: boolean;
  today: string;
}) {
  const [saveState, saveAction, saving] = useActionState(saveBankStatementAction, INITIAL);
  const [matchState, matchAction, matching] = useActionState(matchBankStatementAction, INITIAL);
  const [unmatchState, unmatchAction, unmatching] = useActionState(unmatchBankStatementAction, INITIAL);
  const [finalizeState, finalizeAction, finalizing] = useActionState(finalizeBankStatementAction, INITIAL);
  const [reopenState, reopenAction, reopening] = useActionState(reopenBankStatementAction, INITIAL);

  const companies = useMemo(() => [...new Set(accounts.map((a) => a.companyCode))], [accounts]);
  const houses = useMemo(() => [...new Set(accounts.map((a) => a.houseBankKey))], [accounts]);
  const accountIds = useMemo(() => [...new Set(accounts.map((a) => a.accountId))], [accounts]);

  const hrefFor = (statementId: string) =>
    `/finance/gl-clearing?mode=bank&companyCode=${encodeURIComponent(query.companyCode)}`
    + `&houseBankKey=${encodeURIComponent(query.houseBankKey)}&accountId=${encodeURIComponent(query.accountId)}`
    + `&statement=${encodeURIComponent(statementId)}`;

  return (
    <>
      <section aria-labelledby="bank-selection" className="border border-line bg-surface p-4">
        <h2 id="bank-selection" className="text-sm font-semibold">Bank account</h2>
        <p className="mt-1 text-sm text-ink-soft">
          Enter a bank statement by hand, match its transactions to the posted bank G/L and freeze a reviewed
          reconciliation. Amounts are debit-to-bank: money in is positive, money out is negative; a negative
          closing balance is an overdraft. Matching never posts a journal or clears an AR/AP item.
        </p>
        <form method="get" action="/finance/gl-clearing" className="mt-3 flex flex-wrap items-end gap-3">
          <input type="hidden" name="mode" value="bank" />
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Company code</span>
            <input name="companyCode" className="input w-32" required defaultValue={query.companyCode} list="bank-company-list" />
            <datalist id="bank-company-list">{companies.map((c) => <option key={c} value={c} />)}</datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">House bank</span>
            <input name="houseBankKey" className="input w-32" required defaultValue={query.houseBankKey} list="bank-house-list" />
            <datalist id="bank-house-list">{houses.map((h) => <option key={h} value={h} />)}</datalist>
          </label>
          <label className="block">
            <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Account</span>
            <input name="accountId" className="input w-28" required defaultValue={query.accountId} list="bank-account-list" />
            <datalist id="bank-account-list">{accountIds.map((a) => <option key={a} value={a} />)}</datalist>
          </label>
          <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Load account</button>
        </form>
        {accounts.length === 0 && (
          <p className="mt-2 text-sm text-ink-soft">
            No bank account stands in your Company Code scope. Define one in House Banks, or ask an administrator
            to extend your scope. You may still type a known company, house bank and account.
          </p>
        )}
        {loadError && <p role="alert" className="mt-2 text-sm text-signal-error">{loadError}</p>}
        {stateMessage(saveState)}
        {stateMessage(matchState)}
        {stateMessage(unmatchState)}
        {stateMessage(finalizeState)}
        {stateMessage(reopenState)}
      </section>

      {view && (
        <>
          <section aria-labelledby="bank-account" className="border border-line bg-surface p-4">
            <h2 id="bank-account" className="text-sm font-semibold">
              {view.companyCode} · {view.houseBankKey} · {view.accountId}
            </h2>
            <p className="mt-1 text-sm">
              Account {view.accountNumber} · currency <strong>{view.currency}</strong> · bank G/L{' '}
              <strong>{view.glAccount}</strong> · {view.statements.length} statement(s).
            </p>
          </section>

          {view.statements.length > 0 && (
            <section aria-labelledby="bank-statements" className="border border-line bg-surface p-4">
              <h2 id="bank-statements" className="text-sm font-semibold">Statements</h2>
              <div className="mt-2 overflow-x-auto">
                <table className="grid-table text-left text-sm">
                  <thead>
                    <tr className="text-xs uppercase tracking-wide text-ink-faint">
                      <th>Reference</th><th>Period</th><th>Status</th><th>Opening</th><th>Closing</th><th>Finalized</th>
                    </tr>
                  </thead>
                  <tbody>
                    {view.statements.map((statement) => (
                      <tr key={statement.statementId}>
                        <td>
                          <a className="underline" href={hrefFor(statement.statementId)}>{statement.statementReference}</a>
                        </td>
                        <td>{statement.fromDate} – {statement.toDate}</td>
                        <td className={STATUS_STYLE[statement.status] ?? ''}>{statement.status}</td>
                        <td className="num">{statement.openingBalance} {statement.currency}</td>
                        <td className="num">{statement.closingBalance} {statement.currency}</td>
                        <td>{statement.finalizedBy ? `${statement.finalizedBy} ${statement.finalizedAt ?? ''}` : ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          <section aria-labelledby="bank-entry" className="border border-line bg-surface p-4">
            <h2 id="bank-entry" className="text-sm font-semibold">
              {view.statement ? (view.statement.status === 'FINALIZED' ? 'Statement (finalized — reopen to correct)' : 'Statement entry') : 'New statement'}
            </h2>
            {view.statement?.status === 'FINALIZED' && (
              <p className="mt-1 text-sm text-ink-soft">
                Finalized statements are not edited in place. Reopen below to correct one; the signed snapshot stays as evidence.
              </p>
            )}
            <StatementEditor
              key={view.statement?.statementId ?? 'new'}
              view={view}
              query={query}
              canEnter={canEnter && view.statement?.status !== 'FINALIZED'}
              saveAction={saveAction}
              saving={saving}
              today={today}
            />
          </section>

          {view.statement && (
            <>
              <section aria-labelledby="bank-bridge" className="border border-line bg-surface p-4">
                <h2 id="bank-bridge" className="text-sm font-semibold">As-of reconciliation</h2>
                {view.bridge ? (
                  <>
                    <table className="mt-3 grid-table text-left text-sm">
                      <tbody>
                        <tr><td>Statement opening</td><td className="num">{view.bridge.statementOpening} {view.currency}</td></tr>
                        <tr><td>Statement closing</td><td className="num">{view.bridge.statementClosing} {view.currency}</td></tr>
                        <tr><td>Ledger opening (bank G/L, debit positive)</td><td className="num">{view.bridge.ledgerOpening} {view.currency}</td></tr>
                        <tr><td>Ledger closing (as of {view.statement.toDate})</td><td className="num">{view.bridge.ledgerClosing} {view.currency}</td></tr>
                        <tr><td>Statement closing − ledger closing</td><td className="num">{view.bridge.closingDifference} {view.currency}</td></tr>
                        <tr><td>Unmatched statement-side signed amount</td><td className="num">{view.bridge.unmatchedStatementAmount} {view.currency}</td></tr>
                        <tr><td>Unmatched ledger-side signed amount</td><td className="num">{view.bridge.unmatchedLedgerAmount} {view.currency}</td></tr>
                        <tr><td>Cutover baseline (explicit)</td><td className="num">{view.bridge.baselineAmount} {view.currency}</td></tr>
                        <tr className="font-semibold"><td>Unexplained difference</td><td className="num">{view.bridge.unexplainedDifference} {view.currency}</td></tr>
                      </tbody>
                    </table>
                    <p className="mt-2 text-sm text-ink-soft">
                      Statement arithmetic: opening plus the signed lines {view.statement.arithmeticValid ? 'equals' : 'does not equal'} the closing balance
                      {' '}({view.statement.arithmeticDifference} difference). {view.bridge.unexplainedDifference === '0.0000' || view.bridge.unexplainedDifference === '0'
                        ? 'The bridge explains the balance difference.'
                        : 'The bridge leaves a difference; it cannot be treated as reconciled.'}
                    </p>
                  </>
                ) : <p className="mt-2 text-sm text-ink-soft">No bridge stands for this selection.</p>}
                {view.issues.length > 0 && (
                  <ul className="mt-2 list-disc pl-5 text-sm text-signal-error">
                    {view.issues.map((issue) => <li key={issue.code}>{issue.message}{issue.blocking ? ' (blocks finalization)' : ''}</li>)}
                  </ul>
                )}
                {view.changedSinceSnapshot && (
                  <p className="mt-2 text-sm text-signal-warning">
                    This reconciliation changed after sign-off: {view.changeReasons.join(' ')}
                  </p>
                )}
              </section>

              <section aria-labelledby="bank-lines" className="border border-line bg-surface p-4">
                <h2 id="bank-lines" className="text-sm font-semibold">Statement lines and matching</h2>
                <div className="mt-3 overflow-x-auto">
                  <table className="grid-table text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-ink-faint">
                        <th>Line</th><th>Value date</th><th>Reference</th><th>Description</th>
                        <th>Direction</th><th>Amount</th><th>Matched</th><th>Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.statement.lines.map((line) => (
                        <tr key={line.lineId}>
                          <td>{line.lineNumber}</td>
                          <td>{line.valueDate}</td>
                          <td>{line.bankReference}</td>
                          <td>{line.description}</td>
                          <td>{line.direction === 'IN' ? 'Money in' : 'Money out'}</td>
                          <td className="num">{line.amount}</td>
                          <td className="num">{line.matchedAmount}</td>
                          <td className="num">{line.remainingAmount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {view.priorStatementLines.length > 0 && (
                  <>
                    <h3 className="mt-4 text-sm font-semibold">Carried-forward statement items</h3>
                    <div className="mt-2 overflow-x-auto">
                      <table className="grid-table text-left text-sm">
                        <thead>
                          <tr className="text-xs uppercase tracking-wide text-ink-faint">
                            <th>Statement</th><th>Line</th><th>Reference</th><th>Direction</th><th>Remaining</th>
                          </tr>
                        </thead>
                        <tbody>
                          {view.priorStatementLines.map((line) => (
                            <tr key={line.lineId}>
                              <td>{line.statementReference} ({line.toDate})</td>
                              <td>{line.lineNumber}</td>
                              <td>{line.bankReference}</td>
                              <td>{line.direction === 'IN' ? 'Money in' : 'Money out'}</td>
                              <td className="num">{line.remainingAmount}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}

                {view.statement.status !== 'FINALIZED' && canMatch && (
                  <MatchPanel
                    view={view}
                    action={matchAction}
                    pending={matching}
                  />
                )}

                {view.statement.lines.some((line) => line.matches.some((match) => match.isActive)) && (
                  <form action={unmatchAction} className="mt-4 flex flex-wrap items-end gap-3 border-t border-line pt-3">
                    <input type="hidden" name="statementId" value={view.statement.statementId} />
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Withdraw a match</span>
                      <select name="matchId" className="input w-64" required>
                        <option value="">Choose a match</option>
                        {view.statement.lines.flatMap((line) => line.matches.filter((match) => match.isActive).map((match) => (
                          <option key={match.matchId} value={match.matchId}>
                            Line {line.lineNumber}: {match.ledgerDocumentNumber}/{match.ledgerLineNumber} · {match.amount}
                          </option>
                        )))}
                      </select>
                    </label>
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reason</span>
                      <input name="reason" className="input w-64" required maxLength={400} />
                    </label>
                    <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canMatch || unmatching}>
                      Withdraw match
                    </button>
                  </form>
                )}
              </section>

              <section aria-labelledby="bank-ledger" className="border border-line bg-surface p-4">
                <h2 id="bank-ledger" className="text-sm font-semibold">Posted bank G/L lines as of {view.statement.toDate}</h2>
                <p className="mt-1 text-sm text-ink-soft">
                  Debit to the bank asset is money in (positive); credit is money out (negative).
                </p>
                <div className="mt-3 overflow-x-auto">
                  <table className="grid-table text-left text-sm">
                    <thead>
                      <tr className="text-xs uppercase tracking-wide text-ink-faint">
                        <th>Document</th><th>Date</th><th>Type</th><th>Reference</th><th>Assignment</th>
                        <th>Origin</th><th>Direction</th><th>Amount</th><th>Matched</th><th>Remaining</th>
                      </tr>
                    </thead>
                    <tbody>
                      {view.ledgerLines.map((line) => (
                        <tr key={ledgerKey(line)}>
                          <td>{line.documentNumber}/{line.lineNumber}</td>
                          <td>{line.postingDate}</td>
                          <td>{line.documentType}</td>
                          <td>{line.reference}</td>
                          <td>{line.assignment}</td>
                          <td>{line.originClass ? `${line.originClass} ${line.originKey ?? ''}` : ''}</td>
                          <td>{line.direction === 'IN' ? 'Money in' : 'Money out'}</td>
                          <td className="num">{line.amount}</td>
                          <td className="num">{line.matchedAmount}</td>
                          <td className="num">{line.remainingAmount}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>

              <section aria-labelledby="bank-finalize" className="border border-line bg-surface p-4">
                <h2 id="bank-finalize" className="text-sm font-semibold">Review and sign-off</h2>
                {view.statement.status === 'FINALIZED' ? (
                  <form action={reopenAction} className="mt-3 flex flex-wrap items-end gap-3">
                    <input type="hidden" name="statementId" value={view.statement.statementId} />
                    <label className="block">
                      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Reopen reason</span>
                      <input name="reason" className="input w-80" required maxLength={400} />
                    </label>
                    <button type="submit" className="btn btn-default min-h-11 sm:min-h-8" disabled={!canFinalize || reopening}>
                      Reopen for correction
                    </button>
                  </form>
                ) : (
                  <form action={finalizeAction} className="mt-3 flex flex-wrap items-end gap-3">
                    <input type="hidden" name="statementId" value={view.statement.statementId} />
                    <label className="flex items-end gap-2">
                      <input type="checkbox" name="confirmed" value="yes" required className="size-4" />
                      <span className="text-sm">I reviewed the as-of calculation and confirm this reconciliation</span>
                    </label>
                    <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canFinalize || finalizing}>
                      Finalize reconciliation
                    </button>
                  </form>
                )}
                <p className="mt-2 text-sm text-ink-soft">
                  The snapshot stores the statement identity, ledger basis, allocations, outstanding items, baseline,
                  reviewer and timestamp. A later match or a late posting is shown as a change; it never rewrites the
                  signed snapshot. Finalizing posts nothing.
                </p>
              </section>

              {view.snapshots.length > 0 && (
                <section aria-labelledby="bank-snapshots" className="border border-line bg-surface p-4">
                  <h2 id="bank-snapshots" className="text-sm font-semibold">Finalized evidence</h2>
                  <div className="mt-2 overflow-x-auto">
                    <table className="grid-table text-left text-sm">
                      <thead>
                        <tr className="text-xs uppercase tracking-wide text-ink-faint">
                          <th>#</th><th>Finalized by</th><th>Finalized at</th><th>Ledger closing</th>
                          <th>Unmatched statement</th><th>Unmatched ledger</th><th>Unexplained</th>
                        </tr>
                      </thead>
                      <tbody>
                        {view.snapshots.map((snapshot) => (
                          <tr key={snapshot.snapshotId}>
                            <td>{snapshot.sequence}</td>
                            <td>{snapshot.finalizedBy}</td>
                            <td>{snapshot.finalizedAt}</td>
                            <td className="num">{snapshot.ledgerClosingBalance}</td>
                            <td className="num">{snapshot.unmatchedStatementAmount}</td>
                            <td className="num">{snapshot.unmatchedLedgerAmount}</td>
                            <td className="num">{snapshot.unexplainedDifference}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <a
                    className="mt-3 inline-block underline text-sm"
                    href={`/finance/gl-clearing/export?companyCode=${encodeURIComponent(view.companyCode)}&houseBankKey=${encodeURIComponent(view.houseBankKey)}&accountId=${encodeURIComponent(view.accountId)}&statement=${encodeURIComponent(view.statement.statementId)}`}
                  >
                    Export reconciliation evidence (CSV)
                  </a>
                </section>
              )}
            </>
          )}
        </>
      )}
    </>
  );
}

interface EditableLine {
  lineId?: string;
  direction: 'IN' | 'OUT';
  amount: string;
  valueDate: string;
  transactionDate: string;
  bankReference: string;
  description: string;
}

function fromView(line: BankStatementLineView): EditableLine {
  return {
    lineId: line.lineId,
    direction: line.direction,
    amount: line.amount,
    valueDate: line.valueDate,
    transactionDate: line.transactionDate,
    bankReference: line.bankReference,
    description: line.description,
  };
}

function StatementEditor({
  view, query, canEnter, saveAction, saving, today,
}: {
  view: BankReconciliationView;
  query: Query;
  canEnter: boolean;
  saveAction: (payload: FormData) => void;
  saving: boolean;
  today: string;
}) {
  const statement = view.statement;
  const [lines, setLines] = useState<EditableLine[]>(
    statement
      ? statement.lines.map(fromView)
      : [{ direction: 'IN', amount: '', valueDate: today, transactionDate: today, bankReference: '', description: '' }],
  );
  const update = (index: number, patch: Partial<EditableLine>) =>
    setLines((current) => current.map((line, i) => (i === index ? { ...line, ...patch } : line)));
  const add = () => setLines((current) => [
    ...current,
    { direction: 'IN', amount: '', valueDate: today, transactionDate: today, bankReference: '', description: '' },
  ]);
  const remove = (index: number) => setLines((current) => current.filter((_, i) => i !== index));

  return (
    <form action={saveAction} className="mt-3 space-y-3">
      <input type="hidden" name="companyCode" value={view.companyCode} />
      <input type="hidden" name="houseBankKey" value={view.houseBankKey} />
      <input type="hidden" name="accountId" value={view.accountId} />
      <input type="hidden" name="currency" value={view.currency} />
      <input type="hidden" name="statementId" value={statement?.statementId ?? ''} />
      <input type="hidden" name="requestKey" value={`bank-statement-${statement?.statementId ?? `${query.companyCode}-${query.houseBankKey}-${query.accountId}-${today}`}`} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />

      <div className="flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Statement reference</span>
          <input name="statementReference" className="input w-56" required maxLength={40} defaultValue={statement?.statementReference ?? ''} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">From</span>
          <input type="date" name="fromDate" className="input" required defaultValue={statement?.fromDate ?? today} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">To</span>
          <input type="date" name="toDate" className="input" required defaultValue={statement?.toDate ?? today} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Opening balance</span>
          <input name="openingBalance" className="input w-40" required inputMode="decimal" defaultValue={statement?.openingBalance ?? '0'} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Closing balance</span>
          <input name="closingBalance" className="input w-40" required inputMode="decimal" defaultValue={statement?.closingBalance ?? '0'} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Cutover baseline</span>
          <input name="baselineAmount" className="input w-36" inputMode="decimal" defaultValue={statement?.baselineAmount ?? '0'} />
        </label>
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Baseline reason</span>
          <input name="baselineReason" className="input w-64" maxLength={400} />
        </label>
      </div>

      <div className="overflow-x-auto">
        <table className="grid-table text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-ink-faint">
              <th>Direction</th><th>Amount</th><th>Value date</th><th>Transaction date</th>
              <th>Bank reference</th><th>Description</th><th />
            </tr>
          </thead>
          <tbody>
            {lines.map((line, index) => (
              <tr key={line.lineId ?? `new-${index}`}>
                <td>
                  <select className="input w-28" value={line.direction} onChange={(e) => update(index, { direction: e.target.value as 'IN' | 'OUT' })} aria-label={`Direction for line ${index + 1}`}>
                    <option value="IN">Money in</option>
                    <option value="OUT">Money out</option>
                  </select>
                </td>
                <td><input className="input w-32" inputMode="decimal" value={line.amount} onChange={(e) => update(index, { amount: e.target.value })} aria-label={`Amount for line ${index + 1}`} /></td>
                <td><input type="date" className="input" value={line.valueDate} onChange={(e) => update(index, { valueDate: e.target.value })} aria-label={`Value date for line ${index + 1}`} /></td>
                <td><input type="date" className="input" value={line.transactionDate} onChange={(e) => update(index, { transactionDate: e.target.value })} aria-label={`Transaction date for line ${index + 1}`} /></td>
                <td><input className="input w-40" maxLength={60} value={line.bankReference} onChange={(e) => update(index, { bankReference: e.target.value })} aria-label={`Bank reference for line ${index + 1}`} /></td>
                <td><input className="input w-56" maxLength={200} value={line.description} onChange={(e) => update(index, { description: e.target.value })} aria-label={`Description for line ${index + 1}`} /></td>
                <td><button type="button" className="btn btn-default" onClick={() => remove(index)} disabled={lines.length === 1}>Remove</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <button type="button" className="btn btn-default" onClick={add}>Add line</button>
        <button type="submit" className="btn btn-primary min-h-11 sm:min-h-8" disabled={!canEnter || saving}>
          {statement ? 'Save draft correction' : 'Save draft statement'}
        </button>
        <span className="text-sm text-ink-soft">
          Identical amounts and references are allowed; the statement reference and line sequence carry identity.
        </span>
      </div>
    </form>
  );
}

function MatchPanel({
  view, action, pending,
}: {
  view: BankReconciliationView;
  action: (payload: FormData) => void;
  pending: boolean;
}) {
  const statement = view.statement!;
  const [statementLineId, setStatementLineId] = useState(statement.lines[0]?.lineId ?? '');
  const available = view.ledgerLines.filter((line) => Number(line.remainingAmount.replace('-', '')) > 0);
  const [allocations, setAllocations] = useState<Record<string, string>>({});

  const selectedLine = statement.lines.find((line) => line.lineId === statementLineId);
  const rows = available
    .filter((line) => !selectedLine || (line.direction === selectedLine.direction))
    .map((line) => {
      const key = ledgerKey(line);
      return {
        line,
        key,
        value: allocations[key] ?? '',
      };
    });

  const payload = rows
    .filter((row) => row.value.trim() !== '')
    .map((row) => ({
      statementLineId,
      ledgerDocumentNumber: row.line.documentNumber,
      ledgerFiscalYear: row.line.fiscalYear,
      ledgerLineNumber: row.line.lineNumber,
      amount: row.value.trim(),
    }));

  return (
    <form action={action} className="mt-4 border-t border-line pt-4">
      <input type="hidden" name="statementId" value={statement.statementId} />
      <input type="hidden" name="allocations" value={JSON.stringify(payload)} />
      <input type="hidden" name="requestKey" value={`bank-match-${statement.statementId}-${statementLineId}-${rows.map((r) => `${r.key}:${r.value}`).join(',')}`} />
      <h3 className="text-sm font-semibold">Match a statement line</h3>
      <div className="mt-2 flex flex-wrap items-end gap-3">
        <label className="block">
          <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-ink-faint">Statement line</span>
          <select className="input w-72" value={statementLineId} onChange={(e) => setStatementLineId(e.target.value)}>
            {statement.lines.map((line) => (
              <option key={line.lineId} value={line.lineId}>
                {line.lineNumber} · {line.direction === 'IN' ? 'in' : 'out'} {line.amount} · remaining {line.remainingAmount}
              </option>
            ))}
          </select>
        </label>
        <span className="text-sm text-ink-soft">One statement line can settle several bank lines; repeat for several statement lines against one bank line.</span>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="grid-table text-left text-sm">
          <thead>
            <tr className="text-xs uppercase tracking-wide text-ink-faint">
              <th>Bank line</th><th>Date</th><th>Direction</th><th>Remaining</th><th>Allocate</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr><td colSpan={5} className="text-ink-soft">No posted bank line on the same side stands open.</td></tr>
            ) : rows.map((row) => (
              <tr key={row.key}>
                <td>{row.line.documentNumber}/{row.line.lineNumber}</td>
                <td>{row.line.postingDate}</td>
                <td>{row.line.direction === 'IN' ? 'Money in' : 'Money out'}</td>
                <td className="num">{row.line.remainingAmount}</td>
                <td>
                  <input
                    className="input w-28" inputMode="decimal" value={row.value}
                    placeholder={amountValue(row.line.remainingAmount)}
                    onChange={(e) => setAllocations((current) => ({ ...current, [row.key]: e.target.value }))}
                    aria-label={`Allocate to ledger line ${row.line.documentNumber}/${row.line.lineNumber}`}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="submit" className="mt-3 btn btn-primary min-h-11 sm:min-h-8" disabled={pending || payload.length === 0}>
        Confirm match (evidence only)
      </button>
    </form>
  );
}
