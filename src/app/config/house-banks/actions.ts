'use server';

/**
 * Capability-protected FI12 definition actions (SCR-037).
 *
 * The tenant and the actor come from the session, never from the form. The
 * bank reference arrives as one "COUNTRY/KEY" value because the form offers
 * it as one choice from the bank master; the service still receives the two
 * halves separately, the way it stores and validates them.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  ACTIVITY,
  HouseBankError,
  deleteBankAccount,
  deleteHouseBank,
  saveBankAccount,
  saveHouseBank,
} from '@/modules/foundation/house-bank-definition';

const ROUTE = '/config/house-banks';

export interface HouseBankActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateHouseBankRoutes() {
  revalidatePath(ROUTE);
  revalidatePath('/config/banks');
  revalidatePath('/config');
}

function mapHouseBankError(error: unknown): HouseBankActionState {
  if (error instanceof HouseBankError) {
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
    message: t('houseBank.unexpected'),
    remedy: t('houseBank.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

/** The master choice arrives as one "COUNTRY/KEY" string; stored as two. */
function readBank(form: FormData): { bankCountry: string; bankKey: string } {
  const [bankCountry = '', ...rest] = read(form, 'bank').split('/');
  return { bankCountry, bankKey: rest.join('/') };
}

export async function saveHouseBankAction(
  _previous: HouseBankActionState,
  form: FormData,
): Promise<HouseBankActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    const result = await saveHouseBank({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      companyCode: read(form, 'companyCode'),
      houseBankKey: read(form, 'houseBankKey'),
      ...readBank(form),
      reason: read(form, 'reason'),
    });

    revalidateHouseBankRoutes();

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: t('houseBank.created', { key: result.houseBankKey, company: result.companyCode }),
      };
    }
    if (!result.changed) {
      return {
        ok: true,
        message: t('houseBank.unchanged', { key: result.houseBankKey, company: result.companyCode }),
      };
    }
    return {
      ok: true,
      message: t('houseBank.changed', { key: result.houseBankKey, company: result.companyCode }),
      remedy: result.accounts > 0
        ? t('houseBank.changeAccountsNote', { count: String(result.accounts) })
        : undefined,
    };
  } catch (error) {
    return mapHouseBankError(error);
  }
}

export async function deleteHouseBankAction(
  _previous: HouseBankActionState,
  form: FormData,
): Promise<HouseBankActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const companyCode = read(form, 'companyCode');
    const houseBankKey = read(form, 'houseBankKey');

    await deleteHouseBank({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode,
      houseBankKey,
      reason: read(form, 'reason'),
    });

    revalidateHouseBankRoutes();

    return {
      ok: true,
      message: t('houseBank.deleted', { key: houseBankKey, company: companyCode }),
    };
  } catch (error) {
    return mapHouseBankError(error);
  }
}

export async function saveBankAccountAction(
  _previous: HouseBankActionState,
  form: FormData,
): Promise<HouseBankActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    const result = await saveBankAccount({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      companyCode: read(form, 'companyCode'),
      houseBankKey: read(form, 'houseBankKey'),
      accountId: read(form, 'accountId'),
      accountNumber: read(form, 'accountNumber'),
      iban: read(form, 'iban'),
      currency: read(form, 'currency'),
      glAccount: read(form, 'glAccount'),
      reason: read(form, 'reason'),
    });

    revalidateHouseBankRoutes();

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: t('houseBank.accountCreated', { account: result.accountId, key: result.houseBankKey }),
      };
    }
    if (!result.changed) {
      return {
        ok: true,
        message: t('houseBank.accountUnchanged', { account: result.accountId, key: result.houseBankKey }),
      };
    }
    return {
      ok: true,
      message: t('houseBank.accountChanged', { account: result.accountId, key: result.houseBankKey }),
    };
  } catch (error) {
    return mapHouseBankError(error);
  }
}

export async function deleteBankAccountAction(
  _previous: HouseBankActionState,
  form: FormData,
): Promise<HouseBankActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(ACTIVITY, session);

    const houseBankKey = read(form, 'houseBankKey');
    const accountId = read(form, 'accountId');

    await deleteBankAccount({
      client: session.user.client,
      changedBy: session.user.username,
      companyCode: read(form, 'companyCode'),
      houseBankKey,
      accountId,
      reason: read(form, 'reason'),
    });

    revalidateHouseBankRoutes();

    return {
      ok: true,
      message: t('houseBank.accountDeleted', { account: accountId, key: houseBankKey }),
    };
  } catch (error) {
    return mapHouseBankError(error);
  }
}
