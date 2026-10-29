'use client';

import Link from 'next/link';
import { useActionState, useState } from 'react';

import type {
  AbsenceView,
  TimeLeaveActionState,
  TimeRecordingView,
  TimeTypeView,
} from '@/modules/people/time-leave';
import {
  decideAbsenceAction,
  defineTimeTypeAction,
  recordTimeAction,
  requestAbsenceAction,
  setLeaveQuotaAction,
  changeTimeTypeAction,
} from './actions';

const EMPTY: TimeLeaveActionState = { ok: false };

interface Props {
  timeTypes: TimeTypeView[];
  selectedType: TimeTypeView | null;
  absences: AbsenceView[];
  selectedAbsence: AbsenceView | undefined;
  employee: string;
  query: string;
  canWrite: boolean;
  canView: boolean;
}

function Notice({ state }: { state: TimeLeaveActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

function textLabel(kind: string): string {
  if (kind === 'ABSENCE') return 'absence';
  if (kind === 'ATTENDANCE') return 'attendance';
  return 'overtime';
}

/** ───────── Time type definition ───────── */
function TimeTypeForm({ canWrite }: { canWrite: boolean }) {
  const [state, setState] = useState<TimeLeaveActionState>(EMPTY);
  const [actionState, setActionState] = useState<TimeLeaveActionState>(EMPTY);

  const [isPending, formAction] = useActionState(defineTimeTypeAction, actionState, `/people/time-leave`);

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Define a time type</h2>
      <Notice state={state} />
      {!canWrite && (
        <p className="text-ink-soft text-sm">
          This session does not hold {`PEOPLE.TIME.ENTER`}. The form is read.
        </p>
      )}
      <form action={formAction} className="grid grid-cols-1 sm:grid-cols-3 gap-3" disabled={!canWrite}>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Code</label>
          <input name="code" required className="w-full border rounded px-2 py-1 text-sm" placeholder="e.g. LEAVE" />
        </div>
        <div className="col-span-1 sm:col-span-2">
          <label className="block text-xs text-ink-soft mb-1">Name</label>
          <input name="name" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Kind</label>
          <select name="typeKind" className="w-full border rounded px-2 py-1 text-sm">
            <option value="ABSENCE">absence</option>
            <option value="ATTENDANCE">attendance</option>
            <option value="OVERTIME">overtime</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-2">
          <label className="block text-xs text-ink-soft mb-1">Description</label>
          <input name="description" className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Reduces quota</label>
          <select name="reducesQuota" className="w-full border rounded px-2 py-1 text-sm">
            <option value="no">no</option>
            <option value="yes">yes</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">&nbsp;</label>
          <button
            type="submit"
            disabled={isPending || !canWrite}
            className="w-full btn btn-primary"
          >
            {isPending ? 'Defining…' : 'Define time type'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ───────── Time type change ───────── */
function TimeTypeChange({ type, canWrite }: { type: TimeTypeView | null; canWrite: boolean }) {
  const [state, setState] = useState<TimeLeaveActionState>(EMPTY);
  const [actionState, setActionState] = useState<TimeLeaveActionState>(EMPTY);
  const [isPending, formAction] = useActionState(changeTimeTypeAction, actionState, `/people/time-leave`);

  if (!type) return null;

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Change time type {type.code}</h2>
      <Notice state={state} />
      {!canWrite && (
        <p className="text-ink-soft text-sm">
          This session does not hold {`PEOPLE.TIME.ENTER`}. The form is read.
        </p>
      )}
      <form action={formAction} className="grid grid-cols-1 sm:grid-cols-4 gap-3" disabled={!canWrite}>
        <input name="typeCode" defaultValue={type.code} hidden />
        <div className="col-span-1 sm:col-span-2">
          <label className="block text-xs text-ink-soft mb-1">Name</label>
          <input name="name" defaultValue={type.name} className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-2">
          <label className="block text-xs text-ink-soft mb-1">Description</label>
          <input name="description" defaultValue={type.description ?? ''} className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Valid</label>
          <select name="isValid" className="w-full border rounded px-2 py-1 text-sm">
            <option value="yes">yes</option>
            <option value="no">no</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">&nbsp;</label>
          <button
            type="submit"
            disabled={isPending || !canWrite}
            className="w-full btn btn-primary"
          >
            {isPending ? 'Changing…' : 'Change type'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ───────── Absence request ───────── */
function AbsenceRequestForm({ canWrite }: { canWrite: boolean }) {
  const [state, setState] = useState<TimeLeaveActionState>(EMPTY);
  const [actionState, setActionState] = useState<TimeLeaveActionState>(EMPTY);
  const [isPending, formAction] = useActionState(requestAbsenceAction, actionState, `/people/time-leave`);

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Request an absence</h2>
      <Notice state={state} />
      {!canWrite && (
        <p className="text-ink-soft text-sm">
          This session does not hold {`PEOPLE.TIME.ENTER`}. The form is read.
        </p>
      )}
      <form action={formAction} className="grid grid-cols-1 sm:grid-cols-4 gap-3" disabled={!canWrite}>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Personnel number</label>
          <input name="personnelNumber" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Time type</label>
          <select name="timeTypeCode" required className="w-full border rounded px-2 py-1 text-sm">
            <option value="">—</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">From</label>
          <input name="validFrom" type="date" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">To</label>
          <input name="validTo" type="date" className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-2">
          <label className="block text-xs text-ink-soft mb-1">Reason</label>
          <input name="reason" className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">&nbsp;</label>
          <button
            type="submit"
            disabled={isPending || !canWrite}
            className="w-full btn btn-primary"
          >
            {isPending ? 'Requesting…' : 'Request absence'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ───────── Absence decision ───────── */
function AbsenceDecisionForm({ absence, canWrite }: { absence: AbsenceView | undefined; canWrite: boolean }) {
  const [state, setState] = useState<TimeLeaveActionState>(EMPTY);
  const [actionState, setActionState] = useState<TimeLeaveActionState>(EMPTY);
  const [isPending, formAction] = useActionState(decideAbsenceAction, actionState, `/people/time-leave`);

  if (!absence || absence.status !== 'REQUESTED') return null;

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Decide absence for {absence.personnelNumber}</h2>
      <p className="text-sm text-ink-soft mb-3">
        {absence.timeTypeCode} from {absence.validFrom}{absence.validTo ? ` to ${absence.validTo}` : ''}{' — '}
        {absence.reason ?? 'no reason given'}
      </p>
      <Notice state={state} />
      {!canWrite && (
        <p className="text-ink-soft text-sm">
          This session does not hold {`PEOPLE.TIME.ENTER`}. The form is read.
        </p>
      )}
      <form action={formAction} className="grid grid-cols-1 sm:grid-cols-4 gap-3" disabled={!canWrite}>
        <input name="personnelNumber" defaultValue={absence.personnelNumber} hidden />
        <input name="timeTypeCode" defaultValue={absence.timeTypeCode} hidden />
        <input name="validFrom" defaultValue={absence.validFrom} hidden />
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Decision</label>
          <select name="status" required className="w-full border rounded px-2 py-1 text-sm">
            <option value="APPROVED">Approve</option>
            <option value="REJECTED">Reject</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">&nbsp;</label>
          <button
            type="submit"
            disabled={isPending || !canWrite}
            className="w-full btn btn-primary"
          >
            {isPending ? 'Deciding…' : 'Decide'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ───────── Time recording ───────── */
function TimeRecordingForm({ canWrite }: { canWrite: boolean }) {
  const [state, setState] = useState<TimeLeaveActionState>(EMPTY);
  const [actionState, setActionState] = useState<TimeLeaveActionState>(EMPTY);
  const [isPending, formAction] = useActionState(recordTimeAction, actionState, `/people/time-leave`);

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Record time</h2>
      <Notice state={state} />
      {!canWrite && (
        <p className="text-ink-soft text-sm">
          This session does not hold {`PEOPLE.TIME.ENTER`}. The form is read.
        </p>
      )}
      <form action={formAction} className="grid grid-cols-1 sm:grid-cols-4 gap-3" disabled={!canWrite}>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Personnel number</label>
          <input name="personnelNumber" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Time type</label>
          <select name="timeTypeCode" required className="w-full border rounded px-2 py-1 text-sm">
            <option value="">—</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Date</label>
          <input name="recordingDate" type="date" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Hours</label>
          <input name="hours" type="number" step="0.01" min="0" max="24" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">&nbsp;</label>
          <button
            type="submit"
            disabled={isPending || !canWrite}
            className="w-full btn btn-primary"
          >
            {isPending ? 'Recording…' : 'Record time'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ───────── Leave quota ───────── */
function LeaveQuotaForm({ canWrite }: { canWrite: boolean }) {
  const [state, setState] = useState<TimeLeaveActionState>(EMPTY);
  const [actionState, setActionState] = useState<TimeLeaveActionState>(EMPTY);
  const [isPending, formAction] = useActionState(setLeaveQuotaAction, actionState, `/people/time-leave`);

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Set a leave quota</h2>
      <p className="text-sm text-ink-soft mb-3">
        Entitlement for one employee, one absence type that reduces quota, one
        calendar year. Approved absences reduce the remaining balance.
      </p>
      <Notice state={state} />
      {!canWrite && (
        <p className="text-ink-soft text-sm">
          This session does not hold {`PEOPLE.TIME.ENTER`}. The form is read.
        </p>
      )}
      <form action={formAction} className="grid grid-cols-1 sm:grid-cols-4 gap-3" disabled={!canWrite}>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Personnel number</label>
          <input name="personnelNumber" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Time type</label>
          <select name="timeTypeCode" required className="w-full border rounded px-2 py-1 text-sm">
            <option value="">—</option>
          </select>
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Year</label>
          <input name="year" type="number" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">Entitlement (days)</label>
          <input name="entitlement" type="number" step="0.01" min="0" required className="w-full border rounded px-2 py-1 text-sm" />
        </div>
        <div className="col-span-1 sm:col-span-1">
          <label className="block text-xs text-ink-soft mb-1">&nbsp;</label>
          <button
            type="submit"
            disabled={isPending || !canWrite}
            className="w-full btn btn-primary"
          >
            {isPending ? 'Setting…' : 'Set quota'}
          </button>
        </div>
      </form>
    </section>
  );
}

/** ───────── Time type list ───────── */
function TimeTypeList({ timeTypes }: { timeTypes: TimeTypeView[] }) {
  if (timeTypes.length === 0) {
    return (
      <section className="mt-4 border panel p-3">
        <h2 className="text-sm font-semibold mb-2">Time types</h2>
        <p className="text-ink-soft text-sm">No time types defined yet. Define one above.</p>
      </section>
    );
  }

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Time types</h2>
      <table className="w-full text-left text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="pb-2 text-ink-soft">Code</th>
            <th className="pb-2 text-ink-soft">Name</th>
            <th className="pb-2 text-ink-soft">Kind</th>
            <th className="pb-2 text-ink-soft">Reduces quota</th>
            <th className="pb-2 text-ink-soft">Valid</th>
          </tr>
        </thead>
        <tbody>
          {timeTypes.map((t) => (
            <tr key={t.code} className="border-b hover:bg-tint">
              <td className="py-2 font-mono">{t.code}</td>
              <td className="py-2">{t.name}</td>
              <td className="py-2">{textLabel(t.typeKind)}</td>
              <td className="py-2">{t.reducesQuota ? 'yes' : 'no'}</td>
              <td className="py-2">{t.isValid ? 'yes' : 'retired'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

/** ───────── Absence list ───────── */
function AbsenceList({ absences }: { absences: AbsenceView[] }) {
  if (absences.length === 0) {
    return (
      <section className="mt-4 border panel p-3">
        <h2 className="text-sm font-semibold mb-2">Absences</h2>
        <p className="text-ink-soft text-sm">No absences found.</p>
      </section>
    );
  }

  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">Absences</h2>
      <table className="w-full text-left text-sm border-collapse">
        <thead>
          <tr className="border-b">
            <th className="pb-2 text-ink-soft">Personnel</th>
            <th className="pb-2 text-ink-soft">Type</th>
            <th className="pb-2 text-ink-soft">From</th>
            <th className="pb-2 text-ink-soft">To</th>
            <th className="pb-2 text-ink-soft">Status</th>
            <th className="pb-2 text-ink-soft">Reason</th>
          </tr>
        </thead>
        <tbody>
          {absences.map((a) => (
            <tr key={`${a.personnelNumber}/${a.timeTypeCode}/${a.validFrom}`} className="border-b hover:bg-tint">
              <td className="py-2 font-mono">{a.personnelNumber}</td>
              <td className="py-2">{a.timeTypeCode}</td>
              <td className="py-2">{a.validFrom}</td>
              <td className="py-2">{a.validTo ?? 'open'}</td>
              <td className="py-2">{a.status}</td>
              <td className="py-2 text-ink-soft">{a.reason ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function TimeLeave({
  timeTypes,
  selectedType,
  absences,
  selectedAbsence,
  employee,
  query,
  canWrite,
  canView,
}: Props) {
  return (
    <div className="space-y-4">
      <TimeTypeForm canWrite={canWrite} />
      {selectedType && <TimeTypeChange type={selectedType} canWrite={canWrite} />}
      <AbsenceRequestForm canWrite={canWrite} />
      <AbsenceDecisionForm absence={selectedAbsence} canWrite={canWrite} />
      <TimeRecordingForm canWrite={canWrite} />
      <LeaveQuotaForm canWrite={canWrite} />
      <TimeTypeList timeTypes={timeTypes} />
      <AbsenceList absences={absences} />
    </div>
  );
}
