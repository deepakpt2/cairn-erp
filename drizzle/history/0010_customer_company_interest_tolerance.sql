-- B-020: customer company interest and tolerance defaults are code-only until their masters exist.
ALTER TABLE "customer_company_code" ADD COLUMN "interest_indicator" varchar(4);
ALTER TABLE "customer_company_code" ADD COLUMN "tolerance_group" varchar(4);
