/** Development-only sample masters. Never overwrites an existing view or stock. */
import { withTenant } from '../../platform/db/client';
import { applyMaterialDefaults } from './standard-config';
import { getMaterialDetail, saveMaterialView } from './materials';

export async function seedDevelopmentMaterials() {
  const client = '0100';
  await withTenant(client, (tx) => applyMaterialDefaults(tx, client, 'DEV_SEED'));
  const samples = [
    { number: 'RAW-STEEL', description: 'Carbon steel sheet', type: 'RAW', group: 'RAW', unit: 'KG', procurement: 'BUY' as const, priceControl: 'MOVING_AVERAGE' as const, valuationClass: 'RAW_INVENTORY', price: '5.0000' },
    { number: 'PACK-CARTON', description: 'Shipping carton', type: 'RAW', group: 'PACKAGING', unit: 'PC', procurement: 'BUY' as const, priceControl: 'MOVING_AVERAGE' as const, valuationClass: 'RAW_INVENTORY', price: '2.0000' },
    { number: 'FG-BRACKET', description: 'Manufactured bracket', type: 'FINISHED', group: 'PRODUCTS', unit: 'PC', procurement: 'MAKE' as const, priceControl: 'STANDARD' as const, valuationClass: 'FINISHED_INVENTORY', price: '100.0000' },
  ];
  for (const s of samples) {
    const common = { client, materialNumber: s.number, changedBy: 'DEV_SEED', reason: 'Development sample master' };
    let detail = await getMaterialDetail(client, s.number);
    if (!detail) {
      await saveMaterialView({ ...common, view: 'BASIC', expectedVersion: 0, description: s.description, materialType: s.type,
        materialGroup: s.group, baseUnit: s.unit, industrySector: 'MANUFACTURING', barcode: '', grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false });
      detail = await getMaterialDetail(client, s.number);
    }
    let p = detail!.plants.find((p) => p.plant === '1000');
    if (!p || p.mrpStatus === 'NOT_CREATED') {
      await saveMaterialView({ ...common, view: 'MRP', expectedVersion: p?.version ?? 0, plant: '1000', mrpType: 'REQUIREMENTS', mrpController: '001',
        procurementType: s.procurement, lotSizing: 'EXACT', fixedLotSize: '0', minimumLotSize: '0', maximumLotSize: '0', safetyStock: '5', reorderPoint: '0',
        plannedDeliveryDays: s.procurement === 'BUY' ? 7 : 0, inHouseProductionDays: s.procurement === 'MAKE' ? 2 : 0 });
    }
    detail = await getMaterialDetail(client, s.number); p = detail!.plants.find((p) => p.plant === '1000');
    if (s.procurement === 'BUY' && (!p || p.purchasingStatus === 'NOT_CREATED')) {
      await saveMaterialView({ ...common, view: 'PURCHASING', expectedVersion: p?.version ?? 0, plant: '1000', purchasingGroup: '001', orderUnit: s.unit,
        overdeliveryTolerance: '0', underdeliveryTolerance: '0', manufacturerPartNumber: '' });
    }
    if (!detail!.valuations.some((v) => v.valuationArea === '1000')) {
      await saveMaterialView({ ...common, view: 'ACCOUNTING', expectedVersion: 0, plant: '1000', valuationClass: s.valuationClass, priceControl: s.priceControl,
        standardPrice: s.priceControl === 'STANDARD' ? s.price : '0', movingAveragePrice: s.priceControl === 'MOVING_AVERAGE' ? s.price : '0', priceUnit: '1' });
    }
  }
}
