'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import { EnqueueError, assertChangeForSession } from '@/platform/lock/enqueue';
import {
  ASSET_CHANGE_CAPABILITY, AssetMasterError, changeAsset,
  changeAssetAssignment, changeAssetDepreciation, deactivateAsset,
} from '@/modules/finance/asset-master';
import type { AssetActionState } from '../new/actions';

const ROUTE = '/finance/assets/change';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

function wrap(error: unknown): AssetActionState {
  if (error instanceof AssetMasterError || error instanceof EnqueueError) return { ok: false, message: error.message, remedy: error.remedy };
  throw error;
}

async function guard(form: FormData) {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_CHANGE_CAPABILITY)) return null;
  const companyCode = text(form, 'companyCode');
  const assetNumber = text(form, 'assetNumber');
  const subNumber = text(form, 'subNumber') || '0000';
  await assertChangeForSession(session, {
    lockObject: 'ASSET',
    argument: `${companyCode}/${assetNumber}/${subNumber}`,
  });
  return {
    client: session.user.client, changedBy: session.user.username,
    companyCode: text(form, 'companyCode'), assetNumber: text(form, 'assetNumber'),
    subNumber: text(form, 'subNumber') || '0000',
    expectedVersion: Number(text(form, 'version')),
  };
}

export async function changeAction(_previous: AssetActionState, form: FormData): Promise<AssetActionState> {
  try {
    const base = await guard(form);
    if (!base) return { ok: false, message: 'You do not hold the asset change capability.' };
    const result = await changeAsset({
      ...base,
      description1: text(form, 'description1'),
      description2: text(form, 'description2') || null,
      inventoryNumber: text(form, 'inventoryNumber') || null,
      serialNumber: text(form, 'serialNumber') || null,
      capitalizationDate: text(form, 'capitalizationDate') || null,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Asset ${result.assetNumber}/${result.subNumber} saved (version ${result.version}).` };
  } catch (error) {
    return wrap(error);
  }
}

export async function assignmentAction(_previous: AssetActionState, form: FormData): Promise<AssetActionState> {
  try {
    const base = await guard(form);
    if (!base) return { ok: false, message: 'You do not hold the asset change capability.' };
    const result = await changeAssetAssignment({
      ...base,
      assignment: {
        validFrom: text(form, 'validFrom'),
        costCenter: text(form, 'costCenter') || undefined,
        profitCenter: text(form, 'profitCenter') || undefined,
        plant: text(form, 'plant') || undefined,
        location: text(form, 'location') || undefined,
      },
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Assignment appended from ${text(form, 'validFrom')}; the earlier interval stands closed, history preserved (version ${result.version}).` };
  } catch (error) {
    return wrap(error);
  }
}

export async function depreciationAction(_previous: AssetActionState, form: FormData): Promise<AssetActionState> {
  try {
    const base = await guard(form);
    if (!base) return { ok: false, message: 'You do not hold the asset change capability.' };
    const result = await changeAssetDepreciation({
      ...base,
      depreciation: {
        areaCode: text(form, 'areaCode'), depreciationKey: text(form, 'depreciationKey'),
        usefulLifeYears: Number(text(form, 'usefulLifeYears')),
        usefulLifePeriods: Number(text(form, 'usefulLifePeriods')),
        depreciationStartDate: text(form, 'depreciationStartDate') || undefined,
      },
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Depreciation parameters saved prospectively for area ${text(form, 'areaCode')} (version ${result.version}); no posted value was touched.` };
  } catch (error) {
    return wrap(error);
  }
}

export async function deactivateAction(_previous: AssetActionState, form: FormData): Promise<AssetActionState> {
  try {
    const base = await guard(form);
    if (!base) return { ok: false, message: 'You do not hold the asset change capability.' };
    const result = await deactivateAsset({
      ...base,
      deactivationDate: text(form, 'deactivationDate'),
      reason: text(form, 'reason') || undefined,
    });
    revalidatePath(ROUTE);
    return { ok: true, message: `Asset ${result.assetNumber}/${result.subNumber} stands DEACTIVATED; no retirement has posted.` };
  } catch (error) {
    return wrap(error);
  }
}
