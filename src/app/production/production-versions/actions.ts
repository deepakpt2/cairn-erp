'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireCapability } from '@/platform/auth/current';
import {
  PRODUCTION_VERSION_CHANGE_CAPABILITY,
  PRODUCTION_VERSION_CHECK_CAPABILITY,
  PRODUCTION_VERSION_CREATE_CAPABILITY,
  PRODUCTION_VERSION_DELETE_CAPABILITY,
  PRODUCTION_VERSION_LOCK_CAPABILITY,
  PRODUCTION_VERSION_ROUTE,
  ProductionVersionError,
  changeProductionVersion,
  checkProductionVersion,
  copyProductionVersion,
  createProductionVersion,
  deleteProductionVersion,
  lockProductionVersion,
  saveProductionVersionRule,
  type ProductionVersionView,
} from '@/modules/production/production-version';

export interface VersionActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  version?: ProductionVersionView;
}

function fail(error: unknown): VersionActionState {
  if (error instanceof ProductionVersionError) return { ok: false, message: error.message, remedy: error.remedy };
  return { ok: false, message: error instanceof Error ? error.message : 'The production version was not saved.' };
}

function inputOf(session: { user: { client: string; username: string } }, formData: FormData) {
  return {
    client: session.user.client,
    changedBy: session.user.username,
    materialNumber: String(formData.get('materialNumber') ?? ''),
    plant: String(formData.get('plant') ?? ''),
    productionVersion: String(formData.get('productionVersion') ?? ''),
    description: String(formData.get('description') ?? ''),
    validFrom: String(formData.get('validFrom') ?? ''),
    validTo: String(formData.get('validTo') ?? ''),
    lotFrom: String(formData.get('lotFrom') ?? ''),
    lotTo: String(formData.get('lotTo') ?? ''),
    lotUnit: String(formData.get('lotUnit') ?? ''),
    bomUsage: String(formData.get('bomUsage') ?? ''),
    bomAlternative: String(formData.get('bomAlternative') ?? ''),
    taskListType: String(formData.get('taskListType') ?? ''),
    routingGroup: String(formData.get('routingGroup') ?? ''),
    groupCounter: String(formData.get('groupCounter') ?? ''),
    receivingStorageLocation: String(formData.get('receivingStorageLocation') ?? ''),
    changeNumber: String(formData.get('changeNumber') ?? ''),
    version: formData.get('version') ? Number(formData.get('version')) : undefined,
    requestKey: String(formData.get('requestKey') ?? '') || null,
  };
}

export async function saveVersionAction(_previous: VersionActionState, formData: FormData): Promise<VersionActionState> {
  const mode = String(formData.get('mode') ?? 'CREATE');
  const session = await requireCapability(mode === 'CHANGE' ? PRODUCTION_VERSION_CHANGE_CAPABILITY : PRODUCTION_VERSION_CREATE_CAPABILITY);
  try {
    const version = mode === 'CHANGE'
      ? await changeProductionVersion(inputOf(session, formData))
      : await createProductionVersion(inputOf(session, formData));
    const check = version.checkStatus === '1' ? 'The consistency check has no findings.' : 'The consistency check has findings. An error is not treated as valid.';
    return { ok: true, version, message: `Production version ${version.productionVersion} was saved. ${check} A production order was not rewritten.` };
  } catch (error) {
    return fail(error);
  }
}

export async function copyVersionAction(_previous: VersionActionState, formData: FormData): Promise<VersionActionState> {
  const session = await requireCapability(PRODUCTION_VERSION_CREATE_CAPABILITY);
  try {
    const version = await copyProductionVersion({ ...inputOf(session, formData), newProductionVersion: String(formData.get('newProductionVersion') ?? '') });
    return { ok: true, version, message: `Production version ${version.productionVersion} was copied. The source identity and its earlier check were not copied.` };
  } catch (error) {
    return fail(error);
  }
}

function back(formData: FormData, notice: string): never {
  const plant = String(formData.get('plant') ?? '');
  const material = String(formData.get('materialNumber') ?? formData.get('material') ?? '');
  const version = String(formData.get('productionVersion') ?? '');
  revalidatePath(PRODUCTION_VERSION_ROUTE);
  redirect(`${PRODUCTION_VERSION_ROUTE}?plant=${encodeURIComponent(plant)}&material=${encodeURIComponent(material)}&version=${encodeURIComponent(version)}&notice=${encodeURIComponent(notice)}`);
}

export async function checkVersionAction(formData: FormData): Promise<void> {
  const session = await requireCapability(PRODUCTION_VERSION_CHECK_CAPABILITY);
  try {
    const version = await checkProductionVersion(
      session.user.client,
      String(formData.get('materialNumber') ?? ''),
      String(formData.get('plant') ?? ''),
      String(formData.get('productionVersion') ?? ''),
      session.user.username,
    );
    back(formData, `The check is ${version.checkStatus}. A previous result was not reused.`);
  } catch (error) {
    back(formData, error instanceof ProductionVersionError ? error.message : 'The consistency check was not saved.');
  }
}

export async function lockVersionAction(formData: FormData): Promise<void> {
  const session = await requireCapability(PRODUCTION_VERSION_LOCK_CAPABILITY);
  try {
    const version = await lockProductionVersion(
      session.user.client,
      String(formData.get('materialNumber') ?? ''),
      String(formData.get('plant') ?? ''),
      String(formData.get('productionVersion') ?? ''),
      session.user.username,
      String(formData.get('locked') ?? '') === '1',
      Number(formData.get('version') ?? 0),
    );
    back(formData, version.lockIndicator === '1' ? 'The version is locked. It will not be selected.' : 'The version is unlocked.');
  } catch (error) {
    back(formData, error instanceof ProductionVersionError ? error.message : 'The lock was not saved.');
  }
}

export async function deleteVersionAction(formData: FormData): Promise<void> {
  const session = await requireCapability(PRODUCTION_VERSION_DELETE_CAPABILITY);
  try {
    const result = await deleteProductionVersion(
      session.user.client,
      String(formData.get('materialNumber') ?? ''),
      String(formData.get('plant') ?? ''),
      String(formData.get('productionVersion') ?? ''),
      session.user.username,
      Number(formData.get('version') ?? 0),
    );
    back(formData, result.mode === 'DELETED'
      ? 'The unused production version was deleted. The change document remains.'
      : 'A production or planned order exists for this material and plant. The version was marked inactive and was not removed.');
  } catch (error) {
    back(formData, error instanceof ProductionVersionError ? error.message : 'The production version was not deleted.');
  }
}

export async function saveRuleAction(formData: FormData): Promise<void> {
  const session = await requireCapability(PRODUCTION_VERSION_CHANGE_CAPABILITY);
  try {
    await saveProductionVersionRule({
      client: session.user.client,
      changedBy: session.user.username,
      refuseOverlap: String(formData.get('refuseOverlap') ?? ' '),
    });
  } catch (error) {
    const message = error instanceof ProductionVersionError ? error.message : 'The overlap rule was not saved.';
    revalidatePath(PRODUCTION_VERSION_ROUTE);
    redirect(`${PRODUCTION_VERSION_ROUTE}?notice=${encodeURIComponent(message)}`);
  }
  revalidatePath(PRODUCTION_VERSION_ROUTE);
  redirect(`${PRODUCTION_VERSION_ROUTE}?notice=${encodeURIComponent('The overlap rule was saved. It is not a delivered sample. Selection still does not pick the first match.')}`);
}
