/**
 * Scoped reads for the leave screens: employee picker, absence list, time recordings, group codes.
 *
 * Every function judges the live session (or the in-process capability list) and then keeps only employees the
 * caller reaches over the dates concerned. Nothing here is a screen-level check: the screen cannot widen it.
 */
import { sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import {
  LEAVE_ADJUST, LEAVE_APPROVE, LEAVE_ASSIGN, LEAVE_ENTER, LEAVE_VIEW, type LeaveAccess, judgeLeave, reachesEmployee,
} from './leave-access';

export interface PickerEmployee { personnelNumber: string; fullName: string }

/** Employees matching `query` (number or name) that the caller reaches over [from, to]. At most `limit`. */
export async function searchLeaveEmployees(
  client: string, access: LeaveAccess | undefined,
  opts: { query?: string; from: string; to: string; limit?: number },
): Promise<PickerEmployee[]> {
  const limit = Math.min(opts.limit ?? 25, 100);
  const needle = `%${(opts.query ?? '').trim().toUpperCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return withTenant(client, async (tx) => {
    const grant = await judgeLeave(tx, client, access, [LEAVE_ENTER, LEAVE_APPROVE, LEAVE_VIEW, LEAVE_ADJUST, LEAVE_ASSIGN]);
    const rows = (await tx.execute(sql`
      select personnel_number as pn, full_name as name from employee
       where client = ${client} and is_active
         and (upper(personnel_number) like ${needle} or upper(full_name) like ${needle})
       order by personnel_number limit 400
    `)) as unknown as Array<{ pn: string; name: string }>;
    const out: PickerEmployee[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      if (await reachesEmployee(tx, client, grant, r.pn, opts.from, opts.to)) out.push({ personnelNumber: r.pn, fullName: r.name });
    }
    return out;
  });
}

export interface AbsenceRow {
  id: string;
  personnelNumber: string;
  employeeName: string;
  timeTypeCode: string;
  timeTypeName: string | null;
  validFrom: string;
  validTo: string | null;
  status: 'REQUESTED' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  reason: string | null;
  policyManaged: boolean;
  /** What the requester confirmed at request time (null for a legacy row). */
  confirmedUnpaidDays: string | null;
  /** The split kept on the approved record (live allocations); null until approved or for a legacy row. */
  paidDays: string | null;
  unpaidDays: string | null;
}

export async function listLeaveAbsences(
  client: string, access: LeaveAccess | undefined,
  opts: { status?: string; query?: string; limit?: number } = {},
): Promise<AbsenceRow[]> {
  const limit = Math.min(opts.limit ?? 100, 200);
  const needle = `%${(opts.query ?? '').trim().toUpperCase().replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  return withTenant(client, async (tx) => {
    const grant = await judgeLeave(tx, client, access, [LEAVE_ENTER, LEAVE_APPROVE, LEAVE_VIEW]);
    const rows = (await tx.execute(sql`
      select a.id, a.personnel_number as pn, e.full_name as name, a.time_type_code as type, t.name as type_name,
             a.valid_from::text as valid_from, a.valid_to::text as valid_to, a.status, a.reason, a.policy_managed,
             a.confirmed_unpaid_days::text as confirmed,
             (select sum(l.days) filter (where l.is_paid)::text from absence_allocation l where l.client = a.client and l.absence_id = a.id and l.reversed_at is null) as paid,
             (select sum(l.days) filter (where not l.is_paid)::text from absence_allocation l where l.client = a.client and l.absence_id = a.id and l.reversed_at is null) as unpaid
        from absence a
        join employee e on e.client = a.client and e.personnel_number = a.personnel_number
        left join time_type t on t.client = a.client and t.code = a.time_type_code
       where a.client = ${client}
         ${opts.status ? sql`and a.status = ${opts.status}` : sql``}
         ${opts.query?.trim() ? sql`and (upper(a.personnel_number) like ${needle} or upper(e.full_name) like ${needle})` : sql``}
       order by a.valid_from desc, a.personnel_number limit 600
    `)) as unknown as Array<{
      id: string; pn: string; name: string; type: string; type_name: string | null; valid_from: string; valid_to: string | null;
      status: AbsenceRow['status']; reason: string | null; policy_managed: boolean; confirmed: string | null; paid: string | null; unpaid: string | null;
    }>;
    const out: AbsenceRow[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      if (!(await reachesEmployee(tx, client, grant, r.pn, r.valid_from, r.valid_to ?? r.valid_from))) continue;
      out.push({
        id: r.id, personnelNumber: r.pn, employeeName: r.name, timeTypeCode: r.type, timeTypeName: r.type_name,
        validFrom: r.valid_from, validTo: r.valid_to, status: r.status, reason: r.reason, policyManaged: r.policy_managed,
        confirmedUnpaidDays: r.confirmed, paidDays: r.paid, unpaidDays: r.unpaid,
      });
    }
    return out;
  });
}

export interface TimeRecordRow { personnelNumber: string; employeeName: string; timeTypeCode: string; recordingDate: string; hours: string }

export async function listLeaveTimeRecordings(
  client: string, access: LeaveAccess | undefined, opts: { limit?: number } = {},
): Promise<TimeRecordRow[]> {
  const limit = Math.min(opts.limit ?? 50, 200);
  return withTenant(client, async (tx) => {
    const grant = await judgeLeave(tx, client, access, [LEAVE_ENTER, LEAVE_VIEW]);
    const rows = (await tx.execute(sql`
      select r.personnel_number as pn, e.full_name as name, r.time_type_code as type, r.recording_date::text as day, r.hours::text as hours
        from time_recording r join employee e on e.client = r.client and e.personnel_number = r.personnel_number
       where r.client = ${client} order by r.recording_date desc, r.personnel_number limit 600
    `)) as unknown as Array<{ pn: string; name: string; type: string; day: string; hours: string }>;
    const out: TimeRecordRow[] = [];
    for (const r of rows) {
      if (out.length >= limit) break;
      if (await reachesEmployee(tx, client, grant, r.pn, r.day, r.day)) {
        out.push({ personnelNumber: r.pn, employeeName: r.name, timeTypeCode: r.type, recordingDate: r.day, hours: r.hours });
      }
    }
    return out;
  });
}

/** Leave groups by code and name, for the report's group picker (members are not named here). */
export async function listLeaveGroupChoices(client: string, access: LeaveAccess | undefined): Promise<Array<{ code: string; name: string }>> {
  return withTenant(client, async (tx) => {
    await judgeLeave(tx, client, access, [LEAVE_VIEW, LEAVE_ASSIGN]);
    return (await tx.execute(sql`select code, name from leave_group where client = ${client} and is_valid order by code`)) as unknown as Array<{ code: string; name: string }>;
  });
}
