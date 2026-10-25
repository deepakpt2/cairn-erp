/**
 * Component snapshot for a production order created from a production version.
 *
 * CO01 calls this. CO40 keeps its own copy of the same rules and is not edited
 * here. Both call selectProductionVersion with context ORDER and scale quantities
 * with componentRequirementQuantity. This file does not walk a plant explosion,
 * does not explode through a phantom, and does not write an order.
 *
 * A phantom, bulk item, co-product, special procurement, different issuing plant,
 * or follow-up material blocks the snapshot. The item is not dropped and not
 * replaced. A component's own BOM is not read, so a recursive BOM cannot loop.
 */
import { and, asc, eq } from 'drizzle-orm';

import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { type Tx } from '../../platform/db/client';
import { material, materialPlant } from '../inventory/schema';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { componentRequirementQuantity } from './mrp-explosion';
import { materialBom, materialBomItem } from './schema';
import { ProductionVersionError, selectProductionVersion } from './production-version';

export class OrderBomSnapshotError extends Error {
  readonly code: string;
  remedy?: string;
  constructor(code: string, message: string, remedy?: string) {
    super(message);
    this.name = 'OrderBomSnapshotError';
    this.code = code;
    this.remedy = remedy;
  }
}

function fail(code: string, message: string, remedy?: string): never {
  throw new OrderBomSnapshotError(code, message, remedy);
}

export interface OrderBomComponentSnapshot {
  /** Order line. The BOM item is kept separately because it may not be an integer. */
  orderItemNumber: number;
  bomItem: string;
  sourceMaterial: string;
  materialNumber: string;
  plant: string;
  requiredQuantity: string;
  unit: string;
}

export interface OrderBomSnapshot {
  productionVersion: string;
  bomUsage: string;
  bomAlternative: string;
  routingGroup: string;
  groupCounter: string;
  components: OrderBomComponentSnapshot[];
  warnings: string[];
}

export async function resolveOrderBomSnapshot(tx: Tx, input: {
  client: string;
  materialNumber: string;
  plant: string;
  orderQuantity: number;
  scheduledFinish: string;
  productionVersion?: string | null;
}): Promise<OrderBomSnapshot> {
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant.trim();
  const finish = input.scheduledFinish.trim();
  const quantity = input.orderQuantity.toFixed(3);

  const [plantView] = await tx.select({ procurementType: materialPlant.procurementType }).from(materialPlant).where(and(
    eq(materialPlant.client, input.client),
    eq(materialPlant.materialNumber, materialNumber),
    eq(materialPlant.plant, plant),
  ));
  if (!plantView) {
    fail('MATERIAL_PLANT', `Material ${materialNumber} is not extended to plant ${plant}. No order was created.`, `Extend the material to plant ${plant}, then create the order.`);
  }
  if (plantView.procurementType === 'BUY') {
    fail('PROCUREMENT', `Material ${materialNumber} is externally procured. No order was created.`, 'A purchased material is not given a production order from this screen.');
  }
  if (plantView.procurementType !== 'MAKE' && plantView.procurementType !== 'BOTH') {
    fail('PROCUREMENT', `Material ${materialNumber} has no in-house procurement type. No order was created.`, 'Set procurement to make or both on the plant view.');
  }

  const [produced] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
    eq(material.client, input.client), eq(material.materialNumber, materialNumber),
  ));
  if (!produced?.baseUnit) {
    fail('UNIT', `Material ${materialNumber} carries no base unit. No order was created.`, 'Complete the material master, then create the order.');
  }

  let selected;
  try {
    selected = await selectProductionVersion(input.client, {
      materialNumber,
      plant,
      keyDate: finish,
      quantity,
      unit: produced.baseUnit,
      productionVersion: input.productionVersion,
      context: 'ORDER',
    }, tx);
  } catch (caught) {
    if (caught instanceof ProductionVersionError) {
      fail(caught.code, `${caught.message} No order was created.`, caught.remedy);
    }
    throw caught;
  }

  const warnings = [
    `Routing ${selected.taskListType} ${selected.routingGroup} ${selected.groupCounter} is named by production version ${selected.productionVersion}. The production order does not store operations, so none were copied.`,
    'A later bill of material or production version change does not rewrite this snapshot.',
  ];

  const [header] = await tx.select().from(materialBom).where(and(
    eq(materialBom.client, input.client),
    eq(materialBom.materialNumber, materialNumber),
    eq(materialBom.plant, plant),
    eq(materialBom.usage, selected.bomUsage),
    eq(materialBom.alternative, selected.bomAlternative),
  ));
  if (!header || header.deletionFlag === 'X') {
    fail('BOM_MISSING', `Bill of material ${selected.bomUsage}/${selected.bomAlternative} does not stand. No order was created.`, 'Correct the production version or the bill of material, then create the order.');
  }

  const items = await tx.select().from(materialBomItem).where(and(
    eq(materialBomItem.client, input.client),
    eq(materialBomItem.materialNumber, materialNumber),
    eq(materialBomItem.plant, plant),
    eq(materialBomItem.usage, selected.bomUsage),
    eq(materialBomItem.alternative, selected.bomAlternative),
  )).orderBy(asc(materialBomItem.itemNumber));
  const inEffect = items.filter((item) => item.deletionFlag !== 'X' && item.validFrom <= finish && item.validTo >= finish);
  if (inEffect.length < items.filter((item) => item.deletionFlag !== 'X').length) {
    warnings.push('Bill of material items outside the finish date were not copied.');
  }
  if (inEffect.length === 0) {
    fail('NO_COMPONENT', 'The selected bill of material has no component in effect on the finish date. No order was created.', 'Correct the component validity, or choose another finish date. Nothing was saved.');
  }

  const components: OrderBomComponentSnapshot[] = [];
  for (const item of inEffect) {
    if (item.phantom === 'X') {
      fail('PHANTOM', `Component ${item.itemNumber} is a phantom. The order snapshot does not explode through a phantom, and the item was not dropped. No order was created.`, 'Replace the phantom before creating the order. A phantom BOM was not walked.');
    }
    if (item.bulkMaterial === 'X') {
      fail('BULK', `Component ${item.itemNumber} is a bulk material. It was not silently omitted. No order was created.`, 'Remove the bulk item from the bill of material, then create the order.');
    }
    if (item.coproduct === 'X') {
      fail('COPRODUCT', `Component ${item.itemNumber} is a co-product. It was not copied. No order was created.`, 'A co-product is not a component snapshot. Nothing was saved.');
    }
    if (item.specialProcurement?.trim()) {
      fail('SPECIAL_PROCUREMENT', `Component ${item.itemNumber} has special procurement ${item.specialProcurement}. It was not copied. No order was created.`, 'Special procurement is not executed on this order. Nothing was saved.');
    }
    if (item.issuingPlant && item.issuingPlant !== plant) {
      fail('ISSUING_PLANT', `Component ${item.itemNumber} is issued from plant ${item.issuingPlant}. The production order component does not store a different issuing plant. No order was created.`, 'Use a component issued in the order plant. Nothing was saved.');
    }
    if (item.followUpMaterial?.trim()) {
      fail('FOLLOW_UP', `Component ${item.itemNumber} names follow-up material ${item.followUpMaterial}. It was not substituted. No order was created.`, 'The follow-up material was not copied in place of the component. Nothing was saved.');
    }
    if (!item.componentMaterial || item.quantity == null || !item.unit) {
      fail('COMPONENT', `Component ${item.itemNumber} has no material, quantity, or unit. It was not dropped. No order was created.`, 'Complete the bill of material item, then create the order.');
    }
    const raw = componentRequirementQuantity({
      parentQuantity: toScaled(quantity, 3),
      itemQuantity: toScaled(String(item.quantity), 3),
      baseQuantity: toScaled(String(header.baseQuantity), 3),
      scrapPercent: item.scrapPercent,
      fixed: item.fixedQuantity === 'X',
    });
    if (raw == null) {
      fail('QUANTITY', `Component ${item.itemNumber} has no positive requirement quantity. No order was created.`, 'Correct the component quantity. Nothing was saved.');
    }
    try {
      const base = await toBaseQuantity(tx, input.client, {
        materialNumber: item.componentMaterial,
        quantity: Number(fromScaled(raw, 3)),
        entryUnit: item.unit,
      });
      components.push({
        orderItemNumber: (components.length + 1) * 10,
        bomItem: item.itemNumber,
        sourceMaterial: materialNumber,
        materialNumber: item.componentMaterial,
        plant,
        requiredQuantity: Number(base.baseQuantity).toFixed(3),
        unit: base.baseUnit,
      });
    } catch (caught) {
      fail(
        'UNIT',
        caught instanceof UnitConversionError
          ? `${caught.message} No order was created.`
          : `Component ${item.itemNumber} could not be converted to its base unit. No order was created.`,
        caught instanceof UnitConversionError ? caught.remedy : 'Correct the component unit, then create the order.',
      );
    }
  }

  return {
    productionVersion: selected.productionVersion,
    bomUsage: selected.bomUsage,
    bomAlternative: selected.bomAlternative,
    routingGroup: selected.routingGroup,
    groupCounter: selected.groupCounter,
    components,
    warnings,
  };
}
