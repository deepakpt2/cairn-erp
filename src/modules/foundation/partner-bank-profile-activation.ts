/** Capability-checked activation boundary for the global partner-bank profile registry. */
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import {
  hasCapability,
  type SessionContext,
} from '../../platform/auth/session';
import { withTenant, type Tx } from '../../platform/db/client';
import {
  PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY,
  PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE,
  validatePartnerBankProfileActivationCommand,
  type PartnerBankProfileActivationError,
} from '../../platform/security/partner-bank-profile-activation';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DATABASE_OUTCOMES = new Set([
  'ACTIVATED',
  'INPUT_INVALID',
  'EVIDENCE_INVALID',
  'PROFILE_UNAVAILABLE',
  'POLICY_REVISION_MISMATCH',
  'PROFILE_ALREADY_READY',
  'VERSION_MISMATCH',
  'VERSION_EXHAUSTED',
  'UPDATE_CONFLICT',
]);

export interface PartnerBankProfileActivationDatabaseInput {
  eventId: string;
  actorClient: string;
  actorUserId: string;
  country: string;
  expectedPolicyRevision: string;
  expectedVersion: number;
  evidenceCode: typeof PARTNER_BANK_PROFILE_ACTIVATION_EVIDENCE;
}

export type PartnerBankProfileActivationDatabaseExecutor = (
  input: PartnerBankProfileActivationDatabaseInput,
) => Promise<unknown>;

export type PartnerBankProfileActivationFailureCode =
  | 'UNAUTHENTICATED'
  | 'CAPABILITY_DENIED'
  | 'ACTOR_INVALID'
  | 'EVENT_ID_INVALID'
  | PartnerBankProfileActivationError
  | 'PROFILE_ALREADY_READY'
  | 'VERSION_MISMATCH'
  | 'VERSION_EXHAUSTED'
  | 'UPDATE_CONFLICT'
  | 'DATABASE_RESULT_INVALID';

export type PartnerBankProfileActivationResult =
  | {
      ok: true;
      code: 'ACTIVATED';
      eventId: string;
      country: string;
      policyRevision: string;
      version: number;
    }
  | { ok: false; code: PartnerBankProfileActivationFailureCode; errors?: PartnerBankProfileActivationError[] };

async function callAtomicActivationFunction(
  tx: Tx,
  input: PartnerBankProfileActivationDatabaseInput,
): Promise<unknown> {
  const rows = (await tx.execute(sql`
    select public.cairn_activate_partner_bank_profile(
      ${input.eventId}::uuid,
      ${input.actorClient}::varchar,
      ${input.actorUserId}::uuid,
      ${input.country}::varchar,
      ${input.expectedPolicyRevision}::varchar,
      ${input.expectedVersion}::integer,
      ${input.evidenceCode}::varchar
    ) as outcome
  `)) as unknown as Array<{ outcome: unknown }>;
  return rows[0]?.outcome;
}

const executeActivationInDatabase: PartnerBankProfileActivationDatabaseExecutor = (input) =>
  withTenant(input.actorClient, (tx) => callAtomicActivationFunction(tx, input));

export function createPartnerBankProfileActivationService(
  execute: PartnerBankProfileActivationDatabaseExecutor,
  createEventId: () => string = randomUUID,
) {
  return async function activatePartnerBankProfile(
    session: SessionContext | null,
    commandInput: unknown,
  ): Promise<PartnerBankProfileActivationResult> {
    if (!session) return { ok: false, code: 'UNAUTHENTICATED' };
    if (!hasCapability(session.user.capabilities, PARTNER_BANK_PROFILE_ACTIVATE_CAPABILITY)) {
      return { ok: false, code: 'CAPABILITY_DENIED' };
    }

    const validation = validatePartnerBankProfileActivationCommand(commandInput);
    if (!validation.valid) {
      return { ok: false, code: validation.errors[0], errors: validation.errors };
    }

    const actorClient = session.user.client;
    const actorUserId = session.user.userId;
    if (!/^[A-Za-z0-9]{2,4}$/.test(actorClient) || !UUID_V4.test(actorUserId)) {
      return { ok: false, code: 'ACTOR_INVALID' };
    }

    const eventId = createEventId();
    if (!UUID_V4.test(eventId)) return { ok: false, code: 'EVENT_ID_INVALID' };

    const { country, policyRevision, expectedVersion, evidenceCode } = validation.command;
    const outcome = await execute({
      eventId,
      actorClient,
      actorUserId,
      country,
      expectedPolicyRevision: policyRevision,
      expectedVersion,
      evidenceCode,
    });

    if (typeof outcome !== 'string' || !DATABASE_OUTCOMES.has(outcome)) {
      return { ok: false, code: 'DATABASE_RESULT_INVALID' };
    }
    if (outcome !== 'ACTIVATED') return { ok: false, code: outcome as PartnerBankProfileActivationFailureCode };

    return {
      ok: true,
      code: 'ACTIVATED',
      eventId,
      country,
      policyRevision,
      version: expectedVersion + 1,
    };
  };
}

export const activatePartnerBankProfile = createPartnerBankProfileActivationService(
  executeActivationInDatabase,
);
