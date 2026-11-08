# DI-020 Implementation Status

## Committed
- **Commit**: `ce9c650` on `development`, pushed to `origin/development`
- **Working tree**: clean

## Changes Summary

### 1. Schema Migration (Additive) — `drizzle/9206_customer_invoice_credit_of.sql`
- Added `credit_of varchar(20)` to `customer_invoice` table
- Added `credit_of varchar(20)` to `billing_document` table
- No existing columns modified; no data changed

### 2. Customer Credit Memo Service — `src/modules/finance/customer-credit-memo.ts` (NEW)
- `CUSTOMER_CREDIT_MEMO_CAPABILITY = 'FIN.AR.CREDITMEMO.POST'`
- `postCustomerCreditMemo(input)` — full credit memo posting:
  - Validates customer exists, extended to company, not blocked, has reconciliation account
  - Validates company code configured
  - Validates optional original billing document: exists, POSTED, same customer/company/currency
  - Validates optional original customer invoice: exists, INVOICE category, POSTED, same customer/company/currency
  - **Credit cap**: all posted CREDIT_MEMO credits against an original may never exceed its gross
  - **Duplicate reference**: standing posted document with same reference for customer/company refused
  - **Idempotency**: same request key returns the original document (replay)
  - Posts FI document through `postCustomerInvoice` (DR journal) — reuses existing posting engine
  - Creates `customerInvoice` with `category: 'CREDIT_MEMO'`, `creditOf: originalInvoiceNumber`
  - Creates `customerInvoiceLine` entries
  - Records audit change via `recordChange`
- `getCustomerCreditMemo(client, number)` — retrieve credit memo view
- `CustomerCreditMemoError` — structured errors with remedy

### 3. Modified `postCustomerInvoice` — `src/modules/finance/customer-invoice.ts`
- Added optional `category` (default `'INVOICE'`) and `creditOf` parameters to `PostCustomerInvoiceInput`
- Added `creditOf` to `CustomerInvoiceView` interface
- Updated `toView()` to include `creditOf`
- Insert now uses `input.category ?? 'INVOICE'` and `input.creditOf ?? null`
- Backward compatible — existing callers unaffected

### 4. Schema — `src/modules/sales/schema.ts`
- Added `creditOf: varchar('credit_of', { length: 20 })` to `billingDocument` table definition

### 5. Billing Module — `src/modules/sales/billing.ts`
- Added `creditOf: string | null` to `BillingView` interface
- Updated `mapHeader()` to include `creditOf`
- Updated `listBillings()` return type and mapping to include `creditOf`

### 6. UI — `src/app/sales/credit-memo/` (NEW)
- `page.tsx` — server component, requires `FIN.AR.CREDITMEMO.POST` capability
- `actions.ts` — server actions: `postCreditMemoAction`, `cancelCreditMemoAction`
- `CreditMemo.tsx` — client component: header form (customer, company, currency, reference, dates, original billing/invoice, gross amount), line items (G/L account, net, tax code, profit centre, text), balance calculation, posted document display, cancellation form

### 7. Screen Catalog — `src/ui/shell/screen-catalog.ts`
- Added `/sales/credit-memo` entry: code `FIN.AR.CREDITMEMO.POST`, area `sales`, family `sales-billing`, accepts `["billing", "customer", "invoice"]`

### 8. i18n — `src/platform/i18n/index.ts`
- Added `customerCreditMemo.title` and `customerCreditMemo.subtitle`

### 9. Tests — `tests/customer-credit-memo.test.ts` (NEW)
- Full/partial credit posting with balanced DR journal (credit: customer rec account, debit: revenue + tax)
- Duplicate reference prevention
- Credit cap enforcement (excessive credit refused with exact figures)
- Bad original rejection (cancelled invoice, wrong customer/company/currency)
- Multiple partial credits up to original gross
- Cancellation via `cancelCustomerInvoice` frees the credit cap
- Wrong currency rejection
- Cancelled original invoice rejection

## Cancelled Delivery Rebilling — Investigation

### Why cancelled delivery cannot be rebilled (current code)
1. `createBillingFromDelivery` (billing.ts: ~line 188): throws `BillingError` when `deliveryHeader.status === 'CANCELLED'` — "nothing was shipped to bill"
2. `postBillingDocument` (billing.ts: ~line 741): throws `BillingError` when billing document status is `CANCELLED` — "the delivery is not billed again from here"
3. `cancelDelivery` (delivery.ts: ~line 820): refuses if delivery is `GOODS_ISSUED` (must reverse goods issue in Inventory first) or already billed
4. `listBillableDeliveries`: only returns `GOODS_ISSUED`, non-cancelled, unbilled deliveries

### Correct follow-on behavior (already works via existing code)
The replacement flow is structurally supported:
1. Cancel billing document → `cancelBillingDocument` posts cancellation invoice via `cancelCustomerInvoice`, billing row stays `CANCELLED`
2. Reverse goods issue in Inventory → delivery returns to `PICKED` (inventory-owned screen)
3. Cancel delivery → `cancelDelivery` sets status to `CANCELLED`, freeing order line quantity
4. Create replacement delivery → `listDeliverableOrderLines` excludes `CANCELLED` deliveries from delivered quantity, so order line quantity is available
5. Bill replacement delivery → `createBillingFromDelivery` bills the new delivery

### Duplicate billing prevention
- `uniqueIndex('billing_document_delivery_uq')` on `(client, deliveryNumber)` — one billing per delivery
- `uniqueIndex('billing_document_line_delivery_line_uq')` on `(client, deliveryNumber, deliveryLineNumber)` — one billing line per delivery line

### Document flow traceability
- `salesDocumentFlow()` shows order → delivery → material document → billing → invoice chain
- `creditOf` on `billing_document` and `customer_invoice` preserves the link to original documents
- `recordChange` audit trail on all state transitions

## Pending Verification (Test Server)

The test server at `107.173.201.115:2222` is currently not reachable via SSH (authentication failure). The following still needs to be done on the test server:

1. **Apply migration** to `cairn_acceptance`:
   ```
   CAIRN_ENV=development MIGRATION_DATABASE_URL='postgresql://cairn:cairn_dev@127.0.0.1:5432/cairn_acceptance' \
   npx tsx src/platform/db/migrate.ts
   ```

2. **Run focused tests** against `cairn_acceptance`:
   ```
   CAIRN_ENV=development MIGRATION_DATABASE_URL='...cairn_acceptance' DATABASE_URL='...cairn_acceptance' \
   npx vitest run tests/credit.test.ts tests/credit-release.test.ts tests/sales-order.test.ts tests/sales-delivery.test.ts tests/customer-credit-memo.test.ts
   ```

3. **TypeScript check** on changed files:
   ```
   npx tsc --noEmit
   ```

4. **Production build** — only if infrastructure constraints permit (single-CPU timeout documented in DEVELOPMENT-OPERATIONS.md)

## Git Status
- Branch: `development`
- Commit: `ce9c650`
- Pushed to: `origin/development`
- No merge to main, no force-push
