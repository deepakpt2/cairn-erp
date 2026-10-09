'use server';

import { revalidatePath } from 'next/cache';
import { requireSession, requireCapability, AuthzError } from '@/platform/auth/current';
import { MaterialError, saveMaterialView, type MaterialInput } from '@/modules/inventory/materials';
import { MATERIAL_VIEW_CAPABILITY, MATERIAL_VIEWS } from '@/modules/inventory/constants';
import { t } from '@/platform/i18n';

export interface MaterialState { ok: boolean; message?: string; remedy?: string; materialNumber?: string; status?: string; version?: number }

export async function saveMaterialAction(_previous: MaterialState, form: FormData): Promise<MaterialState> {
  const session = await requireSession('/inventory/materials');
  const read = (name: string) => String(form.get(name) ?? '').trim();
  try {
    const view = MATERIAL_VIEWS.find((v) => v === read('view'));
    if (!view) throw new MaterialError('This material view is not implemented.');
    await requireCapability(MATERIAL_VIEW_CAPABILITY[view], session);
    const common = { client: session.user.client, materialNumber: read('materialNumber'), expectedVersion: Number(read('expectedVersion')), changedBy: session.user.username, reason: read('reason') };
    let input: MaterialInput;
    if (view === 'BASIC') input = { ...common, view, description: read('description'), materialType: read('materialType'), materialGroup: read('materialGroup'), baseUnit: read('baseUnit'),
      industrySector: read('industrySector'), barcode: read('barcode'), grossWeight: read('grossWeight'), netWeight: read('netWeight'), weightUnit: read('weightUnit'), isBlocked: form.get('isBlocked') === 'on' };
    else if (view === 'PURCHASING') input = { ...common, view, plant: read('plant'), purchasingGroup: read('purchasingGroup'), orderUnit: read('orderUnit'), overdeliveryTolerance: read('overdeliveryTolerance'), underdeliveryTolerance: read('underdeliveryTolerance'), manufacturerPartNumber: read('manufacturerPartNumber') };
    else if (view === 'MRP') input = { ...common, view, plant: read('plant'), mrpType: read('mrpType') as 'REQUIREMENTS', mrpController: read('mrpController'), procurementType: read('procurementType') as 'BUY', lotSizing: read('lotSizing') as 'EXACT',
      fixedLotSize: read('fixedLotSize'), minimumLotSize: read('minimumLotSize'), maximumLotSize: read('maximumLotSize'), safetyStock: read('safetyStock'), reorderPoint: read('reorderPoint'), plannedDeliveryDays: Number(read('plannedDeliveryDays')), inHouseProductionDays: Number(read('inHouseProductionDays')) };
    else input = { ...common, view, plant: read('plant'), valuationClass: read('valuationClass'), priceControl: read('priceControl') as 'STANDARD', standardPrice: read('standardPrice'), movingAveragePrice: read('movingAveragePrice'), priceUnit: read('priceUnit') };
    const result = await saveMaterialView(input);
    revalidatePath('/inventory/materials');
    return { ok: true, message: t(result.changed ? 'material.saved' : 'material.unchanged', { status: t(`material.state.${result.status}`) }), materialNumber: result.materialNumber, status: result.status, version: result.version };
  } catch (error) {
    if (error instanceof MaterialError || error instanceof AuthzError) return { ok: false, message: error.message, remedy: error.remedy };
    throw error;
  }
}
