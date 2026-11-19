'use client';

import { useActionState, useState } from 'react';

import type { LeaveActionState } from '@/app/people/leave-live';
import type { PickerEmployee, TimeRecordRow } from '@/modules/people/leave-views';
import type { TimeTypeView } from '@/modules/people/time-leave';
import { recordTimeAction } from './actions';
import { INPUT, L, Notice, Section } from './ui';

const EMPTY: LeaveActionState = { ok: false };

export default function TimeRecordsTab({ times, types, employees, canEnter, params }: {
  times: TimeRecordRow[]; types: TimeTypeView[]; employees: PickerEmployee[]; canEnter: boolean; params: { emp?: string };
}) {
  const [form, setForm] = useState({ personnelNumber: '', timeTypeCode: '', recordingDate: '', hours: '' });
  const [state, run, pending] = useActionState(async (p: LeaveActionState, f: FormData) => {
    const r = await recordTimeAction(p, f);
    if (r.ok) setForm({ personnelNumber: '', timeTypeCode: '', recordingDate: '', hours: '' });
    return r;
  }, EMPTY);
  const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm((f) => ({ ...f, [k]: e.target.value }));
  return (
    <div>
      <form method="get" className="panel p-3 flex flex-wrap gap-3 items-end text-sm">
        <input type="hidden" name="tab" value="time" />
        <L label="Narrow the employee list"><input name="emp" defaultValue={params.emp ?? ''} className={INPUT} placeholder="number or name" /></L>
        <button className="btn">Apply</button>
      </form>
      <Section title="Record time">
        <Notice state={state} />
        <form action={run}>
          <fieldset disabled={!canEnter || pending} className="grid grid-cols-1 sm:grid-cols-5 gap-3 mt-2">
            <L label="Employee">
              <select name="personnelNumber" required className={INPUT} value={form.personnelNumber} onChange={set('personnelNumber')}>
                <option value="">—</option>{employees.map((e) => <option key={e.personnelNumber} value={e.personnelNumber}>{e.personnelNumber} · {e.fullName}</option>)}
              </select>
            </L>
            <L label="Time type">
              <select name="timeTypeCode" required className={INPUT} value={form.timeTypeCode} onChange={set('timeTypeCode')}>
                <option value="">—</option>{types.filter((t) => t.typeKind !== 'ABSENCE' && t.isValid).map((t) => <option key={t.code} value={t.code}>{t.code} · {t.name}</option>)}
              </select>
            </L>
            <L label="Date"><input name="recordingDate" type="date" required className={INPUT} value={form.recordingDate} onChange={set('recordingDate')} /></L>
            <L label="Hours"><input name="hours" type="number" step="0.01" min="0" max="24" required className={INPUT} value={form.hours} onChange={set('hours')} /></L>
            <div className="flex items-end"><button className="btn btn-primary w-full">{pending ? 'Recording…' : 'Record time'}</button></div>
          </fieldset>
        </form>
      </Section>
      <Section title="Recent time records">
        <table className="grid-table text-left text-sm border-collapse w-full">
          <thead><tr><th>Employee</th><th>Type</th><th>Date</th><th>Hours</th></tr></thead>
          <tbody>
            {times.map((t) => <tr key={`${t.personnelNumber}/${t.timeTypeCode}/${t.recordingDate}`}><td>{t.personnelNumber} {t.employeeName}</td><td>{t.timeTypeCode}</td><td>{t.recordingDate}</td><td>{t.hours}</td></tr>)}
            {times.length === 0 ? <tr><td colSpan={4} className="text-ink-soft">No time records in your scope.</td></tr> : null}
          </tbody>
        </table>
      </Section>
    </div>
  );
}
