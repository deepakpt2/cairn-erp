'use server';

import { revalidatePath } from 'next/cache';

import { AuthzError, requireCapability } from '@/platform/auth/current';
import {
  ACTIVITY,
  ROUTE,
  BatchConversionError,
  checkBatchConversion,
  executeBatchConversion,
} from '@/modules/inventory/batch-conversion';

export interface ConversionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  summary?: string;
  result?: string;
  conflicts?: Array<{ position: number; conflictCode: string; objectKey: string; detail: string; blocks: boolean }>;
}

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

export async function checkConversionAction(
  _state: ConversionActionState,
  form: FormData,
): Promise<ConversionActionState> {
  const session = await requireCapability(ACTIVITY);
  const dryRun = read(form, 'dryRun') === 'yes';
  try {
    const checked = await checkBatchConversion({
      client: session.user.client,
      changedBy: session.user.username,
      capabilities: session.user.capabilities,
      targetLevel: read(form, 'targetLevel'),
      targetStatus: read(form, 'targetStatus'),
      expectedLevelVersion: Number(read(form, 'expectedLevelVersion') || '0'),
      dryRun,
      confirmed: read(form, 'confirmed') === 'yes',
      reason: read(form, 'reason'),
    });
    if (!dryRun) revalidatePath(ROUTE);
    return {
      ok: true,
      result: checked.result,
      summary: checked.summary,
      conflicts: checked.conflicts,
      message: dryRun
        ? `Dry run only. ${checked.summary}`
        : `Check recorded. ${checked.summary}`,
    };
  } catch (error) {
    if (error instanceof BatchConversionError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
}

export async function executeConversionAction(
  _state: ConversionActionState,
  _form: FormData,
): Promise<ConversionActionState> {
  await requireCapability(ACTIVITY);
  try {
    executeBatchConversion();
  } catch (error) {
    if (error instanceof BatchConversionError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
  return { ok: false, message: 'Live conversion is not available.' };
}
