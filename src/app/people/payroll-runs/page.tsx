/**
 * Payroll runs — PEOPLE.PAYROLLRUN.EXECUTE. SAP: the payroll driver (PC00_M99_CALC).
 *
 * Payroll phase 2: propose a run for one company and fiscal period, recalculate it while proposed,
 * release it (frozen from then on) or cancel it. Exceptions — employees selected but not ready — are
 * always shown with their named reason. Nothing here posts; that is phase 3. `?run=` opens one run.
 */
import { randomUUID } from 'node:crypto';
import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  PAYROLL_RESULT_CAPABILITY,
  PAYROLL_RESULT_ROUTE,
  PAYROLL_RUN_CAPABILITY,
  PAYROLL_RUN_ROUTE,
  currentPayrollPeriod,
  getPayrollRun,
  listPayrollCompanies,
  listPayrollRuns,
} from '@/modules/people/payroll-run';
import { PAYROLL_POST_CAPABILITY, getPayrollPosting } from '@/modules/people/payroll-posting';

import { ProposeRunForm, RunActions } from './RunForms';

export const dynamic = 'force-dynamic';

const ROUTE = PAYROLL_RUN_ROUTE;
const CAPABILITY = PAYROLL_RUN_CAPABILITY;

const STATUS_CHIP: Record<string, string> = {
  PROPOSED: 'chip',
  RELEASED: 'chip chip-ok',
  POSTED: 'chip chip-ok',
  CANCELLED: 'chip chip-warn',
};

export default async function PayrollRunPage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const params = await searchParams;
  const session = await requireSession(ROUTE);
  const allowed = can(session, CAPABILITY);
  const mayReadResults = can(session, PAYROLL_RESULT_CAPABILITY);
  const client = session.user.client;
  const today = new Date().toISOString().slice(0, 10);

  const [runs, companies] = allowed ? await Promise.all([listPayrollRuns(client), listPayrollCompanies(client)]) : [[], []];
  const defaultCompany = companies[0]?.companyCode ?? '';
  const position = allowed && defaultCompany ? await currentPayrollPeriod(client, defaultCompany, today) : null;
  const selected = allowed && params.run && runs.some((r) => r.runId === params.run) ? await getPayrollRun(client, params.run) : null;
  const posting = selected && selected.status === 'POSTED' ? await getPayrollPosting(client, selected.runId) : null;
  const mayPost = can(session, PAYROLL_POST_CAPABILITY);
  const mayDisplayJournal = can(session, 'FIN.JOURNAL.DISPLAY');

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{CAPABILITY} · PC00_M99_CALC</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Payroll runs</h1>
          <div className="flex gap-2">
            {mayReadResults && <Link href={PAYROLL_RESULT_ROUTE} className="btn btn-default min-h-11 sm:min-h-8">Payroll results</Link>}
            <Link href="/people/salary-structures" className="btn btn-default min-h-11 sm:min-h-8">Salary structures</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">{t('nav.launchpad')}</Link>
          </div>
        </div>
        <p className="mt-1 max-w-3xl text-sm text-ink-soft">
          A run pays one company for one fiscal period. Joiners and leavers are paid for the days they hold a position;
          approved unpaid leave is deducted. A released run is frozen — a correction is a new run in a later period.
          Posting a released run books one PR document: personnel cost by cost centre, the payables flat.
        </p>
      </header>

      {!allowed && (
        <p role="status" className="text-sm text-ink-soft">You do not hold the payroll run capability. Ask for {CAPABILITY}.</p>
      )}

      {allowed && (
        <>
          {selected && (
            <>
              <section className="panel space-y-3 p-4" aria-label="Run">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h2 className="panel-title">
                    Company {selected.companyCode} · period {selected.period}/{selected.fiscalYear} · {selected.periodFrom} to {selected.periodTo}
                  </h2>
                  <span className={STATUS_CHIP[selected.status] ?? 'chip'}>{selected.status.toLowerCase()}</span>
                </div>
                <dl className="grid gap-3 text-sm sm:grid-cols-4">
                  <div><dt className="field-label">Employees</dt><dd>{selected.employeeCount}</dd></div>
                  <div><dt className="field-label">Exceptions</dt><dd className={selected.exceptionCount ? 'text-signal-error' : ''}>{selected.exceptionCount}</dd></div>
                  <div><dt className="field-label">Days in period</dt><dd>{selected.totalDays}</dd></div>
                  <div><dt className="field-label">Currency</dt><dd className="code">{selected.currency}</dd></div>
                  <div><dt className="field-label">Gross</dt><dd className="code">{selected.grossPay}</dd></div>
                  <div><dt className="field-label">Deductions</dt><dd className="code">{selected.totalDeductions}</dd></div>
                  <div><dt className="field-label">Net pay</dt><dd className="code font-semibold">{selected.netPay}</dd></div>
                  <div><dt className="field-label">Employer cost</dt><dd className="code">{selected.employerCost}</dd></div>
                </dl>
                <p className="text-xs text-ink-soft">
                  Calculated by {selected.calculatedBy} at {selected.calculatedAt.slice(0, 16).replace('T', ' ')}
                  {selected.releasedBy ? ` · released by ${selected.releasedBy} at ${selected.releasedAt?.slice(0, 16).replace('T', ' ')}` : ''}
                  {selected.cancelledBy ? ` · cancelled by ${selected.cancelledBy}: ${selected.cancelReason}` : ''}
                  {' · '}run {selected.runId}
                </p>
                {posting && (
                  <p className="text-sm">
                    Posted as document{' '}
                    {mayDisplayJournal
                      ? <Link href={`/finance/journal/document?document=${posting.documentNumber}`} className="code underline">{posting.displayNumber}</Link>
                      : <span className="code">{posting.displayNumber}</span>}
                    {' '}(fiscal year {posting.documentFiscalYear}, dated {posting.postingDate}) by {posting.postedBy}: debits {posting.debitTotal}, credits {posting.creditTotal}, {posting.lineCount} lines.
                    {posting.reversalDocumentNumber ? ` Reversed by document ${posting.reversalDocumentNumber}; the run stays posted — a correction is a new run in a later period.` : ''}
                  </p>
                )}
                {selected.status === 'PROPOSED' && <p className="text-xs text-ink-soft">Not postable yet: the run has not been released.</p>}
                {mayReadResults && (
                  <Link href={`${PAYROLL_RESULT_ROUTE}?runId=${selected.runId}`} className="text-sm underline">Open the results of this run</Link>
                )}
              </section>

              <section className="panel overflow-x-auto" aria-label="Exceptions">
                <h2 className="panel-title px-4 pt-4">Exceptions</h2>
                {selected.exceptions.length === 0 ? (
                  <p className="p-4 text-sm text-ink-soft">No exceptions: every selected employee was calculated.</p>
                ) : (
                  <table className="grid-table">
                    <thead><tr><th>Employee</th><th>Name</th><th>Reason</th><th>What stands in the way</th><th>Remedy</th></tr></thead>
                    <tbody>
                      {selected.exceptions.map((e, i) => (
                        <tr key={`${e.personnelNumber}-${i}`}>
                          <td className="code"><Link href={`/people/employees?employee=${e.personnelNumber}`} className="underline">{e.personnelNumber}</Link></td>
                          <td>{e.employeeName ?? ''}</td>
                          <td className="code text-xs">{e.reasonCode}</td>
                          <td className="text-sm">{e.message}</td>
                          <td className="text-xs text-ink-soft">{e.remedy ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <RunActions runId={selected.runId} status={selected.status} exceptionCount={selected.exceptionCount} mayPost={mayPost} />
            </>
          )}

          <section className="panel overflow-x-auto" aria-label="Runs">
            <h2 className="panel-title px-4 pt-4">Runs</h2>
            {runs.length === 0 ? (
              <p className="p-4 text-sm text-ink-soft">No payroll run has been proposed yet.</p>
            ) : (
              <table className="grid-table">
                <thead>
                  <tr><th>Company</th><th>Period</th><th>Dates</th><th>Status</th><th>Employees</th><th>Exceptions</th><th>Gross</th><th>Net</th><th>Employer cost</th></tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={r.runId}>
                      <td className="code">{r.companyCode}</td>
                      <td><Link href={`${ROUTE}?run=${r.runId}`} className="underline">{r.period}/{r.fiscalYear}</Link></td>
                      <td className="text-xs">{r.periodFrom} to {r.periodTo}</td>
                      <td><span className={STATUS_CHIP[r.status] ?? 'chip'}>{r.status.toLowerCase()}</span></td>
                      <td>{r.employeeCount}</td>
                      <td className={r.exceptionCount ? 'text-signal-error' : ''}>{r.exceptionCount}</td>
                      <td className="code">{r.grossPay} {r.currency}</td>
                      <td className="code">{r.netPay} {r.currency}</td>
                      <td className="code">{r.employerCost} {r.currency}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          {companies.length === 0 ? (
            <p role="status" className="panel p-4 text-sm text-ink-soft">No company code is defined, so no run can be proposed.</p>
          ) : (
            <ProposeRunForm
              companies={companies}
              defaultCompany={defaultCompany}
              defaultYear={position?.fiscalYear ?? Number(today.slice(0, 4))}
              defaultPeriod={position?.period ?? Number(today.slice(5, 7))}
              requestKey={randomUUID()}
            />
          )}
        </>
      )}
    </div>
  );
}
