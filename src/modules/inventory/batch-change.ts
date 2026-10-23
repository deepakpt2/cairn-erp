/**
 * Change batch. MSC2N is a search alias only.
 *
 * The batch row from OMCE and MSC1N is the master. This screen does not
 * create a second one, does not change its identity, and does not post
 * stock. Movements 341 and 342 are not posted: stock has no batch column.
 *
 * ZUSTD stays the restricted-use indicator. X is restricted. Blank is
 * unrestricted. It is not 1 or 2, and it is changed only when OMCS is
 * effective. MSC1N and MSC3N are not this screen.
 */
import { and, eq, sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';
import { country } from '../../platform/tables/reference';
import { batchStatusScope } from './batch-status';
import { readPlantBatchStatusActive } from './batch-status-plant';
import { BATCH_LEVELS, type BatchLevelCode } from './batch-level';
import { batch, batchLevelConfiguration, batchStatusManagement } from './schema';

export const ACTIVITY = 'INV.BATCH.CHANGE';
export const ROUTE = '/inventory/batches/change';
export const ALIASES = ['MSC2N'] as const;
export const LOCK_OBJECT = 'BATCH';

export class BatchChangeError extends Error {
  readonly code:
    | 'LEVEL_REQUIRED'
    | 'PLANT_REQUIRED'
    | 'PLANT_NOT_ALLOWED'
    | 'BATCH_REQUIRED'
    | 'BATCH_TOO_LONG'
    | 'BATCH_UNKNOWN'
    | 'IDENTITY_REFUSED'
    | 'DELETE_REFUSED'
    | 'NUMBERING_REFUSED'
    | 'CLASSIFICATION_REFUSED'
    | 'COMPANY_REFUSED'
    | 'STATUS_NOT_ACTIVE'
    | 'STATUS_UNKNOWN'
    | 'DATE_INVALID'
    | 'VENDOR_BATCH'
    | 'COUNTRY_UNKNOWN'
    | 'VERSION_REQUIRED'
    | 'VERSION_STALE'
    | 'REASON_REQUIRED';

  constructor(message: string, code: BatchChangeError['code'], readonly remedy?: string) {
    super(message);
    this.name = 'BatchChangeError';
    this.code = code;
  }
}

export interface BatchChangeRow {
  id: string;
  materialNumber: string;
  plant: string | null;
  batchNumber: string;
  batchLevel: BatchLevelCode;
  restrictedUse: 'X' | '' | null;
  statusApplies: boolean;
  manufactureDate: string | null;
  shelfLifeExpirationDate: string | null;
  vendorBatch: string | null;
  countryOfOrigin: string | null;
  version: number;
  changed: boolean;
}

export interface ChangeBatchInput {
  client: string;
  changedBy: string;
  materialNumber: string;
  plant?: string;
  batchNumber: string;
  expectedVersion: number;
  /** Omit to keep the stored indicator. 'X' restricted, blank unrestricted. */
  restrictedUse?: string;
  manufactureDate?: string;
  shelfLifeExpirationDate?: string;
  vendorBatch?: string;
  countryOfOrigin?: string;
  reason?: string;
  newBatchNumber?: string;
  deleteBatch?: boolean;
  internalNumbering?: boolean;
  classification?: boolean;
  companyCode?: string;
}

interface StoredBatch {
  id: string;
  material_number: string;
  plant: string | null;
  batch_number: string;
  batch_level_at_creation: string;
  restricted_use: string | null;
  manufacture_date: string | Date | null;
  shelf_life_expiration_date: string | Date | null;
  vendor_batch: string | null;
  country_of_origin: string | null;
  version: number;
}

function reasonOf(value: string | undefined): string {
  const text = (value ?? '').trim();
  if (text.length < 3) {
    throw new BatchChangeError('A reason is required.', 'REASON_REQUIRED', 'Say why this batch is being changed.');
  }
  return text.slice(0, 500);
}

function dateOf(value: string | undefined, label: string): string | null | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return null;
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(text) || Number.isNaN(Date.parse(`${text}T00:00:00Z`))) {
    throw new BatchChangeError(`${label} ${text} is not a date. Nothing was changed.`, 'DATE_INVALID', 'Use a date as YYYY-MM-DD.');
  }
  return text;
}

function dateText(value: string | Date | null): string | null {
  if (value == null || value === '') return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function indicator(value: string | null): 'X' | '' | null {
  if (value == null) return null;
  return value.trim() === 'X' ? 'X' : '';
}

async function readLevel(tx: Tx, client: string): Promise<BatchLevelCode | null> {
  const rows = await tx.select({ batchLevel: batchLevelConfiguration.batchLevel })
    .from(batchLevelConfiguration)
    .where(eq(batchLevelConfiguration.client, client))
    .limit(1);
  const code = rows[0]?.batchLevel?.trim();
  return code === '0' || code === '1' || code === '2' ? code : null;
}

function identityOf(input: { materialNumber: string; plant?: string; batchNumber: string }, level: BatchLevelCode) {
  const materialNumber = input.materialNumber.trim();
  const typedNumber = input.batchNumber.trim().toUpperCase();
  if (!typedNumber) {
    throw new BatchChangeError(
      'The batch number is required. Nothing was changed.',
      'BATCH_REQUIRED',
      'Type the batch number of the batch that already stands. It will not be regenerated.',
    );
  }
  if (typedNumber.length > 40) {
    throw new BatchChangeError(
      `Batch ${typedNumber} is longer than 40 characters. Nothing was changed.`,
      'BATCH_TOO_LONG',
      'Use the batch number that already stands.',
    );
  }
  const plantInput = input.plant?.trim() || null;
  if (level === '0' && !plantInput) {
    throw new BatchChangeError(
      'Plant level requires a plant. Nothing was changed.',
      'PLANT_REQUIRED',
      'Name the plant. The batch is unique for this material in that plant.',
    );
  }
  if (level !== '0' && plantInput) {
    throw new BatchChangeError(
      `A plant is not part of batch identity at ${BATCH_LEVELS[level].name} (${level}). Nothing was changed.`,
      'PLANT_NOT_ALLOWED',
      'Leave the plant empty. The same batch is one batch across plants.',
    );
  }
  return { materialNumber, typedNumber, plant: level === '0' ? plantInput : null };
}

async function loadBatch(tx: Tx, client: string, level: BatchLevelCode, materialNumber: string, typedNumber: string, plant: string | null): Promise<StoredBatch | null> {
  const rows = await tx.execute(sql`
    select id, material_number, plant, batch_number, batch_level_at_creation, restricted_use,
           manufacture_date, shelf_life_expiration_date, vendor_batch, country_of_origin, version
    from batch
    where client = ${client}
      and material_number = ${materialNumber}
      and batch_number = ${typedNumber}
      and batch_level_at_creation = ${level}
      and ((${level} = '0' and plant = ${plant}) or (${level} <> '0' and plant is null))
    limit 1
  `) as unknown as StoredBatch[];
  return rows[0] ?? null;
}

function present(row: StoredBatch, level: BatchLevelCode, changed: boolean): BatchChangeRow {
  const restricted = indicator(row.restricted_use);
  return {
    id: row.id,
    materialNumber: row.material_number,
    plant: row.plant,
    batchNumber: row.batch_number,
    batchLevel: level,
    restrictedUse: restricted,
    statusApplies: row.restricted_use !== null,
    manufactureDate: dateText(row.manufacture_date),
    shelfLifeExpirationDate: dateText(row.shelf_life_expiration_date),
    vendorBatch: row.vendor_batch,
    countryOfOrigin: row.country_of_origin?.trim() || null,
    version: Number(row.version),
    changed,
  };
}

export async function readBatch(input: {
  client: string;
  materialNumber: string;
  plant?: string;
  batchNumber: string;
}): Promise<BatchChangeRow | null> {
  return withTenant(input.client, async (tx) => {
    const level = await readLevel(tx, input.client);
    if (!level) {
      throw new BatchChangeError(
        'No batch level stands. Nothing was opened.',
        'LEVEL_REQUIRED',
        'Set the batch level in OMCE first. An unset level is not plant level.',
      );
    }
    const identity = identityOf(input, level);
    const row = await loadBatch(tx, input.client, level, identity.materialNumber, identity.typedNumber, identity.plant);
    return row ? present(row, level, false) : null;
  });
}

export async function changeBatch(input: ChangeBatchInput): Promise<BatchChangeRow> {
  if (input.deleteBatch) {
    throw new BatchChangeError(
      'A batch is not deleted on this screen. Nothing was changed.',
      'DELETE_REFUSED',
      'Leave the batch. A batch already referenced by a business document must not be deleted.',
    );
  }
  if (input.internalNumbering || input.newBatchNumber?.trim()) {
    const next = input.newBatchNumber?.trim().toUpperCase();
    if (!input.internalNumbering && next && next === input.batchNumber.trim().toUpperCase()) {
      // The same number is not a change of identity.
    } else {
      throw new BatchChangeError(
        'The batch number is not changed, and a new number is not assigned. Nothing was changed.',
        input.internalNumbering ? 'NUMBERING_REFUSED' : 'IDENTITY_REFUSED',
        'OMCZ and OMAD are not this screen. Open the batch that already stands.',
      );
    }
  }
  if (input.classification) {
    throw new BatchChangeError(
      'Batch classification is refused. Class type 023 is not active. Nothing was changed.',
      'CLASSIFICATION_REFUSED',
      'Leave classification empty.',
    );
  }
  if (input.companyCode?.trim()) {
    throw new BatchChangeError(
      'A company code is refused. It is not part of the batch identity. Nothing was changed.',
      'COMPANY_REFUSED',
      'Do not send a company code.',
    );
  }
  if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 1) {
    throw new BatchChangeError(
      'The opened version is missing. Nothing was changed.',
      'VERSION_REQUIRED',
      'Open the batch again and send the version it shows.',
    );
  }
  const reason = reasonOf(input.reason);
  const manufactureDate = dateOf(input.manufactureDate, 'Date of manufacture');
  const shelfLifeExpirationDate = dateOf(input.shelfLifeExpirationDate, 'Shelf-life expiration date');
  const vendorSent = input.vendorBatch === undefined ? undefined : input.vendorBatch.trim();
  if (vendorSent && vendorSent.length > 15) {
    throw new BatchChangeError(
      'The vendor batch number is longer than 15 characters. Nothing was changed.',
      'VENDOR_BATCH',
      'Shorten the supplier batch. It is not the internal batch number.',
    );
  }
  const countrySent = input.countryOfOrigin === undefined ? undefined : input.countryOfOrigin.trim().toUpperCase();

  return withTenant(input.client, async (tx) => {
    const level = await readLevel(tx, input.client);
    if (!level) {
      throw new BatchChangeError(
        'No batch level stands. Nothing was changed.',
        'LEVEL_REQUIRED',
        'Set the batch level in OMCE first. An unset level is not plant level.',
      );
    }
    const identity = identityOf(input, level);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${input.client}), hashtext(${`${identity.materialNumber}/${identity.typedNumber}/${identity.plant ?? ''}`}))`);
    const current = await loadBatch(tx, input.client, level, identity.materialNumber, identity.typedNumber, identity.plant);
    if (!current) {
      throw new BatchChangeError(
        `Batch ${identity.typedNumber} does not stand for material ${identity.materialNumber}. Nothing was changed.`,
        'BATCH_UNKNOWN',
        'Create it in MSC1N first. This screen does not create a batch.',
      );
    }
    if (Number(current.version) !== input.expectedVersion) {
      throw new BatchChangeError(
        `Batch ${current.batch_number} was opened at version ${input.expectedVersion}, and version ${current.version} now stands. Nothing was changed.`,
        'VERSION_STALE',
        'Open the batch again and send the version it shows.',
      );
    }

    const statusRow = await tx.select({ code: batchStatusManagement.statusManagement })
      .from(batchStatusManagement)
      .where(eq(batchStatusManagement.client, input.client))
      .limit(1);
    const active = statusRow[0]?.code?.trim() === '1';
    const plantSelected = level === '0' ? await readPlantBatchStatusActive(tx, input.client, identity.plant) : false;
    const scope = batchStatusScope({ batchLevel: level, active, plantSelected });
    const storedIndicator = indicator(current.restricted_use);
    let nextIndicator = storedIndicator;
    if (input.restrictedUse !== undefined) {
      const chosen = input.restrictedUse.trim().toUpperCase();
      if (!scope.effective) {
        throw new BatchChangeError(
          'Batch status was sent, and status management is not effective. Nothing was changed.',
          'STATUS_NOT_ACTIVE',
          scope.scope === 'PLANT_NOT_SELECTED'
            ? 'OMCU has not selected this plant. Do not send a status. Movements 341 and 342 were not posted.'
            : 'Leave the status empty. OMCS is not effective. Movements 341 and 342 were not posted.',
        );
      }
      if (chosen !== 'X' && chosen !== '') {
        throw new BatchChangeError(
          `Batch status ${chosen} is not the restricted-use indicator. Nothing was changed.`,
          'STATUS_UNKNOWN',
          'Use X for restricted, or leave it blank for unrestricted. Do not send 1 or 2. Movements 341 and 342 were not posted.',
        );
      }
      nextIndicator = chosen === 'X' ? 'X' : '';
    }
    const nextRestricted: 'X' | ' ' | null = nextIndicator === null ? null : nextIndicator === 'X' ? 'X' : ' ';

    if (countrySent) {
      const countries = await tx.select({ code: country.code }).from(country).where(eq(country.code, countrySent)).limit(1);
      if (countries.length === 0) {
        throw new BatchChangeError(
          `Country ${countrySent} is not a configured country. Nothing was changed.`,
          'COUNTRY_UNKNOWN',
          'Use a country key from the country list. A three-character code is not accepted unless it stands there.',
        );
      }
    }

    const nextManufacture = manufactureDate === undefined ? dateText(current.manufacture_date) : manufactureDate;
    const nextShelf = shelfLifeExpirationDate === undefined ? dateText(current.shelf_life_expiration_date) : shelfLifeExpirationDate;
    const nextVendor = vendorSent === undefined ? current.vendor_batch : vendorSent || null;
    const nextCountry = countrySent === undefined ? (current.country_of_origin?.trim() || null) : countrySent || null;
    const before = {
      materialNumber: current.material_number,
      plant: current.plant,
      batchNumber: current.batch_number,
      restrictedUse: current.restricted_use,
      manufactureDate: dateText(current.manufacture_date),
      shelfLifeExpirationDate: dateText(current.shelf_life_expiration_date),
      vendorBatch: current.vendor_batch,
      countryOfOrigin: current.country_of_origin?.trim() || null,
      version: Number(current.version),
    };
    const after = {
      materialNumber: current.material_number,
      plant: current.plant,
      batchNumber: current.batch_number,
      restrictedUse: nextRestricted,
      manufactureDate: nextManufacture,
      shelfLifeExpirationDate: nextShelf,
      vendorBatch: nextVendor,
      countryOfOrigin: nextCountry,
      version: Number(current.version) + 1,
    };
    const same = before.restrictedUse === after.restrictedUse
      && before.manufactureDate === after.manufactureDate
      && before.shelfLifeExpirationDate === after.shelfLifeExpirationDate
      && before.vendorBatch === after.vendorBatch
      && before.countryOfOrigin === after.countryOfOrigin;
    if (same) return present(current, level, false);

    const now = new Date();
    const saved = await tx.update(batch).set({
      restrictedUse: nextRestricted,
      manufactureDate: nextManufacture,
      shelfLifeExpirationDate: nextShelf,
      vendorBatch: nextVendor,
      countryOfOrigin: nextCountry,
      version: Number(current.version) + 1,
      changedBy: input.changedBy,
      changedAt: now,
    }).where(and(
      eq(batch.client, input.client),
      eq(batch.id, current.id),
      eq(batch.version, input.expectedVersion),
    )).returning({ version: batch.version });
    if (saved.length !== 1) {
      throw new BatchChangeError(
        `Batch ${current.batch_number} changed before this save. Nothing was changed.`,
        'VERSION_STALE',
        'Open the batch again.',
      );
    }
    await recordChange(tx, {
      client: input.client,
      objectClass: 'batch',
      objectKey: current.id,
      changeType: 'CHANGE',
      changedBy: input.changedBy,
      transactionCode: 'MSC2N',
      reason,
      before,
      after,
    });
    return present({
      ...current,
      restricted_use: nextRestricted,
      manufacture_date: nextManufacture,
      shelf_life_expiration_date: nextShelf,
      vendor_batch: nextVendor,
      country_of_origin: nextCountry,
      version: Number(current.version) + 1,
    }, level, true);
  });
}
