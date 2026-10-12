-- B-098: nullable code-set storage for Supplier company-code payment method defaults.
-- The selected codes are not yet validated against the Payment Methods master in this batch.
ALTER TABLE "supplier_company_code" ADD COLUMN "payment_methods" varchar(40);
