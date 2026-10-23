/**
 * Create batch. MSC1N is a search alias only.
 *
 * The batch row from OMCE is the master. This screen does not create a
 * second one, and it does not post stock. The batch level decides the
 * identity. A plant is stored only at plant level.
 *
 * ZUSTD is the restricted-use indicator, domain XFELD: X means restricted,
 * blank means unrestricted. It is not 1 or 2. It is stored only when OMCS
 * is effective. The initial value is read from the material type flag.
 * That flag is the OMAB setting, and OMAB is not this screen.
 *
 * Internal numbering is refused. OMCZ and OMAD are not this screen.
 * MSC2N and MSC3N are not this screen.
 */
import { eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { country } from '../../platform/tables/reference';
import { batchStatusScope } from './batch-status';
import { BATCH_LEVELS, type BatchLevelCode } from './batch-level';
import { batch, batchLevelConfiguration, batchStatusManagement } from './schema';

export const ACTIVITY = 'INV.BATCH.CREATE';
export const ROUTE = '/inventory/batches/new';
export const ALIASES = ['MSC1N'] as const;
export const LOCK_OBJECT = 'BATCH';

export class BatchMasterError extends Error {
  readonly code:
    | 'LEVEL_REQUIRED'
    | 'MATERIAL_UNKNOWN'
    | 'MATERIAL_NOT_BATCH'
    | 'PLANT_REQUIRED'
    | 'PLANT_NOT_ALLOWED'
    | 'PLANT_UNKNOWN'
    | 'BATCH_REQUIRED'
    | 'BATCH_TOO_LONG'
    | 'BATCH_DUPLICATE'
    | 'NUMBERING_REFUSED'
    | 'STATUS_NOT_ACTIVE'
    | 'STATUS_UNKNOWN'
    | 'DATE_INVALID'
    | 'VENDOR_BATCH'
    | 'COUNTRY_UNKNOWN'
    | 'CLASSIFICATION_REFUSED'
    | 'COMPANY_REFUSED'
    | 'REQUEST_REPLAY'
    | 'REASON_REQUIRED';

  constructor(message: string, code: BatchMasterError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchMasterError';
    this.code = code;
  }
}

export interface CreateBatchInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant?: string;
  batchNumber?: string;
  /** 'X' restricted, blank unrestricted. Omit to use the material type initial status. */
  restrictedUse?: string;
  manufactureDate?: string;
  shelfLifeExpirationDate?: string;
  vendorBatch?: string;
  countryOfOrigin?: string;
  reason?: string;
  requestKey?: string;
  internalNumbering?: boolean;
  classification?: boolean;
  companyCode?: string;
}

export interface BatchMasterRow {
  id: string;
  materialNumber: string;
  plant: string | null;
  batchNumber: string;
  batchLevel: BatchLevelCode;
  restrictedUse: 'X' | null;
  statusApplies: boolean;
  manufactureDate: string | null;
  shelfLifeExpirationDate: string | null;
  vendorBatch: string | null;
  countryOfOrigin: string | null;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3) {
    throw new BatchMasterError('A reason is required.', 'REASON_REQUIRED', 'Say why this batch is being created.');
  }
  return text.slice(0, 500);
}

function dateOf(value: string | undefined, label: string): string | null {
  const text = (value ?? '').trim();
  if (!text) return null;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new BatchMasterError(`${label} ${text} is not a date. No batch was created.`, 'DATE_INVALID', 'Use a date as YYYY-MM-DD.');
  }
  return text;
}

function isUniqueViolation(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === 'object' && !seen.has(current)) {
    seen.add(current);
    if ('code' in current && (current as { code?: string }).code === '23505') return true;
    current = 'cause' in current ? (current as { cause?: unknown }).cause : undefined;
  }
  return false;
}

async function readLevel(tx: Tx, client: string): Promise<BatchLevelCode | null> {
  const rows = await tx.select({ batchLevel: batchLevelConfiguration.batchLevel })
    .from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client))
    .limit(1);
  const code = rows[0]?.batchLevel?.trim();
  return code === '0' || code === '1' || code === '2' ? code : null;
}

export async function createBatch(input: CreateBatchInput): Promise<BatchMasterRow> {
  if (input.internalNumbering) {
    throw new BatchMasterError(
      'Internal batch numbering is refused. OMCZ is not this screen, and OMAD has no BATCH range. No batch was created.',
      'NUMBERING_REFUSED',
      'Type the batch number. Leading zeros are kept.',
    );
  }
  if (input.classification) {
    throw new BatchMasterError(
      'Batch classification is refused. Class type 023 is not active. No class was stored.',
      'CLASSIFICATION_REFUSED',
      'Leave classification empty.',
    );
  }
  if (input.companyCode?.trim()) {
    throw new BatchMasterError(
      'A company code is refused. It is not part of the batch identity. No batch was created.',
      'COMPANY_REFUSED',
      'Do not send a company code.',
    );
  }
  const materialNumber = input.materialNumber.trim();
  const typedNumber = (input.batchNumber ?? '').trim().toUpperCase();
  if (!typedNumber) {
    throw new BatchMasterError(
      'The batch number is required. Internal assignment is not active. OMCZ and OMAD are not this screen. No batch was created.',
      'BATCH_REQUIRED',
      'Type the batch number. OMCZ and OMAD are not this screen. Leading zeros are kept.',
    );
  }
  if (typedNumber.length > 10) {
    throw new BatchMasterError(
      `Batch ${typedNumber} is longer than 10 characters. No batch was created.`,
      'BATCH_TOO_LONG',
      'The classic batch number is 10 characters. Leading zeros are kept.',
    );
  }
  const manufactureDate = dateOf(input.manufactureDate, 'Date of manufacture');
  const shelfLifeExpirationDate = dateOf(input.shelfLifeExpirationDate, 'Shelf-life expiration date');
  const vendorBatch = (input.vendorBatch ?? '').trim();
  if (vendorBatch.length > 15) {
    throw new BatchMasterError(
      'The vendor batch number is longer than 15 characters. No batch was created.',
      'VENDOR_BATCH',
      'Shorten the supplier batch. It is not the internal batch number.',
    );
  }
  const countryOfOrigin = (input.countryOfOrigin ?? '').trim().toUpperCase();
  const reason = reasonOf(input.reason);
  const requestKey = input.requestKey?.trim() || null;
  const plantInput = input.plant?.trim() || null;

  return withTenant(input.client, async (tx) => {
    const level = await readLevel(tx, input.client);
    if (!level) {
      throw new BatchMasterError(
        'No batch level stands. No batch was created.',
        'LEVEL_REQUIRED',
        'Set the batch level in OMCE first. An unset level is not plant level.',
      );
    }
    if (level === '0' && !plantInput) {
      throw new BatchMasterError(
        'Plant level requires a plant. No batch was created.',
        'PLANT_REQUIRED',
        'Name the plant. The batch is unique for this material in that plant.',
      );
    }
    if (level !== '0' && plantInput) {
      throw new BatchMasterError(
        `A plant is not part of batch identity at ${BATCH_LEVELS[level].name} (${level}). No batch was created.`,
        'PLANT_NOT_ALLOWED',
        'Leave the plant empty. The same batch is one batch across plants.',
      );
    }
    const plant = level === '0' ? plantInput : null;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`${materialNumber}/${typedNumber}/${plant ?? ''}`}))`);

    if (requestKey) {
      const prior = await tx.execute(sql`
        select id, batch_number from batch
        where client = ${input.client} and request_key = ${requestKey}
        limit 1
      `) as unknown as Array<{ id: string; batch_number: string }>;
      if (prior[0]) {
        if (prior[0].batch_number !== typedNumber) {
          throw new BatchMasterError(
            'This request key already created a different batch. No second batch was created.',
            'REQUEST_REPLAY',
            'Start a new create.',
          );
        }
        return readCreated(tx, input.client, prior[0].id, level);
      }
    }

    const found = await tx.execute(sql`
      select material_type, batch_managed from material
      where client = ${input.client} and material_number = ${materialNumber}
      limit 1
    `) as unknown as Array<{ material_type: string; batch_managed: boolean }>;
    if (found.length === 0) {
      throw new BatchMasterError(
        `Material ${materialNumber} does not stand. No batch was created.`,
        'MATERIAL_UNKNOWN',
        'Create the material first.',
      );
    }
    if (level === '0') {
      const plants = await tx.execute(sql`
        select batch_managed from material_plant
        where client = ${input.client} and material_number = ${materialNumber} and plant = ${plant}
        limit 1
      `) as unknown as Array<{ batch_managed: boolean }>;
      if (plants.length === 0) {
        throw new BatchMasterError(
          `Material ${materialNumber} does not stand in plant ${plant}. No batch was created.`,
          'PLANT_UNKNOWN',
          'Create the plant view first.',
        );
      }
      if (!plants[0].batch_managed) {
        throw new BatchMasterError(
          `Material ${materialNumber} is not batch-managed in plant ${plant}. No batch was created.`,
          'MATERIAL_NOT_BATCH',
          'Set the plant batch indicator. MM02 does not yet show it.',
        );
      }
    } else if (!found[0].batch_managed) {
      throw new BatchMasterError(
        `Material ${materialNumber} is not batch-managed. No batch was created.`,
        'MATERIAL_NOT_BATCH',
        'Set the material batch indicator. MM02 does not yet show it.',
      );
    }

    const statusRow = await tx.select({ code: batchStatusManagement.statusManagement })
      .from(batchStatusManagement)
      .where(eq(batchStatusManagement.client, input.client))
      .limit(1);
    const active = statusRow[0]?.code?.trim() === '1';
    const scope = batchStatusScope({ batchLevel: level, active, plantSelected: false });
    const sentStatus = input.restrictedUse;
    let restrictedUse: 'X' | ' ' | null = null;
    if (!scope.effective) {
      if (sentStatus !== undefined && sentStatus.trim() !== '') {
        throw new BatchMasterError(
          'Batch status was sent, and status management is not effective. No batch was created.',
          'STATUS_NOT_ACTIVE',
          scope.scope === 'PLANT_NOT_SELECTED'
            ? 'OMCU has not selected this plant. Do not send a status.'
            : 'Leave the status empty. OMCS is not effective.',
        );
      }
    } else {
      const types = await tx.execute(sql`
        select initial_batch_restricted from material_type
        where client = ${input.client} and material_type = ${found[0].material_type}
        limit 1
      `) as unknown as Array<{ initial_batch_restricted: boolean }>;
      const initial = types[0]?.initial_batch_restricted ? 'X' : '';
      const chosen = (sentStatus === undefined ? initial : sentStatus).trim().toUpperCase();
      if (chosen !== 'X' && chosen !== '') {
        throw new BatchMasterError(
          `Batch status ${chosen} is not the restricted-use indicator. No batch was created.`,
          'STATUS_UNKNOWN',
          'Use X for restricted, or leave it blank for unrestricted. Do not send 1 or 2.',
        );
      }
      restrictedUse = chosen === 'X' ? 'X' : ' ';
    }

    if (countryOfOrigin) {
      const countries = await tx.select({ code: country.code }).from(country).where(eq(country.code, countryOfOrigin)).limit(1);
      if (countries.length === 0) {
        throw new BatchMasterError(
          `Country ${countryOfOrigin} is not a configured country. No batch was created.`,
          'COUNTRY_UNKNOWN',
          'Use a country key from the country list. A three-character code is not accepted unless it stands there.',
        );
      }
    }

    const id = crypto.randomUUID();
    const now = new Date();
    try {
      await tx.insert(batch).values({
        id,
        client: input.client,
        batchNumber: typedNumber,
        materialNumber,
        plant,
        batchLevelAtCreation: level,
        restrictedUse,
        manufactureDate,
        shelfLifeExpirationDate,
        vendorBatch: vendorBatch || null,
        countryOfOrigin: countryOfOrigin || null,
        requestKey,
        createdBy: input.changedBy,
        changedBy: input.changedBy,
        createdAt: now,
        changedAt: now,
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new BatchMasterError(
          duplicateMessage(level, typedNumber, materialNumber, plant),
          'BATCH_DUPLICATE',
          'MSC2N is not this screen. No second batch was created.',
        );
      }
      throw error;
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch',
      objectKey: id,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: 'MSC1N',
      reason,
      correlationId: requestKey ?? undefined,
      after: {
        materialNumber,
        plant,
        batchNumber: typedNumber,
        batchLevel: level,
        restrictedUse,
        manufactureDate,
        shelfLifeExpirationDate,
        vendorBatch: vendorBatch || null,
        countryOfOrigin: countryOfOrigin || null,
      },
    });
    return readCreated(tx, input.client, id, level);
  });
}

function duplicateMessage(level: BatchLevelCode, batchNumber: string, materialNumber: string, plant: string | null): string {
  if (level === '0') return `Batch ${batchNumber} already stands for material ${materialNumber} in plant ${plant}. No second batch was created.`;
  if (level === '1') return `Batch ${batchNumber} already stands for material ${materialNumber}. No second batch was created.`;
  return `Batch ${batchNumber} already stands in this client. No second batch was created.`;
}

async function readCreated(tx: Tx, client: string, id: string, level: BatchLevelCode): Promise<BatchMasterRow> {
  const rows = await tx.execute(sql`
    select id, material_number, plant, batch_number, restricted_use, manufacture_date,
           shelf_life_expiration_date, vendor_batch, country_of_origin
    from batch where client = ${client} and id = ${id}
  `) as unknown as Array<{
    id: string;
    material_number: string;
    plant: string | null;
    batch_number: string;
    restricted_use: string | null;
    manufacture_date: string | null;
    shelf_life_expiration_date: string | null;
    vendor_batch: string | null;
    country_of_origin: string | null;
  }>;
  const row = rows[0];
  const restricted = row.restricted_use?.trim() === 'X' ? 'X' : null;
  return {
    id: row.id,
    materialNumber: row.material_number,
    plant: row.plant,
    batchNumber: row.batch_number,
    batchLevel: level,
    restrictedUse: restricted,
    statusApplies: row.restricted_use !== null,
    manufactureDate: row.manufacture_date,
    shelfLifeExpirationDate: row.shelf_life_expiration_date,
    vendorBatch: row.vendor_batch,
    countryOfOrigin: row.country_of_origin,
  };
}
