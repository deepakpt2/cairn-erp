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
import { plant as plantTable, storageLocation } from '../foundation/schema';
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
  requestKey?: string;
}

export interface PhysicalInventoryItemView {
  itemNumber: number;
  materialNumber: string;
  description: string;
  stockQuantity: string;
  unit: string;
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
           and s.plant = ${plant} and s.stock_type = 'UNRESTRICTED'
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
    const stock = await stockAt(tx, client, header.plant, header.storageLocation, item.materialNumber);
    described.push({
      itemNumber: item.itemNumber,
      materialNumber: item.materialNumber,
      description: master?.description ?? '',
      stockQuantity: stock.quantity.toFixed(3),
      unit: stock.unit || master?.unit || '',
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
    items: described,
  };
}

/**
 * Create a count document. One transaction: the header, its items and the number commit
 * together or not at all, and the number rolls back with them because it is drawn inside it.
 *
 * Nothing is written to the ledger, and nothing about stock changes. A test asserts both.
 */
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
  for (const raw of input.materials) {
    const materialNumber = raw.trim();
    if (!materialNumber) continue;
    if (seen.has(materialNumber)) {
      throw new PhysicalInventoryError(
        `Material ${materialNumber} appears twice in the count.`,
        'Name each material once; a count measures a material, not an entry.',
      );
    }
    seen.add(materialNumber);
    materials.push(materialNumber);
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

    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/physical-inventory`}, 0))`);

    // The plant first: it carries the company code, which carries the fiscal year variant.
    const [plantRow] = await tx.select().from(plantTable).where(and(
      eq(plantTable.client, input.client), eq(plantTable.plant, plant),
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
      const [sloc] = await tx.select().from(storageLocation).where(and(
        eq(storageLocation.client, input.client),
        eq(storageLocation.plant, plant),
        eq(storageLocation.storageLocation, location),
      ));
      if (!sloc) {
        throw new PhysicalInventoryError(
          `Storage location ${location} does not stand in plant ${plant}.`,
          'Choose a storage location of the plant being counted, or count the whole plant.',
        );
      }
      if (!sloc.isActive) {
        throw new PhysicalInventoryError(
          `Storage location ${location} in plant ${plant} is not active.`,
          'Choose an active storage location.',
        );
      }
    }

    // Every material before the header is drawn, so a refusal writes nothing.
    for (const materialNumber of materials) {
      const [master] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, materialNumber),
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
         where client = ${input.client} and material_number = ${materialNumber} and plant = ${plant}
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

    // The year and period of the count date must be open for the plant's company.
    const company = await getCompanyCode(tx, input.client, plantRow.companyCode);
    if (!company?.fiscalYearVariant) {
      throw new PhysicalInventoryError(`Company code ${plantRow.companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, plannedCountDate);
    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, plantRow.companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new PhysicalInventoryError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${plantRow.companyCode}.`,
        'Plan the count in an open period, or shift the material period first.',
      );
    }

    const drawn = await allocateNumber(tx, {
      client: input.client,
      objectCode: NUMBER_OBJECT,
      fiscalYear: position.fiscalYear,
      allocatedBy: input.createdBy,
    });
    const inventoryDocumentNumber = drawn.display;

    const [header] = await tx.insert(physicalInventoryDocument).values({
      client: input.client,
      inventoryDocumentNumber,
      fiscalYear: position.fiscalYear,
      plant,
      storageLocation: location || null,
      plannedCountDate,
      postingBlock: input.postingBlock === true,
      status: 'CREATED',
      requestKey: input.requestKey ?? null,
      createdBy: input.createdBy,
    }).returning();

    await tx.insert(physicalInventoryItem).values(materials.map((materialNumber, index) => ({
      client: input.client,
      inventoryDocumentNumber,
      fiscalYear: position.fiscalYear,
      itemNumber: (index + 1) * 10,
      materialNumber,
      createdBy: input.createdBy,
    })));

    await recordChange(tx, {
      client: input.client,
      objectClass: 'physical_inventory_document',
      objectKey: `${inventoryDocumentNumber}/${position.fiscalYear}`,
      changeType: 'CREATE',
      changedBy: input.createdBy,
      after: {
        plant, storageLocation: location || null, plannedCountDate,
        postingBlock: input.postingBlock === true, materials,
      },
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
      before: { status: header.status },
      after: { status: 'CANCELLED' },
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
 * The posting block, enforced. Called inside every service that moves stock — a receipt, an
 * issue, a transfer, a production receipt — before it reads a balance.
 *
 * It returns normally when nothing blocks the movement, which is the overwhelming majority of
 * postings; the index added in 9079 is what makes that path cost 0.046 ms rather than 15 ms.
 */
export async function assertInventoryCountOpen(
  tx: Tx,
  client: string,
  movement: { materialNumber: string; plant: string; storageLocation?: string | null },
): Promise<void> {
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
