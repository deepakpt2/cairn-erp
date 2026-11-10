-- ---------------------------------------------------------------------------
-- SCR-030 / OB37 stage 2 — declare the fiscal year variant assignment
--
-- company_code.fiscal_year_variant has always been a bare two-character column.
-- The trigger cairn_assert_company_code_refs() (9000, corrected by 9021 to allow
-- an unassigned company code) refuses a company code that points at a variant
-- this tenant has not defined, so the child side of the relationship was already
-- guarded. Nothing guarded the parent side: a variant row could be deleted while
-- a company code still posted in it, and the only thing preventing that was the
-- absence of a delete path in the OB29 service — an application habit, not a
-- constraint.
--
-- This adds the composite foreign key the owner's contract asked for, with no
-- cascade: a variant in use cannot be removed, and a company code keeps its
-- variant until somebody assigns another. The column stays nullable, because a
-- company code is defined before its variant is assigned and the workbench shows
-- that state as "Not assigned" rather than as an error. The trigger stays: it
-- fires first and says CAIRN_CONFIG_MISSING with the activity that fixes it,
-- which is a better sentence than a constraint name.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_code_client_fiscal_year_variant_fk'
  ) THEN
    ALTER TABLE company_code
      ADD CONSTRAINT company_code_client_fiscal_year_variant_fk
      FOREIGN KEY (client, fiscal_year_variant)
      REFERENCES fiscal_year_variant (client, variant);
  END IF;
END $$;

-- The parent-side check scans the child table, and so does the OB29 retirement
-- guard that counts the company codes holding a variant. Same shape as the
-- existing company_code_coa_idx.
CREATE INDEX IF NOT EXISTS company_code_fyv_idx
  ON company_code (client, fiscal_year_variant);
