import { and, count, eq, ne } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { changeDocument } from '../../platform/tables/audit-trail';
import { markActivityComplete } from '../../platform/tenancy';
import { postingEvent } from '../foundation/account-determination';
import {
  materialDocumentLine,
  movementType,
  reservationHeader,
} from './schema';
import {
  MOVEMENT_ASSIGNMENTS,
  MOVEMENT_DIRECTIONS,
  MOVEMENT_KINDS,
  MOVEMENT_NEGATIVE_POLICIES,
  MOVEMENT_REFERENCES,
  MOVEMENT_RULES,
  MOVEMENT_STOCK_TYPES,
} from './movement-type-vocabulary';

/**
 * Movement type configuration (OMJJ as a search alias only).
 *
 * The movement catalogue already stands. Posting, reversal, transfer, return,
 * reservation and account determination read `movement_type`. This service
 * maintains that row. It does not post stock, write a journal, or consult a
 * posting period. A second configuration table, a stored three-digit code, a
 * draft, a version, a policy identifier and a field-selection profile are
 * refused by name: none of them is what a posting service reads.
 *
 * A movement a material document or a reservation already cites keeps its
 * posting rules. The description may still change, and the change document is
 * the history. The posted document is not rewritten.
 */

export const ACTIVITY = 'CFG.INV.MOVETYPE.CONFIG';
export const ROUTE = '/config/movement-types';

export class MovementTypeConfigError extends Error {
  constructor(
    message: string,
    public remedy?: string,
  ) {
    super(message);
    this.name = 'MovementTypeConfigError';
  }
}

const OBJECT_CLASS = 'movement_type';
const PRODUCTION = process.env.NODE_ENV === 'production';

/**
 * Lookups that take the first row of a pair, or that refuse more than one.
 * A second row would make a closed posting round guess. Named here so the
 * workbench refuses it before a posting does.
 */
const SINGLE_ROW_LOOKUPS: ReadonlyArray<{
  direction: string;
  referenceCategory?: string;
  movementKind?: string;
  because: string;
}> = [
  {
    direction: 'RECEIPT',
    referenceCategory: 'PURCHASE_ORDER',
    because: 'Goods receipt takes the first receipt movement that references a purchase order, and will not guess between two.',
  },
  {
    direction: 'REVERSAL',
    referenceCategory: 'MATERIAL_DOCUMENT',
    because: 'Goods receipt reversal takes the first reversal movement that references a material document, and will not guess between two.',
  },
];

export interface MovementTypeInput {
  client: string;
  changedBy: string;
  mode: 'CREATE' | 'CHANGE';
  movementType: string;
  description: string;
  direction: string;
  referenceCategory: string;
  reversalMovementType?: string;
  movementKind?: string;
  sourceStockType?: string;
  destinationStockType?: string;
  plantRule?: string;
  locationRule?: string;
  negativeStockPolicy?: string;
  valuationRelevant?: boolean;
  inventoryEvent?: string;
  offsetEvent?: string;
  offsetModifier?: string;
  accountAssignment?: string;
  reason: string;
  requestKey?: string;
  /** Refused by name. Not a column a posting service reads. */
  generalLedgerAccount?: string;
  companyCode?: string;
  bwart?: string;
  status?: string;
  version?: string;
  policyId?: string;
  fieldSelectionProfile?: string;
  specialStockIndicator?: string;
  postingPeriod?: string;
  transportRequest?: string;
  approval?: string;
  isTwoStep?: boolean;
  requiresBatch?: boolean;
  requiresSerial?: boolean;
  requiresSpecialStock?: boolean;
  requiresValuationType?: boolean;
}

export interface MovementTypeRules {
  direction: string;
  referenceCategory: string;
  reversalMovementType: string | null;
  movementKind: string;
  sourceStockType: string | null;
  destinationStockType: string | null;
  plantRule: string;
  locationRule: string;
  negativeStockPolicy: string;
  valuationRelevant: boolean;
  inventoryEvent: string | null;
  offsetEvent: string | null;
  offsetModifier: string | null;
  accountAssignment: string;
}

export interface MovementTypeRow extends MovementTypeRules {
  movementType: string;
  description: string;
  documentCount: number;
  reservationCount: number;
  namedAsReversal: string[];
}

interface Usage {
  documents: number;
  reservations: number;
  namedAsReversal: string[];
}

function requireClient(client: string): string {
  const value = client?.trim() ?? '';
  if (!value) throw new MovementTypeConfigError('The tenant is missing.', 'Sign in again.');
  return value;
}

function requireActor(changedBy: string): string {
  const value = changedBy?.trim() ?? '';
  if (!value) throw new MovementTypeConfigError('The acting user is missing.', 'Sign in again.');
  return PRODUCTION ? value : value.toUpperCase();
}

function requireReason(reason: string): string {
  const value = reason?.trim() ?? '';
  if (!value) {
    throw new MovementTypeConfigError(
      'A reason is required for every movement type change.',
      'State why this change is being made.',
    );
  }
  return value;
}

function requireKey(value: string): string {
  const key = (value ?? '').trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,20}$/.test(key)) {
    throw new MovementTypeConfigError(
      'The movement type must be one to 20 uppercase letters, digits or underscores.',
      'The catalogue key is the identity. A three-digit alias is not stored beside it.',
    );
  }
  return key;
}

function blank(value: string | undefined): string | null {
  const text = (value ?? '').trim();
  return text ? text : null;
}

function oneOf(value: string, allowed: readonly string[], label: string): string {
  const key = value.trim().toUpperCase();
  if (!allowed.includes(key)) {
    throw new MovementTypeConfigError(
      `${label} must be one of ${allowed.join(', ')}.`,
      `Choose a ${label.toLowerCase()} the catalogue already stores.`,
    );
  }
  return key;
}

function optionalCode(value: string | undefined, pattern: RegExp, label: string): string | null {
  const text = blank(value);
  if (!text) return null;
  const key = text.toUpperCase();
  if (!pattern.test(key)) {
    throw new MovementTypeConfigError(
      `${label} is not a catalogue code.`,
      `Correct the ${label.toLowerCase()}, or leave it blank.`,
    );
  }
  return key;
}

function refuseAbsent(input: MovementTypeInput): void {
  const named: Array<[string | undefined, string, string]> = [
    [input.generalLedgerAccount, 'A G/L account', 'The movement stores an account-determination event and a modifier. The account is derived when a posting runs.'],
    [input.companyCode, 'A company code', 'A movement type stands for the tenant. It is not maintained per company code.'],
    [input.bwart, 'A three-digit movement code', 'The catalogue key is the identity. A three-digit alias is not stored.'],
    [input.status, 'A draft or active status', 'A movement stands when the row stands. Posting services do not read a status.'],
    [input.version, 'A configuration version', 'The change document is the history. A version is not stored on the movement or on a posted document.'],
    [input.policyId, 'A quantity or value policy', 'Quantity and value behaviour is the direction, the stock types and the valuation flag on this row.'],
    [input.fieldSelectionProfile, 'A field-selection profile', 'The posting screen owns its fields. This catalogue does not store a profile.'],
    [input.specialStockIndicator, 'A special-stock indicator', 'Special stock is not a one-character indicator, and this screen does not invent a stock type.'],
    [input.postingPeriod, 'A posting period', 'Configuration is not a posting. A closed period does not block this screen.'],
    [input.transportRequest, 'A transport', 'A movement change is recorded as a change document. It is not transported.'],
    [input.approval, 'An approval', 'A movement change is not an approval workflow.'],
  ];
  for (const [value, label, remedy] of named) {
    if (value?.trim()) {
      throw new MovementTypeConfigError(`${label} is not stored on a movement type.`, remedy);
    }
  }
  if (input.isTwoStep) {
    throw new MovementTypeConfigError(
      'A two-step movement is not carried. In-transit stock does not stand.',
      'Leave the movement one-step. A two-step transfer is refused by name when someone chooses it.',
    );
  }
  if (input.requiresBatch) {
    throw new MovementTypeConfigError(
      'A batch requirement is not set on this screen.',
      'The posting uses the batch already entered when the movement row already requires one. This screen does not add a second posting engine.',
    );
  }
  if (input.requiresSerial) {
    throw new MovementTypeConfigError(
      'Serial requirement is not configured here. No serial master stands.',
      'Leave serial off.',
    );
  }
  if (input.requiresSpecialStock) {
    throw new MovementTypeConfigError(
      'Special stock is not a stock type this screen invents.',
      'Leave special stock off. The stock type on the row is unrestricted, quality or blocked.',
    );
  }
  if (input.requiresValuationType) {
    throw new MovementTypeConfigError(
      'A valuation type is not configured here. Split valuation does not stand.',
      'Leave the valuation type off.',
    );
  }
}

function rulesFrom(input: MovementTypeInput): { description: string; rules: MovementTypeRules } {
  const description = (input.description ?? '').trim();
  if (!description || description.length > 60) {
    throw new MovementTypeConfigError(
      'The description is required and may be at most 60 characters.',
      'Enter a description within the limit.',
    );
  }
  const direction = oneOf(input.direction ?? '', MOVEMENT_DIRECTIONS, 'Direction');
  const referenceCategory = oneOf(input.referenceCategory ?? '', MOVEMENT_REFERENCES, 'Reference');
  const movementKind = oneOf(input.movementKind?.trim() ? input.movementKind : 'MATERIAL', MOVEMENT_KINDS, 'Movement kind');
  const sourceStockType = optionalCode(input.sourceStockType, /^(UNRESTRICTED|QUALITY|BLOCKED)$/, 'Source stock type');
  const destinationStockType = optionalCode(
    input.destinationStockType,
    /^(UNRESTRICTED|QUALITY|BLOCKED)$/,
    'Destination stock type',
  );
  if (Boolean(sourceStockType) !== Boolean(destinationStockType)) {
    throw new MovementTypeConfigError(
      'Source and destination stock types are a pair.',
      'Name both, or leave both blank.',
    );
  }
  if (sourceStockType && !MOVEMENT_STOCK_TYPES.includes(sourceStockType as typeof MOVEMENT_STOCK_TYPES[number])) {
    throw new MovementTypeConfigError('The stock type is not one the stock balance stores.', 'Use unrestricted, quality or blocked.');
  }
  const plantRule = oneOf(input.plantRule?.trim() ? input.plantRule : 'ANY', MOVEMENT_RULES, 'Plant rule');
  const locationRule = oneOf(input.locationRule?.trim() ? input.locationRule : 'ANY', MOVEMENT_RULES, 'Storage location rule');
  const negativeStockPolicy = oneOf(
    input.negativeStockPolicy?.trim() ? input.negativeStockPolicy : 'LOCATION',
    MOVEMENT_NEGATIVE_POLICIES,
    'Negative stock policy',
  );
  const accountAssignment = oneOf(
    input.accountAssignment?.trim() ? input.accountAssignment : 'NONE',
    MOVEMENT_ASSIGNMENTS,
    'Account assignment',
  );
  const inventoryEvent = optionalCode(input.inventoryEvent, /^[A-Z][A-Z0-9_]{0,39}$/, 'Inventory event');
  const offsetEvent = optionalCode(input.offsetEvent, /^[A-Z][A-Z0-9_]{0,39}$/, 'Offset event');
  const offsetModifier = optionalCode(input.offsetModifier, /^[A-Z0-9]{1,4}$/, 'Account modifier');
  for (const event of [inventoryEvent, offsetEvent]) {
    if (event && !postingEvent(event)) {
      throw new MovementTypeConfigError(
        `Posting event ${event} is not in the account-determination catalogue.`,
        'Name an event the account-determination activity already defines, or leave it blank. The event is not a G/L account.',
      );
    }
  }
  const valuationRelevant = input.valuationRelevant === true;
  if (movementKind === 'INVENTORY_DIFFERENCE') {
    if (direction !== 'RECEIPT' && direction !== 'ISSUE') {
      throw new MovementTypeConfigError(
        'An inventory difference movement receives or issues. It does not transfer or reverse.',
        'Choose receipt or issue.',
      );
    }
    if (referenceCategory !== 'PHYSICAL_INVENTORY') {
      throw new MovementTypeConfigError(
        'An inventory difference movement references a physical inventory.',
        'Set the reference to physical inventory.',
      );
    }
    if (valuationRelevant && (!inventoryEvent || !offsetEvent || !offsetModifier)) {
      throw new MovementTypeConfigError(
        'A valuing inventory difference needs an inventory event, an offset event and a modifier.',
        'Name the three determination inputs, or leave the movement unvalued. None of them is a G/L account.',
      );
    }
  }
  return {
    description,
    rules: {
      direction,
      referenceCategory,
      reversalMovementType: blank(input.reversalMovementType)?.toUpperCase() ?? null,
      movementKind,
      sourceStockType,
      destinationStockType,
      plantRule,
      locationRule,
      negativeStockPolicy,
      valuationRelevant,
      inventoryEvent,
      offsetEvent,
      offsetModifier,
      accountAssignment,
    },
  };
}

function sameRules(left: MovementTypeRules, right: MovementTypeRules): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function usageText(usage: Usage): string {
  const named = usage.namedAsReversal.length > 0 ? usage.namedAsReversal.join(', ') : 'none';
  return `${usage.documents} material document line(s), ${usage.reservations} reservation(s), and reversal of ${named}`;
}

/** A posted document or a reservation cites the movement. Its posting rules stay. */
function citedByHistory(usage: Usage): boolean {
  return usage.documents > 0 || usage.reservations > 0;
}

/**
 * Also named as another movement's reversal. That blocks deletion, because the
 * other row depends on it. It does not freeze the rules: completing a reciprocal
 * pair is a change to the counter, and no document has been rewritten.
 */
function citedAtAll(usage: Usage): boolean {
  return citedByHistory(usage) || usage.namedAsReversal.length > 0;
}

async function usageOf(tx: Tx, client: string, key: string): Promise<Usage> {
  const [documents] = await tx
    .select({ n: count() })
    .from(materialDocumentLine)
    .where(and(eq(materialDocumentLine.client, client), eq(materialDocumentLine.movementType, key)));
  const [reservations] = await tx
    .select({ n: count() })
    .from(reservationHeader)
    .where(and(eq(reservationHeader.client, client), eq(reservationHeader.movementType, key)));
  const named = await tx
    .select({ movementType: movementType.movementType })
    .from(movementType)
    .where(and(eq(movementType.client, client), eq(movementType.reversalMovementType, key)));
  return {
    documents: Number(documents?.n ?? 0),
    reservations: Number(reservations?.n ?? 0),
    namedAsReversal: named.map((row) => row.movementType).sort(),
  };
}

async function assertReversal(tx: Tx, client: string, key: string, reversal: string | null): Promise<void> {
  if (!reversal) return;
  if (reversal === key) {
    throw new MovementTypeConfigError(
      'A movement cannot name itself as its reversal.',
      'Name a different movement, or leave the reversal blank.',
    );
  }
  const [target] = await tx
    .select()
    .from(movementType)
    .where(and(eq(movementType.client, client), eq(movementType.movementType, reversal)));
  if (!target) {
    throw new MovementTypeConfigError(
      `Reversal movement ${reversal} does not stand.`,
      'Create the reversal movement first, then name it here.',
    );
  }
  if (target.reversalMovementType && target.reversalMovementType !== key) {
    throw new MovementTypeConfigError(
      `Reversal movement ${reversal} already names ${target.reversalMovementType}, not ${key}.`,
      'A reversal names one counter. Clear that pairing first, or choose the movement it already names.',
    );
  }
}

async function assertUniqueLookup(tx: Tx, client: string, key: string, rules: MovementTypeRules): Promise<void> {
  for (const lookup of SINGLE_ROW_LOOKUPS) {
    if (rules.direction !== lookup.direction) continue;
    if (lookup.referenceCategory && rules.referenceCategory !== lookup.referenceCategory) continue;
    const [other] = await tx
      .select({ movementType: movementType.movementType })
      .from(movementType)
      .where(and(
        eq(movementType.client, client),
        eq(movementType.direction, lookup.direction),
        eq(movementType.referenceCategory, lookup.referenceCategory!),
        ne(movementType.movementType, key),
      ));
    if (other) {
      throw new MovementTypeConfigError(
        `Movement ${other.movementType} already stands for ${lookup.direction} / ${lookup.referenceCategory}.`,
        lookup.because,
      );
    }
  }
  if (rules.movementKind === 'INVENTORY_DIFFERENCE') {
    const [other] = await tx
      .select({ movementType: movementType.movementType })
      .from(movementType)
      .where(and(
        eq(movementType.client, client),
        eq(movementType.movementKind, 'INVENTORY_DIFFERENCE'),
        eq(movementType.direction, rules.direction),
        ne(movementType.movementType, key),
      ));
    if (other) {
      throw new MovementTypeConfigError(
        `Difference movement ${other.movementType} already stands for a ${rules.direction.toLowerCase()}.`,
        'Physical inventory posting refuses two difference movements for one direction. Change the standing movement, or leave this one a different kind.',
      );
    }
  }
}

function requestKeyOf(value: string | undefined): string | null {
  const key = (value ?? '').trim();
  if (!key) return null;
  if (key.length > 64) {
    throw new MovementTypeConfigError('The request key is longer than 64 characters.', 'Use a shorter key.');
  }
  return key;
}

async function priorRequest(tx: Tx, client: string, requestKey: string | null) {
  if (!requestKey) return null;
  const [prior] = await tx
    .select()
    .from(changeDocument)
    .where(and(
      eq(changeDocument.client, client),
      eq(changeDocument.objectClass, OBJECT_CLASS),
      eq(changeDocument.correlationId, requestKey),
    ))
    .limit(1);
  return prior ?? null;
}

function snapshot(description: string, rules: MovementTypeRules) {
  return { description, ...rules };
}

export async function listMovementTypes(client: string): Promise<MovementTypeRow[]> {
  const tenant = requireClient(client);
  return withTenant(tenant, async (tx) => {
    const rows = await tx
      .select()
      .from(movementType)
      .where(eq(movementType.client, tenant))
      .orderBy(movementType.movementType);
    const listed: MovementTypeRow[] = [];
    for (const row of rows) {
      const usage = await usageOf(tx, tenant, row.movementType);
      listed.push({
        movementType: row.movementType,
        description: row.description,
        direction: row.direction,
        referenceCategory: row.referenceCategory,
        reversalMovementType: row.reversalMovementType,
        movementKind: row.movementKind,
        sourceStockType: row.sourceStockType,
        destinationStockType: row.destinationStockType,
        plantRule: row.plantRule,
        locationRule: row.locationRule,
        negativeStockPolicy: row.negativeStockPolicy,
        valuationRelevant: row.valuationRelevant,
        inventoryEvent: row.inventoryEvent,
        offsetEvent: row.offsetEvent,
        offsetModifier: row.offsetModifier,
        accountAssignment: row.accountAssignment,
        documentCount: usage.documents,
        reservationCount: usage.reservations,
        namedAsReversal: usage.namedAsReversal,
      });
    }
    return listed;
  });
}

/** A check reads one movement. It writes nothing, and a missing period does not block it. */
export async function checkMovementType(client: string, movementTypeKey: string): Promise<MovementTypeRow> {
  const tenant = requireClient(client);
  const key = requireKey(movementTypeKey);
  return withTenant(tenant, async (tx) => {
    const [row] = await tx
      .select()
      .from(movementType)
      .where(and(eq(movementType.client, tenant), eq(movementType.movementType, key)));
    if (!row) {
      throw new MovementTypeConfigError(
        `Movement type ${key} does not stand.`,
        'Create it, or check a movement the catalogue already carries.',
      );
    }
    const usage = await usageOf(tx, tenant, key);
    return {
      movementType: row.movementType,
      description: row.description,
      direction: row.direction,
      referenceCategory: row.referenceCategory,
      reversalMovementType: row.reversalMovementType,
      movementKind: row.movementKind,
      sourceStockType: row.sourceStockType,
      destinationStockType: row.destinationStockType,
      plantRule: row.plantRule,
      locationRule: row.locationRule,
      negativeStockPolicy: row.negativeStockPolicy,
      valuationRelevant: row.valuationRelevant,
      inventoryEvent: row.inventoryEvent,
      offsetEvent: row.offsetEvent,
      offsetModifier: row.offsetModifier,
      accountAssignment: row.accountAssignment,
      documentCount: usage.documents,
      reservationCount: usage.reservations,
      namedAsReversal: usage.namedAsReversal,
    };
  });
}

export async function saveMovementType(input: MovementTypeInput) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.movementType);
  const requestKey = requestKeyOf(input.requestKey);
  refuseAbsent(input);
  const { description, rules } = rulesFrom(input);

  return withTenant(client, async (tx) => {
    const [existing] = await tx
      .select()
      .from(movementType)
      .where(and(eq(movementType.client, client), eq(movementType.movementType, key)))
      .for('update');
    const prior = await priorRequest(tx, client, requestKey);
    if (prior) {
      if (prior.objectKey !== key) {
        throw new MovementTypeConfigError(
          `This request key already recorded a change to movement type ${prior.objectKey}.`,
          'Use a new request key for a different movement.',
        );
      }
      if (!existing) {
        throw new MovementTypeConfigError(
          `This request key recorded movement type ${key}, which no longer stands.`,
          'Create it again under a new request key.',
        );
      }
      const current = snapshot(existing.description, {
        direction: existing.direction,
        referenceCategory: existing.referenceCategory,
        reversalMovementType: existing.reversalMovementType,
        movementKind: existing.movementKind,
        sourceStockType: existing.sourceStockType,
        destinationStockType: existing.destinationStockType,
        plantRule: existing.plantRule,
        locationRule: existing.locationRule,
        negativeStockPolicy: existing.negativeStockPolicy,
        valuationRelevant: existing.valuationRelevant,
        inventoryEvent: existing.inventoryEvent,
        offsetEvent: existing.offsetEvent,
        offsetModifier: existing.offsetModifier,
        accountAssignment: existing.accountAssignment,
      });
      if (JSON.stringify(current) !== JSON.stringify(snapshot(description, rules))) {
        throw new MovementTypeConfigError(
          'This request key already recorded a different movement type change.',
          'Repeat the same change, or use a new request key.',
        );
      }
      return { movementType: key, changed: false, replayed: true };
    }

    await assertReversal(tx, client, key, rules.reversalMovementType);
    await assertUniqueLookup(tx, client, key, rules);

    if (input.mode === 'CREATE') {
      if (existing) {
        throw new MovementTypeConfigError(
          `Movement type ${key} already stands.`,
          'Change the standing movement, or choose a new key.',
        );
      }
      await tx.insert(movementType).values({
        client,
        movementType: key,
        description,
        ...rules,
        createdBy: changedBy,
      });
      await recordChange(tx, {
        client,
        objectClass: OBJECT_CLASS,
        objectKey: key,
        changeType: 'CREATE',
        changedBy,
        reason,
        transactionCode: ACTIVITY,
        correlationId: requestKey ?? undefined,
        after: snapshot(description, rules),
        securityRelevantFields: ['direction', 'valuationRelevant', 'inventoryEvent', 'offsetEvent', 'offsetModifier'],
      });
      await markActivityComplete(tx, client, ACTIVITY, changedBy);
      return { movementType: key, changed: true, replayed: false };
    }

    if (!existing) {
      throw new MovementTypeConfigError(
        `Movement type ${key} does not stand.`,
        'Create it first, then change it.',
      );
    }
    const standingRules: MovementTypeRules = {
      direction: existing.direction,
      referenceCategory: existing.referenceCategory,
      reversalMovementType: existing.reversalMovementType,
      movementKind: existing.movementKind,
      sourceStockType: existing.sourceStockType,
      destinationStockType: existing.destinationStockType,
      plantRule: existing.plantRule,
      locationRule: existing.locationRule,
      negativeStockPolicy: existing.negativeStockPolicy,
      valuationRelevant: existing.valuationRelevant,
      inventoryEvent: existing.inventoryEvent,
      offsetEvent: existing.offsetEvent,
      offsetModifier: existing.offsetModifier,
      accountAssignment: existing.accountAssignment,
    };
    const before = snapshot(existing.description, standingRules);
    const after = snapshot(description, rules);
    if (JSON.stringify(before) === JSON.stringify(after)) {
      return { movementType: key, changed: false, replayed: false };
    }
    const usage = await usageOf(tx, client, key);
    if (citedByHistory(usage) && !sameRules(standingRules, rules)) {
      throw new MovementTypeConfigError(
        `Movement type ${key} is already cited (${usageText(usage)}). Its posting rules are not changed.`,
        'Change the description only. A posted document keeps the movement it was posted with, and this screen does not rewrite it.',
      );
    }
    await tx
      .update(movementType)
      .set({ description, ...rules, changedBy, changedAt: new Date() })
      .where(and(eq(movementType.client, client), eq(movementType.movementType, key)));
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'CHANGE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before,
      after,
      securityRelevantFields: ['direction', 'valuationRelevant', 'inventoryEvent', 'offsetEvent', 'offsetModifier'],
    });
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { movementType: key, changed: true, replayed: false };
  });
}

export async function deleteMovementType(input: {
  client: string;
  changedBy: string;
  movementType: string;
  reason: string;
  requestKey?: string;
}) {
  const client = requireClient(input.client);
  const changedBy = requireActor(input.changedBy);
  const reason = requireReason(input.reason);
  const key = requireKey(input.movementType);
  const requestKey = requestKeyOf(input.requestKey);

  return withTenant(client, async (tx) => {
    const prior = await priorRequest(tx, client, requestKey);
    const [existing] = await tx
      .select()
      .from(movementType)
      .where(and(eq(movementType.client, client), eq(movementType.movementType, key)))
      .for('update');
    if (prior?.changeType === 'DELETE' && prior.objectKey === key && !existing) {
      return { movementType: key, deleted: false, replayed: true };
    }
    if (!existing) {
      throw new MovementTypeConfigError(
        `Movement type ${key} does not stand.`,
        'Nothing remains to delete.',
      );
    }
    const usage = await usageOf(tx, client, key);
    if (citedAtAll(usage)) {
      throw new MovementTypeConfigError(
        `Movement type ${key} is already cited (${usageText(usage)}). It is not deleted.`,
        'Leave it standing. History is not removed with the configuration.',
      );
    }
    await recordChange(tx, {
      client,
      objectClass: OBJECT_CLASS,
      objectKey: key,
      changeType: 'DELETE',
      changedBy,
      reason,
      transactionCode: ACTIVITY,
      correlationId: requestKey ?? undefined,
      before: { movementType: key, description: existing.description, direction: existing.direction },
    });
    await tx
      .delete(movementType)
      .where(and(eq(movementType.client, client), eq(movementType.movementType, key)));
    await markActivityComplete(tx, client, ACTIVITY, changedBy);
    return { movementType: key, deleted: true, replayed: false };
  });
}
