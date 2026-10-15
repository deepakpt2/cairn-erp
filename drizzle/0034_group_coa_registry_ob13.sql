-- SCR-026 / OB13 amendment: move Group Chart of Accounts into its own tenant-local
-- registry and reserve four-character keys tenant-wide across both registries.
--
-- Owner decisions applied here (2026-10-15):
--   1. Group CoA entries are maintained in a separate registry, not derived from
--      operational charts, so the Group CoA F4 can never offer a posting chart.
--   2. A key may be an operational Chart of Accounts OR a Group CoA, never both.
--   3. Registry entries carry Code, Description, Language Key and an active flag.
--   4. Lifecycle (deactivate/reactivate) reuses chart_of_accounts.is_active and the
--      registry's own is_active; no rows are deleted and references are retained.

DO $$
BEGIN
  -- Under shared key uniqueness an existing Group CoA reference would point at a code
  -- that is also an operational chart, which the new registry forbids. Refuse rather
  -- than silently rewrite accounting structure.
  IF EXISTS (
    SELECT 1 FROM chart_of_accounts WHERE group_chart IS NOT NULL
  ) THEN
    RAISE EXCEPTION '0034 refuses the Group CoA registry split: existing chart_of_accounts.group_chart references must be re-keyed to registry-only codes before this migration runs';
  END IF;

  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'group_chart_of_accounts'
      AND table_schema = current_schema()
  ) THEN
    RAISE EXCEPTION '0034 refuses to recreate group_chart_of_accounts: the registry already exists';
  END IF;
END $$;

CREATE TABLE group_chart_of_accounts (
  client varchar(4) NOT NULL,
  group_chart_of_accounts varchar(4) NOT NULL,
  name varchar(50) NOT NULL,
  language char(2) NOT NULL DEFAULT 'EN',
  is_active boolean NOT NULL DEFAULT true,
  created_by varchar(60) NOT NULL DEFAULT 'SYSTEM',
  created_at timestamptz NOT NULL DEFAULT now(),
  changed_by varchar(60),
  changed_at timestamptz,
  CONSTRAINT group_chart_of_accounts_pk
    PRIMARY KEY (client, group_chart_of_accounts),
  CONSTRAINT group_chart_of_accounts_key_format
    CHECK (group_chart_of_accounts ~ '^[A-Z0-9]{4}$'),
  CONSTRAINT group_chart_of_accounts_name_nonempty
    CHECK (length(btrim(name)) BETWEEN 1 AND 50),
  CONSTRAINT group_chart_of_accounts_language_format
    CHECK (language ~ '^[A-Z]{2}$'),
  CONSTRAINT group_chart_of_accounts_language_supported
    CHECK (language IN ('EN')),
  CONSTRAINT group_chart_of_accounts_client_fk
    FOREIGN KEY (client) REFERENCES client (client)
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE INDEX group_chart_of_accounts_active_idx
  ON group_chart_of_accounts (client, is_active, group_chart_of_accounts);

-- Group CoA now resolves to the registry instead of to another operational chart.
ALTER TABLE chart_of_accounts
  DROP CONSTRAINT chart_of_accounts_client_group_chart_fk;
ALTER TABLE chart_of_accounts
  ADD CONSTRAINT chart_of_accounts_client_group_chart_fk
    FOREIGN KEY (client, group_chart)
    REFERENCES group_chart_of_accounts (client, group_chart_of_accounts)
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Tenant-wide key reservation across both registries. The check runs as the invoking
-- role, so forced row-level security keeps it scoped to the current SAP client.
CREATE FUNCTION coa_key_registry_exclusive() RETURNS trigger AS $$
DECLARE
  tenant varchar(4);
  reserved_key varchar(4);
BEGIN
  IF tg_table_name = 'chart_of_accounts' THEN
    tenant := new.client;
    reserved_key := new.chart_of_accounts;
    IF EXISTS (
      SELECT 1 FROM group_chart_of_accounts registry
      WHERE registry.client = tenant
        AND registry.group_chart_of_accounts = reserved_key
    ) THEN
      RAISE EXCEPTION 'Chart of Accounts key % is reserved as a Group CoA in this SAP client', reserved_key
        USING ERRCODE = 'unique_violation';
    END IF;
  ELSE
    tenant := new.client;
    reserved_key := new.group_chart_of_accounts;
    IF EXISTS (
      SELECT 1 FROM chart_of_accounts chart
      WHERE chart.client = tenant
        AND chart.chart_of_accounts = reserved_key
    ) THEN
      RAISE EXCEPTION 'Group CoA key % is reserved as an operational Chart of Accounts in this SAP client', reserved_key
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER chart_of_accounts_key_registry_exclusive
  BEFORE INSERT OR UPDATE OF client, chart_of_accounts ON chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION coa_key_registry_exclusive();

CREATE TRIGGER group_chart_of_accounts_key_registry_exclusive
  BEFORE INSERT OR UPDATE OF client, group_chart_of_accounts ON group_chart_of_accounts
  FOR EACH ROW EXECUTE FUNCTION coa_key_registry_exclusive();

-- Least privilege: the application role may fire the trigger but nobody else may call it.
REVOKE ALL PRIVILEGES ON FUNCTION public.coa_key_registry_exclusive() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.coa_key_registry_exclusive() TO cairn_app';
  END IF;
END $$;
