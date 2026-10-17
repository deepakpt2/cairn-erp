'use server';

/**
 * Capability-protected OB08 maintenance actions (SCR-034).
 *
 * The tenant and the actor come from the session, never from the form. `expectedRate`
 * does come from the form, and that is the point: it is the rate the operator was
 * looking at, so a correction that was already stale when it arrived is refused
 * instead of overwriting somebody else's.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  ExchangeRateError,
  deleteExchangeRate,
  saveExchangeRate,
} from '@/modules/foundation/exchange-rate-maintenance';

const ROUTE = '/config/exchange-rates';

export interface ExchangeRateActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateRateRoutes() {
  // A rate decides what future postings translate at, so every screen that reads a
  // Company Code's currency picture is re-read rather than shown from cache.
  revalidatePath(ROUTE);
  revalidatePath('/config/company-codes');
  revalidatePath('/config');
}

function mapRateError(error: unknown): ExchangeRateActionState {
  if (error instanceof ExchangeRateError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  if (error instanceof AuthzError) {
    return {
      ok: false,
      message: t('auth.missingAuthority', { authority: error.capability }),
      remedy: t('auth.readOnly', { authority: error.capability }),
    };
  }
  return {
    ok: false,
    message: t('exRate.unexpected'),
    remedy: t('exRate.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

const typeLabel = (rateType: string) => t(`exRate.type.${rateType}`);

export async function saveExchangeRateAction(
  _previous: ExchangeRateActionState,
  form: FormData,
): Promise<ExchangeRateActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    const result = await saveExchangeRate({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      rateType: read(form, 'rateType'),
      fromCurrency: read(form, 'fromCurrency'),
      toCurrency: read(form, 'toCurrency'),
      validFrom: read(form, 'validFrom'),
      rate: read(form, 'rate'),
      ratioFrom: read(form, 'ratioFrom') === '' ? 1 : Number(read(form, 'ratioFrom')),
      ratioTo: read(form, 'ratioTo') === '' ? 1 : Number(read(form, 'ratioTo')),
      expectedRate: read(form, 'expectedRate'),
      reason: read(form, 'reason'),
    });

    revalidateRateRoutes();

    const pair = `${result.fromCurrency} → ${result.toCurrency}`;
    if (mode === 'CREATE') {
      return {
        ok: true,
        message: t('exRate.created', {
          type: typeLabel(result.rateType),
          pair,
          from: result.validFrom,
          rate: result.rate,
        }),
      };
    }
    if (!result.changed) {
      return {
        ok: true,
        message: t('exRate.unchanged', { type: typeLabel(result.rateType), pair, from: result.validFrom }),
      };
    }
    return {
      ok: true,
      message: t('exRate.changed', {
        type: typeLabel(result.rateType),
        pair,
        from: result.validFrom,
        rate: result.rate,
      }),
    };
  } catch (error) {
    return mapRateError(error);
  }
}

export async function deleteExchangeRateAction(
  _previous: ExchangeRateActionState,
  form: FormData,
): Promise<ExchangeRateActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const rateType = read(form, 'rateType');
    const fromCurrency = read(form, 'fromCurrency');
    const toCurrency = read(form, 'toCurrency');
    const validFrom = read(form, 'validFrom');

    await deleteExchangeRate({
      client: session.user.client,
      changedBy: session.user.username,
      rateType,
      fromCurrency,
      toCurrency,
      validFrom,
      reason: read(form, 'reason'),
    });

    revalidateRateRoutes();

    return {
      ok: true,
      message: t('exRate.deleted', {
        type: typeLabel(rateType.toUpperCase()),
        pair: `${fromCurrency} → ${toCurrency}`,
        from: validFrom,
      }),
    };
  } catch (error) {
    return mapRateError(error);
  }
}
