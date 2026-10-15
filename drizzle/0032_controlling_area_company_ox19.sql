-- SCR-025 / OX19: add structural constraints to the tenant-local Controlling Area ↔ Company Code relation.
-- Refuse to infer repairs for existing assignments that violate the owner contract.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM controlling_area_company
     WHERE company_code !~ '^[A-Za-z0-9]{4}$'
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 Char 4 assignment validation: an existing Company Code assignment key is not four alphanumeric characters';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM controlling_area_company assignment
      LEFT JOIN controlling_area area
        ON area.client = assignment.client
       AND area.controlling_area = assignment.controlling_area
     WHERE area.client IS NULL
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 foreign keys: an existing assignment references a missing Controlling Area';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM controlling_area_company assignment
      LEFT JOIN company_code company
        ON company.client = assignment.client
       AND company.company_code = assignment.company_code
     WHERE company.client IS NULL
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 foreign keys: an existing assignment references a missing Company Code';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM controlling_area_company
     GROUP BY client, company_code
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 unique Company Code assignment: a Company Code is currently linked to multiple Controlling Areas';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM controlling_area area
      JOIN controlling_area_company assignment
        ON assignment.client = area.client
       AND assignment.controlling_area = area.controlling_area
     WHERE area.company_code_scope = 'SINGLE'
     GROUP BY area.client, area.controlling_area
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 1:1 scope validation: a Same Company Code Controlling Area has multiple assignments';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM controlling_area_company assignment
      JOIN controlling_area area
        ON area.client = assignment.client
       AND area.controlling_area = assignment.controlling_area
      JOIN company_code company
        ON company.client = assignment.client
       AND company.company_code = assignment.company_code
     WHERE company.chart_of_accounts IS NULL
        OR length(btrim(company.chart_of_accounts)) = 0
        OR company.fiscal_year_variant IS NULL
        OR length(btrim(company.fiscal_year_variant)) = 0
        OR NOT EXISTS (
          SELECT 1
            FROM chart_of_accounts chart
           WHERE chart.client = company.client
             AND chart.chart_of_accounts = company.chart_of_accounts
        )
        OR NOT EXISTS (
          SELECT 1
            FROM fiscal_year_variant variant
           WHERE variant.client = company.client
             AND variant.variant = company.fiscal_year_variant
        )
        OR btrim(company.fiscal_year_variant) <> btrim(area.fiscal_year_variant)
        OR btrim(company.currency::text) <> btrim(area.currency::text)
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 compatibility validation: an existing assignment lacks or mismatches Operational Chart of Accounts, Fiscal Year Variant, or Currency Key';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM controlling_area_company assignment
      JOIN company_code company
        ON company.client = assignment.client
       AND company.company_code = assignment.company_code
     GROUP BY assignment.client, assignment.controlling_area
    HAVING count(DISTINCT company.chart_of_accounts) > 1
  ) THEN
    RAISE EXCEPTION '0032 refuses OX19 derived Chart of Accounts baseline: current Company Codes under one Controlling Area use different Operational Charts of Accounts';
  END IF;
END $$;

ALTER TABLE controlling_area_company
  ADD CONSTRAINT controlling_area_company_code_format_ck
    CHECK (company_code ~ '^[A-Za-z0-9]{4}$'),
  ADD CONSTRAINT controlling_area_company_area_fk
    FOREIGN KEY (client, controlling_area)
    REFERENCES controlling_area (client, controlling_area)
    ON DELETE NO ACTION ON UPDATE NO ACTION,
  ADD CONSTRAINT controlling_area_company_company_code_fk
    FOREIGN KEY (client, company_code)
    REFERENCES company_code (client, company_code)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

CREATE UNIQUE INDEX controlling_area_company_code_unique_idx
  ON controlling_area_company (client, company_code);
