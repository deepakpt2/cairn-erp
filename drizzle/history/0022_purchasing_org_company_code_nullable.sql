-- B-142: allow an organisation definition to exist while its separate Company Code assignment is pending.
-- Keep existing assignments unchanged; unassigned organisations remain unusable by supplier-purchasing services.
ALTER TABLE "purchasing_org"
  ALTER COLUMN "company_code" DROP NOT NULL;
