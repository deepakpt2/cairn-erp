'use client';

import { useActionState, useRef, useState } from 'react';

import type { AbsencePlan } from '@/modules/people/leave-absence';
import type { AbsenceRow, PickerEmployee } from '@/modules/people/leave-views';
import type { TimeTypeView } from '@/modules/people/time-leave';
import { type AbsenceActionState, decideAbsenceAction, previewAbsenceAction, requestAbsenceAction } from './actions';
import { INPUT, L, Notice, Section } from './ui';

const EMPTY: AbsenceActionState = { ok: false };
const newKey = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `k-${Date.now()}-${Math.random().toString(36).slice(2)}`);

function Plan({ plan, accepted, onAccept }: { plan: AbsencePlan; accepted: boolean; onAccept: (v: boolean) => void }) {
  if (!plan.managed) {
    return <p className="mt-2 text-sm text-ink-soft">No leave policy governs this request: the legacy rules apply and no split is made.</p>;
  }
  return (
    <div className="mt-2 text-sm">
      <p className="font-medium">Preview (policy {plan.policyCode}): {plan.paidDays} paid day(s), {plan.unpaidDays} unpaid day(s). Nothing is reserved until you request.</p>
      <table className="grid-table text-left border-collapse mt-1">
        <thead><tr><th>Dates</th><th>Days</th><th>Charged to</th><th>Pay</th></tr></thead>
        <tbody>
          {plan.spans.map((s, i) => (
            <tr key={i}><td>{s.from === s.to ? s.from : `${s.from} – ${s.to}`}</td><td>{s.days}</td><td>{s.typeCode} {s.year}</td><td>{s.isPaid ? 'paid' : 'unpaid'}</td></tr>
          ))}
        </tbody>
      </table>
      {plan.uncovered.length > 0 ? <p className="mt-1 text-signal-danger">Not covered by a policy: {plan.uncovered.join(', ')}.</p> : null}
      {plan.requiresConfirmation ? (
        <label className="mt-2 flex items-center gap-2">
          <input type="checkbox" checked={accepted} onChange={(e) => onAccept(e.target.checked)} />
          <span>I accept {plan.unpaidDays} unpaid day(s) for this request.</span>
        </label>
      ) : null}
    </div>
  );
}

function RequestForm({ types, employees, canEnter }: { types: TimeTypeView[]; employees: PickerEmployee[]; canEnter: boolean }) {
  const [form, setForm] = useState({ personnelNumber: '', timeTypeCode: '', validFrom: '', validTo: '', reason: '' });
  const [accepted, setAccepted] = useState(false);
  const key = useRef(newKey());
  const [preview, previewRun, previewing] = useActionState(previewAbsenceAction, EMPTY);
  const [previewedFor, setPreviewedFor] = useState('');
  const [result, requestRun, requesting] = useActionState(async (p: AbsenceActionState, f: FormData) => {
    const r = await requestAbsenceAction(p, f);
    if (r.ok) { key.current = newKey(); setForm({ personnelNumber: '', timeTypeCode: '', validFrom: '', validTo: '', reason: '' }); setAccepted(false); }
    return r;
  }, EMPTY);

  const sig = `${form.personnelNumber}|${form.timeTypeCode}|${form.validFrom}|${form.validTo}`;
  const plan = preview.plan && previewedFor === sig ? preview.plan : undefined; // an edited form invalidates the preview
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => { setForm((f) => ({ ...f, [k]: e.target.value })); setAccepted(false); };

  return (
    <Section title="Request an absence" hint="Preview the paid/unpaid split first. If any days are unpaid you must accept them before the request is recorded; the server checks this again.">
      <Notice state={result} />
      <form action={requestRun}>
        <fieldset disabled={!canEnter || requesting} className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-2">
          <input type="hidden" name="requestKey" value={key.current} />
          <input type="hidden" name="confirmUnpaid" value={accepted && plan ? String(plan.unpaidDays) : ''} />
          <L label="Employee" span={2}>
            <select name="personnelNumber" required className={INPUT} value={form.personnelNumber} onChange={set('personnelNumber')}>
              <option value="">— choose (narrow the list above) —</option>
              {employees.map((e) => <option key={e.personnelNumber} value={e.personnelNumber}>{e.personnelNumber} · {e.fullName}</option>)}
            </select>
          </L>
          <L label="Absence type">
            <select name="timeTypeCode" required className={INPUT} value={form.timeTypeCode} onChange={set('timeTypeCode')}>
              <option value="">—</option>
              {types.filter((t) => t.typeKind === 'ABSENCE' && t.isValid).map((t) => <option key={t.code} value={t.code}>{t.code} · {t.name}</option>)}
            </select>
          </L>
          <span />
          <L label="From"><input name="validFrom" type="date" required className={INPUT} value={form.validFrom} onChange={set('validFrom')} /></L>
          <L label="To (needed for policy leave)"><input name="validTo" type="date" className={INPUT} value={form.validTo} onChange={set('validTo')} /></L>
          <L label="Reason" span={2}><input name="reason" className={INPUT} value={form.reason} onChange={set('reason')} /></L>
          <div className="sm:col-span-4 flex gap-2">
            <button type="submit" formAction={async (f) => { setPreviewedFor(sig); await previewRun(f); }} disabled={previewing} className="btn">{previewing ? 'Previewing…' : 'Preview split'}</button>
            <button type="submit" className="btn btn-primary" disabled={!!plan?.requiresConfirmation && !accepted}>{requesting ? 'Requesting…' : 'Request absence'}</button>
          </div>
        </fieldset>
      </form>
      {preview.ok === false && preview.message ? <Notice state={preview} /> : null}
      {plan ? <Plan plan={plan} accepted={accepted} onAccept={setAccepted} /> : null}
    </Section>
  );
}

function DecideRow({ a, canApprove }: { a: AbsenceRow; canApprove: boolean }) {
  const [state, run, pending] = useActionState(decideAbsenceAction, EMPTY);
  const [confirm, setConfirm] = useState('');
  const open = a.status === 'REQUESTED' || a.status === 'APPROVED';
  return (
    <tr className="hover:bg-tint align-top">
      <td className="font-mono">{a.personnelNumber}<div className="text-ink-soft font-sans">{a.employeeName}</div></td>
      <td>{a.timeTypeCode}</td><td>{a.validFrom}</td><td>{a.validTo ?? 'open'}</td><td>{a.status}</td>
      <td>
        {a.policyManaged
          ? a.paidDays !== null || a.unpaidDays !== null
            ? `${a.paidDays ?? '0'} paid / ${a.unpaidDays ?? '0'} unpaid (kept)`
            : `confirmed unpaid: ${a.confirmedUnpaidDays ?? '0'}`
          : 'legacy'}
      </td>
      <td>
        {open ? (
          <form action={run} className="flex flex-wrap items-center gap-1">
            <input type="hidden" name="absenceId" value={a.id} />
            {a.status === 'REQUESTED' ? <input name="confirmUnpaid" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="unpaid days to accept" size={9} className="border rounded px-1 text-xs" /> : null}
            {a.status === 'REQUESTED' ? <button name="decision" value="APPROVED" disabled={!canApprove || pending} className="btn text-xs">Approve</button> : null}
            {a.status === 'REQUESTED' ? <button name="decision" value="REJECTED" disabled={!canApprove || pending} className="btn text-xs">Reject</button> : null}
            <button name="decision" value="CANCELLED" disabled={!canApprove || pending} className="btn text-xs">Cancel</button>
            {state.message ? <span className={`text-xs ${state.ok ? 'text-signal-ok' : 'text-signal-danger'}`}>{state.message} {state.remedy}</span> : null}
          </form>
        ) : null}
      </td>
    </tr>
  );
}

export default function AbsencesTab({ absences, types, employees, caps, params }: {
  absences: AbsenceRow[]; types: TimeTypeView[]; employees: PickerEmployee[];
  caps: { enter: boolean; approve: boolean }; params: { q?: string; status?: string; emp?: string };
}) {
  return (
    <div>
      <form method="get" className="panel p-3 flex flex-wrap gap-3 items-end text-sm">
        <input type="hidden" name="tab" value="absences" />
        <L label="Narrow the employee list"><input name="emp" defaultValue={params.emp ?? ''} className={INPUT} placeholder="number or name" /></L>
        <L label="Filter absences"><input name="q" defaultValue={params.q ?? ''} className={INPUT} placeholder="number or name" /></L>
        <L label="Status">
          <select name="status" defaultValue={params.status ?? ''} className={INPUT}>
            <option value="">any</option><option>REQUESTED</option><option>APPROVED</option><option>REJECTED</option><option>CANCELLED</option>
          </select>
        </L>
        <button className="btn">Apply</button>
        <span className="text-ink-soft">{employees.length} employee(s) in your scope match.</span>
      </form>
      <RequestForm types={types} employees={employees} canEnter={caps.enter} />
      <Section title="Absences">
        <table className="grid-table text-left text-sm border-collapse w-full">
          <thead><tr><th>Employee</th><th>Type</th><th>From</th><th>To</th><th>Status</th><th>Split</th><th>Decide</th></tr></thead>
          <tbody>
            {absences.map((a) => <DecideRow key={a.id} a={a} canApprove={caps.approve} />)}
            {absences.length === 0 ? <tr><td colSpan={7} className="text-ink-soft">No absences in your scope.</td></tr> : null}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
