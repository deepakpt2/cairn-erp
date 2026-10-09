'use server';

/** FIN.JOURNAL.POST — authenticate, authorise, derive configuration, then post. */
import { revalidatePath } from 'next/cache';
import { withTenant } from '@/platform/db/client';
import { postJournalEntry, PostingError, type PostingLineInput } from '@/platform/posting';
import { derivePosition, getCompanyCode, PeriodError } from '@/platform/periods';
import { NumberRangeError } from '@/platform/numbering';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';

export interface PostState {
  ok: boolean;
  message?: string;
  remedy?: string;
  documentNumber?: string;
  displayNumber?: string;
}

export async function postJournalAction(_previous: PostState, formData: FormData): Promise<PostState> {
  // Outside the catch: an unauthenticated request redirects rather than turning
  // the redirect exception into a misleading "posting failed" message.
  const session = await requireSession('/finance/journal/new');
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  try {
    await requireCapability('FIN.JOURNAL.POST', session);
    const client = session.user.client; // Ignore any tenant/actor fields sent by the browser.
    const postingDate = read('postingDate');
    if (!postingDate) throw new PostingError('A posting date is required.', 'Enter the date the document should post to.');
    const indices = new Set<string>();
    for (const key of formData.keys()) {
      const match = key.match(/^line_(\d+)_account$/);
      if (match) indices.add(match[1]);
    }
    const lines: PostingLineInput[] = [];
    for (const index of [...indices].sort((a, b) => Number(a) - Number(b))) {
      const glAccount = read(`line_${index}_account`);
      const amount = read(`line_${index}_amount`);
      if (!glAccount && !amount) continue;
      const side = read(`line_${index}_side`);
      if (side !== 'S' && side !== 'H') throw new PostingError(`Line ${Number(index) + 1} has an invalid debit/credit indicator.`, 'Choose Debit or Credit.');
      lines.push({
        glAccount, debitCredit: side, amount,
        costCenter: read(`line_${index}_costCenter`) || undefined,
        lineText: read(`line_${index}_text`) || undefined,
      });
    }
    const result = await withTenant(client, async (tx) => {
      const companyCode = read('companyCode');
      const company = await getCompanyCode(tx, client, companyCode);
      if (!company?.isActive) throw new PostingError(`Company code ${companyCode} is not active or does not exist.`, 'Choose an active company code in this tenant.');
      const position = await derivePosition(tx, client, company.fiscalYearVariant, postingDate);
      const currency = read('currency') || company.currency;
      if (currency !== company.currency) throw new PostingError('Foreign-currency journal entry is not available on this form yet.', 'Post in the company local currency; exchange-rate selection will be added with currency maintenance.');
      return postJournalEntry(tx, {
        client, companyCode, documentType: read('documentType'),
        documentDate: read('documentDate') || postingDate, postingDate,
        fiscalYear: position.fiscalYear, postingPeriod: position.period,
        currency, localCurrency: company.currency,
        reference: read('reference') || undefined, headerText: read('headerText') || undefined,
        postedBy: session.user.username, transactionCode: 'FIN.JOURNAL.POST', lines,
      });
    });
    revalidatePath('/finance/journal');
    revalidatePath('/config/number-ranges');
    return {
      ok: true,
      message: `Document ${result.displayNumber} posted. Debits ${result.debitTotal}, credits ${result.creditTotal}.`,
      documentNumber: result.documentNumber, displayNumber: result.displayNumber,
    };
  } catch (error) {
    if (error instanceof PostingError || error instanceof PeriodError || error instanceof NumberRangeError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    console.error('Journal posting failed', error);
    return { ok: false, message: 'Posting failed. Nothing was saved.', remedy: 'Check the configuration and contact an administrator if the problem persists.' };
  }
}
