'use server';

/**
 * Capability-protected bank master actions (SCR-036).
 *
 * The tenant and the actor come from the session, never from the form. There is
 * no activity to complete and no change document to file — the bank master is
 * global reference data (R-86), and its audit is the actor the service stamps
 * on the row itself.
 */
import { revalidatePath } from 'next/cache';
import { AuthzError, requireCapability, requireSession } from '@/platform/auth/current';
import { t } from '@/platform/i18n';
import {
  BankMasterError,
  CAPABILITY,
  deleteBank,
  saveBank,
} from '@/modules/foundation/bank-master';

const ROUTE = '/config/banks';

export interface BankActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
}

function revalidateBankRoutes() {
  revalidatePath(ROUTE);
  revalidatePath('/config');
}

function mapBankError(error: unknown): BankActionState {
  if (error instanceof BankMasterError) {
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
    message: t('bank.unexpected'),
    remedy: t('bank.unexpectedRemedy'),
  };
}

const read = (form: FormData, field: string) => String(form.get(field) ?? '').trim();

export async function saveBankAction(
  _previous: BankActionState,
  form: FormData,
): Promise<BankActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(CAPABILITY, session);

    const mode = read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE';
    const result = await saveBank({
      client: session.user.client,
      changedBy: session.user.username,
      mode,
      bankCountry: read(form, 'bankCountry'),
      bankKey: read(form, 'bankKey'),
      name: read(form, 'name'),
      city: read(form, 'city'),
      swift: read(form, 'swift'),
    });

    revalidateBankRoutes();

    if (mode === 'CREATE') {
      return {
        ok: true,
        message: t('bank.created', { key: result.bankKey, country: result.bankCountry }),
      };
    }
    if (!result.changed) {
      return {
        ok: true,
        message: t('bank.unchanged', { key: result.bankKey, country: result.bankCountry }),
      };
    }
    return {
      ok: true,
      message: t('bank.changed', { key: result.bankKey, country: result.bankCountry }),
    };
  } catch (error) {
    return mapBankError(error);
  }
}

export async function deleteBankAction(
  _previous: BankActionState,
  form: FormData,
): Promise<BankActionState> {
  // Keep the redirect outside the catch, so an anonymous request still reaches sign-in.
  const session = await requireSession(ROUTE);

  try {
    await requireCapability(CAPABILITY, session);

    const bankCountry = read(form, 'bankCountry');
    const bankKey = read(form, 'bankKey');

    await deleteBank({
      client: session.user.client,
      changedBy: session.user.username,
      bankCountry,
      bankKey,
    });

    revalidateBankRoutes();

    return {
      ok: true,
      message: t('bank.deleted', { key: bankKey, country: bankCountry }),
    };
  } catch (error) {
    return mapBankError(error);
  }
}
