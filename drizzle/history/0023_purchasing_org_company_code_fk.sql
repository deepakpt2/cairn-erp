-- B-151: enforce Purchasing Organisation -> Company Code assignment within the same tenant.
-- A null Company Code remains valid while the organisation is pending its separate assignment.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM purchasing_org po
      LEFT JOIN company_code cc
        ON cc.client = po.client
       AND cc.company_code = po.company_code
     WHERE po.company_code IS NOT NULL
       AND cc.company_code IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot add purchasing_org Company Code FK: tenant-local orphan assignment exists.';
  END IF;
END $$;

CREATE INDEX "purchasing_org_company_code_idx"
  ON "purchasing_org" ("client", "company_code");

ALTER TABLE "purchasing_org"
  ADD CONSTRAINT "purchasing_org_client_company_code_fk"
  FOREIGN KEY ("client", "company_code")
  REFERENCES "company_code" ("client", "company_code")
  ON DELETE NO ACTION
  ON UPDATE NO ACTION;
