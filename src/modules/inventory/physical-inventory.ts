/**
 * Physical inventory documents — SCR-142 / MI01 (INV.PHYINV.CREATE).
 *
 * A count document is the one inventory object that is **not** a posting: it names what is to
 * be counted, where, and when, and changes nothing in the ledger. That is why it earns two
 * tables where the goods issue, the production order and the production receipt each lost
 * theirs — the ledger holds what moved, and it cannot hold what has not moved yet.
 *
 * The posting block is the part that has to be real. A flag written and never read would be a
 * control that does not control, so `assertInventoryCountOpen` runs inside every service that
 * moves stock and refuses with the blocking document's number.
 */
import { and, desc, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { materialPeriodAllows } from './material-period-control';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { plant as plantTable } from '../foundation/schema';
import { resolveStorageLocation, StorageLocationError } from './storage-location';
import { material } from './schema';
import {
  physicalInventoryDocument, physicalInventoryItem,
} from './schema';

export const PHYSICAL_INVENTORY_CREATE_CAPABILITY = 'INV.PHYINV.CREATE';
export const PHYSICAL_INVENTORY_CANCEL_CAPABILITY = 'INV.PHYINV.CANCEL';
export const PHYSICAL_INVENTORY_ROUTE = '/inventory/physical-inventory';
/** SAP's names as search aliases only — never stored, never a code. */
export const PHYSICAL_INVENTORY_ALIASES = ['MI01', 'MI02'] as const;
const NUMBER_OBJECT = 'PHYINV';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export class PhysicalInventoryError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'PhysicalInventoryError';
    this.remedy = remedy;
  }
}

export interface CreatePhysicalInventoryInput {
  client: string;
  createdBy: string;
  plant: string;
  /** Absent means the whole plant is counted. */
  storageLocation?: string;
  plannedCountDate: string;
  /** Refuse every stock movement for these materials here while the count is open. */
  postingBlock?: boolean;
  materials: string[];
  /** Parallel to materials. Blank counts the blank batch. A named batch must already stand. */
  batches?: string[];
  requestKey?: string;
}

export interface PhysicalInventoryItemView {
  itemNumber: number;
  materialNumber: string;
  description: string;
  stockQuantity: string;
  unit: string;
  /** SCR-147: the stock identity this item counts, and where its count has got to. */
  stockType: string;
  /** Blank when the material is not batch-managed. */
  batch: string;
  countStatus: string;
  countedQuantity: string | null;
}

export interface PhysicalInventoryView {
  inventoryDocumentNumber: string;
  fiscalYear: number;
  companyCode: string;
  plant: string;
  storageLocation: string | null;
  plannedCountDate: string;
  postingBlock: boolean;
  status: string;
  version: number;
  items: PhysicalInventoryItemView[];
}

function requireDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new PhysicalInventoryError(
      `${label} ${value || '(empty)'} is not a date.`,
      'Enter the date as YYYY-MM-DD.',
    );
  }
  return trimmed;
}

/**
 * SCR-147: the stock a count will cover, per stock type.
 *
 * `stockAt` below measures only UNRESTRICTED, which was right while an item was one material row.
 * A count that produces a difference MI07 must post needs the identity the difference belongs to,
 * so a document now carries one item per stock type that actually holds stock.
 */
async function stockByType(
  tx: Tx, client: string, plant: string, location: string | null, materialNumber: string, batch = '',
) {
  const rows = await tx.execute(sql`
    select s.stock_type, sum(s.quantity)::text as quantity, min(m.base_unit) as unit
      from stock_quantity s
      join material m on m.client = s.client and m.material_number = s.material_number
     where s.client = ${client} and s.material_number = ${materialNumber}
       and s.plant = ${plant} and s.batch_number = ${batch}
       and (${location}::text is null or s.storage_location = ${location}::text)
     group by s.stock_type
     order by s.stock_type
  `) as unknown as Array<{ stock_type: string; quantity: string; unit: string }>;
  return rows.map((r) => ({ stockType: r.stock_type, quantity: Number(r.quantity), unit: r.unit ?? '' }));
}

/** The stock the count will be measured against — read for the screen, never written. */
async function stockAt(
  tx: Tx, client: string, plant: string, location: string | null, materialNumber: string,
) {
  const rows = await tx.execute(sql`
    select coalesce(sum(quantity), 0)::text as quantity, coalesce(min(unit), '') as unit
      from (
        select s.quantity, m.base_unit as unit
          from stock_quantity s
          join material m on m.client = s.client and m.material_number = s.material_number
         where s.client = ${client} and s.material_number = ${materialNumber}
           and s.plant = ${plant} and s.stock_type = 'UNRESTRICTED' and s.batch_number = ${''}
           and (${location}::text is null or s.storage_location = ${location}::text)
      ) t
  `) as unknown as Array<{ quantity: string; unit: string }>;
  return { quantity: Number(rows[0]?.quantity ?? 0), unit: rows[0]?.unit ?? '' };
}

async function toView(tx: Tx, client: string, header: {
  inventoryDocumentNumber: string; fiscalYear: number; plant: string;
  storageLocation: string | null; plannedCountDate: string; postingBlock: boolean; status: string;
}): Promise<PhysicalInventoryView> {
  const items = await tx.select().from(physicalInventoryItem).where(and(
    eq(physicalInventoryItem.client, client),
    eq(physicalInventoryItem.inventoryDocumentNumber, header.inventoryDocumentNumber),
    eq(physicalInventoryItem.fiscalYear, header.fiscalYear),
  )).orderBy(physicalInventoryItem.itemNumber);

  const [plantRow] = await tx.select({ companyCode: plantTable.companyCode }).from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, header.plant),
  ));

  const described: PhysicalInventoryItemView[] = [];
  for (const item of items) {
    const [master] = await tx.select({ description: material.description, unit: material.baseUnit })
      .from(material).where(and(
        eq(material.client, client), eq(material.materialNumber, item.materialNumber),
      ));
    // The book quantity is the one frozen at creation when the document carries one — the count
    // answers for that quantity, not for whatever the stock has drifted to since.
    const held = await stockByType(tx, client, header.plant, header.storageLocation, item.materialNumber, item.batchNumber);
    const live = held.find((h) => h.stockType === item.stockType);
    const book = item.bookQuantitySnapshot !== null
      ? Number(item.bookQuantitySnapshot)
      : live?.quantity ?? 0;
    described.push({
      itemNumber: item.itemNumber,
      materialNumber: item.materialNumber,
      description: master?.description ?? '',
      stockQuantity: book.toFixed(3),
      unit: item.bookQuantityUnit || live?.unit || master?.unit || '',
      stockType: item.stockType,
      batch: item.batchNumber,
      countStatus: item.countStatus,
      countedQuantity: item.countedQuantity,
    });
  }

  return {
    inventoryDocumentNumber: header.inventoryDocumentNumber,
    fiscalYear: header.fiscalYear,
    companyCode: plantRow?.companyCode ?? '',
    plant: header.plant,
    storageLocation: header.storageLocation,
    plannedCountDate: header.plannedCountDate,
    postingBlock: header.postingBlock,
    status: header.status,
    version: header.version,
    items: described,
  };
}

/**
 * Create a count document. One transaction: the header, its items and the number commit
 * together or not at all, and the number rolls back with them because it is drawn inside it.
 *
 * Nothing is written to the ledger, and nothing about stock changes. A test asserts both.
 */

/**
 * The document writer both creation and recount share.
 *
 * Call it inside the caller's transaction. It does not open one, and it does not replay a
 * request key: creation's replay returns a document without comparing a fingerprint, and a
 * recount must not inherit that hole. When `lines` is set, those stock identities are the
 * items. When it is absent, every stock type the material holds is seeded, which is creation's
 * rule and not a recount's.
 */
export async function writeInventoryDocument(
  tx: Tx,
  spec: {
    client: string;
    createdBy: string;
    plant: string;
    storageLocation: string | null;
    plannedCountDate: string;
    postingBlock: boolean;
    requestKey: string | null;
    materials: string[];
    /** Parallel to materials, used only when lines are absent. */
    batches?: string[];
    lines?: Array<{ materialNumber: string; stockType: string; batch?: string }>;
  },
): Promise<{
  inventoryDocumentNumber: string; fiscalYear: number; plant: string;
  storageLocation: string | null; plannedCountDate: string; postingBlock: boolean; status: string;
}> {
  const plant = spec.plant;
  const location = spec.storageLocation ?? '';
  const plannedCountDate = spec.plannedCountDate;
  const materials = spec.materials;

  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${spec.client}/physical-inventory`}, 0))`);
  await lockStockScope(tx, spec.client, materials, 'EXCLUSIVE');

  const [plantRow] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, spec.client), eq(plantTable.plant, plant),
  ));
  if (!plantRow) {
    throw new PhysicalInventoryError(
      `Plant ${plant} does not exist.`,
      'Count a plant the tenant carries (CFG.PLT.DEFINE).',
    );
  }
  if (plantRow.companyCode === null) {
    throw new PhysicalInventoryError(
      `Plant ${plant} carries no company code.`,
      'Assign the plant to a company code, then create the count.',
    );
  }
  if (!plantRow.isStorageSite) {
    throw new PhysicalInventoryError(
      `Plant ${plant} is not a storage site.`,
      'Count a plant that carries storage locations.',
    );
  }
  if (location) {
    try {
      await resolveStorageLocation(tx, {
        client: spec.client,
        plant,
        typed: location,
        required: true,
        applyPlantDefault: false,
        verb: 'Count',
      });
    } catch (caught) {
      if (caught instanceof StorageLocationError) {
        throw new PhysicalInventoryError(
          caught.message,
          'Choose a storage location of the plant being counted, or count the whole plant.',
        );
      }
      throw caught;
    }
  }

  for (const materialNumber of materials) {
    const [master] = await tx.select().from(material).where(and(
      eq(material.client, spec.client), eq(material.materialNumber, materialNumber),
    ));
    if (!master) {
      throw new PhysicalInventoryError(
        `Material ${materialNumber} does not exist.`,
        'Count materials the tenant carries (MM01).',
      );
    }
    if (master.markedForDeletion) {
      throw new PhysicalInventoryError(
        `Material ${materialNumber} is flagged for deletion.`,
        'Cancel the deletion flag, then create the count.',
      );
    }
    const [extension] = await tx.execute(sql`
      select marked_for_deletion from material_plant
       where client = ${spec.client} and material_number = ${materialNumber} and plant = ${plant}
    `) as unknown as Array<{ marked_for_deletion: boolean }>;
    if (!extension) {
      throw new PhysicalInventoryError(
        `Material ${materialNumber} is not extended to plant ${plant}.`,
        'Extend the material to the plant, then create the count.',
      );
    }
    if (extension.marked_for_deletion) {
      throw new PhysicalInventoryError(
        `Material ${materialNumber} is flagged for deletion in plant ${plant}.`,
        'Cancel the plant deletion flag, then create the count.',
      );
    }
  }

  const company = await getCompanyCode(tx, spec.client, plantRow.companyCode);
  if (!company?.fiscalYearVariant) {
    throw new PhysicalInventoryError(`Company code ${plantRow.companyCode} is not configured.`);
  }
  const position = await derivePosition(tx, spec.client, company.fiscalYearVariant, plannedCountDate);
  const mmRecord = await getMaterialPeriodControlInTx(tx, spec.client, plantRow.companyCode);
  if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
    throw new PhysicalInventoryError(
      `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${plantRow.companyCode}.`,
      'Plan the count in an open period, or shift the material period first.',
    );
  }

  if (spec.lines) {
    for (const line of spec.lines) await countBatch(tx, spec.client, line.materialNumber, plant, line.batch ?? '');
  } else {
    for (const [index, materialNumber] of materials.entries()) {
      await countBatch(tx, spec.client, materialNumber, plant, spec.batches?.[index] ?? '');
    }
  }

  const drawn = await allocateNumber(tx, {
    client: spec.client,
    objectCode: NUMBER_OBJECT,
    fiscalYear: position.fiscalYear,
    allocatedBy: spec.createdBy,
  });
  const inventoryDocumentNumber = drawn.display;
  const [header] = await tx.insert(physicalInventoryDocument).values({
    client: spec.client,
    inventoryDocumentNumber,
    fiscalYear: position.fiscalYear,
    plant,
    storageLocation: location || null,
    plannedCountDate,
    postingBlock: spec.postingBlock,
    status: 'CREATED',
    requestKey: spec.requestKey,
    createdBy: spec.createdBy,
  }).returning();

  const itemRows: Array<typeof physicalInventoryItem.$inferInsert> = [];
  if (spec.lines) {
    for (const line of spec.lines) {
      const batch = await countBatch(tx, spec.client, line.materialNumber, plant, line.batch ?? '');
      const held = await stockOfType(tx, spec.client, plant, location || null, line.materialNumber, line.stockType, batch);
      itemRows.push({
        client: spec.client,
        inventoryDocumentNumber,
        fiscalYear: position.fiscalYear,
        itemNumber: (itemRows.length + 1) * 10,
        materialNumber: line.materialNumber,
        stockType: line.stockType,
        batchNumber: batch,
        bookQuantitySnapshot: held.quantity.toFixed(3),
        bookQuantityUnit: held.unit || null,
        bookQuantityBasis: 'DOCUMENT_CREATION',
        createdBy: spec.createdBy,
      });
    }
  } else {
    for (const [index, materialNumber] of materials.entries()) {
      const batch = await countBatch(tx, spec.client, materialNumber, plant, spec.batches?.[index] ?? '');
      const held = await stockByType(tx, spec.client, plant, location || null, materialNumber, batch);
      const [_master] = await tx.select({ unit: material.baseUnit }).from(material).where(and(
        eq(material.client, spec.client), eq(material.materialNumber, materialNumber),
      ));
      const types = held.length > 0 ? held : [{ stockType: 'UNRESTRICTED', quantity: 0, unit: _master?.unit ?? '' }];
      for (const type of types) {
        itemRows.push({
          client: spec.client,
          inventoryDocumentNumber,
          fiscalYear: position.fiscalYear,
          itemNumber: (itemRows.length + 1) * 10,
          materialNumber,
          stockType: type.stockType,
          batchNumber: batch,
          bookQuantitySnapshot: String(type.quantity),
          bookQuantityUnit: type.unit || _master?.unit || null,
          bookQuantityBasis: 'DOCUMENT_CREATION',
          createdBy: spec.createdBy,
        });
      }
    }
  }
  await tx.insert(physicalInventoryItem).values(itemRows);
  await recordChange(tx, {
    client: spec.client,
    objectClass: 'physical_inventory_document',
    objectKey: `${inventoryDocumentNumber}/${position.fiscalYear}`,
    changeType: 'CREATE',
    changedBy: spec.createdBy,
    after: {
      plant, storageLocation: location || null, plannedCountDate,
      postingBlock: spec.postingBlock, materials,
    },
  });
  return header;
}

async function stockOfType(
  tx: Tx, client: string, plant: string, location: string | null, materialNumber: string, stockType: string, batch = '',
) {
  const rows = await tx.execute(sql`
    select coalesce(sum(s.quantity), 0)::text as quantity, min(m.base_unit) as unit
      from material m
      left join stock_quantity s
        on s.client = m.client and s.material_number = m.material_number
       and s.plant = ${plant} and s.stock_type = ${stockType} and s.batch_number = ${batch}
       and (${location}::text is null or s.storage_location = ${location})
     where m.client = ${client} and m.material_number = ${materialNumber}
     group by m.material_number
  `) as unknown as Array<{ quantity: string; unit: string | null }>;
  return { quantity: Number(rows[0]?.quantity ?? 0), unit: rows[0]?.unit ?? '' };
}

/** A batch the count may name. It must already stand. Restricted and expired stock can still be counted. */
async function countBatch(
  tx: Tx, client: string, materialNumber: string, plant: string, batch: string,
): Promise<string> {
  const typed = batch.trim().toUpperCase();
  const levelRows = await tx.execute(sql`
    select batch_level from batch_level_configuration where client = ${client} limit 1
  `) as unknown as Array<{ batch_level: string }>;
  const level = levelRows[0]?.batch_level?.trim();
  const code = level === '0' || level === '1' || level === '2' ? level : null;
  let managed = false;
  if (code === '0') {
    const plants = await tx.execute(sql`
      select batch_managed from material_plant
       where client = ${client} and material_number = ${materialNumber} and plant = ${plant}
       limit 1
    `) as unknown as Array<{ batch_managed: boolean }>;
    managed = Boolean(plants[0]?.batch_managed);
  } else if (code) {
    const materials = await tx.execute(sql`
      select batch_managed from material
       where client = ${client} and material_number = ${materialNumber}
       limit 1
    `) as unknown as Array<{ batch_managed: boolean }>;
    managed = Boolean(materials[0]?.batch_managed);
  }
  if (!managed) {
    if (typed) {
      throw new PhysicalInventoryError(
        `Material ${materialNumber} is not batch-managed. No count was created.`,
        'Leave the batch empty.',
      );
    }
    return '';
  }
  if (!typed) {
    throw new PhysicalInventoryError(
      `Material ${materialNumber} is batch-managed. A batch is required. No count was created.`,
      'Create the batch in MSC1N, then name that number. This count does not create a batch.',
    );
  }
  const rows = await tx.execute(sql`
    select batch_number from batch
     where client = ${client}
       and material_number = ${materialNumber}
       and batch_number = ${typed}
       and batch_level_at_creation = ${code}
       and ((${code} = '0' and plant = ${plant}) or (${code} <> '0' and plant is null))
     limit 1
  `) as unknown as Array<{ batch_number: string }>;
  if (!rows[0]) {
    throw new PhysicalInventoryError(
      `Batch ${typed} does not stand for material ${materialNumber}. No count was created.`,
      'Create the batch in MSC1N first. This count does not create a batch.',
    );
  }
  return rows[0].batch_number;
}

export async function createPhysicalInventory(
  input: CreatePhysicalInventoryInput,
): Promise<PhysicalInventoryView> {
  const plant = input.plant.trim();
  const location = (input.storageLocation ?? '').trim();
  if (!plant) {
    throw new PhysicalInventoryError('A plant is required.', 'Enter the plant being counted.');
  }
  const plannedCountDate = requireDate(input.plannedCountDate, 'The planned count date');

  const seen = new Set<string>();
  const materials: string[] = [];
  const batches: string[] = [];
  for (const [index, raw] of input.materials.entries()) {
    const materialNumber = raw.trim();
    if (!materialNumber) continue;
    const batch = (input.batches?.[index] ?? '').trim().toUpperCase();
    const key = `${materialNumber}\0${batch}`;
    if (seen.has(key)) {
      throw new PhysicalInventoryError(
        batch
          ? `Material ${materialNumber} batch ${batch} appears twice in the count.`
          : `Material ${materialNumber} appears twice in the count.`,
        'Name each material and batch once; a count measures that stock, not an entry.',
      );
    }
    seen.add(key);
    materials.push(materialNumber);
    batches.push(batch);
  }
  if (materials.length === 0) {
    throw new PhysicalInventoryError(
      'A count needs at least one material.',
      'Enter the materials being counted, or cancel the document.',
    );
  }

  return withTenant(input.client, async (tx) => {
    if (input.requestKey) {
      const [replay] = await tx.select().from(physicalInventoryDocument).where(and(
        eq(physicalInventoryDocument.client, input.client),
        eq(physicalInventoryDocument.requestKey, input.requestKey),
      ));
      if (replay) return toView(tx, input.client, replay);
    }

    const header = await writeInventoryDocument(tx, {
      client: input.client,
      createdBy: input.createdBy,
      plant,
      storageLocation: location || null,
      plannedCountDate,
      postingBlock: input.postingBlock === true,
      requestKey: input.requestKey ?? null,
      materials,
      batches,
    });
    return toView(tx, input.client, header);
  });
}

/**
 * Cancel a count before anything is counted. Only CREATED can be cancelled: a document that
 * has been counted has quantities to answer for, and cancelling it would strand them.
 */
export async function cancelPhysicalInventory(input: {
  client: string;
  changedBy: string;
  inventoryDocumentNumber: string;
  fiscalYear: number;
}): Promise<PhysicalInventoryView> {
  const number = input.inventoryDocumentNumber.trim().toUpperCase();
  return withTenant(input.client, async (tx) => {
    const [header] = await tx.select().from(physicalInventoryDocument).where(and(
      eq(physicalInventoryDocument.client, input.client),
      eq(physicalInventoryDocument.inventoryDocumentNumber, number),
      eq(physicalInventoryDocument.fiscalYear, input.fiscalYear),
    ));
    if (!header) {
      throw new PhysicalInventoryError(
        `Physical inventory document ${number}/${input.fiscalYear} does not exist.`,
        'Choose a document this tenant carries.',
      );
    }
    if (header.status === 'CANCELLED') return toView(tx, input.client, header);
    if (header.status !== 'CREATED') {
      throw new PhysicalInventoryError(
        `Physical inventory document ${number} stands ${header.status.toLowerCase()} and can no longer be cancelled.`,
        'A counted document is corrected by its count, not by this act.',
      );
    }

    const [changed] = await tx.update(physicalInventoryDocument).set({
      status: 'CANCELLED',
      version: header.version + 1,
      changedBy: input.changedBy,
      changedAt: new Date(),
    }).where(and(
      eq(physicalInventoryDocument.client, input.client),
      eq(physicalInventoryDocument.inventoryDocumentNumber, number),
      eq(physicalInventoryDocument.fiscalYear, input.fiscalYear),
    )).returning();

    await recordChange(tx, {
      client: input.client,
      objectClass: 'physical_inventory_document',
      objectKey: `${number}/${input.fiscalYear}`,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      reason: header.postingBlock
        ? `Block released: document ${number} for plant ${header.plant} no longer restricts movements`
        : `Document ${number} cancelled`,
      before: { status: header.status, version: header.version },
      after: { status: 'CANCELLED', version: header.version + 1, blockReleased: header.postingBlock },
    });

    return toView(tx, input.client, changed);
  });
}

/** Documents of a plant, newest planned date first — the screen's list. */
export async function listPhysicalInventory(
  client: string, filter: { plant?: string } = {},
): Promise<PhysicalInventoryView[]> {
  return withTenant(client, async (tx) => {
    const rows = await tx.select().from(physicalInventoryDocument).where(and(
      eq(physicalInventoryDocument.client, client),
      filter.plant ? eq(physicalInventoryDocument.plant, filter.plant) : sql`true`,
    )).orderBy(
      desc(physicalInventoryDocument.plannedCountDate),
      desc(physicalInventoryDocument.inventoryDocumentNumber),
    ).limit(50);
    const views: PhysicalInventoryView[] = [];
    for (const row of rows) views.push(await toView(tx, client, row));
    return views;
  });
}

/**
 * The scope lock, taken in ONE mode by everything that touches a material's stock.
 *
 * A posting takes it **shared**; creating a count takes it **exclusive**. That is what makes
 * the block race-free: a count cannot be created under a posting that is mid-flight, and a
 * posting that begins after the count commits waits, reads, and sees the block.
 *
 * Materials are locked in **sorted order** so two postings touching the same pair cannot
 * deadlock against each other.
 */
export async function lockStockScope(
  tx: Tx, client: string, materials: string[], mode: 'SHARED' | 'EXCLUSIVE',
): Promise<void> {
  const keys = [...new Set(materials.filter(Boolean))].sort();
  for (const materialNumber of keys) {
    const key = `${client}/stock-scope/${materialNumber}`;
    if (mode === 'EXCLUSIVE') {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    } else {
      await tx.execute(sql`select pg_advisory_xact_lock_shared(hashtextextended(${key}, 0))`);
    }
  }
}

/** The same key, tried rather than awaited — used by tests to prove the protocol without timing. */
export async function tryLockStockScope(
  tx: Tx, client: string, materialNumber: string, mode: 'SHARED' | 'EXCLUSIVE',
): Promise<boolean> {
  const key = `${client}/stock-scope/${materialNumber}`;
  const rows = (mode === 'EXCLUSIVE'
    ? await tx.execute(sql`select pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) as ok`)
    : await tx.execute(sql`select pg_try_advisory_xact_lock_shared(hashtextextended(${key}, 0)) as ok`)
  ) as unknown as Array<{ ok: boolean }>;
  return rows[0]?.ok === true;
}

/**
 * The posting block, enforced. Called inside every service that moves stock — a receipt, an
 * issue, a transfer, a production receipt — before it reads a balance.
 *
 * It returns normally when nothing blocks the movement, which is the overwhelming majority of
 * postings; the index added in 9079 is what makes that path cost 0.046 ms rather than 15 ms.
 */
export async function assertInventoryCountOpen(
  tx: Tx,
  client: string,
  movement: { materialNumber: string; plant: string; storageLocation?: string | null; batch?: string | null },
): Promise<void> {
  // Shared: this posting may proceed only if no count creation holds the scope exclusively,
  // and a count created after this point must wait for this posting to finish.
  await lockStockScope(tx, client, [movement.materialNumber], 'SHARED');

  const rows = await tx.execute(sql`
    select d.inventory_document_number, d.planned_count_date
      from physical_inventory_document d
      join physical_inventory_item i
        on i.client = d.client
       and i.inventory_document_number = d.inventory_document_number
       and i.fiscal_year = d.fiscal_year
     where d.client = ${client}
       and d.status = 'CREATED'
       and d.posting_block
       and i.material_number = ${movement.materialNumber}
       and d.plant = ${movement.plant}
       and (d.storage_location is null or d.storage_location = ${movement.storageLocation ?? null})
       and (
         ${ (movement.batch ?? '').trim().toUpperCase() } = ''
         or coalesce(i.batch_number, '') = ''
         or i.batch_number = ${ (movement.batch ?? '').trim().toUpperCase() }
       )
     limit 1
  `) as unknown as Array<{ inventory_document_number: string; planned_count_date: string }>;

  const blocking = rows[0];
  if (!blocking) return;
  throw new PhysicalInventoryError(
    `Physical inventory document ${blocking.inventory_document_number} blocks postings for material ` +
      `${movement.materialNumber} in plant ${movement.plant} until the count of ${blocking.planned_count_date} is done.`,
    'Count the material first (MI04), or cancel the count document, then post.',
  );
}
