'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { can, requireSession } from '@/platform/auth/current';
import {
  ASSIGNMENT_CAPABILITY,
  ASSIGNMENT_ROUTE,
  AssignmentError,
  assignPosition,
  changeAssignment,
  delimitAssignment,
} from '@/modules/people/assignment';

const ROUTE = ASSIGNMENT_ROUTE;

export interface AssignmentActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  personnelNumber?: string;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function optional(form: FormData, name: string): string | undefined {
  const value = text(form, name);
  return value === '' ? undefined : value;
}

/** The service's own words and remedy are the answer a refusal gives; anything else is a bug, not a refusal. */
function refuse(error: unknown): AssignmentActionState {
  if (error instanceof AssignmentError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function done(personnelNumber: string, message: string): AssignmentActionState {
  revalidatePath(ROUTE);
  revalidatePath(`${ROUTE}?employee=${personnelNumber}`);
  return { ok: true, message, personnelNumber };
}

/**
 * The session is read once for both answers a write needs: whose tenant, and who is writing. The tenant is
 * never taken from the form, and the capability named here is the one §10.8 registers for this screen (PA30).
 */
async function guard(doing: string): Promise<{ client: string; actor: string } | AssignmentActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSIGNMENT_CAPABILITY)) {
    return {
      ok: false,
      message: `${doing} needs ${ASSIGNMENT_CAPABILITY}, which this session does not hold.`,
      remedy: `Assignments are maintained by whoever the tenant authorizes for personnel org data; until then this screen reads.`,
    };
  }
  return { client: session.user.client, actor: session.user.username };
}

export async function assignAction(
  _previous: AssignmentActionState, formData: FormData,
): Promise<AssignmentActionState> {
  const access = await guard('Assigning a position');
  if (!('actor' in access)) return access;
  try {
    const view = await assignPosition({
      client: access.client,
      personnelNumber: text(formData, 'personnelNumber'),
      positionCode: text(formData, 'positionCode'),
      controllingArea: text(formData, 'controllingArea'),
      costCenter: text(formData, 'costCenter'),
      validFrom: text(formData, 'validFrom'),
      changedBy: access.actor,
      requestKey: optional(formData, 'requestKey'),
    });
    return done(view.personnelNumber, `Assignment written for ${view.personnelNumber}: ${view.positionCode} on ${view.costCenter} from ${view.validFrom}.`);
  } catch (error) {
    return refuse(error);
  }
}

export async function delimitAction(
  _previous: AssignmentActionState, formData: FormData,
): Promise<AssignmentActionState> {
  const access = await guard('Ending an assignment');
  if (!('actor' in access)) return access;
  let view;
  try {
    view = await delimitAssignment({
      client: access.client,
      personnelNumber: text(formData, 'personnelNumber'),
      validFrom: text(formData, 'validFrom'),
      validTo: text(formData, 'validTo'),
      changedBy: access.actor,
    });
  } catch (error) {
    return refuse(error);
  }
  revalidatePath(ROUTE);
  // The notice belongs in the standing panel, and this write is precisely what empties it: with no open span
  // the screen renders no standing block, so a returned message would vanish with the block that carries it.
  // The dates go into the URL and the page says the sentence over the history list instead — same words, from
  // ./copy, so the two cannot drift.
  const endedOn = view.validTo;
  if (endedOn === null) {
    // Not reachable through the screen, whose end form requires the last day; if a caller ever closes a span
    // without one, the write still stands, so say what happened rather than quote a date nobody gave.
    return done(view.personnelNumber, `Assignment for ${view.personnelNumber} from ${view.validFrom} was ended.`);
  }
  redirect(
    `${ROUTE}?employee=${encodeURIComponent(view.personnelNumber)}`
    + `&ended=${encodeURIComponent(view.validFrom)}&to=${encodeURIComponent(endedOn)}`,
  );
}

export async function changeAssignmentAction(
  _previous: AssignmentActionState, formData: FormData,
): Promise<AssignmentActionState> {
  const access = await guard('Correcting an assignment');
  if (!('actor' in access)) return access;
  try {
    const view = await changeAssignment({
      client: access.client,
      personnelNumber: text(formData, 'personnelNumber'),
      validFrom: text(formData, 'validFrom'),
      positionCode: optional(formData, 'positionCode'),
      controllingArea: optional(formData, 'controllingArea'),
      costCenter: optional(formData, 'costCenter'),
      changedBy: access.actor,
    });
    return done(view.personnelNumber, `Open assignment for ${view.personnelNumber} corrected: ${view.positionCode} on ${view.costCenter}. The dates were left as they were written.`);
  } catch (error) {
    return refuse(error);
  }
}
