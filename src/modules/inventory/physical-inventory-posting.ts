import { createHash } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { PostingError, postJournalEntry } from '../../platform/posting';
import { accountDetermination, plant as plantTable, storageLocation } from '../foundation/schema';
import { lockStockScope } from './physical-inventory';
import { lockRequestKey } from './balance-update';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { materialPeriodAllows } from './material-period-control';
import { postingValuationRefusal } from './valuation-class-definition';
import { recordOutputsForPostedDocument } from './material-document-output';
import { reverseMaterialDocument } from './material-document-reversal';
import { recomputePostingStatus } from './physical-inventory-posting-status';
import { recountPostingBlock, syncRecountLink } from './physical-inventory-recount';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import {
  material, materialDocument, materialDocumentLine, materialValuation,
  movementType, stockQuantity,
} from './schema';

/**
 * Physical inventory difference posting — SCR-149 / MI07 (as a search alias only).
 *
 * The material document is the batch. This service does not write stock by a formula of its own
 * and does not keep a second journal. It looks up the movement by kind and direction, never by a
 * number, and the amount is the plant valuation at the currency's decimals. The list's estimate
 * is not an input.
 */

export const PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY = 'INV.PHYINV.DIFF.POST';
export const PHYSICAL_INVENTORY_DIFF_POST_ROUTE = '/inventory/physical-inventory-posting';
export const PHYSICAL_INVENTORY_DIFF_POST_ALIASES = ['MI07'] as const;

const JOURNAL_DOCUMENT_TYPE = 'WA';
const MATERIAL_DOCUMENT_CLASS = 'material_document';
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Delivered configuration, inserted only when the tenant has no difference movement for that
 * direction. The numbers are the row's key. The lookup below does not read them.
 */
const DELIVERED_DIFFERENCE_MOVEMENTS = [
  {
    movementType: '701', description: 'Physical inventory surplus', direction: 'RECEIPT',
    reversalMovementType: '702',
  },
  {
    movementType: '702', description: 'Physical inventory shortage', direction: 'ISSUE',
    reversalMovementType: '701',
  },
] as const;

export class PhysicalInventoryPostingError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PhysicalInventoryPostingError';
    this.remedy = remedy;
  }
}

export interface PostDifferencesInput {
  client: string;
  changedBy: string;
  documentNumber: string;
  fiscalYear: number;
  itemNumbers: number[];
  postingDate: string;
  documentDate: string;
  headerText?: string;
  externalReference?: string;
  requestKey: string;
  /** Not implemented. A present value is refused, never applied. */
  maximumDifferenceValue?: unknown;
}

export interface PostingLineView {
  itemNumber: number;
  materialNumber: string;
  stockType: string;
  difference: string;
  direction: 'SHORTAGE' | 'SURPLUS';
  movementType: string;
  quantity: string;
  /** The amount this posting would commit. Not the list's estimate, even when the figures agree. */
  postingValue: string | null;
  /** The current plant price, labelled as an estimate and never taken from the client. */
  estimate: string | null;
  currency: string | null;
  inventoryAccount: string | null;
  offsetAccount: string | null;
  eligible: boolean;
  reason: string | null;
}

export interface DifferencePostingPreview {
  documentNumber: string;
  fiscalYear: number;
  plant: string;
  storageLocation: string | null;
  companyCode: string | null;
  status: string;
  postingDate: string | null;
  documentDate: string | null;
  /** The material period the posting date fell in, once a date has been judged. */
  materialPeriod: string | null;
  journalRequired: boolean;
  lines: PostingLineView[];
}

export interface PostedDifferences {
  materialDocumentNumber: string;
  documentYear: number;
  journalDocumentNumber: string | null;
  headerStatus: string;
  lines: PostingLineView[];
}

export interface PostingHistoryEntry {
  itemNumber: number;
  materialDocumentNumber: string;
  lineNumber: number;
  postedDifference: string;
  reversedQuantity: string;
  reversalDocumentNumber: string | null;
  journalDocumentNumber: string | null;
  postingDate: string;
}

interface HeaderRow {
  inventory_document_number: string;
  fiscal_year: number;
  plant: string;
  storage_location: string | null;
  status: string;
  version: number;
}

interface ItemRow {
  item_number: number;
  material_number: string;
  stock_type: string;
  count_status: string;
  difference_quantity: string | null;
  counted_base_quantity: string | null;
  book_quantity_snapshot: string | null;
  version: number;
  posting_status: string;
  remaining_posted: string;
}

interface MovementRow {
  movement_type: string;
  direction: string;
  movement_kind: string;
  source_stock_type: string | null;
  destination_stock_type: string | null;
  requires_batch: boolean;
  requires_serial: boolean;
  requires_special_stock: boolean;
  requires_valuation_type: boolean;
  is_two_step: boolean;
  negative_stock_policy: string;
  valuation_relevant: boolean;
  inventory_event: string | null;
  offset_event: string | null;
  offset_modifier: string | null;
  account_assignment: string;
}

interface JudgedLine {
  item: ItemRow;
  movement: MovementRow;
  stockType: string;
  quantity: number;
  signed: number;
  value: number | null;
  currency: string | null;
  decimals: number | null;
  unitPrice: string | null;
  priceUnit: string | null;
  valuationClass: string | null;
  priceControl: string | null;
  inventoryAccount: string | null;
  offsetAccount: string | null;
}

function requireDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new PhysicalInventoryPostingError(
      `${label} ${value || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  return trimmed;
}

function fingerprintOf(input: PostDifferencesInput): string {
  const canonical = [
    input.documentNumber.trim(),
    String(input.fiscalYear),
    [...input.itemNumbers].sort((a, b) => a - b).join(','),
    input.postingDate,
    input.documentDate,
    (input.headerText ?? '').trim(),
    (input.externalReference ?? '').trim(),
  ].join('|');
  return createHash('sha256').update(canonical).digest('hex');
}

function assertShape(input: PostDifferencesInput, requireKey: boolean): void {
  if (input.maximumDifferenceValue !== undefined) {
    throw new PhysicalInventoryPostingError(
      'A maximum difference value is not implemented, and it will not drop a selected item or split the batch.',
      'Post the selected items, or leave the threshold off the request.',
    );
  }
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new PhysicalInventoryPostingError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if ((input.externalReference ?? '').length > 40) {
    throw new PhysicalInventoryPostingError('The external reference is longer than 40 characters.', 'Shorten the reference.');
  }
  if (input.itemNumbers.length === 0) {
    throw new PhysicalInventoryPostingError('No items were selected.', 'Select the differences to post, or choose every eligible item.');
  }
  if (new Set(input.itemNumbers).size !== input.itemNumbers.length) {
    throw new PhysicalInventoryPostingError('The same item was selected twice.', 'Select each item once.');
  }
  if (requireKey && !input.requestKey.trim()) {
    throw new PhysicalInventoryPostingError('A request key is required.', 'Repeat the same key to retry this posting.');
  }
  if (requireKey && input.requestKey.length > 64) {
    throw new PhysicalInventoryPostingError('The request key is longer than 64 characters.', 'Use a shorter key.');
  }
}

async function ensureDifferenceMovements(tx: Tx, client: string, changedBy: string): Promise<void> {
  for (const delivered of DELIVERED_DIFFERENCE_MOVEMENTS) {
    const standing = await tx.execute(sql`
      select movement_type from movement_type
       where client = ${client}
         and movement_kind = 'INVENTORY_DIFFERENCE'
         and direction = ${delivered.direction}
    `) as unknown as Array<{ movement_type: string }>;
    if (standing.length > 0) continue;
    const taken = await tx.execute(sql`
      select movement_kind from movement_type
       where client = ${client} and movement_type = ${delivered.movementType}
    `) as unknown as Array<{ movement_kind: string }>;
    if (taken.length > 0) {
      throw new PhysicalInventoryPostingError(
        `Movement ${delivered.movementType} already stands and is not an inventory difference.`,
        'Configure a difference movement for this direction, or free the number.',
      );
    }
    await tx.insert(movementType).values({
      client,
      movementType: delivered.movementType,
      description: delivered.description,
      direction: delivered.direction,
      referenceCategory: 'PHYSICAL_INVENTORY',
      movementKind: 'INVENTORY_DIFFERENCE',
      reversalMovementType: delivered.reversalMovementType,
      valuationRelevant: true,
      inventoryEvent: 'INVENTORY',
      offsetEvent: 'OFFSETTING_INVENTORY',
      offsetModifier: 'DIFF',
      plantRule: 'SAME',
      locationRule: 'SAME',
      accountAssignment: 'NONE',
      negativeStockPolicy: 'LOCATION',
      createdBy: changedBy,
    });
  }
}

async function loadHeader(tx: Tx, client: string, documentNumber: string, fiscalYear: number): Promise<HeaderRow | null> {
  const rows = await tx.execute(sql`
    select inventory_document_number, fiscal_year, plant, storage_location, status, version
      from physical_inventory_document
     where client = ${client}
       and inventory_document_number = ${documentNumber}
       and fiscal_year = ${fiscalYear}
     for update
  `) as unknown as HeaderRow[];
  return rows[0] ?? null;
}

async function loadItems(tx: Tx, client: string, documentNumber: string, fiscalYear: number): Promise<ItemRow[]> {
  return await tx.execute(sql`
    select i.item_number, i.material_number, i.stock_type, i.count_status,
           i.difference_quantity::text as difference_quantity,
           i.counted_base_quantity::text as counted_base_quantity,
           i.book_quantity_snapshot::text as book_quantity_snapshot,
           i.version, i.posting_status,
           coalesce(sum(abs(a.posted_difference) - a.reversed_quantity), 0)::text as remaining_posted
      from physical_inventory_item i
      left join physical_inventory_difference_allocation a
        on a.client = i.client
       and a.inventory_document_number = i.inventory_document_number
       and a.fiscal_year = i.fiscal_year
       and a.item_number = i.item_number
     where i.client = ${client}
       and i.inventory_document_number = ${documentNumber}
       and i.fiscal_year = ${fiscalYear}
     group by i.item_number, i.material_number, i.stock_type, i.count_status, i.difference_quantity,
              i.counted_base_quantity, i.book_quantity_snapshot, i.version, i.posting_status
     order by i.item_number
  `) as unknown as ItemRow[];
}

async function movementFor(tx: Tx, client: string, direction: 'RECEIPT' | 'ISSUE'): Promise<MovementRow> {
  const rows = await tx.execute(sql`
    select movement_type, direction, movement_kind, source_stock_type, destination_stock_type,
           requires_batch, requires_serial, requires_special_stock, requires_valuation_type,
           is_two_step, negative_stock_policy, valuation_relevant,
           inventory_event, offset_event, offset_modifier, account_assignment
      from movement_type
     where client = ${client}
       and movement_kind = 'INVENTORY_DIFFERENCE'
       and direction = ${direction}
  `) as unknown as MovementRow[];
  const word = direction === 'RECEIPT' ? 'surplus' : 'shortage';
  if (rows.length === 0) {
    throw new PhysicalInventoryPostingError(
      `No difference movement is configured for a ${word}.`,
      'Configure one inventory-difference movement for that direction, then post.',
    );
  }
  if (rows.length > 1) {
    throw new PhysicalInventoryPostingError(
      `More than one difference movement is configured for a ${word} (${rows.map((r) => r.movement_type).sort().join(', ')}).`,
      'Leave one movement for that direction. Ambiguous configuration is not a guess.',
    );
  }
  return rows[0];
}

function refuseUnusable(movement: MovementRow, itemNumber: number): void {
  if (movement.requires_batch) {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} requires a batch, and item ${itemNumber} does not carry one.`,
      'Batch is refused by name. Use a difference movement that does not require one.',
    );
  }
  if (movement.requires_serial) {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} requires a serial number, and item ${itemNumber} does not carry one.`,
      'Serial numbers are refused by name.',
    );
  }
  if (movement.requires_special_stock) {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} requires a special stock, and item ${itemNumber} does not carry one.`,
      'Special stock is refused by name.',
    );
  }
  if (movement.requires_valuation_type) {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} requires a valuation type, and item ${itemNumber} does not carry one.`,
      'Split valuation is refused by name.',
    );
  }
  if (movement.is_two_step) {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} is a two-step movement, and a difference posts in one step.`,
      'Use a one-step difference movement.',
    );
  }
  if (movement.account_assignment !== 'NONE') {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} charges a ${movement.account_assignment.replace('_', ' ').toLowerCase()}, and a difference posting does not.`,
      'Use a difference movement with no account assignment. The offset account comes from account determination.',
    );
  }
}

function stockTypeOf(movement: MovementRow, item: ItemRow): string {
  const named = movement.direction === 'RECEIPT' ? movement.destination_stock_type : movement.source_stock_type;
  if (named && named !== item.stock_type) {
    throw new PhysicalInventoryPostingError(
      `Movement ${movement.movement_type} posts ${named} stock, and item ${item.item_number} is ${item.stock_type}.`,
      'Leave the movement\'s stock type empty to post the item\'s own, or name the same stock type.',
    );
  }
  return item.stock_type;
}

function itemReason(item: ItemRow | undefined, itemNumber: number, header: HeaderRow): string | null {
  if (!item) return `Item ${itemNumber} does not belong to document ${header.inventory_document_number}.`;
  if (header.status === 'CANCELLED') return 'The count document was cancelled.';
  if (!header.storage_location) {
    return 'The document names no storage location, so the difference cannot be posted to one stock dimension.';
  }
  if (item.count_status === 'UNCOUNTED') return `Item ${item.item_number} has not been counted, and an uncounted item is not zero.`;
  if (item.count_status === 'RECOUNT_REQUIRED') {
    return `Item ${item.item_number} is marked for recount, which this posting does not create or clear.`;
  }
  if (item.count_status !== 'COUNTED') return `Item ${item.item_number} is ${item.count_status}, which cannot be posted.`;
  if (item.difference_quantity === null || item.counted_base_quantity === null || item.book_quantity_snapshot === null) {
    return `Item ${item.item_number} has no stored difference to post.`;
  }
  const stored = Number(item.difference_quantity);
  const recomputed = Number(item.counted_base_quantity) - Number(item.book_quantity_snapshot);
  if (Math.abs(stored - recomputed) > 0.0005) {
    return `Item ${item.item_number} stores a difference of ${stored.toFixed(3)} that does not match the book and the count. The posting will not overwrite it.`;
  }
  if (Math.abs(stored) <= 0.0005) return `Item ${item.item_number} has no difference, and a zero is not an adjustment.`;
  const remaining = Math.abs(stored) - Number(item.remaining_posted);
  if (remaining <= 0.0005) return `Item ${item.item_number} is already fully posted.`;
  return null;
}

async function accountFor(
  tx: Tx, client: string, chart: string, event: string, valuationClass: string, modifier: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
    eq(accountDetermination.generalModifier, modifier),
  ));
  const row = rows.find((r) => r.valuationClass === valuationClass) ?? rows.find((r) => r.valuationClass === '');
  if (!row) {
    throw new PhysicalInventoryPostingError(
      `Account determination for ${event}${modifier ? ` modifier ${modifier}` : ''} and valuation class ${valuationClass} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

async function judgeItem(
  tx: Tx, client: string, header: HeaderRow, item: ItemRow, companyCurrency: string, chart: string,
): Promise<JudgedLine> {
  const signed = Number(item.difference_quantity);
  const movement = await movementFor(tx, client, signed > 0 ? 'RECEIPT' : 'ISSUE');
  refuseUnusable(movement, item.item_number);
  const stockType = stockTypeOf(movement, item);
  const quantity = Math.abs(signed);

  const [valuation] = await tx.select().from(materialValuation).where(and(
    eq(materialValuation.client, client),
    eq(materialValuation.materialNumber, item.material_number),
    eq(materialValuation.valuationArea, header.plant),
  ));
  if (movement.valuation_relevant && (!valuation || !valuation.valuationClass)) {
    throw new PhysicalInventoryPostingError(
      `Material ${item.material_number} has no valuation record in plant ${header.plant}, and movement ${movement.movement_type} requires one.`,
      'Maintain the plant valuation, or use a difference movement that does not value. An unvalued difference is not posted at zero.',
    );
  }
  if (!movement.valuation_relevant) {
    return {
      item, movement, stockType, quantity, signed, value: null, currency: null, decimals: null,
      unitPrice: null, priceUnit: null, valuationClass: null, priceControl: null,
      inventoryAccount: null, offsetAccount: null,
    };
  }
  const classRefusal = await postingValuationRefusal(tx, client, item.material_number, valuation!.valuationClass!);
  if (classRefusal) {
    throw new PhysicalInventoryPostingError(
      classRefusal,
      'Maintain a valuation class this material type permits, then post the difference.',
    );
  }
  if (valuation!.currency !== companyCurrency) {
    throw new PhysicalInventoryPostingError(
      `Material ${item.material_number} is valued in ${valuation!.currency}, and the company keeps its books in ${companyCurrency}.`,
      'No rate is assumed. Value the material in the company currency, or post a movement that does not write a journal.',
    );
  }
  const precision = await tx.execute(sql`
    select decimal_places from currency where code = ${valuation!.currency}
  `) as unknown as Array<{ decimal_places: number }>;
  const decimals = precision[0]?.decimal_places;
  if (decimals === undefined || decimals === null) {
    throw new PhysicalInventoryPostingError(
      `Currency ${valuation!.currency} has no decimal places, so the difference cannot be rounded.`,
      'Maintain the currency, then post.',
    );
  }
  const priced = await tx.execute(sql`
    select round(
      ${quantity}::numeric * (
        case when ${valuation!.priceControl} = 'STANDARD'
          then ${valuation!.standardPrice}::numeric
          else ${valuation!.movingAveragePrice}::numeric
        end
      ) / ${valuation!.priceUnit}::numeric
    , ${decimals}::int)::text as value
  `) as unknown as Array<{ value: string }>;
  const value = Number(priced[0].value);
  if (!(value > 0)) {
    throw new PhysicalInventoryPostingError(
      `Material ${item.material_number} prices to zero at the plant valuation, and movement ${movement.movement_type} requires an amount.`,
      'Maintain a price, or use a difference movement that does not value.',
    );
  }
  const inventoryAccount = await accountFor(tx, client, chart, movement.inventory_event!, valuation!.valuationClass!, '');
  const offsetAccount = await accountFor(tx, client, chart, movement.offset_event!, valuation!.valuationClass!, movement.offset_modifier!);
  return {
    item, movement, stockType, quantity, signed, value, currency: valuation!.currency, decimals,
    unitPrice: valuation!.priceControl === 'STANDARD' ? valuation!.standardPrice : valuation!.movingAveragePrice,
    priceUnit: valuation!.priceUnit,
    valuationClass: valuation!.valuationClass,
    priceControl: valuation!.priceControl,
    inventoryAccount, offsetAccount,
  };
}

function lineView(judged: JudgedLine, eligible: boolean, reason: string | null): PostingLineView {
  const value = judged.value === null ? null : judged.value.toFixed(judged.decimals ?? 2);
  return {
    itemNumber: judged.item.item_number,
    materialNumber: judged.item.material_number,
    stockType: judged.stockType,
    difference: judged.signed.toFixed(3),
    direction: judged.signed < 0 ? 'SHORTAGE' : 'SURPLUS',
    movementType: judged.movement.movement_type,
    quantity: judged.quantity.toFixed(3),
    postingValue: value,
    estimate: value,
    currency: judged.currency,
    inventoryAccount: judged.inventoryAccount,
    offsetAccount: judged.offsetAccount,
    eligible,
    reason,
  };
}

async function judgeSelection(
  tx: Tx, client: string, input: PostDifferencesInput, header: HeaderRow, items: ItemRow[],
): Promise<{ companyCode: string; judged: JudgedLine[]; materialPeriod: string }> {
  const [plantRow] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, header.plant),
  ));
  if (!plantRow?.companyCode) {
    throw new PhysicalInventoryPostingError(`Plant ${header.plant} does not stand.`, 'Maintain the plant, then post.');
  }
  const company = await getCompanyCode(tx, client, plantRow.companyCode);
  if (!company?.fiscalYearVariant || !company.chartOfAccounts || !company.currency) {
    throw new PhysicalInventoryPostingError(
      `Company code ${plantRow.companyCode} is not configured.`,
      'Complete the company code, then post.',
    );
  }
  if (header.storage_location) {
    const [location] = await tx.select().from(storageLocation).where(and(
      eq(storageLocation.client, client),
      eq(storageLocation.plant, header.plant),
      eq(storageLocation.storageLocation, header.storage_location),
    ));
    if (!location) {
      throw new PhysicalInventoryPostingError(
        `Storage location ${header.storage_location} does not stand in plant ${header.plant}.`,
        'Maintain the storage location, then post.',
      );
    }
  }
  const position = await derivePosition(tx, client, company.fiscalYearVariant, input.postingDate);
  const period = await getMaterialPeriodControlInTx(tx, client, plantRow.companyCode);
  if (!materialPeriodAllows(period, position.fiscalYear, position.period)) {
    throw new PhysicalInventoryPostingError(
      `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${plantRow.companyCode}.`,
      'Post into the open material period. The count date is not the posting date.',
    );
  }

  const judged: JudgedLine[] = [];
  const failures: string[] = [];
  for (const itemNumber of input.itemNumbers) {
    const item = items.find((row) => row.item_number === itemNumber);
    const reason = await recountPostingBlock(tx, client, header.inventory_document_number, header.fiscal_year, itemNumber)
      ?? itemReason(item, itemNumber, header);
    if (reason || !item) {
      failures.push(reason ?? `Item ${itemNumber} does not belong to the document.`);
      continue;
    }
    try {
      judged.push(await judgeItem(tx, client, header, item, company.currency, company.chartOfAccounts));
    } catch (caught) {
      if (caught instanceof PhysicalInventoryPostingError) failures.push(caught.message);
      else throw caught;
    }
  }
  if (failures.length > 0) {
    throw new PhysicalInventoryPostingError(failures.join(' '), 'Correct the selection and post it again. Nothing selected was skipped.');
  }
  return {
    companyCode: plantRow.companyCode,
    judged,
    materialPeriod: `${position.fiscalYear}/${position.period}`,
  };
}

async function replayOrRefuse(tx: Tx, client: string, requestKey: string, fingerprint: string): Promise<PostedDifferences | null> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  if (header.requestFingerprint && header.requestFingerprint !== fingerprint) {
    throw new PhysicalInventoryPostingError(
      `Request key ${requestKey} already posted ${header.materialDocumentNumber}, and this is a different posting.`,
      'Post with a fresh request key, or repeat the original request exactly.',
    );
  }
  return postedView(tx, client, header.materialDocumentNumber);
}

async function postedView(tx: Tx, client: string, materialDocumentNumber: string): Promise<PostedDifferences> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client),
    eq(materialDocument.materialDocumentNumber, materialDocumentNumber),
  ));
  const lines = await tx.execute(sql`
    select a.item_number, a.posted_difference::text as difference, l.movement_type, l.base_quantity::text as quantity,
           l.value::text as value, l.currency, c.decimal_places, l.stock_type, l.material_number, l.line_direction
      from physical_inventory_difference_allocation a
      join material_document_line l
        on l.client = a.client and l.material_document_number = a.material_document_number and l.line_number = a.line_number
      left join currency c on c.code = l.currency
     where a.client = ${client} and a.material_document_number = ${materialDocumentNumber}
     order by a.item_number
  `) as unknown as Array<{
    item_number: number; difference: string; movement_type: string; quantity: string;
    value: string; currency: string | null; decimal_places: number | null;
    stock_type: string; material_number: string; line_direction: string;
  }>;
  const allocation = lines[0];
  const inventory = allocation
    ? await tx.execute(sql`
        select d.status from physical_inventory_difference_allocation a
          join physical_inventory_document d
            on d.client = a.client and d.inventory_document_number = a.inventory_document_number and d.fiscal_year = a.fiscal_year
         where a.client = ${client} and a.material_document_number = ${materialDocumentNumber}
         limit 1
      `) as unknown as Array<{ status: string }>
    : [];
  return {
    materialDocumentNumber,
    documentYear: header.documentYear,
    journalDocumentNumber: header.journalDocumentNumber,
    headerStatus: inventory[0]?.status ?? '',
    lines: lines.map((line) => ({
      itemNumber: line.item_number,
      materialNumber: line.material_number,
      stockType: line.stock_type,
      difference: Number(line.difference).toFixed(3),
      direction: line.line_direction === 'ISSUE' ? 'SHORTAGE' as const : 'SURPLUS' as const,
      movementType: line.movement_type,
      quantity: Number(line.quantity).toFixed(3),
      postingValue: line.currency ? Number(line.value).toFixed(line.decimal_places ?? 2) : null,
      estimate: null,
      currency: line.currency,
      inventoryAccount: null,
      offsetAccount: null,
      eligible: false,
      reason: null,
    })),
  };
}


/** A load must not call an unvalued item eligible, or selecting every eligible item fails the batch. */
async function missingValuationReason(
  tx: Tx, client: string, plant: string, materialNumber: string, direction: 'ISSUE' | 'RECEIPT',
): Promise<string | null> {
  const movements = await tx.execute(sql`
    select movement_type, valuation_relevant from movement_type
     where client = ${client} and movement_kind = 'INVENTORY_DIFFERENCE' and direction = ${direction}
  `) as unknown as Array<{ movement_type: string; valuation_relevant: boolean }>;
  const values = movements.length === 0 || movements.some((row) => row.valuation_relevant);
  if (!values) return null;
  const standing = await tx.execute(sql`
    select 1 from material_valuation
     where client = ${client} and material_number = ${materialNumber} and valuation_area = ${plant}
  `) as unknown as unknown[];
  if (standing.length > 0) return null;
  const named = movements.length === 1 ? `movement ${movements[0].movement_type}` : 'a difference movement that values';
  return `Material ${materialNumber} has no valuation record, and ${named} requires one.`;
}

/** The document and its items, with the reason an item cannot be posted. Writes nothing. */
export async function getDifferencePosting(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<DifferencePostingPreview | null> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select inventory_document_number, fiscal_year, plant, storage_location, status, version
        from physical_inventory_document
       where client = ${client}
         and inventory_document_number = ${keys.documentNumber}
         and fiscal_year = ${keys.fiscalYear}
    `) as unknown as HeaderRow[];
    const header = rows[0];
    if (!header) return null;
    const items = await loadItems(tx, client, keys.documentNumber, keys.fiscalYear);
    const lines = [];
    for (const item of items) {
      const reason = await recountPostingBlock(tx, client, header.inventory_document_number, header.fiscal_year, item.item_number)
        ?? itemReason(item, item.item_number, header);
      const signed = item.difference_quantity === null ? 0 : Number(item.difference_quantity);
      const valuationReason = reason === null && Math.abs(signed) > 0.0005
        ? await missingValuationReason(tx, client, header.plant, item.material_number, signed < 0 ? 'ISSUE' : 'RECEIPT')
        : null;
      const shown = reason ?? valuationReason;
      lines.push({
        itemNumber: item.item_number,
        materialNumber: item.material_number,
        stockType: item.stock_type,
        difference: item.difference_quantity === null ? '' : signed.toFixed(3),
        direction: signed < 0 ? 'SHORTAGE' as const : 'SURPLUS' as const,
        movementType: '',
        quantity: item.difference_quantity === null ? '' : Math.abs(signed).toFixed(3),
        postingValue: null,
        estimate: null,
        currency: null,
        inventoryAccount: null,
        offsetAccount: null,
        eligible: shown === null,
        reason: shown,
      });
    }
    return {
      documentNumber: header.inventory_document_number,
      fiscalYear: header.fiscal_year,
      plant: header.plant,
      storageLocation: header.storage_location,
      companyCode: null,
      status: header.status,
      postingDate: null,
      documentDate: null,
      materialPeriod: null,
      journalRequired: false,
      lines,
    };
  });
}

/** The same judgement as a posting, and no write. */
export async function validateDifferencePosting(
  input: Omit<PostDifferencesInput, 'requestKey'> & { requestKey?: string },
): Promise<DifferencePostingPreview> {
  const full: PostDifferencesInput = { ...input, requestKey: input.requestKey ?? 'validate' };
  assertShape(full, false);
  return withTenant(input.client, async (tx) => {
    const header = await loadHeader(tx, input.client, input.documentNumber, input.fiscalYear);
    if (!header) {
      throw new PhysicalInventoryPostingError(
        `Physical inventory document ${input.documentNumber} for fiscal year ${input.fiscalYear} does not exist.`,
      );
    }
    const items = await loadItems(tx, input.client, input.documentNumber, input.fiscalYear);
    const { companyCode, judged, materialPeriod } = await judgeSelection(tx, input.client, full, header, items);
    return {
      documentNumber: header.inventory_document_number,
      fiscalYear: header.fiscal_year,
      plant: header.plant,
      storageLocation: header.storage_location,
      companyCode,
      status: header.status,
      postingDate: input.postingDate,
      documentDate: input.documentDate,
      materialPeriod,
      journalRequired: judged.some((line) => line.movement.valuation_relevant),
      lines: judged.map((line) => lineView(line, true, null)),
    };
  });
}

export async function postDifferences(input: PostDifferencesInput): Promise<PostedDifferences> {
  assertShape(input, true);
  const fingerprint = fingerprintOf(input);
  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await replayOrRefuse(tx, input.client, input.requestKey, fingerprint);
    if (replay) return replay;

    await ensureDifferenceMovements(tx, input.client, input.changedBy);
    const header = await loadHeader(tx, input.client, input.documentNumber, input.fiscalYear);
    if (!header) {
      throw new PhysicalInventoryPostingError(
        `Physical inventory document ${input.documentNumber} for fiscal year ${input.fiscalYear} does not exist.`,
      );
    }
    const items = await loadItems(tx, input.client, input.documentNumber, input.fiscalYear);
    await lockStockScope(tx, input.client, items.map((item) => item.material_number), 'EXCLUSIVE');
    const { companyCode, judged } = await judgeSelection(tx, input.client, input, header, items);

    if (header.storage_location) {
      try {
        await resolveStorageLocation(tx, {
          client: input.client,
          plant: header.plant,
          typed: header.storage_location,
          required: true,
          applyPlantDefault: false,
          verb: 'Post into',
        });
      } catch (caught) {
        if (caught instanceof StorageLocationError) throw new PhysicalInventoryPostingError(caught.message, caught.remedy);
        throw caught;
      }
    }
    for (const line of judged) {
      const [location] = await tx.select().from(storageLocation).where(and(
        eq(storageLocation.client, input.client),
        eq(storageLocation.plant, header.plant),
        eq(storageLocation.storageLocation, header.storage_location ?? ''),
      ));
      const [stock] = await tx.select().from(stockQuantity).where(and(
        eq(stockQuantity.client, input.client),
        eq(stockQuantity.materialNumber, line.item.material_number),
        eq(stockQuantity.plant, header.plant),
        eq(stockQuantity.storageLocation, header.storage_location ?? ''),
        eq(stockQuantity.stockType, line.stockType),
      ));
      const onHand = Number(stock?.quantity ?? 0);
      const forbid = line.movement.negative_stock_policy === 'FORBID' || !location?.allowNegativeStock;
      if (line.signed < 0 && forbid && onHand + 1e-9 < line.quantity) {
        throw new PhysicalInventoryPostingError(
          `Storage location ${header.storage_location} in plant ${header.plant} carries ${onHand.toFixed(3)} of ${line.item.material_number} in ${line.stockType}, and the shortage is ${line.quantity.toFixed(3)}.`,
          'The location does not allow the stock to go negative.',
        );
      }
      if (line.movement.valuation_relevant) {
        const [valuation] = await tx.select().from(materialValuation).where(and(
          eq(materialValuation.client, input.client),
          eq(materialValuation.materialNumber, line.item.material_number),
          eq(materialValuation.valuationArea, header.plant),
        ));
        const nextQty = Number(valuation!.totalStockQuantity) + (line.signed < 0 ? -line.quantity : line.quantity);
        const nextValue = Number(valuation!.stockValue) + (line.signed < 0 ? -line.value! : line.value!);
        if (nextQty < -1e-9 || nextValue < -1e-9) {
          throw new PhysicalInventoryPostingError(
            `Posting item ${line.item.item_number} would drive the valued stock of ${line.item.material_number} below zero.`,
            'The valuation record cannot hold a negative quantity or a negative value.',
          );
        }
      }
    }

    const company = await getCompanyCode(tx, input.client, companyCode);
    const position = await derivePosition(tx, input.client, company!.fiscalYearVariant!, input.postingDate);
    const needsJournal = judged.some((line) => line.movement.valuation_relevant);
    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    let journalNumber: string | null = null;
    if (needsJournal) {
      const journalLines = judged.filter((line) => line.movement.valuation_relevant).flatMap((line) => {
        const amount = line.value!.toFixed(line.decimals ?? 2);
        const inventorySide = line.signed > 0 ? 'S' as const : 'H' as const;
        const offsetSide = line.signed > 0 ? 'H' as const : 'S' as const;
        return [
          { glAccount: line.inventoryAccount!, debitCredit: inventorySide, amount, material: line.item.material_number, plant: header.plant },
          { glAccount: line.offsetAccount!, debitCredit: offsetSide, amount, material: line.item.material_number, plant: header.plant },
        ];
      });
      const journal = await postJournalEntry(tx, {
        client: input.client,
        companyCode,
        documentType: JOURNAL_DOCUMENT_TYPE,
        documentDate: input.documentDate,
        postingDate: input.postingDate,
        fiscalYear: position.fiscalYear,
        postingPeriod: position.period,
        currency: company!.currency!,
        localCurrency: company!.currency!,
        reference: input.externalReference?.trim() || input.documentNumber,
        headerText: input.headerText?.trim() || undefined,
        lines: journalLines,
        origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
        postedBy: input.changedBy,
        transactionCode: PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY,
      }).catch((error: unknown) => {
        if (error instanceof PostingError) throw new PhysicalInventoryPostingError(error.message, error.remedy);
        throw error;
      });
      journalNumber = journal.documentNumber;
    }

    await tx.insert(materialDocument).values({
      client: input.client,
      materialDocumentNumber: number,
      documentYear: position.fiscalYear,
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      headerText: input.headerText?.trim() || null,
      status: 'POSTED',
      journalDocumentNumber: journalNumber,
      requestKey: input.requestKey,
      requestFingerprint: fingerprint,
      externalReference: input.externalReference?.trim() || null,
      createdBy: input.changedBy,
    });

    let lineNumber = 0;
    for (const line of judged) {
      lineNumber += 1;
      const direction = line.signed < 0 ? 'ISSUE' : 'RECEIPT';
      await tx.insert(materialDocumentLine).values({
        client: input.client,
        materialDocumentNumber: number,
        lineNumber,
        movementType: line.movement.movement_type,
        materialNumber: line.item.material_number,
        plant: header.plant,
        storageLocation: header.storage_location,
        stockType: line.stockType,
        lineDirection: direction,
        entryQuantity: line.quantity.toFixed(3),
        entryUnit: 'PC',
        baseQuantity: line.quantity.toFixed(3),
        baseUnit: 'PC',
        unitPrice: line.unitPrice ?? '0',
        priceUnit: line.priceUnit ?? '1',
        currency: line.currency,
        value: line.value === null ? '0' : line.value.toFixed(line.decimals ?? 2),
        createdBy: input.changedBy,
      });
      const [master] = await tx.select({ baseUnit: material.baseUnit }).from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, line.item.material_number),
      ));
      if (master?.baseUnit) {
        await tx.update(materialDocumentLine).set({
          entryUnit: master.baseUnit, baseUnit: master.baseUnit,
        }).where(and(
          eq(materialDocumentLine.client, input.client),
          eq(materialDocumentLine.materialDocumentNumber, number),
          eq(materialDocumentLine.lineNumber, lineNumber),
        ));
      }
      const delta = line.signed < 0 ? -line.quantity : line.quantity;
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, quantity, created_by)
        values (${input.client}, ${line.item.material_number}, ${header.plant}, ${header.storage_location ?? ''},
                ${line.stockType}, ${String(delta)}, ${input.changedBy})
        on conflict (client, material_number, plant, storage_location, stock_type)
        do update set quantity = stock_quantity.quantity + ${delta},
                      changed_by = ${input.changedBy}, changed_at = now()
      `);
      if (line.movement.valuation_relevant && line.value !== null) {
        const valueDelta = line.signed < 0 ? -line.value : line.value;
        await tx.execute(sql`
          update material_valuation
             set total_stock_quantity = total_stock_quantity + ${delta},
                 stock_value = stock_value + ${valueDelta},
                 moving_average_price = case
                   when price_control = 'MOVING_AVERAGE' and total_stock_quantity + ${delta} > 0
                   then round((stock_value + ${valueDelta}) / (total_stock_quantity + ${delta}) * price_unit, ${line.decimals ?? 2})
                   else moving_average_price
                 end,
                 changed_by = ${input.changedBy}, changed_at = now()
           where client = ${input.client}
             and material_number = ${line.item.material_number}
             and valuation_area = ${header.plant}
        `);
      }
      await tx.execute(sql`
        insert into physical_inventory_difference_allocation
          (client, inventory_document_number, fiscal_year, item_number, count_version, posted_difference,
           material_document_number, line_number, created_by)
        values (${input.client}, ${header.inventory_document_number}, ${header.fiscal_year}, ${line.item.item_number},
                ${line.item.version}, ${line.signed.toFixed(3)}, ${number}, ${lineNumber}, ${input.changedBy})
      `);
    }

    const headerStatus = await recomputePostingStatus(
      tx, input.client, header.inventory_document_number, header.fiscal_year, input.changedBy,
    );
    await syncRecountLink(tx, input.client, header.inventory_document_number, header.fiscal_year, input.changedBy);
    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: PHYSICAL_INVENTORY_DIFF_POST_CAPABILITY,
      after: {
        inventoryDocument: header.inventory_document_number,
        fiscalYear: header.fiscal_year,
        items: judged.map((line) => line.item.item_number),
        journal: journalNumber,
        headerStatus,
      },
    });
    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);
    return postedView(tx, input.client, number);
  });
}

export async function getPostingHistory(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<PostingHistoryEntry[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select a.item_number, a.material_document_number, a.line_number,
             a.posted_difference::text as posted_difference, a.reversed_quantity::text as reversed_quantity,
             a.reversal_document_number, d.journal_document_number, d.posting_date
        from physical_inventory_difference_allocation a
        join material_document d
          on d.client = a.client and d.material_document_number = a.material_document_number
       where a.client = ${client}
         and a.inventory_document_number = ${keys.documentNumber}
         and a.fiscal_year = ${keys.fiscalYear}
       order by a.item_number, a.material_document_number
    `) as unknown as Array<{
      item_number: number; material_document_number: string; line_number: number;
      posted_difference: string; reversed_quantity: string; reversal_document_number: string | null;
      journal_document_number: string | null; posting_date: string;
    }>;
    return rows.map((row) => ({
      itemNumber: row.item_number,
      materialDocumentNumber: row.material_document_number,
      lineNumber: row.line_number,
      postedDifference: row.posted_difference,
      reversedQuantity: row.reversed_quantity,
      reversalDocumentNumber: row.reversal_document_number,
      journalDocumentNumber: row.journal_document_number,
      postingDate: row.posting_date,
    }));
  });
}

/** Calls the canonical reversal. The allocation is released inside that transaction, not here. */
export async function reverseDifferencePosting(input: {
  client: string;
  changedBy: string;
  materialDocumentNumber: string;
  postingDate: string;
  documentDate: string;
  headerText?: string;
  /** Forwarded so the canonical reversal can refuse a reason. This screen does not invent a table. */
  reason?: string;
  requestKey: string;
}) {
  return reverseMaterialDocument({
    client: input.client,
    changedBy: input.changedBy,
    materialDocumentNumber: input.materialDocumentNumber,
    postingDate: input.postingDate,
    documentDate: input.documentDate,
    headerText: input.headerText,
    reason: input.reason,
    requestKey: input.requestKey,
  });
}

