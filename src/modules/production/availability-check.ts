/**
 * Availability-check configuration. OVZ2, OPJL, and OVZ9 are search aliases only.
 *
 * A checking group is client customizing and is assigned on the material plant
 * view (MARC-MTVFP). A checking rule is a separate key. It is not a checking
 * group, and it does not decide whether a check runs. That decision is checking
 * control, which is not stored. A scope of check is the pair. Saving a scope
 * does not calculate ATP, does not read MD04, and does not post.
 *
 * A missing assignment stays null. It is not replaced by a default group.
 */
import { and, asc, eq } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { markActivityComplete } from '../../platform/tenancy';
import { materialPlant } from '../inventory/schema';
import {
  availabilityCheckScope,
  availabilityCheckingGroup,
  availabilityCheckingRule,
} from './schema';

export const ACTIVITY = 'CFG.PROD.AVCHECK.DEFINE';
export const ROUTE = '/config/availability-check';
export const ALIASES = ['OVZ2', 'OPJL', 'OVZ9', 'OPJJ'] as const;
export const LOCK_OBJECT = 'AVAILABILITY_CHECK';

export const AVAILABILITY_CHECK_GAPS = [
  'Replenishment lead time is not stored. Planned delivery days and in-house production days are MRP master data. Goods-receipt processing time is not stored, and no rule selects which time applies. Check-without-RLT is not stored, because either value would pretend the lead time is defined.',
  'Purchase requisitions, purchase orders, planned orders, and dependent requirements keep their own unit. Stock, reservations, and production orders keep the base unit. This configuration does not convert one into the other.',
  'A production-order component is not a reservation. A requirement date is stored only when conversion copied it from a matching dependent requirement. This configuration does not reconcile those rows, does not invent one as the other, and does not calculate ATP.',
  'Storage-location inspection is not stored. Planned orders and dependent requirements have no storage location. A location check would omit them or invent a location.',
  'Sales orders, deliveries, shipping notifications, stock in transfer, stock-transport releases, subcontracting, independent requirements, and a special-stock indicator are not stored. Their scope flags are refused.',
  'Unrestricted-use stock has no inclusion switch in this scope. It is not treated as available.',
  'Checking control is not stored on this screen. It is a separate record keyed by plant, order type, and business function 1 (creation) or 2 (release). A group, a rule, and a scope do not make that selection and do not run a check. The checking-group no-check indicator is not that control and is not an available quantity.',
  'No transaction is bound to a checking rule. Order creation, conversion, MRP, and the stock/requirements list do not read this configuration. Saving a scope does not calculate an ATP quantity.',
] as const;

const REFUSED: Record<string, string> = {
  totalSalesRequirements: 'Total sales requirements are not stored. Sales orders are not implemented.',
  totalDeliveryRequirements: 'Total delivery requirements are not stored. Deliveries are not implemented.',
  replenishmentLeadTime: 'A replenishment lead time is not stored. Planned delivery days do not become an availability date.',
  checkWithoutReplenishmentLeadTime: 'Check without replenishment lead time is not stored. The lead time itself is not defined.',
  materialBlock: 'A material block during the availability check is not stored. No check runs.',
  advancedAtp: 'Advanced ATP is not stored.',
  salesRequirements: 'Sales requirements are not an inclusion control. Sales orders are not implemented.',
  deliveries: 'Deliveries are not an inclusion control. They are not implemented.',
  shippingNotifications: 'Shipping notifications are not an inclusion control. They are not implemented.',
  stockInTransfer: 'Stock in transfer is not an inclusion control. No transit stock is stored.',
  dependentReservations: 'Dependent reservations are not an inclusion control. A production-order component is not a reservation.',
  storageLocationInspection: 'Storage-location inspection is not stored. Plant-level and location-level elements are not reconciled.',
  stockTransportReleases: 'Stock-transport releases are not an inclusion control. They are not implemented.',
  subcontracting: 'Subcontracting is not an inclusion control. It is not implemented.',
  independentRequirements: 'Independent requirements are not an inclusion control. They are not stored.',
  specialStock: 'A special-stock indicator is not an inclusion control. It is not stored.',
  checkingControl: 'Checking control is not stored on this screen. A checking rule here is not bound to an order type or a transaction.',
  atpQuantity: 'An ATP quantity is not stored. This configuration does not calculate one.',
};

export class AvailabilityCheckError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'AvailabilityCheckError';
    this.remedy = remedy;
  }
}

export type Flag = 'X' | ' ';
export type PlannedOrderScope = 'X' | 'A' | ' ';
export type ProductionOrderScope = 'X' | 'F' | ' ';
export type PastReceiptScope = 'B' | ' ';

export interface CheckingGroupRow {
  checkingGroup: string;
  description: string;
  noCheck: Flag;
  version: number;
}

export interface CheckingRuleRow {
  checkingRule: string;
  description: string;
  version: number;
}

export interface ScopeOfCheckRow {
  checkingGroup: string;
  checkingRule: string;
  includeSafetyStock: Flag;
  includeQualityStock: Flag;
  includeBlockedStock: Flag;
  includeRestrictedUse: Flag;
  purchaseOrders: Flag;
  purchaseRequisitions: Flag;
  plannedOrders: PlannedOrderScope;
  productionOrders: ProductionOrderScope;
  dependentRequirements: Flag;
  reservations: Flag;
  receiptsInPast: PastReceiptScope;
  version: number;
}

export interface CheckingGroupAssignment {
  materialNumber: string;
  plant: string;
  checkingGroup: string | null;
  version: number;
}

function fail(message: string, remedy?: string): never {
  throw new AvailabilityCheckError(message, remedy);
}

export function availabilityCheckRefusal(input: Record<string, string | undefined>): string | null {
  for (const [key, message] of Object.entries(REFUSED)) {
    if ((input[key] ?? '').trim()) return message;
  }
  return null;
}

function rejectExtensions(extensions: Record<string, string | undefined> | undefined): void {
  const message = availabilityCheckRefusal(extensions ?? {});
  if (message) fail(message, 'Leave the unsupported field unset. Nothing was saved.');
}

function requireReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) fail('A reason is required. Nothing was saved.', 'Say why this configuration changes.');
  return reason;
}

function requireKey(raw: string, label: string): string {
  if (raw !== raw.trim()) {
    fail(`${label} has surrounding spaces. They were not removed. Nothing was saved.`, 'Type the two characters without spaces.');
  }
  if (!/^[A-Z0-9]{2}$/.test(raw)) {
    fail(`${label} ${raw || '(blank)'} is not two characters, A to Z or 0 to 9. It was not changed.`, 'Use a two-character key. It is not padded and it is not truncated.');
  }
  return raw;
}

function requireText(raw: string, limit: number, label: string): string {
  const text = raw.trim();
  if (!text || text.length > limit) {
    fail(`${label} is required and may be at most ${limit} characters. Nothing was saved.`, 'Enter the description in the tenant language.');
  }
  return text;
}

function requireFlag(raw: string, label: string): Flag {
  if (raw === 'X') return 'X';
  if (raw === '' || raw === ' ') return ' ';
  fail(`${label} ${raw} is not X or blank. Nothing was saved.`, 'Use X to include it in a future check, or leave it blank. This save does not run the check.');
}

function requirePlanned(raw: string): PlannedOrderScope {
  if (raw === 'X' || raw === 'A') return raw;
  if (raw === '' || raw === ' ') return ' ';
  if (raw === 'B') {
    fail('Planned-order scope B is not stored. A planned order has no confirmed quantity. Nothing was saved.', 'Use blank, X for every planned order, or A for firmed planned orders only.');
  }
  fail(`Planned-order scope ${raw} is not blank, X, or A. Nothing was saved.`, 'Use blank, X, or A.');
}

function requireProduction(raw: string): ProductionOrderScope {
  if (raw === 'X' || raw === 'F') return raw;
  if (raw === '' || raw === ' ') return ' ';
  fail(`Production-order scope ${raw} is not blank, X, or F. Nothing was saved.`, 'Blank does not include them. X means all production orders. F means released production orders only. This flag does not select an order status and does not run a check.');
}

function requirePast(raw: string): PastReceiptScope {
  if (raw === 'B') return 'B';
  if (raw === '' || raw === ' ') return ' ';
  if (raw === 'A' || raw === 'C') {
    fail(`Receipts in the past ${raw} would require a check message. No message is produced. Nothing was saved.`, 'Use blank to include past and future receipts in a future check, or B for future receipts only.');
  }
  fail(`Receipts in the past ${raw} is not blank or B. Nothing was saved.`, 'Use blank or B.');
}

function purchaseOrdersOf(raw: string): Flag {
  if (raw === 'A') {
    fail('Purchase-order scope A is not stored. A stock-transport confirmed quantity is not stored. Nothing was saved.', 'Use X to name purchase orders for a future check, or leave it blank.');
  }
  return requireFlag(raw, 'Purchase orders');
}

function flag(value: string | null | undefined): Flag {
  return value === 'X' ? 'X' : ' ';
}

async function finish(tx: Tx, client: string, changedBy: string): Promise<void> {
  await markActivityComplete(tx, client, ACTIVITY, changedBy);
}

export async function listAvailabilityCheck(client: string): Promise<{
  groups: CheckingGroupRow[];
  rules: CheckingRuleRow[];
  scopes: ScopeOfCheckRow[];
  assignments: CheckingGroupAssignment[];
  gaps: readonly string[];
}> {
  return withTenant(client, async (tx) => {
    const groups = await tx.select().from(availabilityCheckingGroup)
      .where(eq(availabilityCheckingGroup.client, client))
      .orderBy(asc(availabilityCheckingGroup.checkingGroup));
    const rules = await tx.select().from(availabilityCheckingRule)
      .where(eq(availabilityCheckingRule.client, client))
      .orderBy(asc(availabilityCheckingRule.checkingRule));
    const scopes = await tx.select().from(availabilityCheckScope)
      .where(eq(availabilityCheckScope.client, client))
      .orderBy(asc(availabilityCheckScope.checkingGroup), asc(availabilityCheckScope.checkingRule));
    const assignments = await tx.select({
      materialNumber: materialPlant.materialNumber,
      plant: materialPlant.plant,
      checkingGroup: materialPlant.checkingGroup,
      version: materialPlant.version,
    }).from(materialPlant)
      .where(eq(materialPlant.client, client))
      .orderBy(asc(materialPlant.plant), asc(materialPlant.materialNumber))
      .limit(100);
    return {
      groups: groups.map((row) => ({
        checkingGroup: row.checkingGroup,
        description: row.description,
        noCheck: flag(row.noCheck),
        version: row.version,
      })),
      rules: rules.map((row) => ({
        checkingRule: row.checkingRule,
        description: row.description,
        version: row.version,
      })),
      scopes: scopes.map(scopeOf),
      assignments: assignments.map((row) => ({
        materialNumber: row.materialNumber,
        plant: row.plant,
        checkingGroup: row.checkingGroup,
        version: row.version,
      })),
      gaps: AVAILABILITY_CHECK_GAPS,
    };
  });
}

function scopeOf(row: typeof availabilityCheckScope.$inferSelect): ScopeOfCheckRow {
  return {
    checkingGroup: row.checkingGroup,
    checkingRule: row.checkingRule,
    includeSafetyStock: flag(row.includeSafetyStock),
    includeQualityStock: flag(row.includeQualityStock),
    includeBlockedStock: flag(row.includeBlockedStock),
    includeRestrictedUse: flag(row.includeRestrictedUse),
    purchaseOrders: flag(row.purchaseOrders),
    purchaseRequisitions: flag(row.purchaseRequisitions),
    plannedOrders: row.plannedOrders === 'X' || row.plannedOrders === 'A' ? row.plannedOrders : ' ',
    productionOrders: row.productionOrders === 'X' || row.productionOrders === 'F' ? row.productionOrders : ' ',
    dependentRequirements: flag(row.dependentRequirements),
    reservations: flag(row.reservations),
    receiptsInPast: row.receiptsInPast === 'B' ? 'B' : ' ',
    version: row.version,
  };
}

export async function saveCheckingGroup(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  checkingGroup: string;
  description: string;
  noCheck: string;
  version: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<CheckingGroupRow | null> {
  rejectExtensions(input.extensions);
  const checkingGroup = requireKey(input.checkingGroup, 'Checking group');
  const reason = requireReason(input.reason);
  const description = input.mode === 'DELETE' ? '' : requireText(input.description, 20, 'Checking-group description');
  const noCheck = input.mode === 'DELETE' ? ' ' : requireFlag(input.noCheck, 'No availability check');

  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(availabilityCheckingGroup)
      .where(and(eq(availabilityCheckingGroup.client, input.client), eq(availabilityCheckingGroup.checkingGroup, checkingGroup)))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) fail(`Checking group ${checkingGroup} already stands. Nothing was saved.`, 'Change the standing group, or choose another key.');
      await tx.insert(availabilityCheckingGroup).values({
        client: input.client,
        checkingGroup,
        description,
        noCheck,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) fail(`Checking group ${checkingGroup} does not stand. Nothing was saved.`, 'Create it first.');
      if (existing.version !== input.version) {
        fail(`Checking group ${checkingGroup} was opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`, 'Reload the group and save again.');
      }
      if (input.mode === 'DELETE') {
        const [assigned] = await tx.select({ materialNumber: materialPlant.materialNumber }).from(materialPlant)
          .where(and(eq(materialPlant.client, input.client), eq(materialPlant.checkingGroup, checkingGroup)))
          .limit(1);
        const [scoped] = await tx.select({ checkingGroup: availabilityCheckScope.checkingGroup }).from(availabilityCheckScope)
          .where(and(eq(availabilityCheckScope.client, input.client), eq(availabilityCheckScope.checkingGroup, checkingGroup)))
          .limit(1);
        if (assigned || scoped) fail(`Checking group ${checkingGroup} is assigned or used in a scope. Nothing was deleted.`, 'Clear the assignment and delete the scope first. The group is not a checking rule.');
        await tx.delete(availabilityCheckingGroup).where(and(
          eq(availabilityCheckingGroup.client, input.client),
          eq(availabilityCheckingGroup.checkingGroup, checkingGroup),
        ));
      } else {
        await tx.update(availabilityCheckingGroup).set({
          description,
          noCheck,
          version: existing.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(availabilityCheckingGroup.client, input.client),
          eq(availabilityCheckingGroup.checkingGroup, checkingGroup),
        ));
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'availability_checking_group',
      objectKey: checkingGroup,
      changeType: input.mode === 'CREATE' ? 'CREATE' : input.mode === 'DELETE' ? 'DELETE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? { description: existing.description, noCheck: existing.noCheck } : undefined,
      after: input.mode === 'DELETE' ? undefined : { description, noCheck },
    });
    await finish(tx, input.client, input.changedBy);
    if (input.mode === 'DELETE') return null;
    return { checkingGroup, description, noCheck, version: input.mode === 'CREATE' ? 1 : existing!.version + 1 };
  });
}

export async function saveCheckingRule(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  checkingRule: string;
  description: string;
  version: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<CheckingRuleRow | null> {
  rejectExtensions(input.extensions);
  const checkingRule = requireKey(input.checkingRule, 'Checking rule');
  const reason = requireReason(input.reason);
  const description = input.mode === 'DELETE' ? '' : requireText(input.description, 40, 'Checking-rule description');

  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(availabilityCheckingRule)
      .where(and(eq(availabilityCheckingRule.client, input.client), eq(availabilityCheckingRule.checkingRule, checkingRule)))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) fail(`Checking rule ${checkingRule} already stands. Nothing was saved.`, 'Change the standing rule, or choose another key. A checking group of the same key is not this rule.');
      await tx.insert(availabilityCheckingRule).values({
        client: input.client,
        checkingRule,
        description,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) fail(`Checking rule ${checkingRule} does not stand. Nothing was saved.`, 'Create it first. A checking group is not a checking rule.');
      if (existing.version !== input.version) {
        fail(`Checking rule ${checkingRule} was opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`, 'Reload the rule and save again.');
      }
      if (input.mode === 'DELETE') {
        const [used] = await tx.select({ checkingRule: availabilityCheckScope.checkingRule }).from(availabilityCheckScope)
          .where(and(eq(availabilityCheckScope.client, input.client), eq(availabilityCheckScope.checkingRule, checkingRule)))
          .limit(1);
        if (used) fail(`Checking rule ${checkingRule} is used in a scope. Nothing was deleted.`, 'Delete the scope first. The rule is not removed from a material, because it is not stored there.');
        await tx.delete(availabilityCheckingRule).where(and(
          eq(availabilityCheckingRule.client, input.client),
          eq(availabilityCheckingRule.checkingRule, checkingRule),
        ));
      } else {
        await tx.update(availabilityCheckingRule).set({
          description,
          version: existing.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(availabilityCheckingRule.client, input.client),
          eq(availabilityCheckingRule.checkingRule, checkingRule),
        ));
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'availability_checking_rule',
      objectKey: checkingRule,
      changeType: input.mode === 'CREATE' ? 'CREATE' : input.mode === 'DELETE' ? 'DELETE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? { description: existing.description } : undefined,
      after: input.mode === 'DELETE' ? undefined : { description },
    });
    await finish(tx, input.client, input.changedBy);
    if (input.mode === 'DELETE') return null;
    return { checkingRule, description, version: input.mode === 'CREATE' ? 1 : existing!.version + 1 };
  });
}

export async function assignCheckingGroup(input: {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant: string;
  checkingGroup: string;
  expectedVersion: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<CheckingGroupAssignment> {
  rejectExtensions(input.extensions);
  const materialNumber = input.materialNumber.trim();
  const plant = input.plant.trim();
  const checkingGroup = input.checkingGroup.trim() === '' ? '' : requireKey(input.checkingGroup, 'Checking group');
  const reason = requireReason(input.reason);
  if (!materialNumber || !plant) fail('A material and a plant are required. Nothing was assigned.', 'Name both. This screen does not create a plant view.');

  return withTenant(input.client, async (tx) => {
    const [view] = await tx.select().from(materialPlant)
      .where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, plant),
      ))
      .for('update');
    if (!view) {
      fail(`Material ${materialNumber} has no plant view in ${plant}. Nothing was assigned.`, 'Create the plant view first. A checking group is not assigned at client level.');
    }
    if (view.version !== input.expectedVersion) {
      fail(`Material ${materialNumber} in plant ${plant} was opened at version ${input.expectedVersion}, and version ${view.version} now stands. Nothing was assigned.`, 'Reload the plant view and save again.');
    }
    if (checkingGroup) {
      const [group] = await tx.select({ checkingGroup: availabilityCheckingGroup.checkingGroup })
        .from(availabilityCheckingGroup)
        .where(and(
          eq(availabilityCheckingGroup.client, input.client),
          eq(availabilityCheckingGroup.checkingGroup, checkingGroup),
        ));
      if (!group) fail(`Checking group ${checkingGroup} does not stand. Nothing was assigned.`, 'Create the checking group. A checking rule of the same key is not assigned.');
    }
    const next = checkingGroup || null;
    await tx.update(materialPlant).set({
      checkingGroup: next,
      version: view.version + 1,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(materialPlant.client, input.client),
      eq(materialPlant.materialNumber, materialNumber),
      eq(materialPlant.plant, plant),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: 'material_plant',
      objectKey: `${materialNumber}/${plant}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: { checkingGroup: view.checkingGroup ?? '' },
      after: { checkingGroup },
    });
    return { materialNumber, plant, checkingGroup: next, version: view.version + 1 };
  });
}

export async function saveScopeOfCheck(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  checkingGroup: string;
  checkingRule: string;
  includeSafetyStock: string;
  includeQualityStock: string;
  includeBlockedStock: string;
  includeRestrictedUse: string;
  purchaseOrders: string;
  purchaseRequisitions: string;
  plannedOrders: string;
  productionOrders: string;
  dependentRequirements: string;
  reservations: string;
  receiptsInPast: string;
  version: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<ScopeOfCheckRow | null> {
  rejectExtensions(input.extensions);
  const checkingGroup = requireKey(input.checkingGroup, 'Checking group');
  const checkingRule = requireKey(input.checkingRule, 'Checking rule');
  const reason = requireReason(input.reason);
  const flags = input.mode === 'DELETE' ? null : {
    includeSafetyStock: requireFlag(input.includeSafetyStock, 'Include safety stock'),
    includeQualityStock: requireFlag(input.includeQualityStock, 'Include quality-inspection stock'),
    includeBlockedStock: requireFlag(input.includeBlockedStock, 'Include blocked stock'),
    includeRestrictedUse: requireFlag(input.includeRestrictedUse, 'Include restricted-use batches'),
    purchaseOrders: purchaseOrdersOf(input.purchaseOrders),
    purchaseRequisitions: requireFlag(input.purchaseRequisitions, 'Purchase requisitions'),
    plannedOrders: requirePlanned(input.plannedOrders),
    productionOrders: requireProduction(input.productionOrders),
    dependentRequirements: requireFlag(input.dependentRequirements, 'Dependent requirements'),
    reservations: requireFlag(input.reservations, 'Reservations'),
    receiptsInPast: requirePast(input.receiptsInPast),
  };

  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(availabilityCheckScope)
      .where(and(
        eq(availabilityCheckScope.client, input.client),
        eq(availabilityCheckScope.checkingGroup, checkingGroup),
        eq(availabilityCheckScope.checkingRule, checkingRule),
      ))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) fail(`Scope ${checkingGroup}/${checkingRule} already stands. Nothing was saved.`, 'Change the standing scope. The group and the rule are not interchangeable.');
      const [group] = await tx.select({ checkingGroup: availabilityCheckingGroup.checkingGroup }).from(availabilityCheckingGroup)
        .where(and(eq(availabilityCheckingGroup.client, input.client), eq(availabilityCheckingGroup.checkingGroup, checkingGroup)));
      if (!group) fail(`Checking group ${checkingGroup} does not stand. Nothing was saved.`, 'Create the checking group. A checking rule is not a group.');
      const [rule] = await tx.select({ checkingRule: availabilityCheckingRule.checkingRule }).from(availabilityCheckingRule)
        .where(and(eq(availabilityCheckingRule.client, input.client), eq(availabilityCheckingRule.checkingRule, checkingRule)));
      if (!rule) fail(`Checking rule ${checkingRule} does not stand. Nothing was saved.`, 'Create the checking rule. A checking group is not a rule.');
      await tx.insert(availabilityCheckScope).values({
        client: input.client,
        checkingGroup,
        checkingRule,
        ...flags!,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) fail(`Scope ${checkingGroup}/${checkingRule} does not stand. Nothing was saved.`, 'Create it first.');
      if (existing.version !== input.version) {
        fail(`Scope ${checkingGroup}/${checkingRule} was opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`, 'Reload the scope and save again.');
      }
      if (input.mode === 'DELETE') {
        await tx.delete(availabilityCheckScope).where(and(
          eq(availabilityCheckScope.client, input.client),
          eq(availabilityCheckScope.checkingGroup, checkingGroup),
          eq(availabilityCheckScope.checkingRule, checkingRule),
        ));
      } else {
        await tx.update(availabilityCheckScope).set({
          ...flags!,
          version: existing.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(availabilityCheckScope.client, input.client),
          eq(availabilityCheckScope.checkingGroup, checkingGroup),
          eq(availabilityCheckScope.checkingRule, checkingRule),
        ));
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'availability_check_scope',
      objectKey: `${checkingGroup}/${checkingRule}`,
      changeType: input.mode === 'CREATE' ? 'CREATE' : input.mode === 'DELETE' ? 'DELETE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? { ...scopeOf(existing) } : undefined,
      after: input.mode === 'DELETE' ? undefined : { checkingGroup, checkingRule, ...flags },
    });
    await finish(tx, input.client, input.changedBy);
    if (input.mode === 'DELETE') return null;
    return { checkingGroup, checkingRule, ...flags!, version: input.mode === 'CREATE' ? 1 : existing!.version + 1 };
  });
}
