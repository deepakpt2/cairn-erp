/**
 * CO09 slice 1 — the availability of one production order's components, read-only.
 *
 * This is *an availability check over the configuration this ERP already maintains*,
 * computed live and written nowhere. It is not the reference product's CO09 and no claim of parity is
 * made here or on the screen: the parts of CO09 that need a stored commitment, a
 * shortage status, a missing-parts log, a reset, or a storage-location and batch
 * section are refused by name below, because this repository stores none of them
 * (`docs/co09-availability-audit.md` §3). What is implemented is the half the data
 * can carry: resolve the checking group and rule, honour the (group × rule) scope of
 * check, reuse the stock/requirements list as the source of dated elements, and
 * cumulate scoped supply against the component's requirement date.
 *
 * Three rules govern every number this file returns.
 *
 * 1. **A missing record is not configured. It is not a check and it is not a
 *    no-check.** The control row, its checking rule, the material's checking group
 *    and the scope pair must each already stand. Nothing here defaults a rule,
 *    invents a group, or reads a scope the tenant never maintained — the refusal is
 *    the answer, with the transaction that maintains it named as the remedy. That is
 *    the same stance `availability-check.ts` and `checking-control.ts` take.
 * 2. **A committed quantity and a cumulated ATP quantity are different things.**
 *    The reference product writes the committed quantity onto the dependent requirement, so a later
 *    check can only commit what is left. This repository stores no such column and
 *    slice 1 writes nothing, so `committedQuantity` is `null` for every component,
 *    always, and `cumulatedAtp` is labelled as what it is: the balance of the elements
 *    the scope includes, summed to the component's requirement date. The demand being
 *    checked is one *line* of the order, so only that line is left out of its own
 *    balance — another line of the same order and any other document's demand dated the
 *    same day are both counted against it, because the list has no order within a day and
 *    this check does not guess who stands first in line. The gap is shown, not
 *    papered over.
 * 3. **The elements come from the stock/requirements engine, not from a second one.**
 *    `stockRequirementsList` is called per component; this file only *selects* from the
 *    elements it returned and adds them up, and it honours each switch of the scope of
 *    check the way the configuration module defines it: planned orders `A` means firmed
 *    ones only, production orders `F` means released ones, receipts in the past `B`
 *    leaves a past receipt out of coverage. Where the scope asks for something the
 *    engine cannot express at all — a stock split by stock type, which includes its
 *    "include restricted-use batches" switch — the component is
 *    reported UNSUPPORTED rather than answered with a number that quietly means
 *    something else. A switch the engine already agrees with, such as a blank
 *    restricted-use switch when the ledger counts no restricted-use stock at all, is
 *    honoured by answering normally: it is not a reason to refuse.
 *
 * 4. **A quantity is added only in one unit.** Every counted element is read in the unit of
 *    the document it came from and brought into the material's base unit by the conversion the
 *    material carries (`inventory/unit-conversion.ts`). A row whose unit the material cannot
 *    convert, or whose figure the ledger has already netted across two unit streams, refuses the
 *    line rather than being added in or dropped out. So a cumulated figure here is a total of one
 *    unit, and the conversion that produced each row that needed it is stated beside it.
 *
 * Nothing posts, reserves, commits, changes an order, or writes a row. A check that
 * runs twice returns the same answer, and the reason it can promise that is that it
 * keeps nothing between the two calls.
 */
import { and, eq, inArray, sql } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';

import { withTenant, type Tx } from '../../platform/db/client';
import {
  material as materialTable,
  materialPlant,
  productionOrder,
  productionOrderComponent,
} from '../inventory/schema';
import {
  UOM_CAPABILITY,
  UnitConversionError,
  toBaseQuantity,
} from '../inventory/unit-conversion';
import { materialBomItem, plannedOrder, productionCheckingControl } from './schema';
import { listAvailabilityCheck, type ScopeOfCheckRow } from './availability-check';
import { parseProductionOrderStatus } from './production-order-status';
import { StockRequirementsError, stockRequirementsList, type StockRequirementRow } from './stock-requirements';

/**
 * The authority to reach the screen and the authority over the numbers it shows.
 *
 * A dedicated `PROD.ORDER.AVAILABILITY.CHECK` is what the audit's §7 asks for, and it
 * cannot be created here: a capability code that no role can hold until a registry
 * row exists, and registry rows are written by `scripts/seed.ts` (out of bounds) or
 * by a migration (also out of bounds for this slice). So the check demands the two
 * authorities its data already belongs to — the order and the stock/requirements
 * list — which is *narrower* than a new code would be, never wider. Recorded in
 * CAIRN-7 as the one blocker this slice met and did not paper over.
 */
export const ORDER_AVAILABILITY_ORDER_CAPABILITY = 'PROD.ORDER.DISPLAY';
export const ORDER_AVAILABILITY_ELEMENTS_CAPABILITY = 'PROD.MRP.STOCKREQ';
export const ORDER_AVAILABILITY_ROUTE = '/production/order-availability';
export const ORDER_AVAILABILITY_ALIAS = 'CO09';

/** What is refused by name, rendered on the screen so the limit is not a surprise. */
export const ORDER_AVAILABILITY_GAPS: readonly string[] = [
  'No quantity is committed. A check writes nothing, so a second check cannot be reduced by the first, and "committed" is shown as not stored rather than as zero.',
  'Advanced ATP, product allocation and any checking rule beyond the pair maintained here are not this screen.',
  'Sales requirements, delivery requirements and independent requirements are not counted. The scope of check has no switch for them.',
  'Special stock, stock in transfer and blocked stock are not available as separate elements. A scope that asks to split stock by type is refused, not approximated.',
  'Storage-location-level and batch-level sections are not computed. A component requirement carries no storage location, so a location split would invent one.',
  'Subcontracting and dependent reservations are not modelled; a component whose procurement says otherwise is refused.',
  'Replenishment lead time is not a date source. A component without a requirement date is reported undated, not given the order start date.',
  'No shortage status is set and no missing-parts log is stored; the order status is untouched and no release decision is made.',
  'No reset and no collective check over a worklist. Both need the commitment record that is not part of slice 1.',
  'A counted supply is converted by the unit-of-measure conversion the material carries; the requirement being checked is not. A component line in another unit is refused, because converting the demand and measuring it against itself would answer a different question from the one the order holds.',
  'A receipt the list has already netted — a requisition reduced by the orders converted from it, an order reduced by posted movements — is used only in the base unit. A difference taken across two units is not a quantity of either, so it is refused rather than converted afterwards.',
];

/**
 * Selection fields that would ask this screen to do something it does not do. A
 * parameter is refused by name rather than accepted and ignored, so a link that
 * promises a commitment or a storage-location split fails loudly instead of
 * quietly returning a plant-level answer that was asked for at a finer level. CO11N set this precedent.
 */
export const ORDER_AVAILABILITY_UNSUPPORTED_PARAMETERS: Readonly<Record<string, string>> = {
  storageLocation: 'A storage-location level check is not this screen. The component requirement carries no location, so a location split would invent one.',
  batch: 'A batch level check is not this screen. Batch and restricted-use stock are not elements here.',
  specialStock: 'A special-stock indicator is not a selection field of this check. The scope of check does not include or exclude it.',
  commit: 'Committing a quantity is not this screen. A check writes nothing.',
  reserve: 'Reserving is not this screen. A reservation is maintained on its own screen.',
  post: 'Posting a goods movement is not this screen.',
  release: 'Releasing the order is not this screen. The order\u2019s status is not read as a check result and never written by one.',
  reset: 'Resetting an availability is not this screen. No check result is stored, so there is nothing to reset.',
  collective: 'A collective check over a worklist is not this screen. One order is checked per run.',
  missingParts: 'A missing-parts list is not this screen. A shortage is reported on the component it belongs to.',
  rule: 'The checking rule is not chosen here. It is what the checking control names for the order\u2019s plant, order type and business function.',
  scopeOfCheck: 'The scope of check is not chosen here. It is the row maintained for the resolved checking group and rule.',
  mrpArea: 'An MRP area is not a planning scope this ERP carries. The plant is.',
  allocation: 'Product allocation and advanced ATP are not this screen.',
};

/** The refusal for an unsupported selection, or null when the selection is one this check can run. */
export function orderAvailabilityRefusal(selection: Record<string, string>): string | null {
  const named = Object.entries(ORDER_AVAILABILITY_UNSUPPORTED_PARAMETERS)
    .filter(([parameter]) => (selection[parameter] ?? '').trim() !== '')
    .map(([parameter, reason]) => `${parameter}: ${reason}`);
  return named.length === 0 ? null : `The check was not run. ${named.join(' ')}`;
}

/** The authority the check needs. Both halves, or nothing is read. */
export function holdsOrderAvailabilityAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], ORDER_AVAILABILITY_ORDER_CAPABILITY)
    && hasCapability([...held], ORDER_AVAILABILITY_ELEMENTS_CAPABILITY);
}

/** The element types whose inclusion the scope of check decides. */
const SCOPED_ELEMENTS = [
  'PURCHASE_REQUISITION', 'PURCHASE_ORDER', 'PLANNED_ORDER', 'PRODUCTION_ORDER',
  'SAFETY_STOCK', 'RESERVATION', 'DEPENDENT_REQUIREMENT', 'PRODUCTION_COMPONENT',
] as const;
type ScopedElement = (typeof SCOPED_ELEMENTS)[number];

export type ComponentAvailabilityOutcome =
  | 'AVAILABLE' | 'SHORT' | 'NO_ELEMENTS' | 'UNDATED' | 'EXCLUDED'
  | 'NOT_CHECKED' | 'NO_GROUP' | 'NO_SCOPE' | 'UNSUPPORTED';

export type OrderAvailabilityStatus = 'CHECKED' | 'PARTIALLY_CHECKED' | 'NOT_CHECKED';

/** A counted element's figure as its own document holds it, kept beside the base-unit figure. */
export interface ElementUnitConversion {
  quantity: number;
  unit: string;
  /** The factor the material's conversion applied, as `toBaseQuantity` reports it. */
  factor: string;
}

export interface AvailabilityElementRow {
  date: string;
  elementType: string;
  elementLabel: string;
  direction: 'RECEIPT' | 'REQUIREMENT';
  documentNumber: string;
  documentItem: string;
  quantity: number;
  /**
   * The unit `quantity` is in. A counted element is brought into the material's base unit before
   * it enters the balance, so this is that unit whenever the figure means anything; the row's own
   * document quantity and unit stay visible in `convertedFrom`.
   */
  unit: string | null;
  /** Set when this row's document stands in another unit and the material's conversion was applied. */
  convertedFrom: ElementUnitConversion | null;
  /** The running total of the scoped elements through this one. */
  cumulated: number;
  /** True on the component's own demand row when it was left out of its own coverage. */
  ownDemand: boolean;
}

export interface ComponentAvailability {
  itemNumber: string;
  materialNumber: string;
  description: string;
  unit: string;
  baseUnit: string | null;
  requiredQuantity: number;
  /** Null until conversion copied a date. It is never replaced by the order start. */
  requirementDate: string | null;
  checkingGroup: string | null;
  checkingRule: string | null;
  /** The (group × rule) pair the elements were selected by, or null when none stood. */
  scopeKey: string | null;
  outcome: ComponentAvailabilityOutcome;
  /** Always null in slice 1: nothing here commits a quantity. */
  committedQuantity: number | null;
  /** The counted balance at the requirement date, own demand of the checked line excluded.
   *  It is the balance of the whole scope, not of this line, so it is negative when the demand
   *  dated before the line already exceeds what the scope counts. */
  cumulatedAtp: number | null;
  /** How much of this line's required quantity the balance at the date reaches, capped at the
   *  requirement and never below zero. */
  coveredQuantity: number | null;
  /** The supply that must still arrive at the requirement date for this line to be covered: the
   *  line's own requirement plus any deficit the earlier demand left in the cumulated balance.
   *  It therefore can exceed `requiredQuantity`, and `coveredQuantity + shortageQuantity` is not
   *  the requirement whenever the balance in front of the line is negative. It is not the quantity
   *  of this line that stands unmet, and it is not a reservation or a claim on stock. */
  shortageQuantity: number | null;
  earliestFullCoverageDate: string | null;
  message: string | null;
  remedy: string | null;
  elements: AvailabilityElementRow[];
  warnings: string[];
}

export interface OrderAvailabilityResult {
  status: OrderAvailabilityStatus;
  orderNumber: string;
  plant: string;
  orderType: string | null;
  orderStatus: string;
  /** OPJK business function the order's status resolves to. 1 is the order, 2 the release. */
  businessFunction: '1' | '2';
  materialNumber: string;
  orderQuantity: number;
  unitOfMeasure: string;
  checkingRule: string | null;
  scopeKey: string | null;
  components: ComponentAvailability[];
  /** A component the check answered with a number. */
  checkedCount: number;
  refusedCount: number;
  excludedCount: number;
  /** An order-level refusal that comes from the configuration not standing (no order type, no
   *  checking control, a control naming no rule), as opposed to a refusal that comes from the
   *  order or the state of its data. The workbench buckets these differently because one is
   *  maintained by a configurator and the other is not. */
  configurationGap: boolean;
  message: string | null;
  remedy: string | null;
  warnings: string[];
  calculatedAt: string;
}

export class OrderAvailabilityError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'OrderAvailabilityError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new OrderAvailabilityError(message, remedy);
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function round(value: number): number {
  return Number(value.toFixed(3));
}

/**
 * The unit each counted element arrives in, and whether its figure is one quantity or a
 * difference of two streams. The stock/requirements list selects a quantity and leaves the unit
 * behind (`stock-requirements.ts`: `purchase_requisition_item.quantity`, `purchase_order_item
 * .quantity`, `planned_order.quantity`, `mrp_dependent_requirement.quantity`,
 * `reservation_item.required_quantity`, `production_order.order_quantity`,
 * `production_order_component.required_quantity` — each of those tables stores a unit beside it,
 * and no availability query reads it), so the unit is read from the row's own table here rather
 * than assumed to be the base unit. `netted` marks the kinds whose open quantity the list
 * computes by subtracting a second stream: a requisition by the purchase orders converted from
 * it, a purchase order and a production order by `material_document_line.base_quantity`. A
 * difference taken across two units is neither of them, so those three are usable only when they
 * stand in the base unit and are otherwise a refusal, not a figure to be scaled afterwards.
 *
 * Stock on hand and the safety stock carry no unit of their own and need none:
 * `stock_quantity.quantity` and `material_plant.safety_stock` are amounts in the material's base
 * unit, which is the rule every posting is written to honour (`inventory/unit-conversion.ts`:
 * "Everything in canon stored entry_quantity = base_quantity"), so those two enter the balance as
 * base-unit figures by the schema's own design.
 */
const UNIT_OF_ELEMENT = new Map<string, { netted: boolean }>([
  ['PURCHASE_REQUISITION', { netted: true }],
  ['PURCHASE_ORDER', { netted: true }],
  ['PRODUCTION_ORDER', { netted: true }],
  ['PLANNED_ORDER', { netted: false }],
  ['RESERVATION', { netted: false }],
  ['DEPENDENT_REQUIREMENT', { netted: false }],
  ['PRODUCTION_COMPONENT', { netted: false }],
]);

/** The table and the columns a counted element's own unit stands on. */
const UNIT_SOURCE = new Map<string, {
  table: string; document: string; item: string | null; unit: string;
}>([
  ['PURCHASE_REQUISITION', {
    table: 'purchase_requisition_item', document: 'requisition_number', item: 'item_number', unit: 'unit',
  }],
  ['PURCHASE_ORDER', {
    table: 'purchase_order_item', document: 'order_number', item: 'item_number', unit: 'unit',
  }],
  ['PLANNED_ORDER', {
    table: 'planned_order', document: 'order_number', item: null, unit: 'unit',
  }],
  ['PRODUCTION_ORDER', {
    table: 'production_order', document: 'order_number', item: null, unit: 'unit_of_measure',
  }],
  ['RESERVATION', {
    table: 'reservation_item', document: 'reservation_number', item: 'item_number', unit: 'unit_of_measure',
  }],
  ['DEPENDENT_REQUIREMENT', {
    table: 'mrp_dependent_requirement', document: 'parent_order_number', item: 'item_number', unit: 'unit',
  }],
  ['PRODUCTION_COMPONENT', {
    table: 'production_order_component', document: 'order_number', item: 'item_number', unit: 'unit_of_measure',
  }],
]);

function elementUnitKey(row: { elementType: string; documentNumber: string; documentItem: string }): string {
  return `${row.elementType}|${row.documentNumber}|${row.documentItem}`;
}

/**
 * The unit of every counted row, in one read per element kind. A kind the list named but this
 * select does not return arrives as `null` — an element whose row cannot be found has no unit
 * that can honestly be reported, and the caller refuses the line on that rather than adding the
 * figure in silence.
 */
async function elementUnitsOf(
  tx: Tx,
  client: string,
  plant: string,
  materialNumber: string,
  rows: StockRequirementRow[],
): Promise<Map<string, string | null>> {
  const wanted = new Map<string, Array<{ document: string; item: string }>>();
  for (const row of rows) {
    if (!UNIT_SOURCE.has(row.elementType)) continue;
    const keys = wanted.get(row.elementType) ?? [];
    keys.push({ document: row.documentNumber, item: row.documentItem });
    wanted.set(row.elementType, keys);
  }
  const found = new Map<string, string | null>();
  if (wanted.size === 0) return found;

  for (const [kind, keys] of wanted) {
    const source = UNIT_SOURCE.get(kind)!;
    const read = await tx.execute(sql`
      select ${sql.identifier(source.document)}::text as document_number,
             ${source.item ? sql`${sql.identifier(source.item)}::text` : sql`''`} as document_item,
             ${sql.identifier(source.unit)}::text as unit
        from ${sql.identifier(source.table)}
       where client = ${client} and material_number = ${materialNumber} and plant = ${plant}
    `) as unknown as Array<{ document_number: string | null; document_item: string | null; unit: string | null }>;
    const byRow = new Map<string, string | null>();
    for (const row of read) {
      byRow.set(`${row.document_number ?? ''}|${row.document_item ?? ''}`,
        row.unit === null || row.unit === undefined ? null : String(row.unit).trim());
    }
    for (const key of keys) {
      found.set(`${kind}|${key.document}|${key.item}`, byRow.get(`${key.document}|${key.item}`) ?? null);
    }
  }
  return found;
}

/** What one counted row may be added as, and why not when it cannot. */
interface ResolvedElementUnits {
  /** Keyed by `elementUnitKey`. A row absent from the map is added exactly as it stands. */
  quantities: Map<string, { quantity: number; convertedFrom: ElementUnitConversion | null }>;
  /** One sentence per row the material cannot bring into the base unit. Each names the row. */
  blockers: string[];
}

/**
 * The unit of every counted row, and each row's figure in the material's base unit — in one
 * read-only transaction, one select per element kind.
 *
 * A kind the list named but this select does not return has no unit that can honestly be
 * reported, so it arrives as `null` and becomes a blocker rather than silence. A row already in
 * the base unit is returned untouched, which is what keeps a same-unit check byte for byte the
 * figure it was before any of this existed. Where a conversion is applied it is
 * `inventory/unit-conversion.ts` that applies it, so the rounding is the posting path's rounding
 * and the refusal of a missing factor is its refusal.
 */
async function resolveElementUnits(input: {
  client: string;
  plant: string;
  materialNumber: string;
  baseUnit: string | null;
  rows: StockRequirementRow[];
}): Promise<ResolvedElementUnits> {
  const quantities = new Map<string, { quantity: number; convertedFrom: ElementUnitConversion | null }>();
  const blockers: string[] = [];
  if (!input.rows.some((row) => UNIT_OF_ELEMENT.has(row.elementType))) return { quantities, blockers };

  return withTenant(input.client, async (tx) => {
    const units = await elementUnitsOf(tx, input.client, input.plant, input.materialNumber, input.rows);
    for (const row of input.rows) {
      const key = elementUnitKey(row);
      if (!UNIT_OF_ELEMENT.has(row.elementType)) continue;
      const where = `${row.elementType} ${row.documentNumber}/${row.documentItem} (${row.date})`;
      const unit = units.get(key);
      if (unit === undefined || unit === null || unit === '') {
        blockers.push(`${where} carries no unit that can be read on its row, so nothing can be compared with it`);
        continue;
      }
      if (unit === input.baseUnit) continue; // one unit already: the figure stands as the list read it
      if (input.baseUnit === null) {
        blockers.push(`${where} stands in ${unit} while the material ${input.materialNumber} carries no base unit of its own to bring it into`);
        continue;
      }
      if (UNIT_OF_ELEMENT.get(row.elementType)!.netted) {
        blockers.push(`${where} is ${row.quantity.toFixed(3)} ${unit} netted against quantities the list reads in ${input.baseUnit}`
          + '; the difference is neither unit, so a factor cannot be applied to it afterwards');
        continue;
      }
      try {
        const conversion = await toBaseQuantity(tx, input.client, {
          materialNumber: input.materialNumber, quantity: row.quantity, entryUnit: unit,
        });
        quantities.set(key, {
          quantity: conversion.baseQuantity,
          convertedFrom: { quantity: row.quantity, unit, factor: conversion.factor },
        });
      } catch (error) {
        const reason = error instanceof UnitConversionError
          ? `${error.message.charAt(0).toLowerCase()}${error.message.slice(1)}`
          : 'the conversion it would need could not be read';
        blockers.push(`${where} is ${row.quantity.toFixed(3)} ${unit} and ${reason}`);
      }
    }
    return { quantities, blockers };
  });
}

/** A numeric column arrives as a string; the engine's quantities are plain numbers. */
function qty(value: unknown): number {
  if (value === null || value === undefined || value === '') return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? round(parsed) : 0;
}

/**
 * The order's status chooses the business function to read the control under, the way
 * The reference product's checking control is keyed (CAIRN §1 item 5, 15). Technically complete is
 * release-lineage: the release check already happened, so function 2 answers for it.
 */
export function businessFunctionForStatus(status: string): '1' | '2' {
  return status === 'CREATED' ? '1' : '2';
}

/**
 * Whether a dated element counts, given the scope of check.
 *
 * The switches are read with the meanings the maintaining screens give them
 * (`availability-check.ts` validates the same letters): `X` includes, blank excludes,
 * a planned-order `A` counts **firmed** planned orders only, a production-order `F`
 * counts orders that **stand released**, and `receiptsInPast = B` counts future
 * receipts only. Nothing is folded into a broader reading of a flag: a scope that
 * says firmed is answered with firmed, and a `B` on past receipts really does drop a
 * receipt dated before the check date out of the coverage.
 *
 * The row that is being checked can never be its own coverage. It is one **line** of
 * the order, not the order: a component requirement is identified by the production
 * order *and* its item number, which is the key the stock/requirements list carries on
 * every dependent row (`documentNumber` / `documentItem`, `stock-requirements.ts`), so a
 * second line of the same material stays in the demand and competes for the supply like
 * any other document's requirement does. Excluding the whole order instead would let two
 * lines of one material each claim the same opening stock.
 */
interface ElementContext {
  today: string;
  /** Planned orders standing FIRMED, for the planned-order scope "A". */
  firmedPlanned: ReadonlySet<string>;
  /** Production orders standing released, for the production-order scope "F". */
  releasedProduction: ReadonlySet<string>;
}

/**
 * The elements that are *this* line's own demand, so that it cannot cover itself.
 *
 * `componentItem` is the item number of the component line being answered. On a dated
 * production-component row the list's document key is the production order and `documentItem`
 * is that component's own item number, so the pair — never the order alone — identifies the
 * requirement being checked. An item number is unique within its document and is what the
 * order's own key is built from (`production_order_component` primary key), so matching on
 * the string the list put there is the same identity the row itself carries.
 */
function isOwnDemand(
  row: StockRequirementRow,
  ownDemandOf: { orderNumber: string; plannedOrderNumber: string | null; componentItem: string },
): boolean {
  if (row.elementType === 'PRODUCTION_COMPONENT') {
    return row.documentNumber === ownDemandOf.orderNumber && row.documentItem === ownDemandOf.componentItem;
  }
  // The production order stands in for the planned order it was converted from; the
  // engine already drops that planned order as a receipt, so its open dependent
  // requirement is the same demand and is not counted against the order either. That
  // row is keyed by the planned order's own item, so it is matched by document only.
  return row.elementType === 'DEPENDENT_REQUIREMENT'
    && ownDemandOf.plannedOrderNumber !== null
    && row.documentNumber === ownDemandOf.plannedOrderNumber;
}

function elementCounts(
  scope: ScopeOfCheckRow,
  row: StockRequirementRow,
  ownDemandOf: { orderNumber: string; plannedOrderNumber: string | null; componentItem: string },
  context: ElementContext,
): { counted: boolean; ownDemand: boolean; unsupported: string | null; pastReceipt: boolean } {
  const ownDemand = isOwnDemand(row, ownDemandOf);

  let byFlag: boolean;
  let unsupported: string | null = null;
  switch (row.elementType as ScopedElement | 'STOCK') {
    case 'STOCK':
      byFlag = true;
      break;
    case 'SAFETY_STOCK':
      byFlag = scope.includeSafetyStock === 'X';
      break;
    case 'PURCHASE_REQUISITION':
      byFlag = scope.purchaseRequisitions === 'X';
      break;
    case 'PURCHASE_ORDER':
      byFlag = scope.purchaseOrders === 'X';
      break;
    case 'PLANNED_ORDER':
      // "Firmed planned orders only", which is what the switch's own validation says A
      // means, so an open planned order is not coverage under A and is under X.
      byFlag = scope.plannedOrders === 'A'
        ? context.firmedPlanned.has(row.documentNumber)
        : scope.plannedOrders === 'X';
      break;
    case 'PRODUCTION_ORDER':
      byFlag = scope.productionOrders === 'F'
        ? context.releasedProduction.has(row.documentNumber)
        : scope.productionOrders === 'X';
      break;
    case 'DEPENDENT_REQUIREMENT':
    // The order's dated component demand is that order's dependent requirement; the
    // scope's switch governs both, so the list cannot include one and drop the other.
    case 'PRODUCTION_COMPONENT':
      byFlag = scope.dependentRequirements === 'X';
      break;
    case 'RESERVATION':
      byFlag = scope.reservations === 'X';
      break;
    default:
      byFlag = false;
      unsupported = `The element ${row.elementType} is not one this check knows how to scope.`;
  }

  // "Future receipts only" is what the past-receipt switch says, so a receipt standing
  // in the past does not cover a requirement. Past *requirements* still do, because
  // demand that was already missed is not cancelled by a display switch.
  const pastReceipt = byFlag && scope.receiptsInPast === 'B'
    && row.direction === 'RECEIPT' && row.date < context.today;

  return { counted: byFlag && !pastReceipt, ownDemand, unsupported, pastReceipt };
}

/**
 * The two lookups a narrower scope flag needs: which planned orders are firmed, and
 * which production orders stand released. They are read only when a scope asks for
 * them, from the tables that own them, and only for the documents the element list
 * already named. A technically complete order counts as released for supply, because
 * it was released to become complete.
 */
async function scopeDocumentStates(
  client: string,
  rows: readonly StockRequirementRow[],
  scope: ScopeOfCheckRow,
  today: string,
): Promise<ElementContext> {
  const planned = scope.plannedOrders === 'A'
    ? rows.filter((row) => row.elementType === 'PLANNED_ORDER').map((row) => row.documentNumber) : [];
  const production = scope.productionOrders === 'F'
    ? rows.filter((row) => row.elementType === 'PRODUCTION_ORDER').map((row) => row.documentNumber) : [];
  if (planned.length === 0 && production.length === 0) return { today, firmedPlanned: new Set(), releasedProduction: new Set() };
  return withTenant(client, async (tx) => {
    const firmedPlanned = new Set<string>();
    const releasedProduction = new Set<string>();
    if (planned.length > 0) {
      const found = await tx.select({ orderNumber: plannedOrder.orderNumber }).from(plannedOrder).where(and(
        eq(plannedOrder.client, client), eq(plannedOrder.firmingStatus, 'FIRMED'), inArray(plannedOrder.orderNumber, planned),
      ));
      for (const row of found) firmedPlanned.add(row.orderNumber);
    }
    if (production.length > 0) {
      const found = await tx.select({ orderNumber: productionOrder.orderNumber }).from(productionOrder).where(and(
        eq(productionOrder.client, client),
        inArray(productionOrder.status, ['RELEASED', 'TECHNICALLY_COMPLETED']),
        inArray(productionOrder.orderNumber, production),
      ));
      for (const row of found) releasedProduction.add(row.orderNumber);
    }
    return { today, firmedPlanned, releasedProduction };
  });
}

/**
 * A scope that asks for stock by type cannot be honoured: the stock/requirements list
 * draws unrestricted-use and quality-inspection stock as one opening element and
 * never draws blocked or restricted-use stock at all. Refusing the component is the
 * honest answer; reporting the merged opening as though it were a chosen subset would
 * not be.
 *
 * The flags are read as the maintaining screen defines them: `includeRestrictedUse` is
 * "Include restricted-use batches" (`AvailabilityCheckForm.tsx`, and the label
 * `availability-check.ts` validates it under), not an inclusion switch for
 * unrestricted-use stock — that type has no switch in this scope. So a blank
 * restricted-use switch asks for exactly what the list already counts and is no reason
 * to refuse, while `X` asks for a stock type the list has no element for.
 */
function stockSplitRefusal(scope: ScopeOfCheckRow): string | null {
  if (scope.includeRestrictedUse === 'X') {
    return 'The scope includes restricted-use batches, and the stock/requirements list has no such element: it draws unrestricted-use and quality-inspection stock as one opening element and counts no restricted-use stock. A per-type stock split is not stored or computed here.';
  }
  if (scope.includeQualityStock !== 'X') {
    return 'The scope excludes quality-inspection stock, and the stock/requirements list counts it as part of one opening element. A per-type stock split is not stored or computed here.';
  }
  if (scope.includeBlockedStock === 'X') {
    return 'The scope includes blocked stock, which planning never counts and the stock/requirements list reports as excluded. It cannot be brought in as coverage.';
  }
  return null;
}

/** A component resolved to a scope, or resolved to the reason it cannot be checked. */
interface ComponentPlan {
  base: ComponentAvailability;
  scope: ScopeOfCheckRow | null;
}

export async function checkOrderAvailability(input: {
  client: string;
  orderNumber: string;
  itemNumber?: string | null;
  today?: string;
  horizonEnd?: string | null;
}): Promise<OrderAvailabilityResult> {
  const client = input.client;
  const orderNumber = input.orderNumber.trim().toUpperCase();
  if (!orderNumber) fail('An order number is required.', 'Open the check from an order, or type its number.');
  const itemFilter = (input.itemNumber ?? '').trim();
  if (itemFilter && !/^\d{1,4}$/.test(itemFilter)) {
    fail(`The item ${itemFilter} is not a component item number.`, 'Leave the item empty to check every component of the order.');
  }
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  if (!ISO_DATE.test(today)) fail(`The check date ${today} is not a date.`, 'Use the format YYYY-MM-DD.');
  const horizonEnd = (input.horizonEnd ?? '').trim();
  if (horizonEnd && !ISO_DATE.test(horizonEnd)) fail(`The horizon end ${horizonEnd} is not a date.`, 'Use the format YYYY-MM-DD.');

  // The configuration is read through the maintaining screens' own service, so the
  // flags this check selects elements by are the flags the scope of check stores —
  // including how an unrecognised letter in a switch is normalised. Reading the table
  // directly would put a second interpretation of the same row in the application.
  const config = await listAvailabilityCheck(client);
  const groups = new Map(config.groups.map((row) => [row.checkingGroup, row]));
  const rules = new Set(config.rules.map((row) => row.checkingRule));
  const scopes = new Map(config.scopes.map((row) => [`${row.checkingGroup}/${row.checkingRule}`, row]));

  const plan = await withTenant(client, async (tx) => {
    const [order] = await tx.select().from(productionOrder)
      .where(and(eq(productionOrder.client, client), eq(productionOrder.orderNumber, orderNumber)));
    if (!order) {
      fail(`The production order ${orderNumber} does not stand in tenant ${client}.`, 'Open an order that exists, or correct the number.');
    }
    const status = parseProductionOrderStatus(order.status);
    if (!status) fail(`The order status ${order.status} is not one this application knows.`, 'The order is not in a state a check can be read from.');

    // The order type keys the checking control. An order without one cannot be resolved
    // to a rule, and no rule may be assumed in its place.
    const orderType = order.orderType === null || order.orderType === '' ? null : order.orderType;
    const businessFunction = businessFunctionForStatus(status);

    const components = await tx.select().from(productionOrderComponent)
      .where(and(eq(productionOrderComponent.client, client), eq(productionOrderComponent.orderNumber, orderNumber)))
      .orderBy(productionOrderComponent.itemNumber);
    const wanted = itemFilter ? components.filter((row) => row.itemNumber === Number(itemFilter)) : components;
    if (wanted.length === 0) {
      fail(components.length === 0
        ? `The production order ${orderNumber} has no component to check.`
        : `The production order ${orderNumber} has no item ${itemFilter}.`,
      components.length === 0
        ? 'An order without components has nothing for an availability check. Maintain the order before checking it.'
        : 'Leave the item empty to check every component of the order.');
    }

    let checkingRule: string | null = null;
    let orderMessage: string | null = null;
    let orderRemedy: string | null = null;
    let orderNoCheck = false;
    let orderLevelRefusal: string | null = null;
    let orderLevelRemedy: string | null = null;
    let statusRefusal: string | null = null;
    let statusRefusalRemedy: string | null = null;

    // A technically complete order is finished: the stock/requirements list keeps its own demand
    // and its dependent requirements out of the balance (that is the list's rule, not a
    // simplification here), so the elements left on the material's list cannot be read against the
    // order that no longer draws on them. Answering a shortfall from those rows would publish a
    // figure for demand the plant stopped carrying, so the order's state is refused before any
    // configuration is consulted and before any element is counted.
    if (status === 'TECHNICALLY_COMPLETED') {
      statusRefusal = `The production order ${orderNumber} is technically complete. The stock/requirements list counts neither its order receipt nor its dated component demand for a completed order - a completed order is not an open receipt there, by that query's own rule - while a dependent requirement that still stands open on it is read, because completion does not maintain it. No picture on this ledger is the one this order was planned against, so no quantity is answered for a finished order, and no element list is shown.`;
      statusRefusalRemedy = 'Revoke the technical completion on the order-change screen to have this order checked again, or read the material in the stock/requirements list for its own picture. A completion is a decision about the order, not an availability result.';
    } else if (orderType === null) {
      orderLevelRefusal = `The order carries no order type, so no checking control can be resolved for it.`;
      orderLevelRemedy = 'Maintain the order type on the order. A check does not pick a rule because no control row was found.';
    } else {
      const [control] = await tx.select().from(productionCheckingControl).where(and(
        eq(productionCheckingControl.client, client),
        eq(productionCheckingControl.plant, order.plant),
        eq(productionCheckingControl.orderType, orderType),
        eq(productionCheckingControl.businessFunction, businessFunction),
      ));
      if (!control) {
        orderLevelRefusal = `No checking control stands for plant ${order.plant}, order type ${orderType}, business function ${businessFunction}.`;
        orderLevelRemedy = 'Maintain the record in Define Checking Control (OPJK). A missing record is not configured. It is not a check and it is not a no-check.';
      } else if (control.noCheck === 'X') {
        orderNoCheck = true;
        orderMessage = `The checking control for plant ${order.plant}, order type ${orderType}, business function ${businessFunction} marks this combination as not checked. Nothing is calculated.`;
        orderRemedy = 'Clear the no-check indicator in Define Checking Control (OPJK) to have the order checked.';
      } else if (control.checkingRule === null || control.checkingRule === '') {
        orderLevelRefusal = `The checking control for plant ${order.plant}, order type ${orderType}, business function ${businessFunction} names no checking rule, and without a rule there is no scope of check to select elements by.`;
        orderLevelRemedy = 'Maintain a checking rule on the checking control record (OPJK). A blank rule is not a default rule and is not a production rule.';
      } else if (!rules.has(control.checkingRule)) {
        orderLevelRefusal = `The checking control names the checking rule ${control.checkingRule}, which does not stand in the checking-rule registry.`;
        orderLevelRemedy = 'Maintain the checking rule (OVZ8) or correct the checking control. A dangling key is not a check.';
      } else {
        checkingRule = control.checkingRule;
      }
    }

    const entries: ComponentPlan[] = [];
    for (const component of wanted) {
      const [master] = await tx.select({
        description: materialTable.description,
        baseUnit: materialTable.baseUnit,
      }).from(materialTable)
        .where(and(eq(materialTable.client, client), eq(materialTable.materialNumber, component.materialNumber)));

      const base: ComponentAvailability = {
        itemNumber: String(component.itemNumber),
        materialNumber: component.materialNumber,
        description: master?.description ?? '',
        unit: component.unitOfMeasure,
        baseUnit: master?.baseUnit ?? null,
        requiredQuantity: qty(component.requiredQuantity),
        requirementDate: component.requirementDate ?? null,
        checkingGroup: null,
        checkingRule,
        scopeKey: null,
        outcome: 'NO_GROUP',
        committedQuantity: null,
        cumulatedAtp: null,
        coveredQuantity: null,
        shortageQuantity: null,
        earliestFullCoverageDate: null,
        message: null,
        remedy: null,
        elements: [],
        warnings: [],
      };

      if (orderNoCheck || orderLevelRefusal || statusRefusal) {
        entries.push({
          base: {
            ...base,
            outcome: orderNoCheck ? 'NOT_CHECKED' : 'UNSUPPORTED',
            message: orderNoCheck ? orderMessage : (orderLevelRefusal ?? statusRefusal),
            remedy: orderNoCheck ? orderRemedy : (orderLevelRemedy ?? statusRefusalRemedy),
            warnings: statusRefusal
              ? ['This line is refused because the order it belongs to is technically complete. The refusal covers every line of the order; no element list of the material was read for it.']
              : base.warnings,
          },
          scope: null,
        });
        continue;
      }

      // A storage location on the component line is shown, never assumed: the check is
      // at plant level, and splitting a plant-level requirement across locations would
      // invent a distribution the order does not store.
      if (component.storageLocation !== null && component.storageLocation !== '') {
        base.warnings.push(`The component line carries storage location ${component.storageLocation}. The check is at plant level; the location is shown and not used.`);
      }

      const [plantView] = await tx.select({ checkingGroup: materialPlant.checkingGroup }).from(materialPlant).where(and(
        eq(materialPlant.client, client),
        eq(materialPlant.materialNumber, component.materialNumber),
        eq(materialPlant.plant, component.plant),
      ));
      const checkingGroup = plantView?.checkingGroup ?? null;
      base.checkingGroup = checkingGroup;
      if (checkingGroup === null) {
        entries.push({
          base: {
            ...base,
            message: `The material ${component.materialNumber} has no checking group in plant ${component.plant}, so no scope of check can be resolved for it.`,
            remedy: 'Assign a checking group to the material in the plant (the MRP view of the material master, or the checking-group assignment). No group is not a default group.',
          },
          scope: null,
        });
        continue;
      }

      const groupRow = groups.get(checkingGroup);
      if (!groupRow) {
        entries.push({
          base: {
            ...base,
            message: `The checking group ${checkingGroup} carried by ${component.materialNumber} does not stand in the checking-group registry.`,
            remedy: 'Maintain the checking group or correct the material. A dangling key is not a check.',
          },
          scope: null,
        });
        continue;
      }
      if (groupRow.noCheck === 'X') {
        entries.push({
          base: {
            ...base,
            outcome: 'NOT_CHECKED',
            message: `The checking group ${checkingGroup} is marked as not checked, so ${component.materialNumber} is left out of the availability check.`,
            remedy: 'Clear the no-check indicator on the checking group to have this material checked.',
          },
          scope: null,
        });
        continue;
      }

      if (component.requirementDate === null || component.requirementDate === '') {
        entries.push({
          base: {
            ...base,
            outcome: 'UNDATED',
            message: 'The component has no requirement date. A date stands on the component only when conversion copied one from the order\'s dependent requirement, and none was copied.',
            remedy: 'The order needs a dated component requirement. Re-run the planning that gives the order its dates. The order start, the order finish, today and the bill-of-material date are each rejected here as a substitute.',
          },
          scope: null,
        });
        continue;
      }

      // The horizon end bounds the stock/requirements search; it is not the date the answer is
      // given for, which is the requirement date. When the horizon stops before that date, the
      // elements that decide the balance at the date are outside the search, and the cumulated
      // figure would be a partial ledger printed as a verdict at a date it cannot reach. The list
      // accepts such a horizon - it only refuses one in the past - so the refusal is made here,
      // per line, before the list is asked.
      const needBy = (component.requirementDate ?? '').trim();
      if (horizonEnd !== '' && needBy !== '' && horizonEnd >= today && horizonEnd < needBy) {
        entries.push({
          base: {
            ...base,
            outcome: 'UNSUPPORTED',
            message: `The planning horizon ends ${horizonEnd}, before this component's requirement date ${needBy}. Elements dated after the horizon are not read, so the cumulated balance at ${needBy} cannot be computed and no figure is answered for that date.`,
            remedy: `End the horizon on or after ${needBy}, or leave it empty to use the horizon the stock/requirements list applies itself. A total taken from rows that stop short of the date is not an answer for that date.`,
          },
          scope: null,
        });
        continue;
      }

      if (master?.baseUnit && component.unitOfMeasure !== master.baseUnit) {
        entries.push({
          base: {
            ...base,
            outcome: 'UNSUPPORTED',
            message: `The requirement is in ${component.unitOfMeasure} while the stock/requirements list counts ${master.baseUnit}, the material's base unit. Counted supplies are brought into that unit by the conversion the material carries; the requirement being checked is not converted, because a quantity you entered on the order is the quantity this line has to cover, and a converted requirement would answer a different question from the one the order holds.`,
            remedy: 'Keep the component requirement in the base unit, or maintain the unit-of-measure conversion the component needs. An unconverted comparison is not reported as an availability result.',
          },
          scope: null,
        });
        continue;
      }

      // The reference product checks a component only when it is kept in stock, is not a phantom item and
      // is not a bulk material. This application stores no stock-relevance flag, so the
      // standing plant view above is what stands in for "kept in stock" — a component
      // without one is refused as unconfigured — and the phantom and bulk flags are read
      // from the bill-of-material item the order's snapshot names, the only place the
      // repository keeps them (audit §5, decision 2).
      const bomParent = component.sourceMaterial ?? order.materialNumber;
      let bomFlags: { phantom: string; bulkMaterial: string; deletionFlag: string } | null = null;
      if (component.bomItem && order.bomUsage && order.bomAlternative) {
        const [bomItem] = await tx.select({
          phantom: materialBomItem.phantom,
          bulkMaterial: materialBomItem.bulkMaterial,
          deletionFlag: materialBomItem.deletionFlag,
        }).from(materialBomItem).where(and(
          eq(materialBomItem.client, client),
          eq(materialBomItem.materialNumber, bomParent),
          eq(materialBomItem.plant, order.plant),
          eq(materialBomItem.usage, order.bomUsage),
          eq(materialBomItem.alternative, order.bomAlternative),
          eq(materialBomItem.itemNumber, component.bomItem),
        ));
        bomFlags = bomItem ?? null;
        if (!bomItem) {
          base.warnings.push(`The bill-of-material item ${component.bomItem} of ${bomParent} no longer stands. The component is checked from the order's snapshot, and its phantom and bulk state is unknown.`);
        }
      } else {
        base.warnings.push('The component line names no bill-of-material item, so its phantom and bulk state cannot be read. It is checked as an ordinary component.');
      }
      const excluded = bomFlags?.phantom === 'X'
        ? 'The component is a phantom item on the order\'s bill of material. A phantom is not checked for availability; its own components are.'
        : bomFlags?.bulkMaterial === 'X'
          ? 'The component is a bulk material on the order\'s bill of material. Bulk material is not checked here; it is provided by the goods receipt of the order.'
          : bomFlags?.deletionFlag === 'X'
            ? 'The bill-of-material item behind this component is marked for deletion, so it is not checked.'
            : null;
      if (excluded) {
        entries.push({ base: { ...base, outcome: 'EXCLUDED', message: excluded }, scope: null });
        continue;
      }

      const scope = scopes.get(`${checkingGroup}/${checkingRule}`);
      if (!scope) {
        entries.push({
          base: {
            ...base,
            outcome: 'NO_SCOPE',
            message: `No scope of check stands for the checking group ${checkingGroup} with the checking rule ${checkingRule}, so this component cannot be scoped.`,
            remedy: 'Maintain the scope of check for that pair. No scope row is not an empty scope: nothing would be counted, which is a different answer from the one this screen is allowed to give.',
          },
          scope: null,
        });
        continue;
      }
      base.scopeKey = `${scope.checkingGroup}/${scope.checkingRule}`;

      // The component's plant is where its own planning happens, and it is a caller-set
      // field on the order's snapshot (`production-orders.ts` copies `component.plant ||
      // plant`), so it is not guaranteed to be the order's plant. The configuration above
      // is read at the component's plant; the stock/requirements list, the message and the
      // drill-down are all at the order's plant. Answering across the two would publish a
      // quantity drawn from one plant under a heading that names another, so the line is
      // refused instead of substituted — neither plant is quietly used for the other.
      const componentPlant = (component.plant ?? '').trim();
      if (componentPlant !== '' && componentPlant !== order.plant.trim()) {
        entries.push({
          base: {
            ...base,
            outcome: 'UNSUPPORTED',
            message: `The component line stands in plant ${componentPlant} while the production order stands in plant ${order.plant}. Cross-plant component availability is not this screen: the checking scope is resolved at ${componentPlant} and the stock/requirements list is run at ${order.plant}, and no quantity is answered from one plant for a line of the other.`,
            remedy: `Maintain the component in the order's own plant ${order.plant}, or check it in ${componentPlant} where its planning belongs. This slice does not substitute one plant for the other.`,
          },
          scope: null,
        });
        continue;
      }

      const stockRefusal = stockSplitRefusal(scope);
      if (stockRefusal) {
        entries.push({
          base: {
            ...base,
            outcome: 'UNSUPPORTED',
            message: stockRefusal,
            remedy: 'Maintain a scope of check that counts stock the way the stock/requirements list does, or wait for the per-type element this check would need. The refusal is the answer; an approximate quantity is not.',
          },
          scope: null,
        });
        continue;
      }

      entries.push({ base, scope });
    }

    return {
      order,
      status,
      orderType,
      businessFunction,
      checkingRule,
      orderNoCheck,
      orderMessage,
      orderRemedy,
      orderLevelRefusal,
      orderLevelRemedy,
      statusRefusal,
      statusRefusalRemedy,
      entries,
    };
  });

  const { order, entries } = plan;
  const rows: ComponentAvailability[] = [];
  for (const entry of entries) {
    const base = entry.base;
    if (entry.scope === null) {
      rows.push(base);
      continue;
    }

    let list;
    try {
      list = await stockRequirementsList({
        client,
        today,
        selection: {
          material: base.materialNumber,
          plant: order.plant,
          periodSplit: 'DAILY',
          // Every dated element is asked for, whatever the scope's past-receipt switch
          // says. The list's own switch is a display control, and a row it hides still
          // moves that list's balance — so answering the scope here means seeing the
          // element and declining it on its date, not losing it silently.
          displayPastDue: true,
          horizonEnd: horizonEnd || undefined,
        },
      });
    } catch (error) {
      const reason = error instanceof StockRequirementsError
        ? error.message
        : 'The stock/requirements list could not be calculated for this component.';
      const remedy = error instanceof StockRequirementsError ? error.remedy ?? null : null;
      rows.push({
        ...base,
        outcome: 'UNSUPPORTED',
        message: `${reason} The availability of this component is not answered without its element list.`,
        remedy: remedy ?? 'Maintain the material and plant the list needs, then run the check again.',
      });
      continue;
    }

    const componentWarnings = [...list.warnings];
    if (list.truncated) {
      componentWarnings.push(`The element list was cut at ${list.maxHits} rows. Coverage beyond that point is unknown, so a shortage may be reported and full availability is not.`);
    }

    const elements: AvailabilityElementRow[] = [];
    const context = await scopeDocumentStates(client, list.rows, entry.scope, today);
    const droppedPastReceipts: string[] = [];
    // The unit each counted row stands in, read from that row's own table. A row already in the
    // material's base unit is added as it stands; a row in another unit is brought into it by the
    // conversion the material carries; a row that can be brought in neither way refuses the line,
    // so no figure below is the sum of two units and no row is dropped to make the units agree.
    const scopeOfEntry = entry.scope; // already narrowed to non-null; a closure would lose that
    const countedRows = list.rows.filter((row) => elementCounts(scopeOfEntry, row, {
      orderNumber,
      plannedOrderNumber: order.plannedOrderNumber,
      componentItem: base.itemNumber,
    }, context).counted);
    const unitResolution = await resolveElementUnits({
      client,
      // The same plant the element list was read at, just above: a component of another plant is
      // refused before this point, and the rows below came from `order.plant` in any case.
      plant: order.plant,
      materialNumber: base.materialNumber,
      baseUnit: base.baseUnit,
      rows: countedRows,
    });
    let cumulative = 0;
    let unsupportedNote: string | null = null;
    for (const row of list.rows) {
      const decision = elementCounts(entry.scope, row, {
        orderNumber,
        plannedOrderNumber: order.plannedOrderNumber,
        componentItem: base.itemNumber,
      }, context);
      if (decision.pastReceipt) droppedPastReceipts.push(`${row.elementType} ${row.documentNumber}/${row.documentItem} (${row.date})`);
      if (decision.unsupported) {
        unsupportedNote = decision.unsupported;
        break;
      }
      if (!decision.counted) continue;
      const asBase = unitResolution.quantities.get(elementUnitKey(row));
      const quantity = asBase?.quantity ?? row.quantity;
      cumulative = round(cumulative + (row.direction === 'RECEIPT' ? quantity : -quantity));
      elements.push({
        date: row.date,
        elementType: row.elementType,
        elementLabel: row.elementLabel,
        direction: row.direction,
        documentNumber: row.documentNumber,
        documentItem: row.documentItem,
        quantity,
        unit: base.baseUnit,
        convertedFrom: asBase?.convertedFrom ?? null,
        cumulated: cumulative,
        ownDemand: decision.ownDemand,
      });
    }

    if (unitResolution.blockers.length > 0) {
      rows.push({
        ...base,
        outcome: 'UNSUPPORTED',
        message: `The counted elements of this component are not all in ${base.baseUnit ?? 'one unit'}, and the material\'s own conversions cannot bring them there: ${unitResolution.blockers.join('; ')}. No availability figure is answered for a balance that would add those rows to the rest, and none of them is left out to make the units agree.`,
        remedy: `Maintain the conversion this material lacks (Define Unit-of-Measure Conversion, ${UOM_CAPABILITY}) or bring the document\'s quantity into ${base.baseUnit ?? 'the material\'s base unit'}. A netted receipt — a requisition or an order already reduced by what stands against it — has to be in the base unit on its own, because the subtraction was taken across two. This check never assumes a factor of 1.`,
        warnings: [`This line is refused before any figure: ${unitResolution.blockers.length} counted element(s) cannot be expressed in ${base.baseUnit ?? 'the material\'s base unit'}. Its element list is not published, because a total of those rows would be arithmetic on mixed units.`],
      });
      continue;
    }

    if (droppedPastReceipts.length > 0) {
      componentWarnings.push(`The scope of check counts future receipts only (receipts in the past = B), so ${droppedPastReceipts.length} element(s) dated before ${today} are not coverage: ${droppedPastReceipts.join(', ')}.`);
    }

    const broughtIn = elements
      .filter((element) => element.convertedFrom !== null)
      .map((element) => `${element.elementType} ${element.documentNumber}/${element.documentItem} (${element.date}) `
        + `${element.convertedFrom!.quantity.toFixed(3)} ${element.convertedFrom!.unit} at ${element.convertedFrom!.factor}`
        + ` = ${element.quantity.toFixed(3)} ${base.baseUnit}`);
    if (broughtIn.length > 0) {
      componentWarnings.push(`${broughtIn.length} counted element(s) were brought into the base unit ${base.baseUnit} by the conversion the material carries, before cumulation: ${broughtIn.join('; ')}. A row the material cannot convert refuses this line instead of being left out, so the figures below are one unit throughout.`);
    }

    if (unsupportedNote) {
      rows.push({
        ...base,
        outcome: 'UNSUPPORTED',
        message: unsupportedNote,
        remedy: 'Set the scope of check to a switch this check models, then run it again. The flag is not ignored: the component is left unanswered.',
        warnings: componentWarnings,
      });
      continue;
    }

    if (elements.length === 0) {
      rows.push({
        ...base,
        outcome: 'NO_ELEMENTS',
        cumulatedAtp: 0,
        coveredQuantity: 0,
        shortageQuantity: base.requiredQuantity,
        message: `The scope of check ${base.scopeKey} counts no element for ${base.materialNumber} in plant ${order.plant}: no stock stands open, and every receipt and requirement the scope would include is switched off or absent. The required ${base.requiredQuantity.toFixed(3)} ${base.unit} is not covered.`,
        remedy: 'Bring supply into the scope — stock, a purchase order, a production or planned order, or a reservation the scope counts — or widen the scope of check.',
        warnings: componentWarnings,
      });
      continue;
    }

    // The answer the requirement date decides: every element the scope counts up to and
    // including that date, with one exception — this line's own demand row, which is the
    // demand being checked and so can never cover itself. Every other requirement on that
    // date is counted against the line, including a sibling component line of the same
    // order: the list has no order within a day, so the check does not guess who is first
    // in line. That is the conservative reading, and the element list shows each
    // competing row.
    const requirementDate = base.requirementDate as string;
    const through = (row: AvailabilityElementRow) => row.ownDemand ? false : row.date <= requirementDate;
    const sameDayDemand = elements.filter((row) => !row.ownDemand && row.date === requirementDate && row.direction === 'REQUIREMENT');
    if (sameDayDemand.length > 0) {
      componentWarnings.push(`${sameDayDemand.length} requirement(s) other than the line being checked are dated ${requirementDate}, the same day as this component, and are counted against it: ${sameDayDemand.map((row) => `${row.elementType} ${row.documentNumber}/${row.documentItem}`).join(', ')}. They may be other component lines of this order or demand from another document; the stock/requirements list has no order within a day, so which line would be served first is not answered here.`);
    }
    let cumulatedOnDate = 0;
    for (const row of elements) if (through(row)) cumulatedOnDate = round(cumulatedOnDate + (row.direction === 'RECEIPT' ? row.quantity : -row.quantity));

    const covered = round(Math.max(0, Math.min(base.requiredQuantity, cumulatedOnDate)));
    const shortage = round(Math.max(0, base.requiredQuantity - cumulatedOnDate));

    // A shortfall larger than the requirement is the cumulated reading, not an arithmetic slip:
    // the balance in front of this line is already negative, so the line needs that hole filled
    // as well as its own quantity. The figure stands; the sentence says what it is made of, so it
    // cannot be read as this line's unmet quantity - which is at most the requirement.
    const exceedsRequirement = shortage > base.requiredQuantity;
    const madeOf = exceedsRequirement
      ? ` The requirement of this line is ${base.requiredQuantity.toFixed(3)} ${base.unit} of that; the remaining ${round(shortage - base.requiredQuantity).toFixed(3)} ${base.unit} is the deficit the demand dated before it already left in the cumulated balance. The figure is the supply this line needs on top of that deficit, not the part of the line that stands unmet, and it is not a claim on the stock of any other document.`
      : '';

    let earliest: string | null = null;
    if (shortage <= 0) {
      earliest = requirementDate;
    } else {
      let running = cumulatedOnDate;
      for (const row of elements) {
        if (row.ownDemand || row.date <= requirementDate) continue; // already in the balance above
        running = round(running + (row.direction === 'RECEIPT' ? row.quantity : -row.quantity));
        if (running >= base.requiredQuantity) { earliest = row.date; break; }
      }
    }

    rows.push({
      ...base,
      outcome: shortage > 0 ? 'SHORT' : 'AVAILABLE',
      cumulatedAtp: cumulatedOnDate,
      coveredQuantity: covered,
      shortageQuantity: shortage,
      earliestFullCoverageDate: earliest,
      message: shortage > 0
        ? earliest === null
          ? `Short by ${shortage.toFixed(3)} ${base.unit} at ${requirementDate}.${madeOf} Nothing in the counted elements covers the remainder within the elements shown.`
          : `Short by ${shortage.toFixed(3)} ${base.unit} at ${requirementDate}; the counted elements cover the requirement from ${earliest}.${madeOf}`
        : `Covered at ${requirementDate}: ${covered.toFixed(3)} ${base.unit} of ${base.requiredQuantity.toFixed(3)} stands in the scope's elements.`,
      remedy: shortage > 0
        ? 'Bring in supply the scope counts, move the requirement to a date the supply precedes, or reduce the quantity. This check commits nothing, so none of those is done here.'
        : null,
      elements,
      warnings: componentWarnings,
    });
  }

  const checkedCount = rows.filter((row) => row.outcome === 'AVAILABLE' || row.outcome === 'SHORT' || row.outcome === 'NO_ELEMENTS').length;
  const excludedCount = rows.filter((row) => row.outcome === 'EXCLUDED').length;
  const refusedCount = rows.length - checkedCount - excludedCount;
  // A check that answered nothing is not a partial check, whatever the reason is. The gap in the
  // configuration stays a separate fact, so the workbench can say whose record needs maintaining.
  const configurationGap = plan.orderLevelRefusal !== null;
  const nothingAnswered = rows.length > 0 && checkedCount === 0;
  const status: OrderAvailabilityStatus = (plan.orderNoCheck || nothingAnswered)
    ? 'NOT_CHECKED'
    : refusedCount > 0 || checkedCount < rows.length ? 'PARTIALLY_CHECKED' : 'CHECKED';

  const warnings: string[] = [];
  if (plan.orderNoCheck) warnings.unshift(plan.orderMessage ?? '');
  else if (plan.orderLevelRefusal) warnings.unshift(plan.orderLevelRefusal);
  else if (plan.statusRefusal) warnings.unshift(plan.statusRefusal);
  warnings.push('Nothing is committed, reserved, posted or stored. A second check returns the same figures because no quantity was taken.');
  warnings.push('The requirement dates and quantities are the order\'s own snapshot. A bill of material changed after the order was made is not re-read for its demand; only the phantom, bulk and deletion flags are read from it, because no other record keeps them.');
  if (excludedCount > 0) {
    warnings.push(`${excludedCount} component line(s) are not checked because the bill-of-material item marks them phantom, bulk or flagged for deletion. That is the rule, not a gap in the data.`);
  }
  warnings.push('Committed quantity is shown as not stored on every line. This ERP keeps no commitment, so two checks of one order agree, and neither reduces what the next order can take.');
  if (nothingAnswered && !plan.orderNoCheck) {
    warnings.push(`No component of this order was answered with a figure: ${refusedCount} line(s) are refused and ${excludedCount} are excluded by the bill of material. NOT_CHECKED says no answer was given; it does not say the supply is short.`);
  }

  return {
    status,
    orderNumber,
    plant: order.plant,
    orderType: plan.orderType,
    orderStatus: plan.status,
    businessFunction: plan.businessFunction,
    materialNumber: order.materialNumber,
    orderQuantity: qty(order.orderQuantity),
    unitOfMeasure: order.unitOfMeasure,
    checkingRule: plan.checkingRule,
    scopeKey: rows.find((row) => row.scopeKey !== null)?.scopeKey ?? null,
    components: rows,
    checkedCount,
    refusedCount,
    excludedCount,
    configurationGap,
    message: plan.orderNoCheck ? plan.orderMessage : (plan.orderLevelRefusal ?? plan.statusRefusal),
    remedy: plan.orderNoCheck ? plan.orderRemedy : (plan.orderLevelRemedy ?? plan.statusRefusalRemedy),
    warnings,
    calculatedAt: new Date().toISOString(),
  };
}
