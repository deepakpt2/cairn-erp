'use server';

import { requireCapability } from '@/platform/auth/current';
import {
  BOM_CHANGE_CAPABILITY,
  BOM_CREATE_CAPABILITY,
  MaterialBomError,
  changeMaterialBom,
  createMaterialBom,
  saveBomItemCategory,
  saveBomStatus,
  saveBomUsage,
  type MaterialBomItemInput,
  type MaterialBomView,
} from '@/modules/production/material-bom';

export interface BomActionState {
  ok: boolean;
  message?: string;
  remedy?: string;
  warnings?: string[];
  bom?: MaterialBomView;
}

function fail(error: unknown): BomActionState {
  if (error instanceof MaterialBomError) return { ok: false, message: error.message, remedy: error.remedy };
  return { ok: false, message: error instanceof Error ? error.message : 'The BOM was not saved.' };
}

export async function saveUsageAction(_previous: BomActionState, formData: FormData): Promise<BomActionState> {
  const session = await requireCapability(BOM_CREATE_CAPABILITY);
  try {
    await saveBomUsage({
      client: session.user.client,
      changedBy: session.user.username,
      usage: String(formData.get('usage') ?? ''),
      description: String(formData.get('description') ?? ''),
      productionRelevance: String(formData.get('productionRelevance') ?? ''),
      engineeringRelevance: String(formData.get('engineeringRelevance') ?? ''),
      costingRelevance: String(formData.get('costingRelevance') ?? ''),
      salesRelevance: String(formData.get('salesRelevance') ?? ''),
    });
    return { ok: true, message: 'The usage was saved. It is not a delivered usage list.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveStatusAction(_previous: BomActionState, formData: FormData): Promise<BomActionState> {
  const session = await requireCapability(BOM_CREATE_CAPABILITY);
  try {
    await saveBomStatus({
      client: session.user.client,
      changedBy: session.user.username,
      status: String(formData.get('status') ?? ''),
      description: String(formData.get('description') ?? ''),
      releasedForMrp: String(formData.get('releasedForMrp') ?? ' '),
      releasedForCosting: String(formData.get('releasedForCosting') ?? ' '),
      releasedForOrders: String(formData.get('releasedForOrders') ?? ' '),
    });
    return { ok: true, message: 'The status was saved. A release flag is stored and is not executed by planning or costing.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveItemCategoryAction(_previous: BomActionState, formData: FormData): Promise<BomActionState> {
  const session = await requireCapability(BOM_CREATE_CAPABILITY);
  try {
    await saveBomItemCategory({
      client: session.user.client,
      changedBy: session.user.username,
      category: String(formData.get('category') ?? ''),
      description: String(formData.get('description') ?? ''),
      materialEntry: String(formData.get('materialEntry') ?? ''),
      quantityEntry: String(formData.get('quantityEntry') ?? ''),
      allowFixedQuantity: String(formData.get('allowFixedQuantity') ?? ' '),
      allowBulk: String(formData.get('allowBulk') ?? ' '),
      allowPhantom: String(formData.get('allowPhantom') ?? ' '),
      allowCoproduct: String(formData.get('allowCoproduct') ?? ' '),
      allowFollowUp: String(formData.get('allowFollowUp') ?? ' '),
      allowSpecialProcurement: String(formData.get('allowSpecialProcurement') ?? ' '),
      allowNegativeQuantity: String(formData.get('allowNegativeQuantity') ?? ' '),
    });
    return { ok: true, message: 'The item category was saved. It is not a delivered category list.' };
  } catch (error) {
    return fail(error);
  }
}

export async function saveBomAction(_previous: BomActionState, formData: FormData): Promise<BomActionState> {
  const mode = String(formData.get('mode') ?? 'CREATE');
  const session = await requireCapability(mode === 'CHANGE' ? BOM_CHANGE_CAPABILITY : BOM_CREATE_CAPABILITY);
  let items: MaterialBomItemInput[] = [];
  try {
    items = JSON.parse(String(formData.get('items') ?? '[]')) as MaterialBomItemInput[];
  } catch {
    return { ok: false, message: 'The component lines could not be read. Nothing was saved.' };
  }
  const copyMaterial = String(formData.get('copyMaterial') ?? '').trim();
  const input = {
    client: session.user.client,
    changedBy: session.user.username,
    materialNumber: String(formData.get('materialNumber') ?? ''),
    plant: String(formData.get('plant') ?? ''),
    usage: String(formData.get('usage') ?? ''),
    alternative: String(formData.get('alternative') ?? ''),
    status: String(formData.get('status') ?? '') || null,
    baseQuantity: String(formData.get('baseQuantity') ?? ''),
    baseUnit: String(formData.get('baseUnit') ?? ''),
    validFrom: String(formData.get('validFrom') ?? ''),
    validTo: String(formData.get('validTo') ?? ''),
    headerText: String(formData.get('headerText') ?? ''),
    deletionFlag: String(formData.get('deletionFlag') ?? ' '),
    changeNumber: String(formData.get('changeNumber') ?? ''),
    items,
    version: formData.get('version') ? Number(formData.get('version')) : undefined,
    requestKey: String(formData.get('requestKey') ?? '') || null,
    copyFrom: copyMaterial ? {
      materialNumber: copyMaterial,
      plant: String(formData.get('copyPlant') ?? ''),
      usage: String(formData.get('copyUsage') ?? ''),
      alternative: String(formData.get('copyAlternative') ?? ''),
      copyItems: formData.get('copyItems') === 'X',
    } : null,
  };
  try {
    const bom = mode === 'CHANGE' ? await changeMaterialBom(input) : await createMaterialBom(input);
    return {
      ok: true,
      bom,
      warnings: bom.warnings,
      message: mode === 'CHANGE'
        ? `BOM ${bom.bomNumber} alternative ${bom.alternative} was saved. No production order was rewritten.`
        : `BOM ${bom.bomNumber} alternative ${bom.alternative} was created. No explosion was run.`,
    };
  } catch (error) {
    return fail(error);
  }
}
