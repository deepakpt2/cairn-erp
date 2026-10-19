'use server';

/** FIN.ACCRUAL.POST — authenticate, authorise, post and reverse accrual documents (SCR-100). */
import { revalidatePath } from 'next/cache';
import {
  postAccrualDocument, executeAccrualReversal, AccrualError, ACCRUAL_CAPABILITY,
} from '@/modules/finance/accrual';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';

export interface AccrualState {
  ok: boolean;
  message?: string;
  remedy?: string;
  documentNumber?: string;
}

export async function postAccrualAction(_previous: AccrualState, formData: FormData): Promise<AccrualState> {
  const session = await requireSession('/finance/accruals');
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  try {
    await requireCapability(ACCRUAL_CAPABILITY, session);
    const indices = new Set<string>();
    for (const key of formData.keys()) {
      const match = key.match(/^line_(\d+)_account$/);
      if (match) indices.add(match[1]);
    }
    const lines = [];
    for (const index of [...indices].sort((a, b) => Number(a) - Number(b))) {
      const glAccount = read(`line_${index}_account`);
      const amount = read(`line_${index}_amount`);
      if (!glAccount && !amount) continue;
      const side = read(`line_${index}_side`);
      if (side !== 'S' && side !== 'H') {
        throw new AccrualError(`Line ${Number(index) + 1} has an invalid debit/credit indicator.`, 'Choose Debit or Credit.');
      }
      lines.push({
        glAccount, debitCredit: side as 'S' | 'H', amount,
        costCenter: read(`line_${index}_costCenter`) || undefined,
        profitCenter: read(`line_${index}_profitCenter`) || undefined,
        assignment: read(`line_${index}_assignment`) || undefined,
        lineText: read(`line_${index}_text`) || undefined,
      });
    }
    const result = await postAccrualDocument({
      client: session.user.client, changedBy: session.user.username,
      requestKey: read('requestKey'),
      companyCode: read('companyCode'), documentDate: read('documentDate'),
      postingDate: read('postingDate'), documentType: read('documentType'),
      currency: read('currency'), reference: read('reference') || undefined,
      headerText: read('headerText') || undefined,
      reversalDate: read('reversalDate'), reversalReason: read('reversalReason'),
      lines,
    });
    revalidatePath('/finance/accruals');
    return {
      ok: true,
      message: `Accrual document ${result.displayNumber} posted in fiscal year ${result.fiscalYear}; reversal due ${result.reversalDate}.`,
      documentNumber: result.documentNumber,
    };
  } catch (error) {
    if (error instanceof AccrualError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: (error as { remedy?: string }).remedy };
    }
    console.error('Accrual posting failed', error);
    return { ok: false, message: 'Posting failed. Nothing was saved.', remedy: 'Check the configuration and contact an administrator if the problem persists.' };
  }
}

export async function reverseAccrualAction(formData: FormData): Promise<void> {
  const session = await requireSession('/finance/accruals');
  await requireCapability(ACCRUAL_CAPABILITY, session);
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  await executeAccrualReversal({
    client: session.user.client, changedBy: session.user.username,
    companyCode: read('companyCode'), documentNumber: read('documentNumber'),
    fiscalYear: Number(read('fiscalYear')),
  });
  revalidatePath('/finance/accruals');
}
