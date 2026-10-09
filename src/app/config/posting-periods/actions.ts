'use server';

/** Posting controls are authorised at the write boundary, not just the page. */
import { revalidatePath } from 'next/cache';
import { updatePeriodRule, ConfigError } from '@/modules/foundation/services';
import { requireCapability, requireSession, AuthzError } from '@/platform/auth/current';
import { t } from '@/platform/i18n';

export async function savePeriodRule(formData: FormData): Promise<{ ok: boolean; message?: string }> {
  const session = await requireSession('/config/posting-periods');
  const read = (name: string) => String(formData.get(name) ?? '').trim();
  try {
    await requireCapability('FIN.CLOSE.PERIOD', session);
    await updatePeriodRule({
      client: session.user.client,
      variant: read('variant'),
      accountType: read('accountType') as 'S' | 'K' | 'D' | 'A' | 'M',
      periodFrom: Number(read('periodFrom')),
      periodTo: Number(read('periodTo')),
      allowSpecialPeriods: formData.get('allowSpecialPeriods') === 'on',
      changedBy: session.user.username,
    });
    revalidatePath('/config/posting-periods');
    return { ok: true, message: t('pp.saved') };
  } catch (error) {
    if (error instanceof ConfigError || error instanceof AuthzError) {
      return { ok: false, message: `${error.message} ${error.remedy}` };
    }
    throw error;
  }
}
