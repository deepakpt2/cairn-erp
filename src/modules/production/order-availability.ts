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
 *    the scope includes, summed to the component's requirement date. The line's own
 *    demand is the demand being checked, so it is not netted against itself, while
 *    another document's demand dated that same day is — the list has no order within a
 *    day and this check does not guess who stands first in line. The gap is shown, not
 *    papered over.
 * 3. **The elements come from the stock/requirements engine, not from a second one.**
 *    `stockRequirementsList` is called per component; this file only *selects* from the
 *    elements it returned and adds them up, and it honours each switch of the scope of
 *    check the way the configuration module defines it: planned orders `A` means firmed
 *    ones only, production orders `F` means released ones, receipts in the past `B`
 *    leaves a past receipt out of coverage. Where the scope asks for something the
 *    engine cannot express at all — stock split by stock type — the component is
 *    reported UNSUPPORTED rather than answered with a number that quietly means
 *    something else.
 *
 * Nothing posts, reserves, commits, changes an order, or writes a row. A check that
 * runs twice returns the same answer, and the reason it can promise that is that it
 * keeps nothing between the two calls.
 */
import { and, eq, inArray } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';

import { withTenant } from '../../platform/db/client';
import {
  material as materialTable,
  materialPlant,
  productionOrder,
  productionOrderComponent,
} from '../inventory/schema';
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

export interface AvailabilityElementRow {
  date: string;
  elementType: string;
  elementLabel: string;
  direction: 'RECEIPT' | 'REQUIREMENT';
  documentNumber: string;
  documentItem: string;
  quantity: number;
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
  cumulatedAtp: number | null;
  coveredQuantity: number | null;
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
 * `ownDemandOf` marks the row the check is about, which can never be its own coverage.
 */
interface ElementContext {
  today: string;
  /** Planned orders standing FIRMED, for the planned-order scope "A". */
  firmedPlanned: ReadonlySet<string>;
  /** Production orders standing released, for the production-order scope "F". */
  releasedProduction: ReadonlySet<string>;
}

function elementCounts(
  scope: ScopeOfCheckRow,
  row: StockRequirementRow,
  ownDemandOf: { orderNumber: string; plannedOrderNumber: string | null },
  context: ElementContext,
): { counted: boolean; ownDemand: boolean; unsupported: string | null; pastReceipt: boolean } {
  const ownProductionDemand = row.elementType === 'PRODUCTION_COMPONENT'
    && row.documentNumber === ownDemandOf.orderNumber;
  // The production order stands in for the planned order it was converted from; the
  // engine already drops that planned order as a receipt, so its open dependent
  // requirement is the same demand and is not counted against the order either.
  const ownConvertedDemand = row.elementType === 'DEPENDENT_REQUIREMENT'
    && ownDemandOf.plannedOrderNumber !== null
    && row.documentNumber === ownDemandOf.plannedOrderNumber;
  const ownDemand = ownProductionDemand || ownConvertedDemand;

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
 * never draws blocked stock at all. Refusing the component is the honest answer;
 * reporting the merged opening as though it were a chosen subset would not be.
 */
function stockSplitRefusal(scope: ScopeOfCheckRow): string | null {
  if (scope.includeRestrictedUse !== 'X') {
    return 'The scope does not include unrestricted-use stock, and the stock/requirements list counts it as part of one opening element. A per-type stock split is not stored or computed here.';
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

    if (orderType === null) {
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

      if (orderLevelRefusal || orderNoCheck) {
        entries.push({
          base: {
            ...base,
            outcome: orderNoCheck ? 'NOT_CHECKED' : 'UNSUPPORTED',
            message: orderNoCheck ? orderMessage : orderLevelRefusal,
            remedy: orderNoCheck ? orderRemedy : orderLevelRemedy,
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

      if (master?.baseUnit && component.unitOfMeasure !== master.baseUnit) {
        entries.push({
          base: {
            ...base,
            outcome: 'UNSUPPORTED',
            message: `The requirement is in ${component.unitOfMeasure} while the stock/requirements list counts ${master.baseUnit}, the material's base unit. No conversion is applied, so the two quantities cannot be compared honestly.`,
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
    let cumulative = 0;
    let unsupportedNote: string | null = null;
    for (const row of list.rows) {
      const decision = elementCounts(entry.scope, row, { orderNumber, plannedOrderNumber: order.plannedOrderNumber }, context);
      if (decision.pastReceipt) droppedPastReceipts.push(`${row.elementType} ${row.documentNumber}/${row.documentItem} (${row.date})`);
      if (decision.unsupported) {
        unsupportedNote = decision.unsupported;
        break;
      }
      if (!decision.counted) continue;
      cumulative = round(cumulative + (row.direction === 'RECEIPT' ? row.quantity : -row.quantity));
      elements.push({
        date: row.date,
        elementType: row.elementType,
        elementLabel: row.elementLabel,
        direction: row.direction,
        documentNumber: row.documentNumber,
        documentItem: row.documentItem,
        quantity: row.quantity,
        cumulated: cumulative,
        ownDemand: decision.ownDemand,
      });
    }

    if (droppedPastReceipts.length > 0) {
      componentWarnings.push(`The scope of check counts future receipts only (receipts in the past = B), so ${droppedPastReceipts.length} element(s) dated before ${today} are not coverage: ${droppedPastReceipts.join(', ')}.`);
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
    // including that date, with one exception — the component's own demand, which is the
    // demand being checked and so can never cover itself. A requirement that another
    // document puts on the same day is counted against this line: the list has no order
    // within a day, so the check does not guess who is first in line. That is the
    // conservative reading, and the element list shows the competing row.
    const requirementDate = base.requirementDate as string;
    const through = (row: AvailabilityElementRow) => row.ownDemand ? false : row.date <= requirementDate;
    const sameDayDemand = elements.filter((row) => !row.ownDemand && row.date === requirementDate && row.direction === 'REQUIREMENT');
    if (sameDayDemand.length > 0) {
      componentWarnings.push(`${sameDayDemand.length} requirement(s) of other documents are dated ${requirementDate}, the same day as this component, and are counted against it: ${sameDayDemand.map((row) => `${row.elementType} ${row.documentNumber}/${row.documentItem}`).join(', ')}. The stock/requirements list has no order within a day, so which line would be served first is not answered here.`);
    }
    let cumulatedOnDate = 0;
    for (const row of elements) if (through(row)) cumulatedOnDate = round(cumulatedOnDate + (row.direction === 'RECEIPT' ? row.quantity : -row.quantity));

    const covered = round(Math.max(0, Math.min(base.requiredQuantity, cumulatedOnDate)));
    const shortage = round(Math.max(0, base.requiredQuantity - cumulatedOnDate));

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
          ? `Short by ${shortage.toFixed(3)} ${base.unit} at ${requirementDate}. Nothing in the counted elements covers the remainder within the elements shown.`
          : `Short by ${shortage.toFixed(3)} ${base.unit} at ${requirementDate}; the counted elements cover the requirement from ${earliest}.`
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
  const status: OrderAvailabilityStatus = plan.orderNoCheck
    ? 'NOT_CHECKED'
    : refusedCount > 0 || checkedCount < rows.length ? 'PARTIALLY_CHECKED' : 'CHECKED';

  const warnings: string[] = [];
  if (plan.orderNoCheck) warnings.unshift(plan.orderMessage ?? '');
  else if (plan.orderLevelRefusal) warnings.unshift(plan.orderLevelRefusal);
  warnings.push('Nothing is committed, reserved, posted or stored. A second check returns the same figures because no quantity was taken.');
  warnings.push('The requirement dates and quantities are the order\'s own snapshot. A bill of material changed after the order was made is not re-read for its demand; only the phantom, bulk and deletion flags are read from it, because no other record keeps them.');
  if (excludedCount > 0) {
    warnings.push(`${excludedCount} component line(s) are not checked because the bill-of-material item marks them phantom, bulk or flagged for deletion. That is the rule, not a gap in the data.`);
  }
  warnings.push('Committed quantity is shown as not stored on every line. This ERP keeps no commitment, so two checks of one order agree, and neither reduces what the next order can take.');
  if (order.status === 'TECHNICALLY_COMPLETED') {
    warnings.push('The order is technically complete. The release-time checking control is what answered for it; no completion decision is made here.');
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
    message: plan.orderNoCheck ? plan.orderMessage : plan.orderLevelRefusal,
    remedy: plan.orderNoCheck ? plan.orderRemedy : plan.orderLevelRemedy,
    warnings,
    calculatedAt: new Date().toISOString(),
  };
}
