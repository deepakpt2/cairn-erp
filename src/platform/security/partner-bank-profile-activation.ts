/** Security contract for the controlled partner-bank profile activation action. */
import {
  PARTNER_BANK_PROFILE_POLICIES,
  type PartnerBankProfileAuthoringCountry,
} from './partner-bank-profile-readiness';

export const PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY =
  'CFG.FND.PARTNER.BANKPROFILE.ACTIVATE';

/** Fixed audit evidence code; activation accepts no free-text rationale. */
export const PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE =
  'PROFILE_VALIDATION_ACCEPTED';

export type PartnerBankProfileActivationError =
  | 'INPUT_INVALID'
  | 'UNSUPPORTED_FIELDS'
  | 'COUNTRY_REQUIRED'
  | 'PROFILE_UNAVAILABLE'
  | 'POLICY_REVISION_REQUIRED'
  | 'POLICY_REVISION_MISMATCH'
  | 'VERSION_INVALID'
  | 'EVIDENCE_INVALID';

export type PartnerBankProfileActivationCommandResult =
  | {
      valid: true;
      command: {
        country: PartnerBankProfileAuthoringCountry;
        policyRevision: string;
        expectedVersion: number;
        evidenceCode: typeof PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE;
        targetStatus: 'READY';
      };
    }
  | { valid: false; errors: PartnerBankProfileActivationError[] };

const POLICY_BY_COUNTRY = new Map<string, (typeof PARTNER_BANK_PROFILE_POLICIES)[number]>(
  PARTNER_BANK_PROFILE_POLICIES.map((policy) => [policy.country, policy]),
);
const ALLOWED_FIELDS = new Set(['country', 'expectedPolicyRevision', 'expectedVersion', 'evidenceCode']);
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** Validate the one-way NOT_READY→READY request; no actor or state change is performed here. */
export function validatePartnerBankProfileActivationCommand(
  input: unknown,
): PartnerBankProfileActivationCommandResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { valid: false, errors: ['INPUT_INVALID'] };
  }
  if (Reflect.ownKeys(input).some((key) => typeof key !== 'string' || !ALLOWED_FIELDS.has(key))) {
    return { valid: false, errors: ['UNSUPPORTED_FIELDS'] };
  }

  const command = input as Record<string, unknown>;
  const countryInput = typeof command.country === 'string' ? command.country.trim().toUpperCase() : '';
  if (!countryInput) return { valid: false, errors: ['COUNTRY_REQUIRED'] };

  const policy = POLICY_BY_COUNTRY.get(countryInput);
  if (!policy) return { valid: false, errors: ['PROFILE_UNAVAILABLE'] };

  if (typeof command.expectedPolicyRevision !== 'string' || !command.expectedPolicyRevision.trim()) {
    return { valid: false, errors: ['POLICY_REVISION_REQUIRED'] };
  }
  if (command.expectedPolicyRevision !== policy.policyRevision) {
    return { valid: false, errors: ['POLICY_REVISION_MISMATCH'] };
  }

  if (
    typeof command.expectedVersion !== 'number' ||
    !Number.isSafeInteger(command.expectedVersion) ||
    command.expectedVersion < 1 ||
    command.expectedVersion > POSTGRES_INTEGER_MAX
  ) {
    return { valid: false, errors: ['VERSION_INVALID'] };
  }

  if (command.evidenceCode !== PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE) {
    return { valid: false, errors: ['EVIDENCE_INVALID'] };
  }

  return {
    valid: true,
    command: {
      country: policy.country,
      policyRevision: policy.policyRevision,
      expectedVersion: command.expectedVersion,
      evidenceCode: PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
      targetStatus: 'READY',
    },
  };
}
