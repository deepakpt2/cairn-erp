'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ASSET_DEPRECIATE_CAPABILITY, AssetDepreciationError,
  executeDepreciationRun,
  type DepreciationRunResult, type DepreciationRunType,
} from '@/modules/finance/asset-depreciation';

export interface DepreciateActionState {
  ok: boolean;
  message: string;
  remedy?: string;
  result?: DepreciationRunResult;
}

const ROUTE = '/finance/assets/depreciate';
const POST_CAPABILITY = 'FIN.JOURNAL.POST';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function executeAction(
  _previous: DepreciateActionState,
  form: FormData,
): Promise<DepreciateActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_DEPRECIATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the depreciation run capability.' };
  }
  const testRun = text(form, 'intent') !== 'live';
  if (!testRun && !can(session, POST_CAPABILITY)) {
    return { ok: false, message: 'A live depreciation run takes the journal posting capability, apart from the run capability.' };
  }
  try {
    const result = await executeDepreciationRun({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      fiscalYear: Number(text(form, 'fiscalYear')),
      postingPeriod: Number(text(form, 'postingPeriod')),
      runType: (text(form, 'runType') || '1') as DepreciationRunType,
      testRun,
      documentType: text(form, 'documentType').toUpperCase() || 'AF',
      postingDate: text(form, 'postingDate'),
      restartOfRunId: text(form, 'restartOfRunId') || undefined,
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      result,
      message: testRun
        ? `Test run ${result.runId} simulated: ${result.totalCalculated.toFixed(2)} ${result.currency} calculated across ${result.items.length} item(s). Nothing was posted.`
        : `Live run ${result.runId} ${result.status.toLowerCase().replace(/_/g, ' ')}: ${result.totalPosted.toFixed(2)} ${result.currency} posted${result.documentNumber ? ` as document ${result.documentNumber}` : ''}.`,
    };
  } catch (error) {
    if (error instanceof AssetDepreciationError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}
