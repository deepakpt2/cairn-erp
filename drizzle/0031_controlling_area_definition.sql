-- SCR-024 / OKKP: extend the existing tenant-local Controlling Area master.
-- Refuse to truncate or guess the meaning of any existing key/reference.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM controlling_area
    WHERE char_length(name) > 30 OR length(btrim(name)) = 0
  ) THEN
    RAISE EXCEPTION '0031 refuses to narrow Controlling Area Name: a stored value is blank or exceeds 30 characters';
  END IF;

  IF EXISTS (
    SELECT 1 FROM controlling_area
    WHERE btrim(controlling_area) !~ '^[A-Z0-9]{4}$'
  ) THEN
    RAISE EXCEPTION '0031 refuses to add the Controlling Area key check: a stored key is not four uppercase letters/digits';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM controlling_area area
    WHERE btrim(area.currency) !~ '^[A-Z]{3}$'
       OR NOT EXISTS (
         SELECT 1 FROM currency reference_currency
         WHERE btrim(reference_currency.code) = btrim(area.currency)
       )
  ) THEN
    RAISE EXCEPTION '0031 refuses to constrain Controlling Area currency: a stored key is not an existing three-character currency';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM controlling_area area
    WHERE btrim(area.fiscal_year_variant) !~ '^[A-Z0-9]{2}$'
       OR NOT EXISTS (
         SELECT 1 FROM fiscal_year_variant variant
         WHERE variant.client = area.client
           AND variant.variant = area.fiscal_year_variant
       )
  ) THEN
    RAISE EXCEPTION '0031 refuses to constrain Controlling Area Fiscal Year Variant: a stored key is not an existing two-character tenant definition';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM controlling_area_company assignment
    LEFT JOIN controlling_area area
      ON area.client = assignment.client
     AND area.controlling_area = assignment.controlling_area
    WHERE area.client IS NULL
  ) THEN
    RAISE EXCEPTION '0031 refuses to derive Assignment Control while orphan Controlling Area assignments exist';
  END IF;
END $$;

ALTER TABLE controlling_area
  ALTER COLUMN name TYPE varchar(30),
  ALTER COLUMN fiscal_year_variant TYPE varchar(2);

ALTER TABLE controlling_area
  ADD COLUMN organization_name varchar(30),
  ADD COLUMN company_code_scope varchar(8) NOT NULL DEFAULT 'SINGLE';

-- Preserve current assignment capacity: one or zero links maps to SINGLE;
-- two or more existing links map to MULTIPLE. New areas default to SINGLE.
UPDATE controlling_area area
SET company_code_scope = 'MULTIPLE'
WHERE (
  SELECT count(*)
  FROM controlling_area_company assignment
  WHERE assignment.client = area.client
    AND assignment.controlling_area = area.controlling_area
) > 1;

ALTER TABLE controlling_area
  ADD CONSTRAINT controlling_area_key_format_ck
    CHECK (controlling_area ~ '^[A-Z0-9]{4}$'),
  ADD CONSTRAINT controlling_area_name_not_blank_ck
    CHECK (length(btrim(name)) > 0),
  ADD CONSTRAINT controlling_area_organization_name_not_blank_ck
    CHECK (organization_name IS NULL OR length(btrim(organization_name)) > 0),
  ADD CONSTRAINT controlling_area_company_code_scope_ck
    CHECK (company_code_scope IN ('SINGLE', 'MULTIPLE')),
  ADD CONSTRAINT controlling_area_currency_format_ck
    CHECK (btrim(currency) ~ '^[A-Z]{3}$'),
  ADD CONSTRAINT controlling_area_fiscal_year_variant_format_ck
    CHECK (fiscal_year_variant ~ '^[A-Z0-9]{2}$'),
  ADD CONSTRAINT controlling_area_fiscal_year_variant_fk
    FOREIGN KEY (client, fiscal_year_variant)
    REFERENCES fiscal_year_variant (client, variant),
  ADD CONSTRAINT controlling_area_currency_reference_fk
    FOREIGN KEY (currency)
    REFERENCES currency (code);
