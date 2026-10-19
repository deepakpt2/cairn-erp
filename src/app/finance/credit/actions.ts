'use server';

/** FIN.CREDIT.MAINTAIN — authenticate, authorise, save credit data (SCR-103). */
import { redirect } from 'next/navigation';
import { revalidatePath } from 'next/cache';
import { CREDIT_CAPABILITY, CreditError, saveCustomerCredit } from '@/modules/finance/credit';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';

const PATH = '/finance/credit';

export interface CreditState { ok: boolean; message?: string; remedy?: string }

export async function loadCreditAction(formData: FormData): Promise<void> {
  await requireSession(PATH);
  const customer = String(formData.get('customer') ?? '').trim();
  const area = String(formData.get('area') ?? '').trim().toUpperCase();
  redirect(`${PATH}?customer=${encodeURIComponent(customer)}&area=${encodeURIComponent(area)}`);
}

export async function saveCreditAction(_previous: CreditState, formData: FormData): Promise<CreditState> {
  const session = await requireSession(PATH);
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  const customer = read('customer');
  const area = read('area').toUpperCase();
  try {
    await requireCapability(CREDIT_CAPABILITY, session);
    const view = await saveCustomerCredit({
      client: session.user.client, changedBy: session.user.username,
      customer, creditControlArea: area,
      creditLimit: read('creditLimit'), riskCategory: read('riskCategory').toUpperCase(),
      representativeGroup: read('representativeGroup').toUpperCase() || undefined,
      validTo: read('validTo') || undefined,
      customerCreditGroup: read('customerCreditGroup').toUpperCase() || undefined,
      isBlocked: read('isBlocked') === 'true',
      blockReason: read('blockReason').toUpperCase() || undefined,
      changeReason: read('changeReason'),
      expectedVersion: read('version') ? Number(read('version')) : undefined,
    });
    revalidatePath(PATH);
    return {
      ok: true,
      message: `Credit data for ${view.customer} in ${view.creditControlArea} saved (limit ${view.creditLimit.toFixed(2)} ${view.creditCurrency}, version ${view.version}).`,
    };
  } catch (error) {
    if (error instanceof CreditError || error instanceof AuthzError) {
      return { ok: false, message: error.message, remedy: (error as { remedy?: string }).remedy };
    }
    console.error('Credit save failed', error);
    return { ok: false, message: 'The credit change failed. Nothing was saved.', remedy: 'Contact an administrator if the problem persists.' };
  }
}
