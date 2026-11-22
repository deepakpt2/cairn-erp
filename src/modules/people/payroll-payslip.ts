/**
 * Printable employee payslip — an official statement of one payroll result.
 *
 * This is a *view* of `payroll_result` and `payroll_result_line`, not a new calculation: the amounts,
 * component codes, segments and dates are read as they were stored. Nothing here recalculates payroll,
 * totals its own subtotals, posts, pays, or re-reads the configuration the result was calculated
 * against. A payslip states what the payroll calculation produced for the period; it says nothing about
 * whether a bank received the money, and it makes no statement about statutory compliance.
 *
 * Two rules decide whether a payslip may be produced at all:
 * - Only a RELEASED or POSTED run is final. A PROPOSED result can still be recalculated, and a
 *   CANCELLED result belongs to a withdrawn run, so neither is an official payslip.
 * - The caller is judged in this file's own transaction: a live session, the payroll-result (or
 *   payroll-run) capability, and Company Code reach over the run's company. A result outside that
 *   reach answers exactly like one that does not exist, so the endpoint cannot be used to probe for
 *   payroll data.
 *
 * The tenant is passed by the route handler from the authenticated session; nothing here reads a tenant
 * from user input. `renderPayslipHtml` is a pure function over the view and escapes every value.
 */
import { and, asc, eq } from 'drizzle-orm';

import { type ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { withTenant } from '../../platform/db/client';
import { moneyOf } from '../../platform/posting/money';
import { judgePayrollAccess, reachesCompany } from './payroll-access';
import { COMPANY_RESPONSIBILITY_NOTICE } from './payroll-components';
import { PAYROLL_RESULT_CAPABILITY, PAYROLL_RUN_CAPABILITY, currencyDecimals } from './payroll-run';
import { employee, payrollResult, payrollResultLine, payrollRun } from './schema';
import { companyCode } from '../foundation/schema';

/** The capabilities a payslip reader may hold — the same pair the run's read services use. */
const READ = [PAYROLL_RESULT_CAPABILITY, PAYROLL_RUN_CAPABILITY] as const;

/** The printable endpoint. A route handler linked from the result, not a navigation screen. */
export const PAYSLIP_ROUTE = '/people/payroll-results/payslip';

export class PayslipError extends Error {
  remedy?: string;
  /** A stable code a test or caller can branch on. The message is for people. */
  readonly code: string;
  constructor(message: string, remedy?: string, code = 'PAYSLIP') {
    super(message);
    this.name = 'PayslipError';
    this.remedy = remedy;
    this.code = code;
  }
}

export function isPayslipError(error: unknown): error is PayslipError {
  return error instanceof PayslipError;
}

export function refuse(code: string, message: string, remedy?: string): never {
  throw new PayslipError(message, remedy, code);
}

/** The session form of payroll authority. Never a capability array: the session is re-judged here. */
export interface PayslipAccess {
  authorization: ServiceAuthorityContext | undefined;
}

export interface PayslipLine {
  lineNo: number;
  segmentFrom: string;
  segmentTo: string;
  payableDays: string;
  structureCode: string;
  componentCode: string;
  amount: string;
  sourceType: string;
  sourceLabel: string;
  basis: string | null;
}

export interface PayslipCompany {
  code: string;
  name: string;
  city: string | null;
  address: string | null;
  country: string;
  taxRegistrationNumber: string | null;
}

export interface PayslipView {
  resultId: string;
  personnelNumber: string;
  /** Read from the employee master today; the payslip labels it as current master data. */
  employeeName: string | null;
  currency: string;
  decimals: number;
  company: PayslipCompany;
  run: {
    runId: string;
    fiscalYear: number;
    period: number;
    periodFrom: string;
    periodTo: string;
    totalDays: number;
    status: 'RELEASED' | 'POSTED';
    /** The payroll posting document when the run is posted. It is a posting, never a payment. */
    documentNumber: string | null;
  };
  days: { payable: string; total: string; covered: string; unpaid: string };
  earnings: PayslipLine[];
  deductions: PayslipLine[];
  /** Shown apart from the employee's deductions: nothing here is deducted from net pay. */
  employerContributions: PayslipLine[];
  /** A kind none of the three above; shown rather than silently dropped. */
  otherLines: PayslipLine[];
  /** Exactly the persisted totals, written at the currency's precision. Never summed here. */
  totals: { gross: string; deductions: string; net: string; employerCost: string };
  notice: string;
}

const text = (v: unknown) => (v === null || v === undefined ? '0' : String(v));

const SOURCE_LABEL: Record<string, string> = {
  STRUCTURE: 'Structure rule',
  EMPLOYEE_ADD: 'Employee addition',
  EMPLOYEE_REPLACE: 'Employee replacement',
  ONE_TIME: 'One-time adjustment',
};

export function sourceLabel(source: string): string {
  return SOURCE_LABEL[source] ?? source;
}

function assertResultId(value: string): string {
  const resultId = value.trim();
  if (!resultId || resultId.length > 36) {
    refuse('PAYSLIP_INPUT', 'Choose a payroll result to print.', 'Open a slip at the payroll results screen.');
  }
  return resultId;
}

const UNAVAILABLE = 'That payroll result does not exist, or is not available to you.';
const UNAVAILABLE_REMEDY = 'Open a slip you reach at the payroll results screen.';

/**
 * Build the payslip view. Refuses an unauthenticated caller, a caller without the payroll-result
 * capability, a result outside the caller's Company Code reach (exactly like a missing one), and a
 * result whose run is PROPOSED or CANCELLED.
 */
export async function getPayslip(client: string, resultIdInput: string, access: PayslipAccess): Promise<PayslipView> {
  const resultId = assertResultId(resultIdInput);
  return withTenant(client, async (tx) => {
    const grant = await judgePayrollAccess(tx, client, access, READ, refuse, 'PAYSLIP_AUTHORITY');

    const [found] = await tx
      .select({ result: payrollResult, employeeName: employee.fullName })
      .from(payrollResult)
      .leftJoin(employee, and(eq(employee.client, payrollResult.client), eq(employee.personnelNumber, payrollResult.personnelNumber)))
      .where(and(eq(payrollResult.client, client), eq(payrollResult.resultId, resultId)))
      .limit(1);
    if (!found) refuse('PAYSLIP_UNAVAILABLE', UNAVAILABLE, UNAVAILABLE_REMEDY);

    const [run] = await tx.select().from(payrollRun)
      .where(and(eq(payrollRun.client, client), eq(payrollRun.runId, found.result.runId)))
      .limit(1);
    // An inaccessible result reads like a missing one — the endpoint must not leak that it exists.
    if (!run || !reachesCompany(grant, run.companyCode)) {
      refuse('PAYSLIP_UNAVAILABLE', UNAVAILABLE, UNAVAILABLE_REMEDY);
    }
    if (run.status === 'PROPOSED') {
      refuse(
        'PAYSLIP_NOT_FINAL',
        `Payroll run ${run.runId} is still proposed; only a released or posted result is an official payslip.`,
        'Release the run, then print its slips.',
      );
    }
    if (run.status === 'CANCELLED') {
      refuse(
        'PAYSLIP_CANCELLED',
        `Payroll run ${run.runId} is cancelled; a cancelled result is not an official payslip.`,
        'Choose a result of a released or posted run.',
      );
    }

    const [company] = await tx.select({
      name: companyCode.name,
      city: companyCode.city,
      address: companyCode.address,
      country: companyCode.country,
      taxRegistrationNumber: companyCode.taxRegistrationNumber,
    }).from(companyCode)
      .where(and(eq(companyCode.client, client), eq(companyCode.companyCode, run.companyCode)))
      .limit(1);
    if (!company) {
      refuse('PAYSLIP_COMPANY', `Company code ${run.companyCode} does not exist.`, 'Correct the run’s company code, then print again.');
    }

    const decimals = await currencyDecimals(tx, run.currency);
    const money = moneyOf(run.currency, decimals);
    const lines = await tx.select()
      .from(payrollResultLine)
      .where(and(eq(payrollResultLine.client, client), eq(payrollResultLine.resultId, resultId)))
      .orderBy(asc(payrollResultLine.lineNo));
    if (lines.length === 0) {
      refuse('PAYSLIP_EMPTY', 'This payroll result carries no component lines, so there is nothing to print.', 'Recalculate the run, or choose another result.');
    }

    const mapped = lines.map((l) => ({
      kind: l.componentKind,
      line: {
        lineNo: l.lineNo,
        segmentFrom: l.segmentFrom,
        segmentTo: l.segmentTo,
        payableDays: text(l.payableDays),
        structureCode: l.structureCode,
        componentCode: l.componentCode,
        amount: money.text(text(l.amount)),
        sourceType: l.sourceType,
        sourceLabel: sourceLabel(l.sourceType),
        basis: l.calcBasis ?? null,
      } satisfies PayslipLine,
    }));
    const ofKind = (kind: string) => mapped.filter((l) => l.kind === kind).map((l) => l.line);

    const r = found.result;
    const view: PayslipView = {
      resultId: r.resultId,
      personnelNumber: r.personnelNumber,
      employeeName: found.employeeName ?? null,
      currency: run.currency,
      decimals,
      company: {
        code: run.companyCode,
        name: company.name,
        city: company.city ?? null,
        address: company.address ?? null,
        country: company.country,
        taxRegistrationNumber: company.taxRegistrationNumber ?? null,
      },
      run: {
        runId: run.runId,
        fiscalYear: run.fiscalYear,
        period: run.period,
        periodFrom: run.periodFrom,
        periodTo: run.periodTo,
        totalDays: run.totalDays,
        status: run.status as 'RELEASED' | 'POSTED',
        documentNumber: run.documentNumber ?? null,
      },
      days: {
        payable: text(r.payableDays),
        total: text(r.totalDays),
        covered: text(r.coveredDays),
        unpaid: text(r.unpaidLeaveDays),
      },
      earnings: ofKind('EARNING'),
      deductions: ofKind('DEDUCTION'),
      employerContributions: ofKind('EMPLOYER_CONTRIBUTION'),
      otherLines: mapped.filter((l) => !['EARNING', 'DEDUCTION', 'EMPLOYER_CONTRIBUTION'].includes(l.kind)).map((l) => l.line),
      totals: {
        gross: money.text(text(r.grossPay)),
        deductions: money.text(text(r.totalDeductions)),
        net: money.text(text(r.netPay)),
        employerCost: money.text(text(r.employerCost)),
      },
      notice: COMPANY_RESPONSIBILITY_NOTICE,
    };
    return view;
  });
}

// ── HTML ────────────────────────────────────────────────────────────────────

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const esc = (value: unknown) => String(value ?? '').replace(/[&<>"']/g, (c) => ESC[c]!);

const KIND_LABEL: Record<string, string> = {
  EARNING: 'Earnings',
  DEDUCTION: 'Deductions',
  EMPLOYER_CONTRIBUTION: 'Employer contributions',
};

function lineRows(lines: PayslipLine[], empty: string): string {
  if (lines.length === 0) return `<tr><td colspan="7" class="muted">${esc(empty)}</td></tr>`;
  return lines
    .map(
      (l) => `<tr>
        <td class="num">${l.lineNo}</td>
        <td>${esc(l.segmentFrom)} to ${esc(l.segmentTo)}<br><span class="muted">${esc(l.structureCode)}</span></td>
        <td class="num">${esc(l.payableDays)}</td>
        <td class="code">${esc(l.componentCode)}</td>
        <td>${esc(l.sourceLabel)}</td>
        <td class="basis">${esc(l.basis ?? '')}</td>
        <td class="num">${esc(l.amount)}</td>
      </tr>`,
    )
    .join('');
}

function table(title: string, lines: PayslipLine[], empty: string, note?: string): string {
  return `<section class="block">
    <h3>${esc(title)}</h3>
    ${note ? `<p class="muted small">${esc(note)}</p>` : ''}
    <table>
      <thead>
        <tr><th class="num">#</th><th>Segment</th><th class="num">Days</th><th>Component</th><th>Source</th><th>Rule and basis</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${lineRows(lines, empty)}</tbody>
    </table>
  </section>`;
}

/**
 * The printable document: one self-contained HTML page, no external resource, no script and no
 * navigation. A browser print (or Save as PDF) reproduces exactly this page.
 */
export function renderPayslipHtml(view: PayslipView): string {
  const who = view.employeeName
    ? `${esc(view.employeeName)} <span class="muted small">(name from current master data)</span>`
    : '<span class="muted">Name not recorded — current master data unavailable</span>';
  const address = view.company.address ? esc(view.company.address).replace(/\n/g, '<br>') : null;
  const posted = view.run.status === 'POSTED'
    ? `<p class="muted small">Payroll posting document <span class="code">${esc(view.run.documentNumber ?? '')}</span>. A posting records the accounting document; it is not proof that money left the company.</p>`
    : '<p class="muted small">The run is released and not yet posted to the general ledger. This payslip is the calculation, not a posting.</p>';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>Payslip ${esc(view.personnelNumber)} — ${esc(view.run.fiscalYear)}/${esc(view.run.period)}</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #fff; color: #111; font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif; }
  .sheet { max-width: 780px; margin: 0 auto; padding: 22mm 18mm; }
  .letterhead { display: flex; justify-content: space-between; gap: 24px; border-bottom: 2px solid #111; padding-bottom: 10px; }
  .letterhead h1 { margin: 0; font-size: 20px; letter-spacing: .01em; }
  .letterhead .muted { font-size: 12px; }
  .doc-title { margin: 18px 0 4px; font-size: 16px; font-weight: 600; text-transform: uppercase; letter-spacing: .06em; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 28px; margin: 12px 0 18px; font-size: 12.5px; }
  .meta div { display: flex; justify-content: space-between; gap: 12px; border-bottom: 1px dotted #bbb; padding: 2px 0; }
  .meta dt { color: #444; }
  .meta dd { margin: 0; text-align: right; }
  .block { margin-top: 16px; page-break-inside: avoid; }
  .block h3 { margin: 0 0 6px; font-size: 13px; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid #111; padding-bottom: 3px; }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: 4px 6px; border-bottom: 1px solid #ddd; vertical-align: top; font-size: 12px; }
  th { text-align: left; color: #333; font-weight: 600; background: #f4f4f4; }
  .num { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
  .code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .basis { max-width: 250px; }
  .muted { color: #555; }
  .small { font-size: 11.5px; }
  .totals { margin-top: 18px; border: 1px solid #111; page-break-inside: avoid; }
  .totals table td { font-size: 12.5px; }
  .totals tr.total td { font-weight: 700; font-size: 14px; border-bottom: 0; }
  .notice { margin-top: 18px; border-top: 1px solid #111; padding-top: 8px; font-size: 11px; color: #333; }
  .hint { margin: 0 0 14px; padding: 8px 10px; background: #f4f4f4; border: 1px solid #ddd; font-size: 12px; }
  @media print {
    @page { size: A4; margin: 14mm; }
    body { font-size: 11.5px; }
    .sheet { max-width: none; padding: 0; }
    .hint { display: none; }
    a { color: inherit; text-decoration: none; }
  }
</style>
</head>
<body>
<main class="sheet">
  <header class="letterhead">
    <div>
      <h1>${esc(view.company.name)}</h1>
      ${address ? `<div class="muted">${address}</div>` : ''}
      <div class="muted">${esc(view.company.city ?? '')}${view.company.city ? ', ' : ''}${esc(view.company.country)}</div>
      ${view.company.taxRegistrationNumber ? `<div class="muted">Tax registration: ${esc(view.company.taxRegistrationNumber)}</div>` : ''}
    </div>
    <div class="muted small">
      <div>Company code ${esc(view.company.code)}</div>
      <div>Payroll run ${esc(view.run.runId)}</div>
    </div>
  </header>

  <p class="hint">This is the printable payslip. Use your browser's Print command (Ctrl/Cmd + P) and choose “Save as PDF” to keep a copy.</p>

  <h2 class="doc-title">Payslip</h2>
  <p class="muted small">Official payroll calculation for period ${esc(view.run.period)} of ${esc(view.run.fiscalYear)}.</p>

  <dl class="meta">
    <div><dt>Personnel number</dt><dd class="code">${esc(view.personnelNumber)}</dd></div>
    <div><dt>Employee</dt><dd>${who}</dd></div>
    <div><dt>Payroll period</dt><dd>${esc(view.run.period)} / ${esc(view.run.fiscalYear)}</dd></div>
    <div><dt>Run status</dt><dd>${esc(view.run.status.toLowerCase())}</dd></div>
    <div><dt>Period dates</dt><dd>${esc(view.run.periodFrom)} to ${esc(view.run.periodTo)} <span class="muted">(${esc(view.run.totalDays)} days)</span></dd></div>
    <div><dt>Currency</dt><dd>${esc(view.currency)} <span class="muted">(${esc(view.decimals)} decimals)</span></dd></div>
    <div><dt>Days paid</dt><dd>${esc(view.days.payable)} of ${esc(view.days.total)}</dd></div>
    <div><dt>Unpaid leave</dt><dd>${esc(view.days.unpaid)} day(s) <span class="muted">(covered ${esc(view.days.covered)})</span></dd></div>
  </dl>

  ${posted}

  ${table(KIND_LABEL.EARNING!, view.earnings, 'No earning component in this result.')}
  ${table(KIND_LABEL.DEDUCTION!, view.deductions, 'No deduction component in this result.')}
  ${table(
    KIND_LABEL.EMPLOYER_CONTRIBUTION!,
    view.employerContributions,
    'No employer contribution in this result.',
    'Employer contributions are the company’s cost. They are not deducted from the employee’s net pay.',
  )}
  ${view.otherLines.length ? table('Other components', view.otherLines, '') : ''}

  <section class="totals">
    <table>
      <tbody>
        <tr><td>Gross pay</td><td class="num">${esc(view.totals.gross)} ${esc(view.currency)}</td></tr>
        <tr><td>Total deductions</td><td class="num">${esc(view.totals.deductions)} ${esc(view.currency)}</td></tr>
        <tr class="total"><td>Net pay</td><td class="num">${esc(view.totals.net)} ${esc(view.currency)}</td></tr>
        <tr><td class="muted">Employer cost, not part of net pay</td><td class="num muted">${esc(view.totals.employerCost)} ${esc(view.currency)}</td></tr>
      </tbody>
    </table>
  </section>

  <p class="notice"><strong>This payslip is a payroll calculation.</strong> It records what the run calculated for the period and the amounts the employee accounts will post. It is not evidence that a bank payment succeeded, and it is not a statutory filing or a statement of compliance. ${esc(view.notice)}</p>
</main>
</body>
</html>`;
}

/** The printable endpoint for one result, linked from the results screen. */
export function payslipHref(resultId: string): string {
  return `${PAYSLIP_ROUTE}?result=${encodeURIComponent(resultId)}`;
}

/** A payslip exists only for a final run; the results screen uses this to show the link. */
export function payslipAvailable(status: string): boolean {
  return status === 'RELEASED' || status === 'POSTED';
}
