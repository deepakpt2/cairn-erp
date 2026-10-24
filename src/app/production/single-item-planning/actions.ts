'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MRP_SINGLE_ROUTE,
  MrpRunError,
  planSingleItem,
  singleItemRefusal,
  type MrpRunView,
} from '@/modules/production/mrp-run';

export interface SingleItemActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  run?: MrpRunView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function planSingleItemAction(
  _previous: SingleItemActionState,
  form: FormData,
): Promise<SingleItemActionState> {
  const session = await requireSession(MRP_SINGLE_ROUTE);
  if (!can(session, MRP_RUN_CAPABILITY)) {
    return { ok: false, message: `You do not hold the planning capability (${MRP_RUN_CAPABILITY}).` };
  }
  const processingKey = text(form, 'processingKey').toUpperCase();
  if (processingKey === 'NEUPL' && !can(session, MRP_REGENERATE_CAPABILITY)) {
    return { ok: false, message: `You do not hold the regenerative planning capability (${MRP_REGENERATE_CAPABILITY}).` };
  }
  const named = {
    mrpArea: text(form, 'mrpArea'),
    leadTimeScheduling: text(form, 'leadTimeScheduling'),
    proposalMode: text(form, 'proposalMode'),
    changeNumber: text(form, 'changeNumber'),
    bomAlternative: text(form, 'bomAlternative'),
    calendar: text(form, 'calendar'),
    period: text(form, 'period'),
    background: text(form, 'background'),
    deleteAndRecreate: text(form, 'deleteAndRecreate'),
  };
  const refused = singleItemRefusal(named, text(form, 'planningMode'));
  if (refused) return { ok: false, message: refused };
  try {
    const run = await planSingleItem({
      client: session.user.client,
      requestedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      processingKey,
      planningMode: text(form, 'planningMode') || undefined,
      schedulingMode: text(form, 'schedulingMode') || undefined,
      horizonStart: text(form, 'horizonStart') || undefined,
      horizonEnd: text(form, 'horizonEnd') || undefined,
      productionVersion: text(form, 'productionVersion') || undefined,
      simulationOnly: text(form, 'intent') === 'check',
      confirmRegenerative: text(form, 'confirmRegenerative') === 'on',
      named,
    });
    return {
      ok: true,
      run,
      message: run.simulationOnly
        ? 'The check wrote no proposal and no dependent requirement.'
        : `Run ${run.runNumber} is ${run.status}.`,
    };
  } catch (error) {
    if (error instanceof MrpRunError) return { ok: false, message: error.message, remedy: error.remedy };
    return { ok: false, message: error instanceof Error ? error.message : 'The material could not be planned.' };
  }
}
