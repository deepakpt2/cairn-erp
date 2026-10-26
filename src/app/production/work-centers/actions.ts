'use server';

import { requireCapability } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  WORK_CENTER_CHANGE_CAPABILITY,
  WORK_CENTER_CREATE_CAPABILITY,
  WORK_CENTER_LOCK,
  WorkCenterError,
  changeWorkCenter,
  createWorkCenter,
  saveWorkCenterCategory,
  type WorkCenterCapacityInput,
  type WorkCenterCostingInput,
  type WorkCenterView,
} from '@/modules/production/work-center';

export interface WorkCenterActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  workCenter?: WorkCenterView;
}

function fail(error: unknown): WorkCenterActionState {
  if (error instanceof WorkCenterError || error instanceof EnqueueError) {
    return { ok: false, message: error.message, remedy: error.remedy };
  }
  return { ok: false, message: error instanceof Error ? error.message : 'The work center was not saved.' };
}

export async function saveCategoryAction(
  _previous: WorkCenterActionState,
  formData: FormData,
): Promise<WorkCenterActionState> {
  const session = await requireCapability(WORK_CENTER_CREATE_CAPABILITY);
  try {
    await saveWorkCenterCategory({
      client: session.user.client,
      changedBy: session.user.username,
      category: String(formData.get('category') ?? ''),
      description: String(formData.get('description') ?? ''),
      requireCapacity: formData.get('requireCapacity') === 'X',
      requireScheduling: formData.get('requireScheduling') === 'X',
      requireCosting: formData.get('requireCosting') === 'X',
      requireStandardValueKey: formData.get('requireStandardValueKey') === 'X',
      version: formData.get('version') ? Number(formData.get('version')) : undefined,
    });
    return { ok: true, message: 'The category was saved. It is not a delivered category list.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveWorkCenterAction(
  _previous: WorkCenterActionState,
  formData: FormData,
): Promise<WorkCenterActionState> {
  const mode = String(formData.get('mode') ?? 'CREATE');
  const session = await requireCapability(mode === 'CHANGE' ? WORK_CENTER_CHANGE_CAPABILITY : WORK_CENTER_CREATE_CAPABILITY);
  let capacities: WorkCenterCapacityInput[] = [];
  let costing: WorkCenterCostingInput[] = [];
  try {
    capacities = JSON.parse(String(formData.get('capacities') ?? '[]')) as WorkCenterCapacityInput[];
    costing = JSON.parse(String(formData.get('costing') ?? '[]')) as WorkCenterCostingInput[];
  } catch {
    return { ok: false, message: 'The capacity or costing lines could not be read. Nothing was saved.' };
  }
  const copyPlant = String(formData.get('copyPlant') ?? '').trim();
  const copyCenter = String(formData.get('copyCenter') ?? '').trim();
  const input = {
    client: session.user.client,
    changedBy: session.user.username,
    plant: String(formData.get('plant') ?? ''),
    workCenter: String(formData.get('workCenter') ?? ''),
    category: String(formData.get('category') ?? ''),
    description: String(formData.get('description') ?? ''),
    personResponsible: String(formData.get('personResponsible') ?? '') || null,
    location: String(formData.get('location') ?? '') || null,
    usage: String(formData.get('usage') ?? '') || null,
    standardValueKey: String(formData.get('standardValueKey') ?? '') || null,
    controlKey: String(formData.get('controlKey') ?? '') || null,
    deletionFlag: String(formData.get('deletionFlag') ?? ' '),
    schedulingCapacityCategory: String(formData.get('schedulingCapacityCategory') ?? '') || null,
    schedulingSetupFormula: String(formData.get('schedulingSetupFormula') ?? '') || null,
    schedulingProcessingFormula: String(formData.get('schedulingProcessingFormula') ?? '') || null,
    schedulingTeardownFormula: String(formData.get('schedulingTeardownFormula') ?? '') || null,
    capacities,
    costing,
    version: formData.get('version') ? Number(formData.get('version')) : undefined,
    copyFrom: copyPlant && copyCenter
      ? { plant: copyPlant, workCenter: copyCenter, copyChildren: formData.get('copyChildren') === 'X' }
      : null,
  };
  try {
    // The work center screen holds a change lock on the centre it opened, and a centre is edited in
    // one write, so that lock is what decides here: the session it was granted to, on the same
    // plant and centre the screen locked and this write is keyed on. Creating is not under it, and
    // the category master has none.
    if (mode === 'CHANGE') {
      await assertChangeForSession(session, {
        lockObject: WORK_CENTER_LOCK,
        argument: `${input.plant}/${input.workCenter}`,
      });
    }
    const saved = mode === 'CHANGE' ? await changeWorkCenter(input) : await createWorkCenter(input);
    return {
      ok: true,
      workCenter: saved,
      message: `Work center ${saved.workCenter} in plant ${saved.plant} was saved. No routing was created, and no formula was calculated.`,
    };
  } catch (error) {
    return fail(error);
  }
}
