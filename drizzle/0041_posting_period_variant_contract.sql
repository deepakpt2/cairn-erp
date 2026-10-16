-- ---------------------------------------------------------------------------
-- SCR-031 / OBBO stage 2 — hold the posting period variant to its contract
--
-- The contract defines a posting period variant as a four-character key and a
-- thirty-character description, and makes it deletable only while nothing posts
-- against it. The table disagreed on both counts.
--
-- The description was varchar(120). Nothing wrote more than twenty-three
-- characters — the standard package's own name is the only row in any tenant —
-- but a column wider than the contract is a column a direct write can overfill,
-- and the screen would then be the only thing holding the rule.
--
-- Neither child table had a foreign key. The trigger
-- cairn_assert_company_code_refs() (9000, corrected by 9021 to allow an
-- unassigned company code) refuses a company code that points at a variant this
-- tenant has not defined, so the child side of the company-code relationship
-- was already guarded; the parent side was not. A variant could be deleted
-- while a company code still posted against it, and while its own interval rows
-- still existed — posting_period_rule.variant had no key at all, so its rows
-- outlived their variant silently and the posting engine went on reading them.
-- What stopped that in practice was the absence of a delete path, which is an
-- application habit rather than a constraint.
--
-- Both keys are added with no cascade and no action on delete: a variant in use
-- cannot be removed, and a company code keeps its variant until somebody
-- assigns another. The company-code column stays nullable, because a company
-- code is defined before its variant is assigned and the workbench shows that
-- state as "Not assigned" rather than as an error. The trigger stays: it fires
-- first and says CAIRN_CONFIG_MISSING with the activity that fixes it, which is
-- a better sentence than a constraint name.
--
-- Every step verifies before it applies, and refuses rather than repairs. This
-- migration will not shorten a description, and will not delete or null out an
-- orphaned row to make its own constraint satisfiable: both would change what
-- the books mean without anybody deciding that they should.
-- ---------------------------------------------------------------------------

-- A. The description is thirty characters. ----------------------------------
DO $$
DECLARE
  too_long text;
  current_width integer;
BEGIN
  SELECT character_maximum_length INTO current_width
    FROM information_schema.columns
   WHERE table_name = 'posting_period_variant' AND column_name = 'name';

  IF current_width IS DISTINCT FROM 30 THEN
    SELECT string_agg(client || '/' || variant || ' (' || length(name) || ' characters)', ', '
                      ORDER BY client, variant)
      INTO too_long
      FROM posting_period_variant
     WHERE length(name) > 30;

    IF too_long IS NOT NULL THEN
      RAISE EXCEPTION
        'CAIRN_MIGRATION: posting period variant descriptions longer than thirty characters: %. Shorten them, then re-run.',
        too_long
        USING HINT = 'The contract holds the description at thirty characters. This migration refuses rather than truncates: a shortened description is silently a different one, and nobody decided that it should be.';
    END IF;

    ALTER TABLE posting_period_variant ALTER COLUMN name TYPE varchar(30);
  END IF;
END $$;

-- B. A company code points at a variant that exists. -------------------------
DO $$
DECLARE
  orphaned text;
BEGIN
  SELECT string_agg(cc.client || '/' || cc.company_code || ' -> ' || cc.posting_period_variant,
                    ', ' ORDER BY cc.client, cc.company_code)
    INTO orphaned
    FROM company_code cc
    LEFT JOIN posting_period_variant v
           ON v.client = cc.client AND v.variant = cc.posting_period_variant
   WHERE cc.posting_period_variant IS NOT NULL AND v.variant IS NULL;

  IF orphaned IS NOT NULL THEN
    RAISE EXCEPTION
      'CAIRN_MIGRATION: company codes point at a posting period variant their tenant has not defined: %. Define the variant or clear the assignment, then re-run.',
      orphaned
      USING HINT = 'Define the variant first (CFG.FIN.PPV.DEFINE). This migration refuses rather than clearing the assignment: which variant a company code posts against is not this migration''s decision.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'company_code_client_posting_period_variant_fk'
  ) THEN
    ALTER TABLE company_code
      ADD CONSTRAINT company_code_client_posting_period_variant_fk
      FOREIGN KEY (client, posting_period_variant)
      REFERENCES posting_period_variant (client, variant);
  END IF;
END $$;

-- The parent-side check scans the child table, and so does the deletion guard
-- that counts the company codes posting against a variant. Same shape as the
-- existing company_code_coa_idx and company_code_fyv_idx.
CREATE INDEX IF NOT EXISTS company_code_ppv_idx
  ON company_code (client, posting_period_variant);

-- C. An interval row belongs to a variant that exists. -----------------------
-- No index here: the primary key (client, variant, account_type) already
-- carries the prefix a parent-side check needs.
DO $$
DECLARE
  orphaned text;
BEGIN
  SELECT string_agg(r.client || '/' || r.variant || '/' || r.account_type, ', '
                    ORDER BY r.client, r.variant, r.account_type)
    INTO orphaned
    FROM posting_period_rule r
    LEFT JOIN posting_period_variant v
           ON v.client = r.client AND v.variant = r.variant
   WHERE v.variant IS NULL;

  IF orphaned IS NOT NULL THEN
    RAISE EXCEPTION
      'CAIRN_MIGRATION: posting period intervals exist for a variant their tenant has not defined: %. Define the variant or remove the intervals, then re-run.',
      orphaned
      USING HINT = 'An interval without a variant is read by the posting engine and shown on no screen. This migration refuses rather than deleting it: which periods are open is not this migration''s decision.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'posting_period_rule_client_variant_fk'
  ) THEN
    ALTER TABLE posting_period_rule
      ADD CONSTRAINT posting_period_rule_client_variant_fk
      FOREIGN KEY (client, variant)
      REFERENCES posting_period_variant (client, variant);
  END IF;
END $$;
