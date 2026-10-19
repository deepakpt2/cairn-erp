'use server';

/** FIN.CLOSE.CARRYFORWARD — authenticate, authorise, execute (SCR-102). */
import { revalidatePath } from 'next/cache';
import {
  CARRYFORWARD_CAPABILITY, CarryforwardError, executeCarryforward,
} from '@/modules/finance/carryforward';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';

export interface CarryState { ok: boolean; message?: string; remedy?: string; runId?: string }

export async function executeCarryforwardAction(_previous: CarryState, formData: FormData): Promise<CarryState> {
  const session = await requireSession('/finance/carryforward');
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  try {
    await requireCapability(CARRYFORWARD_CAPABILITY, session);
    const run = await executeCarryforward({
      client: session.user.client, changedBy: session.user.username,
      selection: {
        ledger: read('ledger').toUpperCase() || '0L',
        companyCodes: read('companyCodes').split(',').map((c) => c.trim()).filter(Boolean),
        targetFiscalYear: Number(read('targetFiscalYear')),
        testRun: read('testRun') !== 'false',
      },
    });
    revalidatePath('/finance/carryforward');
    return {
      ok: true, runId: run.runId,
      message: run.testRun
        ? `Test run ${run.runId} completed: ${run.accountsProcessed} accounts examined, nothing posted.`
        : `Carryforward ${run.runId} ${run.status.toLowerCase()}: ${run.accountsProcessed} accounts, P&L transfer ${run.plTransferred.toFixed(2)}.`,
    };
  } catch (error) {
    if (error instanceof CarryforwardError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: (error as { remedy?: string }).remedy };
    }
    console.error('Carryforward failed', error);
    return { ok: false, message: 'The carryforward failed. Nothing was posted.', remedy: 'Contact an administrator if the problem persists.' };
  }
}
