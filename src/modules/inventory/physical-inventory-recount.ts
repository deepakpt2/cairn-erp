/**
 * Physical inventory recount — SCR-150.
 *
 * A recount is a new document for the items the person selected. The original count stays.
 * The two quantities are never added. This module does not post, reverse, or open a second
 * transaction inside the document writer.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { writeInventoryDocument } from './physical-inventory';
import { physicalInventoryDocument, physicalInventoryItem, physicalInventoryRecountLink } from './schema';
export const PHYSICAL_INVENTORY_RECOUNT_CAPABILITY = 'INV.PHYINV.RECOUNT';
export const PHYSICAL_INVENTORY_RECOUNT_ROUTE = '/inventory/physical-inventory-recount';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_LIMIT = 40;

export class PhysicalInventoryRecountError extends Error {
  remedy?: string;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PhysicalInventoryRecountError';
    this.remedy = remedy;
  }
}

export interface CreateRecountInput {
  client: string;
  changedBy: string;
  documentNumber: string;
  fiscalYear: number;
  itemNumbers: number[];
  plannedRecountDate: string;
  reason: string;
  headerText?: string;
  requestKey: string;
  /** Not implemented. A present value is refused, never applied. */
  varianceThreshold?: unknown;
  batch?: unknown;
  specialStock?: unknown;
}

export interface RecountItemView {
  sourceItemNumber: number;
  recountItemNumber: number;
  materialNumber: string;
  stockType: string;
  bookQuantity: string;
  originalCountedQuantity: string;
  originalDifference: string;
}

export interface RecountView {
  sourceDocumentNumber: string;
  sourceFiscalYear: number;
  recountDocumentNumber: string;
  recountFiscalYear: number;
  plannedRecountDate: string;
  reason: string;
  headerText: string;
  status: string;
  items: RecountItemView[];
}

export interface RecountPreview {
  sourceDocumentNumber: string;
  sourceFiscalYear: number;
  plant: string;
  storageLocation: string | null;
  plannedRecountDate: string;
  reason: string;
  headerText: string;
  items: Array<{
    itemNumber: number;
    materialNumber: string;
    stockType: string;
    originalBookQuantity: string;
    originalCountedQuantity: string;
    originalDifference: string;
    bookQuantityNow: string;
  }>;
}

function requireDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new PhysicalInventoryRecountError(
      `${label} ${value || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD. A planned recount date is not a posting date.',
    );
  }
  return trimmed;
}

function boundText(value: string | undefined, label: string, required: boolean): string {
  const raw = value ?? '';
  if (raw.length > TEXT_LIMIT) {
    throw new PhysicalInventoryRecountError(
      `${label} is longer than ${TEXT_LIMIT} characters.`,
      'Shorten it. It is not truncated.',
    );
  }
  const trimmed = raw.trim();
  if (required && !trimmed) {
    throw new PhysicalInventoryRecountError(`${label} is required.`, 'Say why the recount is required.');
  }
  return trimmed;
}

function assertShape(input: CreateRecountInput, requireKey: boolean): { date: string; reason: string; header: string } {
  if (input.varianceThreshold !== undefined) {
    throw new PhysicalInventoryRecountError(
      'A variance threshold is not implemented, and it will not recommend or hide an item.',
      'Select the items. A difference is not a reason to select them.',
    );
  }
  if (input.batch !== undefined || input.specialStock !== undefined) {
    throw new PhysicalInventoryRecountError(
      'Batch and special stock are not carried on a recount.',
      'Recount the stock type the item already names.',
    );
  }
  const date = requireDate(input.plannedRecountDate, 'The planned recount date');
  const reason = boundText(input.reason, 'The recount reason', true);
  const header = boundText(input.headerText, 'The header note', false);
  if (input.itemNumbers.length === 0) {
    throw new PhysicalInventoryRecountError('No items were selected.', 'Select at least one counted item.');
  }
  if (new Set(input.itemNumbers).size !== input.itemNumbers.length) {
    throw new PhysicalInventoryRecountError('The same item was selected twice.', 'Select each item once.');
  }
  if (requireKey && !input.requestKey.trim()) {
    throw new PhysicalInventoryRecountError('A request key is required.', 'Repeat the same key to retry this recount.');
  }
  if (requireKey && input.requestKey.length > 64) {
    throw new PhysicalInventoryRecountError('The request key is longer than 64 characters.', 'Use a shorter key.');
  }
  return { date, reason, header };
}

type SourceItem = {
  item_number: number;
  material_number: string;
  stock_type: string;
  count_status: string;
  counted_quantity: string | null;
  difference_quantity: string | null;
  book_quantity_snapshot: string | null;
  posting_status: string;
};

type SourceHeader = {
  inventory_document_number: string;
  fiscal_year: number;
  plant: string;
  storage_location: string | null;
  status: string;
};

async function lockSource(tx: Tx, client: string, documentNumber: string, fiscalYear: number): Promise<SourceHeader | null> {
  const rows = await tx.execute(sql`
    select inventory_document_number, fiscal_year, plant, storage_location, status
      from physical_inventory_document
     where client = ${client}
       and inventory_document_number = ${documentNumber}
       and fiscal_year = ${fiscalYear}
     for update
  `) as unknown as SourceHeader[];
  return rows[0] ?? null;
}

async function loadSourceItems(tx: Tx, client: string, documentNumber: string, fiscalYear: number): Promise<SourceItem[]> {
  return await tx.execute(sql`
    select item_number, material_number, stock_type, count_status,
           counted_quantity::text, difference_quantity::text, book_quantity_snapshot::text, posting_status
      from physical_inventory_item
     where client = ${client}
       and inventory_document_number = ${documentNumber}
       and fiscal_year = ${fiscalYear}
     order by item_number
     for update
  `) as unknown as SourceItem[];
}

async function remainingPosted(tx: Tx, client: string, documentNumber: string, fiscalYear: number, itemNumber: number): Promise<number> {
  const rows = await tx.execute(sql`
    select coalesce(sum(abs(posted_difference) - reversed_quantity), 0)::text as remaining
      from physical_inventory_difference_allocation
     where client = ${client}
       and inventory_document_number = ${documentNumber}
       and fiscal_year = ${fiscalYear}
       and item_number = ${itemNumber}
  `) as unknown as Array<{ remaining: string }>;
  return Number(rows[0]?.remaining ?? 0);
}

async function activeLink(tx: Tx, client: string, documentNumber: string, fiscalYear: number, itemNumber: number) {
  const rows = await tx.execute(sql`
    select recount_document_number, recount_fiscal_year, status
      from physical_inventory_recount_link
     where client = ${client}
       and original_document_number = ${documentNumber}
       and original_fiscal_year = ${fiscalYear}
       and original_item_number = ${itemNumber}
       and status <> 'CANCELLED'
     limit 1
  `) as unknown as Array<{ recount_document_number: string; recount_fiscal_year: number; status: string }>;
  return rows[0] ?? null;
}

function linkSentence(itemNumber: number, link: { recount_document_number: string; recount_fiscal_year: number; status: string }): string {
  if (link.status === 'RESOLVED') {
    return `Item ${itemNumber} was recounted on ${link.recount_document_number}/${link.recount_fiscal_year}, and that recount is resolved. The original difference is not posted from here.`;
  }
  return `Item ${itemNumber} already has recount ${link.recount_document_number}/${link.recount_fiscal_year}. A second active recount is refused.`;
}

async function judgeItem(
  tx: Tx, client: string, header: SourceHeader, item: SourceItem | undefined, itemNumber: number,
): Promise<string | null> {
  if (!item) return `Item ${itemNumber} does not belong to document ${header.inventory_document_number}.`;
  if (header.status === 'CANCELLED') return `Physical inventory document ${header.inventory_document_number} is cancelled.`;
  if (item.count_status === 'UNCOUNTED' || item.counted_quantity === null) {
    return `Item ${itemNumber} has not been counted, and an uncounted item is counted, not recounted.`;
  }
  if (item.count_status !== 'COUNTED' && item.count_status !== 'RECOUNT_REQUIRED') {
    return `Item ${itemNumber} is ${item.count_status}, which cannot be recounted.`;
  }
  const link = await activeLink(tx, client, header.inventory_document_number, header.fiscal_year, itemNumber);
  if (link) return linkSentence(itemNumber, link);
  const remaining = await remainingPosted(tx, client, header.inventory_document_number, header.fiscal_year, itemNumber);
  if (remaining > 0.0005) {
    return `Item ${itemNumber} still has a posted difference of ${remaining.toFixed(3)}. Reverse that posting, then recount. This recount does not reverse.`;
  }
  return null;
}

async function booksNow(
  tx: Tx, client: string, plant: string, location: string | null, materialNumber: string, stockType: string,
): Promise<string> {
  const rows = await tx.execute(sql`
    select coalesce(sum(quantity), 0)::text as quantity
      from stock_quantity
     where client = ${client} and material_number = ${materialNumber} and plant = ${plant}
       and stock_type = ${stockType}
       and (${location}::text is null or storage_location = ${location})
  `) as unknown as Array<{ quantity: string }>;
  return Number(rows[0]?.quantity ?? 0).toFixed(3);
}

async function viewOf(tx: Tx, client: string, recountDocumentNumber: string, recountFiscalYear: number): Promise<RecountView> {
  const links = await tx.execute(sql`
    select original_document_number, original_fiscal_year, original_item_number,
           recount_document_number, recount_fiscal_year, recount_item_number,
           reason, header_text, planned_recount_date, status
      from physical_inventory_recount_link
     where client = ${client}
       and recount_document_number = ${recountDocumentNumber}
       and recount_fiscal_year = ${recountFiscalYear}
     order by original_item_number
  `) as unknown as Array<{
    original_document_number: string; original_fiscal_year: number; original_item_number: number;
    recount_document_number: string; recount_fiscal_year: number; recount_item_number: number;
    reason: string; header_text: string | null; planned_recount_date: string; status: string;
  }>;
  const first = links[0];
  if (!first) {
    throw new PhysicalInventoryRecountError(
      `Recount document ${recountDocumentNumber}/${recountFiscalYear} has no link.`,
      'Open the document the recount was raised from.',
    );
  }
  const items: RecountItemView[] = [];
  for (const link of links) {
    const source = await tx.execute(sql`
      select material_number, stock_type, counted_quantity::text, difference_quantity::text
        from physical_inventory_item
       where client = ${client}
         and inventory_document_number = ${link.original_document_number}
         and fiscal_year = ${link.original_fiscal_year}
         and item_number = ${link.original_item_number}
    `) as unknown as Array<{ material_number: string; stock_type: string; counted_quantity: string | null; difference_quantity: string | null }>;
    const recount = await tx.execute(sql`
      select book_quantity_snapshot::text as book
        from physical_inventory_item
       where client = ${client}
         and inventory_document_number = ${link.recount_document_number}
         and fiscal_year = ${link.recount_fiscal_year}
         and item_number = ${link.recount_item_number}
    `) as unknown as Array<{ book: string | null }>;
    items.push({
      sourceItemNumber: link.original_item_number,
      recountItemNumber: link.recount_item_number,
      materialNumber: source[0]?.material_number ?? '',
      stockType: source[0]?.stock_type ?? '',
      bookQuantity: recount[0]?.book ?? '',
      originalCountedQuantity: source[0]?.counted_quantity ?? '',
      originalDifference: source[0]?.difference_quantity ?? '',
    });
  }
  return {
    sourceDocumentNumber: first.original_document_number,
    sourceFiscalYear: first.original_fiscal_year,
    recountDocumentNumber: first.recount_document_number,
    recountFiscalYear: first.recount_fiscal_year,
    plannedRecountDate: first.planned_recount_date,
    reason: first.reason,
    headerText: first.header_text ?? '',
    status: first.status,
    items,
  };
}

/** The same judgement as creation, and no write. */
export async function validateRecount(input: Omit<CreateRecountInput, 'requestKey'> & { requestKey?: string }): Promise<RecountPreview> {
  const full = { ...input, requestKey: input.requestKey ?? 'validate' };
  const shaped = assertShape(full, false);
  return withTenant(input.client, async (tx) => {
    const header = await lockSource(tx, input.client, input.documentNumber.trim(), input.fiscalYear);
    if (!header) {
      throw new PhysicalInventoryRecountError(
        `Physical inventory document ${input.documentNumber} for fiscal year ${input.fiscalYear} does not exist.`,
        'Choose a document this tenant carries.',
      );
    }
    const items = await loadSourceItems(tx, input.client, header.inventory_document_number, header.fiscal_year);
    const failures: string[] = [];
    const chosen: SourceItem[] = [];
    for (const itemNumber of input.itemNumbers) {
      const item = items.find((row) => row.item_number === itemNumber);
      const reason = await judgeItem(tx, input.client, header, item, itemNumber);
      if (reason || !item) failures.push(reason ?? `Item ${itemNumber} does not belong to the document.`);
      else chosen.push(item);
    }
    if (failures.length > 0) {
      throw new PhysicalInventoryRecountError(failures.join(' '), 'Correct the selection. Nothing selected was skipped, and nothing was written.');
    }
    const previewItems = [];
    for (const item of chosen) {
      previewItems.push({
        itemNumber: item.item_number,
        materialNumber: item.material_number,
        stockType: item.stock_type,
        originalBookQuantity: item.book_quantity_snapshot ?? '',
        originalCountedQuantity: item.counted_quantity ?? '',
        originalDifference: item.difference_quantity ?? '',
        bookQuantityNow: await booksNow(tx, input.client, header.plant, header.storage_location, item.material_number, item.stock_type),
      });
    }
    return {
      sourceDocumentNumber: header.inventory_document_number,
      sourceFiscalYear: header.fiscal_year,
      plant: header.plant,
      storageLocation: header.storage_location,
      plannedRecountDate: shaped.date,
      reason: shaped.reason,
      headerText: shaped.header,
      items: previewItems,
    };
  });
}

export async function createRecount(input: CreateRecountInput): Promise<RecountView> {
  const shaped = assertShape(input, true);
  const documentNumber = input.documentNumber.trim();
  const expectedItems = [...input.itemNumbers].sort((a, b) => a - b);
  return withTenant(input.client, async (tx) => {
    const replay = await tx.execute(sql`
      select inventory_document_number, fiscal_year
        from physical_inventory_document
       where client = ${input.client} and request_key = ${input.requestKey}
       for update
    `) as unknown as Array<{ inventory_document_number: string; fiscal_year: number }>;
    if (replay[0]) {
      const stored = await tx.execute(sql`
        select original_document_number, original_fiscal_year, original_item_number,
               reason, header_text, planned_recount_date
          from physical_inventory_recount_link
         where client = ${input.client}
           and recount_document_number = ${replay[0].inventory_document_number}
           and recount_fiscal_year = ${replay[0].fiscal_year}
         order by original_item_number
      `) as unknown as Array<{
        original_document_number: string; original_fiscal_year: number; original_item_number: number;
        reason: string; header_text: string | null; planned_recount_date: string;
      }>;
      const same = stored.length > 0
        && stored.every((link) => link.original_document_number === documentNumber && link.original_fiscal_year === input.fiscalYear)
        && stored.map((link) => link.original_item_number).join(',') === expectedItems.join(',')
        && stored[0].planned_recount_date === shaped.date
        && stored[0].reason === shaped.reason
        && (stored[0].header_text ?? '') === shaped.header;
      if (same) return viewOf(tx, input.client, replay[0].inventory_document_number, replay[0].fiscal_year);
      throw new PhysicalInventoryRecountError(
        `Request key ${input.requestKey} already created ${replay[0].inventory_document_number}, and this is a different recount.`,
        'Use a new key for a different selection, date, or reason.',
      );
    }

    const header = await lockSource(tx, input.client, documentNumber, input.fiscalYear);
    if (!header) {
      throw new PhysicalInventoryRecountError(
        `Physical inventory document ${documentNumber} for fiscal year ${input.fiscalYear} does not exist.`,
        'Choose a document this tenant carries.',
      );
    }
    const items = await loadSourceItems(tx, input.client, header.inventory_document_number, header.fiscal_year);
    const failures: string[] = [];
    const chosen: SourceItem[] = [];
    for (const itemNumber of [...input.itemNumbers].sort((a, b) => a - b)) {
      const item = items.find((row) => row.item_number === itemNumber);
      const reason = await judgeItem(tx, input.client, header, item, itemNumber);
      if (reason || !item) failures.push(reason ?? `Item ${itemNumber} does not belong to the document.`);
      else chosen.push(item);
    }
    if (failures.length > 0) {
      throw new PhysicalInventoryRecountError(failures.join(' '), 'Correct the selection. Nothing selected was skipped, and nothing was written.');
    }

    const anyPosted = await tx.execute(sql`
      select 1 from physical_inventory_difference_allocation
       where client = ${input.client}
         and inventory_document_number = ${header.inventory_document_number}
         and fiscal_year = ${header.fiscal_year}
         and abs(posted_difference) - reversed_quantity > 0
       limit 1
    `) as unknown as unknown[];

    const created = await writeInventoryDocument(tx, {
      client: input.client,
      createdBy: input.changedBy,
      plant: header.plant,
      storageLocation: header.storage_location,
      plannedCountDate: shaped.date,
      postingBlock: false,
      requestKey: input.requestKey,
      materials: [...new Set(chosen.map((item) => item.material_number))],
      lines: chosen.map((item) => ({ materialNumber: item.material_number, stockType: item.stock_type })),
    });

    for (let index = 0; index < chosen.length; index += 1) {
      const source = chosen[index];
      await tx.insert(physicalInventoryRecountLink).values({
        client: input.client,
        originalDocumentNumber: header.inventory_document_number,
        originalFiscalYear: header.fiscal_year,
        originalItemNumber: source.item_number,
        recountDocumentNumber: created.inventoryDocumentNumber,
        recountFiscalYear: created.fiscalYear,
        recountItemNumber: (index + 1) * 10,
        reason: shaped.reason,
        headerText: shaped.header || null,
        plannedRecountDate: shaped.date,
        status: 'SCHEDULED',
        createdBy: input.changedBy,
      });
      await tx.update(physicalInventoryItem).set({
        countStatus: 'RECOUNT_REQUIRED',
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(physicalInventoryItem.client, input.client),
        eq(physicalInventoryItem.inventoryDocumentNumber, header.inventory_document_number),
        eq(physicalInventoryItem.fiscalYear, header.fiscal_year),
        eq(physicalInventoryItem.itemNumber, source.item_number),
      ));
      await recordChange(tx, {
        client: input.client,
        objectClass: 'physical_inventory_item',
        objectKey: `${header.inventory_document_number}/${header.fiscal_year}/${source.item_number}`,
        changeType: 'CHANGE',
        changedBy: input.changedBy,
        transactionCode: PHYSICAL_INVENTORY_RECOUNT_CAPABILITY,
        reason: shaped.reason,
        correlationId: input.requestKey,
        before: { countStatus: source.count_status },
        after: {
          countStatus: 'RECOUNT_REQUIRED',
          recountDocument: created.inventoryDocumentNumber,
          recountFiscalYear: created.fiscalYear,
        },
      });
    }

    if (anyPosted.length > 0) {
      const { recomputePostingStatus } = await import('./physical-inventory-posting-status');
      await recomputePostingStatus(tx, input.client, header.inventory_document_number, header.fiscal_year, input.changedBy);
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: 'physical_inventory_document',
      objectKey: `${created.inventoryDocumentNumber}/${created.fiscalYear}`,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: PHYSICAL_INVENTORY_RECOUNT_CAPABILITY,
      reason: shaped.reason,
      correlationId: input.requestKey,
      after: {
        sourceDocument: header.inventory_document_number,
        sourceFiscalYear: header.fiscal_year,
        items: chosen.map((item) => item.item_number),
        plannedRecountDate: shaped.date,
      },
    });
    return viewOf(tx, input.client, created.inventoryDocumentNumber, created.fiscalYear);
  });
}

export async function cancelRecount(input: {
  client: string;
  changedBy: string;
  recountDocumentNumber: string;
  recountFiscalYear: number;
  reason: string;
}): Promise<RecountView> {
  const reason = boundText(input.reason, 'The cancellation reason', true);
  return withTenant(input.client, async (tx) => {
    const header = await tx.execute(sql`
      select status from physical_inventory_document
       where client = ${input.client}
         and inventory_document_number = ${input.recountDocumentNumber}
         and fiscal_year = ${input.recountFiscalYear}
       for update
    `) as unknown as Array<{ status: string }>;
    if (!header[0]) {
      throw new PhysicalInventoryRecountError(
        `Recount document ${input.recountDocumentNumber}/${input.recountFiscalYear} does not exist.`,
        'Choose the recount document, not the original.',
      );
    }
    const posted = await tx.execute(sql`
      select 1 from physical_inventory_difference_allocation
       where client = ${input.client}
         and inventory_document_number = ${input.recountDocumentNumber}
         and fiscal_year = ${input.recountFiscalYear}
       limit 1
    `) as unknown as unknown[];
    if (posted.length > 0) {
      throw new PhysicalInventoryRecountError(
        `Recount document ${input.recountDocumentNumber} has a material document, and a posted recount is not cancelled here.`,
        'Reverse that posting through the reversal. This cancellation does not reverse and does not delete.',
      );
    }
    const links = await tx.execute(sql`
      select original_document_number, original_fiscal_year, original_item_number, status
        from physical_inventory_recount_link
       where client = ${input.client}
         and recount_document_number = ${input.recountDocumentNumber}
         and recount_fiscal_year = ${input.recountFiscalYear}
       for update
    `) as unknown as Array<{
      original_document_number: string; original_fiscal_year: number; original_item_number: number; status: string;
    }>;
    if (links.length === 0) {
      throw new PhysicalInventoryRecountError(
        `Document ${input.recountDocumentNumber} is not a recount.`,
        'Cancel an ordinary count document through its own cancellation.',
      );
    }
    if (links.every((link) => link.status === 'CANCELLED')) {
      throw new PhysicalInventoryRecountError(
        `Recount document ${input.recountDocumentNumber} is already cancelled.`,
        'The link is kept. Raise a new recount if the count must be done again.',
      );
    }
    await tx.execute(sql`
      update physical_inventory_recount_link
         set status = 'CANCELLED', changed_by = ${input.changedBy}, changed_at = now()
       where client = ${input.client}
         and recount_document_number = ${input.recountDocumentNumber}
         and recount_fiscal_year = ${input.recountFiscalYear}
         and status <> 'CANCELLED'
    `);
    if (header[0].status === 'CREATED') {
      await tx.update(physicalInventoryDocument).set({
        status: 'CANCELLED',
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(physicalInventoryDocument.client, input.client),
        eq(physicalInventoryDocument.inventoryDocumentNumber, input.recountDocumentNumber),
        eq(physicalInventoryDocument.fiscalYear, input.recountFiscalYear),
      ));
    }
    for (const link of links) {
      const still = await activeLink(
        tx, input.client, link.original_document_number, link.original_fiscal_year, link.original_item_number,
      );
      if (still) continue;
      await tx.update(physicalInventoryItem).set({
        countStatus: 'COUNTED',
        changedBy: input.changedBy,
        changedAt: new Date(),
      }).where(and(
        eq(physicalInventoryItem.client, input.client),
        eq(physicalInventoryItem.inventoryDocumentNumber, link.original_document_number),
        eq(physicalInventoryItem.fiscalYear, link.original_fiscal_year),
        eq(physicalInventoryItem.itemNumber, link.original_item_number),
        eq(physicalInventoryItem.countStatus, 'RECOUNT_REQUIRED'),
      ));
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'physical_inventory_document',
      objectKey: `${input.recountDocumentNumber}/${input.recountFiscalYear}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: PHYSICAL_INVENTORY_RECOUNT_CAPABILITY,
      reason,
      after: { status: 'CANCELLED', documentLeft: header[0].status === 'CREATED' ? 'CANCELLED' : header[0].status },
    });
    return viewOf(tx, input.client, input.recountDocumentNumber, input.recountFiscalYear);
  });
}

/** The posting and the count read this. A drifted item status does not outrank the link. */
export async function recountPostingBlock(
  tx: Tx, client: string, documentNumber: string, fiscalYear: number, itemNumber: number,
): Promise<string | null> {
  const link = await activeLink(tx, client, documentNumber, fiscalYear, itemNumber);
  if (!link) return null;
  if (link.status === 'RESOLVED') {
    return `Item ${itemNumber} was recounted on ${link.recount_document_number}/${link.recount_fiscal_year}, and that recount is resolved. Posting the original would be a second adjustment.`;
  }
  return `Item ${itemNumber} has an unresolved recount ${link.recount_document_number}/${link.recount_fiscal_year}. Post that document, or cancel the recount. This posting does not post the original.`;
}

export async function recountCountRemedy(
  tx: Tx, client: string, documentNumber: string, fiscalYear: number, itemNumber: number,
): Promise<string> {
  const link = await activeLink(tx, client, documentNumber, fiscalYear, itemNumber);
  if (!link) {
    return 'The count is entered on the recount document. Clearing the requirement is not how a recount is entered.';
  }
  return `Enter the count on recount document ${link.recount_document_number}/${link.recount_fiscal_year}. Clearing the requirement is not how a recount is entered.`;
}

/**
 * Called in the same transaction as a count save or a difference posting. A zero on every
 * recount item, or a posted nonzero difference, resolves the link. The original item stays
 * ineligible either way.
 */
export async function syncRecountLink(
  tx: Tx, client: string, recountDocumentNumber: string, fiscalYear: number, changedBy: string,
): Promise<void> {
  const links = await tx.execute(sql`
    select status from physical_inventory_recount_link
     where client = ${client}
       and recount_document_number = ${recountDocumentNumber}
       and recount_fiscal_year = ${fiscalYear}
       and status in ('SCHEDULED', 'COUNTED')
  `) as unknown as Array<{ status: string }>;
  if (links.length === 0) return;
  const items = await tx.execute(sql`
    select i.count_status, i.difference_quantity::text as difference,
           coalesce(sum(abs(a.posted_difference) - a.reversed_quantity), 0)::text as remaining
      from physical_inventory_item i
      left join physical_inventory_difference_allocation a
        on a.client = i.client
       and a.inventory_document_number = i.inventory_document_number
       and a.fiscal_year = i.fiscal_year
       and a.item_number = i.item_number
     where i.client = ${client}
       and i.inventory_document_number = ${recountDocumentNumber}
       and i.fiscal_year = ${fiscalYear}
     group by i.item_number, i.count_status, i.difference_quantity
  `) as unknown as Array<{ count_status: string; difference: string | null; remaining: string }>;
  const anyCounted = items.some((item) => item.count_status === 'COUNTED');
  const allCounted = items.length > 0 && items.every((item) => item.count_status === 'COUNTED');
  const resolved = allCounted && items.every((item) => {
    const difference = item.difference === null ? null : Math.abs(Number(item.difference));
    if (difference === null || difference <= 0.0005) return difference !== null;
    return Number(item.remaining) + 0.0005 >= difference;
  });
  const next = resolved ? 'RESOLVED' : anyCounted ? 'COUNTED' : null;
  if (!next) return;
  await tx.execute(sql`
    update physical_inventory_recount_link
       set status = ${next}, changed_by = ${changedBy}, changed_at = now()
     where client = ${client}
       and recount_document_number = ${recountDocumentNumber}
       and recount_fiscal_year = ${fiscalYear}
       and status in ('SCHEDULED', 'COUNTED')
       and status <> ${next}
  `);
}

function shown(value: string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '';
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(3) : value;
}

export interface RecountSourceItem {
  itemNumber: number;
  materialNumber: string;
  stockType: string;
  countStatus: string;
  bookQuantity: string;
  countedQuantity: string;
  difference: string;
  bookQuantityNow: string;
  eligible: boolean;
  reason: string | null;
  recountDocumentNumber: string | null;
  recountFiscalYear: number | null;
}

export interface RecountSourceView {
  documentNumber: string;
  fiscalYear: number;
  plant: string;
  storageLocation: string | null;
  status: string;
  plannedCountDate: string;
  items: RecountSourceItem[];
}

/** The document a person is about to recount. A read. It writes nothing. */
export async function getRecountSource(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<RecountSourceView | null> {
  return withTenant(client, async (tx) => {
    const headers = await tx.execute(sql`
      select inventory_document_number, fiscal_year, plant, storage_location, status, planned_count_date
        from physical_inventory_document
       where client = ${client}
         and inventory_document_number = ${keys.documentNumber}
         and fiscal_year = ${keys.fiscalYear}
    `) as unknown as Array<SourceHeader & { planned_count_date: string }>;
    const header = headers[0];
    if (!header) return null;
    const items = await tx.execute(sql`
      select item_number, material_number, stock_type, count_status,
             counted_quantity::text, difference_quantity::text, book_quantity_snapshot::text, posting_status
        from physical_inventory_item
       where client = ${client}
         and inventory_document_number = ${header.inventory_document_number}
         and fiscal_year = ${header.fiscal_year}
       order by item_number
    `) as unknown as SourceItem[];
    const view: RecountSourceItem[] = [];
    for (const item of items) {
      const reason = await judgeItem(tx, client, header, item, item.item_number);
      const link = await activeLink(tx, client, header.inventory_document_number, header.fiscal_year, item.item_number);
      view.push({
        itemNumber: item.item_number,
        materialNumber: item.material_number,
        stockType: item.stock_type,
        countStatus: item.count_status,
        bookQuantity: shown(item.book_quantity_snapshot),
        countedQuantity: shown(item.counted_quantity),
        difference: shown(item.difference_quantity),
        bookQuantityNow: await booksNow(tx, client, header.plant, header.storage_location, item.material_number, item.stock_type),
        eligible: reason === null,
        reason,
        recountDocumentNumber: link?.recount_document_number ?? null,
        recountFiscalYear: link?.recount_fiscal_year ?? null,
      });
    }
    return {
      documentNumber: header.inventory_document_number,
      fiscalYear: header.fiscal_year,
      plant: header.plant,
      storageLocation: header.storage_location,
      status: header.status,
      plannedCountDate: header.planned_count_date,
      items: view,
    };
  });
}

export interface RecountComparisonItem {
  originalItemNumber: number;
  recountItemNumber: number;
  materialNumber: string;
  stockType: string;
  originalBook: string;
  originalCounted: string;
  originalDifference: string;
  originalCounter: string;
  originalCountDate: string;
  recountBook: string;
  recountCounted: string;
  recountDifference: string;
  recountCounter: string;
  recountCountDate: string;
  materialDocumentNumber: string;
  status: string;
  reason: string;
}

export interface RecountComparison {
  originalDocumentNumber: string;
  originalFiscalYear: number;
  recountDocumentNumber: string;
  recountFiscalYear: number;
  plannedRecountDate: string;
  status: string;
  reason: string;
  headerText: string;
  items: RecountComparisonItem[];
}

/**
 * Both documents, side by side. The quantities are not added. A missing recount count stays
 * blank; it is not treated as zero and it is not folded into the original.
 */
export async function getRecountComparison(
  client: string,
  keys: { documentNumber: string; fiscalYear: number },
): Promise<RecountComparison[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select l.original_document_number, l.original_fiscal_year, l.original_item_number,
             l.recount_document_number, l.recount_fiscal_year, l.recount_item_number,
             l.reason, l.header_text, l.planned_recount_date, l.status,
             oi.material_number, oi.stock_type,
             oi.book_quantity_snapshot::text as original_book,
             oi.counted_quantity::text as original_counted,
             oi.difference_quantity::text as original_difference,
             oi.counter_name as original_counter,
             oi.count_date as original_count_date,
             ri.book_quantity_snapshot::text as recount_book,
             ri.counted_quantity::text as recount_counted,
             ri.difference_quantity::text as recount_difference,
             ri.counter_name as recount_counter,
             ri.count_date as recount_count_date,
             a.material_document_number
        from physical_inventory_recount_link l
        join physical_inventory_item oi
          on oi.client = l.client
         and oi.inventory_document_number = l.original_document_number
         and oi.fiscal_year = l.original_fiscal_year
         and oi.item_number = l.original_item_number
        join physical_inventory_item ri
          on ri.client = l.client
         and ri.inventory_document_number = l.recount_document_number
         and ri.fiscal_year = l.recount_fiscal_year
         and ri.item_number = l.recount_item_number
        left join physical_inventory_difference_allocation a
          on a.client = l.client
         and a.inventory_document_number = l.recount_document_number
         and a.fiscal_year = l.recount_fiscal_year
         and a.item_number = l.recount_item_number
       where l.client = ${client}
         and (
           (l.original_document_number = ${keys.documentNumber} and l.original_fiscal_year = ${keys.fiscalYear})
           or (l.recount_document_number = ${keys.documentNumber} and l.recount_fiscal_year = ${keys.fiscalYear})
         )
       order by l.recount_document_number, l.original_item_number, a.material_document_number
    `) as unknown as Array<{
      original_document_number: string; original_fiscal_year: number; original_item_number: number;
      recount_document_number: string; recount_fiscal_year: number; recount_item_number: number;
      reason: string; header_text: string | null; planned_recount_date: string; status: string;
      material_number: string; stock_type: string;
      original_book: string | null; original_counted: string | null; original_difference: string | null;
      original_counter: string | null; original_count_date: string | null;
      recount_book: string | null; recount_counted: string | null; recount_difference: string | null;
      recount_counter: string | null; recount_count_date: string | null;
      material_document_number: string | null;
    }>;
    const groups = new Map<string, RecountComparison>();
    for (const row of rows) {
      const key = `${row.recount_document_number}/${row.recount_fiscal_year}`;
      let group = groups.get(key);
      if (!group) {
        group = {
          originalDocumentNumber: row.original_document_number,
          originalFiscalYear: row.original_fiscal_year,
          recountDocumentNumber: row.recount_document_number,
          recountFiscalYear: row.recount_fiscal_year,
          plannedRecountDate: row.planned_recount_date,
          status: row.status,
          reason: row.reason,
          headerText: row.header_text ?? '',
          items: [],
        };
        groups.set(key, group);
      }
      let item = group.items.find((entry) => entry.recountItemNumber === row.recount_item_number);
      if (!item) {
        item = {
          originalItemNumber: row.original_item_number,
          recountItemNumber: row.recount_item_number,
          materialNumber: row.material_number,
          stockType: row.stock_type,
          originalBook: shown(row.original_book),
          originalCounted: shown(row.original_counted),
          originalDifference: shown(row.original_difference),
          originalCounter: row.original_counter ?? '',
          originalCountDate: row.original_count_date ?? '',
          recountBook: shown(row.recount_book),
          recountCounted: shown(row.recount_counted),
          recountDifference: shown(row.recount_difference),
          recountCounter: row.recount_counter ?? '',
          recountCountDate: row.recount_count_date ?? '',
          materialDocumentNumber: '',
          status: row.status,
          reason: row.reason,
        };
        group.items.push(item);
      }
      if (row.material_document_number && !item.materialDocumentNumber.split(', ').includes(row.material_document_number)) {
        item.materialDocumentNumber = item.materialDocumentNumber
          ? `${item.materialDocumentNumber}, ${row.material_document_number}`
          : row.material_document_number;
      }
    }
    return [...groups.values()];
  });
}
