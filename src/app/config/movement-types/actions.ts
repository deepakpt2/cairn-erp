'use server';

import { requireSession } from '@/platform/auth/current';
import {
  MovementTypeConfigError,
  checkMovementType,
  deleteMovementType,
  saveMovementType,
} from '@/modules/inventory/movement-type-configuration';

export interface MovementTypeActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  checked?: string;
  movementType?: string;
  replaceRequestKey?: boolean;
}

const ROUTE = '/config/movement-types';

function read(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
}

function fail(error: unknown): MovementTypeActionState {
  if (error instanceof MovementTypeConfigError) {
    return {
      ok: false,
      message: error.message,
      remedy: error.remedy,
      replaceRequestKey: /request key/i.test(error.message),
    };
  }
  throw error;
}

function refused(form: FormData) {
  return {
    generalLedgerAccount: read(form, 'generalLedgerAccount'),
    companyCode: read(form, 'companyCode'),
    bwart: read(form, 'bwart'),
    status: read(form, 'status'),
    version: read(form, 'version'),
    policyId: read(form, 'policyId'),
    fieldSelectionProfile: read(form, 'fieldSelectionProfile'),
    specialStockIndicator: read(form, 'specialStockIndicator'),
    postingPeriod: read(form, 'postingPeriod'),
    transportRequest: read(form, 'transportRequest'),
    approval: read(form, 'approval'),
    isTwoStep: read(form, 'isTwoStep') === 'on' || read(form, 'isTwoStep') === 'true',
    requiresBatch: read(form, 'requiresBatch') === 'on' || read(form, 'requiresBatch') === 'true',
    requiresSerial: read(form, 'requiresSerial') === 'on' || read(form, 'requiresSerial') === 'true',
    requiresSpecialStock: read(form, 'requiresSpecialStock') === 'on' || read(form, 'requiresSpecialStock') === 'true',
    requiresValuationType: read(form, 'requiresValuationType') === 'on' || read(form, 'requiresValuationType') === 'true',
  };
}

export async function saveMovementTypeAction(
  _previous: MovementTypeActionState,
  form: FormData,
): Promise<MovementTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await saveMovementType({
      client: session.user.client,
      changedBy: session.user.username,
      mode: read(form, 'mode') === 'CHANGE' ? 'CHANGE' : 'CREATE',
      movementType: read(form, 'movementType'),
      description: read(form, 'description'),
      direction: read(form, 'direction'),
      referenceCategory: read(form, 'referenceCategory'),
      reversalMovementType: read(form, 'reversalMovementType'),
      movementKind: read(form, 'movementKind'),
      sourceStockType: read(form, 'sourceStockType'),
      destinationStockType: read(form, 'destinationStockType'),
      plantRule: read(form, 'plantRule'),
      locationRule: read(form, 'locationRule'),
      negativeStockPolicy: read(form, 'negativeStockPolicy'),
      valuationRelevant: read(form, 'valuationRelevant') === 'on',
      inventoryEvent: read(form, 'inventoryEvent'),
      offsetEvent: read(form, 'offsetEvent'),
      offsetModifier: read(form, 'offsetModifier'),
      accountAssignment: read(form, 'accountAssignment'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
      ...refused(form),
    });
    const verb = result.replayed ? 'already stood' : result.changed ? 'saved' : 'is unchanged';
    return { ok: true, movementType: result.movementType, message: `Movement type ${result.movementType} ${verb}.` };
  } catch (error) {
    return fail(error);
  }
}

export async function checkMovementTypeAction(
  _previous: MovementTypeActionState,
  form: FormData,
): Promise<MovementTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const row = await checkMovementType(session.user.client, read(form, 'movementType'));
    const cited = row.documentCount + row.reservationCount + row.namedAsReversal.length;
    return {
      ok: true,
      checked: row.movementType,
      message: cited > 0
        ? `Movement type ${row.movementType} stands. Posting rules are frozen: ${row.documentCount} material document line(s), ${row.reservationCount} reservation(s).`
        : `Movement type ${row.movementType} stands and is not yet cited. A check writes nothing.`,
    };
  } catch (error) {
    return fail(error);
  }
}

export async function deleteMovementTypeAction(
  _previous: MovementTypeActionState,
  form: FormData,
): Promise<MovementTypeActionState> {
  const session = await requireSession(ROUTE);
  try {
    const result = await deleteMovementType({
      client: session.user.client,
      changedBy: session.user.username,
      movementType: read(form, 'movementType'),
      reason: read(form, 'reason'),
      requestKey: read(form, 'requestKey'),
    });
    return {
      ok: true,
      message: result.replayed
        ? `Movement type ${result.movementType} was already deleted.`
        : `Movement type ${result.movementType} deleted.`,
    };
  } catch (error) {
    return fail(error);
  }
}
