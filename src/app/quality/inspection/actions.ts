'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  INSPECTION_RESULT_CAPABILITY,
  InspectionResultError,
  recordInspectionResult,
  listInspectionResults,
  lotResultSummary,
  saveCharacteristic,
  listCharacteristics,
  type CharacteristicRow,
  type ResultRow,
} from '@/modules/quality/inspection-results';
import {
  USAGE_DECISION_CAPABILITY,
  UsageDecisionError,
  postUsageDecisionWithStock,
  getDecisionWithLot,
  type DecisionWithLot,
} from '@/modules/quality/usage-decision';
import { getLot } from '@/modules/quality/lot';

const ROUTE = '/quality/inspection';

export interface InspectionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  lotNumber?: string;
}

function refuse(error: unknown): InspectionActionState {
  if (error instanceof InspectionResultError || error instanceof UsageDecisionError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

export async function recordResultAction(
  _previous: InspectionActionState,
  form: FormData,
): Promise<InspectionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INSPECTION_RESULT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the inspection-result capability.', remedy: 'Ask for QM.INSPECTION.RECORD.' };
  }

  const lotNumber = form.get('lotNumber');
  const characteristicCode = form.get('characteristicCode');
  const resultValue = form.get('resultValue');
  const measuredUnit = form.get('measuredUnit');
  const resultStatus = form.get('resultStatus');
  const requestKey = form.get('requestKey');

  if (typeof lotNumber !== 'string' || !lotNumber ||
      typeof characteristicCode !== 'string' || !characteristicCode ||
      typeof resultValue !== 'string' || !resultValue) {
    return { ok: false, message: 'Lot, characteristic and result value are required.' };
  }

  try {
    await recordInspectionResult({
      client: session.user.client,
      changedBy: session.user.username,
      lotNumber: lotNumber.trim().toUpperCase(),
      characteristicCode: characteristicCode.trim().toUpperCase(),
      resultValue: resultValue.trim(),
      measuredUnit: typeof measuredUnit === 'string' ? measuredUnit.trim().toUpperCase() || undefined : undefined,
      resultStatus: (typeof resultStatus === 'string' && resultStatus) as any,
      requestKey: typeof requestKey === 'string' ? requestKey.trim() || undefined : undefined,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Result recorded for ${lotNumber}.`,
      lotNumber: lotNumber.trim().toUpperCase(),
    };
  } catch (error) {
    return refuse(error);
  }
}

export async function saveCharacteristicAction(
  _previous: InspectionActionState,
  form: FormData,
): Promise<InspectionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, INSPECTION_RESULT_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the inspection-result capability.', remedy: 'Ask for QM.INSPECTION.RECORD.' };
  }

  const characteristicCode = form.get('characteristicCode');
  const description = form.get('description');
  const characteristicType = form.get('characteristicType');
  const tolerancePlus = form.get('tolerancePlus');
  const toleranceMinus = form.get('toleranceMinus');
  const unit = form.get('unit');

  if (typeof characteristicCode !== 'string' || !characteristicCode ||
      typeof description !== 'string' || !description ||
      typeof characteristicType !== 'string') {
    return { ok: false, message: 'Characteristic code, description and type are required.' };
  }

  try {
    await saveCharacteristic({
      client: session.user.client,
      changedBy: session.user.username,
      characteristicCode: characteristicCode.trim().toUpperCase(),
      description: description.trim(),
      characteristicType: characteristicType as 'QUANTITATIVE' | 'QUALITATIVE',
      tolerancePlus: typeof tolerancePlus === 'string' && tolerancePlus ? Number(tolerancePlus) : undefined,
      toleranceMinus: typeof toleranceMinus === 'string' && toleranceMinus ? Number(toleranceMinus) : undefined,
      unit: typeof unit === 'string' ? unit.trim().toUpperCase() || undefined : undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Characteristic ${characteristicCode} saved.` };
  } catch (error) {
    return refuse(error);
  }
}

export async function decideAction(
  _previous: InspectionActionState,
  form: FormData,
): Promise<InspectionActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, USAGE_DECISION_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the usage-decision capability.', remedy: 'Ask for QM.USAGE.DECIDE.' };
  }

  const lotNumber = form.get('lotNumber');
  const decisionCode = form.get('decisionCode');
  const postStock = form.get('postStock');
  const requestKey = form.get('requestKey');

  if (typeof lotNumber !== 'string' || !lotNumber ||
      typeof decisionCode !== 'string' || !decisionCode) {
    return { ok: false, message: 'Lot and decision are required.' };
  }

  try {
    await postUsageDecisionWithStock({
      client: session.user.client,
      changedBy: session.user.username,
      lotNumber: lotNumber.trim().toUpperCase(),
      decisionCode: decisionCode as 'ACCEPT' | 'REJECT' | 'BLOCK' | 'REWORK',
      postStock: postStock !== 'false',
      requestKey: typeof requestKey === 'string' ? requestKey.trim() || undefined : undefined,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: `Usage decision ${decisionCode} recorded for ${lotNumber}.`,
      lotNumber: lotNumber.trim().toUpperCase(),
    };
  } catch (error) {
    return refuse(error);
  }
}

export async function loadInspectionWorkbench(
  client: string, lotNumber: string,
): Promise<{
  lot: any;
  characteristics: CharacteristicRow[];
  results: ResultRow[];
  decision: DecisionWithLot | null;
  summary: any;
} | null> {
  const [lot, characteristics, results, decision, summary] = await Promise.all([
    getLot(client, lotNumber),
    listCharacteristics(client),
    listInspectionResults(client, lotNumber),
    getDecisionWithLot(client, lotNumber),
    lotResultSummary(client, lotNumber),
  ]);
  if (!lot) return null;
  return { lot, characteristics, results, decision, summary };
}