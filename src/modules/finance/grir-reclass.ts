/**
 * GR/IR clearing account analysis — SCR-099 / R-147 (F.19 as a
 * search alias only).
 *
 * Stage 1 vocabulary. The analysis service lands in stage 3.
 */
export const GRIR_RECLASS_CAPABILITY = 'FIN.GRIR.RECLASS';

export class GrIrReclassError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GrIrReclassError';
  }
}

export interface GrIrSelection {
  companyCode: string;
  keyDate: string;
  purchaseOrderFrom?: string;
  purchaseOrderTo?: string;
  postingDateFrom?: string;
  postingDateTo?: string;
  displayVariant?: string;
  testRun: boolean;
  createAccruals: boolean;
  postingDate?: string;
  reversalDate?: string;
  accrualDocumentType?: string;
  accrualAccount?: string;
  requestKey: string;
}

export type GrIrClassification =
  | 'RECONCILED' | 'GOODS_RECEIVED_NOT_INVOICED' | 'INVOICED_NOT_RECEIVED'
  | 'QUANTITY_DIFFERENCE' | 'VALUE_DIFFERENCE';

export type GrIrItemStatus = 'ANALYZED' | 'ACCRUED' | 'SKIPPED' | 'ERROR';

export interface GrIrItem {
  itemNumber: number;
  purchaseOrder: string;
  purchaseOrderItem: number;
  vendor: string;
  material: string | null;
  plant: string;
  currency: string;
  orderedQuantity: number;
  receivedQuantity: number;
  invoicedQuantity: number;
  openQuantity: number;
  receivedValue: number;
  invoicedValue: number;
  openValue: number;
  classification: GrIrClassification;
  accrualAmount: number;
  status: GrIrItemStatus;
  error: string | null;
  accrualDocument: string | null;
}

export interface GrIrResult {
  runId: string;
  status: 'TEST' | 'COMPLETED' | 'REVERSED';
  companyCode: string;
  keyDate: string;
  fiscalYear: number;
  items: GrIrItem[];
  totalOpenValue: number;
  totalAccrualAmount: number;
  accrualDocument: string | null;
  reversalDocument: string | null;
  warnings: string[];
}

import { and, eq, sql } from 'drizzle-orm';

import { withTenant } from '../../platform/db/client';
import { derivePosition, getCompanyCode } from '../../platform/periods';
import { postJournalEntry, reverseJournalEntry, PostingError } from '../../platform/posting';
import { accountDetermination } from '../foundation/schema';
import { grirReclassItem, grirReclassRun } from './schema';

const round2 = (n: number) => Math.round(n * 100) / 100;
const round3 = (n: number) => Math.round(n * 1000) / 1000;
const TOLERANCE = 0.01;

function classify(openQty: number, openValue: number): GrIrClassification {
  const qtyOpen = Math.abs(openQty) > TOLERANCE;
  const valueOpen = Math.abs(openValue) > TOLERANCE;
  if (!qtyOpen && !valueOpen) return 'RECONCILED';
  if (!qtyOpen && valueOpen) return 'VALUE_DIFFERENCE';
  if (qtyOpen && !valueOpen) return 'QUANTITY_DIFFERENCE';
  if (openQty > 0 && openValue > 0) return 'GOODS_RECEIVED_NOT_INVOICED';
  if (openQty < 0 && openValue < 0) return 'INVOICED_NOT_RECEIVED';
  return 'QUANTITY_DIFFERENCE';
}

/**
 * Execute the GR/IR analysis for a judged selection. Analysis
 * never posts; accrual creation is a separate live step posting
 * the open value per item against the GR/IR clearing account,
 * atomically and only once per item and fiscal year.
 */
export async function executeGrIrAnalysis(input: {
  client: string; changedBy: string; selection: GrIrSelection;
}): Promise<GrIrResult> {
  const s = input.selection;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s.keyDate)) {
    throw new GrIrReclassError(`Key date ${s.keyDate} is not a calendar date.`);
  }
  if (s.postingDateFrom && s.postingDateTo && s.postingDateFrom > s.postingDateTo) {
    throw new GrIrReclassError('The posting-date range starts after it ends.');
  }
  if (!s.requestKey?.trim()) throw new GrIrReclassError('A request key is required.');
  const wantsAccrual = !s.testRun && s.createAccruals;
  if (wantsAccrual && (!s.postingDate || !s.accrualDocumentType || !s.accrualAccount)) {
    throw new GrIrReclassError(
      'Creating accruals requires a posting date, an accrual document type and an accrual G/L account.',
    );
  }

  return withTenant(input.client, async (tx) => {
    const [existing] = await tx.select().from(grirReclassRun).where(and(
      eq(grirReclassRun.client, input.client), eq(grirReclassRun.requestKey, s.requestKey),
    ));
    if (existing) {
      const replay = await loadRun(tx, input.client, existing.runId);
      if (replay) return replay;
    }

    const company = await getCompanyCode(tx, input.client, s.companyCode);
    if (!company?.isActive) {
      throw new GrIrReclassError(`Company code ${s.companyCode} is not active or does not exist.`);
    }
    const position = await derivePosition(tx, input.client, company.fiscalYearVariant!, s.keyDate)
      .catch((e: unknown) => { throw new GrIrReclassError(e instanceof Error ? e.message : 'Key date cannot be judged.'); });
    const chart = company.chartOfAccounts ?? '';

    const poFilter = sql`and (${s.purchaseOrderFrom ?? null}::varchar is null or po.order_number >= ${s.purchaseOrderFrom ?? null})
      and (${s.purchaseOrderTo ?? null}::varchar is null or po.order_number <= ${s.purchaseOrderTo ?? null})`;
    const raw = await tx.execute(sql`
      select po.order_number, poi.item_number, po.supplier_number, poi.material_number,
             poi.plant, po.currency, poi.quantity as ordered_qty,
             poi.net_price, poi.price_unit,
             coalesce(gr.qty, 0) as received_qty,
             coalesce(ir.qty, 0) as invoiced_qty,
             coalesce(ir.value, 0) as invoiced_value
      from purchase_order po
      join purchase_order_item poi
        on poi.client = po.client and poi.order_number = po.order_number
      left join (
        select l.purchase_order_number, l.purchase_order_item,
               sum(case when mt.direction = 'REVERSAL' then -l.base_quantity else l.base_quantity end) as qty
        from material_document_line l
        join material_document h
          on h.client = l.client and h.material_document_number = l.material_document_number
        join movement_type mt
          on mt.client = l.client and mt.movement_type = l.movement_type
        where l.client = ${input.client} and h.status = 'POSTED'
          and h.posting_date <= ${s.keyDate}
          and l.purchase_order_number is not null
        group by l.purchase_order_number, l.purchase_order_item
      ) gr on gr.purchase_order_number = po.order_number and gr.purchase_order_item = poi.item_number
      left join (
        select i.purchase_order_number, i.purchase_order_item,
               sum(case when h.category in ('CREDIT_MEMO', 'SUBSEQUENT_CREDIT') then -i.quantity else i.quantity end) as qty,
               sum(case when h.category in ('CREDIT_MEMO', 'SUBSEQUENT_CREDIT') then -i.net_amount else i.net_amount end) as value
        from supplier_invoice_item i
        join supplier_invoice h
          on h.client = i.client and h.invoice_number = i.invoice_number
        where i.client = ${input.client} and h.status = 'POSTED' and h.cancellation_of is null
          and h.posting_date <= ${s.keyDate}
        group by i.purchase_order_number, i.purchase_order_item
      ) ir on ir.purchase_order_number = po.order_number and ir.purchase_order_item = poi.item_number
      where po.client = ${input.client} and po.company_code = ${s.companyCode}
        ${poFilter}
      order by po.order_number, poi.item_number
    `);
    interface RowShape {
      order_number: string; item_number: number; supplier_number: string;
      material_number: string | null; plant: string; currency: string;
      ordered_qty: string; net_price: string; price_unit: string;
      received_qty: string; invoiced_qty: string; invoiced_value: string;
    }
    const rows = raw as unknown as RowShape[];

    const prior = await tx.execute(sql`
      select i.purchase_order, i.purchase_order_item
      from grir_reclass_item i
      join grir_reclass_run r on r.client = i.client and r.run_id = i.run_id
      where i.client = ${input.client} and r.company_code = ${s.companyCode}
        and r.fiscal_year = ${position.fiscalYear} and r.status <> 'REVERSED'
        and i.status = 'ACCRUED'
    `);
    const priorKeys = new Set((prior as unknown as Array<Record<string, unknown>>)
      .map((r) => `${r.purchase_order}|${r.purchase_order_item}`));

    const items: GrIrItem[] = rows.map((row, index) => {
      const receivedQty = round3(Number(row.received_qty));
      const invoicedQty = round3(Number(row.invoiced_qty));
      const receivedValue = round2((receivedQty * Number(row.net_price)) / Number(row.price_unit));
      const invoicedValue = round2(Number(row.invoiced_value));
      const openQuantity = round3(receivedQty - invoicedQty);
      const openValue = round2(receivedValue - invoicedValue);
      const classification = classify(openQuantity, openValue);
      const already = priorKeys.has(`${row.order_number}|${row.item_number}`);
      return {
        itemNumber: index + 1,
        purchaseOrder: row.order_number, purchaseOrderItem: row.item_number,
        vendor: row.supplier_number, material: row.material_number, plant: row.plant,
        currency: row.currency, orderedQuantity: Number(row.ordered_qty),
        receivedQuantity: receivedQty, invoicedQuantity: invoicedQty, openQuantity,
        receivedValue, invoicedValue, openValue, classification,
        accrualAmount: 0,
        status: wantsAccrual && already && classification !== 'RECONCILED' ? 'SKIPPED' : 'ANALYZED',
        error: wantsAccrual && already && classification !== 'RECONCILED'
          ? 'Already accrued for this fiscal year; reverse the earlier accrual to repost.'
          : null,
        accrualDocument: null,
      };
    });

    const warnings: string[] = [];
    if (s.displayVariant) {
      warnings.push(`Display variant ${s.displayVariant} is not configured; the delivered grouping (purchase order, then item) stands.`);
    }
    const totalOpenValue = round2(items.reduce((sum, i) => sum + i.openValue, 0));

    const runId = `GR${Date.now().toString(36).toUpperCase()}`.slice(0, 24);
    await tx.insert(grirReclassRun).values({
      client: input.client, runId, requestKey: s.requestKey,
      companyCode: s.companyCode, fiscalYear: position.fiscalYear, keyDate: s.keyDate,
      postingDate: s.postingDate ?? null, reversalDate: s.reversalDate ?? null,
      isTestRun: s.testRun, createAccruals: s.createAccruals,
      status: s.testRun ? 'TEST' : 'COMPLETED',
      createdBy: input.changedBy, completedAt: s.testRun ? null : new Date(),
    });

    let accrualDocument: string | null = null;
    let reversalDocument: string | null = null;
    let totalAccrual = 0;
    if (wantsAccrual) {
      const eligible = items.filter((i) => i.status === 'ANALYZED' && i.classification !== 'RECONCILED' && Math.abs(i.openValue) > TOLERANCE);
      if (eligible.length > 0) {
        const [determination] = await tx.select().from(accountDetermination).where(and(
          eq(accountDetermination.client, input.client),
          eq(accountDetermination.chartOfAccounts, chart),
          eq(accountDetermination.event, 'GR_IR_CLEARING'),
        ));
        if (!determination) {
          throw new GrIrReclassError(`Account determination for GR_IR_CLEARING does not stand in chart ${chart}.`);
        }
        const lines: Array<{ glAccount: string; debitCredit: 'S' | 'H'; amount: string; lineText?: string }> = [];
        for (const item of eligible) {
          const amount = Math.abs(item.openValue).toFixed(2);
          const grirSide = item.openValue > 0 ? 'S' : 'H';
          lines.push({ glAccount: determination.glAccount, debitCredit: grirSide as 'S' | 'H', amount, lineText: `GR/IR ${item.purchaseOrder}/${item.purchaseOrderItem}` });
          lines.push({ glAccount: s.accrualAccount!, debitCredit: grirSide === 'S' ? 'H' : 'S', amount, lineText: 'GR/IR accrual' });
          item.accrualAmount = item.openValue;
          totalAccrual = round2(totalAccrual + item.openValue);
        }
        const accrualPosition = await derivePosition(tx, input.client, company.fiscalYearVariant!, s.postingDate!)
          .catch((e: unknown) => { throw new GrIrReclassError(e instanceof Error ? e.message : 'Posting date cannot be judged.'); });
        const posted = await postJournalEntry(tx, {
          client: input.client, companyCode: s.companyCode, documentType: s.accrualDocumentType!,
          documentDate: s.postingDate!, postingDate: s.postingDate!,
          fiscalYear: accrualPosition.fiscalYear, postingPeriod: accrualPosition.period,
          currency: company.currency, localCurrency: company.currency,
          headerText: `GR/IR accrual ${s.keyDate}`,
          lines, postedBy: input.changedBy, transactionCode: GRIR_RECLASS_CAPABILITY,
        }).catch((error: unknown) => {
          if (error instanceof PostingError) throw new GrIrReclassError(`${error.message} ${error.remedy}`);
          throw error;
        });
        accrualDocument = posted.documentNumber;
        for (const item of eligible) {
          item.status = 'ACCRUED';
          item.accrualDocument = accrualDocument;
        }
        if (s.reversalDate) {
          const reversal = await reverseJournalEntry(tx, {
            client: input.client, documentNumber: accrualDocument, fiscalYear: accrualPosition.fiscalYear,
            reversalDate: s.reversalDate, reason: `GR/IR accrual reversal ${runId}`,
            reversedBy: input.changedBy, transactionCode: GRIR_RECLASS_CAPABILITY,
          }).catch((error: unknown) => {
            if (error instanceof PostingError) throw new GrIrReclassError(`${error.message} ${error.remedy}`);
            throw error;
          });
          reversalDocument = reversal.documentNumber;
        }
      }
    }

    for (const item of items) {
      await tx.insert(grirReclassItem).values({
        client: input.client, runId, companyCode: s.companyCode, fiscalYear: position.fiscalYear,
        itemNumber: item.itemNumber, purchaseOrder: item.purchaseOrder,
        purchaseOrderItem: item.purchaseOrderItem, vendor: item.vendor,
        material: item.material, plant: item.plant, currency: item.currency,
        orderedQuantity: String(item.orderedQuantity), receivedQuantity: String(item.receivedQuantity),
        invoicedQuantity: String(item.invoicedQuantity), openQuantity: String(item.openQuantity),
        receivedValue: String(item.receivedValue), invoicedValue: String(item.invoicedValue),
        openValue: String(item.openValue), classification: item.classification,
        accrualAmount: String(item.accrualAmount), accrualDocument: item.accrualDocument,
        status: item.status, error: item.error,
      });
    }
    if (accrualDocument || totalAccrual !== 0) {
      await tx.update(grirReclassRun).set({
        totalAccrualAmount: String(totalAccrual), accrualDocumentNumber: accrualDocument,
        reversalDocumentNumber: reversalDocument, status: reversalDocument ? 'REVERSED' : 'COMPLETED',
      }).where(and(eq(grirReclassRun.client, input.client), eq(grirReclassRun.runId, runId)));
    }

    return {
      runId, status: reversalDocument ? 'REVERSED' : s.testRun ? 'TEST' : 'COMPLETED',
      companyCode: s.companyCode, keyDate: s.keyDate, fiscalYear: position.fiscalYear,
      items, totalOpenValue, totalAccrualAmount: totalAccrual,
      accrualDocument, reversalDocument, warnings,
    };
  });
}

type TxLike = Parameters<Parameters<typeof withTenant>[1]>[0];

async function loadRun(tx: TxLike, client: string, runId: string): Promise<GrIrResult | null> {
  const [run] = await tx.select().from(grirReclassRun).where(and(
    eq(grirReclassRun.client, client), eq(grirReclassRun.runId, runId),
  ));
  if (!run) return null;
  const items = await tx.select().from(grirReclassItem).where(and(
    eq(grirReclassItem.client, client), eq(grirReclassItem.runId, runId),
  )).orderBy(grirReclassItem.itemNumber);
  return {
    runId: run.runId, status: run.status as GrIrResult['status'],
    companyCode: run.companyCode, keyDate: run.keyDate, fiscalYear: run.fiscalYear,
    items: items.map((i) => ({
      itemNumber: i.itemNumber, purchaseOrder: i.purchaseOrder, purchaseOrderItem: i.purchaseOrderItem,
      vendor: i.vendor, material: i.material, plant: i.plant, currency: i.currency,
      orderedQuantity: Number(i.orderedQuantity), receivedQuantity: Number(i.receivedQuantity),
      invoicedQuantity: Number(i.invoicedQuantity), openQuantity: Number(i.openQuantity),
      receivedValue: Number(i.receivedValue), invoicedValue: Number(i.invoicedValue),
      openValue: Number(i.openValue), classification: i.classification as GrIrClassification,
      accrualAmount: Number(i.accrualAmount), status: i.status as GrIrItemStatus,
      error: i.error, accrualDocument: i.accrualDocument,
    })),
    totalOpenValue: round2(items.reduce((sum, i) => sum + Number(i.openValue), 0)),
    totalAccrualAmount: Number(run.totalAccrualAmount),
    accrualDocument: run.accrualDocumentNumber, reversalDocument: run.reversalDocumentNumber,
    warnings: [],
  };
}

export async function getGrIrRun(client: string, runId: string): Promise<GrIrResult | null> {
  return withTenant(client, async (tx) => loadRun(tx, client, runId));
}

export function grIrCsv(result: GrIrResult): string {
  const esc = (v: string | number | null) => {
    const s = v === null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = 'Item,Purchase Order,PO Item,Vendor,Material,Plant,Currency,Ordered Qty,Received Qty,Invoiced Qty,Open Qty,Received Value,Invoiced Value,Open Value,Classification,Accrual Amount,Status,Error,Accrual Document';
  const lines = result.items.map((i) => [
    i.itemNumber, i.purchaseOrder, i.purchaseOrderItem, i.vendor, i.material ?? '', i.plant, i.currency,
    i.orderedQuantity, i.receivedQuantity, i.invoicedQuantity, i.openQuantity,
    i.receivedValue, i.invoicedValue, i.openValue, i.classification, i.accrualAmount,
    i.status, i.error ?? '', i.accrualDocument ?? '',
  ].map(esc).join(','));
  return [header, ...lines].join('\n') + '\n';
}
