/**
 * Payroll results — PEOPLE.PAYROLL.RESULT. SAP: payroll result display (PC00_M99_DISPLAY).
 *
 * Read-only. One row per employee of a run — payable days of total, unpaid leave, gross, deductions,
 * net, employer cost, cost centre. `?result=` drills into one slip: each component line with its
 * amount, the account it will post to and the cost receiver, as snapshotted at calculation time.
 * Filter (GET): `runId`, `personnelNumber`.
 */
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PAYROLL_RESULT_CAPABILITY,
  PAYROLL_RESULT_ROUTE,
  PAYROLL_RUN_ROUTE,
  PayrollRunError,
  getResultWithLines,
  listPayrollRuns,
  listResults,
} from '@/modules/people/payroll-run';
import { getPayrollPosting } from '@/modules/people/payroll-posting';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

const ROUTE = PAYROLL_RESULT_ROUTE;
const CAPABILITY = PAYROLL_RESULT_CAPABILITY;

export default async function PayrollResultPage({
  searchParams,
}: {
  searchParams: Promise<{ runId?: string; personnelNumber?: string; result?: string }>;
}) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const access = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  const allowed = can(session, CAPABILITY);
  const client = session.user.client;

  const runs = allowed ? await listPayrollRuns(client, access) : [];
  const run = runs.find((r) => r.runId === params.runId) ?? runs.find((r) => r.status !== 'CANCELLED') ?? runs[0] ?? null;
  const personnelNumber = params.personnelNumber?.trim().toUpperCase() || '';
  const results = allowed && run ? await listResults(client, run.runId, personnelNumber || undefined, access) : [];
  // A result outside the caller's Company Code scope is refused by the service; the page shows none.
  const slip = allowed && params.result
    ? await getResultWithLines(client, params.result, access).catch((error: unknown) => {
      if (error instanceof PayrollRunError) return null;
      throw error;
    })
    : null;
  const slipRun = slip ? runs.find((r) => r.runId === slip.result.runId) : null;
  const posting = run && run.status === 'POSTED' ? await getPayrollPosting(client, run.runId, access) : null;
  const posted = Boolean(posting);
  const query = (extra: Record<string, string>) => {
    const q = new URLSearchParams({ ...(run ? { runId: run.runId } : {}), ...(personnelNumber ? { personnelNumber } : {}), ...extra });
    return `${ROUTE}?${q.toString()}`;
  };

  return (
    <Page
      title="Payroll results" code={<>{CAPABILITY} · PC00_M99_DISPLAY</>} back={{ href: '/', label: t('nav.launchpad') }}
      description="One slip per employee and run. Each line shows the account it posts to and the cost receiver, fixed when the run was calculated. Read-only."
      actions={
        <>
          <LinkButton href={PAYROLL_RUN_ROUTE}>Payroll runs</LinkButton>
        </>
      }
    >

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">You do not hold the payroll result capability. Ask for {CAPABILITY}.</p>
      )}

      {allowed && runs.length === 0 && (
        <p role="status" className="panel p-4 text-sm text-ink-soft">No payroll run exists yet. Propose one at <Link href={PAYROLL_RUN_ROUTE} className="underline">{PAYROLL_RUN_ROUTE}</Link>.</p>
      )}

      {allowed && run && (
        <>
          <form action={ROUTE} className="panel flex flex-wrap items-end gap-3 p-3" role="search">
            <label>
              <span className="field-label">Run</span>
              <select name="runId" className="field-input" defaultValue={run.runId}>
                {runs.map((r) => (
                  <option key={r.runId} value={r.runId}>{r.companyCode} · {r.period}/{r.fiscalYear} · {r.status.toLowerCase()}</option>
                ))}
              </select>
            </label>
            <label>
              <span className="field-label">Personnel number (optional)</span>
              <input name="personnelNumber" className="field-input code" maxLength={20} defaultValue={personnelNumber} />
            </label>
            <button type="submit" className="btn btn-default min-h-11 sm:min-h-8">Show</button>
          </form>

          {slip && (
            <section className="panel overflow-x-auto" aria-label={`Slip of ${slip.result.personnelNumber}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 pt-4">
                <h2 className="panel-title">
                  {slip.result.personnelNumber} — {slip.result.employeeName ?? ''}
                  {slipRun ? ` · ${slipRun.companyCode} ${slipRun.period}/${slipRun.fiscalYear} (${slipRun.status.toLowerCase()})` : ''}
                </h2>
                <Link href={query({})} className="text-sm underline">Close</Link>
              </div>
              <p className="px-4 text-sm text-ink-soft">
                Paid {slip.result.payableDays} of {slip.result.totalDays} days (held a position {slip.result.coveredDays} days,
                unpaid leave {slip.result.unpaidLeaveDays}). Gross {slip.result.grossPay}, deductions {slip.result.totalDeductions},
                net <strong>{slip.result.netPay}</strong>, employer cost {slip.result.employerCost} {slip.result.currency}.
              </p>
              <table className="grid-table mt-2">
                <thead>
                  <tr><th>#</th><th>Segment</th><th>Days</th><th>Component</th><th>Kind</th><th>Rule</th><th>Amount</th><th>{slipRun?.status === 'POSTED' ? 'Debited' : 'Debit'}</th><th>{slipRun?.status === 'POSTED' ? 'Credited' : 'Credit'}</th><th>Cost receiver</th></tr>
                </thead>
                <tbody>
                  {slip.lines.map((l) => (
                    <tr key={l.lineId}>
                      <td>{l.lineNo}</td>
                      <td className="text-xs">{l.segmentFrom} to {l.segmentTo} · {l.structureCode}</td>
                      <td>{l.payableDays}</td>
                      <td className="code">{l.componentCode}</td>
                      <td className="text-xs">{l.componentKind}</td>
                      <td className="code text-xs">{l.amountKind === 'FIXED' ? `fixed ${l.amountValue}` : `${l.amountValue} % of ${l.baseAmount}`}</td>
                      <td className="code">{l.amount}</td>
                      <td className="code">{l.debitAccount ?? ''}</td>
                      <td className="code">{l.creditAccount ?? ''}</td>
                      <td className="text-xs">{l.costReceiverCategory === 'NONE' ? 'none' : `${l.costReceiverCategory.toLowerCase()} · ${l.controllingArea}/${l.costCenter}`}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          <section className="panel overflow-x-auto" aria-label="Results">
            <h2 className="panel-title px-4 pt-4">
              Company {run.companyCode} · period {run.period}/{run.fiscalYear} · {run.periodFrom} to {run.periodTo} · {run.status.toLowerCase()}
            </h2>
            {posting && (
              <p className="px-4 text-sm">
                Posted as document <span className="code">{posting.displayNumber}</span> on {posting.postingDate}: debits {posting.debitTotal}, credits {posting.creditTotal}.
                Each slip shows the accounts its lines posted to.
              </p>
            )}
            {!posted && run.status !== 'CANCELLED' && (
              <p className="px-4 text-xs text-ink-soft">Not posted yet: each slip shows the accounts its lines will post to.</p>
            )}
            {results.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">
                {personnelNumber ? `No result for ${personnelNumber} in this run.` : 'This run has no results.'}
                {run.exceptionCount > 0 ? ` ${run.exceptionCount} employee(s) stand as exceptions — see the run.` : ''}
              </p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Employee</th><th>Name</th><th>Days paid</th><th>Unpaid leave</th><th>Gross</th><th>Deductions</th><th>Net</th><th>Employer cost</th><th>Cost centre</th></tr>
                </thead>
                <tbody>
                  {results.map((r) => (
                    <tr key={r.resultId}>
                      <td className="code"><Link href={query({ result: r.resultId })} className="underline">{r.personnelNumber}</Link></td>
                      <td>{r.employeeName ?? ''}</td>
                      <td>{r.payableDays} / {r.totalDays}</td>
                      <td>{r.unpaidLeaveDays}</td>
                      <td className="code">{r.grossPay}</td>
                      <td className="code">{r.totalDeductions}</td>
                      <td className="code">{r.netPay}</td>
                      <td className="code">{r.employerCost}</td>
                      <td className="code text-xs">{r.costCenter ?? ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </Page>
  );
}
