/**
 * The goods movements a production-order confirmation causes.
 *
 * A confirmation is the event that proves work was done, so it is the event that may
 * move stock: a component whose material is marked for backflush is withdrawn against
 * the order, and a final confirmation of a material marked for automatic goods receipt
 * receives the finished good. Both postings are made by the services MIGO already uses —
 * this module decides *what* is owed and never posts it twice.
 *
 * **Quantities are derived, never accumulated here.** What a component still needs is
 * its requirement less the issues that still stand, read from material documents with the
 * same rule MIGO applies (`lineNotReversed` and `OPEN_PRODUCTION_DOCUMENT` from
 * `production-document-quantity.ts`). This module keeps no counter and writes no ledger:
 * the material document is the only record of a movement, so a reversal is seen here the
 * moment it is posted anywhere.
 *
 * **The proportion is the confirmation's yield over the order quantity.** A partial
 * confirmation therefore withdraws a part of what the component still needs, and not the
 * whole requirement. The product is truncated, never rounded up, and is capped by what
 * remains open, so the automatic issue can never exceed the component. Scrap is not
 * grossed into the component quantity: the order's component snapshot stores no scrap
 * indicator, so a grossing here would be an invention, and it is named as refused instead.
 *
 * Deliberately absent, and stated so the reader is not left to guess: no reservation is
 * cleared, no batch is chosen for a batch-managed component (the posting service refuses
 * that on its own terms), no storage location is invented for the receipt (the receipt
 * service applies the plant default it already applies to a manual posting), no
 * "final issue" sweeps the remainder a partial sequence leaves open, and no order type can
 * switch an automatic receipt on or off.
 */
import { sql } from 'drizzle-orm';

import type { Tx } from '../../platform/db/client';
import { toScaled } from '../../platform/posting/decimal';
import {
  OPEN_PRODUCTION_DOCUMENT, lineNotReversed,
} from '../inventory/production-document-quantity';
import { toBaseQuantity } from '../inventory/unit-conversion';
import { GOODS_ISSUE_SCENARIOS } from '../inventory/goods-issue';
import { PRODUCTION_RECEIPT_SCENARIO } from '../inventory/production-receipt';

export type MovementKind = 'ISSUE' | 'RECEIPT';

/** The movement types, read from the two services that post them. */
export const CONFIRMATION_MOVEMENT_CODES = {
  issue: GOODS_ISSUE_SCENARIOS.find((s) => s.accountAssignment === 'ORDER' && s.screen === 'MIGO')?.code ?? '261',
  receipt: PRODUCTION_RECEIPT_SCENARIO.code,
} as const;

/**
 * The request key of the document a confirmation causes for one kind of movement.
 *
 * A material document is unique per client and request key, so the issue and the receipt
 * of one confirmation cannot share a key. The key is derived from the confirmation's own
 * key, which means a replayed request finds the document it already caused, and a retried
 * request never posts a second one. A key too long to carry a suffix keeps its head and
 * carries a fold of the whole: it is shortened, never cut, so two different confirmations
 * cannot land on one document. A confirmation with no request key causes no lookup.
 */
export function movementRequestKey(requestKey: string, kind: MovementKind): string | null {
  const base = requestKey.trim().toUpperCase();
  if (!base) return null;
  const tag = kind === 'ISSUE' ? 'BF' : 'GR';
  const direct = `${base}-${tag}`;
  if (direct.length <= 64) return direct;
  return `${base.slice(0, 45)}-${tag}-${fold(base, tag)}`;
}

/** Two FNV-1a passes over the same text, 32 bits each: 14 characters, no collision trick. */
function fold(value: string, tag: string): string {
  const text = `${value}|${tag}`;
  const one = hash(text, 0x811c9dc5, 0x01000193);
  const two = hash(text, 0x2545f491, 0x000001b3);
  return `${one}${two}`;
}

function hash(value: string, seed: number, prime: number): string {
  let h = seed >>> 0;
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i);
    h = Math.imul(h, prime) >>> 0;
  }
  return h.toString(36).toUpperCase().padStart(7, '0');
}

export interface PlannedIssue {
  itemNumber: number;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  /** In the component's own unit — the unit the requirement is stored in. */
  quantity: string;
  unit: string;
  requiredQuantity: string;
  issuedQuantity: string;
  openQuantity: string;
}

export interface PlannedReceipt {
  materialNumber: string;
  plant: string;
  quantity: string;
  unit: string;
}

export interface MovementPlan {
  /** Components whose material carries the backflush mark, whatever is left to issue. */
  markedComponents: number;
  issues: PlannedIssue[];
  receipt: PlannedReceipt | null;
  skipped: Array<{ itemNumber: number; materialNumber: string; reason: string }>;
  /** The order's own material: is a final confirmation to receive it. */
  automaticGoodsReceipt: boolean;
  note: string;
}

const text = (value: unknown, fallback = '0'): string => (value == null ? fallback : String(value));

/** Three decimal places, the scale MIGO's own open-quantity figure is held to. */
function scaled(value: string): bigint {
  return toScaled(value, 3);
}

/**
 * Fixed-point text at three decimals — the scale a material document line holds a quantity
 * at. A preview and the document it becomes therefore state the same figure, and no value is
 * rounded: the arithmetic above already truncated.
 */
function plain(s: bigint): string {
  const negative = s < 0n;
  const digits = (negative ? -s : s).toString().padStart(4, '0');
  return `${negative ? '-' : ''}${digits.slice(0, -3)}.${digits.slice(-3)}`;
}

/**
 * What this confirmation owes, read from the order's own component snapshot and from the
 * material documents that already stand. It writes nothing and locks nothing: a caller may
 * run it for a preview as well as for a posting.
 */
export async function planConfirmationMovements(
  tx: Tx,
  client: string,
  input: {
    orderNumber: string;
    materialNumber: string;
    plant: string;
    orderQuantity: string;
    unit: string;
    yieldQuantity: string;
    confirmationType: 'PARTIAL' | 'FINAL';
  },
): Promise<MovementPlan> {
  const components = await tx.execute(sql`
    select c.item_number, c.material_number, c.plant, c.storage_location,
           c.required_quantity::text as required_quantity, c.unit_of_measure,
           m.base_unit,
           coalesce(p.backflush, false) as backflush
      from production_order_component c
      join material m on m.client = c.client and m.material_number = c.material_number
      left join material_plant p
        on p.client = c.client and p.material_number = c.material_number and p.plant = c.plant
     where c.client = ${client} and c.order_number = ${input.orderNumber}
     order by c.item_number
  `) as unknown as Array<Record<string, unknown>>;

  const issued = await tx.execute(sql`
    select l.production_order_item as item_number, l.material_number,
           coalesce(sum(l.base_quantity), 0)::text as issued_quantity
      from material_document_line l
      join material_document d
        on d.client = l.client and d.material_document_number = l.material_document_number
       and ${OPEN_PRODUCTION_DOCUMENT}
     where l.client = ${client}
       and l.production_order_number = ${input.orderNumber}
       and ${lineNotReversed('l')}
     group by l.production_order_item, l.material_number
  `) as unknown as Array<Record<string, unknown>>;
  const issuedByLine = new Map<string, bigint>();
  for (const row of issued) {
    issuedByLine.set(
      `${String(row.item_number)}|${String(row.material_number)}`,
      scaled(text(row.issued_quantity)),
    );
  }

  // The proportion the confirmation earns: its yield over the order quantity, in the
  // order material's base unit so a yield entered in another unit still scales right.
  const yieldBase = await baseQuantityOf(tx, client, input.materialNumber, input.yieldQuantity, input.unit);
  const orderBase = await baseQuantityOf(tx, client, input.materialNumber, input.orderQuantity, input.unit);
  const proportionless = orderBase <= 0n;

  const issues: PlannedIssue[] = [];
  const skipped: MovementPlan['skipped'] = [];
  let markedComponents = 0;
  for (const row of components) {
    const itemNumber = Number(row.item_number);
    const materialNumber = String(row.material_number);
    const marked = row.backflush === true || row.backflush === 'true';
    if (!marked) continue;
    markedComponents += 1;
    const unit = text(row.unit_of_measure) || null;
    const baseUnit = text(row.base_unit) || null;
    const requiredBase = await baseQuantityOf(
      tx, client, materialNumber, text(row.required_quantity), unit === baseUnit ? null : unit,
    );
    const openBase = requiredBase - (issuedByLine.get(`${itemNumber}|${materialNumber}`) ?? 0n);
    if (openBase <= 0n) {
      skipped.push({
        itemNumber, materialNumber,
        reason: `This order already stands issued ${plain(requiredBase)}${baseUnit ? ` ${baseUnit}` : ''} of this`
          + ' component, so nothing more is proposed.',
      });
      continue;
    }
    if (proportionless) {
      skipped.push({
        itemNumber, materialNumber,
        reason: 'The order quantity is not a positive quantity, so no proportion of the component can be drawn.',
      });
      continue;
    }
    const owed = requiredBase * yieldBase / orderBase;
    const proposed = owed < openBase ? owed : openBase;
    if (proposed <= 0n) {
      skipped.push({
        itemNumber, materialNumber,
        reason: 'This confirmation yields nothing of the order, so the component is not withdrawn by it.',
      });
      continue;
    }
    issues.push({
      itemNumber,
      materialNumber,
      plant: String(row.plant),
      storageLocation: row.storage_location == null ? null : String(row.storage_location),
      // Every figure is in the material's base unit, which is the unit the posting service
      // measures the open amount in. The snapshot's own unit is used only to bring the
      // requirement to base, exactly as the service does, so the plan and the refusal
      // cannot disagree about what was meant.
      quantity: plain(proposed),
      unit: baseUnit ?? '',
      requiredQuantity: plain(requiredBase),
      issuedQuantity: plain(requiredBase - openBase),
      openQuantity: plain(openBase),
    });
  }

  const [own] = await tx.execute(sql`
    select coalesce(automatic_goods_receipt, false) as automatic_goods_receipt
      from material_plant
     where client = ${client} and material_number = ${input.materialNumber} and plant = ${input.plant}
  `) as unknown as Array<Record<string, unknown>>;
  const automatic = own?.automatic_goods_receipt === true || own?.automatic_goods_receipt === 'true';

  let receipt: PlannedReceipt | null = null;
  if (automatic && input.confirmationType === 'FINAL' && !proportionless && yieldBase > 0n) {
    receipt = {
      materialNumber: input.materialNumber,
      plant: input.plant,
      quantity: input.yieldQuantity,
      unit: input.unit,
    };
  }

  const owed: string[] = [];
  if (issues.length) owed.push(`${issues.length} component ${issues.length === 1 ? 'line' : 'lines'} withdrawn`);
  if (receipt) owed.push('the finished good received');
  let note: string;
  if (owed.length) {
    note = `This confirmation would post ${owed.join(' and ')}. Nothing was posted by reading.`;
  } else if (skipped.length) {
    note = `This confirmation would post no goods movement: ${skipped.length === 1
      ? 'the marked component'
      : `${skipped.length} marked components`} already ${skipped.length === 1 ? 'stands' : 'stand'} issued on this order, or owe nothing to this confirmation. Nothing was posted by reading.`;
  } else if (automatic) {
    note = 'This confirmation would post no goods movement: the material is marked for an automatic receipt, and only a final confirmation receives. Nothing was posted by reading.';
  } else {
    note = 'This confirmation would post no goods movement: no material on this order is marked for one. Nothing was posted by reading.';
  }

  return { markedComponents, issues, receipt, skipped, automaticGoodsReceipt: automatic, note };
}

/**
 * The quantity in the material's base unit. A null unit means the quantity is already held
 * in base units. A unit the material cannot convert is refused by the unit service, and the
 * refusal is the caller's to report: no quantity is guessed around it.
 */
async function baseQuantityOf(
  tx: Tx, client: string, materialNumber: string, quantity: string, entryUnit: string | null,
): Promise<bigint> {
  if (!quantity || !Number.isFinite(Number(quantity)) || Number(quantity) === 0) return 0n;
  if (!entryUnit) return scaled(quantity);
  const converted = await toBaseQuantity(tx, client, {
    materialNumber, quantity: Number(quantity), entryUnit,
  });
  return scaled(converted.baseQuantity.toFixed(3));
}

/**
 * The marks the materials on this order carry, read without any confirmation quantity. The
 * screen states it before anything is entered, so a user learns whether a movement can
 * follow at all. Quantities are not guessed here: they arrive with a check, which is where
 * the open amount on the order is measured.
 */
export async function movementConfiguration(
  tx: Tx, client: string, input: { orderNumber: string; materialNumber: string; plant: string },
): Promise<{ componentLines: number; markedLines: number; automaticGoodsReceipt: boolean; note: string }> {
  const [totals] = await tx.execute(sql`
    select count(*)::text as component_lines,
           count(*) filter (where coalesce(p.backflush, false))::text as marked_lines
      from production_order_component c
      left join material_plant p
        on p.client = c.client and p.material_number = c.material_number and p.plant = c.plant
     where c.client = ${client} and c.order_number = ${input.orderNumber}
  `) as unknown as Array<Record<string, unknown>>;
  const [own] = await tx.execute(sql`
    select coalesce(automatic_goods_receipt, false) as automatic_goods_receipt
      from material_plant
     where client = ${client} and material_number = ${input.materialNumber} and plant = ${input.plant}
  `) as unknown as Array<Record<string, unknown>>;
  const componentLines = Number(totals?.component_lines ?? '0');
  const markedLines = Number(totals?.marked_lines ?? '0');
  const automatic = own?.automatic_goods_receipt === true || own?.automatic_goods_receipt === 'true';
  const parts: string[] = [];
  parts.push(markedLines === 0
    ? 'No component line is marked for backflush, so a confirmation here withdraws nothing'
    : `${markedLines} of ${componentLines} component ${componentLines === 1 ? 'line is' : 'lines are'} marked for backflush, so a confirmation withdraws them`);
  parts.push(automatic
    ? 'the finished good is marked to be received by a final confirmation'
    : 'the finished good is not marked for an automatic receipt');
  return {
    componentLines, markedLines, automaticGoodsReceipt: automatic,
    note: `${parts[0]}. ${parts[1][0]!.toUpperCase()}${parts[1].slice(1)}.`,
  };
}

/** One row of the movement list the confirmation screen shows. */
export interface ConfirmationMovement {
  kind: MovementKind;
  /** The three-digit movement type the screen offers. It is an alias, never a stored code. */
  movementCode: string;
  itemNumber: number | null;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  /** In the material's base unit, which is how the movement services measure an order line. */
  quantity: string;
  unit: string;
  requiredQuantity: string | null;
  issuedQuantity: string | null;
  openQuantity: string | null;
  materialDocumentNumber: string | null;
  documentYear: number | null;
  /** True once the document stands. A reversed document is not standing. */
  standing: boolean;
  posted: boolean;
}

/** The rows a preview shows: what would move, with no document behind it yet. */
export function plannedMovements(plan: MovementPlan): ConfirmationMovement[] {
  const rows: ConfirmationMovement[] = plan.issues.map((line) => ({
    kind: 'ISSUE',
    movementCode: CONFIRMATION_MOVEMENT_CODES.issue,
    itemNumber: line.itemNumber,
    materialNumber: line.materialNumber,
    plant: line.plant,
    storageLocation: line.storageLocation,
    quantity: line.quantity,
    unit: line.unit,
    requiredQuantity: line.requiredQuantity,
    issuedQuantity: line.issuedQuantity,
    openQuantity: line.openQuantity,
    materialDocumentNumber: null,
    documentYear: null,
    standing: false,
    posted: false,
  }));
  if (plan.receipt) {
    rows.push({
      kind: 'RECEIPT',
      movementCode: CONFIRMATION_MOVEMENT_CODES.receipt,
      itemNumber: null,
      materialNumber: plan.receipt.materialNumber,
      plant: plan.receipt.plant,
      storageLocation: null,
      quantity: plan.receipt.quantity,
      unit: plan.receipt.unit,
      requiredQuantity: null,
      issuedQuantity: null,
      openQuantity: null,
      materialDocumentNumber: null,
      documentYear: null,
      standing: false,
      posted: false,
    });
  }
  return rows;
}

/**
 * The documents this confirmation caused, read back from the material documents.
 *
 * A material document is the only record of a movement, so this is also the only way the
 * confirmation screen learns that a movement it caused was reversed elsewhere. Nothing is
 * counted or cached here.
 */
export async function postedMovements(
  tx: Tx, client: string, confirmationRequestKey: string,
): Promise<ConfirmationMovement[]> {
  const kinds: MovementKind[] = ['ISSUE', 'RECEIPT'];
  const out: ConfirmationMovement[] = [];
  for (const kind of kinds) {
    const key = movementRequestKey(confirmationRequestKey, kind);
    if (!key) continue;
    const documents = await tx.execute(sql`
      select d.material_document_number, d.document_year, d.status, d.reversal_of,
             l.line_number, l.material_number, l.plant, l.storage_location,
             l.base_quantity::text as base_quantity, l.base_unit,
             l.production_order_item, l.movement_type
        from material_document d
        join material_document_line l on l.client = d.client and l.material_document_number = d.material_document_number
       where d.client = ${client} and d.request_key = ${key}
       order by l.line_number
    `) as unknown as Array<Record<string, unknown>>;
    for (const row of documents) {
      const status = text(row.status);
      out.push({
        kind,
        movementCode: kind === 'ISSUE' ? CONFIRMATION_MOVEMENT_CODES.issue : CONFIRMATION_MOVEMENT_CODES.receipt,
        itemNumber: row.production_order_item == null ? null : Number(row.production_order_item),
        materialNumber: String(row.material_number),
        plant: String(row.plant),
        storageLocation: row.storage_location == null ? null : String(row.storage_location),
        quantity: text(row.base_quantity),
        unit: text(row.base_unit),
        requiredQuantity: null,
        issuedQuantity: null,
        openQuantity: null,
        materialDocumentNumber: String(row.material_document_number),
        documentYear: Number(row.document_year),
        standing: (status === 'POSTED' || status === 'PARTIALLY_REVERSED') && row.reversal_of == null,
        posted: true,
      });
    }
  }
  return out;
}

/**
 * Whether a confirmation whose movements were caused by this request still has a movement
 * in force. CO13 reads it: a cancellation that would leave a standing document behind is
 * refused, because the confirmation is the proof that document was owed.
 */
export async function movementStands(
  tx: Tx, client: string, confirmationRequestKey: string,
): Promise<Array<{ materialDocumentNumber: string; documentYear: number }>> {
  const keys = [
    movementRequestKey(confirmationRequestKey, 'ISSUE'),
    movementRequestKey(confirmationRequestKey, 'RECEIPT'),
  ].filter((key): key is string => key !== null);
  if (!keys.length) return [];
  const rows = await tx.execute(sql`
    select d.material_document_number, d.document_year
      from material_document d
     where d.client = ${client} and d.request_key in (${keys[0]}, ${keys[1]})
       and ${OPEN_PRODUCTION_DOCUMENT}
       and d.reversal_of is null
     order by d.material_document_number
  `) as unknown as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    materialDocumentNumber: String(row.material_document_number),
    documentYear: Number(row.document_year),
  }));
}
