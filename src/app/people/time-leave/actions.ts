'use server';

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';

import { liveLeave, leaveRefusal, field, type LeaveActionState } from '@/app/people/leave-live';
import {
  type AbsencePlan, approveLeaveAbsence, cancelLeaveAbsence, previewAbsence, rejectLeaveAbsence, requestLeaveAbsence,
} from '@/modules/people/leave-absence';
import { applyLegacyConversion, adjustLeaveBalance, previewLegacyConversion, type ConversionPreview } from '@/modules/people/leave-ledger';
import { requestLeaveAccrual } from '@/modules/people/leave-accrual';
import { requestLeaveExport, type ExportView } from '@/modules/people/leave-export';
import { recordTime } from '@/modules/people/time-leave';
import { TIME_LEAVE_ROUTE } from '@/modules/people/time-leave';

const ROUTE = TIME_LEAVE_ROUTE;

export type AbsenceActionState = LeaveActionState & { plan?: AbsencePlan; absenceId?: string };
export type ConversionState = LeaveActionState & { preview?: ConversionPreview };
export type ExportState = LeaveActionState & { export?: ExportView };

const done = (message: string, extra: Partial<AbsenceActionState> = {}): AbsenceActionState => {
  revalidatePath(ROUTE);
  return { ok: true, message, ...extra };
};

/** The paid/unpaid split a request would get right now. Writes nothing. */
export async function previewAbsenceAction(_p: AbsenceActionState, form: FormData): Promise<AbsenceActionState> {
  const { client, access } = await liveLeave(ROUTE);
  try {
    const plan = await previewAbsence({
      client, personnelNumber: field(form, 'personnelNumber'), timeTypeCode: field(form, 'timeTypeCode'),
      validFrom: field(form, 'validFrom'), validTo: field(form, 'validTo') || undefined,
    }, access);
    return { ok: true, plan };
  } catch (e) { return leaveRefusal(e); }
}

/** Request an absence. When the split has unpaid days, `confirmUnpaid` must carry the days the requester saw. */
export async function requestAbsenceAction(_p: AbsenceActionState, form: FormData): Promise<AbsenceActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const out = await requestLeaveAbsence({
      client, personnelNumber: field(form, 'personnelNumber'), timeTypeCode: field(form, 'timeTypeCode'),
      validFrom: field(form, 'validFrom'), validTo: field(form, 'validTo') || undefined, reason: field(form, 'reason') || null,
      requestKey: field(form, 'requestKey') || randomUUID(), confirmUnpaidDays: field(form, 'confirmUnpaid') || undefined, changedBy: username,
    }, access);
    return done(
      `${out.replayed ? 'Already recorded: ' : ''}Absence for ${out.personnelNumber} (${out.timeTypeCode} from ${out.validFrom}) is ${out.status}${out.unpaidDays > 0 ? `, with ${out.unpaidDays} unpaid day(s) confirmed` : ''}.`,
      { absenceId: out.absenceId },
    );
  } catch (e) { return leaveRefusal(e); }
}

/** Approve, reject or cancel one absence, named by its id (never by employee/type/start). */
export async function decideAbsenceAction(_p: AbsenceActionState, form: FormData): Promise<AbsenceActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  const decision = field(form, 'decision');
  const input = { client, absenceId: field(form, 'absenceId'), confirmUnpaidDays: field(form, 'confirmUnpaid') || undefined, changedBy: username };
  try {
    const out = decision === 'APPROVED' ? await approveLeaveAbsence(input, access)
      : decision === 'REJECTED' ? await rejectLeaveAbsence(input, access)
      : decision === 'CANCELLED' ? await cancelLeaveAbsence(input, access)
      : null;
    if (!out) return { ok: false, message: 'Choose approve, reject or cancel.', remedy: 'Pick a decision and submit again.' };
    return done(`Absence for ${out.personnelNumber} (${out.timeTypeCode} from ${out.validFrom}) is now ${out.status}.`, { absenceId: out.absenceId });
  } catch (e) { return leaveRefusal(e); }
}

export async function recordTimeAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  const hours = Number(field(form, 'hours'));
  try {
    const v = await recordTime({
      client, personnelNumber: field(form, 'personnelNumber'), timeTypeCode: field(form, 'timeTypeCode'),
      recordingDate: field(form, 'recordingDate'), hours: Number.isFinite(hours) ? hours : 0, changedBy: username,
    }, access);
    revalidatePath(ROUTE);
    return { ok: true, message: `Time recorded for ${v.personnelNumber} (${v.timeTypeCode}) on ${v.recordingDate}: ${v.hours} hours.` };
  } catch (e) { return leaveRefusal(e); }
}

export async function adjustBalanceAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const r = await adjustLeaveBalance({
      client, personnelNumber: field(form, 'personnelNumber'), timeTypeCode: field(form, 'timeTypeCode'),
      year: Number(field(form, 'year')), days: field(form, 'days'), reason: field(form, 'reason'),
      requestKey: field(form, 'requestKey') || randomUUID(), changedBy: username,
    }, access);
    revalidatePath(ROUTE);
    return { ok: true, message: r.posted ? 'Adjustment posted to the ledger.' : 'Already posted: this request key was used before.' };
  } catch (e) { return leaveRefusal(e); }
}

export async function runAccrualAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access } = await liveLeave(ROUTE);
  const kind = field(form, 'kind') === 'BACKFILL' ? 'BACKFILL' : 'CATCH_UP';
  try {
    const r = await requestLeaveAccrual(client, kind, access);
    revalidatePath(ROUTE);
    return { ok: true, message: r.created ? `${kind === 'BACKFILL' ? 'Backfill (intensive queue)' : 'Catch-up'} queued as run ${r.jobRunId}.` : `A ${kind === 'BACKFILL' ? 'backfill' : 'catch-up'} was already queued today (run ${r.jobRunId}).` };
  } catch (e) { return leaveRefusal(e); }
}

export async function queueExportAction(_p: ExportState, form: FormData): Promise<ExportState> {
  const { client, access } = await liveLeave(ROUTE);
  const numbers = field(form, 'employees').split(/[\s,;]+/).filter(Boolean);
  try {
    const v = await requestLeaveExport({
      client, personnelNumbers: numbers, groupCode: field(form, 'group') || undefined,
      year: field(form, 'year') ? Number(field(form, 'year')) : undefined, asOf: field(form, 'asOf') || undefined,
      requestKey: field(form, 'requestKey') || randomUUID(),
    }, access);
    revalidatePath(ROUTE);
    return { ok: true, message: `Export queued on the intensive worker (${v.status.toLowerCase()}). It appears under "Your exports" when ready.`, export: v };
  } catch (e) { return leaveRefusal(e); }
}

/** Conversion: `step=preview` reads, `step=apply` converts the previewed cutover. */
export async function legacyConversionAction(_p: ConversionState, form: FormData): Promise<ConversionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  const input = { client, personnelNumber: field(form, 'personnelNumber'), cutover: field(form, 'cutover'), changedBy: username };
  try {
    if (field(form, 'step') === 'apply') {
      const r = await applyLegacyConversion(input, access);
      revalidatePath(ROUTE);
      return { ok: true, message: `Converted ${r.converted} legacy quota(s) to policy balances.` };
    }
    const preview = await previewLegacyConversion(input, access);
    return { ok: true, preview, message: `${preview.convertible} convertible, ${preview.blocked} blocked. Nothing is changed until you apply.` };
  } catch (e) { return leaveRefusal(e); }
}
