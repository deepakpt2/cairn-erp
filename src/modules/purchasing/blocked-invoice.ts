/**
 * Release a blocked invoice — SCR-162 / PROC.INV.BLOCK.RELEASE.
 *
 * A manual hold stands on a posted supplier invoice. The payable is the
 * supplier line of that invoice's journal. The payment run reads the same
 * hold and leaves the line out. A release clears the hold and appends an
 * event. It does not post, clear, or change the invoice amount.
 *
 * Invoice verification does not block a payment. No tolerance stands, so a
 * price block and a quantity block are refused by name. A check writes nothing.
 */
import { sql } from 'drizzle-orm';

import { recordChange } from '../../platform/change';
import { withTenant, type Tx } from '../../platform/db/client';

export const BLOCKED_INVOICE_CAPABILITY = 'PROC.INV.BLOCK.RELEASE';
export const BLOCKED_INVOICE_HOLD_CAPABILITY = 'PROC.INV.BLOCK';
export const BLOCKED_INVOICE_ROUTE = '/purchasing/blocked-invoice';
export const BLOCKED_INVOICE_ALIASES = ['MRBR'] as const;
export const MANUAL_REASON = 'MANUAL';

export class BlockedInvoiceError extends Error {
  remedy?: string;

  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'BlockedInvoiceError';
    this.remedy = remedy;
  }
}

function fail(message: string, remedy?: string): never {
  throw new BlockedInvoiceError(message, remedy);
}

function named(value: string | undefined): string {
  return (value ?? '').trim();
}

export interface BlockedInvoiceInput {
  client: string;
  changedBy: string;
  invoiceNumber: string;
  comment?: string;
  requestKey?: string;
  expectedVersion?: number;
  reason?: string;
  price?: string;
  quantity?: string;
  quality?: string;
  approval?: string;
  post?: string;
  clear?: string;
  export?: string;
  batch?: string;
  evaluationDate?: string;
  paymentRun?: string;
}

export type PaymentState = 'OPEN' | 'PROPOSAL' | 'PAID';

export interface BlockedInvoiceRow {
  invoiceNumber: string;
  fiscalYear: number;
  companyCode: string;
  supplierNumber: string;
  supplierName: string;
  reference: string;
  purchaseOrderNumber: string;
  purchasingOrg: string | null;
  postingDate: string;
  grossAmount: string;
  currency: string;
  journalDocumentNumber: string | null;
  active: boolean;
  version: number;
  comment: string;
  createdBy: string;
  paymentState: PaymentState;
  proposalRun: string | null;
  varianceAmount: string;
  invoicedQuantity: string;
}

export interface BlockedInvoicePreview {
  invoiceNumber: string;
  wouldWrite: false;
  eligible: boolean;
  message: string;
  paymentState: PaymentState;
  active: boolean;
}

export interface BlockEventRow {
  eventId: number;
  invoiceNumber: string;
  reason: string;
  action: string;
  outcome: string;
  actor: string;
  comment: string;
  previousActive: boolean;
  resultingActive: boolean;
  createdAt: string;
}

export interface BlockedInvoiceResult {
  invoiceNumber: string;
  active: boolean;
  version: number;
  wrote: boolean;
  outcome: 'HELD' | 'RELEASED';
}

interface InvoiceRow {
  invoice_number: string;
  fiscal_year: number;
  status: string;
  cancellation_of: string | null;
  cancelled_by: string | null;
  supplier_number: string;
  company_code: string;
  purchase_order_number: string;
  supplier_reference: string;
  currency: string;
  gross_amount: string;
  posting_date: string;
  journal_document_number: string | null;
}

interface BlockRow {
  invoice_number: string;
  reason: string;
  journal_document_number: string;
  active: boolean;
  comment: string;
  version: number;
}

function refuseAbsent(input: BlockedInvoiceInput) {
  if (named(input.price)) {
    fail(
      'A price block is not on this screen.',
      'Invoice verification does not block a payment. No tolerance stands to judge a price difference.',
    );
  }
  if (named(input.quantity)) {
    fail(
      'A quantity block is not on this screen.',
      'Invoice verification does not block a payment. No tolerance stands to judge a quantity difference.',
    );
  }
  if (named(input.quality)) {
    fail('A quality block is not on this screen.', 'It is not stored as a manual hold.');
  }
  const reason = named(input.reason).toUpperCase();
  if (reason && reason !== MANUAL_REASON) {
    fail(
      `Block reason ${reason} is not on this screen.`,
      'The only hold is manual. A price block and a quantity block are not generated.',
    );
  }
  if (named(input.approval)) fail('An approval is not on this screen.');
  if (named(input.post) || named(input.clear)) {
    fail('This screen does not post a journal, and it does not clear an open item.');
  }
  if (named(input.export)) fail('This screen does not export.');
  if (named(input.batch)) {
    fail('A batch release is not this screen.', 'Release one invoice. The result names that invoice.');
  }
  if (named(input.evaluationDate)) {
    fail('An evaluation date is not an input.', 'The release uses the invoice and the open item as they stand.');
  }
  if (named(input.paymentRun)) {
    fail('This screen does not execute a payment.', 'The payment run reads the hold. It is a different capability.');
  }
}

async function replay(tx: Tx, client: string, requestKey: string): Promise<BlockedInvoiceResult | null> {
  const [row] = await tx.execute(sql`
    select invoice_number, outcome, resulting_active
      from supplier_invoice_payment_block_event
     where client = ${client} and request_key = ${requestKey}
  `) as unknown as Array<{ invoice_number: string; outcome: 'HELD' | 'RELEASED'; resulting_active: boolean }>;
  if (!row) return null;
  const [block] = await tx.execute(sql`
    select version from supplier_invoice_payment_block
     where client = ${client} and invoice_number = ${row.invoice_number} and reason = ${MANUAL_REASON}
  `) as unknown as Array<{ version: number }>;
  return {
    invoiceNumber: row.invoice_number,
    active: row.resulting_active,
    version: Number(block?.version ?? 0),
    wrote: false,
    outcome: row.outcome,
  };
}

async function loadInvoice(tx: Tx, client: string, number: string): Promise<InvoiceRow | null> {
  const [row] = await tx.execute(sql`
    select invoice_number, fiscal_year, status, cancellation_of, cancelled_by,
           supplier_number, company_code, purchase_order_number, supplier_reference,
           currency, gross_amount::text, posting_date::text, journal_document_number
      from supplier_invoice
     where client = ${client} and invoice_number = ${number}
  `) as unknown as InvoiceRow[];
  return row ?? null;
}

async function loadBlock(tx: Tx, client: string, number: string): Promise<BlockRow | null> {
  const [row] = await tx.execute(sql`
    select invoice_number, reason, journal_document_number, active, comment, version
      from supplier_invoice_payment_block
     where client = ${client} and invoice_number = ${number} and reason = ${MANUAL_REASON}
  `) as unknown as BlockRow[];
  return row ?? null;
}

async function proposalRun(tx: Tx, client: string, number: string): Promise<string | null> {
  const [row] = await tx.execute(sql`
    select r.run_date::text as run_date, r.run_id
      from payment_proposal_item i
      join payment_run r
        on r.client = i.client and r.run_date = i.run_date and r.run_id = i.run_id
     where i.client = ${client} and i.invoice_number = ${number} and r.status = 'PROPOSAL'
     limit 1
  `) as unknown as Array<{ run_date: string; run_id: string }>;
  return row ? `${row.run_date}/${row.run_id}` : null;
}

async function paymentState(tx: Tx, client: string, invoice: InvoiceRow): Promise<{ state: PaymentState; proposal: string | null }> {
  const proposal = await proposalRun(tx, client, invoice.invoice_number);
  if (proposal) return { state: 'PROPOSAL', proposal };
  if (!invoice.journal_document_number) return { state: 'PAID', proposal: null };
  const [line] = await tx.execute(sql`
    select clearing_document
      from journal_entry_line
     where client = ${client}
       and document_number = ${invoice.journal_document_number}
       and business_partner = ${invoice.supplier_number}
       and debit_credit = 'H'
     limit 1
  `) as unknown as Array<{ clearing_document: string | null }>;
  const [paid] = await tx.execute(sql`
    select 1 as one from payment_document
     where client = ${client} and invoice_number = ${invoice.invoice_number}
     limit 1
  `) as unknown as Array<{ one: number }>;
  if (!line || line.clearing_document || paid) return { state: 'PAID', proposal: null };
  return { state: 'OPEN', proposal: null };
}

async function requireOpenPayable(tx: Tx, client: string, invoice: InvoiceRow): Promise<void> {
  if (invoice.status !== 'POSTED' || invoice.cancellation_of || invoice.cancelled_by) {
    fail(
      `Invoice ${invoice.invoice_number} is not an open posted invoice.`,
      'A cancelled invoice and a cancellation document are not released here.',
    );
  }
  if (!invoice.journal_document_number) {
    fail(`Invoice ${invoice.invoice_number} carries no journal.`, 'A hold needs the posted payable.');
  }
  const lines = await tx.execute(sql`
    select line_number, clearing_document
      from journal_entry_line
     where client = ${client}
       and document_number = ${invoice.journal_document_number}
       and business_partner = ${invoice.supplier_number}
       and debit_credit = 'H'
  `) as unknown as Array<{ line_number: number; clearing_document: string | null }>;
  if (lines.length !== 1) {
    fail(
      `Invoice ${invoice.invoice_number} does not have one supplier line.`,
      'The hold follows the posted payable. It does not choose among several.',
    );
  }
  const state = await paymentState(tx, client, invoice);
  if (state.state === 'PAID') {
    fail(
      `Invoice ${invoice.invoice_number} is already paid.`,
      'A paid item is not released here. A payment correction is a different document.',
    );
  }
  if (state.state === 'PROPOSAL') {
    fail(
      `Invoice ${invoice.invoice_number} stands in payment proposal ${state.proposal}.`,
      'Remove it from the proposal before the hold changes. This screen does not rewrite a proposal.',
    );
  }
}

async function resolveInvoice(tx: Tx, client: string, rawNumber: string): Promise<InvoiceRow> {
  const number = named(rawNumber).toUpperCase();
  if (!number) fail('An invoice number is required.');
  const [park] = await tx.execute(sql`
    select parked_number from parked_supplier_invoice
     where client = ${client} and parked_number = ${number}
  `) as unknown as Array<{ parked_number: string }>;
  if (park) {
    fail(
      `Parked invoice ${number} is not a posted invoice.`,
      'This screen does not release a park. Invoice verification posts.',
    );
  }
  const invoice = await loadInvoice(tx, client, number);
  if (!invoice) fail(`Invoice ${number} does not stand.`);
  return invoice;
}

function requireComment(input: BlockedInvoiceInput): string {
  const comment = named(input.comment);
  if (!comment || comment.length > 100) {
    fail('A reason is required.', 'Say why the hold is placed or released, in at most 100 characters.');
  }
  return comment;
}

function requireKey(input: BlockedInvoiceInput): string {
  const key = named(input.requestKey);
  if (!key) fail('A request key is required.', 'The same key returns the standing result and does not write again.');
  return key;
}

async function writeEvent(tx: Tx, input: {
  client: string;
  invoiceNumber: string;
  action: 'PLACE' | 'RELEASE' | 'REBLOCK';
  outcome: 'HELD' | 'RELEASED';
  actor: string;
  comment: string;
  requestKey: string;
  previousActive: boolean;
  resultingActive: boolean;
}) {
  await tx.execute(sql`
    insert into supplier_invoice_payment_block_event (
      client, invoice_number, reason, action, outcome, actor, comment, request_key,
      previous_active, resulting_active
    ) values (
      ${input.client}, ${input.invoiceNumber}, ${MANUAL_REASON}, ${input.action}, ${input.outcome},
      ${input.actor}, ${input.comment}, ${input.requestKey}, ${input.previousActive}, ${input.resultingActive}
    )
  `);
}

export async function activeBlockedInvoiceNumbers(tx: Tx, client: string): Promise<Set<string>> {
  const rows = await tx.execute(sql`
    select invoice_number
      from supplier_invoice_payment_block
     where client = ${client} and active
  `) as unknown as Array<{ invoice_number: string }>;
  return new Set(rows.map((row) => row.invoice_number));
}

export async function listBlockedInvoices(input: {
  client: string;
  companyFrom: string;
  companyTo?: string;
  fiscalYear: string;
  supplier?: string;
  orderNumber?: string;
  reference?: string;
  invoiceNumber?: string;
  includeReleased?: boolean;
}): Promise<BlockedInvoiceRow[]> {
  const companyFrom = named(input.companyFrom).toUpperCase();
  const companyTo = named(input.companyTo).toUpperCase() || companyFrom;
  const yearText = named(input.fiscalYear);
  if (!companyFrom) fail('A company code is required.');
  if (!/^\d{4}$/.test(yearText)) {
    fail('A fiscal year is required.', 'Name the four-digit year stored on the invoice.');
  }
  if (companyTo < companyFrom) fail(`Company code ${companyTo} is before ${companyFrom}.`);
  return withTenant(input.client, async (tx) => {
    const companies = await tx.execute(sql`
      select company_code from company_code
       where client = ${input.client} and is_active
         and company_code in (${companyFrom}, ${companyTo})
    `) as unknown as Array<{ company_code: string }>;
    const standing = new Set(companies.map((row) => row.company_code));
    if (!standing.has(companyFrom)) fail(`Company code ${companyFrom} does not stand.`);
    if (!standing.has(companyTo)) fail(`Company code ${companyTo} does not stand.`);
    const supplier = named(input.supplier).toUpperCase() || null;
    const orderNumber = named(input.orderNumber).toUpperCase() || null;
    const reference = named(input.reference) || null;
    const invoiceNumber = named(input.invoiceNumber).toUpperCase() || null;
    const rows = await tx.execute(sql`
      select i.invoice_number, i.fiscal_year, i.company_code, i.supplier_number,
             coalesce(bp.name, '') as supplier_name, i.supplier_reference, i.purchase_order_number,
             po.purchasing_org, i.posting_date::text, i.gross_amount::text, i.currency,
             i.journal_document_number, b.active, b.version, b.comment, b.created_by,
             coalesce((
               select sum(item.variance_amount)::text from supplier_invoice_item item
                where item.client = i.client and item.invoice_number = i.invoice_number
             ), '0') as variance_amount,
             coalesce((
               select sum(item.quantity)::text from supplier_invoice_item item
                where item.client = i.client and item.invoice_number = i.invoice_number
             ), '0') as invoiced_quantity
        from supplier_invoice_payment_block b
        join supplier_invoice i
          on i.client = b.client and i.invoice_number = b.invoice_number
        left join business_partner bp
          on bp.client = i.client and bp.partner_number = i.supplier_number
        left join purchase_order po
          on po.client = i.client and po.order_number = i.purchase_order_number
       where b.client = ${input.client}
         and b.reason = ${MANUAL_REASON}
         and (${input.includeReleased === true} or b.active)
         and i.company_code >= ${companyFrom}
         and i.company_code <= ${companyTo}
         and i.fiscal_year = ${Number(yearText)}
         and (${supplier}::text is null or i.supplier_number = ${supplier})
         and (${orderNumber}::text is null or i.purchase_order_number = ${orderNumber})
         and (${reference}::text is null or i.supplier_reference = ${reference})
         and (${invoiceNumber}::text is null or i.invoice_number = ${invoiceNumber})
       order by i.invoice_number
    `) as unknown as Array<{
      invoice_number: string; fiscal_year: number; company_code: string; supplier_number: string;
      supplier_name: string; supplier_reference: string; purchase_order_number: string;
      purchasing_org: string | null; posting_date: string; gross_amount: string; currency: string;
      journal_document_number: string | null; active: boolean; version: number; comment: string; created_by: string;
      variance_amount: string; invoiced_quantity: string;
    }>;
    const listed: BlockedInvoiceRow[] = [];
    for (const row of rows) {
      const invoice = await loadInvoice(tx, input.client, row.invoice_number);
      const state = invoice ? await paymentState(tx, input.client, invoice) : { state: 'PAID' as const, proposal: null };
      listed.push({
        invoiceNumber: row.invoice_number,
        fiscalYear: Number(row.fiscal_year),
        companyCode: row.company_code,
        supplierNumber: row.supplier_number,
        supplierName: row.supplier_name,
        reference: row.supplier_reference,
        purchaseOrderNumber: row.purchase_order_number,
        purchasingOrg: row.purchasing_org,
        postingDate: row.posting_date,
        grossAmount: row.gross_amount,
        currency: row.currency.trim(),
        journalDocumentNumber: row.journal_document_number,
        active: row.active,
        version: Number(row.version),
        comment: row.comment,
        createdBy: row.created_by,
        paymentState: state.state,
        proposalRun: state.proposal,
        varianceAmount: row.variance_amount,
        invoicedQuantity: row.invoiced_quantity,
      });
    }
    return listed;
  });
}

export async function listBlockEvents(client: string, invoiceNumber: string): Promise<BlockEventRow[]> {
  const number = named(invoiceNumber).toUpperCase();
  if (!number) return [];
  return withTenant(client, async (tx) => {
    const rows = await tx.execute(sql`
      select event_id, invoice_number, reason, action, outcome, actor, comment,
             previous_active, resulting_active, created_at::text
        from supplier_invoice_payment_block_event
       where client = ${client} and invoice_number = ${number} and reason = ${MANUAL_REASON}
       order by event_id
    `) as unknown as Array<{
      event_id: number; invoice_number: string; reason: string; action: string; outcome: string;
      actor: string; comment: string; previous_active: boolean; resulting_active: boolean; created_at: string;
    }>;
    return rows.map((row) => ({
      eventId: Number(row.event_id),
      invoiceNumber: row.invoice_number,
      reason: row.reason,
      action: row.action,
      outcome: row.outcome,
      actor: row.actor,
      comment: row.comment,
      previousActive: row.previous_active,
      resultingActive: row.resulting_active,
      createdAt: row.created_at,
    }));
  });
}

export async function previewPaymentBlock(input: BlockedInvoiceInput & { action: 'place' | 'release' }): Promise<BlockedInvoicePreview> {
  refuseAbsent(input);
  requireComment(input);
  return withTenant(input.client, async (tx) => {
    const invoice = await resolveInvoice(tx, input.client, input.invoiceNumber);
    const block = await loadBlock(tx, input.client, invoice.invoice_number);
    const state = await paymentState(tx, input.client, invoice);
    if (input.action === 'place') {
      if (block?.active) {
        return {
          invoiceNumber: invoice.invoice_number, wouldWrite: false, eligible: false, active: true,
          paymentState: state.state,
          message: `Invoice ${invoice.invoice_number} already has a manual hold. Nothing would be written.`,
        };
      }
      try {
        await requireOpenPayable(tx, input.client, invoice);
      } catch (error) {
        if (error instanceof BlockedInvoiceError) {
          return {
            invoiceNumber: invoice.invoice_number, wouldWrite: false, eligible: false, active: Boolean(block?.active),
            paymentState: state.state, message: error.message,
          };
        }
        throw error;
      }
      return {
        invoiceNumber: invoice.invoice_number, wouldWrite: false, eligible: true, active: false,
        paymentState: state.state,
        message: `A manual hold would stand on ${invoice.invoice_number}. The journal would not change. Nothing was written.`,
      };
    }
    if (!block?.active) {
      return {
        invoiceNumber: invoice.invoice_number, wouldWrite: false, eligible: false, active: false,
        paymentState: state.state,
        message: `Invoice ${invoice.invoice_number} has no active hold. Nothing would be written.`,
      };
    }
    if (state.state !== 'OPEN') {
      return {
        invoiceNumber: invoice.invoice_number, wouldWrite: false, eligible: false, active: true,
        paymentState: state.state,
        message: state.state === 'PAID'
          ? `Invoice ${invoice.invoice_number} is already paid. The hold would stay.`
          : `Invoice ${invoice.invoice_number} stands in payment proposal ${state.proposal}. The hold would stay.`,
      };
    }
    return {
      invoiceNumber: invoice.invoice_number, wouldWrite: false, eligible: true, active: true,
      paymentState: state.state,
      message: `The manual hold on ${invoice.invoice_number} would be released. The journal would not change. Nothing was written.`,
    };
  });
}

export async function placePaymentBlock(input: BlockedInvoiceInput): Promise<BlockedInvoiceResult> {
  refuseAbsent(input);
  const comment = requireComment(input);
  const requestKey = requireKey(input);
  return withTenant(input.client, async (tx) => {
    const again = await replay(tx, input.client, requestKey);
    if (again) return again;
    const invoice = await resolveInvoice(tx, input.client, input.invoiceNumber);
    await requireOpenPayable(tx, input.client, invoice);
    const block = await loadBlock(tx, input.client, invoice.invoice_number);
    if (block?.active) {
      fail(`Invoice ${invoice.invoice_number} already has a manual hold.`, 'Release it before placing another.');
    }
    if (block) {
      if (input.expectedVersion != null && Number(block.version) !== input.expectedVersion) {
        fail(`Invoice ${invoice.invoice_number} changed since it was read.`, 'Read it again, then place the hold.');
      }
      await tx.execute(sql`
        update supplier_invoice_payment_block
           set active = true, comment = ${comment}, version = version + 1,
               cleared_by = null, cleared_at = null,
               journal_document_number = ${invoice.journal_document_number},
               changed_by = ${input.changedBy}, changed_at = now()
         where client = ${input.client} and invoice_number = ${invoice.invoice_number} and reason = ${MANUAL_REASON}
      `);
      await writeEvent(tx, {
        client: input.client, invoiceNumber: invoice.invoice_number, action: 'REBLOCK', outcome: 'HELD',
        actor: input.changedBy, comment, requestKey, previousActive: false, resultingActive: true,
      });
    } else {
      await tx.execute(sql`
        insert into supplier_invoice_payment_block (
          client, invoice_number, reason, journal_document_number, active, comment, version, created_by
        ) values (
          ${input.client}, ${invoice.invoice_number}, ${MANUAL_REASON}, ${invoice.journal_document_number},
          true, ${comment}, 1, ${input.changedBy}
        )
      `);
      await writeEvent(tx, {
        client: input.client, invoiceNumber: invoice.invoice_number, action: 'PLACE', outcome: 'HELD',
        actor: input.changedBy, comment, requestKey, previousActive: false, resultingActive: true,
      });
    }
    await recordChange(tx, {
      client: input.client, objectClass: 'supplier_invoice_payment_block', objectKey: invoice.invoice_number,
      changeType: block ? 'CHANGE' : 'CREATE', changedBy: input.changedBy, transactionCode: BLOCKED_INVOICE_HOLD_CAPABILITY,
      reason: comment,
      after: { reason: MANUAL_REASON, active: true, journal: invoice.journal_document_number },
    });
    const standing = await loadBlock(tx, input.client, invoice.invoice_number);
    return {
      invoiceNumber: invoice.invoice_number,
      active: true,
      version: Number(standing?.version ?? 1),
      wrote: true,
      outcome: 'HELD',
    };
  });
}

export async function releasePaymentBlock(input: BlockedInvoiceInput): Promise<BlockedInvoiceResult> {
  refuseAbsent(input);
  const comment = requireComment(input);
  const requestKey = requireKey(input);
  return withTenant(input.client, async (tx) => {
    const again = await replay(tx, input.client, requestKey);
    if (again) return again;
    const invoice = await resolveInvoice(tx, input.client, input.invoiceNumber);
    const block = await loadBlock(tx, input.client, invoice.invoice_number);
    if (!block?.active) {
      fail(`Invoice ${invoice.invoice_number} has no active hold.`, 'A release does not invent a hold, and it does not write.');
    }
    if (input.expectedVersion != null && Number(block.version) !== input.expectedVersion) {
      fail(`Invoice ${invoice.invoice_number} changed since it was read.`, 'Read it again, then release the hold.');
    }
    await requireOpenPayable(tx, input.client, invoice);
    await tx.execute(sql`
      update supplier_invoice_payment_block
         set active = false, comment = ${comment}, version = version + 1,
             cleared_by = ${input.changedBy}, cleared_at = now(),
             changed_by = ${input.changedBy}, changed_at = now()
       where client = ${input.client} and invoice_number = ${invoice.invoice_number} and reason = ${MANUAL_REASON}
         and active
    `);
    await writeEvent(tx, {
      client: input.client, invoiceNumber: invoice.invoice_number, action: 'RELEASE', outcome: 'RELEASED',
      actor: input.changedBy, comment, requestKey, previousActive: true, resultingActive: false,
    });
    await recordChange(tx, {
      client: input.client, objectClass: 'supplier_invoice_payment_block', objectKey: invoice.invoice_number,
      changeType: 'CHANGE', changedBy: input.changedBy, transactionCode: BLOCKED_INVOICE_CAPABILITY,
      reason: comment,
      after: { reason: MANUAL_REASON, active: false },
    });
    const standing = await loadBlock(tx, input.client, invoice.invoice_number);
    return {
      invoiceNumber: invoice.invoice_number,
      active: false,
      version: Number(standing?.version ?? block.version + 1),
      wrote: true,
      outcome: 'RELEASED',
    };
  });
}
