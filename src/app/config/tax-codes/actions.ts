'use server';

/**
 * Capability-protected FTXP definition actions (SCR-035).
 *
 * The tenant and the actor come from the session, never from the form. `expectedRate`
 * does come from the form, and that is the point: it is the rate the operator was
 * looking at, so a change that was already stale when it arrived is refused instead
 * of overwriting somebody else's correction.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ACTIVITY,
  TaxCodeError,
  deleteTaxCode,
  saveTaxCode,
} from '@/modules/foundation/tax-code-definition';

const ROUTE = '/config/tax-codes';

export interface TaxCodeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateTaxRoutes() {
  revalidatePath(ROUTE);
  revalidatePath('/config/company-codes');
  revalidatePath('/config');
}

function mapTaxError(error: unknown): TaxCodeActionState {
  if (error instanceof TaxCodeError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('auth.missingAuthority', { authority: error.capability }),
      remedy: t('auth.readOnly', { authority: error.capability }),
    };
  }
  return {
    ok: false,
    message: t('taxCode.unexpected'),
    remedy: t('taxCode.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

export async function saveTaxCodeAction(
  _previous: TaxCodeActionState,
  form: FormData,
): Promise<TaxCodeActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, { lockObject: 'TAX_CODE', argument: `${read(form, 'country')}/${read(form, 'taxCode')}` });
    }
    const result = await saveTaxCode({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      country: read(form, 'country'),
      taxCode: read(form, 'taxCode'),
      name: read(form, 'name'),
      taxType: read(form, 'taxType'),
      ratePercent: read(form, 'ratePercent'),
      accountKey: read(form, 'accountKey'),
      expectedRate: read(form, 'expectedRate'),
      reason: read(form, 'reason'),
    });

    revalidateTaxRoutes();

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: t('taxCode.created', {
          code: result.taxCode,
          country: result.country,
          rate: result.ratePercent,
        }),
      };
    }
    if (!result.changed) {
      return {
        ok: true,
        message: t('taxCode.unchanged', { code: result.taxCode, country: result.country }),
      };
    }
    return {
      ok: true,
      message: t('taxCode.changed', {
        code: result.taxCode,
        country: result.country,
        rate: result.ratePercent,
      }),
      // The exposure the reason had to cover, said back to the operator rather than only filed.
      remedy: result.usedByLines > 0
        ? t('taxCode.changeUsedNote', { count: String(result.usedByLines) })
        : undefined,
    };
  } catch (error) {
    return mapTaxError(error);
  }
}

export async function deleteTaxCodeAction(
  _previous: TaxCodeActionState,
  form: FormData,
): Promise<TaxCodeActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const country = read(form, 'country');
    const code = read(form, 'taxCode');
    await assertChangeForSession(session, { lockObject: 'TAX_CODE', argument: `${country}/${code}` });

    await deleteTaxCode({
      client: session.user.client,
      changedBy: session.user.username,
      country,
      taxCode: code,
      reason: read(form, 'reason'),
    });

    revalidateTaxRoutes();

    return {
      ok: true,
      message: t('taxCode.deleted', { code, country }),
    };
  } catch (error) {
    return mapTaxError(error);
  }
}
