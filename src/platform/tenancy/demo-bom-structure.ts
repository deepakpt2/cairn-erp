/**
 * Demo phase D15_BOM_STRUCTURE — something for BOM explosion and where-used (CS11/CS12/CS15) to show.
 *
 * The demo's standing structure is two levels (finished goods → SEMI-DOUGH → bought raw materials)
 * with no phantom, text item, fixed quantity or second alternative. This phase adds, beside it:
 * - PH-GLAZE, a glaze made on the line and never stocked: a phantom sub-assembly with its own BOM
 *   (cocoa and sugar) and a production version, so the explosion passes through it. Its MRP type is
 *   NONE: MRP never plans it on its own;
 * - alternative 02 of FG-CHOC — the same chocolate wafer with a glaze — carrying the phantom, scrap on
 *   the dough, a fixed carton quantity and a text item.
 *
 * Alternative 02 is selected by **no** production version: FG-CHOC's only version names alternative
 * 01, so neither lot size nor date can reach it, and MRP plans exactly what it planned before. It is
 * explored by naming it (usage P, alternative 02) on /production/bom-explosion; where-used finds it.
 *
 * Built through the product's services; idempotent by adoption.
 */
import { getMaterialDetail, saveMaterialView } from '../../modules/inventory/materials';
import { createMaterialBom, getMaterialBom, saveBomItemCategory } from '../../modules/production/material-bom';
import { createProductionVersion, getProductionVersion } from '../../modules/production/production-version';
import { createRouting, resolveRouting } from '../../modules/production/routing';
import { DEMO_ACTOR, DEMO_IDENTITY, DEMO_STRUCTURE } from './demo-organisation';
import type { DemoTimeline } from './demo-provisioning';

const PHANTOM = 'PH-GLAZE';
const PARENT = 'FG-CHOC';

const ignoreExisting = (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  if (/already|exists|stands/i.test(message)) return;
  throw error;
};

export interface DemoBomStructureResult {
  phantom: string;
  parent: string;
  alternative: string;
  phantomBom: boolean;
  alternativeBom: boolean;
  phantomVersion: boolean;
}

export async function buildDemoBomStructure(input: { client?: string; timeline: DemoTimeline }): Promise<DemoBomStructureResult> {
  const client = input.client ?? DEMO_IDENTITY.clientKey;
  const plant = DEMO_STRUCTURE.manufacturingPlant;
  const from = input.timeline.startDate;
  const common = { client, changedBy: DEMO_ACTOR, reason: 'Demo BOM structure' };

  // A text item category: a line on the BOM that names no material.
  await saveBomItemCategory({
    client, changedBy: DEMO_ACTOR, category: 'T', description: 'Text item', materialEntry: '-', quantityEntry: '-',
  }).catch(ignoreExisting);

  // The phantom material: made on the line, never stocked, never planned on its own.
  if (!(await getMaterialDetail(client, PHANTOM))) {
    await saveMaterialView({
      ...common, materialNumber: PHANTOM, view: 'BASIC', expectedVersion: 0, description: 'Chocolate glaze (phantom)',
      materialType: 'SEMI', materialGroup: 'PRODUCTS', baseUnit: 'KG', industrySector: 'M', barcode: '',
      grossWeight: '0', netWeight: '0', weightUnit: '', isBlocked: false,
    });
  }
  const detail = await getMaterialDetail(client, PHANTOM);
  const view = detail?.plants.find((row) => row.plant === plant);
  if (!view || view.mrpStatus === 'NOT_CREATED' || view.mrpStatus === 'INCOMPLETE') {
    await saveMaterialView({
      ...common, materialNumber: PHANTOM, view: 'MRP', expectedVersion: view?.version ?? 0, plant,
      mrpType: 'NONE', mrpController: '001', procurementType: 'MAKE', lotSizing: 'EXACT', fixedLotSize: '0',
      minimumLotSize: '0', maximumLotSize: '0', safetyStock: '0', reorderPoint: '0', plannedDeliveryDays: 0,
      inHouseProductionDays: 0, backflush: true, automaticGoodsReceipt: false,
    }).catch(ignoreExisting);
  }

  // The phantom's own BOM and the version through which an explosion reaches it.
  let phantomBom = false;
  if (!(await getMaterialBom(client, PHANTOM, plant, 'P', '01').catch(() => null))) {
    await createMaterialBom({
      client, changedBy: DEMO_ACTOR, materialNumber: PHANTOM, plant, usage: 'P', alternative: '01', status: '01',
      baseQuantity: '10', baseUnit: 'KG', validFrom: from, headerText: 'Demo phantom — chocolate glaze', requestKey: `DEMO-BOM-${PHANTOM}`,
      items: [
        { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'RAW-COCOA', quantity: '6', unit: 'KG', validFrom: from },
        { itemNumber: '0020', itemCategory: 'S', componentMaterial: 'RAW-SUGAR', quantity: '4', unit: 'KG', validFrom: from },
      ],
    });
    phantomBom = true;
  }
  let phantomVersion = false;
  if (!(await getProductionVersion(client, PHANTOM, plant, '0001').catch(() => null))) {
    let routing = await resolveRouting(client, { materialNumber: PHANTOM, plant, taskListType: 'N' }).catch(() => null);
    if (!routing) {
      await createRouting({
        client, changedBy: DEMO_ACTOR, taskListType: 'N', plant, description: `Demo routing — ${PHANTOM}`, usage: '1', status: '01',
        baseQuantity: '10', baseUnit: 'KG', validFrom: from, requestKey: `DEMO-RTG-${PHANTOM}`,
        assignments: [{ materialNumber: PHANTOM, plant, validFrom: from }],
        operations: [{ operationNumber: '0010', shortText: 'Glaze', workCenter: 'WC01', controlKey: 'PP01', validFrom: from }],
      });
      routing = await resolveRouting(client, { materialNumber: PHANTOM, plant, taskListType: 'N' });
    }
    await createProductionVersion({
      client, changedBy: DEMO_ACTOR, materialNumber: PHANTOM, plant, productionVersion: '0001', description: 'Demo build — glaze',
      validFrom: from, lotFrom: '0', lotTo: '999999', lotUnit: 'KG', bomUsage: 'P', bomAlternative: '01', taskListType: 'N',
      routingGroup: routing!.routingGroup, groupCounter: routing!.groupCounter, requestKey: `DEMO-PV-${PHANTOM}`,
    });
    phantomVersion = true;
  }

  // Alternative 02 of FG-CHOC: selected by no production version (the only one names 01).
  let alternativeBom = false;
  if (!(await getMaterialBom(client, PARENT, plant, 'P', '02').catch(() => null))) {
    await createMaterialBom({
      client, changedBy: DEMO_ACTOR, materialNumber: PARENT, plant, usage: 'P', alternative: '02', status: '01',
      baseQuantity: '1200', baseUnit: 'PC', validFrom: from, headerText: 'Demo alt 02 — glazed chocolate wafer',
      requestKey: `DEMO-BOM-${PARENT}-02`,
      items: [
        { itemNumber: '0010', itemCategory: 'S', componentMaterial: 'SEMI-DOUGH', quantity: '240', unit: 'KG', scrapPercent: '2', validFrom: from },
        { itemNumber: '0020', itemCategory: 'S', componentMaterial: PHANTOM, quantity: '12', unit: 'KG', phantom: 'X', validFrom: from },
        { itemNumber: '0030', itemCategory: 'S', componentMaterial: 'PACK-WRAP', quantity: '1200', unit: 'PC', validFrom: from },
        { itemNumber: '0040', itemCategory: 'S', componentMaterial: 'PACK-CARTON', quantity: '50', unit: 'PC', fixedQuantity: 'X', validFrom: from },
        { itemNumber: '0050', itemCategory: 'T', itemText: 'Glaze while the wafer is still warm', validFrom: from },
      ],
    });
    alternativeBom = true;
  }

  return { phantom: PHANTOM, parent: PARENT, alternative: '02', phantomBom, alternativeBom, phantomVersion };
}
