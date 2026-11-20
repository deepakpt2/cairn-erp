import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { EMPLOYEE_CAPABILITY, EMPLOYEE_ROUTE, EmployeeMasterError, RECORD_CAPABILITY, searchEmployees, viewEmployee } from '@/modules/people/employee-master';
import { HIRE_APPROVE_CAPABILITY } from '@/modules/people/employee-tier';
import { listPositions } from '@/modules/people/org-structure';
import { listRecordTypes } from '@/modules/people/record-types';
import {
  PAYROLL_RESULT_CAPABILITY,
  PayrollStructureError,
  SALARY_STRUCTURE_CAPABILITY,
  SALARY_STRUCTURE_ROUTE,
  defaultPayrollCurrency,
  employeeRunReadiness,
  listAssignments,
  listStructures,
} from '@/modules/people/payroll-structure';
import { randomUUID } from 'node:crypto';
import { PayrollRunError } from '@/modules/people/payroll-run';
import Employees from './Employees';
import { AssignStructureForm, EndAssignmentForm } from './PayStructure';
import { AddComponentForm, EntryActions } from './RecurringComponents';
import {
  BASIS_LABEL,
  COMPANY_RESPONSIBILITY_NOTICE,
  COMPONENT_MAINTAIN_CAPABILITY,
  listEmployeeComponents,
  listEntryComponents,
} from '@/modules/people/payroll-components';
import { LinkButton, Page } from '@/ui/kit';

export const dynamic = 'force-dynamic';

/**
 * The employee master: the person, and what is known about them as of a date.
 *
 * An employee is created as a personnel number and a name. Everything else — an address, a marital status, a
 * bank detail, whatever the tenant decided to keep — arrives as a **dated record** of a type defined on
 * `/config/people-record-types`, because DV-012 replaced fixed infotype numbering with configurable record
 * types and §8.10 fixes the shape of a record: date-delineated, and a change is a new dated record rather than
 * an overwrite. So a record is never edited into a different history here: the screen writes a new one, ends
 * the open one, and allows the answers of the newest open record to be corrected — which is the only in-place
 * write this slice takes, and it is stated as such in `drizzle/9193`.
 *
 * What this screen deliberately does not do: it calculates and posts no pay. Payroll is posting-side only and
 * waits on the result the pay components, deduction configuration and the jurisdiction decision behind them
 * would produce (D-013, R-11, DV-001 and docs/operational-readiness.md §4 item 4), so there is nothing here
 * that could be mistaken for a payslip. The organisational records that assign a position, a company code and
 * a cost centre — the data a payroll posting would charge — arrive with the org block, which is the next
 * increment and not a half-built one: assignment data is itself a record of a configured type.
 */
export default async function PeopleEmployeesPage({ searchParams }: {
  searchParams: Promise<{ employee?: string; q?: string }>;
}) {
  const session = await requireSession(EMPLOYEE_ROUTE);
  const access = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  const params = await searchParams;
  const client = session.user.client;
  const personnelNumber = (params.employee ?? '').trim().toUpperCase();
  const query = (params.q ?? '').trim();

  let scopeNote: string | null = null;
  const positions = (await listPositions(client)).filter((p) => p.isValid).map((p) => ({ code: p.code, title: p.title, tier: p.tier }));
  const [employees, types, selected] = await Promise.all([
    searchEmployees(client, query, access).catch((error) => {
      if (!(error instanceof EmployeeMasterError)) throw error;
      scopeNote = `${error.message} ${error.remedy}`;
      return [];
    }),
    listRecordTypes(client),
    personnelNumber
      ? viewEmployee(client, personnelNumber, access).catch((error) => {
          if (!(error instanceof EmployeeMasterError)) throw error;
          scopeNote ??= `${error.message} ${error.remedy}`;
          return null;
        })
      : Promise.resolve(null),
  ]);

  return (
    <Page
      title="Employees" code={<>{EMPLOYEE_CAPABILITY} · {RECORD_CAPABILITY}</>}
      description="A person is a personnel number and a name; what is true about them stands in dated records. Writing a change creates a new record and leaves the one it replaces readable, so the history a payroll result was built from can still be shown a year later. Nothing here calculates or posts pay."
      actions={
        <>
          <LinkButton href="/config/people-record-types">Record types</LinkButton>
          <LinkButton href="/config/number-ranges">Number ranges</LinkButton>
        </>
      }
    >
      {scopeNote ? <p role="status" className="panel p-3 text-sm">{scopeNote}</p> : null}
      <Employees
        employees={employees}
        positions={positions}
        canApprove={can(session, HIRE_APPROVE_CAPABILITY)}
        types={types}
        selected={selected}
        query={query}
        canCreateMaster={can(session, EMPLOYEE_CAPABILITY)}
        canMaintainRecords={can(session, RECORD_CAPABILITY)}
      />
      {selected && (
        <PayStructureSection
          client={client}
          personnelNumber={personnelNumber}
          canRead={can(session, SALARY_STRUCTURE_CAPABILITY) || can(session, PAYROLL_RESULT_CAPABILITY)}
          canAssign={can(session, SALARY_STRUCTURE_CAPABILITY)}
          access={access}
        />
      )}
      {selected && (
        <RecurringComponentsSection
          client={client}
          personnelNumber={personnelNumber}
          canRead={can(session, COMPONENT_MAINTAIN_CAPABILITY) || can(session, SALARY_STRUCTURE_CAPABILITY) || can(session, PAYROLL_RESULT_CAPABILITY)}
          canMaintain={can(session, COMPONENT_MAINTAIN_CAPABILITY)}
          access={access}
        />
      )}
    </Page>
  );
}

/**
 * Pay structure (payroll phase 1, SAP infotype 0008): the employee's structure, base amount, currency
 * and dates, the history, an assignment form, and whether a run for this month could include them.
 * Pay is sensitive: the section is shown only to whoever may define structures or read a result.
 */
async function PayStructureSection({
  client,
  personnelNumber,
  canRead,
  canAssign,
  access,
}: {
  client: string;
  personnelNumber: string;
  canRead: boolean;
  canAssign: boolean;
  /** The signed-in session; the payroll services judge it themselves (capability, Company Code scope). */
  access: { authorization: { userId: string; sessionId: string } };
}) {
  if (!canRead) {
    return (
      <section className="panel p-4" aria-label="Pay structure">
        <h2 className="panel-title">Pay structure</h2>
        <p className="text-sm text-ink-soft">
          Pay is shown only to holders of {SALARY_STRUCTURE_CAPABILITY} or {PAYROLL_RESULT_CAPABILITY}.
        </p>
      </section>
    );
  }
  const today = new Date().toISOString().slice(0, 10);
  const monthFrom = `${today.slice(0, 8)}01`;
  const monthEnd = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  let loaded;
  try {
    loaded = await Promise.all([
      listAssignments(client, personnelNumber, access),
      listStructures(client, access),
      defaultPayrollCurrency(client),
      employeeRunReadiness(client, personnelNumber, monthFrom, monthEnd, access),
    ]);
  } catch (error) {
    if (!(error instanceof PayrollStructureError)) throw error;
    return (
      <section className="panel p-4" aria-label="Pay structure">
        <h2 className="panel-title">Pay structure</h2>
        <p role="status" className="text-sm text-ink-soft">{error.message}{error.remedy ? ` ${error.remedy}` : ''}</p>
      </section>
    );
  }
  const [assignments, structures, currency, readiness] = loaded;
  const current = assignments.find((a) => a.validFrom <= today && (a.validTo === null || a.validTo >= today)) ?? null;

  return (
    <section className="panel space-y-3 p-4" aria-label="Pay structure">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="panel-title">Pay structure</h2>
        <Link href={SALARY_STRUCTURE_ROUTE} className="text-sm underline">Salary structures</Link>
      </div>
      {current ? (
        <p className="text-sm">
          Current: <span className="code">{current.structureCode}</span> {current.structureName ? `— ${current.structureName}` : ''}, base{' '}
          <strong>{current.baseAmount} {current.currency}</strong>, from {current.validFrom} to {current.validTo ?? 'open'}.
        </p>
      ) : (
        <p className="text-sm text-ink-soft">No pay structure stands for {personnelNumber} today.</p>
      )}

      <div className="text-sm">
        <span className="field-label">Payroll readiness {monthFrom} to {monthEnd}</span>
        {readiness.ready ? (
          <p><span className="chip">ready</span> A run for this period could include {personnelNumber}. Nothing is calculated here.</p>
        ) : (
          <ul className="list-disc pl-5">
            {readiness.reasons.map((r) => (
              <li key={`${r.code}-${r.message}`}>{r.message}{r.remedy ? <span className="text-ink-soft"> {r.remedy}</span> : null}</li>
            ))}
          </ul>
        )}
        {readiness.notes.map((n) => <p key={n.message} className="text-xs text-ink-soft">Note: {n.message}</p>)}
      </div>

      {assignments.length > 0 && (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>Structure</th><th>Base</th><th>From</th><th>To</th>{canAssign && <th>End</th>}</tr></thead>
            <tbody>
              {assignments.map((a) => (
                <tr key={a.assignmentId}>
                  <td className="code">{a.structureCode}</td>
                  <td className="code">{a.baseAmount} {a.currency}</td>
                  <td className="text-xs">{a.validFrom}</td>
                  <td className="text-xs">{a.validTo ?? 'open'}</td>
                  {canAssign && (
                    <td>{a.validTo === null || a.validTo >= today ? <EndAssignmentForm assignmentId={a.assignmentId} defaultEnd={a.validTo ?? monthEnd} /> : '—'}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {canAssign && (
        <AssignStructureForm
          personnelNumber={personnelNumber}
          structures={structures.filter((s) => s.isValid).map((s) => ({ code: s.code, name: s.name, currency: s.currency }))}
          defaultCurrency={currency ?? ''}
          requestKey={randomUUID()}
          today={today}
        />
      )}
    </section>
  );
}

/**
 * Recurring pay components of this employee (9318): additions, deductions and employer contributions the company configures
 * for them, effective-dated, added to or replacing the shared structure's rule. Usable during onboarding, before any payroll
 * result exists. Pay is sensitive: shown only to holders of a payroll capability, and the service judges scope itself.
 */
async function RecurringComponentsSection({
  client,
  personnelNumber,
  canRead,
  canMaintain,
  access,
}: {
  client: string;
  personnelNumber: string;
  canRead: boolean;
  canMaintain: boolean;
  access: { authorization: { userId: string; sessionId: string } };
}) {
  if (!canRead) return null;
  const today = new Date().toISOString().slice(0, 10);
  let loaded;
  try {
    loaded = await Promise.all([
      listEmployeeComponents(client, personnelNumber, access),
      canMaintain ? listEntryComponents(client) : Promise.resolve([]),
      defaultPayrollCurrency(client),
    ]);
  } catch (error) {
    if (!(error instanceof PayrollStructureError) && !(error instanceof PayrollRunError)) throw error;
    return (
      <section className="panel p-4" aria-label="Recurring pay components">
        <h2 className="panel-title">Recurring pay components</h2>
        <p role="status" className="text-sm text-ink-soft">{error.message}{error.remedy ? ` ${error.remedy}` : ''}</p>
      </section>
    );
  }
  const [entries, components, currency] = loaded;
  return (
    <section className="panel space-y-3 p-4" aria-label="Recurring pay components">
      <h2 className="panel-title">Recurring pay components</h2>
      <p className="text-xs text-ink-soft">{COMPANY_RESPONSIBILITY_NOTICE}</p>
      {entries.length === 0 ? (
        <p className="text-sm text-ink-soft">No employee-specific components. This employee is paid by the shared salary structure only.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="grid-table">
            <thead><tr><th>Component</th><th>Relation</th><th>Calculation</th><th>Proration</th><th>From</th><th>To</th><th>Status</th><th>Reason</th>{canMaintain && <th>Change</th>}</tr></thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.entryId}>
                  <td><span className="code">{e.componentCode}</span> <span className="text-xs text-ink-soft">{e.componentName} · {e.componentKind?.toLowerCase().replace('_', ' ')}</span></td>
                  <td className="text-xs">{e.mode === 'ADD' ? 'adds to the structure' : 'replaces the structure rule'}</td>
                  <td className="text-xs"><span className="code">{e.amountKind === 'FIXED' ? `${e.amountValue} ${e.currency}` : `${e.amountValue} %`}</span><div className="text-ink-soft">{BASIS_LABEL[e.amountKind]}</div></td>
                  <td className="text-xs">{e.prorationPolicy.toLowerCase().replaceAll('_', ' ')}</td>
                  <td className="text-xs">{e.validFrom}</td>
                  <td className="text-xs">{e.validTo ?? 'open'}</td>
                  <td className="text-xs">{e.status.toLowerCase()}{e.withdrawnReason ? ` — ${e.withdrawnReason}` : ''}</td>
                  <td className="text-xs">{e.reason}<div className="text-ink-soft">{e.createdBy}</div></td>
                  {canMaintain && <td>{e.status === 'ACTIVE' ? <EntryActions entryId={e.entryId} defaultEnd={e.validTo ?? today} /> : '—'}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {canMaintain && (
        <AddComponentForm personnelNumber={personnelNumber} components={components} defaultCurrency={currency ?? ''} today={today} requestKey={randomUUID()} />
      )}
    </section>
  );
}
