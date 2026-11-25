/**
 * The tables a reset must find empty, and the columns that say who wrote a row.
 *
 * Split out so the reset's rules are readable without the transaction around them, and so a
 * reviewer can check the list against `drizzle/0000_baseline.sql` without reading TypeScript.
 */

/**
 * Tables that hold posted business documents under a company.
 *
 * A reset is a master-data reset: if any of these holds a row for the company, a person has
 * posted something and the reset must not erase it. The list is the document tables, not every
 * table — a stock row, a journal line or a material document is exactly the kind of thing a
 * reset would otherwise destroy without anyone noticing.
 */
export const COMPANY_TABLES_WITH_DOCUMENTS: readonly string[] = [
  'journal_entry',
  'journal_entry_line',
  'material_document',
  'material_document_line',
  'supplier_invoice',
  'supplier_invoice_item',
  'customer_invoice',
  'customer_invoice_line',
  'billing_document',
  'billing_document_line',
  'sales_order',
  'sales_order_line',
  'delivery',
  'delivery_line',
  'purchase_order',
  'purchase_order_item',
  'purchase_requisition_item',
  'production_order',
  'quality_lot',
  'usage_decision',
  'outgoing_payment',
  'incoming_payment',
  'payroll_run',
  'payroll_result',
];

/**
 * Columns that record who wrote a row, in the order a check should read them.
 *
 * The tenant tables carry `created_by`; a few carry `changed_by` instead. A row whose actor is
 * neither the installer nor a system value was written by a person, which is what the reset
 * refuses on.
 */
export const ACTOR_COLUMNS = ['created_by', 'changed_by'] as const;

/**
 * Actors that are not a person working in the data.
 *
 * Two kinds sit here, and both are the installer's own hand:
 *
 * - `IN01_PROVISION`, the actor it stamps on the rows it writes directly;
 * - the fixture's own accounts, because some services (the scope grants among them) record the
 *   signed-in administrator that performed the write rather than a provisioning actor. Those
 *   rows were written by the installer acting as its own founder accounts, not by a tester.
 *
 * A tester's own work carries their username and their session, so it lands outside this list —
 * which is exactly the distinction the reset turns on.
 */
export const SYSTEM_ACTORS: readonly string[] = [
  'IN01_PROVISION',
  'SYSTEM',
  'IN01-CREDENTIALS',
  'in01.owner',
  'IN01.OWNER',
  'in01.admin',
  'IN01.ADMIN',
];
