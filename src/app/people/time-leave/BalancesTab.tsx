'use client';

import { useActionState, useRef, useState } from 'react';

import type { LeaveActionState } from '@/app/people/leave-live';
import type { AccrualStatus } from '@/modules/people/leave-accrual';
import type { ExportView } from '@/modules/people/leave-export';
import type { LeaveReport, ReportRow } from '@/modules/people/leave-report';
import type { PickerEmployee } from '@/modules/people/leave-views';
import type { TimeTypeView } from '@/modules/people/time-leave';
import {
  type ConversionState, type ExportState, adjustBalanceAction, legacyConversionAction, queueExportAction, runAccrualAction,
} from './actions';
import { INPUT, L, Notice, Section } from './ui';

const EMPTY: LeaveActionState = { ok: false };
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

type Params = { employees?: string; group?: string; year?: string; asOf?: string };
interface Caps { view: boolean; exportCsv: boolean; adjust: boolean; accrue: boolean }

function ReportTable({ rows }: { rows: ReportRow[] }) {
  if (rows.length === 0) return <p className="text-sm text-ink-soft">No balances for this selection in your scope.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="grid-table text-left text-sm border-collapse w-full">
        <thead>
          <tr><th>Employee</th><th>Type</th><th>Policy</th><th>Annual target</th><th>Opening</th><th>Accrued</th><th>Granted</th><th>Adjusted</th><th>Taken</th><th>Expired</th><th>Available</th><th>Pending (not reserved)</th><th>Last / next credit</th></tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <RowWithLines key={`${r.personnelNumber}/${r.timeTypeCode}/${r.year}`} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function RowWithLines({ r }: { r: ReportRow }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <tr className="hover:bg-tint align-top">
        <td className="font-mono">{r.personnelNumber}<div className="text-ink-soft font-sans">{r.fullName}</div></td>
        <td>{r.timeTypeCode}{r.mode === 'LEGACY' ? ' (legacy)' : ''}</td>
        <td>{r.policyCode ? `${r.policyCode} v${r.policyVersion} (${r.policySource === 'PERSON' ? 'person' : 'group'})` : '—'}</td>
        <td title="The yearly allowance is a target. Only completed months are earned.">{r.annualTarget ?? '—'}</td>
        <td>{r.opening}</td><td>{r.accrued}</td><td>{r.granted}</td><td>{r.adjusted}</td><td>{r.taken}</td><td>{r.expired}</td>
        <td className="font-semibold">{r.available}{r.reconciled ? '' : ' ⚠'}</td>
        <td>{r.pending}</td>
        <td>{r.lastCredit ?? '—'} / {r.nextCredit ?? '—'}</td>
      </tr>
      <tr>
        <td colSpan={13} className="text-xs text-ink-soft pb-2">
          {r.formula}{r.limitation ? ` · ${r.limitation}` : ''}{r.lateEntries > 0 ? ` · ${r.lateEntries} entr${r.lateEntries === 1 ? 'y' : 'ies'} recorded after the as-of day` : ''}{' '}
          {r.lines.length > 0 ? <button type="button" className="underline" onClick={() => setOpen(!open)}>{open ? 'Hide history' : `Month by month (${r.lines.length})`}</button> : null}
          {open ? (
            <table className="grid-table text-left border-collapse mt-1">
              <thead><tr><th>Effective</th><th>Kind</th><th>Days</th><th>Running total</th><th>Policy</th><th>Absence</th><th>Recorded</th><th>Note</th></tr></thead>
              <tbody>
                {r.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.effectiveDate}</td><td>{l.entryKind}</td><td>{l.quantity}</td><td>{l.cumulative}</td>
                    <td>{l.policyCode ? `${l.policyCode} v${l.policyVersion}` : '—'}</td>
                    <td className="font-mono">{l.absenceId ? l.absenceId.slice(0, 8) : '—'}</td>
                    <td>{l.recordedAt.slice(0, 16)}{l.late ? ' (late)' : ''}</td><td>{l.note ?? ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </td>
      </tr>
    </>
  );
}

function QueueExport({ params }: { params: Params }) {
  const key = useRef(newKey());
  const [state, run, pending] = useActionState(async (p: ExportState, f: FormData) => {
    const r = await queueExportAction(p, f);
    if (r.ok) key.current = newKey();
    return r;
  }, EMPTY as ExportState);
  return (
    <form action={run} className="mt-2">
      <input type="hidden" name="requestKey" value={key.current} />
      <input type="hidden" name="employees" value={params.employees ?? ''} />
      <input type="hidden" name="group" value={params.group ?? ''} />
      <input type="hidden" name="year" value={params.year ?? ''} />
      <input type="hidden" name="asOf" value={params.asOf ?? ''} />
      <button className="btn" disabled={pending}>{pending ? 'Queuing…' : 'Queue large export (background)'}</button>
      <Notice state={state} />
    </form>
  );
}

function Adjust({ types, employees, canAdjust, year }: { types: TimeTypeView[]; employees: PickerEmployee[]; canAdjust: boolean; year: number }) {
  const key = useRef(newKey());
  const blank = { personnelNumber: '', timeTypeCode: '', year: String(year), days: '', reason: '' };
  const [form, setForm] = useState(blank);
  const [state, run, pending] = useActionState(async (p: LeaveActionState, f: FormData) => {
    const r = await adjustBalanceAction(p, f);
    if (r.ok) { key.current = newKey(); setForm(blank); }
    return r;
  }, EMPTY);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <Section title="Adjust a balance" hint="A signed number of days, with a reason. It is a dated entry in the ledger from today (tenant time zone); nothing is overwritten. A balance may not go below zero.">
      <Notice state={state} />
      <form action={run}>
        <input type="hidden" name="requestKey" value={key.current} />
        <fieldset disabled={!canAdjust || pending} className="grid grid-cols-1 sm:grid-cols-6 gap-3 mt-2">
          <L label="Employee" span={2}>
            <select name="personnelNumber" required className={INPUT} value={form.personnelNumber} onChange={set('personnelNumber')}>
              <option value="">—</option>{employees.map((e) => <option key={e.personnelNumber} value={e.personnelNumber}>{e.personnelNumber} · {e.fullName}</option>)}
            </select>
          </L>
          <L label="Type">
            <select name="timeTypeCode" required className={INPUT} value={form.timeTypeCode} onChange={set('timeTypeCode')}>
              <option value="">—</option>{types.filter((t) => t.reducesQuota && t.isValid).map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
            </select>
          </L>
          <L label="Year"><input name="year" type="number" required className={INPUT} value={form.year} onChange={set('year')} /></L>
          <L label="Days (+/−)"><input name="days" required className={INPUT} value={form.days} onChange={set('days')} placeholder="-1.5" /></L>
          <L label="Reason" span={4}><input name="reason" required className={INPUT} value={form.reason} onChange={set('reason')} /></L>
          <div className="flex items-end"><button className="btn btn-primary w-full">{pending ? 'Posting…' : 'Post adjustment'}</button></div>
        </fieldset>
      </form>
    </Section>
  );
}

function Conversion({ canAdjust, employees, year }: { canAdjust: boolean; employees: PickerEmployee[]; year: number }) {
  const [form, setForm] = useState({ personnelNumber: '', cutover: `${year}-01-01` });
  const [state, run, pending] = useActionState(legacyConversionAction, EMPTY as ConversionState);
  const preview = state.preview;
  return (
    <Section title="Convert legacy quotas" hint="Hand-set quotas stay as they are until converted. Preview first: the remaining legacy balance becomes one opening entry and policy accrual counts from the cutover month. Nothing changes until you apply.">
      <Notice state={state} />
      <form action={run}>
        <fieldset disabled={!canAdjust || pending} className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-2">
          <L label="Employee" span={2}>
            <select name="personnelNumber" required className={INPUT} value={form.personnelNumber} onChange={(e) => setForm({ ...form, personnelNumber: e.target.value })}>
              <option value="">—</option>{employees.map((e) => <option key={e.personnelNumber} value={e.personnelNumber}>{e.personnelNumber} · {e.fullName}</option>)}
            </select>
          </L>
          <L label="Cutover (first of a month)"><input name="cutover" type="date" required className={INPUT} value={form.cutover} onChange={(e) => setForm({ ...form, cutover: e.target.value })} /></L>
          <div className="flex items-end gap-2">
            <button name="step" value="preview" className="btn">Preview</button>
            <button name="step" value="apply" className="btn btn-primary" disabled={!preview || preview.blocked > 0 || preview.convertible === 0 || preview.cutover !== form.cutover}>Apply</button>
          </div>
        </fieldset>
      </form>
      {preview ? (
        <table className="grid-table text-left text-sm border-collapse mt-2">
          <thead><tr><th>Type</th><th>Year</th><th>Entitlement</th><th>Taken</th><th>Remaining → opening</th><th>Blocker</th></tr></thead>
          <tbody>{preview.lines.map((l) => <tr key={`${l.timeTypeCode}/${l.year}`}><td>{l.timeTypeCode}</td><td>{l.year}</td><td>{l.entitlement}</td><td>{l.taken}</td><td>{l.remaining}</td><td>{l.blocker ?? '—'}</td></tr>)}</tbody>
        </table>
      ) : null}
    </Section>
  );
}

function Accrual({ status, canAccrue }: { status: AccrualStatus; canAccrue: boolean }) {
  const [state, run, pending] = useActionState(runAccrualAction, EMPTY);
  return (
    <Section title="Accrual status" hint={`Monthly credits are posted at month end in ${status.timezone}. Credits are due through ${status.dueThrough}; today is ${status.today}.`}>
      {status.lastRun ? (
        <p className="text-sm">Last run: {status.lastRun.kind} {status.lastRun.status} at {status.lastRun.startedAt.slice(0, 16)} — {status.lastRun.employees} employee(s), {status.lastRun.posted} credit(s), {status.lastRun.exceptions} exception(s){status.lastRun.backlog > 0 ? `, ${status.lastRun.backlog} older credit(s) not processed` : ''}.</p>
      ) : <p className="text-sm">No accrual run yet. The schedule is {status.scheduleEnabled ? 'enabled' : 'not enabled'}.</p>}
      {status.notProcessed.length > 0 ? (
        <ul className="panel panel-danger p-3 text-sm mt-2 list-disc ml-5">{status.notProcessed.map((n) => <li key={n}>Not processed: {n}</li>)}</ul>
      ) : <p className="text-sm text-ink-soft mt-1">Everything due has been processed.</p>}
      <Notice state={state} />
      <form action={run} className="mt-2 flex gap-2">
        <button name="kind" value="CATCH_UP" className="btn" disabled={!canAccrue || pending}>Run catch-up now</button>
        <button name="kind" value="BACKFILL" className="btn" disabled={!canAccrue || pending}>Backfill from assignment start (intensive)</button>
      </form>
    </Section>
  );
}

export default function BalancesTab({ report, employees, groups, params, caps, types, accrual, exportsList, today, year }: {
  report: LeaveReport | null; employees: PickerEmployee[]; groups: Array<{ code: string; name: string }>; params: Params; caps: Caps;
  types: TimeTypeView[]; accrual: AccrualStatus | null; exportsList: ExportView[]; today: string; year: number;
}) {
  const csvQuery = new URLSearchParams();
  if (params.employees) csvQuery.set('employees', params.employees);
  if (params.group) csvQuery.set('group', params.group);
  if (params.year) csvQuery.set('year', params.year);
  if (params.asOf) csvQuery.set('asOf', params.asOf);
  const requestedCount = (params.employees ?? '').split(/[\s,;]+/).filter(Boolean).length;
  return (
    <div>
      <form method="get" className="panel p-3 grid grid-cols-1 sm:grid-cols-5 gap-3 items-end text-sm">
        <input type="hidden" name="tab" value="balances" />
        <L label="Personnel numbers (comma separated)" span={2}><input name="employees" defaultValue={params.employees ?? ''} className={INPUT} placeholder="e.g. 1001, 1002" /></L>
        <L label="Leave group">
          <select name="group" defaultValue={params.group ?? ''} className={INPUT}><option value="">— none —</option>{groups.map((g) => <option key={g.code} value={g.code}>{g.code} · {g.name}</option>)}</select>
        </L>
        <L label="Year"><input name="year" type="number" defaultValue={params.year ?? ''} placeholder={String(year)} className={INPUT} /></L>
        <L label={`As of (up to ${today})`}><input name="asOf" type="date" max={today} defaultValue={params.asOf ?? ''} className={INPUT} /></L>
        <div className="sm:col-span-5 flex items-center gap-3">
          <button className="btn btn-primary">Show balances</button>
          <details className="text-ink-soft"><summary className="cursor-pointer">Employees in your scope ({employees.length})</summary>
            <p className="mt-1 max-w-3xl">{employees.map((e) => `${e.personnelNumber} ${e.fullName}`).join(' · ') || 'none'}</p>
          </details>
        </div>
      </form>

      {report ? (
        <Section title={`Balances as of ${report.asOf} (${report.year}, ${report.timezone})`} hint={report.basis}>
          <ReportTable rows={report.rows} />
          {report.unavailable.length > 0 ? <p className="mt-2 text-sm text-ink-soft">Not available to you: {report.unavailable.join(', ')}.</p> : null}
          {report.truncated.employees ? <p className="mt-2 text-sm text-signal-danger">Partial: the selection was cut at the report limit. Use the background export for the full list.</p> : null}
          {report.truncated.lines ? <p className="mt-2 text-sm text-signal-danger">Partial: month-by-month history was cut at the line limit; the totals above are complete.</p> : null}
          {report.projectionDrift.length > 0 ? (
            <p className="mt-2 text-sm text-signal-danger">Defect: the quota projection disagrees with the ledger for {report.projectionDrift.map((d) => `${d.personnelNumber} ${d.timeTypeCode} ${d.year}`).join(', ')}.</p>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center gap-3">
            {caps.exportCsv ? <a className="btn" href={`/api/leave/balances/export?${csvQuery.toString()}`}>Download CSV</a> : <span className="text-sm text-ink-soft">CSV needs PEOPLE.LEAVE.EXPORT.</span>}
            {caps.exportCsv && (requestedCount > 100 || report.truncated.employees) ? <QueueExport params={params} /> : null}
          </div>
        </Section>
      ) : <p className="mt-3 text-sm text-ink-soft">Choose employees or a leave group to see balances. Only employees in your Company Code scope are shown.</p>}

      {caps.exportCsv ? (
        <Section title="Your exports" hint="Large exports run on the intensive worker with your authority and expire after 7 days.">
          <ul className="text-sm space-y-1">
            {exportsList.map((e) => (
              <li key={e.exportId}>{e.createdAt.slice(0, 16)} — {e.status}{e.rows !== null ? `, ${e.rows} row(s)` : ''}{e.notes ? ` · ${e.notes}` : ''}{e.errorCode ? ` · ${e.errorCode}` : ''}{' '}
                {e.downloadPath ? <a className="underline" href={e.downloadPath}>Download</a> : null}</li>
            ))}
            {exportsList.length === 0 ? <li className="text-ink-soft">No exports yet.</li> : null}
          </ul>
        </Section>
      ) : null}

      {caps.adjust ? <Adjust types={types} employees={employees} canAdjust={caps.adjust} year={year} /> : null}
      {caps.adjust ? <Conversion canAdjust={caps.adjust} employees={employees} year={year} /> : null}
      {caps.accrue && accrual ? <Accrual status={accrual} canAccrue={caps.accrue} /> : null}
    </div>
  );
}
