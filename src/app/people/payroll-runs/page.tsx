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
  PayrollRunError,
  currentPayrollPeriod,
  getPayrollRun,
  listPayrollCompanies,
  listPayrollRuns,
} from '@/modules/people/payroll-run';
import { PAYROLL_POST_CAPABILITY, getPayrollPosting } from '@/modules/people/payroll-posting';
import { SALARY_PAYMENT_CAPABILITY, getSalaryPayment } from '@/modules/people/salary-payment';
import { PAYMENT_FILE_CAPABILITY, getPaymentFile } from '@/modules/people/payroll-payment-file';
import {
  FILE_HISTORICAL_CAPABILITY,
  REISSUE_APPROVE_CAPABILITY,
  REISSUE_DOWNLOAD_CAPABILITY,
  REISSUE_REQUEST_CAPABILITY,
  listReissues,
} from '@/modules/people/payroll-payment-reissue';
import { listBankChoices } from '@/modules/finance/payment-run';

import { listPayrollOperations } from '@/modules/people/payroll-background';
import {
  ADJUSTMENT_APPROVE_CAPABILITY,
  ADJUSTMENT_ENTER_CAPABILITY,
  COMPANY_RESPONSIBILITY_NOTICE,
  listAdjustments,
  listEntryComponents,
} from '@/modules/people/payroll-components';
import { PayrollStructureError } from '@/modules/people/payroll-structure';
import { AdjustmentRowActions, EnterAdjustmentForm } from './Adjustments';
import { OperationPanel, PaymentFilePanel, PaySalaryForm, ProposeRunForm, RunActions } from './RunForms';
import { PaymentReissuePanel } from './PaymentReissue';
import { LinkButton, Page } from '@/ui/kit';

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
  const access = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  const allowed = can(session, CAPABILITY);
  const mayReadResults = can(session, PAYROLL_RESULT_CAPABILITY);
  const client = session.user.client;
  const today = new Date().toISOString().slice(0, 10);

  const [runs, companies] = allowed ? await Promise.all([listPayrollRuns(client, access), listPayrollCompanies(client)]) : [[], []];
  const defaultCompany = companies[0]?.companyCode ?? '';
  const position = allowed && defaultCompany ? await currentPayrollPeriod(client, defaultCompany, today) : null;
  const selected = allowed && params.run && runs.some((r) => r.runId === params.run) ? await getPayrollRun(client, params.run, access) : null;
  const operations = selected ? await listPayrollOperations(client, selected.runId, access, 1) : [];
  const operation = operations[0] ?? null;
  const busy = operation ? ['QUEUED', 'RUNNING'].includes(operation.status) : false;
  const posting = selected && selected.status === 'POSTED' ? await getPayrollPosting(client, selected.runId, access) : null;
  const mayPost = can(session, PAYROLL_POST_CAPABILITY);
  const mayDisplayJournal = can(session, 'FIN.JOURNAL.DISPLAY');
  const mayPay = can(session, SALARY_PAYMENT_CAPABILITY);
  const mayExportFile = can(session, PAYMENT_FILE_CAPABILITY);
  const payment = selected && selected.status === 'POSTED' ? await getSalaryPayment(client, selected.runId, access) : null;
  const paymentFile = selected && selected.status === 'POSTED' && mayExportFile
    ? await getPaymentFile(client, selected.runId, access).catch(() => null)
    : null;
  const mayRequestReissue = can(session, REISSUE_REQUEST_CAPABILITY);
  const mayApproveReissue = can(session, REISSUE_APPROVE_CAPABILITY);
  const mayDownloadReissue = can(session, REISSUE_DOWNLOAD_CAPABILITY);
  const mayHistorical = can(session, FILE_HISTORICAL_CAPABILITY);
  const reissues = paymentFile && (mayRequestReissue || mayApproveReissue || mayDownloadReissue || mayHistorical)
    ? await listReissues(client, selected!.runId, access).catch(() => [])
    : [];
  const banks = selected && selected.status === 'POSTED' && !payment && mayPay
    ? (await listBankChoices(client)).filter((b) => b.companyCode === selected.companyCode)
    : [];
  const mayEnter = can(session, ADJUSTMENT_ENTER_CAPABILITY);
  const mayApprove = can(session, ADJUSTMENT_APPROVE_CAPABILITY);
  const mayCancelAdjustment = mayEnter || mayApprove;
  let adjustments: Awaited<ReturnType<typeof listAdjustments>> = [];
  let adjustmentNote = '';
  if (allowed || mayEnter || mayApprove) {
    try {
      adjustments = await listAdjustments(client, selected ? { companyCode: selected.companyCode, fiscalYear: selected.fiscalYear, period: selected.period } : {}, access);
    } catch (error) {
      if (!(error instanceof PayrollStructureError) && !(error instanceof PayrollRunError)) throw error;
      adjustmentNote = `${error.message}${error.remedy ? ` ${error.remedy}` : ''}`;
    }
  }
  const entryComponents = mayEnter ? await listEntryComponents(client) : [];
  const nextPeriodStart = selected
    ? new Date(Date.UTC(Number(selected.periodTo.slice(0, 4)), Number(selected.periodTo.slice(5, 7)) - 1, Number(selected.periodTo.slice(8, 10)) + 1)).toISOString().slice(0, 10)
    : today;

  return (
    <Page
      title="Payroll runs" code={<>{CAPABILITY} · PC00_M99_CALC</>} back={{ href: '/', label: t('nav.launchpad') }}
      description="A run pays one company for one fiscal period. Joiners and leavers are paid for the days they hold a position; approved unpaid leave is deducted. A released run is frozen — a correction is a new run in a later period. Posting a released run books one PR document: personnel cost by cost centre, the payables flat."
      actions={
        <>
          {mayReadResults && <LinkButton href={PAYROLL_RESULT_ROUTE}>Payroll results</LinkButton>}
          <LinkButton href="/people/salary-structures">Salary structures</LinkButton>
        </>
      }
    >

      <p role="note" className="panel p-3 text-xs text-ink-soft">{COMPANY_RESPONSIBILITY_NOTICE}</p>

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
                {selected.staleReasons.length > 0 && (
                  <p role="alert" className="text-sm text-signal-error">
                    This calculation is out of date and cannot be released: {selected.staleReasons.join(' ')} Recalculate the run.
                  </p>
                )}
                {selected.status === 'PROPOSED' && selected.pendingAdjustments > 0 && (
                  <p role="alert" className="text-sm text-signal-error">
                    {selected.pendingAdjustments} one-time adjustment{selected.pendingAdjustments === 1 ? '' : 's'} for this company and period await approval and are not in this run.
                  </p>
                )}
                {selected.unpickedAdjustments > 0 && (
                  <p className="text-sm">
                    {selected.unpickedAdjustments} approved adjustment{selected.unpickedAdjustments === 1 ? '' : 's'} belong to employees this run does not pay (covered by another run, or an exception) and stay unapplied.
                    A frozen period is never reopened: cancel and enter the adjustment for a later period.
                  </p>
                )}
                {selected.status === 'POSTED' && (
                  <p className="text-xs text-ink-soft">Posting is accounting only. Paying employees, remitting liabilities and filing returns are completed by the company outside the ERP and are not recorded here.</p>
                )}
                {selected.predecessorRunId && (
                  <p className="text-sm">
                    Off-cycle run: it follows run{' '}
                    <Link href={`${ROUTE}?run=${selected.predecessorRunId}`} className="code underline">{selected.predecessorRunId}</Link>
                    {' '}and pays only employees no live run of this period covers.
                  </p>
                )}
                {selected.status === 'PROPOSED' && <p className="text-xs text-ink-soft">Not postable yet: the run has not been released.</p>}
                {selected.status === 'RELEASED' && <p className="text-xs text-ink-soft">Not payable yet: post the run first.</p>}
                {payment && (
                  <p className="text-sm">
                    Paid {payment.employeeCount} employees, {payment.totalAmount} {payment.currency}, on {payment.paymentDate} from house bank{' '}
                    {payment.houseBankKey} / {payment.bankAccountId} (G/L {payment.bankGlAccount}) as document{' '}
                    {mayDisplayJournal
                      ? <Link href={`/finance/journal/document?document=${payment.documentNumber}`} className="code underline">{payment.displayNumber}</Link>
                      : <span className="code">{payment.displayNumber}</span>}
                    {' '}by {payment.paidBy}.
                    <span className="text-ink-soft"> This is the accounting payment: the bank side is booked, but the ERP does not confirm that a bank transfer reached each employee — the transfer and its confirmation happen outside the ERP.</span>
                    {payment.reversalDocumentNumber ? ` Reversed by document ${payment.reversalDocumentNumber}; the run stays paid — a correction is a new document.` : ''}
                  </p>
                )}
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
                          <td className="code text-xs">
                            {e.reasonCode}
                            {e.informational && <span className="chip ml-1">information</span>}
                          </td>
                          <td className="text-sm">{e.message}</td>
                          <td className="text-xs text-ink-soft">{e.remedy ?? ''}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>

              <OperationPanel operation={operation} />
              <RunActions runId={selected.runId} status={selected.status} exceptionCount={selected.exceptionCount} mayPost={mayPost} busy={busy} pendingAdjustments={selected.pendingAdjustments} stale={selected.staleReasons.length > 0} />
              {selected.status === 'POSTED' && !payment && mayPay && (
                <PaySalaryForm runId={selected.runId} defaultDate={nextPeriodStart} banks={banks} />
              )}
              {selected.status === 'POSTED' && !payment && !mayPay && (
                <p className="text-sm text-ink-soft">Paying this run needs {SALARY_PAYMENT_CAPABILITY} and FIN.JOURNAL.POST.</p>
              )}
              {selected.status === 'POSTED' && mayExportFile && (
                <PaymentFilePanel runId={selected.runId} prepared={paymentFile} defaultDate={payment?.paymentDate ?? nextPeriodStart} />
              )}
              {paymentFile && (mayRequestReissue || mayApproveReissue || mayDownloadReissue || mayHistorical) && (
                <PaymentReissuePanel
                  preparationId={paymentFile.preparationId}
                  reissues={reissues}
                  canRequest={mayRequestReissue}
                  canApprove={mayApproveReissue}
                  canDownload={mayDownloadReissue}
                  canHistorical={mayHistorical}
                  currentUsername={session.user.username}
                  defaultDate={payment?.paymentDate ?? nextPeriodStart}
                />
              )}
              {selected.status === 'POSTED' && !mayExportFile && (
                <p className="text-sm text-ink-soft">Downloading the generic salary payment file needs {PAYMENT_FILE_CAPABILITY}.</p>
              )}
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

          {(mayEnter || mayApprove || allowed) && (
            <section className="panel space-y-3 overflow-x-auto p-4" aria-label="One-time adjustments">
              <h2 className="panel-title">
                One-time payroll adjustments{selected ? ` · company ${selected.companyCode}, period ${selected.period}/${selected.fiscalYear}` : ''}
              </h2>
              <p className="text-xs text-ink-soft">
                A fixed amount for one employee and period, with a reason, approved by someone other than the person who entered it. Only approved adjustments are calculated;
                an approved adjustment is applied once, when the run that calculated it is released. Amounts here are pay data.
              </p>
              {adjustmentNote && <p role="status" className="text-sm text-ink-soft">{adjustmentNote}</p>}
              {adjustments.length === 0 ? (
                <p className="text-sm text-ink-soft">No adjustments{selected ? ' for this period' : ''}.</p>
              ) : (
                <table className="grid-table">
                  <thead><tr><th>Employee</th><th>Period</th><th>Component</th><th>Amount</th><th>Reason / reference</th><th>Status</th><th>Entered by</th><th>Decision</th><th>Action</th></tr></thead>
                  <tbody>
                    {adjustments.map((a) => (
                      <tr key={a.adjustmentId}>
                        <td className="code">{a.personnelNumber}{a.employeeName ? <span className="text-xs text-ink-soft"> {a.employeeName}</span> : null}</td>
                        <td className="text-xs">{a.companyCode} {a.period}/{a.fiscalYear}</td>
                        <td className="text-xs"><span className="code">{a.componentCode}</span> {a.componentKind.toLowerCase().replace('_', ' ')}</td>
                        <td className="code">{a.amount} {a.currency}</td>
                        <td className="text-xs">{a.reason}{a.sourceReference ? ` · ref ${a.sourceReference}` : ''}{a.correctsResultId ? ` · corrects ${a.correctsResultId.slice(0, 8)}` : ''}</td>
                        <td><span className={a.status === 'APPLIED' || a.status === 'APPROVED' ? 'chip chip-ok' : a.status === 'PENDING' ? 'chip' : 'chip chip-warn'}>{a.status.toLowerCase()}</span>
                          {a.appliedRunId ? <div className="text-xs"><Link href={`${ROUTE}?run=${a.appliedRunId}`} className="underline">run</Link></div> : null}</td>
                        <td className="text-xs">{a.createdBy}<div className="text-ink-soft">{a.createdAt.slice(0, 16).replace('T', ' ')}</div></td>
                        <td className="text-xs">{a.decidedBy ? `${a.decidedBy} ${a.decidedAt?.slice(0, 16).replace('T', ' ')}` : ''}{a.decisionNote ? ` — ${a.decisionNote}` : ''}</td>
                        <td>
                          <AdjustmentRowActions
                            adjustmentId={a.adjustmentId} status={a.status} mayApprove={mayApprove} mayCancel={mayCancelAdjustment}
                            isCreator={a.createdBy.toLowerCase() === session.user.username.toLowerCase()}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              {mayEnter && (
                <EnterAdjustmentForm
                  companies={companies.map((c) => c.companyCode)}
                  defaultCompany={selected?.companyCode ?? defaultCompany}
                  defaultYear={selected?.fiscalYear ?? position?.fiscalYear ?? Number(today.slice(0, 4))}
                  defaultPeriod={selected?.period ?? position?.period ?? Number(today.slice(5, 7))}
                  components={entryComponents}
                  employees={[]}
                  requestKey={randomUUID()}
                />
              )}
            </section>
          )}

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
    </Page>
  );
}
