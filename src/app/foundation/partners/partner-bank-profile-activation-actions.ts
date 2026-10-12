'use server';

import { revalidatePath } from 'next/cache';
import { AuthzError, requireSession } from '@/platform/auth/current';
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
