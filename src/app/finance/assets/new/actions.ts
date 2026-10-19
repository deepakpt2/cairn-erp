'use server';

import { revalidatePath } from 'next/cache';

import { can, requireSession } from '@/platform/auth/current';
import {
  ASSET_CREATE_CAPABILITY, AssetMasterError, createAsset,
  type AssetDepreciationInput,
} from '@/modules/finance/asset-master';

export interface AssetActionState {
  ok: boolean;
  message: string;
  remedy?: string;
}

const ROUTE = '/finance/assets/new';

function text(form: FormData, name: string): string {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
}

export async function createAction(
  _previous: AssetActionState,
  form: FormData,
): Promise<AssetActionState> {
  const session = await requireSession(ROUTE);
  if (!can(session, ASSET_CREATE_CAPABILITY)) {
    return { ok: false, message: 'You do not hold the asset creation capability.' };
  }
  try {
    const areasRaw = text(form, 'areas');
    const areas = areasRaw
      ? (JSON.parse(areasRaw) as Array<Record<string, string>>)
        .filter((a) => a.areaCode || a.depreciationKey)
        .map((a): AssetDepreciationInput => ({
          areaCode: a.areaCode, depreciationKey: a.depreciationKey,
          usefulLifeYears: Number(a.usefulLifeYears), usefulLifePeriods: Number(a.usefulLifePeriods),
          depreciationStartDate: a.depreciationStartDate || undefined,
        }))
      : [];
    const created = await createAsset({
      client: session.user.client, changedBy: session.user.username,
      companyCode: text(form, 'companyCode'),
      assetClass: text(form, 'assetClass'),
      similarCount: Number(text(form, 'similarCount') || '1'),
      assetNumber: text(form, 'assetNumber') || undefined,
      subNumber: text(form, 'subNumber') || '0000',
      description1: text(form, 'description1'),
      description2: text(form, 'description2') || undefined,
      inventoryNumber: text(form, 'inventoryNumber') || undefined,
      serialNumber: text(form, 'serialNumber') || undefined,
      quantity: text(form, 'quantity') ? Number(text(form, 'quantity')) : undefined,
      unitOfMeasure: text(form, 'unitOfMeasure') || undefined,
      capitalizationDate: text(form, 'capitalizationDate') || undefined,
      assignment: {
        validFrom: text(form, 'validFrom'),
        costCenter: text(form, 'costCenter') || undefined,
        profitCenter: text(form, 'profitCenter') || undefined,
        plant: text(form, 'plant') || undefined,
        location: text(form, 'location') || undefined,
      },
      depreciation: areas,
    });
    revalidatePath('/finance/assets');
    return {
      ok: true,
      message: `Created ${created.length} asset(s): ${created.map((a) => `${a.assetNumber}/${a.subNumber}`).join(', ')}. No acquisition has posted.`,
    };
  } catch (error) {
    if (error instanceof AssetMasterError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
