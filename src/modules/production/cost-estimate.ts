/**
 * Standard cost estimate — CK11N (create) and CK13N (display). PROD.COST.ESTIMATE.CREATE.
 *
 * One material in one plant on a costing date, costed at a lot size and saved with its itemization.
 * Nothing is released: **this module never writes `material_valuation`** (marking and releasing an
 * estimate to the standard price is CK24, a later item).
 *
 * The quantity structure is the production version's BOM and routing (`selectProductionVersion`,
 * `context: 'COSTING'`), walked with MRP's own quantity formula (`componentRequirementQuantity`), so a
 * scrapped item costs more and a fixed-quantity item does not scale with the lot. Costing is
 * bottom-up: a made component (and a BOTH component that resolves a BOM and a routing) is costed from
 * its own components and operations at the quantity the parent needs; only a bought component, or a
 * BOTH one with no structure, takes its material price. A phantom is costed from its BOM alone and
 * rolled into its parent. The cache key is (material, plant, quantity): with fixed-quantity items the
 * cost per unit varies with quantity, so a material is re-costed when a second use needs another
 * quantity. The total is computed at the lot size and then divided; one unit is never costed and
 * multiplied.
 *
 * Prices: STANDARD price control uses `standard_price`, MOVING_AVERAGE uses `moving_average_price`,
 * each divided by its price unit; the branch taken is stored on every line. A price of zero is refused
 * — an unmaintained price is not a free component. Activities: an operation's quantity measured
 * against its base quantity, at the plan activity price (fixed + variable, per its price unit) of the
 * work centre's cost centre and activity type for the period of the costing date. A work centre
 * with several costing lines, or none, or no activity type, is refused: one operation quantity cannot
 * be split across activity types without formulas, and `formula` is not evaluated.
 *
 * No overhead is applied — there is no costing sheet — and it is stored as zero. The cost component
 * split is by origin: material = every bought component at every level, activity = every operation at
 * every level, so the activity of a made sub-assembly stays visible as activity.
 *
 * Authority: `PROD.COST.ESTIMATE.CREATE` (creating and displaying), judged here from the session, with
 * the signed-in user's Plant scope over the plant.
 */
import { sql } from 'drizzle-orm';

import { type ServiceAuthorityContext } from '../../platform/auth/service-authority';
import { purchasingActor, reachablePlantsInTx } from '../../platform/auth/scope-actor';
import { type Tx, withTenant } from '../../platform/db/client';
import { fromScaled, toScaled } from '../../platform/posting/decimal';
import { planningContext } from '../foundation/activity-rate-definition';
import { toBaseQuantity } from '../inventory/unit-conversion';
import { DEPTH_LIMIT, SCALE, componentRequirementQuantity } from './mrp-explosion';
import { ProductionVersionError, selectProductionVersion } from './production-version';

export const COST_ESTIMATE_CAPABILITY = 'PROD.COST.ESTIMATE.CREATE';
export const COST_ESTIMATE_ROUTE = '/production/cost-estimate';
export const DEFAULT_PLAN_VERSION = '000';
export const OVERHEAD_NOTE = 'Overhead is zero: no costing sheet or overhead rate exists, so none is applied or approximated.';

export class CostEstimateError extends Error {
  readonly remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CostEstimateError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new CostEstimateError(message, remedy);
}

type Authority = { authorization?: ServiceAuthorityContext };
type Row = Record<string, unknown>;
const rows = (tx: Tx, query: ReturnType<typeof sql>) => tx.execute(query) as unknown as Promise<Row[]>;
const text = (value: unknown) => (value == null ? null : String(value).trim() || null);
const flag = (value: unknown) => String(value ?? '').trim() === 'X';

// Quantities carry 3 decimals (SCALE), money 4. Every product is divided once, half up, at the end.
const Q = SCALE;
const M = 4;
const q = (value: unknown) => toScaled(String(value ?? '0'), Q);
const m = (value: unknown) => toScaled(String(value ?? '0'), M);
const qShown = (value: bigint) => fromScaled(value, Q);
const mShown = (value: bigint) => fromScaled(value, M);

function divRound(numerator: bigint, denominator: bigint): bigint {
  if (denominator <= 0n) throw new CostEstimateError('Division by a non-positive number in the costing arithmetic.');
  return numerator >= 0n ? (numerator + denominator / 2n) / denominator : -((-numerator + denominator / 2n) / denominator);
}

/** The cost of `quantity` units at `price` per `priceUnit` units (quantity 3 dp, price 4 dp, price unit 3 dp → 4 dp). */
export function materialAmount(quantity: bigint, price: bigint, priceUnit: bigint): bigint {
  return divRound(quantity * price, priceUnit);
}

/**
 * The cost of an operation for `quantity` units: operation quantity / base quantity per unit, times the
 * lot, times (fixed + variable) / price unit. Rates carry 2 dp, the price unit is an integer.
 */
export function activityAmount(operationQuantity: bigint, baseQuantity: bigint, quantity: bigint, ratePerPriceUnit2dp: bigint, priceUnit: bigint): bigint {
  return divRound(operationQuantity * quantity * ratePerPriceUnit2dp, 10n * baseQuantity * priceUnit);
}

// ── Inputs and views ────────────────────────────────────────────────────────

export interface CostEstimateInput {
  client: string;
  materialNumber: string;
  plant: string;
  costingDate: string;
  /** In the material's base unit. Default: the BOM base quantity. */
  costingLotSize?: string;
  /** Two characters. Default: the next one free for the material, plant and date, starting at 01. */
  costingVersion?: string;
  /** Plan version of the activity prices. Default '000'. */
  planVersion?: string;
  /** A repeat of the same key returns the estimate it created. */
  requestKey?: string;
  actor: string;
}

export interface CostEstimateItemView {
  lineNumber: number;
  itemType: 'MATERIAL' | 'ACTIVITY';
  level: number;
  componentMaterial: string | null;
  operationNumber: string | null;
  workCenter: string | null;
  costCenter: string | null;
  activityType: string | null;
  itemText: string | null;
  quantity: string;
  unit: string | null;
  price: string;
  priceUnit: string;
  priceSource: 'STANDARD' | 'MOVING_AVERAGE' | 'COSTED' | 'ACTIVITY_PLAN' | 'NOT_COSTED';
  amount: string;
  /** False for a line that only explains the rolled-up line above it. */
  inTotal: boolean;
}

export interface CostEstimateSummary {
  materialNumber: string;
  plant: string;
  costingDate: string;
  costingVersion: string;
  status: 'SAVED' | 'SUPERSEDED';
  costingLotSize: string;
  currency: string;
  totalCost: string;
  unitCost: string;
  costedBy: string;
  costedAt: string;
}

export interface CostEstimateView extends CostEstimateSummary {
  materialName: string | null;
  unit: string;
  materialCost: string;
  activityCost: string;
  overheadCost: string;
  overheadNote: string;
  productionVersion: string;
  controllingArea: string;
  planVersion: string;
  requestKey: string | null;
  items: CostEstimateItemView[];
  /** True when a repeated request key returned an estimate that already stood. */
  replayed: boolean;
}

// ── The walk ────────────────────────────────────────────────────────────────

interface Line {
  itemType: 'MATERIAL' | 'ACTIVITY';
  level: number;
  componentMaterial: string | null;
  operationNumber: string | null;
  workCenter: string | null;
  costCenter: string | null;
  activityType: string | null;
  itemText: string | null;
  quantity: bigint;
  unit: string | null;
  price: bigint;
  priceUnit: bigint;
  priceSource: CostEstimateItemView['priceSource'];
  amount: bigint;
  inTotal: boolean;
}

/** One assembly costed at one quantity. Its lines are relative: its own activities at level 0, its components at 1. */
interface Costed {
  total: bigint;
  material: bigint;
  activity: bigint;
  lines: Line[];
  productionVersion: string;
}

interface Run {
  tx: Tx;
  client: string;
  date: string;
  planVersion: string;
  plantCurrency: string;
  areas: Set<string>;
  /** currency → what carried it, for the refusal that names every currency. */
  currencies: Map<string, Set<string>>;
  cache: Map<string, Costed>;
  periods: Map<string, { fiscalYear: number; period: number; currency: string }>;
}

function note(run: Run, currency: string, source: string): void {
  const sources = run.currencies.get(currency) ?? new Set<string>();
  sources.add(source);
  run.currencies.set(currency, sources);
}

interface Structure {
  productionVersion: string;
  bom: { materialNumber: string; plant: string; usage: string; alternative: string; baseQuantity: bigint; baseUnit: string };
  routing: { taskListType: string; routingGroup: string; groupCounter: string } | null;
}

async function baseUnitOf(tx: Tx, client: string, materialNumber: string): Promise<string> {
  const [row] = await rows(tx, sql`select base_unit from material where client = ${client} and material_number = ${materialNumber}`);
  if (!row) fail(`Material ${materialNumber} does not stand.`, 'Choose a material from the material master (/inventory/materials).');
  return String(row.base_unit ?? '');
}

async function procurementOf(tx: Tx, client: string, materialNumber: string, plant: string): Promise<string | null | undefined> {
  const [row] = await rows(tx, sql`select procurement_type from material_plant where client = ${client} and material_number = ${materialNumber} and plant = ${plant}`);
  return row ? text(row.procurement_type) : undefined;
}

/**
 * The BOM and (when `needRouting`) the routing a material is costed from: its production version at
 * the quantity, the BOM and routing released for costing and valid on the costing date. Returns null
 * only when `soft` and no production version resolves (a BOTH material without a structure).
 */
async function structureOf(run: Run, materialNumber: string, plant: string, quantity: bigint, needRouting: boolean, soft: boolean): Promise<Structure | null> {
  const { tx, client, date } = run;
  const unit = await baseUnitOf(tx, client, materialNumber);
  let version;
  try {
    version = await selectProductionVersion(client, {
      materialNumber, plant, keyDate: date, quantity: qShown(quantity), unit, context: 'COSTING',
    }, tx);
  } catch (error) {
    if (!(error instanceof ProductionVersionError)) throw error;
    if (soft) return null;
    fail(
      `No production version resolves for ${materialNumber} in plant ${plant} on ${date} at ${qShown(quantity)} ${unit}: ${error.message}`,
      `${error.remedy ? `${error.remedy} ` : ''}Maintain the production version at /production/production-versions.`,
    );
  }
  const [bom] = await rows(tx, sql`
    select b.material_number, b.plant, b.usage, b.alternative, b.base_quantity::text as base_quantity, b.base_unit, b.status,
           b.valid_from::text as valid_from, b.valid_to::text as valid_to, b.deletion_flag, coalesce(s.released_for_costing, ' ') as released
      from material_bom b
      left join bom_status s on s.client = b.client and s.status = b.status
     where b.client = ${client} and b.material_number = ${materialNumber} and b.plant = ${plant}
       and b.usage = ${version.bomUsage} and b.alternative = ${version.bomAlternative}`);
  if (!bom) fail(`No BOM resolves for ${materialNumber} in plant ${plant}: production version ${version.productionVersion} names BOM ${version.bomUsage}/${version.bomAlternative}, which does not stand.`, 'Correct the production version at /production/production-versions.');
  if (flag(bom.deletion_flag) || String(bom.valid_from) > date || String(bom.valid_to) < date) {
    fail(`BOM ${version.bomUsage}/${version.bomAlternative} of ${materialNumber} in plant ${plant} is not valid on ${date}.`, 'Choose a costing date inside the BOM validity, or another production version.');
  }
  if (!flag(bom.released)) {
    fail(`BOM ${version.bomUsage}/${version.bomAlternative} of ${materialNumber} (status ${text(bom.status) ?? 'none'}) is not released for costing.`, 'Set "released for costing" on the BOM status (/production/boms configuration), or choose another status.');
  }
  if (String(bom.base_unit ?? '') !== unit) {
    fail(`BOM ${version.bomUsage}/${version.bomAlternative} of ${materialNumber} has base unit ${text(bom.base_unit)}, but the material base unit is ${unit}.`, 'Correct the BOM base unit so both agree.');
  }
  let routing: Structure['routing'] = null;
  if (needRouting) {
    if (!version.taskListType || !version.routingGroup || !version.groupCounter) {
      fail(`No routing resolves for ${materialNumber} in plant ${plant}: production version ${version.productionVersion} names none. A made material with no routing has no activity cost.`, 'Add the routing to the production version at /production/production-versions.');
    }
    const [head] = await rows(tx, sql`
      select r.status, r.valid_from::text as valid_from, r.valid_to::text as valid_to, r.deletion_flag, coalesce(s.released_for_costing, ' ') as released
        from routing r
        left join routing_status s on s.client = r.client and s.status = r.status
       where r.client = ${client} and r.task_list_type = ${version.taskListType} and r.routing_group = ${version.routingGroup} and r.group_counter = ${version.groupCounter}`);
    const named = `${version.taskListType}/${version.routingGroup}/${version.groupCounter}`;
    if (!head) fail(`No routing resolves for ${materialNumber}: routing ${named} does not stand.`, 'Correct the production version at /production/production-versions.');
    if (flag(head.deletion_flag) || String(head.valid_from) > date || String(head.valid_to) < date) {
      fail(`Routing ${named} of ${materialNumber} is not valid on ${date}.`, 'Choose a costing date inside the routing validity, or another production version.');
    }
    if (!flag(head.released)) {
      fail(`Routing ${named} of ${materialNumber} (status ${text(head.status) ?? 'none'}) is not released for costing.`, 'Set "released for costing" on the routing status, or choose another status.');
    }
    routing = { taskListType: version.taskListType, routingGroup: version.routingGroup, groupCounter: version.groupCounter };
  }
  return {
    productionVersion: version.productionVersion,
    bom: { materialNumber, plant, usage: version.bomUsage, alternative: version.bomAlternative, baseQuantity: q(bom.base_quantity), baseUnit: unit },
    routing,
  };
}

async function periodOf(run: Run, area: string): Promise<{ fiscalYear: number; period: number; currency: string }> {
  const known = run.periods.get(area);
  if (known) return known;
  const year = Number(run.date.slice(0, 4));
  for (const fiscalYear of [year, year + 1, year - 1]) {
    const context = await planningContext(run.client, area, fiscalYear);
    if (!context) fail(`Controlling Area ${area} is not defined in this tenant.`, 'Choose a work centre whose cost centre belongs to a defined controlling area.');
    const day = Date.parse(`${run.date}T00:00:00Z`);
    const hit = context.periods.find((p) => p.periodType === 'REGULAR' && Date.parse(`${p.start}T00:00:00Z`) <= day && day <= Date.parse(`${p.end}T00:00:00Z`));
    if (hit) {
      const found = { fiscalYear, period: hit.period, currency: context.currency };
      run.periods.set(area, found);
      return found;
    }
  }
  fail(`No fiscal period of controlling area ${area} contains the costing date ${run.date}.`, 'Choose a costing date inside a fiscal year the controlling area defines (OB29).');
}

async function activityLines(run: Run, materialNumber: string, plant: string, structure: Structure, quantity: bigint): Promise<Line[]> {
  const { tx, client, date } = run;
  const r = structure.routing!;
  const ops = await rows(tx, sql`
    select o.operation_number, o.short_text, o.plant, o.work_center, o.control_key, o.operation_quantity::text as operation_quantity,
           o.operation_unit, o.base_quantity::text as base_quantity, coalesce(k.costing, ' ') as costing, coalesce(k.external_processing, ' ') as external
      from routing_operation o
      left join routing_control_key k on k.client = o.client and k.control_key = o.control_key
     where o.client = ${client} and o.task_list_type = ${r.taskListType} and o.routing_group = ${r.routingGroup} and o.group_counter = ${r.groupCounter}
       and o.deletion_flag <> 'X' and o.valid_from <= ${date}::date and o.valid_to >= ${date}::date
     order by o.execution_order, o.operation_number`);
  if (ops.length === 0) {
    fail(`Routing ${r.taskListType}/${r.routingGroup}/${r.groupCounter} of ${materialNumber} has no operation valid on ${date}. A made material with no operation has no activity cost.`, 'Maintain the routing operations at /production/routings.');
  }
  const lines: Line[] = [];
  for (const op of ops) {
    const number = String(op.operation_number);
    const centre = String(op.work_center ?? '').trim();
    if (flag(op.external)) {
      fail(`Operation ${number} of ${materialNumber} uses control key ${text(op.control_key)}, which marks external processing. External processing is not costed.`, 'Cost the material without external processing, or wait for subcontract costing.');
    }
    if (!flag(op.costing)) {
      lines.push({
        itemType: 'ACTIVITY', level: 0, componentMaterial: null, operationNumber: number, workCenter: centre || null, costCenter: null, activityType: null,
        itemText: `Operation ${number}${text(op.short_text) ? ` ${text(op.short_text)}` : ''} is not relevant for costing (control key ${text(op.control_key) ?? 'none'}); not costed.`,
        quantity: 0n, unit: text(op.operation_unit), price: 0n, priceUnit: 1000n, priceSource: 'NOT_COSTED', amount: 0n, inTotal: true,
      });
      continue;
    }
    if (!centre) fail(`Operation ${number} of ${materialNumber} names no work centre, so it has no cost centre or activity type.`, 'Assign a work centre to the operation at /production/routings.');
    const opPlant = text(op.plant) ?? plant;
    const costing = await rows(tx, sql`
      select controlling_area, cost_center, activity_type from work_center_costing
       where client = ${client} and plant = ${opPlant} and work_center = ${centre}
         and valid_from <= ${date}::date and valid_to >= ${date}::date
       order by line_number`);
    if (costing.length === 0) fail(`Work centre ${centre} (plant ${opPlant}) has no costing line valid on ${date}, so operation ${number} of ${materialNumber} has no cost centre.`, 'Assign a cost centre and activity type to the work centre (/production/work-centers).');
    if (costing.length > 1) {
      fail(
        `Work centre ${centre} has ${costing.length} costing lines on ${date} (activity types ${costing.map((c) => text(c.activity_type) ?? 'none').join(', ')}). One operation quantity cannot be split across activity types without formulas, and formulas are not evaluated.`,
        'Keep one costing line on the work centre for the costing date.',
      );
    }
    const line = costing[0]!;
    const activityType = text(line.activity_type);
    const area = String(line.controlling_area);
    const costCenter = String(line.cost_center);
    if (!activityType) fail(`The costing line of work centre ${centre} has no activity type, so operation ${number} of ${materialNumber} has no activity price.`, 'Set the activity type on the work centre costing line.');
    run.areas.add(area);
    const when = await periodOf(run, area);
    note(run, when.currency, `controlling area ${area}`);
    const [rate] = await rows(tx, sql`
      select fixed_price::text as fixed_price, variable_price::text as variable_price, price_unit from activity_rate
       where client = ${client} and controlling_area = ${area} and plan_version = ${run.planVersion} and fiscal_year = ${when.fiscalYear}
         and period = ${when.period} and cost_center = ${costCenter} and activity_type = ${activityType}`);
    if (!rate) {
      fail(`No activity price for cost centre ${costCenter}, activity type ${activityType}, period ${when.period}/${when.fiscalYear}, plan version ${run.planVersion} (operation ${number} of ${materialNumber}).`, 'Plan the activity price at /controlling/plan-activity-prices or calculate it (KSPI).');
    }
    const rate2 = toScaled(String(rate.fixed_price), 2) + toScaled(String(rate.variable_price), 2);
    const priceUnit = BigInt(Number(rate.price_unit));
    const opQuantity = q(op.operation_quantity);
    const opBase = q(op.base_quantity);
    if (opBase <= 0n || priceUnit <= 0n) fail(`Operation ${number} of ${materialNumber} has no positive base quantity or its activity price has no price unit.`, 'Correct the routing operation or the activity price.');
    lines.push({
      itemType: 'ACTIVITY', level: 0, componentMaterial: null, operationNumber: number, workCenter: centre, costCenter, activityType,
      itemText: `Operation ${number}${text(op.short_text) ? ` ${text(op.short_text)}` : ''} of ${materialNumber}`,
      quantity: divRound(opQuantity * quantity, opBase), unit: text(op.operation_unit),
      price: rate2 * 100n, priceUnit: priceUnit * 1000n, priceSource: 'ACTIVITY_PLAN',
      amount: activityAmount(opQuantity, opBase, quantity, rate2, priceUnit), inTotal: true,
    });
  }
  return lines;
}

async function priceOf(run: Run, materialNumber: string, plant: string): Promise<{ price: bigint; priceUnit: bigint; source: 'STANDARD' | 'MOVING_AVERAGE' }> {
  const [row] = await rows(run.tx, sql`
    select price_control, standard_price::text as standard_price, moving_average_price::text as moving_average_price,
           price_unit::text as price_unit, currency
      from material_valuation where client = ${run.client} and material_number = ${materialNumber} and valuation_area = ${plant}`);
  if (!row) fail(`Component ${materialNumber} has no valuation row in valuation area ${plant}, so it has no price.`, 'Maintain the material valuation (MM01 accounting view).');
  const source = String(row.price_control).trim() === 'MOVING_AVERAGE' ? 'MOVING_AVERAGE' : 'STANDARD';
  const price = m(source === 'STANDARD' ? row.standard_price : row.moving_average_price);
  const priceUnit = q(row.price_unit);
  if (priceUnit <= 0n) fail(`Component ${materialNumber} has price unit ${qShown(priceUnit)} in valuation area ${plant}.`, 'Correct the price unit in the material valuation.');
  if (price <= 0n) {
    fail(
      `Component ${materialNumber} has a ${source === 'STANDARD' ? 'standard' : 'moving average'} price of zero in valuation area ${plant} (price control ${source}). An unmaintained price is not a free component.`,
      'Maintain the price (/inventory/price-change), then cost again.',
    );
  }
  note(run, String(row.currency).trim(), `valuation area ${plant} (${materialNumber})`);
  return { price, priceUnit, source };
}

function shift(lines: Line[], by: number): Line[] {
  return lines.map((l) => ({ ...l, level: l.level + by, inTotal: false }));
}

/**
 * Cost one assembly at `quantity` (its base unit). `kind`: TOP and MADE need a BOM and a routing;
 * BOTH takes a price when no production version resolves; PHANTOM is costed from its BOM alone.
 */
async function costAssembly(run: Run, materialNumber: string, plant: string, quantity: bigint, kind: 'TOP' | 'MADE' | 'BOTH' | 'PHANTOM', stack: string[]): Promise<Costed | null> {
  const key = `${materialNumber}|${plant}|${quantity}${kind === 'PHANTOM' ? '|P' : ''}`;
  const cached = run.cache.get(key);
  if (cached) return cached;
  if (stack.includes(materialNumber)) fail(`The BOM contains a cycle: ${[...stack, materialNumber].join(' → ')}.`, 'Correct the BOMs so a material is not its own component.');
  if (stack.length >= DEPTH_LIMIT) fail(`The BOM is deeper than ${DEPTH_LIMIT} levels at ${[...stack, materialNumber].join(' → ')}.`, 'Check the BOMs for an unintended chain.');
  const path = [...stack, materialNumber];

  const structure = await structureOf(run, materialNumber, plant, quantity, kind !== 'PHANTOM', kind === 'BOTH');
  if (!structure) return null;

  const items = await rows(run.tx, sql`
    select i.item_number, i.component_material, i.quantity::text as quantity, i.unit, i.scrap_percent::text as scrap_percent,
           i.fixed_quantity, i.phantom, i.coproduct, i.special_procurement, c.material_entry
      from material_bom_item i
      left join bom_item_category c on c.client = i.client and c.category = i.item_category
     where i.client = ${run.client} and i.material_number = ${materialNumber} and i.plant = ${plant}
       and i.usage = ${structure.bom.usage} and i.alternative = ${structure.bom.alternative}
       and i.deletion_flag <> 'X' and i.valid_from <= ${run.date}::date and i.valid_to >= ${run.date}::date
     order by i.item_number`);

  let material = 0n;
  let activity = 0n;
  const out: Line[] = [];

  if (structure.routing) {
    for (const line of await activityLines(run, materialNumber, plant, structure, quantity)) {
      out.push(line);
      activity += line.amount;
    }
  }

  for (const item of items) {
    const component = text(item.component_material);
    const number = String(item.item_number);
    if (!component || String(item.material_entry ?? '').trim() === '-') continue; // a text item has no cost
    if (flag(item.coproduct)) {
      fail(`Item ${number} (${component}) of ${materialNumber} is a co-product. Costing a co-product needs an apportionment structure that does not exist.`, 'Remove the co-product from the BOM before costing, or wait for co-product costing.');
    }
    if (text(item.special_procurement)) {
      fail(`Item ${number} (${component}) of ${materialNumber} carries special procurement ${text(item.special_procurement)}. Special procurement and external processing are not costed.`, 'Cost the BOM without special procurement, or wait for subcontract costing.');
    }
    const raw = componentRequirementQuantity({
      parentQuantity: quantity,
      itemQuantity: q(item.quantity),
      baseQuantity: structure.bom.baseQuantity,
      scrapPercent: item.scrap_percent == null ? null : String(item.scrap_percent),
      fixed: flag(item.fixed_quantity),
    });
    if (raw == null) fail(`Item ${number} (${component}) of ${materialNumber} has no positive quantity at ${qShown(quantity)}.`, 'Correct the BOM item quantity.');
    let required: bigint;
    let componentUnit: string;
    try {
      const converted = await toBaseQuantity(run.tx, run.client, { materialNumber: component, quantity: Number(qShown(raw)), entryUnit: text(item.unit) ?? '' });
      required = q(converted.baseQuantity);
      componentUnit = converted.baseUnit;
    } catch {
      fail(`Unit conversion fails for ${component}: item ${number} of ${materialNumber} is entered in ${text(item.unit) ?? '(none)'}, the material base unit is ${await baseUnitOf(run.tx, run.client, component).catch(() => '(unknown)')}.`, 'Maintain the unit conversion of the component (INV.STOCK.UOM).');
    }
    if (required <= 0n) fail(`Item ${number} (${component}) of ${materialNumber} rounds to zero in its base unit.`, 'Correct the BOM item quantity.');

    const type = flag(item.phantom) ? 'PHANTOM' : await procurementOf(run.tx, run.client, component, plant);
    const sub = type === 'PHANTOM' || type === 'MAKE' || type === 'BOTH'
      ? await costAssembly(run, component, plant, required, type === 'PHANTOM' ? 'PHANTOM' : type === 'MAKE' ? 'MADE' : 'BOTH', path)
      : null;
    if (sub) {
      // A made component's line is the roll-up of its own lines, which follow it as explanation.
      out.push({
        itemType: 'MATERIAL', level: 1, componentMaterial: component, operationNumber: null, workCenter: null, costCenter: null, activityType: null,
        itemText: type === 'PHANTOM' ? 'Phantom, rolled into its parent' : `Made, costed from its own components and operations (version ${sub.productionVersion})`,
        quantity: required, unit: componentUnit, price: divRound(sub.total * 1000n, required), priceUnit: 1000n, priceSource: 'COSTED', amount: sub.total, inTotal: true,
      });
      out.push(...shift(sub.lines, 1));
      material += sub.material;
      activity += sub.activity;
      continue;
    }
    const price = await priceOf(run, component, plant);
    const amount = materialAmount(required, price.price, price.priceUnit);
    out.push({
      itemType: 'MATERIAL', level: 1, componentMaterial: component, operationNumber: null, workCenter: null, costCenter: null, activityType: null,
      itemText: null, quantity: required, unit: componentUnit, price: price.price, priceUnit: price.priceUnit, priceSource: price.source, amount, inTotal: true,
    });
    material += amount;
  }

  const costed: Costed = { total: material + activity, material, activity, lines: out, productionVersion: structure.productionVersion };
  run.cache.set(key, costed);
  return costed;
}

// ── Reading ─────────────────────────────────────────────────────────────────

const itemOf = (r: Row): CostEstimateItemView => ({
  lineNumber: Number(r.line_number), itemType: r.item_type as 'MATERIAL' | 'ACTIVITY', level: Number(r.level),
  componentMaterial: text(r.component_material), operationNumber: text(r.operation_number), workCenter: text(r.work_center),
  costCenter: text(r.cost_center), activityType: text(r.activity_type), itemText: text(r.item_text),
  quantity: String(r.quantity), unit: text(r.unit), price: String(r.price), priceUnit: String(r.price_unit),
  priceSource: r.price_source as CostEstimateItemView['priceSource'], amount: String(r.amount), inTotal: r.in_total === true,
});

const summaryOf = (r: Row): CostEstimateSummary => ({
  materialNumber: String(r.material_number), plant: String(r.plant), costingDate: String(r.costing_date), costingVersion: String(r.costing_version),
  status: r.status as 'SAVED' | 'SUPERSEDED', costingLotSize: String(r.costing_lot_size), currency: String(r.currency).trim(),
  totalCost: String(r.total_cost), unitCost: String(r.unit_cost), costedBy: String(r.costed_by), costedAt: new Date(String(r.costed_at)).toISOString(),
});

async function readInTx(tx: Tx, client: string, key: { materialNumber: string; plant: string; costingDate: string; costingVersion?: string }, replayed = false): Promise<CostEstimateView | null> {
  const [head] = await rows(tx, sql`
    select h.material_number, h.plant, h.costing_date::text as costing_date, h.costing_version, h.status, h.costing_lot_size::text as costing_lot_size,
           h.currency, h.total_cost::text as total_cost, h.unit_cost::text as unit_cost, h.material_cost::text as material_cost,
           h.activity_cost::text as activity_cost, h.overhead_cost::text as overhead_cost, h.production_version, h.controlling_area,
           h.plan_version, h.request_key, h.costed_by, h.costed_at, m.description, m.base_unit
      from material_cost_estimate h
      left join material m on m.client = h.client and m.material_number = h.material_number
     where h.client = ${client} and h.material_number = ${key.materialNumber} and h.plant = ${key.plant} and h.costing_date = ${key.costingDate}::date
       ${key.costingVersion ? sql`and h.costing_version = ${key.costingVersion}` : sql`and h.status = 'SAVED'`}
     order by h.costing_version desc limit 1`);
  if (!head) return null;
  const items = await rows(tx, sql`
    select line_number, item_type, level, component_material, operation_number, work_center, cost_center, activity_type, item_text,
           quantity::text as quantity, unit, price::text as price, price_unit::text as price_unit, price_source, amount::text as amount, in_total
      from material_cost_estimate_item
     where client = ${client} and material_number = ${key.materialNumber} and plant = ${key.plant}
       and costing_date = ${key.costingDate}::date and costing_version = ${String(head.costing_version)}
     order by line_number`);
  return {
    ...summaryOf(head), materialName: text(head.description), unit: String(head.base_unit ?? ''),
    materialCost: String(head.material_cost), activityCost: String(head.activity_cost), overheadCost: String(head.overhead_cost), overheadNote: OVERHEAD_NOTE,
    productionVersion: String(head.production_version), controllingArea: String(head.controlling_area), planVersion: String(head.plan_version),
    requestKey: text(head.request_key), items: items.map(itemOf), replayed,
  };
}

async function judge(tx: Tx, client: string, authorization: ServiceAuthorityContext | undefined, plant: string): Promise<string> {
  const actor = await purchasingActor(tx, client, authorization, [COST_ESTIMATE_CAPABILITY], (m, r) => new CostEstimateError(m, r ?? ''));
  const reachable = await reachablePlantsInTx(tx, client, actor);
  // A plant out of reach answers exactly as one that does not stand.
  if (!reachable.includes(plant)) fail(`Plant ${plant} does not stand.`, 'Choose a plant that exists.');
  return actor.username;
}

function dateOf(value: string | undefined): string {
  const date = (value ?? '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const probe = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  if (!match || !probe || probe.toISOString().slice(0, 10) !== date) fail(`Costing date ${date || '(blank)'} is not a calendar date.`, 'Enter the date as YYYY-MM-DD.');
  return date;
}

// ── Create ──────────────────────────────────────────────────────────────────

/** Cost a material, save the estimate with its itemization, and return it. Writes nothing else; never a price. */
export async function createCostEstimate(input: CostEstimateInput, options: Authority = {}): Promise<CostEstimateView> {
  const materialNumber = String(input.materialNumber ?? '').trim().toUpperCase();
  const plant = String(input.plant ?? '').trim().toUpperCase();
  if (!materialNumber) fail('Name the material to cost.', 'Enter a material number.');
  if (!plant) fail('Name the plant to cost in.', 'Enter a plant.');
  const date = dateOf(input.costingDate);
  const planVersion = (input.planVersion ?? '').trim().toUpperCase() || DEFAULT_PLAN_VERSION;
  if (!/^[A-Z0-9]{1,3}$/.test(planVersion)) fail(`Plan version ${planVersion} is not valid.`, 'A plan version is up to three letters or digits.');
  const named = (input.costingVersion ?? '').trim().toUpperCase();
  if (named && !/^[A-Z0-9]{2}$/.test(named)) fail(`Costing version ${named} is not valid.`, 'A costing version is two letters or digits, e.g. 01. Leave it blank to number automatically.');
  const requestKey = (input.requestKey ?? '').trim() || null;
  let requested: bigint | null = null;
  if ((input.costingLotSize ?? '').trim()) {
    try {
      requested = toScaled(input.costingLotSize!.trim(), Q);
    } catch {
      fail(`Costing lot size ${input.costingLotSize} is not a number.`, 'Enter a positive quantity in the material\'s base unit.');
    }
    if (requested <= 0n) fail(`Costing lot size ${input.costingLotSize} is not positive.`, 'Enter a positive quantity in the material\'s base unit.');
  }

  return withTenant(input.client, async (tx) => {
    const username = await judge(tx, input.client, options.authorization, plant);
    const client = input.client;

    if (requestKey) {
      const [prior] = await rows(tx, sql`
        select material_number, plant, costing_date::text as costing_date, costing_version from material_cost_estimate
         where client = ${client} and request_key = ${requestKey}`);
      if (prior) {
        if (String(prior.material_number) !== materialNumber || String(prior.plant) !== plant || String(prior.costing_date) !== date) {
          fail(`This request key already created the estimate of ${prior.material_number} in plant ${prior.plant} for ${prior.costing_date}.`, 'Reload the screen and cost again.');
        }
        return (await readInTx(tx, client, { materialNumber, plant, costingDate: date, costingVersion: String(prior.costing_version) }, true))!;
      }
    }

    const [master] = await rows(tx, sql`select base_unit from material where client = ${client} and material_number = ${materialNumber}`);
    if (!master) fail(`Material ${materialNumber} does not stand.`, 'Choose a material from the material master (/inventory/materials).');
    const procurement = await procurementOf(tx, client, materialNumber, plant);
    if (procurement === undefined) fail(`Material ${materialNumber} is not maintained in plant ${plant}.`, 'Choose a plant the material is extended to (MM01 plant view).');
    if (procurement !== 'MAKE' && procurement !== 'BOTH') {
      fail(`Material ${materialNumber} has procurement type ${procurement ?? 'none'} in plant ${plant}. A bought material has a price; it has no cost estimate.`, 'Cost a material that is made in house (procurement type MAKE, or BOTH with a production version).');
    }
    const [plantRow] = await rows(tx, sql`
      select p.company_code, c.currency from plant p left join company_code c on c.client = p.client and c.company_code = p.company_code
       where p.client = ${client} and p.plant = ${plant}`);
    if (!plantRow) fail(`Plant ${plant} does not stand.`, 'Choose a plant that exists.');
    if (!plantRow.company_code || !plantRow.currency) fail(`Plant ${plant} is assigned to no company code with a currency, so its currency is unknown.`, 'Assign the plant to a company code (/config/plants).');
    const plantCurrency = String(plantRow.currency).trim();

    const run: Run = {
      tx, client, date, planVersion, plantCurrency, areas: new Set(), currencies: new Map(), cache: new Map(), periods: new Map(),
    };
    note(run, plantCurrency, `company code ${plantRow.company_code} of plant ${plant}`);

    // The lot size: given, or the BOM base quantity. Resolve once at the given (or unit) quantity to learn the base.
    let lot = requested;
    if (lot === null) {
      const probe = await structureOf(run, materialNumber, plant, 1000n, false, false);
      lot = probe!.bom.baseQuantity;
      if (lot <= 0n) fail(`BOM ${probe!.bom.usage}/${probe!.bom.alternative} of ${materialNumber} has no positive base quantity.`, 'Correct the BOM base quantity.');
    }
    const costed = await costAssembly(run, materialNumber, plant, lot, 'TOP', []);
    if (!costed) fail(`Material ${materialNumber} has no production version, BOM and routing to cost.`, 'Maintain the production version at /production/production-versions.');

    if (run.currencies.size > 1) {
      fail(
        `The currencies differ: ${[...run.currencies].map(([currency, sources]) => `${currency} (${[...sources].join(', ')})`).join('; ')}. An estimate is never built from mixed currencies.`,
        'Bring the valuation area, the controlling area and the company code to one currency before costing.',
      );
    }
    if (run.areas.size > 1) fail(`The routing's work centres belong to several controlling areas (${[...run.areas].join(', ')}); one estimate has one.`, 'Assign the work centres to one controlling area.');
    const [controllingArea] = [...run.areas];

    // Version: named, or the next free one for this material, plant and date.
    const existing = await rows(tx, sql`
      select costing_version from material_cost_estimate
       where client = ${client} and material_number = ${materialNumber} and plant = ${plant} and costing_date = ${date}::date`);
    const taken = new Set(existing.map((r) => String(r.costing_version)));
    let version = named;
    if (version) {
      if (taken.has(version)) fail(`Costing version ${version} already stands for ${materialNumber} in plant ${plant} on ${date}.`, 'Leave the costing version blank to number it automatically.');
    } else {
      let n = 1;
      while (taken.has(String(n).padStart(2, '0'))) n += 1;
      if (n > 99) fail(`Ninety-nine estimates already stand for ${materialNumber} on ${date}.`, 'Choose another costing date.');
      version = String(n).padStart(2, '0');
    }

    const total = costed.total;
    const unitCost = divRound(total * 1000n, lot);
    // The older SAVED estimate of the same material, plant and date is evidence: marked, never deleted.
    await tx.execute(sql`
      update material_cost_estimate set status = 'SUPERSEDED', changed_by = ${username}, changed_at = now()
       where client = ${client} and material_number = ${materialNumber} and plant = ${plant} and costing_date = ${date}::date and status = 'SAVED'`);
    await tx.execute(sql`
      insert into material_cost_estimate
        (client, material_number, plant, costing_date, costing_version, status, costing_lot_size, currency, total_cost, unit_cost,
         material_cost, activity_cost, overhead_cost, production_version, controlling_area, plan_version, request_key, costed_by, created_by)
      values (${client}, ${materialNumber}, ${plant}, ${date}::date, ${version}, 'SAVED', ${qShown(lot)}::numeric, ${plantCurrency}, ${mShown(total)}::numeric, ${mShown(unitCost)}::numeric,
              ${mShown(costed.material)}::numeric, ${mShown(costed.activity)}::numeric, 0, ${costed.productionVersion}, ${controllingArea ?? ''}, ${planVersion}, ${requestKey}, ${username}, ${username})`);
    let lineNumber = 0;
    for (const line of costed.lines) {
      lineNumber += 1;
      await tx.execute(sql`
        insert into material_cost_estimate_item
          (client, material_number, plant, costing_date, costing_version, line_number, item_type, level, component_material, operation_number,
           work_center, cost_center, activity_type, item_text, quantity, unit, price, price_unit, price_source, amount, in_total, created_by)
        values (${client}, ${materialNumber}, ${plant}, ${date}::date, ${version}, ${lineNumber}, ${line.itemType}, ${line.level}, ${line.componentMaterial}, ${line.operationNumber},
                ${line.workCenter}, ${line.costCenter}, ${line.activityType}, ${line.itemText}, ${qShown(line.quantity)}::numeric, ${line.unit}, ${mShown(line.price)}::numeric,
                ${qShown(line.priceUnit)}::numeric, ${line.priceSource}, ${mShown(line.amount)}::numeric, ${line.inTotal}, ${username})`);
    }
    return (await readInTx(tx, client, { materialNumber, plant, costingDate: date, costingVersion: version }))!;
  });
}

// ── Display (CK13N) ─────────────────────────────────────────────────────────

/** A saved estimate with its itemization: the named version, or the SAVED one for the date. */
export async function getCostEstimate(
  input: { client: string; materialNumber: string; plant: string; costingDate: string; costingVersion?: string },
  options: Authority = {},
): Promise<CostEstimateView> {
  const materialNumber = String(input.materialNumber ?? '').trim().toUpperCase();
  const plant = String(input.plant ?? '').trim().toUpperCase();
  const date = dateOf(input.costingDate);
  return withTenant(input.client, async (tx) => {
    await judge(tx, input.client, options.authorization, plant);
    const view = await readInTx(tx, input.client, { materialNumber, plant, costingDate: date, costingVersion: (input.costingVersion ?? '').trim().toUpperCase() || undefined });
    if (!view) fail(`No cost estimate stands for ${materialNumber} in plant ${plant} on ${date}${input.costingVersion ? ` (version ${input.costingVersion})` : ''}.`, 'Create the estimate on this screen.');
    return view;
  });
}

/** Every estimate that stands for the material in the plant, newest costing date first, superseded ones marked. */
export async function listCostEstimates(
  input: { client: string; materialNumber: string; plant: string },
  options: Authority = {},
): Promise<CostEstimateSummary[]> {
  const materialNumber = String(input.materialNumber ?? '').trim().toUpperCase();
  const plant = String(input.plant ?? '').trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    await judge(tx, input.client, options.authorization, plant);
    const found = await rows(tx, sql`
      select material_number, plant, costing_date::text as costing_date, costing_version, status, costing_lot_size::text as costing_lot_size,
             currency, total_cost::text as total_cost, unit_cost::text as unit_cost, costed_by, costed_at
        from material_cost_estimate
       where client = ${input.client} and material_number = ${materialNumber} and plant = ${plant}
       order by costing_date desc, costing_version desc`);
    return found.map(summaryOf);
  });
}
