/**
 * Single-item explosion — MD02.
 *
 * The plant run does not call this. A make proposal names a production version.
 * The version names the BOM. Component demand is dated at the planned-order start.
 * A buy material is not exploded. A phantom is exploded through and is not proposed.
 * A cycle stops the branch. The first version is never chosen.
 *
 * Lead time is a number of days. A factory calendar, an MRP area, capacity, and
 * delete-and-recreate are not this explosion. A check writes no operational demand.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { toBaseQuantity, UnitConversionError } from '../inventory/unit-conversion';
import { ProductionVersionError, selectProductionVersion } from './production-version';

const SCALE = 3;
const DEPTH_LIMIT = 20;

export interface ExplosionDiagnostic {
  severity: 'INFO' | 'WARNING' | 'ERROR';
  code: string;
  message: string;
}

export interface ExplosionComponent {
  materialNumber: string;
  plant: string;
  level: number;
  path: string;
}

export interface ExplosionResult {
  diagnostics: ExplosionDiagnostic[];
  components: ExplosionComponent[];
}

interface ParentLot {
  orderNumber: string | null;
  quantity: bigint;
  unit: string;
  startDate: string;
  finishDate: string;
}

function scaled(value: unknown): bigint {
  if (value == null || value === '') return 0n;
  return toScaled(String(value), SCALE);
}

function shown(value: bigint): string {
  return fromScaled(value, SCALE);
}

function rows(tx: Tx, query: ReturnType<typeof sql>): Promise<Array<Record<string, unknown>>> {
  return tx.execute(query) as unknown as Promise<Array<Record<string, unknown>>>;
}

/** Component quantity in the item unit, before conversion to the component base unit. */
export function componentRequirementQuantity(input: {
  parentQuantity: bigint;
  itemQuantity: bigint;
  baseQuantity: bigint;
  scrapPercent: string | null;
  fixed: boolean;
}): bigint | null {
  if (input.baseQuantity <= 0n || input.itemQuantity === 0n) return null;
  if (input.itemQuantity < 0n || input.parentQuantity <= 0n) return null;
  let raw = input.fixed
    ? input.itemQuantity
    : (input.parentQuantity * input.itemQuantity + input.baseQuantity / 2n) / input.baseQuantity;
  if (input.scrapPercent && input.scrapPercent.trim() && input.scrapPercent.trim() !== '0') {
    const scrap = toScaled(input.scrapPercent, 2);
    if (scrap < 0n) return null;
    raw += (raw * scrap + 5000n) / 10000n;
  }
  return raw > 0n ? raw : null;
}

async function nextDependentLine(tx: Tx, client: string, runNumber: string): Promise<number> {
  const found = await rows(tx, sql`
    select coalesce(max(line_number), 0) as line
      from mrp_run_dependent
     where client = ${client} and run_number = ${runNumber}
  `);
  return Number(found[0]?.line ?? 0) + 1;
}

async function parentLots(
  tx: Tx, client: string, runNumber: string, materialNumber: string, plant: string, simulation: boolean,
): Promise<ParentLot[]> {
  if (simulation) {
    const proposed = await rows(tx, sql`
      select quantity::text as quantity, unit, start_date::text as start_date, receipt_date::text as finish_date
        from mrp_run_proposal
       where client = ${client} and run_number = ${runNumber}
         and material_number = ${materialNumber} and plant = ${plant}
         and proposal_type = 'PLANNED_ORDER' and action = 'CREATE' and status = 'PROPOSED'
    `);
    return proposed.map((row) => ({
      orderNumber: null,
      quantity: scaled(row.quantity),
      unit: String(row.unit ?? ''),
      startDate: String(row.start_date),
      finishDate: String(row.finish_date),
    }));
  }
  const standing = await rows(tx, sql`
    select order_number, quantity::text as quantity, unit, start_date::text as start_date, finish_date::text as finish_date
      from planned_order
     where client = ${client} and material_number = ${materialNumber} and plant = ${plant}
       and (
         firming_status = 'FIRMED'
         or order_number in (
           select document_number from mrp_run_proposal
            where client = ${client} and run_number = ${runNumber}
              and material_number = ${materialNumber} and plant = ${plant}
              and proposal_type = 'PLANNED_ORDER' and document_number is not null
              and action in ('CREATE', 'UPDATE', 'RETAIN', 'CONFLICT')
         )
       )
  `);
  return standing.map((row) => ({
    orderNumber: String(row.order_number),
    quantity: scaled(row.quantity),
    unit: String(row.unit ?? ''),
    startDate: String(row.start_date),
    finishDate: String(row.finish_date),
  }));
}

export async function explodePlannedSupply(tx: Tx, input: {
  client: string;
  runNumber: string;
  actor: string;
  materialNumber: string;
  plant: string;
  procurementType: string;
  simulationOnly: boolean;
  productionVersion?: string | null;
  level: number;
  path: string;
}): Promise<ExplosionResult> {
  const diagnostics: ExplosionDiagnostic[] = [];
  const components: ExplosionComponent[] = [];
  if (input.procurementType !== 'MAKE') {
    if (input.procurementType === 'BUY') {
      diagnostics.push({
        severity: 'INFO', code: 'BUY_NOT_EXPLODED',
        message: `${input.materialNumber} is bought. It was not exploded.`,
      });
    }
    return { diagnostics, components };
  }
  if (input.level >= DEPTH_LIMIT) {
    diagnostics.push({
      severity: 'WARNING', code: 'DEPTH_LIMIT',
      message: `${input.materialNumber} is below the explosion depth. The branch stopped.`,
    });
    return { diagnostics, components };
  }
  const lots = await parentLots(tx, input.client, input.runNumber, input.materialNumber, input.plant, input.simulationOnly);
  if (lots.length === 0) return { diagnostics, components };
  const seen = new Set<string>();
  for (const lot of lots) {
    await explodeLot(tx, input, lot, diagnostics, components, seen);
  }
  return { diagnostics, components };
}

async function explodeLot(
  tx: Tx,
  input: {
    client: string;
    runNumber: string;
    actor: string;
    materialNumber: string;
    plant: string;
    simulationOnly: boolean;
    productionVersion?: string | null;
    level: number;
    path: string;
  },
  lot: ParentLot,
  diagnostics: ExplosionDiagnostic[],
  components: ExplosionComponent[],
  seen: Set<string>,
): Promise<void> {
  let version;
  try {
    version = await selectProductionVersion(input.client, {
      materialNumber: input.materialNumber,
      plant: input.plant,
      keyDate: lot.finishDate,
      quantity: Number(shown(lot.quantity)).toString(),
      unit: lot.unit,
      productionVersion: input.productionVersion,
      context: 'PLANNING',
    });
  } catch (error) {
    if (error instanceof ProductionVersionError) {
      diagnostics.push({
        severity: 'WARNING',
        code: error.code,
        message: error.message.slice(0, 200),
      });
      return;
    }
    throw error;
  }
  const items = await rows(tx, sql`
    select i.item_number, i.component_material, i.quantity::text as quantity, i.unit,
           i.scrap_percent::text as scrap_percent, i.fixed_quantity, i.bulk_material, i.phantom,
           i.coproduct, i.special_procurement, i.issuing_plant, i.follow_up_material,
           i.valid_from::text as valid_from, i.valid_to::text as valid_to, i.deletion_flag,
           h.base_quantity::text as base_quantity
      from material_bom_item i
      join material_bom h
        on h.client = i.client and h.material_number = i.material_number and h.plant = i.plant
       and h.usage = i.usage and h.alternative = i.alternative
     where i.client = ${input.client}
       and i.material_number = ${version.materialNumber}
       and i.plant = ${version.plant}
       and i.usage = ${version.bomUsage}
       and i.alternative = ${version.bomAlternative}
       and i.deletion_flag = ' '
       and h.deletion_flag = ' '
  `);
  const kept = new Set<string>();
  let line = await nextDependentLine(tx, input.client, input.runNumber);
  for (const item of items) {
    const itemNumber = String(item.item_number);
    const component = item.component_material == null ? '' : String(item.component_material);
    if (String(item.valid_from) > lot.startDate || String(item.valid_to) < lot.startDate) {
      diagnostics.push({ severity: 'INFO', code: 'ITEM_NOT_VALID', message: `Item ${itemNumber} is not valid on ${lot.startDate}.` });
      continue;
    }
    if (!component || String(item.coproduct) === 'X') {
      diagnostics.push({ severity: 'INFO', code: 'ITEM_NOT_A_COMPONENT', message: `Item ${itemNumber} is not a component demand.` });
      continue;
    }
    if (String(item.bulk_material) === 'X') {
      diagnostics.push({ severity: 'INFO', code: 'BULK_NOT_PLANNED', message: `Item ${itemNumber} is bulk. It was not planned.` });
      continue;
    }
    if (item.issuing_plant && String(item.issuing_plant) !== input.plant) {
      diagnostics.push({
        severity: 'WARNING', code: 'ISSUING_PLANT',
        message: `Item ${itemNumber} issues from ${item.issuing_plant}. A stock transfer is not planned.`,
      });
      continue;
    }
    if (item.special_procurement && String(item.special_procurement).trim()) {
      diagnostics.push({
        severity: 'WARNING', code: 'SPECIAL_PROCUREMENT',
        message: `Item ${itemNumber} has special procurement ${item.special_procurement}. It was not redirected.`,
      });
      continue;
    }
    const raw = componentRequirementQuantity({
      parentQuantity: lot.quantity,
      itemQuantity: scaled(item.quantity),
      baseQuantity: scaled(item.base_quantity),
      scrapPercent: item.scrap_percent == null ? null : String(item.scrap_percent),
      fixed: String(item.fixed_quantity) === 'X',
    });
    if (raw == null) {
      diagnostics.push({ severity: 'WARNING', code: 'COMPONENT_QUANTITY', message: `Item ${itemNumber} has no positive quantity.` });
      continue;
    }
    if (item.follow_up_material) {
      diagnostics.push({
        severity: 'INFO', code: 'FOLLOW_UP_NOT_APPLIED',
        message: `Item ${itemNumber} names a follow-up material. The stored component was used.`,
      });
    }
    const path = `${input.path}/${component}`;
    if (path.split('/').filter(Boolean).slice(0, -1).includes(component)) {
      diagnostics.push({
        severity: 'WARNING', code: 'BOM_CYCLE',
        message: `${component} is already on this explosion. The branch stopped.`,
      });
      continue;
    }
    if (String(item.phantom) === 'X') {
      diagnostics.push({ severity: 'INFO', code: 'PHANTOM', message: `${component} is a phantom. It was not proposed.` });
      await explodePhantom(tx, input, lot, component, raw, path, diagnostics, components, seen, kept);
      continue;
    }
    let baseQuantity = raw;
    let unit = String(item.unit ?? '');
    try {
      const converted = await toBaseQuantity(tx, input.client, {
        materialNumber: component,
        quantity: Number(shown(raw)),
        entryUnit: unit,
      });
      baseQuantity = scaled(converted.baseQuantity);
      unit = converted.baseUnit;
    } catch (error) {
      const message = error instanceof UnitConversionError ? error.message : 'The component unit could not be converted.';
      diagnostics.push({ severity: 'WARNING', code: 'UNIT', message: message.slice(0, 200) });
      continue;
    }
    if (baseQuantity <= 0n) {
      diagnostics.push({ severity: 'WARNING', code: 'COMPONENT_QUANTITY', message: `Item ${itemNumber} rounded to zero.` });
      continue;
    }
    const source = version.materialNumber;
    kept.add(`${source}/${itemNumber}`);
    await tx.execute(sql`
      insert into mrp_run_dependent (
        client, run_number, line_number, parent_material, parent_order_number, component_material, plant,
        quantity, unit, requirement_date, production_version, bom_usage, bom_alternative, bom_item,
        source_material, bom_level, created_by
      ) values (
        ${input.client}, ${input.runNumber}, ${line}, ${input.materialNumber}, ${lot.orderNumber}, ${component}, ${input.plant},
        ${shown(baseQuantity)}, ${unit}, ${lot.startDate}, ${version.productionVersion}, ${version.bomUsage},
        ${version.bomAlternative}, ${itemNumber}, ${source}, ${input.level + 1}, ${input.actor}
      )
    `);
    line += 1;
    if (lot.orderNumber && !input.simulationOnly) {
      await tx.execute(sql`
        insert into mrp_dependent_requirement (
          client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
          requirement_date, parent_material, production_version, bom_usage, bom_alternative, status, run_number,
          version, created_by
        ) values (
          ${input.client}, ${lot.orderNumber}, ${source}, ${itemNumber}, ${component}, ${input.plant},
          ${shown(baseQuantity)}, ${unit}, ${lot.startDate}, ${input.materialNumber}, ${version.productionVersion},
          ${version.bomUsage}, ${version.bomAlternative}, 'OPEN', ${input.runNumber}, 1, ${input.actor}
        )
        on conflict (client, parent_order_number, source_material, item_number) do update set
          material_number = excluded.material_number,
          quantity = excluded.quantity,
          unit = excluded.unit,
          requirement_date = excluded.requirement_date,
          production_version = excluded.production_version,
          bom_usage = excluded.bom_usage,
          bom_alternative = excluded.bom_alternative,
          status = 'OPEN',
          run_number = excluded.run_number,
          version = mrp_dependent_requirement.version + 1,
          changed_by = excluded.created_by,
          changed_at = now()
      `);
    }
    const key = `${input.plant}/${component}`;
    if (!seen.has(key)) {
      seen.add(key);
      components.push({ materialNumber: component, plant: input.plant, level: input.level + 1, path });
    }
  }
  if (lot.orderNumber && !input.simulationOnly) {
    const open = await rows(tx, sql`
      select source_material, item_number
        from mrp_dependent_requirement
       where client = ${input.client} and parent_order_number = ${lot.orderNumber} and status = 'OPEN'
    `);
    for (const row of open) {
      const key = `${row.source_material}/${row.item_number}`;
      if (kept.has(key)) continue;
      await tx.execute(sql`
        update mrp_dependent_requirement
           set status = 'CLOSED', version = version + 1, changed_by = ${input.actor}, changed_at = now()
         where client = ${input.client} and parent_order_number = ${lot.orderNumber}
           and source_material = ${String(row.source_material)} and item_number = ${String(row.item_number)}
           and status = 'OPEN'
      `);
    }
  }
  diagnostics.push({
    severity: 'INFO', code: 'BOM_EXPLODED',
    message: `${version.productionVersion} exploded ${items.length} items for ${shown(lot.quantity)} on ${lot.finishDate}.`,
  });
}

async function explodePhantom(
  tx: Tx,
  input: {
    client: string;
    runNumber: string;
    actor: string;
    materialNumber: string;
    plant: string;
    simulationOnly: boolean;
    level: number;
  },
  lot: ParentLot,
  phantom: string,
  phantomQuantity: bigint,
  path: string,
  diagnostics: ExplosionDiagnostic[],
  components: ExplosionComponent[],
  seen: Set<string>,
  kept: Set<string>,
): Promise<void> {
  let version;
  try {
    version = await selectProductionVersion(input.client, {
      materialNumber: phantom,
      plant: input.plant,
      keyDate: lot.finishDate,
      quantity: Number(shown(phantomQuantity)).toString(),
      unit: lot.unit,
      context: 'PLANNING',
    });
  } catch (error) {
    if (error instanceof ProductionVersionError) {
      diagnostics.push({ severity: 'WARNING', code: error.code, message: error.message.slice(0, 200) });
      return;
    }
    throw error;
  }
  const items = await rows(tx, sql`
    select i.item_number, i.component_material, i.quantity::text as quantity, i.unit,
           i.scrap_percent::text as scrap_percent, i.fixed_quantity, i.phantom, i.bulk_material,
           i.valid_from::text as valid_from, i.valid_to::text as valid_to,
           h.base_quantity::text as base_quantity
      from material_bom_item i
      join material_bom h
        on h.client = i.client and h.material_number = i.material_number and h.plant = i.plant
       and h.usage = i.usage and h.alternative = i.alternative
     where i.client = ${input.client} and i.material_number = ${phantom} and i.plant = ${input.plant}
       and i.usage = ${version.bomUsage} and i.alternative = ${version.bomAlternative}
       and i.deletion_flag = ' ' and h.deletion_flag = ' '
  `);
  let line = await nextDependentLine(tx, input.client, input.runNumber);
  for (const item of items) {
    const component = item.component_material == null ? '' : String(item.component_material);
    const itemNumber = String(item.item_number);
    if (!component || String(item.phantom) === 'X' || String(item.bulk_material) === 'X') continue;
    if (String(item.valid_from) > lot.startDate || String(item.valid_to) < lot.startDate) continue;
    if (path.split('/').includes(component)) {
      diagnostics.push({ severity: 'WARNING', code: 'BOM_CYCLE', message: `${component} is already on this explosion. The branch stopped.` });
      continue;
    }
    const raw = componentRequirementQuantity({
      parentQuantity: phantomQuantity,
      itemQuantity: scaled(item.quantity),
      baseQuantity: scaled(item.base_quantity),
      scrapPercent: item.scrap_percent == null ? null : String(item.scrap_percent),
      fixed: String(item.fixed_quantity) === 'X',
    });
    if (raw == null) continue;
    let baseQuantity = raw;
    let unit = String(item.unit ?? '');
    try {
      const converted = await toBaseQuantity(tx, input.client, { materialNumber: component, quantity: Number(shown(raw)), entryUnit: unit });
      baseQuantity = scaled(converted.baseQuantity);
      unit = converted.baseUnit;
    } catch (error) {
      diagnostics.push({
        severity: 'WARNING', code: 'UNIT',
        message: (error instanceof Error ? error.message : 'The component unit could not be converted.').slice(0, 200),
      });
      continue;
    }
    if (baseQuantity <= 0n) continue;
    kept.add(`${phantom}/${itemNumber}`);
    await tx.execute(sql`
      insert into mrp_run_dependent (
        client, run_number, line_number, parent_material, parent_order_number, component_material, plant,
        quantity, unit, requirement_date, production_version, bom_usage, bom_alternative, bom_item,
        source_material, bom_level, created_by
      ) values (
        ${input.client}, ${input.runNumber}, ${line}, ${input.materialNumber}, ${lot.orderNumber}, ${component}, ${input.plant},
        ${shown(baseQuantity)}, ${unit}, ${lot.startDate}, ${version.productionVersion}, ${version.bomUsage},
        ${version.bomAlternative}, ${itemNumber}, ${phantom}, ${input.level + 1}, ${input.actor}
      )
    `);
    line += 1;
    if (lot.orderNumber && !input.simulationOnly) {
      await tx.execute(sql`
        insert into mrp_dependent_requirement (
          client, parent_order_number, source_material, item_number, material_number, plant, quantity, unit,
          requirement_date, parent_material, production_version, bom_usage, bom_alternative, status, run_number,
          version, created_by
        ) values (
          ${input.client}, ${lot.orderNumber}, ${phantom}, ${itemNumber}, ${component}, ${input.plant},
          ${shown(baseQuantity)}, ${unit}, ${lot.startDate}, ${input.materialNumber}, ${version.productionVersion},
          ${version.bomUsage}, ${version.bomAlternative}, 'OPEN', ${input.runNumber}, 1, ${input.actor}
        )
        on conflict (client, parent_order_number, source_material, item_number) do update set
          material_number = excluded.material_number, quantity = excluded.quantity, unit = excluded.unit,
          requirement_date = excluded.requirement_date, status = 'OPEN', run_number = excluded.run_number,
          version = mrp_dependent_requirement.version + 1, changed_by = excluded.created_by, changed_at = now()
      `);
    }
    const key = `${input.plant}/${component}`;
    if (!seen.has(key)) {
      seen.add(key);
      components.push({ materialNumber: component, plant: input.plant, level: input.level + 1, path: `${path}/${component}` });
    }
  }
}
