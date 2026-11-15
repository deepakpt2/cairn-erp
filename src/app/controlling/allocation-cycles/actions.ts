'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { can, requireSession } from '@/platform/auth/current';
import {
  ALLOCATION_CYCLE_ROUTE,
  ALLOCATION_DEFINE_CAPABILITY,
  ALLOCATION_EXECUTE_CAPABILITY,
  AllocationCycleError,
  cancelAssessmentRun,
  deleteCycle,
  previewAssessment,
  runAssessment,
  saveCycle,
  setReceiver,
  setSegment,
  setSender,
  type AssessmentPreview,
  type AssessmentRunView,
} from '@/modules/foundation/cost-allocation-cycle';

export interface CycleActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  preview?: AssessmentPreview;
  run?: AssessmentRunView;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

async function guard(capability: string) {
  const session = await requireSession(ALLOCATION_CYCLE_ROUTE);
  if (!can(session, capability)) return { refused: { ok: false, message: `You do not hold ${capability}.`, remedy: `Ask an administrator for ${capability}.` } as CycleActionState };
  return {
    client: session.user.client,
    actor: session.user.username,
    options: { authorization: { userId: session.user.userId, sessionId: session.sessionId ?? '' } },
  };
}

async function attempt(work: () => Promise<CycleActionState>): Promise<CycleActionState> {
  try {
    const state = await work();
    revalidatePath(ALLOCATION_CYCLE_ROUTE);
    return state;
  } catch (error) {
    if (error instanceof AllocationCycleError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}

/** Cycle header: `mode`, `controllingArea`, `cycleCode`, `name`, `category`, `validFrom`, `validTo`, `isActive`, `reason`. */
export async function saveCycleAction(_prev: CycleActionState, form: FormData): Promise<CycleActionState> {
  const g = await guard(ALLOCATION_DEFINE_CAPABILITY);
  if ('refused' in g && g.refused) return g.refused;
  return attempt(async () => {
    const view = await saveCycle({
      client: g.client, changedBy: g.actor, mode: text(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      controllingArea: text(form, 'controllingArea'), cycleCode: text(form, 'cycleCode'), name: text(form, 'name'),
      category: (text(form, 'category') || 'ASSESSMENT') as 'ASSESSMENT' | 'DISTRIBUTION',
      validFrom: text(form, 'validFrom'), validTo: text(form, 'validTo'), isActive: text(form, 'isActive') !== 'no', reason: text(form, 'reason'),
    }, g.options);
    return { ok: true, message: `Cycle ${view.cycleCode} — ${view.name} — saved (${view.category.toLowerCase()}, valid ${view.validFrom} to ${view.validTo}${view.isActive ? '' : ', inactive'}).` };
  });
}

/** Segment: `controllingArea`, `cycleCode`, `segmentNumber`, `name`, `senderRule`, `receiverRule`, `costElementFrom`, `costElementTo`, `reason`. */
export async function setSegmentAction(_prev: CycleActionState, form: FormData): Promise<CycleActionState> {
  const g = await guard(ALLOCATION_DEFINE_CAPABILITY);
  if ('refused' in g && g.refused) return g.refused;
  return attempt(async () => {
    const segment = await setSegment({
      client: g.client, changedBy: g.actor, controllingArea: text(form, 'controllingArea'), cycleCode: text(form, 'cycleCode'),
      segmentNumber: Number(text(form, 'segmentNumber')), name: text(form, 'name'), senderRule: text(form, 'senderRule') || 'POSTED',
      receiverRule: text(form, 'receiverRule'), costElementFrom: text(form, 'costElementFrom'), costElementTo: text(form, 'costElementTo'), reason: text(form, 'reason'),
    }, g.options);
    return { ok: true, message: `Segment ${segment.segmentNumber} — ${segment.name} — saved.` };
  });
}

/**
 * A sender or receiver item: `kind` (sender | receiver), `controllingArea`, `cycleCode`, `segmentNumber`,
 * `itemNumber`, `costCenter`, `groupName`, `weight` (receivers), `reason`. Both blank removes the item.
 */
export async function setNodeAction(_prev: CycleActionState, form: FormData): Promise<CycleActionState> {
  const g = await guard(ALLOCATION_DEFINE_CAPABILITY);
  if ('refused' in g && g.refused) return g.refused;
  return attempt(async () => {
    const kind = text(form, 'kind') === 'receiver' ? 'receiver' : 'sender';
    const input = {
      client: g.client, changedBy: g.actor, controllingArea: text(form, 'controllingArea'), cycleCode: text(form, 'cycleCode'),
      segmentNumber: Number(text(form, 'segmentNumber')), itemNumber: Number(text(form, 'itemNumber')),
      costCenter: text(form, 'costCenter'), groupName: text(form, 'groupName'), weight: text(form, 'weight') || undefined, reason: text(form, 'reason'),
    };
    await (kind === 'receiver' ? setReceiver(input, g.options) : setSender(input, g.options));
    const named = input.costCenter || input.groupName;
    return { ok: true, message: named ? `${kind === 'receiver' ? 'Receiver' : 'Sender'} ${input.itemNumber} set to ${named}.` : `${kind === 'receiver' ? 'Receiver' : 'Sender'} ${input.itemNumber} removed.` };
  });
}

/** Remove a segment (`segmentNumber` given) or the whole cycle: `controllingArea`, `cycleCode`, `reason`. */
export async function deleteAction(_prev: CycleActionState, form: FormData): Promise<CycleActionState> {
  const g = await guard(ALLOCATION_DEFINE_CAPABILITY);
  if ('refused' in g && g.refused) return g.refused;
  const segment = text(form, 'segmentNumber');
  const area = text(form, 'controllingArea').toUpperCase();
  const cycleCode = text(form, 'cycleCode').toUpperCase();
  const state = await attempt(async () => {
    await deleteCycle({ client: g.client, changedBy: g.actor, controllingArea: area, cycleCode, segmentNumber: segment ? Number(segment) : undefined, reason: text(form, 'reason') }, g.options);
    return { ok: true, message: segment ? `Segment ${segment} removed.` : `Cycle ${cycleCode} deleted.` };
  });
  // A deleted cycle takes its own form off the page; say so on the area's page instead.
  if (state.ok && !segment) redirect(`${ALLOCATION_CYCLE_ROUTE}?area=${encodeURIComponent(area)}&deleted=${encodeURIComponent(cycleCode)}`);
  return state;
}

/** Execute panel: `controllingArea`, `cycleCode`, `fiscalYear`, `period`, `reason`, `action` (preview | run). */
export async function executeAction(_prev: CycleActionState, form: FormData): Promise<CycleActionState> {
  const g = await guard(ALLOCATION_EXECUTE_CAPABILITY);
  if ('refused' in g && g.refused) return g.refused;
  const mode = text(form, 'action') === 'run' ? 'run' : 'preview';
  const input = {
    client: g.client, changedBy: g.actor, controllingArea: text(form, 'controllingArea'), cycleCode: text(form, 'cycleCode'),
    fiscalYear: Number(text(form, 'fiscalYear')), period: Number(text(form, 'period')),
    reason: text(form, 'reason') || (mode === 'preview' ? 'preview' : ''),
  };
  return attempt(async () => {
    if (mode === 'preview') {
      const preview = await previewAssessment(input, g.options);
      return { ok: true, preview, message: `Preview: ${preview.assessedTotal} ${preview.currency} would be assessed in ${preview.segments.length} segment(s) through account ${preview.assessmentAccount}. Nothing is posted yet.` };
    }
    const run = await runAssessment(input, g.options);
    revalidatePath('/controlling/cost-center-report');
    return { ok: true, run, preview: run, message: `Assessed ${run.assessedTotal} ${run.currency} as document ${run.displayNumber}, dated ${run.postingDate}.` };
  });
}

/** Cancel a run whose document stands reversed: `runId`, `reason`. */
export async function cancelRunAction(_prev: CycleActionState, form: FormData): Promise<CycleActionState> {
  const g = await guard(ALLOCATION_EXECUTE_CAPABILITY);
  if ('refused' in g && g.refused) return g.refused;
  return attempt(async () => {
    const run = await cancelAssessmentRun({ client: g.client, changedBy: g.actor, runId: text(form, 'runId'), reason: text(form, 'reason') }, g.options);
    return { ok: true, message: `Run of ${run.cycleCode} for ${run.period}/${run.fiscalYear} cancelled; the period can be assessed again.` };
  });
}
