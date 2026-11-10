-- B-118: allow Plant definition before the separate Company Code assignment (SCR-014/SCR-015).
-- Preserve existing assignments and enforce tenant-local integrity whenever a Company Code is present.
ALTER TABLE "plant" ALTER COLUMN "company_code" DROP NOT NULL;
ALTER TABLE "plant"
  ADD CONSTRAINT "plant_client_company_code_fk"
  FOREIGN KEY ("client", "company_code")
  REFERENCES "public"."company_code" ("client", "company_code")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
