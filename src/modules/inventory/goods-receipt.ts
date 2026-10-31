/**
 * Goods receipt — SCR-061 / R-109.
 *
 * The first goods movement. Business action and reference category
 * are separate concepts; the movement type is resolved from them
 * through the tenant-standing movement catalogue (data with
 * configured semantics), never a hard-coded list. A posting writes
 * the material document, the stock balance, the valuation totals,
 * the purchase-order history (the standing lines themselves) and
 * one balanced journal in a single transaction. Posted documents
 * are immutable: correction is a reversal document.
 */
import { and, eq, sql } from 'drizzle-orm';

import { AuthzError } from '../../platform/auth/current';
import {
  hasCapability, hasOrgAccess, loadCapabilities, loadOrgRestrictions,
} from '../../platform/auth/session';
import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { linkDocuments } from '../../platform/document';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination, plant as plantTable } from '../foundation/schema';
import { documentRelease, purchaseOrder, purchaseOrderItem } from '../purchasing/schema';
import { materialPeriodAllows } from './material-period-control';
import {
  proposeStorageLocation, resolveStorageLocation, storageLocationRequired, StorageLocationError,
} from './storage-location';
import { postingValuationRefusal } from './valuation-class-definition';
import { assignedReceiptRefusal, readAssignedGoodsReceiptDecision } from './batch-number-assignment';
import { noteBatchControlUse } from './batch-control-use';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { batchClassificationRefusal } from './batch-classification';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, quantityToken,
  REQUEST_MISMATCH_REMEDY,
} from './balance-update';
import { recordOutputsForPostedDocument } from './material-document-output';
import { fromBaseQuantity, toBaseQuantity, UnitConversionError } from './unit-conversion';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, stockQuantity,
} from './schema';

export const GR_POST_CAPABILITY = 'INV.GR.POST';
const JOURNAL_DOCUMENT_TYPE = 'WE';
const MATERIAL_DOCUMENT_CLASS = 'material_document';

/** Identity resolved by requireSession; it is never accepted from receipt form fields. */
export interface GoodsReceiptAuthorizationContext {
  userId: string;
  sessionId: string;
}

/** One generic denial for invalid session, capability, or company/plant assignment. */
class GoodsReceiptAuthorizationError extends AuthzError {
  constructor(username = 'authenticated user') {
    super(GR_POST_CAPABILITY, username);
    this.message = 'You are not authorised to post this goods receipt.';
  }

  override get remedy(): string {
    return 'Ask an administrator to review your goods-receipt authority and company/plant assignments.';
  }
}

export class GoodsReceiptError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'GoodsReceiptError';
    this.remedy = remedy;
  }
}

/** The delivered movement catalogue, ensured per tenant. */
export const DELIVERED_MOVEMENTS = [
  {
    movementType: 'GOODS_RECEIPT_PO', description: 'Goods receipt for purchase order',
    direction: 'RECEIPT', referenceCategory: 'PURCHASE_ORDER',
    reversalMovementType: 'RECEIPT_REVERSAL',
  },
  {
    movementType: 'RECEIPT_REVERSAL', description: 'Reversal of a goods receipt',
    direction: 'REVERSAL', referenceCategory: 'MATERIAL_DOCUMENT',
    reversalMovementType: null,
  },
] as const;

async function ensureMovements(tx: Tx, client: string, changedBy: string) {
  for (const m of DELIVERED_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

async function resolveMovement(tx: Tx, client: string, direction: string, referenceCategory: string) {
  const rows = await tx.select().from(movementType).where(and(
    eq(movementType.client, client),
    eq(movementType.direction, direction),
    eq(movementType.referenceCategory, referenceCategory),
  ));
  if (rows.length === 0) {
    throw new GoodsReceiptError(
      `No ${direction.toLowerCase()} movement stands configured for reference ${referenceCategory}.`,
      'The movement-type catalogue carries no such movement; goods movement configuration is incomplete.',
    );
  }
  return rows[0];
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * What has been received against each order item — signed by what each line *did*, not by what it
 * is called.
 *
 * SCR-145: this used to sign every non-reversal line positive, which was true only while the only
 * movement carrying a purchase-order reference was a receipt. A return delivery carries the same
 * reference and takes stock out; under the old rule a return would have *increased* the received
 * quantity, and the order would have shown more received after goods went back. The sign now
 * follows the movement's configured direction (receipt adds, issue subtracts), and a reversal takes
 * the opposite sign of the line it reverses — so cancelling a receipt removes it, and cancelling a
 * return puts it back. Receipts show the number they always did; a test pins that.
 */
async function receivedQuantities(tx: Tx, client: string, orderNumber: string): Promise<Map<number, number>> {
  const rows = await tx.select({
    number: materialDocumentLine.materialDocumentNumber,
    line: materialDocumentLine.lineNumber,
    item: materialDocumentLine.purchaseOrderItem,
    movement: materialDocumentLine.movementType,
    direction: materialDocumentLine.lineDirection,
    reversalOfDocument: materialDocumentLine.reversalOfDocument,
    reversalOfLine: materialDocumentLine.reversalOfLine,
    qty: materialDocumentLine.baseQuantity,
  }).from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.purchaseOrderNumber, orderNumber),
  ));
  const directions = new Map<string, string>();
  for (const m of await tx.select().from(movementType).where(eq(movementType.client, client))) {
    directions.set(m.movementType, m.direction);
  }

  const sign = new Map<string, number>();
  for (const row of rows) {
    const configured = directions.get(row.movement) ?? row.direction;
    if (configured === 'REVERSAL') continue;
    sign.set(`${row.number}/${row.line}`, configured === 'ISSUE' ? -1 : 1);
  }
  for (const row of rows) {
    const configured = directions.get(row.movement) ?? row.direction;
    if (configured !== 'REVERSAL' || !row.reversalOfDocument || row.reversalOfLine == null) continue;
    sign.set(`${row.number}/${row.line}`, -(sign.get(`${row.reversalOfDocument}/${row.reversalOfLine}`) ?? 1));
  }

  const map = new Map<number, number>();
  for (const row of rows) {
    if (row.item == null) continue;
    const rowSign = sign.get(`${row.number}/${row.line}`) ?? 1;
    map.set(row.item, (map.get(row.item) ?? 0) + rowSign * Number(row.qty));
  }
  return map;
}

/**
 * What has been received on one order item, in the unit that item is ordered in.
 *
 * `receivedQuantities` adds the posted lines in the material's base unit, because that is the one
 * unit every document on the order agrees on - a goods receipt and a return against it are both
 * counted there. The order's own conversation is in another unit: `ordered`, `remaining`, the
 * over-delivery tolerance and the quantity a receiver types all speak the item's unit, which is
 * why the total comes back through the same material conversion that produced it. An item already
 * in the base unit is answered untouched, and an item whose rule has gone since the posting is
 * answered in the base unit with the gap named, because a number silently re-scaled by a factor
 * nobody maintains would be the worse of the two lies.
 */
async function receivedInItemUnit(
  tx: Tx, client: string, item: { materialNumber: string | null; unit: string }, receivedBase: number,
): Promise<{ quantity: number; unconvertible: boolean }> {
  if (receivedBase === 0 || !item.materialNumber) return { quantity: receivedBase, unconvertible: false };
  try {
    return {
      quantity: await fromBaseQuantity(tx, client, {
        materialNumber: item.materialNumber, baseQuantity: receivedBase, targetUnit: item.unit,
      }),
      unconvertible: false,
    };
  } catch (caught) {
    if (caught instanceof UnitConversionError) return { quantity: receivedBase, unconvertible: true };
    throw caught;
  }
}

export interface ReceiptItemView {
  itemNumber: number;
  materialNumber: string | null;
  shortText: string;
  plant: string;
  storageLocation: string | null;
  /** The batch named on the order. Blank means the receipt must name one. */
  batch: string;
  /** The location a blank receipt line will use: the order item, else the plant default. */
  proposedStorageLocation: string | null;
  unit: string;
  ordered: number;
  received: number;
  remaining: number;
  netPrice: string;
  priceUnit: string;
  eligible: boolean;
  refusal: string | null;
}

export interface ReceiptOrderView {
  orderNumber: string;
  supplierNumber: string;
  companyCode: string;
  currency: string;
  releaseRequired: boolean;
  released: boolean;
  items: ReceiptItemView[];
}

export async function getReceiptOrder(client: string, orderNumber: string): Promise<ReceiptOrderView | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(purchaseOrder).where(and(
      eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
    ));
    if (!header) return null;
    const [release] = await tx.select().from(documentRelease).where(and(
      eq(documentRelease.client, client),
      eq(documentRelease.documentCategory, 'PURCHASE_ORDER'),
      eq(documentRelease.documentNumber, orderNumber),
    ));
    const items = await tx.select().from(purchaseOrderItem).where(and(
      eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
    )).orderBy(purchaseOrderItem.itemNumber);
    const received = await receivedQuantities(tx, client, orderNumber);
    return {
      orderNumber: header.orderNumber,
      supplierNumber: header.supplierNumber,
      companyCode: header.companyCode,
      currency: header.currency,
      releaseRequired: Boolean(release),
      released: !release || release.status === 'RELEASED',
      items: await Promise.all(items.map(async (item) => {
        const gotBase = received.get(item.itemNumber) ?? 0;
        const got = await receivedInItemUnit(tx, client, item, gotBase);
        const ordered = Number(item.quantity);
        let refusal: string | null = null;
        if (got.unconvertible) {
          refusal = `The quantity received on this item cannot be stated in ${item.unit}: the material carries no conversion between ${item.unit} and its base unit, and the posted lines are kept in that base unit. Maintain the conversion to read the order history, or post the receipt in the base unit.`;
        } else if (item.markedForDeletion) refusal = 'The item is marked for deletion.';
        else if (!item.materialNumber) refusal = 'Text items carry no stock.';
        else if (item.accountAssignmentCategory) {
          refusal = assignedReceiptRefusal(await readAssignedGoodsReceiptDecision(tx, client, item.plant, true));
        }
        return {
          itemNumber: item.itemNumber,
          materialNumber: item.materialNumber,
          shortText: item.shortText,
          plant: item.plant,
          storageLocation: item.storageLocation,
          batch: item.batchNumber,
          proposedStorageLocation: await proposeStorageLocation(tx, client, item.plant, item.storageLocation),
          unit: item.unit,
          ordered,
          received: got.quantity,
          remaining: Math.max(0, ordered - got.quantity),
          netPrice: item.netPrice,
          priceUnit: item.priceUnit,
          eligible: !refusal,
          refusal,
        };
      })),
    };
  });
}

export interface PostGoodsReceiptInput {
  client: string;
  changedBy: string;
  orderNumber: string;
  documentDate: string;
  postingDate: string;
  headerText?: string;
  requestKey: string;
  /** Stock type the receipt posts into. Defaults to UNRESTRICTED; quality-inspection receipts use QUALITY. */
  stockType?: string;
  lines: Array<{ itemNumber: number; quantity: number; storageLocation?: string; batch?: string }>;
}

export interface MaterialDocumentView {
  materialDocumentNumber: string;
  documentYear: number;
  documentDate: string;
  postingDate: string;
  headerText: string | null;
  status: string;
  journalDocumentNumber: string | null;
  reversalOf: string | null;
  reversedBy: string | null;
  lines: Array<{
    lineNumber: number; movementType: string; materialNumber: string; plant: string;
    storageLocation: string | null; stockType: string; batch: string; quantity: string; unit: string; value: string;
    purchaseOrderNumber: string | null; purchaseOrderItem: number | null; itemText: string | null;
  }>;
}

function toView(header: typeof materialDocument.$inferSelect, lines: Array<typeof materialDocumentLine.$inferSelect>): MaterialDocumentView {
  return {
    materialDocumentNumber: header.materialDocumentNumber,
    documentYear: header.documentYear,
    documentDate: header.documentDate,
    postingDate: header.postingDate,
    headerText: header.headerText,
    status: header.status,
    journalDocumentNumber: header.journalDocumentNumber,
    reversalOf: header.reversalOf,
    reversedBy: header.reversedBy,
    lines: lines.map((l) => ({
      lineNumber: l.lineNumber, movementType: l.movementType, materialNumber: l.materialNumber,
      plant: l.plant, storageLocation: l.storageLocation, stockType: l.stockType, batch: l.batchNumber, quantity: l.baseQuantity,
      unit: l.baseUnit, value: l.value, purchaseOrderNumber: l.purchaseOrderNumber,
      purchaseOrderItem: l.purchaseOrderItem, itemText: l.itemText,
    })),
  };
}

export async function getMaterialDocument(client: string, number: string): Promise<MaterialDocumentView | null> {
  return withTenant(client, async (tx) => {
    const [header] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
    ));
    if (!header) return null;
    const lines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, client),
      eq(materialDocumentLine.materialDocumentNumber, number),
    )).orderBy(materialDocumentLine.lineNumber);
    return toView(header, lines);
  });
}

async function existingByRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, header.materialDocumentNumber),
  )).orderBy(materialDocumentLine.lineNumber);
  return toView(header, lines);
}

async function requireGoodsReceiptAuthorityInTx(
  tx: Tx,
  client: string,
  authorization: GoodsReceiptAuthorizationContext | undefined,
) {
  if (!authorization?.userId || !authorization.sessionId) {
    throw new GoodsReceiptAuthorizationError();
  }

  // Revalidate the action's session and account at the authoritative service
  // boundary, holding both rows until commit so revocation/deactivation cannot race.
  const sessions = (await tx.execute(sql`
    select u.username
      from user_session s
      join app_user u on u.client = s.client and u.id = s.user_id
     where s.client = ${client}
       and s.id = ${authorization.sessionId}
       and s.user_id = ${authorization.userId}
       and s.revoked_at is null
       and s.expires_at > now()
       and u.is_active = true
       and u.is_locked = false
     for share of s, u
  `)) as unknown as Array<{ username: string }>;
  const actor = sessions[0];
  if (!actor) throw new GoodsReceiptAuthorizationError();

  await tx.execute(sql`
    select code from capability where code = ${GR_POST_CAPABILITY} for share
  `);
  await tx.execute(sql`
    select ur.role_code, rc.capability_code
      from user_role ur
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${authorization.userId}
       and (ur.valid_from is null or ur.valid_from <= now())
       and (ur.valid_to is null or ur.valid_to >= now())
     for share of ur, rc
  `);
  const capabilities = await loadCapabilities(tx, client, authorization.userId);
  if (!hasCapability(capabilities, GR_POST_CAPABILITY)) {
    throw new GoodsReceiptAuthorizationError(actor.username);
  }

  await tx.execute(sql`
    select id from auth_org_restriction
     where client = ${client} and user_id = ${authorization.userId}
     for share
  `);
  const restrictions = await loadOrgRestrictions(tx, client, authorization.userId);
  const hasCompanyScope = restrictions.some((r) => r.scopeType === 'COMPANY_CODE' && r.scopeValue.trim());
  const hasPlantScope = restrictions.some((r) => r.scopeType === 'PLANT' && r.scopeValue.trim());
  if (!hasCompanyScope || !hasPlantScope) {
    throw new GoodsReceiptAuthorizationError(actor.username);
  }
  return { username: actor.username, restrictions };
}

async function requireReceiptPlantAuthorityInTx(
  tx: Tx,
  client: string,
  plantCode: string,
  orderCompanyCode: string | null,
  restrictions: Awaited<ReturnType<typeof loadOrgRestrictions>>,
  username: string,
): Promise<{ plant: string; companyCode: string }> {
  const rows = (await tx.execute(sql`
    select plant, company_code as "companyCode"
      from plant
     where client = ${client} and plant = ${plantCode}
     for share
  `)) as unknown as Array<{ plant: string; companyCode: string | null }>;
  const plantRow = rows[0];
  if (!plantRow?.companyCode
    || (orderCompanyCode !== null && plantRow.companyCode !== orderCompanyCode)
    || !hasOrgAccess(restrictions, 'COMPANY_CODE', plantRow.companyCode)
    || !hasOrgAccess(restrictions, 'PLANT', plantRow.plant)) {
    throw new GoodsReceiptAuthorizationError(username);
  }
  return { plant: plantRow.plant, companyCode: plantRow.companyCode };
}

async function authorizeReceiptOrderInTx(
  tx: Tx,
  client: string,
  orderNumber: string,
  lines: readonly PostGoodsReceiptInput['lines'][number][],
  authorization: GoodsReceiptAuthorizationContext | undefined,
): Promise<Map<number, { plant: string; companyCode: string }>> {
  const { username, restrictions } = await requireGoodsReceiptAuthorityInTx(tx, client, authorization);
  const orderRows = (await tx.execute(sql`
    select company_code as "companyCode"
      from purchase_order
     where client = ${client} and order_number = ${orderNumber}
     for share
  `)) as unknown as Array<{ companyCode: string }>;
  const order = orderRows[0];
  if (!order) throw new GoodsReceiptError(`Purchase order ${orderNumber} does not exist.`);

  const itemRows = (await tx.execute(sql`
    select item_number as "itemNumber", plant
      from purchase_order_item
     where client = ${client} and order_number = ${orderNumber}
     order by item_number
     for share
  `)) as unknown as Array<{ itemNumber: number; plant: string }>;
  const byNumber = new Map(itemRows.map((item) => [item.itemNumber, item]));
  // An empty request still has to be authorised before replay; using all persisted
  // order-item plants means an empty or replay-shaped request cannot skip the scope check.
  const targetNumbers = lines.length
    ? [...new Set(lines.map((line) => line.itemNumber))]
    : itemRows.map((item) => item.itemNumber);
  const authorised = new Map<number, { plant: string; companyCode: string }>();
  for (const itemNumber of targetNumbers) {
    const item = byNumber.get(itemNumber);
    if (!item) throw new GoodsReceiptAuthorizationError(username);
    authorised.set(itemNumber, await requireReceiptPlantAuthorityInTx(
      tx, client, item.plant, order.companyCode, restrictions, username,
    ));
  }
  return authorised;
}

async function authorizeReceiptReversalInTx(
  tx: Tx,
  client: string,
  materialDocumentNumber: string,
  authorization: GoodsReceiptAuthorizationContext | undefined,
): Promise<void> {
  const { username, restrictions } = await requireGoodsReceiptAuthorityInTx(tx, client, authorization);
  const documents = (await tx.execute(sql`
    select material_document_number
      from material_document
     where client = ${client} and material_document_number = ${materialDocumentNumber}
     for share
  `)) as unknown as Array<{ material_document_number: string }>;
  if (!documents[0]) throw new GoodsReceiptError(`Material document ${materialDocumentNumber} does not exist.`);

  const lines = (await tx.execute(sql`
    select line_number, plant
      from material_document_line
     where client = ${client} and material_document_number = ${materialDocumentNumber}
     order by line_number
     for share
  `)) as unknown as Array<{ line_number: number; plant: string }>;
  if (lines.length === 0) throw new GoodsReceiptError('The document carries no lines.');
  for (const plantCode of new Set(lines.map((line) => line.plant))) {
    await requireReceiptPlantAuthorityInTx(tx, client, plantCode, null, restrictions, username);
  }
}

async function resolveAccount(
  tx: Tx, client: string, chart: string, event: string, valuationClass: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find((r) => r.valuationClass === valuationClass)
    ?? rows.find((r) => r.valuationClass === '');
  if (!row) {
    throw new GoodsReceiptError(
      `Account determination for ${event}${valuationClass ? ` and valuation class ${valuationClass}` : ''} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

export async function postGoodsReceipt(
  input: PostGoodsReceiptInput,
  options?: { authorization?: GoodsReceiptAuthorizationContext },
): Promise<MaterialDocumentView> {
  const fingerprint = postingFingerprint([
    'GR', input.orderNumber.trim(), input.postingDate, input.documentDate, input.headerText ?? '',
    ...[...input.lines]
      .map((line) => `${line.itemNumber}:${quantityToken(line.quantity)}:${line.storageLocation ?? ''}:${(line.batch ?? '').trim().toUpperCase()}`)
      .sort(),
  ]);
  return withTenant(input.client, async (tx) => {
    await authorizeReceiptOrderInTx(tx, input.client, input.orderNumber, input.lines, options?.authorization);
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new GoodsReceiptError(mismatch, REQUEST_MISMATCH_REMEDY);
      return replay;
    }

    await ensureMovements(tx, input.client, input.changedBy);
    const movement = await resolveMovement(tx, input.client, 'RECEIPT', 'PURCHASE_ORDER');
    const refused = await batchClassificationRefusal(tx, input.client, movement.movementType);
    if (refused) throw new GoodsReceiptError(refused.message, refused.remedy);

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/gr/${input.orderNumber}`}, 0))`);

    const view = await getReceiptOrderInTx(tx, input.client, input.orderNumber);
    if (!view) throw new GoodsReceiptError(`Purchase order ${input.orderNumber} does not exist.`);
    if (view.releaseRequired && !view.released) {
      throw new GoodsReceiptError(
        `Purchase order ${input.orderNumber} is not released.`,
        'Release the order fully, then post the goods receipt.',
      );
    }
    if (input.lines.length === 0) {
      throw new GoodsReceiptError('No receipt quantities were entered.', 'Enter a quantity for at least one item.');
    }

    const company = await getCompanyCode(tx, input.client, view.companyCode);
    if (!company?.fiscalYearVariant) throw new GoodsReceiptError(`Company code ${view.companyCode} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);

    // The material period judges on its own rules (OMSY).
    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, view.companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new GoodsReceiptError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${view.companyCode}.`,
        'Post into the open material period, or shift the material period first.',
      );
    }

    const materials = [...new Set(view.items.map((item) => item.materialNumber).filter((m): m is string => Boolean(m)))].sort();
    await lockStockScope(tx, input.client, materials, 'EXCLUSIVE');

    const itemsByNumber = new Map(view.items.map((i) => [i.itemNumber, i]));
    const claimedReceipt = new Map<number, number>();
    const journalLines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; material?: string; plant?: string }> = [];
    const prepared: Array<{
      item: ReceiptItemView; quantity: number; baseQuantity: number; baseUnit: string;
      storageLocation: string; batch: string;
      value: number; poValue: number; valuation: typeof materialValuation.$inferSelect;
    }> = [];

    for (const line of input.lines) {
      const item = itemsByNumber.get(line.itemNumber);
      if (!item) throw new GoodsReceiptError(`Order item ${line.itemNumber} does not stand on ${input.orderNumber}.`);
      if (!item.eligible || !item.materialNumber) {
        throw new GoodsReceiptError(`Item ${line.itemNumber} cannot be received: ${item.refusal ?? 'not eligible.'}`);
      }
      if (!(line.quantity > 0)) throw new GoodsReceiptError(`Item ${line.itemNumber}: the receipt quantity must be positive.`);

      const [mat] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, item.materialNumber),
      ));
      if (!mat) throw new GoodsReceiptError(`Material ${item.materialNumber} does not exist.`);
      if (mat.markedForDeletion) {
        throw new GoodsReceiptError(`Material ${item.materialNumber} is flagged for deletion.`, 'Cancel the deletion flag, then post again.');
      }
      const [ext] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, item.materialNumber),
        eq(materialPlant.plant, item.plant),
      ));
      if (!ext) throw new GoodsReceiptError(`Material ${item.materialNumber} is not extended to plant ${item.plant}.`);
      if (ext.markedForDeletion) {
        throw new GoodsReceiptError(`Material ${item.materialNumber} is flagged for deletion in plant ${item.plant}.`, 'Cancel the plant deletion flag, then post again.');
      }
      const toleranceMax = item.ordered * (1 + Number(ext.overdeliveryTolerance) / 100);
      const alreadyClaimed = claimedReceipt.get(line.itemNumber) ?? 0;
      if (item.received + alreadyClaimed + line.quantity > toleranceMax + 1e-9) {
        throw new GoodsReceiptError(
          `Item ${line.itemNumber}: received ${item.received} plus ${line.quantity} exceeds the ordered ${item.ordered} beyond the overdelivery tolerance of ${ext.overdeliveryTolerance}%.`,
          'Reduce the receipt quantity to the remaining open quantity.',
        );
      }
      const [valuation] = await tx.select().from(materialValuation).where(and(
        eq(materialValuation.client, input.client),
        eq(materialValuation.materialNumber, item.materialNumber),
        eq(materialValuation.valuationArea, item.plant),
      ));
      if (!valuation || !valuation.valuationClass) {
        throw new GoodsReceiptError(
          `Material ${item.materialNumber} carries no valuation class in plant ${item.plant}.`,
          'Complete the material valuation data, then post again.',
        );
      }
      const classRefusal = await postingValuationRefusal(tx, input.client, item.materialNumber, valuation.valuationClass);
      if (classRefusal) {
        throw new GoodsReceiptError(classRefusal, 'Maintain a valuation class this material type permits, then post again.');
      }
      if (valuation.currency !== view.currency) {
        throw new GoodsReceiptError(
          `The order currency ${view.currency} does not agree with the valuation currency ${valuation.currency}.`,
          'Receive against an order in the valuation currency this round.',
        );
      }

      // SCR-144, the rule the production and issue postings already keep: the receipt is entered in
      // the unit the order speaks, while stock, the material document's base pair and the
      // valuation quantity are the material's base unit - `stock_quantity` has no unit column and
      // can hold nothing else. `toBaseQuantity` converts by the material's own exact ratio, needs
      // no row for an item already in the base unit, and refuses a unit it cannot convert by name
      // instead of assuming that a case is a piece.
      let baseQuantity = line.quantity;
      let baseUnit = item.unit;
      if (item.unit !== (mat.baseUnit ?? '')) {
        try {
          const conversion = await toBaseQuantity(tx, input.client, {
            materialNumber: item.materialNumber!, quantity: line.quantity, entryUnit: item.unit,
          });
          baseQuantity = conversion.baseQuantity;
          baseUnit = conversion.baseUnit;
        } catch (caught) {
          if (caught instanceof UnitConversionError) throw new GoodsReceiptError(caught.message, caught.remedy);
          throw caught;
        }
      }
      // The money is what the order priced: the entered quantity at the entered price unit. The
      // standard-price stock value is the material's cost per base unit, so it follows the
      // converted quantity - and a moving-average price divided by the base quantity is the price
      // of one base unit, not the price of one package.
      const poValue = round2((line.quantity * Number(item.netPrice)) / Number(item.priceUnit));
      const stockValue = valuation.priceControl === 'STANDARD'
        ? round2((baseQuantity * Number(valuation.standardPrice)) / Number(valuation.priceUnit))
        : poValue;
      // SCR-142: an open count with a posting block refuses the receipt for this material here.
      const required = await storageLocationRequired(tx, input.client, item.materialNumber, item.plant);
      let receivedAt;
      try {
        receivedAt = await resolveStorageLocation(tx, {
          client: input.client,
          plant: item.plant,
          typed: line.storageLocation,
          documentDefault: item.storageLocation,
          applyPlantDefault: true,
          required,
          verb: 'Receive into',
        });
      } catch (caught) {
        if (caught instanceof StorageLocationError) throw new GoodsReceiptError(caught.message, caught.remedy);
        throw caught;
      }
      try {
        await assertInventoryCountOpen(tx, input.client, {
          materialNumber: item.materialNumber, plant: item.plant,
          storageLocation: receivedAt.storageLocation || null,
          batch: line.batch || item.batch,
        });
      } catch (caught) {
        if (caught instanceof PhysicalInventoryError) {
          throw new GoodsReceiptError(caught.message, caught.remedy);
        }
        throw caught;
      }

      let batch = '';
      try {
        batch = await resolvePostingBatch(tx, {
          client: input.client, materialNumber: item.materialNumber, plant: item.plant,
          batch: line.batch || item.batch, postingDate: input.postingDate,
        });
      } catch (caught) {
        if (caught instanceof BatchPostingError) throw new GoodsReceiptError(caught.message, caught.remedy);
        throw caught;
      }

      prepared.push({
        item, quantity: line.quantity, baseQuantity, baseUnit,
        storageLocation: receivedAt.storageLocation, batch,
        value: stockValue, poValue, valuation,
      });
    }

    const chart = company.chartOfAccounts as string;
    const grIrAccount = await resolveAccount(tx, input.client, chart, 'GR_IR_CLEARING', '');
    for (const p of prepared) {
      const inventoryAccount = await resolveAccount(tx, input.client, chart, 'INVENTORY', p.valuation.valuationClass!);
      journalLines.push({ glAccount: inventoryAccount, debitCredit: 'S', amount: p.value.toFixed(2), material: p.item.materialNumber!, plant: p.item.plant });
      journalLines.push({ glAccount: grIrAccount, debitCredit: 'H', amount: p.poValue.toFixed(2), material: p.item.materialNumber!, plant: p.item.plant });
      const difference = round2(p.poValue - p.value);
      if (difference !== 0) {
        const prdAccount = await resolveAccount(tx, input.client, chart, 'PRICE_DIFFERENCE', p.valuation.valuationClass!);
        journalLines.push({
          glAccount: prdAccount, debitCredit: difference > 0 ? 'S' : 'H',
          amount: Math.abs(difference).toFixed(2), material: p.item.materialNumber!, plant: p.item.plant,
        });
      }
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;
    const documentYear = position.fiscalYear;

    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode: view.companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: view.currency,
      localCurrency: company.currency,
      reference: input.orderNumber,
      headerText: input.headerText,
      lines: journalLines,
      origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: GR_POST_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new GoodsReceiptError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear,
      documentDate: input.documentDate, postingDate: input.postingDate,
      headerText: input.headerText ?? null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      requestFingerprint: fingerprint,
      createdBy: input.changedBy,
    });

    let lineNumber = 0;
    for (const p of prepared) {
      lineNumber += 1;
      await tx.insert(materialDocumentLine).values({
        client: input.client, materialDocumentNumber: number, lineNumber,
        movementType: movement.movementType,
        materialNumber: p.item.materialNumber!, plant: p.item.plant,
        storageLocation: p.storageLocation || null, stockType: input.stockType ?? 'UNRESTRICTED',
        batchNumber: p.batch,
        entryQuantity: String(p.quantity), entryUnit: p.item.unit,
        baseQuantity: String(p.baseQuantity), baseUnit: p.baseUnit,
        unitPrice: p.item.netPrice, priceUnit: p.item.priceUnit, currency: view.currency,
        value: String(p.value),
        purchaseOrderNumber: input.orderNumber, purchaseOrderItem: p.item.itemNumber,
        createdBy: input.changedBy,
      });
      await tx.insert(stockQuantity).values({
        client: input.client, materialNumber: p.item.materialNumber!, plant: p.item.plant,
        storageLocation: p.storageLocation, stockType: input.stockType ?? 'UNRESTRICTED', batchNumber: p.batch,
        quantity: String(p.baseQuantity), createdBy: input.changedBy,
      }).onConflictDoUpdate({
        target: [stockQuantity.client, stockQuantity.materialNumber, stockQuantity.plant, stockQuantity.storageLocation, stockQuantity.stockType, stockQuantity.batchNumber],
        set: { quantity: sql`${stockQuantity.quantity} + ${p.baseQuantity}`, changedBy: input.changedBy, changedAt: new Date() },
      });
      await applyValuationDelta(
        tx, input.client, input.changedBy, p.item.materialNumber!, p.item.plant, p.baseQuantity, p.value,
      );
    }

    await linkDocuments(tx, {
      client: input.client,
      predecessor: { documentClass: 'purchase_order', documentKey: input.orderNumber },
      successor: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      relationType: 'GOODS_RECEIPT',
      createdBy: input.changedBy,
    });
    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: GR_POST_CAPABILITY,
      after: {
        movement: movement.movementType, order: input.orderNumber,
        lines: prepared.length, journal: journal.documentNumber, status: 'POSTED',
      },
    });
    await noteBatchControlUse(tx, input.client, number, input.changedBy);

    // SCR-135: the document carries its output with it — determined here, and the
    // immediate ones dispatched inside this same transaction.
    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}

async function getReceiptOrderInTx(tx: Tx, client: string, orderNumber: string): Promise<ReceiptOrderView | null> {
  const [header] = await tx.select().from(purchaseOrder).where(and(
    eq(purchaseOrder.client, client), eq(purchaseOrder.orderNumber, orderNumber),
  ));
  if (!header) return null;
  const [release] = await tx.select().from(documentRelease).where(and(
    eq(documentRelease.client, client),
    eq(documentRelease.documentCategory, 'PURCHASE_ORDER'),
    eq(documentRelease.documentNumber, orderNumber),
  ));
  const items = await tx.select().from(purchaseOrderItem).where(and(
    eq(purchaseOrderItem.client, client), eq(purchaseOrderItem.orderNumber, orderNumber),
  )).orderBy(purchaseOrderItem.itemNumber);
  const received = await receivedQuantities(tx, client, orderNumber);
  return {
    orderNumber: header.orderNumber,
    supplierNumber: header.supplierNumber,
    companyCode: header.companyCode,
    currency: header.currency,
    releaseRequired: Boolean(release),
    released: !release || release.status === 'RELEASED',
    items: await Promise.all(items.map(async (item) => {
      const gotBase = received.get(item.itemNumber) ?? 0;
      const got = await receivedInItemUnit(tx, client, item, gotBase);
      const ordered = Number(item.quantity);
      let refusal: string | null = null;
      if (got.unconvertible) {
        refusal = `The quantity received on this item cannot be stated in ${item.unit}: the material carries no conversion between ${item.unit} and its base unit, and the posted lines are kept in that base unit. Maintain the conversion to read the order history, or post the receipt in the base unit.`;
      } else if (item.markedForDeletion) refusal = 'The item is marked for deletion.';
      else if (!item.materialNumber) refusal = 'Text items carry no stock.';
      else if (item.accountAssignmentCategory) {
        refusal = assignedReceiptRefusal(await readAssignedGoodsReceiptDecision(tx, client, item.plant, true));
      }
      return {
        itemNumber: item.itemNumber,
        materialNumber: item.materialNumber,
        shortText: item.shortText,
        plant: item.plant,
        storageLocation: item.storageLocation,
        batch: item.batchNumber,
        proposedStorageLocation: await proposeStorageLocation(tx, client, item.plant, item.storageLocation),
        unit: item.unit,
        ordered, received: got.quantity, remaining: Math.max(0, ordered - got.quantity),
        netPrice: item.netPrice, priceUnit: item.priceUnit,
        eligible: !refusal, refusal,
      };
    })),
  };
}

async function getMaterialPeriodControlInTx(tx: Tx, client: string, company: string) {
  const rows = await tx.execute(sql`
    select company_code, current_fiscal_year, current_period, previous_fiscal_year,
           previous_period, allow_backposting
    from material_period_control where client = ${client} and company_code = ${company}
  `);
  const r = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!r) return null;
  return {
    companyCode: String(r.company_code),
    currentFiscalYear: Number(r.current_fiscal_year),
    currentPeriod: Number(r.current_period),
    previousFiscalYear: Number(r.previous_fiscal_year),
    previousPeriod: Number(r.previous_period),
    allowBackposting: Boolean(r.allow_backposting),
    disallowBackpostingAfterChange: false,
  };
}

export interface ReverseGoodsReceiptInput {
  client: string;
  changedBy: string;
  materialDocumentNumber: string;
  documentDate: string;
  postingDate: string;
  headerText?: string;
  requestKey: string;
}

export async function reverseGoodsReceipt(
  input: ReverseGoodsReceiptInput,
  options?: { authorization?: GoodsReceiptAuthorizationContext },
): Promise<MaterialDocumentView> {
  const fingerprint = postingFingerprint([
    'GR-REV', input.materialDocumentNumber.trim(), input.postingDate, input.documentDate,
  ]);
  return withTenant(input.client, async (tx) => {
    await authorizeReceiptReversalInTx(tx, input.client, input.materialDocumentNumber, options?.authorization);
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new GoodsReceiptError(mismatch, REQUEST_MISMATCH_REMEDY);
      return replay;
    }

    await ensureMovements(tx, input.client, input.changedBy);
    const movement = await resolveMovement(tx, input.client, 'REVERSAL', 'MATERIAL_DOCUMENT');
    const refused = await batchClassificationRefusal(tx, input.client, movement.movementType);
    if (refused) throw new GoodsReceiptError(refused.message, refused.remedy);

    const [original] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (!original) throw new GoodsReceiptError(`Material document ${input.materialDocumentNumber} does not exist.`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/reverse/${input.materialDocumentNumber}`}, 0))`);
    const [locked] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    if (!locked) throw new GoodsReceiptError(`Material document ${input.materialDocumentNumber} does not exist.`);
    if (locked.status === 'REVERSED') {
      throw new GoodsReceiptError(`Material document ${input.materialDocumentNumber} has already been reversed by ${locked.reversedBy}.`);
    }
    if (locked.reversalOf) {
      throw new GoodsReceiptError('A reversal document cannot itself be reversed.', 'Reverse the original document instead.');
    }
    const originalLines = await tx.select().from(materialDocumentLine).where(and(
      eq(materialDocumentLine.client, input.client),
      eq(materialDocumentLine.materialDocumentNumber, input.materialDocumentNumber),
    )).orderBy(materialDocumentLine.lineNumber);
    if (originalLines.length === 0) throw new GoodsReceiptError('The document carries no lines.');
    await lockStockScope(
      tx, input.client,
      [...new Set(originalLines.map((line) => line.materialNumber).filter((m): m is string => Boolean(m)))].sort(),
      'EXCLUSIVE',
    );

    // SCR-143: reversing a receipt moves stock back out, so it answers to the count block too.
    for (const line of originalLines) {
      if (!line.materialNumber) continue;
      try {
        await assertInventoryCountOpen(tx, input.client, {
          materialNumber: line.materialNumber, plant: line.plant,
          storageLocation: line.storageLocation ?? null,
          batch: line.batchNumber,
        });
      } catch (caught) {
        if (caught instanceof PhysicalInventoryError) {
          throw new GoodsReceiptError(caught.message, caught.remedy);
        }
        throw caught;
      }
    }

    // The reversal's own posting date judges the material period.
    const firstPlant = originalLines[0].plant;
    const [plantRow] = await tx.select().from(plantTable).where(and(
      eq(plantTable.client, input.client), eq(plantTable.plant, firstPlant),
    ));
    if (!plantRow?.companyCode) throw new GoodsReceiptError(`Plant ${firstPlant} does not exist or carries no company code.`);
    const company = await getCompanyCode(tx, input.client, plantRow.companyCode);
    if (!company?.fiscalYearVariant) throw new GoodsReceiptError(`Company code ${plantRow.companyCode} is not configured.`);
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);
    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, plantRow.companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new GoodsReceiptError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${plantRow.companyCode}.`,
        'Post the reversal into an open material period.',
      );
    }

    for (const line of originalLines) {
      const [stock] = await tx.select().from(stockQuantity).where(and(
        eq(stockQuantity.client, input.client),
        eq(stockQuantity.materialNumber, line.materialNumber),
        eq(stockQuantity.plant, line.plant),
        eq(stockQuantity.storageLocation, line.storageLocation ?? ''),
        eq(stockQuantity.stockType, line.stockType),
        eq(stockQuantity.batchNumber, line.batchNumber),
      ));
      if (!stock || Number(stock.quantity) < Number(line.baseQuantity)) {
        throw new GoodsReceiptError(
          `Stock of ${line.materialNumber} in plant ${line.plant} no longer covers the reversal quantity.`,
          'The received stock has been consumed; the receipt can no longer be reversed in full.',
        );
      }
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    let journalNumber: string | null = null;
    if (original.journalDocumentNumber) {
      const [journalYear, rest] = splitJournalKey(original.journalDocumentNumber);
      void rest;
      const reversed = await reverseJournalEntry(tx, {
        client: input.client,
        documentNumber: original.journalDocumentNumber,
        fiscalYear: journalYear,
        reversalDate: input.postingDate,
        reason: `Goods receipt reversal ${number}`,
        reversedBy: input.changedBy,
        transactionCode: GR_POST_CAPABILITY,
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new GoodsReceiptError(error.message, error.remedy);
        throw error;
      });
      journalNumber = reversed.documentNumber;
    }

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
      documentDate: input.documentDate, postingDate: input.postingDate,
      headerText: `Reversal of ${input.materialDocumentNumber}`, status: 'POSTED',
      journalDocumentNumber: journalNumber, reversalOf: input.materialDocumentNumber,
      requestKey: input.requestKey, requestFingerprint: fingerprint, createdBy: input.changedBy,
    });
    for (const line of originalLines) {
      await tx.insert(materialDocumentLine).values({
        client: input.client, materialDocumentNumber: number, lineNumber: line.lineNumber,
        movementType: movement.movementType,
        materialNumber: line.materialNumber, plant: line.plant,
        storageLocation: line.storageLocation, stockType: line.stockType,
        batchNumber: line.batchNumber,
        entryQuantity: line.entryQuantity, entryUnit: line.entryUnit,
        baseQuantity: line.baseQuantity, baseUnit: line.baseUnit,
        unitPrice: line.unitPrice, priceUnit: line.priceUnit, currency: line.currency,
        value: line.value,
        purchaseOrderNumber: line.purchaseOrderNumber, purchaseOrderItem: line.purchaseOrderItem,
        reversalOfDocument: input.materialDocumentNumber, reversalOfLine: line.lineNumber,
        createdBy: input.changedBy,
      });
      await tx.update(stockQuantity).set({
        quantity: sql`${stockQuantity.quantity} - ${line.baseQuantity}`,
        changedBy: input.changedBy, changedAt: new Date(),
      }).where(and(
        eq(stockQuantity.client, input.client),
        eq(stockQuantity.materialNumber, line.materialNumber),
        eq(stockQuantity.plant, line.plant),
        eq(stockQuantity.storageLocation, line.storageLocation ?? ''),
        eq(stockQuantity.stockType, line.stockType),
        eq(stockQuantity.batchNumber, line.batchNumber),
      ));
      if (line.materialNumber) {
        await applyValuationDelta(
          tx, input.client, input.changedBy, line.materialNumber, line.plant,
          -Number(line.baseQuantity), -Number(line.value),
        );
      }
    }
    await tx.update(materialDocument).set({
      status: 'REVERSED', reversedBy: number, changedBy: input.changedBy, changedAt: new Date(),
    }).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.materialDocumentNumber, input.materialDocumentNumber),
    ));
    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: GR_POST_CAPABILITY,
      after: { movement: movement.movementType, reversalOf: input.materialDocumentNumber, status: 'POSTED' },
    });
    await noteBatchControlUse(tx, input.client, number, input.changedBy);

    return (await existingByRequestKey(tx, input.client, input.requestKey))!;
  });
}

function splitJournalKey(key: string): [number, string] {
  const parts = key.split('/');
  return [Number(parts[1]), parts.slice(2).join('/')];
}
