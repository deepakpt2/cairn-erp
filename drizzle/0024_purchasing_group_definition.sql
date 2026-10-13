-- SCR-019: Purchasing Group key and contact fields for the maintenance overview.
-- Refuse the key-width migration rather than truncate or silently rewrite existing references.
-- Keep the existing description width: Cairn's seeded buyer-team descriptions exceed the
-- limit listed in secondary T024 field catalogs; no approved data-renaming policy exists yet.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM purchasing_group
     WHERE purchasing_group !~ '^[A-Z0-9]{3}$'
  ) THEN
    RAISE EXCEPTION 'Cannot apply SCR-019: existing Purchasing Group keys must be exactly three uppercase letters or digits.';
  END IF;

  IF EXISTS (
    SELECT 1 FROM material_plant
     WHERE purchasing_group IS NOT NULL
       AND purchasing_group !~ '^[A-Z0-9]{3}$'
  ) OR EXISTS (
    SELECT 1 FROM supplier_purchasing_org
     WHERE purchasing_group IS NOT NULL
       AND purchasing_group !~ '^[A-Z0-9]{3}$'
  ) THEN
    RAISE EXCEPTION 'Cannot apply SCR-019: an existing material or supplier purchasing view contains a non-standard Purchasing Group key.';
  END IF;
END $$;

ALTER TABLE "material_plant"
  DROP CONSTRAINT IF EXISTS "material_plant_client_purchasing_group_purchasing_group_client_purchasing_group_fk";
ALTER TABLE "supplier_purchasing_org"
  DROP CONSTRAINT IF EXISTS "supplier_purchasing_org_client_purchasing_group_purchasing_group_client_purchasing_group_fk";

ALTER TABLE "purchasing_group"
  ADD COLUMN "tel_no_purch_group" varchar(12),
  ADD COLUMN "fax_number" varchar(31),
  ADD COLUMN "telephone" varchar(30),
  ADD COLUMN "extension" varchar(10),
  ADD COLUMN "email_address" varchar(241);

ALTER TABLE "purchasing_group"
  ALTER COLUMN "purchasing_group" TYPE varchar(3);
ALTER TABLE "material_plant"
  ALTER COLUMN "purchasing_group" TYPE varchar(3);
ALTER TABLE "supplier_purchasing_org"
  ALTER COLUMN "purchasing_group" TYPE varchar(3);

ALTER TABLE "purchasing_group"
  ADD CONSTRAINT "purchasing_group_key_format_ck"
  CHECK ("purchasing_group" ~ '^[A-Z0-9]{3}$');

ALTER TABLE "material_plant"
  ADD CONSTRAINT "material_plant_client_purchasing_group_purchasing_group_client_purchasing_group_fk"
  FOREIGN KEY ("client", "purchasing_group")
  REFERENCES "purchasing_group" ("client", "purchasing_group")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
ALTER TABLE "supplier_purchasing_org"
  ADD CONSTRAINT "supplier_purchasing_org_client_purchasing_group_purchasing_group_client_purchasing_group_fk"
  FOREIGN KEY ("client", "purchasing_group")
  REFERENCES "purchasing_group" ("client", "purchasing_group")
  ON DELETE NO ACTION ON UPDATE NO ACTION;
