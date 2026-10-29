'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import type { AssignmentView } from '@/modules/people/assignment';
import type { PositionView } from '@/modules/people/org-structure';
import {
  assignAction,
  changeAssignmentAction,
  delimitAction,
  type AssignmentActionState,
} from './actions';

const EMPTY: AssignmentActionState = { ok: false };

interface Props {
  assignments: AssignmentView[];
  history: AssignmentView[];
  open: AssignmentView | null;
  positions: PositionView[];
  employee: string;
  query: string;
  positionCode: string;
  openOnly: boolean;
  note?: string;
  remedy?: string;
  /** A success sentence the panel that earned it can no longer carry — see ./copy. */
  confirmed?: string;
  canWrite: boolean;
}

function Notice({ state }: { state: AssignmentActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && state.personnelNumber ? (
        <p className="mt-2">
          <Link className="link" href={`/people/assignments?employee=${state.personnelNumber}`}>
            Open {state.personnelNumber}&apos;s assignments
          </Link>
        </p>
      ) : null}
    </div>
  );
}

function Field({ label, name, defaultValue, hint, maxLength = 60, required, type = 'text' }: {
  label: string;
  name: string;
  defaultValue?: string;
  hint?: string;
  maxLength?: number;
  required?: boolean;
  type?: 'text' | 'date';
}) {
  return (
    <label className="block text-xs text-ink-soft">
      {label}
      <input
        className="input mt-1"
        name={name}
        type={type}
        defaultValue={defaultValue ?? ''}
        autoComplete="off"
        maxLength={maxLength}
        required={required}
      />
      {hint ? <span className="mt-1 block text-ink-faint">{hint}</span> : null}
    </label>
  );
}

function Denied() {
  return (
    <p className="mt-2 text-xs text-ink-soft">
      This session does not hold <span className="code">PEOPLE.ASSIGNMENT.MAINTAIN</span>, so assignments read
      but cannot be written. The capability is registered; who is granted it is a People role decision this
      slice leaves open, and an administrator reaches the screen on the standard role pattern.
    </p>
  );
}

/** The one row a person has standing: the row a new assignment has to be measured against. */
function OpenAssignment({ assignment, canWrite }: { assignment: AssignmentView; canWrite: boolean }) {
  const [state, action, pending] = useActionState(delimitAction, EMPTY);
  const [correctState, correctAction, correctPending] = useActionState(changeAssignmentAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="The assignment standing today">
      <h2 className="text-sm font-semibold">Standing now</h2>
      <p className="mt-1 text-sm">
        <span className="code">{assignment.positionCode}</span>
        {assignment.positionTitle ? ` · ${assignment.positionTitle}` : ''}
        {' '}on <span className="code">{assignment.costCenter}</span>
        {assignment.costCenterName ? ` · ${assignment.costCenterName}` : ''}
        {' '}in area <span className="code">{assignment.controllingArea}</span>, since {assignment.validFrom}.
      </p>
      <p className="mt-1 text-xs text-ink-faint">
        Open — it has no last day, so it covers today and every day after it. A second assignment for the same
        person cannot be written over it: end it, then start the next one the day after.
      </p>
      {canWrite ? (
        <div className="mt-3 grid gap-4 sm:grid-cols-2">
          <form action={action} className="space-y-2 border-t border-line pt-3">
            <h3 className="text-xs font-semibold text-ink-faint">End it</h3>
            <input type="hidden" name="personnelNumber" value={assignment.personnelNumber} />
            <input type="hidden" name="validFrom" value={assignment.validFrom} />
            <Field label="Last day it applies" name="validTo" type="date" required hint="Inclusive: the assignment covers this day too." />
            <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
              {pending ? 'Writing…' : 'End assignment'}
            </button>
          </form>
          <form action={correctAction} className="space-y-2 border-t border-line pt-3">
            <h3 className="text-xs font-semibold text-ink-faint">Correct it (values only)</h3>
            <p className="text-xs text-ink-faint">
              The only in-place write this table takes, and only while the assignment is open: the dates of a
              span are never corrected, because a span that started on the wrong day is a span that should not
              have started there.
            </p>
            <input type="hidden" name="personnelNumber" value={assignment.personnelNumber} />
            <input type="hidden" name="validFrom" value={assignment.validFrom} />
            <Field label="Position" name="positionCode" hint="Blank leaves it." maxLength={10} />
            <Field label="Controlling area" name="controllingArea" maxLength={4} />
            <Field label="Cost centre" name="costCenter" hint="Blank leaves both. A cost centre given here is checked against the master as of the first day." maxLength={10} />
            <button className="btn btn-default min-h-11 sm:min-h-9" disabled={correctPending}>
              {correctPending ? 'Writing…' : 'Correct open assignment'}
            </button>
          </form>
        </div>
      ) : <Denied />}
      <Notice state={state} />
      <Notice state={correctState} />
    </section>
  );
}

function Assign({ employee, positions, canWrite }: { employee: string; positions: PositionView[]; canWrite: boolean }) {
  const [state, action, pending] = useActionState(assignAction, EMPTY);
  const valid = positions.filter((p) => p.isValid);
  return (
    <section className="panel p-4" aria-label="Start an assignment">
      <h2 className="text-sm font-semibold">Start an assignment</h2>
      <p className="mt-1 text-xs text-ink-soft">
        The position has to be defined on <Link className="link" href="/people/organization">the org
        screen</Link> and the cost centre on the cost centre master — an assignment names both, it does not
        create either. The employee comes from the personnel number you type, and their name is read, never
        copied here.
      </p>
      {canWrite ? (
        <form action={action} className="mt-3 space-y-3">
          <Field label="Personnel number" name="personnelNumber" defaultValue={employee} required maxLength={20} />
          <label className="block text-xs text-ink-soft">
            Position
            <select className="input mt-1" name="positionCode" required defaultValue={valid[0]?.code ?? ''}>
              {valid.length === 0 ? <option value="">— no valid position is defined —</option> : null}
              {valid.map((p) => (
                <option key={p.code} value={p.code}>{p.code} · {p.title}{p.orgUnitCode ? ` · ${p.orgUnitCode}` : ''}</option>
              ))}
            </select>
            <span className="mt-1 block text-ink-faint">A retired position takes no new assignment.</span>
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Controlling area" name="controllingArea" required maxLength={4} hint="Four characters, as the cost centre master keys them." />
            <Field label="Cost centre" name="costCenter" required maxLength={10} />
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First day it applies" name="validFrom" type="date" required />
            <Field
              label="Request key"
              name="requestKey"
              maxLength={64}
              hint="Optional. The same key twice writes one assignment, not two — for an import or a retry."
            />
          </div>
          <p className="text-xs text-ink-faint">
            No last day is asked for: the assignment is open until it is ended, which is also how a
            back-dated one is written — start it, then end it on the day it stopped.
          </p>
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Write assignment'}
          </button>
        </form>
      ) : <Denied />}
      <Notice state={state} />
    </section>
  );
}

export default function Assignments(props: Props) {
  const { assignments, history, open, positions, employee, query, positionCode, openOnly, note, remedy, confirmed } =
    props;
  const byCode = new Map(positions.map((p) => [p.code, p]));

  return (
    <div className="space-y-4">
      <form action="/people/assignments" className="panel flex flex-wrap items-end gap-2 p-3">
        <label className="block text-xs text-ink-soft">
          Employee or number
          <input className="input mt-1" name="q" defaultValue={query} placeholder="T9000001 or a name" maxLength={40} />
        </label>
        <label className="block text-xs text-ink-soft">
          Position
          <input className="input mt-1" name="position" defaultValue={positionCode} placeholder="e.g. ACCTMGR" maxLength={10} />
        </label>
        <label className="flex items-center gap-2 pb-2 text-xs text-ink-soft">
          <input type="checkbox" name="open" value="1" defaultChecked={openOnly} />
          standing today only
        </label>
        <button className="btn btn-default min-h-11 sm:min-h-8">Search</button>
        {employee ? (
          <Link className="btn btn-default min-h-11 sm:min-h-8" href="/people/assignments">Clear the employee</Link>
        ) : null}
      </form>

      {note ? (
        <div className="panel panel-warning p-3 text-sm" role="status">
          <p className="font-medium">{note}</p>
          {remedy ? <p className="mt-1 text-ink-soft">{remedy}</p> : null}
        </div>
      ) : null}

      {confirmed ? (
        <div className="panel panel-success p-3 text-sm" role="status">
          <p className="font-medium">{confirmed}</p>
        </div>
      ) : null}

      {employee && history.length > 0 ? (
        <section className="panel p-4" aria-label="Assignment history">
          <h2 className="text-sm font-semibold">
            <span className="code">{employee}</span> · {history[0]!.employeeName} — every assignment, newest first
          </h2>
          <p className="mt-1 text-xs text-ink-faint">
            Nothing here is overwritten. A closed row keeps exactly what it said when it was written, which is
            what a report of a past date reads.
          </p>
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="py-1">From</th><th>To</th><th>Position</th><th>Unit</th><th>Cost centre</th><th>Written by</th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.validFrom} className="border-t border-line align-top">
                  <td className="py-1 pr-2">{row.validFrom}</td>
                  <td className="py-1 pr-2">{row.validTo ?? <span className="text-ink-soft">open</span>}</td>
                  <td className="py-1 pr-2">
                    <span className="code">{row.positionCode}</span>
                    {row.positionTitle ? ` · ${row.positionTitle}` : ''}
                  </td>
                  <td className="py-1 pr-2 text-ink-soft">
                    {row.orgUnitCode
                      ? <Link className="link" href={`/people/organization?unit=${row.orgUnitCode}`}>{row.orgUnitCode}</Link>
                      : '—'}
                  </td>
                  <td className="py-1 pr-2">
                    <span className="code">{row.costCenter}</span>
                    {row.costCenterName ? <span className="text-ink-soft"> · {row.costCenterName}</span> : null}
                    <span className="text-ink-faint"> · {row.controllingArea}</span>
                  </td>
                  <td className="py-1 text-ink-faint">{row.createdBy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      {employee && open ? <OpenAssignment assignment={open} canWrite={props.canWrite} /> : null}

      <section className="panel p-4" aria-label="Assignments found">
        <h2 className="text-sm font-semibold">
          {assignments.length} assignment{assignments.length === 1 ? '' : 's'} listed
          {positionCode ? <> for <span className="code">{positionCode}</span> · {byCode.get(positionCode)?.title ?? 'position'}</> : null}
          {openOnly ? ' · standing today' : ''}
        </h2>
        {assignments.length === 0 ? (
          <p className="mt-1 text-xs text-ink-soft">Nothing matches. Start one below, or clear the search.</p>
        ) : (
          <table className="mt-2 w-full text-xs">
            <thead>
              <tr className="text-left text-ink-faint">
                <th className="py-1">Employee</th><th>Position</th><th>Cost centre</th><th className="py-1">Span</th>
              </tr>
            </thead>
            <tbody>
              {assignments.map((row) => (
                <tr key={`${row.personnelNumber}/${row.validFrom}`} className="border-t border-line align-top">
                  <td className="py-1 pr-2">
                    <Link className="link" href={`/people/assignments?employee=${row.personnelNumber}`}>
                      <span className="code">{row.personnelNumber}</span>
                    </Link>
                    <span className="text-ink-soft"> · {row.employeeName}</span>
                  </td>
                  <td className="py-1 pr-2">
                    <span className="code">{row.positionCode}</span>
                    {row.positionTitle ? <span className="text-ink-soft"> · {row.positionTitle}</span> : null}
                    {row.orgUnitCode ? <span className="text-ink-faint"> · {row.orgUnitCode}</span> : null}
                  </td>
                  <td className="py-1 pr-2"><span className="code">{row.costCenter}</span><span className="text-ink-faint"> · {row.controllingArea}</span></td>
                  <td className="py-1">
                    {row.validFrom} → {row.validTo ?? 'open'}
                    {row.isCurrent ? <span className="ml-1 text-ink-faint">standing</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Assign employee={employee} positions={positions} canWrite={props.canWrite} />
    </div>
  );
}
