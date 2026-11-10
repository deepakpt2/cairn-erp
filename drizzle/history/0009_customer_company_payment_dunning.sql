-- B-018: customer company payment methods and dunning procedure (code-only; no masters yet).
ALTER TABLE "customer_company_code" ADD COLUMN "payment_methods" varchar(40);
ALTER TABLE "customer_company_code" ADD COLUMN "dunning_procedure" varchar(4);
