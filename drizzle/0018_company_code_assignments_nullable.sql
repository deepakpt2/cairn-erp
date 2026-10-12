-- B-107: permit Company Code definition before the separate assignments in §6.2.
-- Existing assigned values are preserved; assignment consumers must fail closed until complete.
ALTER TABLE "company_code" ALTER COLUMN "chart_of_accounts" DROP NOT NULL;
ALTER TABLE "company_code" ALTER COLUMN "fiscal_year_variant" DROP NOT NULL;
ALTER TABLE "company_code" ALTER COLUMN "posting_period_variant" DROP NOT NULL;
