'use client';

import Link from 'next/link';
import { useActionState } from 'react';

import type { JobView, OrgUnitDetail, OrgUnitView, PositionView } from '@/modules/people/org-structure';
import {
  changeJobAction,
  changeOrgUnitAction,
  changePositionAction,
  defineJobAction,
  defineOrgUnitAction,
  definePositionAction,
  type OrgActionState,
} from './actions';

const EMPTY: OrgActionState = { ok: false };
const ROOT = 'ROOT';
const NONE = 'NONE';

interface Props {
  units: OrgUnitView[];
  positions: PositionView[];
  jobs: JobView[];
  selectedUnit: OrgUnitDetail | null;
  selectedPosition: PositionView | null;
  selectedJob: JobView | null;
  query: string;
  tab: 'units' | 'positions' | 'jobs';
  canMaintainUnits: boolean;
  canMaintainPositions: boolean;
}

function Notice({ state }: { state: OrgActionState }) {
  if (!state.message) return null;
  return (
    <div className={state.ok ? 'panel panel-success mt-3 p-3 text-sm' : 'panel panel-danger mt-3 p-3 text-sm'} role="status">
      <p className="font-medium">{state.message}</p>
      {state.remedy ? <p className="mt-1 text-ink-soft">{state.remedy}</p> : null}
      {state.ok && (state.unit || state.position || state.job) ? (
        <p className="mt-2">
          <Link className="link" href={state.unit ? `/people/organization?unit=${state.unit}`
            : state.position ? `/people/organization?position=${state.position}`
              : `/people/organization?tab=jobs`}>
            Open {state.unit ?? state.position ?? state.job}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

/**
 * Tree order: roots first, each branch immediately below the unit it hangs from, using the level the service
 * counted. A search that filters out an ancestor leaves the descendant as its own root in the list — it is
 * still shown, and its real level is still the number beside it, because the level is read from the whole tree
 * and not from what the filter happened to keep.
 */
function treeOrder(units: OrgUnitView[]): OrgUnitView[] {
  const byParent = new Map<string, OrgUnitView[]>();
  for (const unit of units) {
    if (unit.parentCode === null) continue;
    const list = byParent.get(unit.parentCode) ?? [];
    list.push(unit);
    byParent.set(unit.parentCode, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.code.localeCompare(b.code));
  const roots = units.filter((u) => u.parentCode === null).sort((a, b) => a.code.localeCompare(b.code));

  const out: OrgUnitView[] = [];
  const seen = new Set<string>();
  const walk = (unit: OrgUnitView) => {
    if (seen.has(unit.code)) return;
    seen.add(unit.code);
    out.push(unit);
    for (const child of byParent.get(unit.code) ?? []) walk(child);
  };
  for (const root of roots) walk(root);
  for (const unit of units) if (!seen.has(unit.code)) { seen.add(unit.code); out.push(unit); }
  return out;
}

function Field({ label, name, defaultValue, hint, maxLength = 60 }: {
  label: string; name: string; defaultValue?: string; hint?: string; maxLength?: number;
}) {
  return (
    <label className="block text-xs text-ink-soft">
      {label}
      <input className="input mt-1" name={name} defaultValue={defaultValue ?? ''} autoComplete="off" maxLength={maxLength} />
      {hint ? <span className="mt-1 block text-ink-faint">{hint}</span> : null}
    </label>
  );
}

function CodeSelect({ label, name, options, defaultValue, noneLabel }: {
  label: string;
  name: string;
  options: Array<{ code: string; label: string }>;
  defaultValue?: string;
  /** The extra choice this form offers: `ROOT` for a unit's parent, `NONE` for a line or a job. */
  noneLabel?: string;
}) {
  return (
    <label className="block text-xs text-ink-soft">
      {label}
      <select className="input mt-1" name={name} defaultValue={defaultValue ?? ''}>
        <option value="">{noneLabel ? `— ${noneLabel} —` : '— unchanged —'}</option>
        {noneLabel ? <option value={name === 'parentCode' ? ROOT : NONE}>{noneLabel}</option> : null}
        {options.map((option) => (
          <option key={option.code} value={option.code}>
            {option.code} · {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Validity({ defaultValue }: { defaultValue: boolean }) {
  return (
    <label className="block text-xs text-ink-soft">
      Validity
      <select className="input mt-1" name="isValid" defaultValue="">
        <option value="">— unchanged —</option>
        <option value="yes">Valid — new objects may be filed under it</option>
        <option value="no">Retired — nothing new, but what stands keeps standing</option>
      </select>
      <span className="mt-1 block text-ink-faint">
        Currently {defaultValue ? 'valid' : 'retired'}. A definition is never deleted, only retired.
      </span>
    </label>
  );
}

function DefineUnit({ allowed, units }: { allowed: boolean; units: OrgUnitView[] }) {
  const [state, action, pending] = useActionState(defineOrgUnitAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="Define an organisational unit">
      <h2 className="text-sm font-semibold">Define a unit</h2>
      <p className="mt-1 text-xs text-ink-soft">
        A unit is a name and a place in the tree. It carries no company code and no cost centre: nothing in
        this design assigns one, and a default that nobody asked for would be a rule about where money goes.
      </p>
      {allowed ? (
        <form action={action} className="mt-3 space-y-3">
          <Field label="Code" name="code" hint="One to ten characters, starting with a letter. It cannot be reused once defined." />
          <Field label="Name" name="name" />
          <Field label="Description" name="description" maxLength={200} />
          <CodeSelect
            label="Under"
            name="parentCode"
            options={units.map((u) => ({ code: u.code, label: u.name }))}
          />
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Define unit'}
          </button>
        </form>
      ) : <Denied capability="PEOPLE.ORGUNIT.CREATE" />}
      <Notice state={state} />
    </section>
  );
}

function ChangeUnit({ allowed, unit, units }: { allowed: boolean; unit: OrgUnitDetail; units: OrgUnitView[] }) {
  const [state, action, pending] = useActionState(changeOrgUnitAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="Change this unit">
      <h2 className="text-sm font-semibold">Change {unit.code}</h2>
      <p className="mt-1 text-xs text-ink-soft">
        Moving the unit rewrites its one parent edge: the whole branch below it comes along, and the structure
        refuses a parent that would put the unit above itself or below its tenth level.
      </p>
      {allowed ? (
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="unitCode" value={unit.code} />
          <Field label="Name" name="name" defaultValue={unit.name} />
          <Field label="Description" name="description" defaultValue={unit.description ?? ''} maxLength={200} />
          <CodeSelect
            label="Under"
            name="parentCode"
            options={units.filter((u) => u.code !== unit.code).map((u) => ({ code: u.code, label: u.name }))}
            noneLabel="Top of the tree (no parent)"
          />
          <Validity defaultValue={unit.isValid} />
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Change unit'}
          </button>
        </form>
      ) : <Denied capability="PEOPLE.ORGUNIT.CREATE" />}
      <Notice state={state} />
    </section>
  );
}

function DefineJob({ allowed }: { allowed: boolean }) {
  const [state, action, pending] = useActionState(defineJobAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="Define a job">
      <h2 className="text-sm font-semibold">Define a job</h2>
      <p className="mt-1 text-xs text-ink-soft">
        A job says what is done; a position says where. Several positions carry one job, and the job is not
        what decides who is paid how — pay components are a different block and are not built (§15.3).
      </p>
      {allowed ? (
        <form action={action} className="mt-3 space-y-3">
          <Field label="Code" name="code" hint="This screen writes jobs under the position authority: §10.8 gives jobs no code of their own." />
          <Field label="Name" name="name" />
          <Field label="Description" name="description" maxLength={200} />
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Define job'}
          </button>
        </form>
      ) : <Denied capability="PEOPLE.POSITION.CREATE" />}
      <Notice state={state} />
    </section>
  );
}

function ChangeJob({ allowed, job }: { allowed: boolean; job: JobView }) {
  const [state, action, pending] = useActionState(changeJobAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="Change this job">
      <h2 className="text-sm font-semibold">Change {job.code}</h2>
      {allowed ? (
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="jobCode" value={job.code} />
          <Field label="Name" name="name" defaultValue={job.name} />
          <Field label="Description" name="description" defaultValue={job.description ?? ''} maxLength={200} />
          <Validity defaultValue={job.isValid} />
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Change job'}
          </button>
        </form>
      ) : <Denied capability="PEOPLE.POSITION.CREATE" />}
      <Notice state={state} />
    </section>
  );
}

function DefinePosition({ allowed, units, jobs, positions }: {
  allowed: boolean; units: OrgUnitView[]; jobs: JobView[]; positions: PositionView[];
}) {
  const [state, action, pending] = useActionState(definePositionAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="Define a position">
      <h2 className="text-sm font-semibold">Define a position</h2>
      <p className="mt-1 text-xs text-ink-soft">
        A position is created inside the unit that holds it — the unit has to exist first, which is the order
        §6.1 gives every master in this system. Whether it is filled is not asked here: it is answered by
        whoever has an assignment standing today.
      </p>
      {allowed ? (
        <form action={action} className="mt-3 space-y-3">
          <Field label="Code" name="code" />
          <Field label="Title" name="title" />
          <label className="block text-xs text-ink-soft">
            Unit
            <select className="input mt-1" name="orgUnitCode" required>
              {units.map((u) => (
                <option key={u.code} value={u.code}>{u.code} · {u.name}</option>
              ))}
            </select>
            <span className="mt-1 block text-ink-faint">A position always stands in a unit.</span>
          </label>
          <CodeSelect label="Job" name="jobCode" options={jobs.filter((j) => j.isValid).map((j) => ({ code: j.code, label: j.name }))} />
          <CodeSelect
            label="Reports to"
            name="superiorCode"
            options={positions.map((p) => ({ code: p.code, label: p.title }))}
          />
          <Field label="Description" name="description" maxLength={200} />
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Define position'}
          </button>
        </form>
      ) : <Denied capability="PEOPLE.POSITION.CREATE" />}
      <Notice state={state} />
    </section>
  );
}

function ChangePosition({ allowed, position, units, jobs, positions }: {
  allowed: boolean; position: PositionView; units: OrgUnitView[]; jobs: JobView[]; positions: PositionView[];
}) {
  const [state, action, pending] = useActionState(changePositionAction, EMPTY);
  return (
    <section className="panel p-4" aria-label="Change this position">
      <h2 className="text-sm font-semibold">Change {position.code}</h2>
      <p className="mt-1 text-xs text-ink-soft">
        Changing the unit moves the position; changing the line is how a reporting relationship is rewritten —
        both are structure, so they are written as they become true rather than dated. Assignments keep their
        own history on <Link className="link" href="/people/assignments">the assignment screen</Link>.
      </p>
      {allowed ? (
        <form action={action} className="mt-3 space-y-3">
          <input type="hidden" name="positionCode" value={position.code} />
          <Field label="Title" name="title" defaultValue={position.title} />
          <CodeSelect
            label="Move to unit"
            name="orgUnitCode"
            options={units.map((u) => ({ code: u.code, label: u.name }))}
          />
          <CodeSelect
            label="Job"
            name="jobCode"
            options={jobs.filter((j) => j.isValid).map((j) => ({ code: j.code, label: j.name }))}
            defaultValue={position.jobCode ?? ''}
            noneLabel="No job"
          />
          <CodeSelect
            label="Reports to"
            name="superiorCode"
            options={positions.filter((p) => p.code !== position.code).map((p) => ({ code: p.code, label: p.title }))}
            defaultValue={position.superiorCode ?? ''}
            noneLabel="Remove the reporting line"
          />
          <Field label="Description" name="description" defaultValue={position.description ?? ''} maxLength={200} />
          <Validity defaultValue={position.isValid} />
          <button className="btn btn-primary min-h-11 sm:min-h-9" disabled={pending}>
            {pending ? 'Writing…' : 'Change position'}
          </button>
        </form>
      ) : <Denied capability="PEOPLE.POSITION.CREATE" />}
      <Notice state={state} />
    </section>
  );
}

function Denied({ capability }: { capability: string }) {
  return (
    <p className="mt-2 text-xs text-ink-soft">
      This session does not hold <span className="code">{capability}</span>, so the structure reads but cannot
      be written. The capability is registered; who is granted it is a People role decision this slice leaves
      open, and an administrator reaches the screen on the standard role pattern.
    </p>
  );
}

export default function Organization(props: Props) {
  const { units, positions, jobs, selectedUnit, selectedPosition, selectedJob, query, tab } = props;
  const ordered = treeOrder(units);
  const tabLink = (name: string) => `/people/organization?tab=${name}${query ? `&q=${encodeURIComponent(query)}` : ''}`;

  return (
    <div className="space-y-4">
      <nav className="flex flex-wrap items-center gap-2" aria-label="Part of the structure">
        {(['units', 'positions', 'jobs'] as const).map((name) => (
          <Link
            key={name}
            href={tabLink(name)}
            className={tab === name ? 'btn btn-primary min-h-11 sm:min-h-8' : 'btn btn-default min-h-11 sm:min-h-8'}
          >
            {name === 'units' ? `Units (${units.length})` : name === 'positions' ? `Positions (${positions.length})` : `Jobs (${jobs.length})`}
          </Link>
        ))}
        <form action="/people/organization" className="ml-auto flex items-center gap-2">
          <input type="hidden" name="tab" value={tab} />
          <input className="input" name="q" defaultValue={query} placeholder="code or name" aria-label="Search" maxLength={40} />
          <button className="btn btn-default min-h-11 sm:min-h-8">Search</button>
        </form>
      </nav>

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {tab === 'units' ? (
            <section className="panel p-4" aria-label="Organisational units">
              <h2 className="text-sm font-semibold">Units</h2>
              <p className="mt-1 text-xs text-ink-faint">In tree order, with the level the structure counts. Positions and assignments shown are those standing today.</p>
              {ordered.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">No unit stands{query ? ` matching ${query}` : ''}. Define one and the tree starts here.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {ordered.map((unit) => (
                    <li key={unit.code} className="py-1" style={{ paddingLeft: `${(unit.level - 1) * 14}px` }}>
                      <div className="flex items-baseline justify-between gap-2">
                        <Link className="link" href={`/people/organization?unit=${unit.code}`}>
                          <span className="code">{unit.code}</span> · {unit.name}
                          {!unit.isValid ? <span className="ml-1 text-xs text-ink-faint">retired</span> : null}
                        </Link>
                        <span className="text-xs text-ink-faint">
                          L{unit.level} · {unit.positions} pos · {unit.positionsFilled} filled
                          {unit.childUnits > 0 ? ` · ${unit.childUnits} below` : ''}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {tab === 'positions' ? (
            <section className="panel p-4" aria-label="Positions">
              <h2 className="text-sm font-semibold">Positions</h2>
              {positions.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">No position stands{query ? ` matching ${query}` : ''}.</p>
              ) : (
                <table className="mt-2 w-full text-xs">
                  <thead><tr className="text-left text-ink-faint"><th className="py-1">Code</th><th>Title</th><th>Unit</th><th>Reports to</th><th className="text-right">Today</th></tr></thead>
                  <tbody>
                    {positions.map((row) => (
                      <tr key={row.code} className="border-t border-line">
                        <td className="py-1 pr-2"><Link className="link code" href={`/people/organization?position=${row.code}`}>{row.code}</Link></td>
                        <td className="py-1 pr-2">{row.title}{!row.isValid ? ' · retired' : ''}</td>
                        <td className="py-1 pr-2 text-ink-soft">{row.orgUnitCode ?? '—'}</td>
                        <td className="py-1 pr-2 text-ink-soft">{row.superiorCode ?? '—'}</td>
                        <td className="py-1 text-right">{row.incumbents}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
          ) : null}

          {tab === 'jobs' ? (
            <section className="panel p-4" aria-label="Jobs">
              <h2 className="text-sm font-semibold">Jobs</h2>
              {jobs.length === 0 ? (
                <p className="mt-2 text-sm text-ink-soft">No job is defined.</p>
              ) : (
                <ul className="mt-2 divide-y divide-line">
                  {jobs.map((row) => (
                    <li key={row.code} className="flex items-baseline justify-between gap-2 py-1">
                      <span>
                        <Link className="link code" href={`/people/organization?tab=jobs&job=${row.code}`}>{row.code}</Link> · {row.name}{!row.isValid ? ' · retired' : ''}
                      </span>
                      <span className="text-xs text-ink-faint">{row.positions} position{row.positions === 1 ? '' : 's'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}

          {tab === 'units' ? <DefineUnit allowed={props.canMaintainUnits} units={units} /> : null}
          {tab === 'jobs' ? <DefineJob allowed={props.canMaintainPositions} /> : null}
          {tab === 'positions' ? (
            <DefinePosition
              allowed={props.canMaintainPositions}
              units={units}
              jobs={jobs}
              positions={positions}
            />
          ) : null}
        </div>

        <div className="space-y-4">
          {selectedUnit ? (
            <>
              <section className="panel p-4" aria-label="Unit">
                <h2 className="text-lg font-semibold"><span className="code">{selectedUnit.code}</span> · {selectedUnit.name}</h2>
                <p className="mt-1 text-xs text-ink-soft">
                  {selectedUnit.parentCode ? <>Under <Link className="link" href={`/people/organization?unit=${selectedUnit.parentCode}`}>{selectedUnit.parentCode}</Link>{selectedUnit.parentName ? ` · ${selectedUnit.parentName}` : ''}</> : 'A root of the tree.'}
                  {' '}Level {selectedUnit.level}. {selectedUnit.isValid ? 'Valid.' : 'Retired — nothing new is filed under it.'}
                </p>
                {selectedUnit.description ? <p className="mt-2 text-sm">{selectedUnit.description}</p> : null}
                <h3 className="mt-3 text-xs font-semibold text-ink-faint">Units below</h3>
                {selectedUnit.children.length === 0 ? (
                  <p className="text-xs text-ink-soft">None.</p>
                ) : (
                  <ul className="mt-1 space-y-1">
                    {selectedUnit.children.map((child) => (
                      <li key={child.code} className="text-xs">
                        <Link className="link code" href={`/people/organization?unit=${child.code}`}>{child.code}</Link> · {child.name}
                        {!child.isValid ? ' · retired' : ''}
                      </li>
                    ))}
                  </ul>
                )}
                <h3 className="mt-3 text-xs font-semibold text-ink-faint">Positions in this unit</h3>
                {selectedUnit.positionList.length === 0 ? (
                  <p className="text-xs text-ink-soft">None — the unit holds no position.</p>
                ) : (
                  <table className="mt-1 w-full text-xs">
                    <tbody>
                      {selectedUnit.positionList.map((row) => (
                        <tr key={row.code} className="border-t border-line">
                          <td className="py-1 pr-2"><Link className="link code" href={`/people/organization?position=${row.code}`}>{row.code}</Link></td>
                          <td className="py-1 pr-2">{row.title}</td>
                          <td className="py-1 text-right text-ink-soft">
                            {row.incumbents === 0
                              ? <Link className="link" href={`/people/assignments?position=${row.code}`}>nobody today</Link>
                              : <Link className="link" href={`/people/assignments?position=${row.code}`}>{row.incumbents} assigned</Link>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <ChangeUnit allowed={props.canMaintainUnits} unit={selectedUnit} units={units} />
            </>
          ) : null}

          {selectedPosition ? (
            <section className="panel p-4" aria-label="Position">
              <h2 className="text-lg font-semibold"><span className="code">{selectedPosition.code}</span> · {selectedPosition.title}</h2>
              <p className="mt-1 text-xs text-ink-soft">
                {selectedPosition.orgUnitCode
                  ? <>In <Link className="link" href={`/people/organization?unit=${selectedPosition.orgUnitCode}`}>{selectedPosition.orgUnitCode}</Link>{selectedPosition.orgUnitName ? ` · ${selectedPosition.orgUnitName}` : ''}</>
                  : 'Not filed under a unit.'}
                {selectedPosition.superiorCode
                  ? <> · Reports to <Link className="link code" href={`/people/organization?position=${selectedPosition.superiorCode}`}>{selectedPosition.superiorCode}</Link>{selectedPosition.superiorTitle ? ` · ${selectedPosition.superiorTitle}` : ''}</>
                  : ' · No reporting line above it.'}
              </p>
              <p className="mt-2 text-sm">
                {selectedPosition.jobCode
                  ? <>Job <span className="code">{selectedPosition.jobCode}</span>{selectedPosition.jobName ? ` · ${selectedPosition.jobName}` : ''}.</>
                  : 'No job set.'}
                {' '}{selectedPosition.isValid ? 'Valid.' : 'Retired — no new assignment starts here.'}
                {' '}{selectedPosition.incumbents} assignment{selectedPosition.incumbents === 1 ? '' : 's'} of it
                {' '}have not ended — a span planned for a later day counts, a closed one does not —, over{' '}
                {selectedPosition.assignments} dated assignment{selectedPosition.assignments === 1 ? '' : 's'} in all.
              </p>
              <p className="mt-2">
                <Link className="link" href={`/people/assignments?position=${selectedPosition.code}`}>Assignments naming this position</Link>
              </p>
              <ChangePosition
                allowed={props.canMaintainPositions}
                position={selectedPosition}
                units={units}
                jobs={jobs}
                positions={positions}
              />
            </section>
          ) : null}

          {selectedJob ? <ChangeJob allowed={props.canMaintainPositions} job={selectedJob} /> : null}
        </div>
      </div>
    </div>
  );
}
