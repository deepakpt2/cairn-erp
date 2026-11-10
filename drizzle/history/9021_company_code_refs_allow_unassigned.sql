-- B-107: validate only assignments that have been made; definition itself may precede them (§6.2).
CREATE OR REPLACE FUNCTION cairn_assert_company_code_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.chart_of_accounts IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM chart_of_accounts
    WHERE client = NEW.client AND chart_of_accounts = NEW.chart_of_accounts
  ) THEN
    RAISE EXCEPTION
      'CAIRN_CONFIG_MISSING: chart of accounts % is not defined for this tenant.',
      NEW.chart_of_accounts
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Define the chart of accounts first (CFG.FIN.COA.DEFINE), then assign it.';
  END IF;

  IF NEW.fiscal_year_variant IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM fiscal_year_variant
    WHERE client = NEW.client AND variant = NEW.fiscal_year_variant
  ) THEN
    RAISE EXCEPTION
      'CAIRN_CONFIG_MISSING: fiscal year variant % is not defined for this tenant.',
      NEW.fiscal_year_variant
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Define the fiscal year variant first (CFG.FIN.FYV.DEFINE), then assign it.';
  END IF;

  IF NEW.posting_period_variant IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM posting_period_variant
    WHERE client = NEW.client AND variant = NEW.posting_period_variant
  ) THEN
    RAISE EXCEPTION
      'CAIRN_CONFIG_MISSING: posting period variant % is not defined for this tenant.',
      NEW.posting_period_variant
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Define the posting period variant first (CFG.FIN.PPV.DEFINE), then assign it.';
  END IF;

  RETURN NEW;
END $$;
