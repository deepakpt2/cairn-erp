import { can, requireSession } from '@/platform/auth/current';
import { withTenant } from '@/platform/db/client';
import {
  LEAVE_ACCRUE, LEAVE_ADJUST, LEAVE_APPROVE, LEAVE_ENTER, LEAVE_EXPORT, LEAVE_VIEW, isLeaveError,
} from '@/modules/people/leave-access';
import { leaveAccrualStatus, type AccrualStatus } from '@/modules/people/leave-accrual';
import { listLeaveExports, type ExportView } from '@/modules/people/leave-export';
import { tenantToday } from '@/modules/people/leave-ledger';
import { leaveBalanceReport, type LeaveReport } from '@/modules/people/leave-report';
import {
  listLeaveAbsences, listLeaveGroupChoices, listLeaveTimeRecordings, searchLeaveEmployees,
  type AbsenceRow, type PickerEmployee, type TimeRecordRow,
} from '@/modules/people/leave-views';
import { TIME_LEAVE_ROUTE, listTimeTypes, type TimeTypeView } from '@/modules/people/time-leave';
import { LinkButton, Page } from '@/ui/kit';
import TimeLeave, { type Tab } from './TimeLeave';

export const dynamic = 'force-dynamic';

type Params = { tab?: string; q?: string; status?: string; emp?: string; employees?: string; group?: string; year?: string; asOf?: string };

/** A read the caller may not make comes back as a message, never a crash and never a partial list. */
async function guarded<T>(run: () => Promise<T>, empty: T): Promise<{ data: T; error: string | null }> {
  try { return { data: await run(), error: null }; } catch (e) {
    if (isLeaveError(e)) return { data: empty, error: e.message };
    throw e;
  }
}

/**
 * Time & leave, in three tabs (?tab=): Absences (request with a split preview, decide by id), Time records, and
 * Leave balances (ledger-backed report, CSV, adjustment, accrual status). Every read and write is judged by the
 * leave services on the live session and the employee's Company Code scope; `can()` here only hides buttons.
 */
export default async function TimeLeavePage({ searchParams }: { searchParams: Promise<Params> }) {
  const session = await requireSession(TIME_LEAVE_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const access = { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } };
  const tab: Tab = params.tab === 'time' ? 'time' : params.tab === 'balances' ? 'balances' : 'absences';
  const caps = {
    enter: can(session, LEAVE_ENTER), approve: can(session, LEAVE_APPROVE), adjust: can(session, LEAVE_ADJUST),
    view: can(session, LEAVE_VIEW), exportCsv: can(session, LEAVE_EXPORT), accrue: can(session, LEAVE_ACCRUE),
  };
  const { today } = await withTenant(client, (tx) => tenantToday(tx, client));
  const year = Number(today.slice(0, 4));
  const types = await listTimeTypes(client, true);
  const picker = (q?: string) => guarded<PickerEmployee[]>(
    () => searchLeaveEmployees(client, access, { query: q, from: `${year}-01-01`, to: `${year}-12-31`, limit: 100 }), []);

  let absences: { data: AbsenceRow[]; error: string | null } = { data: [], error: null };
  let times: { data: TimeRecordRow[]; error: string | null } = { data: [], error: null };
  let employees: { data: PickerEmployee[]; error: string | null } = { data: [], error: null };
  let report: { data: LeaveReport | null; error: string | null } = { data: null, error: null };
  let accrual: { data: AccrualStatus | null; error: string | null } = { data: null, error: null };
  let exportsList: { data: ExportView[]; error: string | null } = { data: [], error: null };
  let groups: Array<{ code: string; name: string }> = [];

  if (tab === 'absences') {
    [absences, employees] = await Promise.all([
      guarded(() => listLeaveAbsences(client, access, { status: params.status || undefined, query: params.q }), []),
      picker(params.emp),
    ]);
  } else if (tab === 'time') {
    [times, employees] = await Promise.all([guarded(() => listLeaveTimeRecordings(client, access), []), picker(params.emp)]);
  } else {
    const numbers = (params.employees ?? '').split(/[\s,;]+/).map((n) => n.trim()).filter(Boolean);
    const selecting = numbers.length > 0 || !!params.group;
    [report, accrual, exportsList, employees] = await Promise.all([
      selecting
        ? guarded(() => leaveBalanceReport({
            client, personnelNumbers: numbers, groupCode: params.group || undefined,
            year: params.year ? Number(params.year) : undefined, asOf: params.asOf || undefined,
          }, access), null as LeaveReport | null)
        : Promise.resolve({ data: null as LeaveReport | null, error: null }),
      caps.accrue ? guarded(() => leaveAccrualStatus(client, access), null as AccrualStatus | null) : Promise.resolve({ data: null as AccrualStatus | null, error: null }),
      caps.exportCsv ? guarded(() => listLeaveExports(client, access), []) : Promise.resolve({ data: [] as ExportView[], error: null }),
      picker(params.emp),
    ]);
    groups = (await guarded(() => listLeaveGroupChoices(client, access), [])).data;
  }

  return (
    <Page
      title="Time &amp; leave" code={`${LEAVE_ENTER} · ${LEAVE_APPROVE} · ${LEAVE_VIEW}`}
      description="Absences, time records and leave balances. Balances come from the immutable leave ledger; annual allowance is a target, and only completed months are credited. Country-specific leave law is not built (DV-001)."
      actions={<><LinkButton href="/people/employees">Employees</LinkButton><LinkButton href="/config/time-types">Time types &amp; policies</LinkButton></>}
    >
      <TimeLeave
        tab={tab} today={today} year={year} caps={caps} params={params}
        timeTypes={types as TimeTypeView[]} employees={employees.data}
        absences={absences.data} times={times.data} report={report.data} accrual={accrual.data} exportsList={exportsList.data}
        groups={groups}
        errors={[absences.error, times.error, employees.error, report.error, accrual.error, exportsList.error].filter((e): e is string => !!e)}
      />
    </Page>
  );
}
