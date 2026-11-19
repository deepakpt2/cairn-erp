'use client';

import { useActionState, type ReactNode } from 'react';

import type { LeaveActionState } from '@/app/people/leave-live';
import type { AssignmentView, GroupView, PolicyView } from '@/modules/people/leave-policy';
import type { TimeTypeView } from '@/modules/people/time-leave';
import {
  addMemberAction, addPolicyVersionAction, assignPolicyAction, changeTimeTypeAction, defineGroupAction, definePolicyAction,
  defineTimeTypeAction, endAssignmentAction, endMemberAction, retirePolicyAction,
} from './actions';

const EMPTY: LeaveActionState = { ok: false };
const INPUT = 'w-full border rounded px-2 py-1 text-sm';
const LINES_HELP = 'One line per time type: type, annual days, MONTHLY or ANNUAL_UPFRONT, optional fallback type. Example: ANNUAL 24 MONTHLY UNPAID';

function Notice({ state }: { state: LeaveActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-2 p-3 text-sm' : 'panel panel-danger mt-2 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
    </div>
  );
}

function L({ label, children, span = 1 }: { label: string; children: ReactNode; span?: number }) {
  return (
    <label className={`block ${span === 2 ? 'sm:col-span-2' : span === 4 ? 'sm:col-span-4' : ''}`}>
      <span className="block text-xs text-ink-soft mb-1">{label}</span>{children}
    </label>
  );
}

/** One action form. The inputs are uncontrolled and re-read from the server after a success; a refusal keeps the page as it is. */
function Form({ title, action, enabled, submit, hint, children }: {
  title: string; action: (p: LeaveActionState, f: FormData) => Promise<LeaveActionState>; enabled: boolean; submit: string; hint?: string; children: ReactNode;
}) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <section className="mt-4 border panel p-3">
      <h2 className="text-sm font-semibold mb-2">{title}</h2>
      {hint ? <p className="text-sm text-ink-soft mb-2">{hint}</p> : null}
      <Notice state={state} />
      <form action={run}>
        <fieldset disabled={!enabled || pending} className="grid grid-cols-1 sm:grid-cols-4 gap-3 mt-2">
          {children}
          <div className="sm:col-span-1 flex items-end"><button type="submit" className="w-full btn btn-primary">{pending ? 'Working…' : submit}</button></div>
        </fieldset>
      </form>
      {!enabled ? <p className="text-sm text-ink-soft mt-2">This session lacks the authority for this form.</p> : null}
    </section>
  );
}

function Inline({ action, fields, label, enabled }: {
  action: (p: LeaveActionState, f: FormData) => Promise<LeaveActionState>; fields: Record<string, string>; label: string; enabled: boolean;
}) {
  const [state, run, pending] = useActionState(action, EMPTY);
  return (
    <form action={run} className="inline-flex items-center gap-1">
      {Object.entries(fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}
      <button type="submit" disabled={!enabled || pending} className="btn text-xs">{label}</button>
      {state.message && !state.ok ? <span className="text-xs text-signal-danger">{state.message}</span> : null}
    </form>
  );
}

export default function TimeTypes({ timeTypes, policies, groups, assignments, notes, today, canConfigure, canAssign }: {
  timeTypes: TimeTypeView[]; policies: PolicyView[]; groups: GroupView[]; assignments: AssignmentView[];
  notes: string[]; today: string; canConfigure: boolean; canAssign: boolean;
}) {
  return (
    <div className="space-y-4">
      {notes.map((n) => <p key={n} className="panel p-3 text-sm text-ink-soft">{n}</p>)}

      <Form title="Define a time type" action={defineTimeTypeAction} enabled={canConfigure} submit="Define">
        <L label="Code"><input name="code" required className={INPUT} placeholder="e.g. ANNUAL" /></L>
        <L label="Name" span={2}><input name="name" required className={INPUT} /></L>
        <L label="Kind"><select name="typeKind" className={INPUT}><option value="ABSENCE">absence</option><option value="ATTENDANCE">attendance</option><option value="OVERTIME">overtime</option></select></L>
        <L label="Reduces a balance"><select name="reducesQuota" className={INPUT}><option value="yes">yes</option><option value="no">no</option></select></L>
        <L label="Paid"><select name="isPaid" className={INPUT}><option value="yes">yes</option><option value="no">no (unpaid)</option></select></L>
        <L label="Description" span={2}><input name="description" className={INPUT} /></L>
      </Form>

      <section className="border panel p-3">
        <h2 className="text-sm font-semibold mb-2">Time types</h2>
        <table className="grid-table text-left text-sm border-collapse w-full">
          <thead><tr><th>Code</th><th>Name</th><th>Kind</th><th>Balance</th><th>Paid</th><th>Valid</th><th /></tr></thead>
          <tbody>
            {timeTypes.map((t) => (
              <tr key={t.code} className="hover:bg-tint">
                <td className="font-mono">{t.code}</td><td>{t.name}</td><td>{t.typeKind.toLowerCase()}</td>
                <td>{t.reducesQuota ? 'yes' : 'no'}</td><td>{t.isPaid ? 'yes' : 'unpaid'}</td><td>{t.isValid ? 'yes' : 'retired'}</td>
                <td>
                  <Inline action={changeTimeTypeAction} enabled={canConfigure} label={t.isValid ? 'Retire' : 'Reinstate'}
                    fields={{ typeCode: t.code, name: t.name, description: t.description ?? '', isValid: t.isValid ? 'no' : 'yes', isPaid: t.isPaid ? 'yes' : 'no' }} />
                </td>
              </tr>
            ))}
            {timeTypes.length === 0 ? <tr><td colSpan={7} className="text-ink-soft">No time types yet.</td></tr> : null}
          </tbody>
        </table>
      </section>

      <Form title="Define a leave policy" action={definePolicyAction} enabled={canConfigure} submit="Define policy"
        hint="A policy is versioned. Version 1 starts on the first of a month. Annual allowance is a target: monthly lines credit one month at a time at month end, in the tenant time zone, with cumulative rounding.">
        <L label="Code"><input name="code" required className={INPUT} placeholder="e.g. STD" /></L>
        <L label="Name" span={2}><input name="name" required className={INPUT} /></L>
        <L label="Valid from (first of month)"><input name="validFrom" type="date" required className={INPUT} /></L>
        <L label="Partial month (joiner or leaver)">
          <select name="partialMonthMode" required className={INPUT} defaultValue="">
            <option value="" disabled>Choose…</option><option value="PRORATE_DAYS">Prorate by days</option><option value="FULL_IF_ANY">Full month if any day</option>
          </select>
        </L>
        <L label="Description" span={2}><input name="description" className={INPUT} /></L>
        <L label="Lines" span={4}><textarea name="lines" required rows={3} className={INPUT} placeholder={LINES_HELP} /></L>
      </Form>

      <Form title="Add a policy version" action={addPolicyVersionAction} enabled={canConfigure} submit="Add version"
        hint="A new version applies from its start month; earlier postings keep the version they were made under.">
        <L label="Policy"><select name="policyCode" required className={INPUT}>{policies.map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}</select></L>
        <L label="Valid from (first of month)"><input name="validFrom" type="date" required className={INPUT} /></L>
        <L label="Partial month" span={2}>
          <select name="partialMonthMode" required className={INPUT} defaultValue="">
            <option value="" disabled>Choose…</option><option value="PRORATE_DAYS">Prorate by days</option><option value="FULL_IF_ANY">Full month if any day</option>
          </select>
        </L>
        <L label="Lines" span={4}><textarea name="lines" required rows={3} className={INPUT} placeholder={LINES_HELP} /></L>
      </Form>

      <section className="border panel p-3">
        <h2 className="text-sm font-semibold mb-2">Policies</h2>
        {policies.map((p) => (
          <div key={p.code} className="mb-3">
            <p className="text-sm"><span className="font-mono">{p.code}</span> — {p.name} {p.isValid ? '' : '(retired)'}{' '}
              <Inline action={retirePolicyAction} enabled={canConfigure} label={p.isValid ? 'Retire' : 'Reinstate'} fields={{ code: p.code, isValid: p.isValid ? 'no' : 'yes' }} /></p>
            <table className="grid-table text-left text-sm border-collapse w-full mt-1">
              <thead><tr><th>Version</th><th>From</th><th>Partial month</th><th>Lines</th></tr></thead>
              <tbody>
                {p.versions.map((v) => (
                  <tr key={v.version}><td>{v.version}</td><td>{v.validFrom}</td><td>{v.partialMonthMode}</td>
                    <td>{v.lines.map((l) => `${l.timeTypeCode} ${l.annualDays}/yr ${l.accrualMode === 'MONTHLY' ? 'monthly' : 'upfront'}${l.fallbackTypeCode ? ` → ${l.fallbackTypeCode}` : ''}`).join('; ')}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
        {policies.length === 0 ? <p className="text-sm text-ink-soft">No policies yet.</p> : null}
      </section>

      <Form title="Define a leave group" action={defineGroupAction} enabled={canAssign} submit="Define group">
        <L label="Code"><input name="code" required className={INPUT} /></L>
        <L label="Name" span={2}><input name="name" required className={INPUT} /></L>
        <L label="Description" span={2}><input name="description" className={INPUT} /></L>
      </Form>

      <Form title="Add a group member" action={addMemberAction} enabled={canAssign} submit="Add member"
        hint="The employee must be in your Company Code scope for the dates. One person can be in one group on a date.">
        <L label="Group"><select name="groupCode" required className={INPUT}>{groups.map((g) => <option key={g.code} value={g.code}>{g.code}</option>)}</select></L>
        <L label="Personnel number"><input name="personnelNumber" required className={INPUT} /></L>
        <L label="From"><input name="validFrom" type="date" required defaultValue={today} className={INPUT} /></L>
        <L label="To (optional)"><input name="validTo" type="date" className={INPUT} /></L>
      </Form>

      <section className="border panel p-3">
        <h2 className="text-sm font-semibold mb-2">Groups</h2>
        {groups.map((g) => (
          <div key={g.code} className="mb-3">
            <p className="text-sm"><span className="font-mono">{g.code}</span> — {g.name}{g.hiddenMembers > 0 ? ` · ${g.hiddenMembers} member(s) outside your scope not shown` : ''}</p>
            <ul className="text-sm ml-4 list-disc">
              {g.members.map((m) => (
                <li key={m.id}>{m.personnelNumber} {m.employeeName} · {m.validFrom} → {m.validTo ?? 'open'}{' '}
                  {m.validTo === null ? <Inline action={endMemberAction} enabled={canAssign} label="End today" fields={{ id: m.id, validTo: today }} /> : null}</li>
              ))}
            </ul>
          </div>
        ))}
        {groups.length === 0 ? <p className="text-sm text-ink-soft">No groups yet.</p> : null}
      </section>

      <Form title="Assign a policy" action={assignPolicyAction} enabled={canAssign} submit="Assign"
        hint="To a group or to one person. A person's assignment overrides the group's on overlapping dates, and nothing is credited twice. Two assignments for the same subject may not overlap.">
        <L label="Applies to"><select name="subjectKind" className={INPUT}><option value="GROUP">Group</option><option value="PERSON">Person</option></select></L>
        <L label="Group code or personnel number"><input name="subject" required className={INPUT} /></L>
        <L label="Policy"><select name="policyCode" required className={INPUT}>{policies.filter((p) => p.isValid).map((p) => <option key={p.code} value={p.code}>{p.code}</option>)}</select></L>
        <L label="From"><input name="validFrom" type="date" required className={INPUT} /></L>
        <L label="To (optional)"><input name="validTo" type="date" className={INPUT} /></L>
      </Form>

      <section className="border panel p-3">
        <h2 className="text-sm font-semibold mb-2">Assignments</h2>
        <table className="grid-table text-left text-sm border-collapse w-full">
          <thead><tr><th>Applies to</th><th>Policy</th><th>From</th><th>To</th><th /></tr></thead>
          <tbody>
            {assignments.map((a) => (
              <tr key={a.id}>
                <td>{a.subjectKind === 'GROUP' ? `Group ${a.groupCode}` : `${a.personnelNumber} ${a.employeeName ?? ''}`}</td>
                <td className="font-mono">{a.policyCode}</td><td>{a.validFrom}</td><td>{a.validTo ?? 'open'}</td>
                <td>{a.validTo === null ? <Inline action={endAssignmentAction} enabled={canAssign} label="End today" fields={{ id: a.id, validTo: today }} /> : null}</td>
              </tr>
            ))}
            {assignments.length === 0 ? <tr><td colSpan={5} className="text-ink-soft">No assignments yet.</td></tr> : null}
          </tbody>
        </table>
      </section>
    </div>
  );
}
