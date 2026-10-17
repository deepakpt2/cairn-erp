/** International material defaults — applied in the tenant onboarding transaction. */
import { eq } from 'drizzle-orm';
import type { Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { plant } from '../foundation/schema';
import {
  accountCategoryReference,
  materialGroup,
  materialType,
  materialTypeValuation,
  mrpController,
  valuationClass,
} from './schema';

export const TYPE_UPDATING_DEFAULTS: Record<string, { quantityUpdating: boolean; valueUpdating: boolean }> = {
  RAW: { quantityUpdating: true, valueUpdating: true },
  SEMI: { quantityUpdating: true, valueUpdating: true },
  FIN: { quantityUpdating: true, valueUpdating: true },
  TRAD: { quantityUpdating: true, valueUpdating: true },
  SERV: { quantityUpdating: false, valueUpdating: false },
};

/**
 * Seed the per-plant updating rows for a plant that has just been
 * created: onboarding creates the plant after the material defaults
 * stand, so both call sites seed, each idempotently.
 */
export async function seedTypeValuationForPlant(tx: Tx, client: string, plantCode: string, createdBy: string) {
  const types = await tx.select({ materialType: materialType.materialType })
    .from(materialType).where(eq(materialType.client, client));
  for (const t of types) {
    const defaults = TYPE_UPDATING_DEFAULTS[t.materialType] ?? { quantityUpdating: true, valueUpdating: true };
    await tx.insert(materialTypeValuation).values({
      client, materialType: t.materialType, valuationArea: plantCode, ...defaults, createdBy,
    }).onConflictDoNothing();
  }
}

export async function applyMaterialDefaults(tx: Tx, client: string, createdBy: string) {
  await tx.insert(accountCategoryReference)
    .values({ client, reference: '0001', name: 'General valuation', createdBy })
    .onConflictDoNothing();
  const types = [
    { materialType: 'RAW', name: 'Raw material', defaultProcurementType: 'BUY', defaultPriceControl: 'V', isStocked: true, isValuated: true },
    { materialType: 'SEMI', name: 'Semi-finished product', defaultProcurementType: 'MAKE', defaultPriceControl: 'S', isStocked: true, isValuated: true },
    { materialType: 'FIN', name: 'Finished product', defaultProcurementType: 'MAKE', defaultPriceControl: 'S', isStocked: true, isValuated: true },
    { materialType: 'TRAD', name: 'Trading goods', defaultProcurementType: 'BUY', defaultPriceControl: 'V', isStocked: true, isValuated: true },
    { materialType: 'SERV', name: 'Service', defaultProcurementType: 'BUY', defaultPriceControl: 'S', isStocked: false, isValuated: false },
  ];
  for (const type of types) {
    const { isStocked, isValuated, ...typeRow } = type;
    void isStocked; void isValuated;
    await tx.insert(materialType)
      .values({ ...typeRow, accountCategoryReference: '0001', client, createdBy })
      .onConflictDoNothing();
  }
  // Quantity/value updating stands per plant (R-96); seed it from the
  // provisioned defaults for every plant standing at onboarding.
  const plants = await tx.select({ plant: plant.plant }).from(plant).where(eq(plant.client, client));
  for (const type of types) {
    for (const p of plants) {
      await tx.insert(materialTypeValuation).values({
        client, materialType: type.materialType, valuationArea: p.plant,
        quantityUpdating: type.isStocked, valueUpdating: type.isValuated, createdBy,
      }).onConflictDoNothing();
    }
  }
  for (const group of [
    { materialGroup: 'GENERAL', name: 'General materials' }, { materialGroup: 'RAW', name: 'Raw materials' },
    { materialGroup: 'PACKAGING', name: 'Packaging' },
    { materialGroup: 'PRODUCTS', name: 'Manufactured goods', longDescription: 'Manufactured products' },
    { materialGroup: 'MAINT', name: 'Maintenance', longDescription: 'Maintenance and repair' },
    { materialGroup: 'SERVICES', name: 'Services' },
  ]) await tx.insert(materialGroup).values({ ...group, client, createdBy }).onConflictDoNothing();
  for (const c of [
    { valuationClass: 'RAW_INVENTORY', name: 'Raw material inventory', allowedMaterialTypes: 'RAW' },
    { valuationClass: 'SEMI_INVENTORY', name: 'Semi-finished inventory', allowedMaterialTypes: 'SEMI' },
    { valuationClass: 'FINISHED_INVENTORY', name: 'Finished product inventory', allowedMaterialTypes: 'FIN' },
    { valuationClass: 'TRADE_INVENTORY', name: 'Trading goods inventory', allowedMaterialTypes: 'TRAD' },
  ]) await tx.insert(valuationClass).values({ ...c, client, createdBy }).onConflictDoNothing();
  await tx.insert(mrpController).values({ client, controller: '001', name: 'Primary planner', createdBy }).onConflictDoNothing();
  for (const code of ['CFG.INV.MATERIALTYPE.DEFINE', 'CFG.INV.MATERIALGROUP.DEFINE', 'CFG.PROD.MRPCONTROLLER.DEFINE']) {
    await markActivityComplete(tx, client, code, createdBy);
  }
}
