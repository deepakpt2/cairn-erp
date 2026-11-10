-- ============================================================================
-- Cairn — row-level security, structural invariants and role grants
-- CAIRN.md §6.3 (D-006), §5.3 (posting invariant), §23
--
-- Applied after the generated table migrations. Kept as hand-written SQL because
-- these are policies and constraint triggers, which are not expressible in the
-- table definitions themselves.
--
-- Naming convention (D-039): generated migrations are 0000+, hand-written are
-- 9000+, so hand-written always sorts last and never collides with drizzle-kit.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1 · Row-level security
--
-- Every tenant-scoped table carries a policy keyed on the `cairn.client` session
-- variable, which src/platform/db/client.ts sets inside each transaction.
--
-- Default-deny: if the variable is unset, current_setting(..., true) returns NULL
-- and the comparison yields NULL, which is not true — so no rows are visible and
-- no rows may be written. A forgotten scope leaks nothing; it returns nothing.
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_tables text[] := ARRAY[
    -- platform
    'client',
    'client_settings',
    'app_user',
    'role',
    'role_capability',
    'user_role',
    'auth_org_restriction',
    'user_session',
    'audit_access_log',
    'sod_rule',
    'number_range',
    'number_range_allocation',
    'lock_wait_log',
    'change_document',
    'change_document_item',
    'document_flow_link',
    'document_status_history',
    'document_index',
    'config_activity_status',
    'job_run',
    'job_log',
    'mail_server_config',
    -- finance
    'gl_account',
    'journal_entry',
    'journal_entry_line',
    -- foundation
    'chart_of_accounts',
    'fiscal_year_variant',
    'fiscal_year_period',
    'posting_period_variant',
    'posting_period_rule',
    'company_code',
    'plant',
    'storage_location',
    'purchasing_org',
    'purchasing_org_plant',
    'purchasing_group',
    'sales_org',
    'distribution_channel',
    'division',
    'sales_area',
    'controlling_area',
    'controlling_area_company',
    'credit_control_area',
    'exchange_rate',
    'document_type'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format($fmt$
      CREATE POLICY tenant_isolation ON %I
        FOR ALL
        USING (client = current_setting('cairn.client', true))
        WITH CHECK (client = current_setting('cairn.client', true))
    $fmt$, t);
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- 2 · The accounting invariant
--
-- An unbalanced accounting document must be impossible. The posting engine
-- rejects one with a clear message, but this deferred constraint trigger is the
-- second line of defence: it fires at COMMIT, after all lines of the document
-- exist, and refuses the transaction if debits do not equal credits.
--
-- Deferred matters. Lines are inserted one at a time, so a partially written
-- document is legitimately unbalanced mid-transaction. Only the committed state
-- has to satisfy the rule.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cairn_assert_journal_balances()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  rec          record;
  v_debit      numeric(23,4);
  v_credit     numeric(23,4);
BEGIN
  IF TG_OP = 'DELETE' THEN
    rec := OLD;
  ELSE
    rec := NEW;
  END IF;

  SELECT
    COALESCE(SUM(CASE WHEN debit_credit = 'S' THEN amount_local END), 0),
    COALESCE(SUM(CASE WHEN debit_credit = 'H' THEN amount_local END), 0)
  INTO v_debit, v_credit
  FROM journal_entry_line
  WHERE client          = rec.client
    AND document_number = rec.document_number
    AND fiscal_year     = rec.fiscal_year;

  IF v_debit <> v_credit THEN
    RAISE EXCEPTION
      'CAIRN_UNBALANCED: accounting document % (fiscal year %) does not balance — debits % vs credits %. Difference %.',
      rec.document_number, rec.fiscal_year, v_debit, v_credit, v_debit - v_credit
      USING ERRCODE = 'check_violation',
            HINT = 'Nothing was saved. Correct the amounts so total debits equal total credits.';
  END IF;

  RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS trg_journal_balances ON journal_entry_line;
CREATE CONSTRAINT TRIGGER trg_journal_balances
  AFTER INSERT OR UPDATE OR DELETE ON journal_entry_line
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION cairn_assert_journal_balances();

-- ---------------------------------------------------------------------------
-- 3 · Company-code integrity
--
-- A company code's configuration must exist before it can be used. This trigger
-- catches the assignment inconsistency at the database level, so no future code
-- path can create a company code pointing at a chart of accounts that is not
-- there — which would fail much later, at the first posting, with a message that
-- names the wrong thing.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION cairn_assert_company_code_refs()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM chart_of_accounts
    WHERE client = NEW.client AND chart_of_accounts = NEW.chart_of_accounts
  ) THEN
    RAISE EXCEPTION
      'CAIRN_CONFIG_MISSING: chart of accounts % is not defined for this tenant.',
      NEW.chart_of_accounts
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Define the chart of accounts first (CFG.FIN.COA.DEFINE), then assign it.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM fiscal_year_variant
    WHERE client = NEW.client AND variant = NEW.fiscal_year_variant
  ) THEN
    RAISE EXCEPTION
      'CAIRN_CONFIG_MISSING: fiscal year variant % is not defined for this tenant.',
      NEW.fiscal_year_variant
      USING ERRCODE = 'foreign_key_violation',
            HINT = 'Define the fiscal year variant first (CFG.FIN.FYV.DEFINE), then assign it.';
  END IF;

  IF NOT EXISTS (
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

DROP TRIGGER IF EXISTS trg_company_code_refs ON company_code;
CREATE TRIGGER trg_company_code_refs
  BEFORE INSERT OR UPDATE ON company_code
  FOR EACH ROW
  EXECUTE FUNCTION cairn_assert_company_code_refs();

-- ---------------------------------------------------------------------------
-- 4 · Application role
--
-- The application connects as cairn_app: NOSUPERUSER and NOBYPASSRLS, so the
-- policies above actually apply to it. Migrations run as the owning role.
-- A table owner is exempt from RLS unless FORCE is set — which section 1 does,
-- so this holds even if the roles are ever merged by accident.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    CREATE ROLE cairn_app LOGIN PASSWORD 'cairn_app_dev' NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO cairn_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO cairn_app;

-- Global (non-tenant) reference tables: readable by the application. Writable only
-- by migrations and seeds.
GRANT SELECT ON capability, lock_object, config_activity, message_catalog,
  job_definition, country, currency, unit_of_measure TO cairn_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cairn_app;
