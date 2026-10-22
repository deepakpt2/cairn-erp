'use server';

import { revalidatePath } from 'next/cache';
import { AuthzError, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import { activatePartnerBankProfile } from '@/modules/foundation/partner-bank-profile-activation';
import {
  PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY,
  PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
} from '@/platform/security/partner-bank-profile-activation';

export interface PartnerBankProfileActivationActionState {
  ok: boolean;
  code?: string;
  message?: string;
  remedy?: string;
  version?: number;
}

function readString(form: FormData, key: string): string | null {
  const value = form.get(key);
  return typeof value === 'string' ? value : null;
}

function readExpectedVersion(form: FormData): number {
  const value = readString(form, 'expectedVersion');
  return value !== null && /^\d+$/.test(value) ? Number(value) : Number.NaN;
}

/** One-way profile activation. Actor identity and fixed evidence are server-derived. */
export async function activatePartnerBankProfileAction(
  _previous: PartnerBankProfileActivationActionState,
  form: FormData,
): Promise<PartnerBankProfileActivationActionState> {
  const session = await requireSession('/foundation/partners');
  try {
    await assertChangeForSession(session, {
      lockObject: 'PARTNER_BANK_PROFILE',
      argument: readString(form, 'country') ?? '',
    });
  } catch (error) {
    if (error instanceof EnqueueError) {
      return { ok: false, message: error.message, remedy: error.remedy };
    }
    throw error;
  }
  const result = await activatePartnerBankProfile(session, {
    country: readString(form, 'country'),
    expectedPolicyRevision: readString(form, 'expectedPolicyRevision'),
    expectedVersion: readExpectedVersion(form),
    evidenceCode: PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
  });

  if (!result.ok) {
    if (result.code === 'CAPABILITY_DENIED') {
      const error = new AuthzError(PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY, session.user.username);
      return { ok: false, code: result.code, message: error.message, remedy: error.remedy };
    }
    return { ok: false, code: result.code };
  }

  revalidatePath('/foundation/partners');
  revalidatePath('/foundation/partners/bank-profiles');
  return { ok: true, code: result.code, version: result.version };
}
