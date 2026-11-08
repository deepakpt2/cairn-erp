'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  RETURNS_CONFIGURATION_ROUTE,
  RETURNS_DEFINE_CAPABILITY,
  ReturnsConfigurationError,
  saveReturnsConfiguration,
} from '@/modules/sales/returns-configuration';

export interface ReturnsConfigurationActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = RETURNS_CONFIGURATION_ROUTE;

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function refuse(error: unknown): ReturnsConfigurationActionState {
  if (error instanceof ReturnsConfigurationError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  throw error;
}

function denied(): ReturnsConfigurationActionState {
  return {
    ok: false,
    message: `You do not hold the authority ${RETURNS_DEFINE_CAPABILITY}.`,
    remedy: 'Ask an administrator for an exact-code role assignment; wildcard role patterns do not grant this authority.',
  };
}

/**
 * Write the chain. The gate precedes the call, as it does on the document types screen: naming which
 * documents a process uses is a configuration act, not a sales one.
 */
export async function saveReturnsConfigurationAction(
  _previous: ReturnsConfigurationActionState,
  form: FormData,
): Promise<ReturnsConfigurationActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, RETURNS_DEFINE_CAPABILITY)) return denied();

  try {
    const { created } = await saveReturnsConfiguration({
      client: session.user.client,
      changedBy: session.user.username,
      returnsOrderType: text(form, 'returnsOrderType'),
      returnsDeliveryType: text(form, 'returnsDeliveryType'),
      complaintType: text(form, 'complaintType'),
      creditMemoType: text(form, 'creditMemoType'),
      receiptMovementType: text(form, 'receiptMovementType'),
    });
    revalidatePath(ROUTE);
    return {
      ok: true,
      message: created
        ? 'The returns chain is configured for this tenant.'
        : 'The returns chain now reads as configured. Documents already created keep the type they were raised with.',
    };
  } catch (error) {
    return refuse(error);
  }
}
