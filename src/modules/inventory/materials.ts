/** Master views are separate, audited writes; no stock can be edited here. */
import { z } from 'zod';
import { and, eq, sql } from 'drizzle-orm';
import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { unitOfMeasure } from '../../platform/tables/reference';
import { companyCode, plant, purchasingGroup } from '../foundation/schema';
import { material, materialPlant, materialValuation, materialType, materialGroup, valuationClass, mrpController, planningFile } from './schema';
import { MRP_TYPES, PROCUREMENT_TYPES, LOT_PROCEDURES, PRICE_CONTROLS } from './constants';

export class MaterialError extends Error {
  readonly code = 'CAIRN_MATERIAL';
  constructor(message: string, readonly remedy = 'Correct the indicated field and save again.') { super(message); this.name = 'MaterialError'; }
}
const quantity = z.string().regex(/^(0|[1-9]\d{0,19})(\.\d{1,3})?$/, 'Use a non-negative quantity with up to 3 decimals.').transform((s) => fromScaled(toScaled(s, 3), 3));
const money = z.string().regex(/^(0|[1-9]\d{0,18})(\.\d{1,4})?$/, 'Use a non-negative price with up to 4 decimals.').transform((s) => fromScaled(toScaled(s), 4));
const percent = z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).refine((s) => toScaled(s, 2) <= 10000n, 'Tolerance must be between 0 and 100.').transform((s) => fromScaled(toScaled(s, 2), 2));
const common = z.object({
  client: z.string().regex(/^[A-Za-z0-9]{2,4}$/),
  materialNumber: z.string().regex(/^[A-Z0-9][A-Z0-9_.-]{0,39}$/),
  expectedVersion: z.number().int().nonnegative(), changedBy: z.string().min(1).max(60), reason: z.string().trim().max(500).default(''),
});
const materialInput = z.discriminatedUnion('view', [
  common.extend({ view: z.literal('BASIC'), description: z.string().trim().max(200), materialType: z.string().min(1).max(12),
    materialGroup: z.string().max(20), baseUnit: z.string().max(6), industrySector: z.string().max(20), barcode: z.string().max(32),
    grossWeight: quantity, netWeight: quantity, weightUnit: z.string().max(6), isBlocked: z.boolean() }),
  common.extend({ view: z.literal('PURCHASING'), plant: z.string().min(1).max(10), purchasingGroup: z.string().max(6),
    orderUnit: z.string().max(6), overdeliveryTolerance: percent, underdeliveryTolerance: percent, manufacturerPartNumber: z.string().max(80) }),
  common.extend({ view: z.literal('MRP'), plant: z.string().min(1).max(10), mrpType: z.enum(MRP_TYPES), mrpController: z.string().max(3),
    procurementType: z.enum(PROCUREMENT_TYPES), lotSizing: z.enum(LOT_PROCEDURES), fixedLotSize: quantity,
    minimumLotSize: quantity, maximumLotSize: quantity, safetyStock: quantity, reorderPoint: quantity,
    plannedDeliveryDays: z.number().int().min(0).max(3650), inHouseProductionDays: z.number().int().min(0).max(3650) }),
  common.extend({ view: z.literal('ACCOUNTING'), plant: z.string().min(1).max(10), valuationClass: z.string().max(20),
    priceControl: z.enum(PRICE_CONTROLS), standardPrice: money, movingAveragePrice: money, priceUnit: quantity.refine((s) => toScaled(s, 3) > 0n, 'Price unit must be positive.') }),
]);
export type MaterialInput = z.input<typeof materialInput>;
export type MaterialResult = { materialNumber: string; view: MaterialInput['view']; status: string; version: number; changed: boolean };
const key = (client: string, materialNumber: string) => and(eq(material.client, client), eq(material.materialNumber, materialNumber));
const plantKey = (client: string, materialNumber: string, plant: string) => and(eq(materialPlant.client, client), eq(materialPlant.materialNumber, materialNumber), eq(materialPlant.plant, plant));
function checkVersion(row: { version: number } | undefined, expected: number) {
  if ((row?.version ?? 0) !== expected) throw new MaterialError('This view changed after it was opened.', 'Reload the material, review the current values, then apply your change.');
}
function subset(row: object, values: Record<string, unknown>) {
  return Object.fromEntries(Object.keys(values).map((k) => [k, (row as Record<string, unknown>)[k]]));
}
function same(row: object, values: Record<string, unknown>) {
  return Object.entries(values).every(([k, v]) => (row as Record<string, unknown>)[k] === v);
}
function viewStatus(before: string | undefined, complete: boolean) {
  return !complete ? 'INCOMPLETE' : !before || before === 'INCOMPLETE' || before === 'NOT_CREATED' ? 'CREATED' : 'MAINTAINED';
}
async function dirtyPlanning(tx: Tx, client: string, materialNumber: string, plant: string, actor: string, reason: string) {
  await tx.insert(planningFile).values({ client, materialNumber, plant, lastChangedBy: actor, reason }).onConflictDoUpdate({
    target: [planningFile.client, planningFile.materialNumber, planningFile.plant],
    set: { netChange: true, reason, lastChangedBy: actor, lastChangedAt: new Date() },
  });
}
async function checkUnit(tx: Tx, code: string, weight = false) {
  if (!code) return;
  const [unit] = await tx.select().from(unitOfMeasure).where(eq(unitOfMeasure.code, code));
  if (!unit || (weight && unit.dimension !== 'MASS')) throw new MaterialError(`Unit ${code} is not a valid ${weight ? 'mass' : 'base'} unit.`);
}

export async function saveMaterialView(raw: MaterialInput): Promise<MaterialResult> {
  const parsed = materialInput.safeParse(raw);
  if (!parsed.success) { const i = parsed.error.issues[0]; throw new MaterialError(`${i.path.join('.')}: ${i.message}`); }
  const input = parsed.data;
  const { client, materialNumber, changedBy, expectedVersion, view } = input;
  return withTenant(client, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${client}/material/${materialNumber}`}, 0))`);
    const [base] = await tx.select().from(material).where(key(client, materialNumber)).for('update');
    if (view === 'BASIC') {
      checkVersion(base, expectedVersion);
      const [type] = await tx.select().from(materialType).where(eq(materialType.materialType, input.materialType));
      if (!type?.isActive) throw new MaterialError(`Material type ${input.materialType} is not active or does not exist.`);
      if (base && base.materialType !== input.materialType) throw new MaterialError('Material type is immutable after creation.', 'Create another material for a different type.');
      if (input.materialGroup) {
        const [group] = await tx.select().from(materialGroup).where(eq(materialGroup.materialGroup, input.materialGroup));
        if (!group?.isActive) throw new MaterialError(`Material group ${input.materialGroup} does not exist or is inactive.`);
      }
      await checkUnit(tx, input.baseUnit); await checkUnit(tx, input.weightUnit, true);
      if (toScaled(input.grossWeight, 3) < toScaled(input.netWeight, 3)) throw new MaterialError('Gross weight must not be less than net weight.');
      if ((toScaled(input.grossWeight, 3) > 0n || toScaled(input.netWeight, 3) > 0n) && !input.weightUnit) throw new MaterialError('A weight unit is required when a weight is entered.');
      if (base?.baseUnit && base.baseUnit !== (input.baseUnit || null)) {
        const extensions = await tx.select().from(materialPlant).where(eq(materialPlant.materialNumber, materialNumber));
        const valuations = await tx.select().from(materialValuation).where(eq(materialValuation.materialNumber, materialNumber));
        if (extensions.length || valuations.length) throw new MaterialError('The base unit cannot change after organisational views exist.', 'Keep this unit or create a new material. Unit conversions will be maintained separately.');
      }
      if (base && base.isBlocked !== input.isBlocked && input.reason.length < 3) throw new MaterialError('Blocking or unblocking requires a reason.');
      const values = { description: input.description, materialType: input.materialType, materialGroup: input.materialGroup || null,
        baseUnit: input.baseUnit || null, industrySector: input.industrySector || null, barcode: input.barcode || null,
        grossWeight: input.grossWeight, netWeight: input.netWeight, weightUnit: input.weightUnit || null, isBlocked: input.isBlocked };
      if (base && same(base, values)) return { materialNumber, view, status: base.basicStatus, version: base.version, changed: false };
      const status = viewStatus(base?.basicStatus, !!(values.description && values.baseUnit && values.materialGroup));
      const version = (base?.version ?? 0) + 1;
      if (base) await tx.update(material).set({ ...values, basicStatus: status, version, changedBy, changedAt: new Date() }).where(key(client, materialNumber));
      else await tx.insert(material).values({ ...values, client, materialNumber, basicStatus: status, version, createdBy: changedBy });
      await recordChange(tx, { client, objectClass: 'material', objectKey: materialNumber,
        changeType: !base ? 'CREATE' : base.isBlocked !== input.isBlocked ? input.isBlocked ? 'BLOCK' : 'UNBLOCK' : 'CHANGE',
        changedBy, reason: input.reason, transactionCode: 'INV.MATERIAL.MAINTAIN',
        before: base ? { ...subset(base, values), basicStatus: base.basicStatus } : undefined,
        after: { ...values, basicStatus: status }, securityRelevantFields: ['isBlocked', 'materialType', 'baseUnit'],
      });
      if (base) {
        const extensions = await tx.select().from(materialPlant).where(eq(materialPlant.materialNumber, materialNumber));
        if (base.isBlocked !== input.isBlocked) for (const p of extensions) await dirtyPlanning(tx, client, materialNumber, p.plant, changedBy, 'MATERIAL_BLOCK_CHANGED');
      }
      return { materialNumber, view, status, version, changed: true };
    }
    if (!base) throw new MaterialError(`Material ${materialNumber} does not exist.`, 'Create its basic view first.');
    const [site] = await tx.select().from(plant).where(eq(plant.plant, input.plant));
    if (!site?.isActive) throw new MaterialError(`Plant ${input.plant} does not exist or is inactive.`);
    const [company] = await tx.select().from(companyCode).where(eq(companyCode.companyCode, site.companyCode));
    if (!company?.isActive) throw new MaterialError('The plant must belong to an active company code.');
    const [type] = await tx.select().from(materialType).where(eq(materialType.materialType, base.materialType));

    if (view === 'ACCOUNTING') {
      if (!type.isValuated) throw new MaterialError('This material type is not stock-valuated.', 'Services do not have an inventory valuation view.');
      const filter = and(eq(materialValuation.client, client), eq(materialValuation.materialNumber, materialNumber), eq(materialValuation.valuationArea, input.plant));
      const [before] = await tx.select().from(materialValuation).where(filter).for('update');
      checkVersion(before, expectedVersion);
      if (input.valuationClass) {
        const [c] = await tx.select().from(valuationClass).where(eq(valuationClass.valuationClass, input.valuationClass));
        if (!c?.isActive || !c.allowedMaterialTypes.split(',').includes(base.materialType)) throw new MaterialError(`Valuation class ${input.valuationClass} is not allowed for material type ${base.materialType}.`);
      }
      const values = { valuationClass: input.valuationClass || null, priceControl: input.priceControl,
        standardPrice: input.standardPrice, movingAveragePrice: input.movingAveragePrice, priceUnit: input.priceUnit, currency: company.currency };
      if (before && same(before, values) && !(before.accountingStatus === 'INCOMPLETE' && input.valuationClass && base.baseUnit)) return { materialNumber, view, status: before.accountingStatus, version: before.version, changed: false };
      if (before && toScaled(before.totalStockQuantity, 3) !== 0n) throw new MaterialError('Valuation settings cannot be changed here while stock exists.', 'Use an authorised, balanced revaluation document; master maintenance cannot alter inventory book value.');
      const status = viewStatus(before?.accountingStatus, !!(input.valuationClass && base.baseUnit));
      const version = (before?.version ?? 0) + 1;
      if (before) await tx.update(materialValuation).set({ ...values, accountingStatus: status, version, changedBy, changedAt: new Date() }).where(filter);
      else await tx.insert(materialValuation).values({ ...values, client, materialNumber, valuationArea: input.plant, accountingStatus: status, version, createdBy: changedBy });
      await recordChange(tx, { client, objectClass: 'material_valuation', objectKey: `${materialNumber}/${input.plant}`, changeType: before ? 'CHANGE' : 'CREATE', changedBy,
        transactionCode: 'FIN.MATERIAL.VALUATION.MAINTAIN', reason: input.reason,
        before: before ? { ...subset(before, values), accountingStatus: before.accountingStatus } : undefined,
        after: { ...values, accountingStatus: status }, securityRelevantFields: ['valuationClass', 'priceControl', 'standardPrice', 'movingAveragePrice', 'priceUnit'],
      });
      return { materialNumber, view, status, version, changed: true };
    }
    const [before] = await tx.select().from(materialPlant).where(plantKey(client, materialNumber, input.plant)).for('update');
    checkVersion(before, expectedVersion);
    let values: Record<string, string | number | null>;
    let statusColumn: 'purchasingStatus' | 'mrpStatus'; let complete: boolean;
    if (view === 'PURCHASING') {
      if (input.purchasingGroup) {
        const [group] = await tx.select().from(purchasingGroup).where(eq(purchasingGroup.purchasingGroup, input.purchasingGroup));
        if (!group) throw new MaterialError(`Purchasing group ${input.purchasingGroup} does not exist.`);
      }
      await checkUnit(tx, input.orderUnit);
      if (input.orderUnit && input.orderUnit !== base.baseUnit) throw new MaterialError('A different order unit requires a material-specific conversion.', 'For this first slice, use the base unit; unit-conversion maintenance is still pending.');
      values = { purchasingGroup: input.purchasingGroup || null, orderUnit: input.orderUnit || null, overdeliveryTolerance: input.overdeliveryTolerance, underdeliveryTolerance: input.underdeliveryTolerance, manufacturerPartNumber: input.manufacturerPartNumber || null };
      statusColumn = 'purchasingStatus'; complete = !!(base.baseUnit && input.purchasingGroup && input.orderUnit);
    } else {
      if (!type.isStocked && input.mrpType !== 'NONE') throw new MaterialError('A non-stock material cannot be planned for inventory.', 'Choose No planning for this type.');
      if (input.mrpController) {
        const [controller] = await tx.select().from(mrpController).where(eq(mrpController.controller, input.mrpController));
        if (!controller?.isActive) throw new MaterialError(`MRP controller ${input.mrpController} is not active or does not exist.`);
      }
      const min = toScaled(input.minimumLotSize, 3), max = toScaled(input.maximumLotSize, 3);
      if (max > 0n && max < min) throw new MaterialError('Maximum lot size must not be below minimum lot size.');
      values = { mrpType: input.mrpType, mrpController: input.mrpController || null, procurementType: input.procurementType,
        lotSizing: input.lotSizing, fixedLotSize: input.fixedLotSize, minimumLotSize: input.minimumLotSize, maximumLotSize: input.maximumLotSize,
        safetyStock: input.safetyStock, reorderPoint: input.reorderPoint, plannedDeliveryDays: input.plannedDeliveryDays, inHouseProductionDays: input.inHouseProductionDays };
      statusColumn = 'mrpStatus'; complete = !!base.baseUnit && (input.mrpType === 'NONE' || (!!input.mrpController
        && (input.lotSizing !== 'FIXED' || toScaled(input.fixedLotSize, 3) > 0n)
        && (input.mrpType !== 'REORDER' || toScaled(input.reorderPoint, 3) > 0n)));
    }
    if (before && same(before, values) && !(before[statusColumn] === 'INCOMPLETE' && complete)) return { materialNumber, view, status: before[statusColumn], version: before.version, changed: false };
    const status = viewStatus(before?.[statusColumn], complete);
    const version = (before?.version ?? 0) + 1;
    if (before) await tx.update(materialPlant).set({ ...values, [statusColumn]: status, version, changedBy, changedAt: new Date() }).where(plantKey(client, materialNumber, input.plant));
    else await tx.insert(materialPlant).values({ ...values, client, materialNumber, plant: input.plant, [statusColumn]: status, version, createdBy: changedBy });
    await recordChange(tx, { client, objectClass: 'material_plant', objectKey: `${materialNumber}/${input.plant}`, changeType: before ? 'CHANGE' : 'CREATE', changedBy,
      transactionCode: view === 'MRP' ? 'PROD.MATERIAL.MRP.MAINTAIN' : 'PROC.MATERIAL.PURCHASING.MAINTAIN', reason: input.reason,
      before: before ? { ...subset(before, values), [statusColumn]: before[statusColumn] } : undefined, after: { ...values, [statusColumn]: status },
    });
    await dirtyPlanning(tx, client, materialNumber, input.plant, changedBy, `${view}_MASTER_CHANGED`);
    return { materialNumber, view, status, version, changed: true };
  });
}

export async function materialChoices(client: string) {
  return withTenant(client, async (tx) => ({
    types: await tx.select().from(materialType).where(eq(materialType.isActive, true)).orderBy(materialType.materialType),
    groups: await tx.select().from(materialGroup).where(eq(materialGroup.isActive, true)).orderBy(materialGroup.materialGroup),
    valuationClasses: await tx.select().from(valuationClass).where(eq(valuationClass.isActive, true)).orderBy(valuationClass.valuationClass),
    controllers: await tx.select().from(mrpController).where(eq(mrpController.isActive, true)).orderBy(mrpController.controller),
    units: await tx.select().from(unitOfMeasure).orderBy(unitOfMeasure.code),
    plants: await tx.select().from(plant).where(eq(plant.isActive, true)).orderBy(plant.plant),
    companies: await tx.select().from(companyCode).orderBy(companyCode.companyCode),
    purchasingGroups: await tx.select().from(purchasingGroup).orderBy(purchasingGroup.purchasingGroup),
  }));
}
export async function listMaterials(client: string, search = '') {
  return withTenant(client, (tx) => tx.select().from(material).where(and(eq(material.client, client), sql`(${material.materialNumber} ilike ${`%${search}%`} or ${material.description} ilike ${`%${search}%`})`)).orderBy(material.materialNumber).limit(200));
}
export async function getMaterialDetail(client: string, materialNumber: string) {
  return withTenant(client, async (tx) => {
    const [base] = await tx.select().from(material).where(key(client, materialNumber));
    if (!base) return null;
    return { base,
      plants: await tx.select().from(materialPlant).where(eq(materialPlant.materialNumber, materialNumber)).orderBy(materialPlant.plant),
      valuations: await tx.select().from(materialValuation).where(eq(materialValuation.materialNumber, materialNumber)).orderBy(materialValuation.valuationArea),
    };
  });
}

/** Shared operational gate for forthcoming PO/stock/planning services. Read-only. */
export async function requireUsableMaterial(tx: Tx, client: string, materialNumber: string, view: MaterialInput['view'], plantCode?: string) {
  const [base] = await tx.select().from(material).where(key(client, materialNumber));
  if (!base) throw new MaterialError(`Material ${materialNumber} does not exist.`, 'Create its basic view first.');
  if (base.isBlocked) throw new MaterialError(`Material ${materialNumber} is blocked for operational use.`, 'Ask an authorised master-data maintainer to review its blocking reason.');
  if (base.basicStatus === 'INCOMPLETE') throw new MaterialError(`The basic view of ${materialNumber} is incomplete.`, 'Complete description, group and base unit before operational use.');
  if (view === 'BASIC') return { base, plantData: null, valuation: null };
  if (!plantCode) throw new MaterialError(`Plant scope is required for the ${view} view.`);
  if (view === 'ACCOUNTING') {
    const [valuation] = await tx.select().from(materialValuation).where(and(eq(materialValuation.client, client), eq(materialValuation.materialNumber, materialNumber), eq(materialValuation.valuationArea, plantCode)));
    if (!valuation || valuation.accountingStatus === 'INCOMPLETE') throw new MaterialError(`The valuation view of ${materialNumber} / ${plantCode} is missing or incomplete.`, 'Complete its Accounting / Costing view before stock valuation.');
    return { base, plantData: null, valuation };
  }
  const [plantData] = await tx.select().from(materialPlant).where(plantKey(client, materialNumber, plantCode));
  const status = plantData?.[view === 'MRP' ? 'mrpStatus' : 'purchasingStatus'];
  if (!plantData || status === 'NOT_CREATED' || status === 'INCOMPLETE') throw new MaterialError(`The ${view} view of ${materialNumber} / ${plantCode} is missing or incomplete.`, 'Complete the required plant view before operational use.');
  return { base, plantData, valuation: null };
}
