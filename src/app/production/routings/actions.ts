'use server';

import { requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ROUTING_CHANGE_CAPABILITY,
  ROUTING_CREATE_CAPABILITY,
  ROUTING_LOCK,
  RoutingError,
  changeRouting,
  createRouting,
  saveRoutingControlKey,
  saveRoutingStandardValueKey,
  saveRoutingStatus,
  saveRoutingTaskListType,
  saveRoutingUsage,
  type RoutingOperationInput,
  type RoutingView,
} from '@/modules/production/routing';

export interface RoutingActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  warnings?: string[];
  routing?: RoutingView;
}

function fail(error: unknown): RoutingActionState {
  if (error instanceof RoutingError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  return { ok: false, message: error instanceof Error ? error.message : 'The routing was not saved.' };
}

export async function saveTaskListTypeAction(_previous: RoutingActionState, formData: FormData): Promise<RoutingActionState> {
  const session = await requireCapability(ROUTING_CREATE_CAPABILITY);
  try {
    await saveRoutingTaskListType({
      client: session.user.client,
      changedBy: session.user.username,
      taskListType: String(formData.get('taskListType') ?? ''),
      description: String(formData.get('description') ?? ''),
      requireControlKey: String(formData.get('requireControlKey') ?? ' '),
    });
    return { ok: true, message: 'The task list type was saved. No type is delivered.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveUsageAction(_previous: RoutingActionState, formData: FormData): Promise<RoutingActionState> {
  const session = await requireCapability(ROUTING_CREATE_CAPABILITY);
  try {
    await saveRoutingUsage({
      client: session.user.client,
      changedBy: session.user.username,
      usage: String(formData.get('usage') ?? ''),
      description: String(formData.get('description') ?? ''),
    });
    return { ok: true, message: 'The usage was saved. No usage is delivered.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveStatusAction(_previous: RoutingActionState, formData: FormData): Promise<RoutingActionState> {
  const session = await requireCapability(ROUTING_CREATE_CAPABILITY);
  try {
    await saveRoutingStatus({
      client: session.user.client,
      changedBy: session.user.username,
      status: String(formData.get('status') ?? ''),
      description: String(formData.get('description') ?? ''),
      releasedForScheduling: String(formData.get('releasedForScheduling') ?? ' '),
      releasedForCosting: String(formData.get('releasedForCosting') ?? ' '),
      releasedForOrders: String(formData.get('releasedForOrders') ?? ' '),
    });
    return { ok: true, message: 'The status was saved. A release flag is stored. It does not schedule or cost.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveControlKeyAction(_previous: RoutingActionState, formData: FormData): Promise<RoutingActionState> {
  const session = await requireCapability(ROUTING_CREATE_CAPABILITY);
  try {
    await saveRoutingControlKey({
      client: session.user.client,
      changedBy: session.user.username,
      controlKey: String(formData.get('controlKey') ?? ''),
      description: String(formData.get('description') ?? ''),
      scheduling: String(formData.get('scheduling') ?? ' '),
      costing: String(formData.get('costing') ?? ' '),
      confirmation: String(formData.get('confirmation') ?? ' '),
      externalProcessing: String(formData.get('externalProcessing') ?? ' '),
      requireWorkCenter: String(formData.get('requireWorkCenter') ?? ' '),
    });
    return { ok: true, message: 'The control key was saved. External processing does not create a purchase order.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveStandardValueKeyAction(_previous: RoutingActionState, formData: FormData): Promise<RoutingActionState> {
  const session = await requireCapability(ROUTING_CREATE_CAPABILITY);
  try {
    const parameters = String(formData.get('parameters') ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [parameter, description, unit, required] = line.split('|');
      return { parameter: parameter ?? '', description: description ?? '', unit: unit ?? '', required: required ?? ' ' };
    });
    await saveRoutingStandardValueKey({
      client: session.user.client,
      changedBy: session.user.username,
      standardValueKey: String(formData.get('standardValueKey') ?? ''),
      description: String(formData.get('description') ?? ''),
      parameters,
    });
    return { ok: true, message: 'The standard value key was saved. Setup, machine, and labor are not fixed columns.' };
  } catch (error) {
    return fail(error);
  }
}

function operationsOf(formData: FormData): RoutingOperationInput[] {
  const rows = String(formData.get('operations') ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return rows.map((line) => {
    const [operationNumber, shortText, workCenter, controlKey, standardValueKey, values, allocations, executionOrder] = line.split('|');
    return {
      operationNumber,
      shortText,
      workCenter,
      controlKey,
      standardValueKey,
      ...(executionOrder?.trim() ? { executionOrder: executionOrder.trim() } : {}),
      values: (values ?? '').split(';').filter(Boolean).map((part) => {
        const [parameter, quantity, unit] = part.split(',');
        return { parameter: parameter ?? '', quantity: quantity ?? '', unit };
      }),
      allocations: (allocations ?? '').split(';').filter(Boolean).map((part) => {
        const [materialNumber, bomUsage, alternative, itemNumber, quantity] = part.split(',');
        return { materialNumber: materialNumber ?? '', bomUsage: bomUsage ?? '', alternative: alternative ?? '', itemNumber: itemNumber ?? '', quantity };
      }),
    };
  });
}

/**
 * The change lock the routing screen took on the group counter it opened. The argument carries the
 * task list type, group and counter the write itself is keyed on, so the lock and the routing cannot
 * be pointed at different rows; ownership comes from the `enqueue` row, not from the form.
 */
function routingLockInput(formData: FormData) {
  const read = (name: string) => String(formData.get(name) ?? '');
  return {
    lockObject: ROUTING_LOCK,
    argument: `${read('taskListType')}/${read('routingGroup')}/${read('groupCounter')}`,
  };
}

export async function saveRoutingAction(_previous: RoutingActionState, formData: FormData): Promise<RoutingActionState> {
  const mode = String(formData.get('mode') ?? 'CREATE');
  const session = await requireCapability(mode === 'CHANGE' ? ROUTING_CHANGE_CAPABILITY : ROUTING_CREATE_CAPABILITY);
  const assignments = String(formData.get('assignments') ?? '').split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const [materialNumber, plant] = line.split('|');
    return { materialNumber: materialNumber ?? '', plant };
  });
  try {
    // Creating a routing takes no lock; changing one that is already open elsewhere does not go through.
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, routingLockInput(formData));
    }
    const input = {
      client: session.user.client,
      changedBy: session.user.username,
      taskListType: String(formData.get('taskListType') ?? ''),
      routingGroup: String(formData.get('routingGroup') ?? ''),
      groupCounter: String(formData.get('groupCounter') ?? ''),
      plant: String(formData.get('plant') ?? ''),
      description: String(formData.get('description') ?? ''),
      usage: String(formData.get('usage') ?? ''),
      status: String(formData.get('status') ?? ''),
      baseQuantity: String(formData.get('baseQuantity') ?? ''),
      baseUnit: String(formData.get('baseUnit') ?? ''),
      lotFrom: String(formData.get('lotFrom') ?? ''),
      lotTo: String(formData.get('lotTo') ?? ''),
      validFrom: String(formData.get('validFrom') ?? ''),
      validTo: String(formData.get('validTo') ?? ''),
      deletionFlag: String(formData.get('deletionFlag') ?? ' '),
      changeNumber: String(formData.get('changeNumber') ?? ''),
      assignments,
      operations: operationsOf(formData),
      version: formData.get('version') ? Number(formData.get('version')) : undefined,
      requestKey: String(formData.get('requestKey') ?? '') || null,
    };
    const routing = mode === 'CHANGE' ? await changeRouting(input) : await createRouting(input);
    return {
      ok: true,
      routing,
      warnings: routing.warnings,
      message: mode === 'CHANGE'
        ? `Routing ${routing.routingGroup}/${routing.groupCounter} was changed. A production order was not rewritten.`
        : `Routing ${routing.routingGroup}/${routing.groupCounter} was created. No formula was calculated.`,
    };
  } catch (error) {
    return fail(error);
  }
}
