/**
 * Goods issue — SCR-136 / INV.GI.POST (MB1A as a search alias only).
 *
 * A goods issue is a **material document**: it writes the one ledger canon has
 * (MKPF/MSEG shapes) and no parallel table (§26.887). Stock falls at the issuing
 * storage location, the valuation falls by exactly what the issue is worth, the
 * journal credits INVENTORY and debits the consumption or scrapping account, and —
 * when a line names a reservation — SCR-133's withdrawal runs **in the same
 * transaction**, so the demand in MD04 falls with the stock.
 *
 * Delivered movements: **201** (goods issue to a cost centre) and **551**
 * (scrapping). **261 is refused by name** — it consumes against a production order
 * and canon has no order master. The counter movements (202 / 552) stand in the
 * catalogue with their `reversal_movement_type` links so **MBST** reverses an issue
 * through the tested path; this service posts no counter movement of its own.
 *
 * A batch-managed material posts only against a batch that already stands.
 * The production-order issue stays on MIGO until PROD.ORDER.CREATE names it.
 * The posting does not create the batch, and a restricted batch is refused
 * because movements 341 and 342 are not available.
 */
import { and, eq, sql } from 'drizzle-orm';

import { withTenant, type Tx } from '../../platform/db/client';
import { recordChange } from '../../platform/change';
import { allocateNumber } from '../../platform/numbering';
import { postJournalEntry, PostingError } from '../../platform/posting';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { accountDetermination, plant as plantTable } from '../foundation/schema';
import { materialPeriodAllows } from './material-period-control';
import { resolveStorageLocation, storageLocationRequired, StorageLocationError } from './storage-location';
import { postingValuationRefusal } from './valuation-class-definition';
import { noteBatchControlUse } from './batch-control-use';
import { BatchPostingError, resolvePostingBatch } from './batch-posting';
import { batchClassificationRefusal } from './batch-classification';
import { recordOutputsForPostedDocument } from './material-document-output';
import { withdrawReservationInTx } from './reservations';
import { assertInventoryCountOpen, lockStockScope, PhysicalInventoryError } from './physical-inventory';
import {
  applyValuationDelta, lockRequestKey, mismatchedRequest, postingFingerprint, quantityToken,
  REQUEST_MISMATCH_REMEDY,
} from './balance-update';
import { toBaseQuantity, UnitConversionError } from './unit-conversion';
import { lineNotReversed, OPEN_PRODUCTION_DOCUMENT } from './production-document-quantity';
import {
  material, materialDocument, materialDocumentLine, materialPlant, materialValuation,
  movementType, productionOrder, productionOrderComponent, reservationItem, stockQuantity,
} from './schema';

export const GOODS_ISSUE_CAPABILITY = 'INV.GI.POST';
export const GOODS_ISSUE_ALIAS = 'MB1A';
export const GOODS_ISSUE_ROUTE = '/inventory/goods-issue';

export class GoodsIssueError extends Error {
  constructor(message: string, readonly remedy?: string) {
    super(message);
    this.name = 'GoodsIssueError';
  }
}

const MATERIAL_DOCUMENT_CLASS = 'material_document';
const JOURNAL_DOCUMENT_TYPE = 'WA';

export interface GoodsIssueScenario {
  /** The three-digit movement type the user enters — an input alias, never a stored code. */
  code: string;
  movementType: string;
  reversalMovementType: string;
  description: string;
  accountAssignment: 'COST_CENTER' | 'NONE' | 'ORDER';
  /** The account-determination event the offsetting debit reads. */
  expenseEvent: 'CONSUMPTION' | 'SCRAP' | 'PRODUCTION_CONSUMPTION';
  /** Which screen offers this movement: MIGO carries the order issue (SCR-139). */
  screen: 'MB1A' | 'MIGO';
}

export const GOODS_ISSUE_SCENARIOS: readonly GoodsIssueScenario[] = [
  {
    code: '201', movementType: 'GI_ISSUE_CC', reversalMovementType: 'GI_ISSUE_CC_REVERSAL',
    description: 'Goods issue for a cost centre', accountAssignment: 'COST_CENTER',
    expenseEvent: 'CONSUMPTION', screen: 'MB1A',
  },
  {
    code: '551', movementType: 'GI_SCRAP', reversalMovementType: 'GI_SCRAP_REVERSAL',
    description: 'Scrapping', accountAssignment: 'NONE',
    expenseEvent: 'SCRAP', screen: 'MB1A',
  },
  {
    // SCR-139: the component issue a production order consumes. Offered by MIGO alone —
    // SAP's MB1A reaches it too, and canon keeps one screen per movement so the matrix
    // in MIGO stays the single place an action and a reference select a movement.
    code: '261', movementType: 'PROD_ISSUE_ORDER', reversalMovementType: 'PROD_ISSUE_ORDER_REV',
    description: 'Goods issue for a production order', accountAssignment: 'ORDER',
    expenseEvent: 'PRODUCTION_CONSUMPTION', screen: 'MIGO',
  },
] as const;

/** The movements the MB1A screen offers: the order issue lives on MIGO (SCR-139). */
export const MB1A_SCENARIOS = GOODS_ISSUE_SCENARIOS.filter((s) => s.screen === 'MB1A');
/** The movements MIGO posts from its own grid. */
export const MIGO_ISSUE_SCENARIOS = GOODS_ISSUE_SCENARIOS.filter((s) => s.screen === 'MIGO');

/** The catalogue rows this round delivers, counter movements included. */
export const DELIVERED_GOODS_ISSUE_MOVEMENTS = GOODS_ISSUE_SCENARIOS.flatMap((s) => [
  {
    movementType: s.movementType,
    description: `${s.description} (${s.code})`,
    direction: 'ISSUE',
    referenceCategory: s.accountAssignment === 'ORDER' ? 'PRODUCTION_ORDER' : 'MATERIAL_DOCUMENT',
    accountAssignment: s.accountAssignment,
    reversalMovementType: s.reversalMovementType,
  },
  {
    movementType: s.reversalMovementType,
    description: `Reversal of ${s.description} (${Number(s.code) + 1})`,
    direction: 'ISSUE',
    referenceCategory: s.accountAssignment === 'ORDER' ? 'PRODUCTION_ORDER' : 'MATERIAL_DOCUMENT',
    accountAssignment: s.accountAssignment,
    reversalMovementType: null,
  },
]);

export interface GoodsIssueLineInput {
  materialNumber: string;
  plant: string;
  storageLocation?: string;
  quantity: number;
  costCenter?: string;
  reservationNumber?: string;
  reservationItem?: number;
  /** The production order a 261 consumes for, and which component item it satisfies. */
  productionOrderNumber?: string;
  productionOrderItem?: number;
  /** The unit the reader typed in. Absent means the material's base unit. */
  entryUnit?: string;
  /** Required when the material is batch-managed. The batch must already stand. */
  batch?: string;
}

export interface PostGoodsIssueInput {
  client: string;
  changedBy: string;
  movementTypeCode: string;
  postingDate: string;
  documentDate: string;
  headerText?: string;
  requestKey: string;
  lines: GoodsIssueLineInput[];
}

export interface GoodsIssueLineView {
  lineNumber: number;
  movementType: string;
  materialNumber: string;
  plant: string;
  storageLocation: string | null;
  quantity: string;
  unit: string;
  value: string;
  costCenter: string | null;
  reservationNumber: string | null;
  reservationItem: number | null;
  /** What the reservation still holds after this posting, when one was named. */
  reservationOpenAfter: string | null;
  /** What the production order's component still requires after this issue (SCR-139). */
  productionOrderNumber: string | null;
  productionOrderItem: number | null;
  orderOpenAfter: string | null;
}

export interface GoodsIssueView {
  materialDocumentNumber: string;
  documentYear: number;
  postingDate: string;
  documentDate: string;
  movementType: string;
  movementCode: string;
  journalDocumentNumber: string | null;
  companyCode: string;
  totalValue: string;
  lines: GoodsIssueLineView[];
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const round2 = (n: number) => Math.round(n * 100) / 100;

function requireDate(value: string, what: string) {
  if (!ISO_DATE.test(value)) {
    throw new GoodsIssueError(`${what} is not a date.`, 'Enter the date as YYYY-MM-DD.');
  }
}

function resolveScenario(code: string, screen: 'MB1A' | 'MIGO'): GoodsIssueScenario {
  const found = GOODS_ISSUE_SCENARIOS.find((s) => s.code === code.trim());
  if (found && found.screen === screen) return found;
  if (found) {
    throw new GoodsIssueError(
      `Movement ${found.code} is posted from ${found.screen === 'MIGO' ? 'MIGO' : 'MB1A'}, not from this screen.`,
      found.screen === 'MIGO'
        ? 'Open MIGO, choose Goods issue with an order reference, then post it there.'
        : 'Post this movement from the goods issue screen.',
    );
  }
  const trimmed = code.trim();
  if (['202', '552', '262'].includes(trimmed)) {
    throw new GoodsIssueError(
      `${trimmed} is a reversal, not an issue.`,
      'Reverse a posted goods issue through MBST (INV.REVERSE); this screen posts issues only.',
    );
  }
  throw new GoodsIssueError(
    `Movement type ${trimmed || '(empty)'} is not a goods issue canon delivers.`,
    'Goods issues stand on 201 (goods issue for a cost centre) or 551 (scrapping).',
  );
}

async function ensureMovements(tx: Tx, client: string, changedBy: string) {
  for (const m of DELIVERED_GOODS_ISSUE_MOVEMENTS) {
    await tx.insert(movementType).values({ client, ...m, createdBy: changedBy }).onConflictDoNothing();
  }
}

export async function getMaterialPeriodControlInTx(tx: Tx, client: string, company: string) {
  const rows = await tx.execute(sql`
    select current_fiscal_year, current_period, previous_fiscal_year, previous_period,
           allow_backposting, disallow_backposting_after_change
    from material_period_control where client = ${client} and company_code = ${company}
  `) as unknown as Array<{
    current_fiscal_year: number; current_period: number;
    previous_fiscal_year: number; previous_period: number;
    allow_backposting: boolean; disallow_backposting_after_change: boolean;
  }>;
  const r = rows[0];
  if (!r) return null;
  return {
    companyCode: company,
    currentFiscalYear: r.current_fiscal_year,
    currentPeriod: r.current_period,
    previousFiscalYear: r.previous_fiscal_year,
    previousPeriod: r.previous_period,
    allowBackposting: r.allow_backposting,
    disallowBackpostingAfterChange: r.disallow_backposting_after_change,
  };
}

async function resolveAccount(
  tx: Tx, client: string, chart: string, event: string, valuationClass: string,
): Promise<string> {
  const rows = await tx.select().from(accountDetermination).where(and(
    eq(accountDetermination.client, client),
    eq(accountDetermination.chartOfAccounts, chart),
    eq(accountDetermination.event, event),
  ));
  const row = rows.find((r) => r.valuationClass === valuationClass) ?? rows.find((r) => r.valuationClass === '');
  if (!row) {
    throw new GoodsIssueError(
      `Account determination for ${event}${valuationClass ? ` and valuation class ${valuationClass}` : ''} does not stand in chart ${chart}.`,
      'Maintain the account determination for this event, then post again.',
    );
  }
  return row.glAccount;
}

async function existingByRequestKey(tx: Tx, client: string, requestKey: string) {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.requestKey, requestKey),
  ));
  if (!header) return null;
  return toView(tx, client, header);
}

async function toView(
  tx: Tx, client: string, header: typeof materialDocument.$inferSelect,
  prepared: Array<{ line?: GoodsIssueLineInput; reservationOpenAfter?: string | null }> = [],
): Promise<GoodsIssueView> {
  const lines = await tx.select().from(materialDocumentLine).where(and(
    eq(materialDocumentLine.client, client),
    eq(materialDocumentLine.materialDocumentNumber, header.materialDocumentNumber),
  )).orderBy(materialDocumentLine.lineNumber);
  const [plantRow] = await tx.select().from(plantTable).where(and(
    eq(plantTable.client, client), eq(plantTable.plant, lines[0]?.plant ?? ''),
  ));
  const scenario = GOODS_ISSUE_SCENARIOS.find((s) => s.movementType === lines[0]?.movementType);

  return {
    materialDocumentNumber: header.materialDocumentNumber,
    documentYear: header.documentYear,
    postingDate: header.postingDate,
    documentDate: header.documentDate,
    movementType: lines[0]?.movementType ?? '',
    movementCode: scenario?.code ?? '',
    journalDocumentNumber: header.journalDocumentNumber,
    companyCode: plantRow?.companyCode ?? '',
    totalValue: lines.reduce((sum, l) => sum + Number(l.value), 0).toFixed(2),
    lines: lines.map((l, index) => ({
      lineNumber: l.lineNumber,
      movementType: l.movementType,
      materialNumber: l.materialNumber,
      plant: l.plant,
      storageLocation: l.storageLocation,
      quantity: l.baseQuantity,
      unit: l.baseUnit,
      value: l.value,
      costCenter: prepared[index]?.line?.costCenter?.trim() || null,
      reservationNumber: prepared[index]?.line?.reservationNumber ?? null,
      reservationItem: prepared[index]?.line?.reservationItem ?? null,
      reservationOpenAfter: prepared[index]?.reservationOpenAfter ?? null,
      productionOrderNumber: prepared[index]?.productionOrderNumber ?? null,
      productionOrderItem: prepared[index]?.productionOrderItem ?? null,
      orderOpenAfter: prepared[index]?.orderOpenAfter ?? null,
    })),
  };
}

/**
 * Post a goods issue. One transaction: the stock, the valuation, the journal, the
 * material document, the reservation's withdrawn quantity and the document's
 * output all commit together or not at all.
 */
/**
 * `options.tx` runs the posting inside a transaction the caller already holds — the
 * shape CO11N needs so a confirmation and the movements it caused commit together.
 * The caller's transaction must already be scoped to `input.client`; that is what
 * `withTenant` does for a caller that holds none, and it is the same contract
 * `createProductionOrder` follows.
 */
export async function postGoodsIssue(
  input: PostGoodsIssueInput,
  screen: 'MB1A' | 'MIGO' = 'MB1A',
  options?: { tx?: Tx },
): Promise<GoodsIssueView> {
  requireDate(input.postingDate, 'The posting date');
  requireDate(input.documentDate, 'The document date');
  if ((input.headerText ?? '').length > 25) {
    throw new GoodsIssueError('The header text is longer than 25 characters.', 'Shorten the header text.');
  }
  if (input.lines.length === 0) {
    throw new GoodsIssueError('No issue lines were entered.', 'Enter at least one material to issue.');
  }
  const scenario = resolveScenario(input.movementTypeCode, screen);
  const fingerprint = postingFingerprint([
    'GI', scenario.code, input.postingDate, input.documentDate, input.headerText ?? '',
    ...[...input.lines].map((line) => [
      line.materialNumber.trim().toUpperCase(), line.plant.trim(), line.storageLocation ?? '',
      quantityToken(line.quantity), line.entryUnit ?? '', line.costCenter ?? '',
      line.reservationNumber ?? '', line.reservationItem ?? '',
      line.productionOrderNumber ?? '', line.productionOrderItem ?? '',
      (line.batch ?? '').trim().toUpperCase(),
    ].join(':')).sort(),
  ]);

  const run = async (tx: Tx): Promise<GoodsIssueView> => {
    await lockRequestKey(tx, input.client, input.requestKey);
    const replay = await existingByRequestKey(tx, input.client, input.requestKey);
    if (replay) {
      const mismatch = await mismatchedRequest(tx, input.client, input.requestKey, fingerprint);
      if (mismatch) throw new GoodsIssueError(mismatch, REQUEST_MISMATCH_REMEDY);
      return replay;
    }

    await ensureMovements(tx, input.client, input.changedBy);
    const refused = await batchClassificationRefusal(tx, input.client, scenario.movementType);
    if (refused) throw new GoodsIssueError(refused.message, refused.remedy);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`${input.client}/gi`}, 0))`);
    await lockStockScope(
      tx, input.client,
      [...new Set(input.lines.map((line) => line.materialNumber.trim()).filter(Boolean))].sort(),
      'EXCLUSIVE',
    );

    // Every line must stand in one company code: a goods issue writes one journal.
    const companies = new Set<string>();
    for (const line of input.lines) {
      if (!(line.quantity > 0)) {
        throw new GoodsIssueError(
          `Line ${line.materialNumber}: the issue quantity must be positive.`,
          'Enter a quantity greater than zero.',
        );
      }
      const [plantRow] = await tx.select().from(plantTable).where(and(
        eq(plantTable.client, input.client), eq(plantTable.plant, line.plant),
      ));
      if (!plantRow) throw new GoodsIssueError(`Plant ${line.plant} does not exist.`);
      if (!plantRow.companyCode) {
        throw new GoodsIssueError(`Plant ${line.plant} carries no company code.`, 'Maintain the plant first.');
      }
      companies.add(plantRow.companyCode);
    }
    if (companies.size > 1) {
      throw new GoodsIssueError(
        `The lines stand in ${companies.size} company codes (${[...companies].sort().join(', ')}), and a goods issue writes one journal.`,
        'Post one issue per company code.',
      );
    }
    const companyCode = [...companies][0];

    const company = await getCompanyCode(tx, input.client, companyCode);
    if (!company?.fiscalYearVariant) {
      throw new GoodsIssueError(`Company code ${companyCode} is not configured.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant, input.postingDate);

    // A goods issue posts a journal, so the material period judges it.
    const mmRecord = await getMaterialPeriodControlInTx(tx, input.client, companyCode);
    if (!materialPeriodAllows(mmRecord, position.fiscalYear, position.period)) {
      throw new GoodsIssueError(
        `The material posting period ${position.fiscalYear}/${position.period} is closed for company ${companyCode}.`,
        'Post into the open material period, or shift the material period first.',
      );
    }

    const chart = company.chartOfAccounts as string;
    const inventoryAccountCache = new Map<string, string>();
    const expenseAccountCache = new Map<string, string>();

    type Prepared = {
      line: GoodsIssueLineInput;
      materialNumber: string;
      storageLocation: string | null;
      quantity: number;
      unit: string;
      value: number;
      valuation: typeof materialValuation.$inferSelect;
      unitPrice: string;
      priceUnit: string;
      batch: string;
      reservationOpenAfter: string | null;
      productionOrderNumber: string | null;
      productionOrderItem: number | null;
      orderOpenAfter: string | null;
    };
    const prepared: Prepared[] = [];
    const claimedStock = new Map<string, number>();

    for (const line of input.lines) {
      const materialNumber = line.materialNumber.trim();
      if (!materialNumber) throw new GoodsIssueError('A material is required on every line.');

      const [mat] = await tx.select().from(material).where(and(
        eq(material.client, input.client), eq(material.materialNumber, materialNumber),
      ));
      if (!mat) throw new GoodsIssueError(`Material ${materialNumber} does not exist.`);
      if (mat.markedForDeletion) {
        throw new GoodsIssueError(`Material ${materialNumber} is flagged for deletion.`, 'Cancel the deletion flag, then post again.');
      }
      const [ext] = await tx.select().from(materialPlant).where(and(
        eq(materialPlant.client, input.client),
        eq(materialPlant.materialNumber, materialNumber),
        eq(materialPlant.plant, line.plant),
      ));
      if (!ext) throw new GoodsIssueError(`Material ${materialNumber} is not extended to plant ${line.plant}.`);
      if (ext.markedForDeletion) {
        throw new GoodsIssueError(
          `Material ${materialNumber} is flagged for deletion in plant ${line.plant}.`,
          'Cancel the plant deletion flag, then post again.',
        );
      }
      if (!mat.baseUnit) {
        throw new GoodsIssueError(`Material ${materialNumber} carries no base unit.`, 'Maintain the base unit of measure.');
      }

      // SCR-139: a 261 consumes for a released or technically completed order, and no more than the component still needs.
      let productionOrderNumber: string | null = null;
      let productionOrderItem: number | null = null;
      let orderOpenAfter: string | null = null;
      let documentLocation: string | null = null;
      if (scenario.accountAssignment === 'ORDER') {
        const orderNumber = (line.productionOrderNumber ?? '').trim();
        if (!orderNumber) {
          throw new GoodsIssueError(
            `Movement ${scenario.code} consumes for a production order, and none was named on ${materialNumber}.`,
            'Name the released order the component is issued to.',
          );
        }
        const itemNumber = line.productionOrderItem ?? 0;
        if (!itemNumber) {
          throw new GoodsIssueError(
            `Order ${orderNumber}: the component item was not named on the line for ${materialNumber}.`,
            'Name the component item the issue satisfies.',
          );
        }
        const [order] = await tx.select().from(productionOrder).where(and(
          eq(productionOrder.client, input.client), eq(productionOrder.orderNumber, orderNumber),
        ));
        if (!order) {
          throw new GoodsIssueError(
            `Production order ${orderNumber} does not exist.`,
            'Create the order first (CO01), then issue its components.',
          );
        }
        // Technical completion does not copy the closed-order posting ban. A created order still cannot be charged.
        if (order.status !== 'RELEASED' && order.status !== 'TECHNICALLY_COMPLETED') {
          if (order.status !== 'CREATED') {
            throw new GoodsIssueError(
              `Status ${order.status} is not a production-order status. Nothing was posted.`,
              'The stored status is unsupported. It was not treated as created.',
            );
          }
          throw new GoodsIssueError(
            `Production order ${orderNumber} stands ${order.status.toLowerCase()}, and only a released order may be charged.`,
            'Release the order, then post the component issue.',
          );
        }
        const [component] = await tx.select().from(productionOrderComponent).where(and(
          eq(productionOrderComponent.client, input.client),
          eq(productionOrderComponent.orderNumber, orderNumber),
          eq(productionOrderComponent.itemNumber, itemNumber),
        ));
        if (!component) {
          throw new GoodsIssueError(
            `Production order ${orderNumber} carries no component item ${itemNumber}.`,
            'Issue a component the order states.',
          );
        }
        documentLocation = component.storageLocation;
        if (component.materialNumber !== materialNumber || component.plant !== line.plant) {
          throw new GoodsIssueError(
            `Order ${orderNumber} item ${itemNumber} requires ${component.materialNumber} in plant ${component.plant}, and the line issues ${materialNumber} from ${line.plant}.`,
            'Issue the component the order states, from the plant it states.',
          );
        }
        // What the component still needs: required minus issues that still stand.
        // A reversed issue is not still issued. The comparison is in the component unit.
        const issuedRows = await tx.execute(sql`
          select coalesce(sum(l.base_quantity), 0)::text as issued
            from material_document_line l
            join material_document d
              on d.client = l.client and d.material_document_number = l.material_document_number
             and ${OPEN_PRODUCTION_DOCUMENT}
           where l.client = ${input.client}
             and l.production_order_number = ${orderNumber}
             and l.production_order_item = ${itemNumber}
             and l.material_number = ${materialNumber}
             and ${lineNotReversed('l')}
        `) as unknown as Array<{ issued: string }>;
        const required = Number(component.requiredQuantity);
        const issued = Number(issuedRows[0]?.issued ?? 0);
        const demanded = await toBaseQuantity(tx, input.client, {
          materialNumber, quantity: line.quantity, entryUnit: line.entryUnit,
        }).catch((caught: unknown) => {
          if (caught instanceof UnitConversionError) throw new GoodsIssueError(caught.message, caught.remedy);
          throw caught;
        });
        const sameUnit = !component.unitOfMeasure || component.unitOfMeasure === mat.baseUnit;
        const requiredBase = sameUnit
          ? required
          : (await toBaseQuantity(tx, input.client, {
            materialNumber, quantity: required, entryUnit: component.unitOfMeasure,
          }).catch((caught: unknown) => {
            if (caught instanceof UnitConversionError) throw new GoodsIssueError(caught.message, caught.remedy);
            throw caught;
          })).baseQuantity;
        const openBase = Math.max(0, requiredBase - issued);
        if (demanded.baseQuantity > openBase + 1e-9) {
          const unit = sameUnit ? component.unitOfMeasure : mat.baseUnit;
          throw new GoodsIssueError(
            `Order ${orderNumber} item ${itemNumber} still requires ${openBase.toFixed(3)} ${unit} of ${materialNumber}, and ${demanded.baseQuantity.toFixed(3)} was entered.`,
            'Reduce the quantity to what the component still requires; a tolerance master does not stand in canon.',
          );
        }
        productionOrderNumber = orderNumber;
        productionOrderItem = itemNumber;
        orderOpenAfter = Math.max(0, openBase - demanded.baseQuantity).toFixed(3);
      } else if ((line.productionOrderNumber ?? '').trim()) {
        throw new GoodsIssueError(
          `Movement ${scenario.code} consumes for no production order, and ${line.productionOrderNumber} was named on ${materialNumber}.`,
          'Clear the order reference on this line.',
        );
      }

      const reservationNumber = (line.reservationNumber ?? '').trim();
      if (!documentLocation && reservationNumber && line.reservationItem) {
        const [reserved] = await tx.select({ storageLocation: reservationItem.storageLocation }).from(reservationItem).where(and(
          eq(reservationItem.client, input.client),
          eq(reservationItem.reservationNumber, reservationNumber),
          eq(reservationItem.itemNumber, line.reservationItem),
        ));
        documentLocation = reserved?.storageLocation ?? null;
      }
      const required = await storageLocationRequired(tx, input.client, materialNumber, line.plant);
      let location;
      try {
        location = await resolveStorageLocation(tx, {
          client: input.client,
          plant: line.plant,
          typed: line.storageLocation,
          documentDefault: documentLocation,
          applyPlantDefault: true,
          required,
          verb: 'Issue from',
        });
      } catch (caught) {
        if (caught instanceof StorageLocationError) throw new GoodsIssueError(caught.message, caught.remedy);
        throw caught;
      }
      const issuingLocation = location.storageLocation;
      try {
        await assertInventoryCountOpen(tx, input.client, {
          materialNumber, plant: line.plant, storageLocation: issuingLocation || null,
          batch: line.batch,
        });
      } catch (caught) {
        if (caught instanceof PhysicalInventoryError) throw new GoodsIssueError(caught.message, caught.remedy);
        throw caught;
      }

      const [valuation] = await tx.select().from(materialValuation).where(and(
        eq(materialValuation.client, input.client),
        eq(materialValuation.materialNumber, materialNumber),
        eq(materialValuation.valuationArea, line.plant),
      ));
      if (!valuation || !valuation.valuationClass) {
        throw new GoodsIssueError(
          `Material ${materialNumber} carries no valuation class in plant ${line.plant}.`,
          'Complete the material valuation data, then post again.',
        );
      }
      const classRefusal = await postingValuationRefusal(tx, input.client, materialNumber, valuation.valuationClass);
      if (classRefusal) {
        throw new GoodsIssueError(classRefusal, 'Maintain a valuation class this material type permits, then post again.');
      }

      let postingBatch = '';
      try {
        postingBatch = await resolvePostingBatch(tx, {
          client: input.client, materialNumber, plant: line.plant, batch: line.batch, postingDate: input.postingDate,
        });
      } catch (caught) {
        if (caught instanceof BatchPostingError) throw new GoodsIssueError(caught.message, caught.remedy);
        throw caught;
      }

      // Sufficiency, on the location's own terms (SCR-131).
      const [stock] = await tx.select().from(stockQuantity).where(and(
        eq(stockQuantity.client, input.client),
        eq(stockQuantity.materialNumber, materialNumber),
        eq(stockQuantity.plant, line.plant),
        eq(stockQuantity.storageLocation, issuingLocation),
        eq(stockQuantity.stockType, 'UNRESTRICTED'),
        eq(stockQuantity.batchNumber, postingBatch),
      ));
      const onHand = Number(stock?.quantity ?? 0);
      const price = valuation.priceControl === 'STANDARD'
        ? Number(valuation.standardPrice) / Number(valuation.priceUnit)
        : Number(valuation.movingAveragePrice) / Number(valuation.priceUnit);

      // The cost centre only where the movement demands one.
      if (scenario.accountAssignment === 'COST_CENTER') {
        const centre = (line.costCenter ?? '').trim();
        if (!centre) {
          throw new GoodsIssueError(
            `Movement ${scenario.code} charges a cost centre, and none was named on ${materialNumber}.`,
            'Name the cost centre the issue is charged to.',
          );
        }
        const rows = await tx.execute(sql`
          select cost_center, valid_from::text as valid_from, valid_to::text as valid_to, is_posting_locked, company_code
          from cost_center
          where client = ${input.client} and cost_center = ${centre} order by valid_from desc
        `) as unknown as Array<{
          cost_center: string; valid_from: string; valid_to: string;
          is_posting_locked: boolean; company_code: string;
        }>;
        const standing = rows.find((r) => r.company_code === companyCode);
        if (!standing) {
          throw new GoodsIssueError(
            `Cost centre ${centre} does not stand in company code ${companyCode}.`,
            'Name a cost centre of the company the issue posts in.',
          );
        }
        if (input.postingDate < standing.valid_from || input.postingDate > standing.valid_to) {
          throw new GoodsIssueError(
            `Cost centre ${centre} is not valid on ${input.postingDate}.`,
            `It stands from ${standing.valid_from} to ${standing.valid_to}.`,
          );
        }
        if (standing.is_posting_locked) {
          throw new GoodsIssueError(
            `Cost centre ${centre} is locked for postings.`,
            'Unlock the cost centre, or name another.',
          );
        }
      } else if ((line.costCenter ?? '').trim()) {
        throw new GoodsIssueError(
          `Movement ${scenario.code} carries no account assignment, and a cost centre was named on ${materialNumber}.`,
          'Clear the cost centre; a scrapping charges no controlling object.',
        );
      }

      let reservationOpenAfter: string | null = null;
      if (line.reservationNumber) {
        const withdrawn = await withdrawReservationInTx(tx, {
          client: input.client,
          changedBy: input.changedBy,
          reservationNumber: line.reservationNumber.trim(),
          itemNumber: line.reservationItem ?? 0,
          quantity: line.quantity,
        });
        const item = withdrawn.items.find((i) => i.itemNumber === (line.reservationItem ?? 0));
        if (!item) {
          throw new GoodsIssueError(
            `Item ${line.reservationItem ?? '(none)'} does not stand on reservation ${line.reservationNumber}.`,
          );
        }
        if (item.materialNumber !== materialNumber || item.plant !== line.plant) {
          throw new GoodsIssueError(
            `Reservation ${line.reservationNumber} item ${item.itemNumber} stands for ${item.materialNumber} in plant ${item.plant}, and the line issues ${materialNumber} from ${line.plant}.`,
            'Issue the reserved material from its reserved plant.',
          );
        }
        reservationOpenAfter = item.openQuantity;
      }

      // SCR-144: the typed unit is converted, or the line is refused by name.
      const conversion = await toBaseQuantity(tx, input.client, {
        materialNumber, quantity: line.quantity, entryUnit: line.entryUnit,
      }).catch((caught: unknown) => {
        if (caught instanceof UnitConversionError) throw new GoodsIssueError(caught.message, caught.remedy);
        throw caught;
      });
      const value = round2(conversion.baseQuantity * price);
      const claimKey = `${materialNumber}|${line.plant}|${issuingLocation}|UNRESTRICTED|${postingBatch}`;
      const alreadyClaimed = claimedStock.get(claimKey) ?? 0;
      if (!location.row?.allowNegativeStock && onHand + 1e-9 < conversion.baseQuantity + alreadyClaimed) {
        throw new GoodsIssueError(
          `Storage location ${issuingLocation || '(none)'} in plant ${line.plant} carries ${onHand.toFixed(3)} ${mat.baseUnit} of ${materialNumber}, and ${(conversion.baseQuantity + alreadyClaimed).toFixed(3)} was entered.`,
          'Reduce the quantity to what stands, or allow negative stock on the location.',
        );
      }
      claimedStock.set(claimKey, alreadyClaimed + conversion.baseQuantity);

      prepared.push({
        line, materialNumber, storageLocation: issuingLocation || null, batch: postingBatch,
        quantity: conversion.baseQuantity, unit: conversion.baseUnit, value, valuation,
        entryQuantity: line.quantity, entryUnit: line.entryUnit ?? conversion.baseUnit,
        unitPrice: valuation.priceControl === 'STANDARD' ? valuation.standardPrice : valuation.movingAveragePrice,
        priceUnit: valuation.priceUnit,
        reservationOpenAfter,
        productionOrderNumber, productionOrderItem, orderOpenAfter,
      });
    }

    const journalLines: Array<{
      glAccount: string; debitCredit: 'S' | 'H'; amount: string;
      costCenter?: string; material?: string; plant?: string;
    }> = [];
    for (const p of prepared) {
      const cacheKey = `${p.valuation.valuationClass}`;
      if (!inventoryAccountCache.has(cacheKey)) {
        inventoryAccountCache.set(cacheKey, await resolveAccount(
          tx, input.client, chart, 'INVENTORY', p.valuation.valuationClass!,
        ));
      }
      if (!expenseAccountCache.has(cacheKey)) {
        expenseAccountCache.set(cacheKey, await resolveAccount(
          tx, input.client, chart, scenario.expenseEvent, p.valuation.valuationClass!,
        ));
      }
      journalLines.push({
        glAccount: inventoryAccountCache.get(cacheKey)!,
        debitCredit: 'H', amount: p.value.toFixed(2),
        material: p.materialNumber, plant: p.line.plant,
      });
      journalLines.push({
        glAccount: expenseAccountCache.get(cacheKey)!,
        debitCredit: 'S', amount: p.value.toFixed(2),
        costCenter: scenario.accountAssignment === 'COST_CENTER' ? p.line.costCenter : undefined,
        productionOrder: p.productionOrderNumber ?? undefined,
        material: p.materialNumber, plant: p.line.plant,
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
      documentDate: input.documentDate,
      postingDate: input.postingDate,
      fiscalYear: position.fiscalYear,
      postingPeriod: position.period,
      currency: company.currency,
      localCurrency: company.currency,
      reference: scenario.code,
      headerText: input.headerText,
      lines: journalLines,
      origin: { documentClass: MATERIAL_DOCUMENT_CLASS, documentKey: number },
      postedBy: input.changedBy,
      transactionCode: GOODS_ISSUE_CAPABILITY,
    }).catch((error: unknown) => {
      if (error instanceof PostingError) throw new GoodsIssueError(error.message, error.remedy);
      throw error;
    });

    await tx.insert(materialDocument).values({
      client: input.client, materialDocumentNumber: number, documentYear: position.fiscalYear,
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
        movementType: scenario.movementType,
        materialNumber: p.materialNumber, plant: p.line.plant,
        storageLocation: p.storageLocation, stockType: 'UNRESTRICTED',
        batchNumber: p.batch,
        lineDirection: 'ISSUE',
        entryQuantity: String(p.entryQuantity ?? p.quantity), entryUnit: p.entryUnit ?? p.unit,
        baseQuantity: String(p.quantity), baseUnit: p.unit,
        unitPrice: p.unitPrice, priceUnit: p.priceUnit, currency: company.currency,
        value: String(p.value),
        productionOrderNumber: p.productionOrderNumber,
        productionOrderItem: p.productionOrderItem,
        createdBy: input.changedBy,
      });

      // Stock falls at the issuing location; a location with no row is the empty one.
      await tx.execute(sql`
        insert into stock_quantity (client, material_number, plant, storage_location, stock_type, batch_number, quantity, created_by)
        values (${input.client}, ${p.materialNumber}, ${p.line.plant}, ${p.storageLocation ?? ''}, 'UNRESTRICTED',
                ${p.batch}, ${String(-p.quantity)}, ${input.changedBy})
        on conflict (client, material_number, plant, storage_location, stock_type, batch_number)
        do update set quantity = stock_quantity.quantity - ${p.quantity},
                      changed_by = ${input.changedBy}, changed_at = now()
      `);

      await applyValuationDelta(
        tx, input.client, input.changedBy, p.materialNumber, p.line.plant, -p.quantity, -p.value,
      );
    }

    await recordChange(tx, {
      client: input.client,
      objectClass: MATERIAL_DOCUMENT_CLASS,
      objectKey: number,
      changeType: 'CREATE',
      changedBy: input.changedBy,
      transactionCode: GOODS_ISSUE_CAPABILITY,
      after: {
        movement: scenario.movementType, issue: scenario.code,
        lines: prepared.length, journal: journal.documentNumber, status: 'POSTED',
        company: companyCode,
      },
    });
    await noteBatchControlUse(tx, input.client, number, input.changedBy);

    // SCR-135: the issue earns its slip, at the periodic cadence.
    await recordOutputsForPostedDocument(tx, input.client, number, input.changedBy);

    return toViewWithReservations(tx, input.client, number, prepared);
  };
  return options?.tx ? run(options.tx) : withTenant(input.client, run);
}

async function toViewWithReservations(
  tx: Tx, client: string, number: string,
  prepared: Array<{
    line: GoodsIssueLineInput; reservationOpenAfter: string | null;
    productionOrderNumber: string | null; productionOrderItem: number | null;
    orderOpenAfter: string | null;
  }>,
): Promise<GoodsIssueView> {
  const [header] = await tx.select().from(materialDocument).where(and(
    eq(materialDocument.client, client), eq(materialDocument.materialDocumentNumber, number),
  ));
  if (!header) throw new GoodsIssueError(`Material document ${number} does not exist after posting.`);
  return toView(tx, client, header, prepared);
}
