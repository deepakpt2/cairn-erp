'use server';

import { revalidatePath } from 'next/cache';

import { liveLeave, leaveRefusal, field, type LeaveActionState } from '@/app/people/leave-live';
import { changeTimeType, defineTimeType } from '@/modules/people/time-leave';
import {
  addGroupMember, addLeavePolicyVersion, assignLeavePolicy, changeLeavePolicy, defineLeaveGroup, defineLeavePolicy,
  endGroupMember, endLeavePolicyAssignment,
} from '@/modules/people/leave-policy';

const ROUTE = '/config/time-types';
const ok = (message: string): LeaveActionState => { revalidatePath(ROUTE); return { ok: true, message }; };
const yesNo = (form: FormData, name: string, fallback: boolean) => { const v = field(form, name); return v === '' ? fallback : v === 'yes'; };

/** "ANNUAL 24 MONTHLY UNPAID" per line: type, days, mode, optional fallback. */
function parseLines(raw: string) {
  return raw.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [timeTypeCode, annualDays, accrualMode, fallbackTypeCode] = l.split(/\s+/);
    return { timeTypeCode: timeTypeCode ?? '', annualDays: annualDays ?? '', accrualMode: (accrualMode ?? '').toUpperCase(), fallbackTypeCode: fallbackTypeCode ?? '' };
  });
}

export async function defineTimeTypeAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const v = await defineTimeType({
      client, code: field(form, 'code'), name: field(form, 'name'), description: field(form, 'description') || null,
      typeKind: field(form, 'typeKind'), reducesQuota: yesNo(form, 'reducesQuota', false), isPaid: yesNo(form, 'isPaid', true), changedBy: username,
    }, access);
    return ok(`Time type ${v.code} defined as ${v.typeKind.toLowerCase()}.`);
  } catch (e) { return leaveRefusal(e); }
}

export async function changeTimeTypeAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const v = await changeTimeType({
      client, code: field(form, 'typeCode'), name: field(form, 'name') || undefined, description: field(form, 'description') || null,
      isValid: yesNo(form, 'isValid', true), isPaid: yesNo(form, 'isPaid', true), changedBy: username,
    }, access);
    return ok(`Time type ${v.code} is now ${v.isValid ? 'valid' : 'retired'}.`);
  } catch (e) { return leaveRefusal(e); }
}

export async function definePolicyAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const v = await defineLeavePolicy({
      client, code: field(form, 'code'), name: field(form, 'name'), description: field(form, 'description') || null,
      validFrom: field(form, 'validFrom'), partialMonthMode: field(form, 'partialMonthMode'), lines: parseLines(field(form, 'lines')), changedBy: username,
    }, access);
    return ok(`Policy ${v.code} defined (version 1 from ${field(form, 'validFrom')}).`);
  } catch (e) { return leaveRefusal(e); }
}

export async function addPolicyVersionAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const v = await addLeavePolicyVersion({
      client, policyCode: field(form, 'policyCode'), validFrom: field(form, 'validFrom'),
      partialMonthMode: field(form, 'partialMonthMode'), lines: parseLines(field(form, 'lines')), changedBy: username,
    }, access);
    return ok(`Policy ${v.code} now has ${v.versions.length} version(s).`);
  } catch (e) { return leaveRefusal(e); }
}

export async function retirePolicyAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    const v = await changeLeavePolicy({ client, code: field(form, 'code'), isValid: yesNo(form, 'isValid', true), changedBy: username }, access);
    return ok(`Policy ${v.code} is now ${v.isValid ? 'valid' : 'retired'}.`);
  } catch (e) { return leaveRefusal(e); }
}

export async function defineGroupAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    await defineLeaveGroup({ client, code: field(form, 'code'), name: field(form, 'name'), description: field(form, 'description') || null, changedBy: username }, access);
    return ok(`Group ${field(form, 'code').toUpperCase()} defined.`);
  } catch (e) { return leaveRefusal(e); }
}

export async function addMemberAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    await addGroupMember({
      client, groupCode: field(form, 'groupCode'), personnelNumber: field(form, 'personnelNumber'),
      validFrom: field(form, 'validFrom'), validTo: field(form, 'validTo'), changedBy: username,
    }, access);
    return ok(`Added ${field(form, 'personnelNumber').toUpperCase()} to group ${field(form, 'groupCode').toUpperCase()}.`);
  } catch (e) { return leaveRefusal(e); }
}

export async function endMemberAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    await endGroupMember({ client, id: field(form, 'id'), validTo: field(form, 'validTo'), changedBy: username }, access);
    return ok('Membership ended.');
  } catch (e) { return leaveRefusal(e); }
}

export async function assignPolicyAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    await assignLeavePolicy({
      client, subjectKind: field(form, 'subjectKind'), subject: field(form, 'subject'), policyCode: field(form, 'policyCode'),
      validFrom: field(form, 'validFrom'), validTo: field(form, 'validTo'), changedBy: username,
    }, access);
    return ok(`Policy ${field(form, 'policyCode').toUpperCase()} assigned to ${field(form, 'subject').toUpperCase()}.`);
  } catch (e) { return leaveRefusal(e); }
}

export async function endAssignmentAction(_p: LeaveActionState, form: FormData): Promise<LeaveActionState> {
  const { client, access, username } = await liveLeave(ROUTE);
  try {
    await endLeavePolicyAssignment({ client, id: field(form, 'id'), validTo: field(form, 'validTo'), changedBy: username }, access);
    return ok('Assignment ended.');
  } catch (e) { return leaveRefusal(e); }
}
