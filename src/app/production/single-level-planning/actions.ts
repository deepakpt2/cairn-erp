'use server';

import { can, requireSession } from '@/platform/auth/current';
import {
  MRP_REGENERATE_CAPABILITY,
  MRP_RUN_CAPABILITY,
  MRP_SINGLE_LEVEL_CAPABILITY,
  MRP_SINGLE_LEVEL_ROUTE,
  MrpRunError,
  planSingleLevel,
  singleLevelRefusal,
  type MrpRunView,
} from '@/modules/production/mrp-run';

export interface SingleLevelActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  run?: MrpRunView | null;
}

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function planSingleLevelAction(
  _previous: SingleLevelActionState,
  form: FormData,
): Promise<SingleLevelActionState> {
  const session = await requireSession(MRP_SINGLE_LEVEL_ROUTE);
  if (!can(session, MRP_SINGLE_LEVEL_CAPABILITY) || !can(session, MRP_RUN_CAPABILITY)) {
    return { ok: false, message: `You do not hold the planning capability (${MRP_SINGLE_LEVEL_CAPABILITY}).` };
  }
  const processingKey = text(form, 'processingKey').toUpperCase();
  if (processingKey === 'NEUPL' && !can(session, MRP_REGENERATE_CAPABILITY)) {
    return { ok: false, message: `You do not hold the regenerative planning capability (${MRP_REGENERATE_CAPABILITY}).` };
  }
  const named = {
    mrpArea: text(form, 'mrpArea'),
    scheduleLine: text(form, 'scheduleLine'),
    mrpList: text(form, 'mrpList'),
    createMrpList: text(form, 'createMrpList'),
    md05: text(form, 'md05'),
    proposalMode: text(form, 'proposalMode'),
    purchaseRequisition: text(form, 'purchaseRequisition'),
    planningDate: text(form, 'planningDate'),
    openingPeriod: text(form, 'openingPeriod'),
    leadTimeScheduling: text(form, 'leadTimeScheduling'),
    calendar: text(form, 'calendar'),
    period: text(form, 'period'),
    background: text(form, 'background'),
    deleteAndRecreate: text(form, 'deleteAndRecreate'),
    changeNumber: text(form, 'changeNumber'),
    bomAlternative: text(form, 'bomAlternative'),
    companyCode: text(form, 'companyCode'),
  };
  const refused = singleLevelRefusal(named, text(form, 'planningMode'));
  if (refused) return { ok: false, message: refused };
  try {
    const run = await planSingleLevel({
      client: session.user.client,
      requestedBy: session.user.username,
      requestKey: text(form, 'requestKey'),
      materialNumber: text(form, 'materialNumber'),
      plant: text(form, 'plant'),
      processingKey,
      planningMode: text(form, 'planningMode') || undefined,
      schedulingMode: 'BASIC',
      horizonStart: text(form, 'horizonStart') || undefined,
      horizonEnd: text(form, 'horizonEnd') || undefined,
      productionVersion: text(form, 'productionVersion') || undefined,
      simulationOnly: text(form, 'intent') === 'check',
      confirmRegenerative: text(form, 'confirmRegenerative') === 'on',
      named,
    });
    const failed = run.status === 'FAILED';
    return {
      ok: !failed,
      run,
      message: failed
        ? `Run ${run.runNumber} failed. No proposal from this attempt was left.`
        : run.simulationOnly
          ? 'The check wrote no proposal and no dependent requirement. Leaving the screen changes nothing.'
          : `Run ${run.runNumber} is ${run.status}. A lower-level component was not planned.`,
    };
  } catch (error) {
    if (error instanceof MrpRunError) return { ok: false, message: error.message, remedy: error.remedy };
    return { ok: false, message: error instanceof Error ? error.message : 'The material could not be planned.' };
  }
}
