'use server';

/** FIN.JOURNAL.POST — authenticate, authorise, then post through the judged G/L document service (SCR-096). */
import { revalidatePath } from 'next/cache';
import { postGlDocument, GlDocumentError, GL_DOCUMENT_CAPABILITY } from '@/modules/finance/gl-document';
import { PostingError } from '@/platform/posting';
import { PeriodError } from '@/platform/periods';
import { NumberRangeError } from '@/platform/numbering';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';

export interface PostState {
  ok: boolean;
  message?: string;
  remedy?: string;
  documentNumber?: string;
  displayNumber?: string;
  fiscalYear?: number;
}

export async function postJournalAction(_previous: PostState, formData: FormData): Promise<PostState> {
  const session = await requireSession('/finance/journal/new');
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  try {
    await requireCapability(GL_DOCUMENT_CAPABILITY, session);
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
        throw new GlDocumentError(`Line ${Number(index) + 1} has an invalid debit/credit indicator.`, 'Choose Debit or Credit.');
      }
      lines.push({
        glAccount, debitCredit: side as 'S' | 'H', amount,
        costCenter: read(`line_${index}_costCenter`) || undefined,
        profitCenter: read(`line_${index}_profitCenter`) || undefined,
        assignment: read(`line_${index}_assignment`) || undefined,
        lineText: read(`line_${index}_text`) || undefined,
      });
    }
    const result = await postGlDocument({
      client: session.user.client,
      changedBy: session.user.username,
      requestKey: read('requestKey'),
      companyCode: read('companyCode'),
      documentDate: read('documentDate'),
      postingDate: read('postingDate'),
      documentType: read('documentType'),
      currency: read('currency'),
      reference: read('reference') || undefined,
      headerText: read('headerText') || undefined,
      lines,
    });
    revalidatePath('/finance/journal');
    revalidatePath('/config/number-ranges');
    return {
      ok: true,
      message: `Document ${result.displayNumber} posted in fiscal year ${result.fiscalYear}. Debits ${result.debitTotal}, credits ${result.creditTotal}.`,
      documentNumber: result.documentNumber, displayNumber: result.displayNumber,
      fiscalYear: result.fiscalYear,
    };
  } catch (error) {
    if (error instanceof GlDocumentError || error instanceof PostingError || error instanceof PeriodError || error instanceof NumberRangeError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: (error as { remedy?: string }).remedy };
    }
    console.error('Journal posting failed', error);
    return { ok: false, message: 'Posting failed. Nothing was saved.', remedy: 'Check the configuration and contact an administrator if the problem persists.' };
  }
}
