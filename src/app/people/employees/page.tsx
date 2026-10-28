import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import { EMPLOYEE_CAPABILITY, EMPLOYEE_ROUTE, RECORD_CAPABILITY, getEmployee, listEmployees } from '@/modules/people/employee-master';
import { listRecordTypes } from '@/modules/people/record-types';
import Employees from './Employees';

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
  const params = await searchParams;
  const client = session.user.client;
  const personnelNumber = (params.employee ?? '').trim().toUpperCase();
  const query = (params.q ?? '').trim();

  const [employees, types, selected] = await Promise.all([
    listEmployees(client, query),
    listRecordTypes(client),
    personnelNumber ? getEmployee(client, personnelNumber) : Promise.resolve(null),
  ]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">{EMPLOYEE_CAPABILITY} · {RECORD_CAPABILITY}</span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Employees</h1>
          <div className="flex gap-2">
            <Link href="/config/people-record-types" className="btn btn-default min-h-11 sm:min-h-8">Record types</Link>
            <Link href="/config/number-ranges" className="btn btn-default min-h-11 sm:min-h-8">Number ranges</Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">Launchpad</Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          A person is a personnel number and a name; what is true about them stands in dated records. Writing a
          change creates a new record and leaves the one it replaces readable, so the history a payroll result
          was built from can still be shown a year later. Nothing here calculates or posts pay.
        </p>
      </header>
      <Employees
        employees={employees}
        types={types}
        selected={selected}
        query={query}
        canCreateMaster={can(session, EMPLOYEE_CAPABILITY)}
        canMaintainRecords={can(session, RECORD_CAPABILITY)}
      />
    </div>
  );
}
