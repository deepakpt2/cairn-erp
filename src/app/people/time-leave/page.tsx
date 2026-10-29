import Link from 'next/link';

import { can, requireSession } from '@/platform/auth/current';
import {
  TIME_LEAVE_ROUTE,
  TIME_ENTER_CAPABILITY,
  LEAVE_VIEW_CAPABILITY,
  TimeLeaveError,
  changeTimeType,
  decideAbsence,
  defineTimeType,
  getAbsence,
  getLeaveQuota,
  getTimeRecording,
  getTimeTypeView,
  listAbsences,
  listTimeTypes,
  recordTime,
  requestAbsence,
  setLeaveQuota,
  type AbsenceView,
  type LeaveQuotaView,
  type TimeRecordingView,
  type TimeTypeView,
} from '@/modules/people/time-leave';
import TimeLeave from './TimeLeave';

export const dynamic = 'force-dynamic';

/**
 * Time and leave: time types, absence requests, leave quotas and time recordings.
 *
 * This is CAIRN.md §8.10's "time_recording, absence, attendance, leave_quota |
 * Time data" and §15.1's "Time | Absences, attendances, leave quotas and
 * balances", the first time/leave slice. What is deliberately not here:
 * statutory entitlement, waiting periods, carry-over, working-day calendars,
 * half-day absences, retro-active correction of approved absences — country
 * leave law is §15.3's explicit exclusion (DV-001), and nothing here invents
 * one. Payroll reads absence and time rows later; nothing here posts.
 */
export default async function TimeLeavePage({
  searchParams,
}: {
  searchParams: Promise<{ employee?: string; type?: string; status?: string; q?: string }>;
}) {
  const session = await requireSession(TIME_LEAVE_ROUTE);
  const params = await searchParams;
  const client = session.user.client;
  const employee = (params.employee ?? '').trim().toUpperCase();
  const typeCode = (params.type ?? '').trim().toUpperCase();
  const status = (params.status ?? '').trim().toUpperCase();
  const query = (params.q ?? '').trim();

  const [timeTypes, absences] = await Promise.all([
    listTimeTypes(client, true),
    listAbsences({
      client,
      query: query || undefined,
      status: (status === 'REQUESTED' || status === 'APPROVED' || status === 'REJECTED' || status === 'CANCELLED')
        ? status
        : undefined,
      timeTypeCode: typeCode || undefined,
    }),
  ]);

  const selectedType = typeCode ? timeTypes.find((t) => t.code === typeCode) : null;
  const selectedAbsence = employee && typeCode
    ? absences.find((a) => a.personnelNumber === employee && a.timeTypeCode === typeCode)
    : undefined;

  const canWrite = can(session, TIME_ENTER_CAPABILITY);
  const canView = can(session, LEAVE_VIEW_CAPABILITY);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-3 sm:p-4 lg:p-6">
      <header className="border-b border-line pb-4">
        <span className="code text-ink-faint">
          {TIME_ENTER_CAPABILITY} · {LEAVE_VIEW_CAPABILITY}
        </span>
        <div className="mt-1 flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-xl font-semibold tracking-tight">Time &amp; leave</h1>
          <div className="flex gap-2">
            <Link href="/people/employees" className="btn btn-default min-h-11 sm:min-h-8">
              Employees
            </Link>
            <Link href="/people/assignments" className="btn btn-default min-h-11 sm:min-h-8">
              Assignments
            </Link>
            <Link href="/" className="btn btn-default min-h-11 sm:min-h-8">
              Launchpad
            </Link>
          </div>
        </div>
        <p className="mt-2 text-sm text-ink-soft">
          Time types, absence requests and leave balances, read back on the
          tenant's own connection. Nothing here posts to the general ledger —
          payroll reads the result later. Country-specific leave law is not
          built (DV-001, §15.3); entitlement is what the tenant configures.
        </p>
      </header>

      <TimeLeave
        timeTypes={timeTypes}
        selectedType={selectedType}
        absences={absences}
        selectedAbsence={selectedAbsence}
        employee={employee}
        query={query}
        canWrite={canWrite}
        canView={canView}
      />
    </div>
  );
}
