/** International material defaults — applied in the tenant onboarding transaction. */
import type { Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { materialType, materialGroup, valuationClass, mrpController } from './schema';

export async function applyMaterialDefaults(tx: Tx, client: string, createdBy: string) {
  for (const type of [
    { materialType: 'RAW', name: 'Raw material', defaultProcurementType: 'BUY', defaultPriceControl: 'MOVING_AVERAGE', isStocked: true, isValuated: true },
    { materialType: 'SEMI', name: 'Semi-finished product', defaultProcurementType: 'MAKE', defaultPriceControl: 'STANDARD', isStocked: true, isValuated: true },
    { materialType: 'FINISHED', name: 'Finished product', defaultProcurementType: 'MAKE', defaultPriceControl: 'STANDARD', isStocked: true, isValuated: true },
    { materialType: 'TRADE', name: 'Trading goods', defaultProcurementType: 'BUY', defaultPriceControl: 'MOVING_AVERAGE', isStocked: true, isValuated: true },
    { materialType: 'SERVICE', name: 'Service', defaultProcurementType: 'BUY', defaultPriceControl: 'STANDARD', isStocked: false, isValuated: false },
  ]) await tx.insert(materialType).values({ ...type, client, createdBy }).onConflictDoNothing();
  for (const group of [
    { materialGroup: 'GENERAL', name: 'General materials' }, { materialGroup: 'RAW', name: 'Raw materials' },
    { materialGroup: 'PACKAGING', name: 'Packaging' }, { materialGroup: 'PRODUCTS', name: 'Manufactured products' },
    { materialGroup: 'MAINTENANCE', name: 'Maintenance and repair' }, { materialGroup: 'SERVICES', name: 'Services' },
  ]) await tx.insert(materialGroup).values({ ...group, client, createdBy }).onConflictDoNothing();
  for (const c of [
    { valuationClass: 'RAW_INVENTORY', name: 'Raw material inventory', allowedMaterialTypes: 'RAW' },
    { valuationClass: 'SEMI_INVENTORY', name: 'Semi-finished inventory', allowedMaterialTypes: 'SEMI' },
    { valuationClass: 'FINISHED_INVENTORY', name: 'Finished product inventory', allowedMaterialTypes: 'FINISHED' },
    { valuationClass: 'TRADE_INVENTORY', name: 'Trading goods inventory', allowedMaterialTypes: 'TRADE' },
  ]) await tx.insert(valuationClass).values({ ...c, client, createdBy }).onConflictDoNothing();
  await tx.insert(mrpController).values({ client, controller: '001', name: 'Primary planner', createdBy }).onConflictDoNothing();
  for (const code of ['CFG.INV.MATERIALTYPE.DEFINE', 'CFG.INV.MATERIALGROUP.DEFINE', 'CFG.PROD.MRPCONTROLLER.DEFINE']) {
    await markActivityComplete(tx, client, code, createdBy);
  }
}
