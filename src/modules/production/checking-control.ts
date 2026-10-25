/**
 * OPJK. Checking control for one production order type in one plant.
 *
 * The SAP key is the plant, the order type, and the business function.
 * Function 1 is check availability during order creation. Function 2 is
 * check availability during order release. No other function is stored.
 *
 * The no-check indicator and the check-on-save indicator must be chosen.
 * A missing row is not a check and not a no-check. A checking rule, when
 * named, must already stand. Blank is not a default rule.
 *
 * Saving does not run an availability check, create an order, or release one.
 * CO01, conversion, release, and MRP do not read this record. CO09 stays blocked.
 */
import { and, asc, eq } from 'drizzle-orm';

import { hasCapability } from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { withTenant } from '../../platform/db/client';
import { plant } from '../foundation/schema';
import { markActivityComplete } from '../../platform/tenancy';
import { availabilityCheckingRule, productionCheckingControl, productionOrderType } from './schema';

export const ACTIVITY = 'CFG.PROD.CHECKCTRL.DEFINE';
export const ROUTE = '/config/checking-control';
export const ALIAS = 'OPJK';
export const LOCK_OBJECT = 'PRODUCTION_CHECKING_CONTROL';
export const PRODUCTION_ORDER_CATEGORY = '10';

export const CHECKING_CONTROL_GAPS = [
  'The key is a standing plant, a standing production order type, and business function 1 or 2. A missing record is not configured. It is not a check and it is not a no-check.',
  'Business function 1 means check availability during order creation. Business function 2 means check availability during order release. Naming either function does not run a check.',
  'The no-check indicator is X or blank. X means no automatic material availability check for that function. Blank means the indicator is not set. Neither value runs a check.',
  'Check on save is X or blank. X means the indicator for a check when the order is saved is set. Blank means that indicator is not set. Saving this record does not run a check.',
  'A checking rule is optional. If it is named, it must already stand. A blank rule is not a default rule and is not PP.',
  'The order type must be category 10. Process orders, networks, and maintenance orders are not this record.',
  'Release control, creation control, PRT, capacity, a component-check type, a status-only check, and batch release are not stored.',
  'Order creation, release, conversion, and MRP do not read this record. CO09 remains blocked. ATP is not calculated.',
] as const;

const REFUSED: Record<string, string> = {
  releaseControl: 'Release control is not stored. This record does not release an order.',
  creationControl: 'Creation control is not stored. This record does not create an order.',
  prtCheck: 'A PRT availability check is not stored. No PRT master stands.',
  prtRule: 'A PRT checking rule is not stored.',
  capacityCheck: 'A capacity availability check is not stored. Capacity is not configured here.',
  capacityRule: 'A capacity checking rule is not stored.',
  componentCheckType: 'A component-check type is not stored. ATP and planning-file checks are not executed.',
  statusOnly: 'A status-only check is not stored. No check runs.',
  batchRelease: 'Batch release control is not stored.',
  atp: 'ATP is not calculated. This record does not make ATP available.',
  co09: 'CO09 remains blocked. This record does not open it.',
  collectCheck: 'A collective availability check is not stored and is not executed.',
  missingParts: 'A missing-parts profile is not stored.',
  processOrder: 'A process order is not this customizing. The category is production order only.',
  network: 'A network is not this customizing. The category is production order only.',
  maintenanceOrder: 'A maintenance order is not this customizing. The category is production order only.',
};

export class CheckingControlError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CheckingControlError';
    this.remedy = remedy;
  }
}

export type BusinessFunction = '1' | '2';
export type Indicator = 'X' | ' ';

export interface CheckingControlRow {
  plant: string;
  orderType: string;
  orderCategory: typeof PRODUCTION_ORDER_CATEGORY;
  businessFunction: BusinessFunction;
  noCheck: Indicator;
  checkingRule: string | null;
  checkOnSave: Indicator;
  version: number;
}

export function holdsCheckingControlAuthority(held: readonly string[]): boolean {
  return hasCapability([...held], ACTIVITY);
}

export function checkingControlRefusal(input: Record<string, string | undefined>): string | null {
  for (const [key, message] of Object.entries(REFUSED)) {
    if ((input[key] ?? '').trim()) return message;
  }
  const category = (input.orderCategory ?? '').trim();
  if (category && category !== PRODUCTION_ORDER_CATEGORY) {
    return `Order category ${category} is not a production order. Nothing was saved.`;
  }
  return null;
}

function fail(message: string, remedy?: string): never {
  throw new CheckingControlError(message, remedy);
}

function rejectExtensions(extensions: Record<string, string | undefined> | undefined): void {
  const message = checkingControlRefusal(extensions ?? {});
  if (message) fail(message, 'Leave the unsupported field unset. Nothing was saved.');
}

function requirePlantKey(raw: string): string {
  if (raw !== raw.trim()) {
    fail('The plant has surrounding spaces. They were not removed. Nothing was saved.', 'Type the standing plant key.');
  }
  if (!raw || raw.length > 10) {
    fail(`Plant ${raw || '(blank)'} does not stand. Nothing was saved.`, 'Choose a plant from the plant master. The key is not shortened.');
  }
  return raw;
}

function requireOrderType(raw: string): string {
  if (raw !== raw.trim()) {
    fail('The order type has surrounding spaces. They were not removed. Nothing was saved.', 'Type the standing order type.');
  }
  if (!/^[A-Z0-9]{4}$/.test(raw)) {
    fail(`Order type ${raw || '(blank)'} is not four characters, A to Z or 0 to 9. It was not padded.`, 'Define the production order type first.');
  }
  return raw;
}

function requireFunction(raw: string): BusinessFunction {
  if (raw !== raw.trim()) {
    fail('The business function has surrounding spaces. They were not removed. Nothing was saved.', 'Choose 1 or 2.');
  }
  if (raw !== '1' && raw !== '2') {
    fail(
      `Business function ${raw || '(blank)'} is not 1 or 2. Nothing was saved.`,
      '1 means check availability during order creation. 2 means check availability during order release. Neither function runs a check.',
    );
  }
  return raw;
}

function requireIndicator(raw: string, label: string): Indicator {
  if (raw === '') {
    fail(
      `The ${label} was not chosen. Nothing was saved. A missing record is not a check and not a no-check.`,
      'Choose X or blank. Neither choice runs a check.',
    );
  }
  if (raw !== 'X' && raw !== ' ') {
    fail(
      `The ${label} is not X or blank. Nothing was saved.`,
      'X and blank are the only values. Neither runs a check.',
    );
  }
  return raw;
}

function requireRule(raw: string): string | null {
  if (raw === '' || raw === ' ') return null;
  if (raw !== raw.trim() || !/^[A-Z0-9]{2}$/.test(raw)) {
    fail(
      `Checking rule ${raw || '(blank)'} is not two characters, A to Z or 0 to 9. It was not padded. Nothing was saved.`,
      'Leave it blank, or type a rule that already stands. Blank is not a default rule.',
    );
  }
  return raw;
}

function requireReason(raw: string): string {
  const reason = raw.trim();
  if (!reason) fail('A reason is required. Nothing was saved.', 'Say why this checking control changes.');
  return reason;
}

function rowOf(row: {
  plant: string;
  orderType: string;
  businessFunction: string;
  noCheck: string;
  checkingRule: string | null;
  checkOnSave: string;
  version: number;
}): CheckingControlRow {
  return {
    plant: row.plant,
    orderType: row.orderType,
    orderCategory: PRODUCTION_ORDER_CATEGORY,
    businessFunction: row.businessFunction as BusinessFunction,
    noCheck: row.noCheck as Indicator,
    checkingRule: row.checkingRule,
    checkOnSave: row.checkOnSave as Indicator,
    version: row.version,
  };
}

export async function listCheckingControls(client: string): Promise<{
  controls: CheckingControlRow[];
  gaps: readonly string[];
}> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(productionCheckingControl)
      .where(eq(productionCheckingControl.client, client))
      .orderBy(
        asc(productionCheckingControl.plant),
        asc(productionCheckingControl.orderType),
        asc(productionCheckingControl.businessFunction),
      );
    return { controls: rows.map(rowOf), gaps: CHECKING_CONTROL_GAPS };
  });
}

export async function saveCheckingControl(input: {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE' | 'DELETE';
  plant: string;
  orderType: string;
  businessFunction: string;
  noCheck: string;
  checkingRule: string;
  checkOnSave: string;
  version: number;
  reason: string;
  extensions?: Record<string, string | undefined>;
}): Promise<CheckingControlRow | null> {
  rejectExtensions(input.extensions);
  const plantKey = requirePlantKey(input.plant);
  const orderType = requireOrderType(input.orderType);
  const businessFunction = requireFunction(input.businessFunction);
  const noCheck = input.mode === 'DELETE' ? ' ' : requireIndicator(input.noCheck, 'no-check indicator');
  const checkOnSave = input.mode === 'DELETE' ? ' ' : requireIndicator(input.checkOnSave, 'check-on-save indicator');
  const checkingRule = input.mode === 'DELETE' ? null : requireRule(input.checkingRule);
  const reason = requireReason(input.reason);

  return withTenant(input.client, async (tx) => {
    const [site] = await tx.select({ plant: plant.plant }).from(plant)
      .where(and(eq(plant.client, input.client), eq(plant.plant, plantKey)));
    if (!site) {
      fail(`Plant ${plantKey} does not stand in this tenant. Nothing was saved.`, 'Choose a plant from the plant master.');
    }
    const [type] = await tx.select().from(productionOrderType)
      .where(and(eq(productionOrderType.client, input.client), eq(productionOrderType.orderType, orderType)));
    if (!type) {
      fail(`Order type ${orderType} does not stand in this tenant. Nothing was saved.`, 'Define the production order type first.');
    }
    if (type.orderCategory !== PRODUCTION_ORDER_CATEGORY) {
      fail(`Order type ${orderType} is not a production order type. Nothing was saved.`, 'This screen maintains category 10 only.');
    }
    if (checkingRule) {
      const [rule] = await tx.select({ checkingRule: availabilityCheckingRule.checkingRule }).from(availabilityCheckingRule)
        .where(and(eq(availabilityCheckingRule.client, input.client), eq(availabilityCheckingRule.checkingRule, checkingRule)));
      if (!rule) {
        fail(
          `Checking rule ${checkingRule} does not stand in this tenant. Nothing was saved.`,
          'Leave the rule blank, or define it first. Blank is not a default rule and is not a no-check.',
        );
      }
    }
    const [existing] = await tx.select().from(productionCheckingControl)
      .where(and(
        eq(productionCheckingControl.client, input.client),
        eq(productionCheckingControl.plant, plantKey),
        eq(productionCheckingControl.orderType, orderType),
        eq(productionCheckingControl.businessFunction, businessFunction),
      ))
      .for('update');
    if (input.mode === 'CREATE') {
      if (existing) {
        fail(
          `Checking control for ${plantKey} / ${orderType} / ${businessFunction} already stands. Nothing was saved.`,
          'Change the standing record, or choose another plant, type, or function.',
        );
      }
      await tx.insert(productionCheckingControl).values({
        client: input.client,
        plant: plantKey,
        orderType,
        businessFunction,
        noCheck,
        checkingRule,
        checkOnSave,
        version: 1,
        createdBy: input.changedBy,
      });
    } else {
      if (!existing) {
        fail(
          `Checking control for ${plantKey} / ${orderType} / ${businessFunction} does not stand. Nothing was saved.`,
          'Create it first. A missing record is not a check and not a no-check.',
        );
      }
      if (existing.version !== input.version) {
        fail(
          `Checking control for ${plantKey} / ${orderType} / ${businessFunction} was opened at version ${input.version}, and version ${existing.version} now stands. Nothing was saved.`,
          'Reload the record and save again.',
        );
      }
      if (input.mode === 'DELETE') {
        await tx.delete(productionCheckingControl).where(and(
          eq(productionCheckingControl.client, input.client),
          eq(productionCheckingControl.plant, plantKey),
          eq(productionCheckingControl.orderType, orderType),
          eq(productionCheckingControl.businessFunction, businessFunction),
        ));
      } else {
        await tx.update(productionCheckingControl).set({
          noCheck,
          checkingRule,
          checkOnSave,
          version: existing.version + 1,
          changedBy: input.changedBy,
          changedAt: new Date(),
        }).where(and(
          eq(productionCheckingControl.client, input.client),
          eq(productionCheckingControl.plant, plantKey),
          eq(productionCheckingControl.orderType, orderType),
          eq(productionCheckingControl.businessFunction, businessFunction),
        ));
      }
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'production_checking_control',
      objectKey: `${plantKey}/${orderType}/${businessFunction}`,
      changeType: input.mode === 'CREATE' ? 'CREATE' : input.mode === 'DELETE' ? 'DELETE' : 'CHANGE',
      changedBy: input.changedBy,
      reason,
      transactionCode: ACTIVITY,
      before: existing ? {
        noCheck: existing.noCheck,
        checkingRule: existing.checkingRule,
        checkOnSave: existing.checkOnSave,
      } : undefined,
      after: input.mode === 'DELETE' ? undefined : {
        noCheck,
        checkingRule,
        checkOnSave,
      },
    });
    await markActivityComplete(tx, input.client, ACTIVITY, input.changedBy);
    if (input.mode === 'DELETE') return null;
    return {
      plant: plantKey,
      orderType,
      orderCategory: PRODUCTION_ORDER_CATEGORY,
      businessFunction,
      noCheck,
      checkingRule,
      checkOnSave,
      version: input.mode === 'CREATE' ? 1 : existing!.version + 1,
    };
  });
}
