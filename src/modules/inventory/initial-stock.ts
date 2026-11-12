/**
 * Initial stock entry — movement 561.
 *
 * Every other goods movement in the system names the document it answers. A
 * receipt answers a purchase order; an issue answers an order, a reservation or
 * a cost centre; a transfer answers nothing but is still a movement between two
 * things the company already owns. A company's opening stock answers none of
 * them, because there is no document before it: the stock simply *is* there on
 * the day the books open.
 *
 * That is what 561 is for. It is the one movement whose authority is the
 * inventory itself, and its offsetting entry is not a clearing account — there
 * is nothing to clear — but retained earnings, because stock that was already
 * there on the day the books opened is part of the equity the books opened with.
 *
 * Why it is a service and not a journal line: a stock figure is a quantity the
 * inventory ledger holds. A journal can state a value but it cannot put a
 * quantity on a shelf, and the two must agree or the inventory accounts stop
 * tying to the stock they are supposed to represent. So this writes what every
 * other goods movement writes — a material document, the stock balance, the
 * valuation totals, and one balanced journal — in a single transaction.
 *
 * Deliberately not here:
 *
 *   * A reversal. The movement carries no reversal movement type, so the
 *     generic reversal engine refuses it with a reason rather than guessing.
 *     Cancelling an opening balance is a correcting entry, not a reversal.
 *   * An externally stated value. The stock takes the price the material
 *     carries — standard price where the material is standard-priced, moving
 *     average otherwise — because that is the price every later movement will
 *     use, and an opening entry valued at a different price would leave the
 *     valuation average wrong from the first day.
 */

import { and, eq, sql } from 'drizzle-orm';

import { AuthzError } from '../../platform/auth/current';
import {
  hasCapability, hasOrgAccess, loadCapabilities, loadOrgRestrictions,
} from '../../platform/auth/session';
import { type Tx, withTenant } from '../../platform/db/client';
import { allocateNumber } from '../../platform/numbering';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination } from '../foundation/schema';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, quantityToken,
  REQUEST_MISMATCH_REMEDY,
} from './balance-update';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { getMaterialPeriodControlInTx } from './goods-issue';
import { materialPeriodAllows } from './material-period-control';
import { recordOutputsForPostedDocument } from './material-document-output';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, stockQuantity,
} from './schema';
import { resolveStorageLocation, storageLocationRequired, StorageLocationError } from './storage-location';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';
import { postingValuationRefusal } from './valuation-class-definition';

export const INITIAL_STOCK_CAPABILITY = 'INV.INITIAL_STOCK.POST';

/** SAP's 561, named the way this system names its movements. */
export const INITIAL_STOCK_MOVEMENT = 'INITIAL_STOCK_ENTRY';
export const INITIAL_STOCK_DESCRIPTION = 'Initial stock entry';

const JOURNAL_DOCUMENT_TYPE = 'WE';
const MATERIAL_DOCUMENT_CLASS = 'material_document';

/** The account that receives the other side of an opening balance. */
const OFFSET_EVENT = 'RETAINED_EARNINGS';
const OFFSET_MODIFIER = 'X';

/** What a caller passes to identify itself. Never taken from a form field. */
export interface InitialStockAuthorizationContext {
  userId: string;
  sessionId: string;
}

/** One generic denial for invalid session, capability, or company/plant assignment. */
class InitialStockAuthorizationError extends AuthzError {
  constructor(username = 'authenticated user') {
    super(INITIAL_STOCK_CAPABILITY, username);
    this.message = 'You are not authorised to post this initial stock entry.';
  }

  override get remedy(): string {
    return 'Ask an administrator to review your goods-movement authority and company/plant assignments.';
  }
}

export class InitialStockError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'InitialStockError';
    this.remedy = remedy;
  }
}

export interface InitialStockLineInput {
  materialNumber: string;
  plant: string;
  /** Where it sits. Resolved from the material's plant default when omitted. */
  storageLocation?: string | null;
  quantity: number;
  /** The unit the quantity was counted in. The material's base unit when omitted. */
  entryUnit?: string | null;
  batch?: string | null;
  stockType?: string | null;
}

export interface PostInitialStockInput {
  client: string;
  changedBy: string;
  /** ISO date, yyyy-mm-dd. */
  postingDate: string;
  /** ISO date, yyyy-mm-dd. */
  documentDate: string;
  headerText?: string;
  requestKey: string;
  lines: InitialStockLineInput[];
}

export interface InitialStockLineView {
  materialNumber: string;
  plant: string;
  storageLocation: string;
  quantity: string;
  baseQuantity: string;
  value: string;
  batch: string;
}

export interface InitialStockView {
  materialDocumentNumber: string;
  documentYear: number;
  postingDate: string;
  journalDocumentNumber: string;
  lines: InitialStockLineView[];
  totalValue: string;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

function requireDate(value: string, label: string): string {
  const trimmed = value.trim();
  if (!ISO_DATE.test(trimmed) || Number.isNaN(Date.parse(trimmed))) {
    throw new InitialStockError(`${label} ${value || '(empty)'} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
  return trimmed;
}

/**
 * The movement, ensured per tenant the way every other movement is.
 *
 * It names no reference category because an opening balance answers no document,
 * and it carries no reversal: there is nothing here to reverse into.
 */
async function ensureInitialStockMovement(tx: Tx, client: string, changedBy: string): Promise<string> {
  await tx.insert(movementType).values({
    client,
    movementType: INITIAL_STOCK_MOVEMENT,
    description: INITIAL_STOCK_DESCRIPTION,
    direction: 'RECEIPT',
    // The document itself is the reference: an opening balance names no
    // preceding document, which is the same answer a goods issue gives.
    referenceCategory: 'MATERIAL_DOCUMENT',
    movementKind: 'MATERIAL',
    reversalMovementType: null,
    valuationRelevant: true,
    inventoryEvent: 'INVENTORY',
    offsetEvent: OFFSET_EVENT,
    offsetModifier: OFFSET_MODIFIER,
    plantRule: 'SAME',
    locationRule: 'SAME',
    accountAssignment: 'NONE',
    negativeStockPolicy: 'LOCATION',
    createdBy: changedBy,
  }).onConflictDoNothing();
  return INITIAL_STOCK_MOVEMENT;
}

/**
 * Who is posting, and whether their reach covers every plant this document
 * touches.
 *
 * The same judgement every goods movement makes: the session is revalidated at
 * the service boundary and its rows are held until commit, the capability is
 * checked against the roles the user actually holds, and both a company-code
 * and a plant restriction must stand — because a posting is only as narrow as
 * the person allowed to make it.
 */
async function requireInitialStockAuthorityInTx(
  tx: Tx,
  client: string,
  authorization: InitialStockAuthorizationContext | undefined,
): Promise<{ username: string; restrictions: Awaited<ReturnType<typeof loadOrgRestrictions>> }> {
  if (!authorization?.userId || !authorization.sessionId) {
    throw new InitialStockAuthorizationError();
  }

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
  if (!actor) throw new InitialStockAuthorizationError();

  await tx.execute(sql`
    select code from capability where code = ${INITIAL_STOCK_CAPABILITY} for share
  `);
  await tx.execute(sql`
    select ur.role_code, rc.capability_code
      from user_role ur
      join role r on r.client = ur.client and r.code = ur.role_code and r.is_active = true
      join role_capability rc on rc.client = ur.client and rc.role_code = ur.role_code
     where ur.client = ${client}
       and ur.user_id = ${authorization.userId}
       and (ur.valid_from is null or ur.valid_from <= now())
       and (ur.valid_to is null or ur.valid_to >= now())
     for share of ur, r, rc
  `);
  const capabilities = await loadCapabilities(tx, client, authorization.userId);
  if (!hasCapability(capabilities, INITIAL_STOCK_CAPABILITY)) {
    throw new InitialStockAuthorizationError(actor.username);
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
    throw new InitialStockAuthorizationError(actor.username);
  }
  return { username: actor.username, restrictions };
}

async function requirePlantAuthorityInTx(
  tx: Tx,
  client: string,
  plantCode: string,
  restrictions: Awaited<ReturnType<typeof loadOrgRestrictions>>,
  username: string,
): Promise<string> {
  const rows = (await tx.execute(sql`
    select plant, company_code as "companyCode"
      from plant
     where client = ${client} and plant = ${plantCode}
     for share
  `)) as unknown as Array<{ plant: string; companyCode: string | null }>;
  const plantRow = rows[0];
  if (!plantRow?.companyCode
    || !hasOrgAccess(restrictions, 'COMPANY_CODE', plantRow.companyCode)
    || !hasOrgAccess(restrictions, 'PLANT', plantRow.plant)) {
    throw new InitialStockAuthorizationError(username);
  }
  return plantRow.companyCode;
}

async function resolveAccount(
  tx: Tx,
  client: string,
  chart: string,
  event: string,
  valuationClass: string,
  generalModifier: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find(
    (candidate) => candidate.valuationClass === valuationClass
      && (candidate.generalModifier ?? '') === generalModifier,
  ) ?? rows.find((candidate) => candidate.valuationClass === '' && (candidate.generalModifier ?? '') === generalModifier)
    ?? rows.find((candidate) => candidate.valuationClass === '');
  if (!row) {
    throw new InitialStockError(
      `Account determination for ${event}${valuationClass ? ` and valuation class ${valuationClass}` : ''} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

/**
 * Post the stock a company already holds on the day its books open.
 *
 * One transaction: the material document, the stock balance, the valuation
 * totals and one balanced journal. Idempotent through the request key — the
 * same key and the same lines return the document already posted, and the same
 * key with different lines is refused rather than silently ignored.
 */
export async function postInitialStock(
  input: PostInitialStockInput,
  options?: { authorization?: InitialStockAuthorizationContext },
): Promise<InitialStockView> {
  const postingDate = requireDate(input.postingDate, 'The posting date');
  const documentDate = requireDate(input.documentDate, 'The document date');
  const headerText = input.headerText ?? '';
  if (headerText.length > 25) {
    throw new InitialStockError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (!input.requestKey.trim()) {
    throw new InitialStockError('A request key is required.', 'Repeat the same key to retry this posting.');
  }
  if (input.requestKey.length > 64) {
    throw new InitialStockError('The request key is longer than 64 characters.', 'Use a shorter key.');
  }
  if (input.lines.length === 0) {
    throw new InitialStockError(
      'No stock was entered.',
      'Enter the material, plant and quantity of at least one line.',
    );
  }

  const fingerprint = postingFingerprint([
    'INITIAL-STOCK', postingDate, documentDate, headerText,
    ...[...input.lines]
      .map((line) => [
        line.materialNumber.trim().toUpperCase(),
        line.plant.trim(),
        (line.storageLocation ?? '').trim(),
        quantityToken(line.quantity),
        (line.entryUnit ?? '').trim().toUpperCase(),
        (line.batch ?? '').trim().toUpperCase(),
        (line.stockType ?? '').trim().toUpperCase(),
      ].join(':'))
      .sort(),
  ]);

  return withTenant(input.client, async (tx) => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const [replay] = await tx.select().from(materialDocument).where(and(
      eq(materialDocument.client, input.client),
      eq(materialDocument.requestKey, input.requestKey),
    ));
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new InitialStockError(mismatch, REQUEST_MISMATCH_REMEDY);
      return await toView(tx, input.client, replay.materialDocumentNumber);
    }

    const { username, restrictions } = await requireInitialStockAuthorityInTx(tx, input.client, options?.authorization);

    const movementTypeCode = await ensureInitialStockMovement(tx, input.client, input.changedBy);

    // Every plant this document touches has to be inside the poster's reach, and
    // every plant has to belong to the same company: one document, one company.
    const plants = [...new Set(input.lines.map((line) => line.plant.trim()))].sort();
    const companyCodes = new Set<string>();
    for (const plantCode of plants) {
      companyCodes.add(await requirePlantAuthorityInTx(tx, input.client, plantCode, restrictions, username));
    }
    if (companyCodes.size !== 1) {
      throw new InitialStockError(
        'An initial stock entry may not span company codes.',
        'Post one document per company code.',
      );
    }
    const companyCode = [...companyCodes][0] ?? '';

    const company = await getCompanyCode(tx, input.client, companyCode);
    if (!company?.fiscalYearVariant) {
      throw new InitialStockError(`Company code ${companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, postingDate);

    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new InitialStockError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${companyCode}.`,
        'Post into the open material period, or shift the material period first.',
      );
    }

    const materials = [...new Set(input.lines.map((line) => line.materialNumber.trim().toUpperCase()))].sort();
    await lockStockScope(tx, input.client, materials, 'EXCLUSIVE');

    const chart = company.chartOfAccounts as string;
    const offsetAccount = await resolveAccount(tx, input.client, chart, OFFSET_EVENT, '', OFFSET_MODIFIER);

    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string; material?: string; plant?: string;
    }> = [];
    const prepared: Array<{
      materialNumber: string; plant: string; storageLocation: string; batch: string; stockType: string;
      quantity: number; baseQuantity: number; baseUnit: string; entryUnit: string;
      value: number; inventoryAccount: string;
    }> = [];

    for (const line of input.lines) {
      const materialNumber = line.materialNumber.trim().toUpperCase();
      const plantCode = line.plant.trim();
      if (!(line.quantity > 0)) {
        throw new InitialStockError(
          `${materialNumber} in plant ${plantCode}: the quantity must be positive.`,
          'Enter a quantity greater than zero.',
        );
      }

      const [mat] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, materialNumber),
      ));
      if (!mat) throw new InitialStockError(`Material ${materialNumber} does not exist.`);
      if (mat.markedForDeletion) {
        throw new InitialStockError(
          `Material ${materialNumber} is flagged for deletion.`,
          'Cancel the deletion flag, then post again.',
        );
      }
      const [ext] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, plantCode),
      ));
      if (!ext) {
        throw new InitialStockError(
          `Material ${materialNumber} is not extended to plant ${plantCode}.`,
          'Extend the material to the plant first.',
        );
      }
      if (ext.markedForDeletion) {
        throw new InitialStockError(
          `Material ${materialNumber} is flagged for deletion in plant ${plantCode}.`,
          'Cancel the plant deletion flag, then post again.',
        );
      }
      const [valuation] = await tx.select().from(materialValuation).where(and(
        eq(materialValuation.client, input.client),
        eq(materialValuation.materialNumber, materialNumber),
        eq(materialValuation.valuationArea, plantCode),
      ));
      if (!valuation) {
        throw new InitialStockError(
          `Material ${materialNumber} carries no valuation in plant ${plantCode}.`,
          'Maintain the accounting view for the material, then post again.',
        );
      }
      const refusal = await postingValuationRefusal(tx, input.client, materialNumber, valuation.valuationClass ?? '');
      if (refusal) throw new InitialStockError(refusal, 'Maintain the material valuation, then post again.');

      const entryUnit = (line.entryUnit ?? '').trim().toUpperCase() || (mat.baseUnit ?? '');
      let baseQuantity = line.quantity;
      let baseUnit = entryUnit;
      if (entryUnit !== (mat.baseUnit ?? '')) {
        try {
          const conversion = await toBaseQuantity(tx, input.client, {
            materialNumber, quantity: line.quantity, entryUnit,
          });
          baseQuantity = conversion.baseQuantity;
          baseUnit = conversion.baseUnit;
        } catch (caught) {
          if (caught instanceof UnitConversionError) throw new InitialStockError(caught.message, caught.remedy);
          throw caught;
        }
      }

      // The stock takes the price the material carries — standard where the
      // material is standard-priced, moving average otherwise. An opening entry
      // valued at anything else would leave every later movement dividing by a
      // base it did not start from.
      const price = valuation.priceControl === 'STANDARD'
        ? Number(valuation.standardPrice)
        : Number(valuation.movingAveragePrice);
      const value = round2((baseQuantity * price) / Number(valuation.priceUnit));

      const required = await storageLocationRequired(tx, input.client, materialNumber, plantCode);
      let receivedAt;
      try {
        receivedAt = await resolveStorageLocation(tx, {
          client: input.client,
          plant: plantCode,
          typed: line.storageLocation ?? null,
          documentDefault: null,
          applyPlantDefault: true,
          required,
          verb: 'Receive into',
        });
      } catch (caught) {
        if (caught instanceof StorageLocationError) throw new InitialStockError(caught.message, caught.remedy);
        throw caught;
      }

      let batch = '';
      try {
        batch = await resolvePostingBatch(tx, {
          client: input.client, materialNumber, plant: plantCode,
          batch: line.batch ?? '', postingDate,
        });
      } catch (caught) {
        if (caught instanceof BatchPostingError) throw new InitialStockError(caught.message, caught.remedy);
        throw caught;
      }

      try {
        await assertInventoryCountOpen(tx, input.client, {
          materialNumber, plant: plantCode, storageLocation: receivedAt.storageLocation, batch,
        });
      } catch (caught) {
        if (caught instanceof PhysicalInventoryError) throw new InitialStockError(caught.message, caught.remedy);
        throw caught;
      }

      const inventoryAccount = await resolveAccount(
        tx, input.client, chart, 'INVENTORY', valuation.valuationClass ?? '', '',
      );
      journalLines.push({
        glAccount: inventoryAccount, debitCredit: 'S', amount: value.toFixed(2),
        material: materialNumber, plant: plantCode,
      });
      journalLines.push({
        glAccount: offsetAccount, debitCredit: 'H', amount: value.toFixed(2),
        material: materialNumber, plant: plantCode,
      });

      prepared.push({
        materialNumber, plant: plantCode, storageLocation: receivedAt.storageLocation, batch,
        stockType: (line.stockType ?? '').trim().toUpperCase() || 'UNRESTRICTED',
        quantity: line.quantity, baseQuantity, baseUnit, entryUnit, value, inventoryAccount,
      });
    }

    const allocated = await allocateNumber(tx, {
      client: input.client, objectCode: 'MATDOC', allocatedBy: input.changedBy,
    });
    const number = allocated.display;

    const journal = await postJournalEntry(tx, {
      client: input.client,
      companyCode,
      documentType: JOURNAL_DOCUMENT_TYPE,
      documentDate,
      postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: company.currency,
      localCurrency: company.currency,
      headerText,
      lines: journalLines,
      origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: INITIAL_STOCK_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new InitialStockError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
      documentDate, postingDate,
      headerText: headerText || null, status: 'POSTED',
      journalDocumentNumber: journal.documentNumber, requestKey: input.requestKey,
      requestFingerprint: fingerprint,
      createdBy: input.changedBy,
    });

    let lineNumber = 0;
    for (const p of prepared) {
      lineNumber += 1;
      await tx.insert(materialDocumentLine).values({
        client: input.client, materialDocumentNumber: number, lineNumber,
        movementType: movementTypeCode,
        materialNumber: p.materialNumber, plant: p.plant,
        storageLocation: p.storageLocation || null, stockType: p.stockType, batchNumber: p.batch,
        entryQuantity: String(p.quantity), entryUnit: p.entryUnit,
        baseQuantity: String(p.baseQuantity), baseUnit: p.baseUnit,
        unitPrice: String(round2(p.value / (p.baseQuantity || 1))), priceUnit: '1',
        currency: company.currency,
        value: String(p.value),
        createdBy: input.changedBy,
      });
      await tx.insert(stockQuantity).values({
        client: input.client, materialNumber: p.materialNumber, plant: p.plant,
        storageLocation: p.storageLocation, stockType: p.stockType, batchNumber: p.batch,
        quantity: String(p.baseQuantity), createdBy: input.changedBy,
      }).onConflictDoUpdate({
        target: [
          stockQuantity.client, stockQuantity.materialNumber, stockQuantity.plant,
          stockQuantity.storageLocation, stockQuantity.stockType, stockQuantity.batchNumber,
        ],
        set: {
          quantity: sql`${stockQuantity.quantity} + ${p.baseQuantity}`,
          changedBy: input.changedBy,
          changedAt: new Date(),
        },
      });
      await applyValuationDelta(
        tx, input.client, input.changedBy, p.materialNumber, p.plant, p.baseQuantity, p.value,
      );
    }

    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return {
      materialDocumentNumber: number,
      documentYear: position.fiscalYear,
      postingDate,
      journalDocumentNumber: journal.documentNumber,
      totalValue: prepared.reduce((sum, p) => sum + p.value, 0).toFixed(2),
      lines: prepared.map((p) => ({
        materialNumber: p.materialNumber,
        plant: p.plant,
        storageLocation: p.storageLocation,
        quantity: String(p.quantity),
        baseQuantity: String(p.baseQuantity),
        value: p.value.toFixed(2),
        batch: p.batch,
      })),
    };
  });
}

async function toView(tx: Tx, client: string, documentNumber: string): Promise<InitialStockView> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client),
    eq(materialDocument.materialDocumentNumber, documentNumber),
  ));
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, documentNumber),
  )).orderBy(materialDocumentLine.lineNumber);

  return {
    materialDocumentNumber: documentNumber,
    documentYear: header?.documentYear ?? 0,
    postingDate: header?.postingDate ?? '',
    journalDocumentNumber: header?.journalDocumentNumber ?? '',
    totalValue: lines.reduce((sum, line) => sum + Number(line.value ?? 0), 0).toFixed(2),
    lines: lines.map((line) => ({
      materialNumber: line.materialNumber ?? '',
      plant: line.plant ?? '',
      storageLocation: line.storageLocation ?? '',
      quantity: String(line.entryQuantity ?? '0'),
      baseQuantity: String(line.baseQuantity ?? '0'),
      value: Number(line.value ?? 0).toFixed(2),
      batch: line.batchNumber ?? '',
    })),
  };
}
