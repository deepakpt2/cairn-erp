-- SCR-026 / OB13 follow-up: vendor-free key-reservation messages (D-034).
--
-- The tenant-wide key reservation deployed by 0034 raises two exceptions whose text
-- names the reference vendor. D-034 permits that mark only inside Term Registry alias
-- data, so the deployed message text is corrected here.
--
-- 0033 and 0034 are NOT edited. The migration runner records a checksum per file and
-- refuses to apply one that has changed since it ran, and that rule is what makes an
-- applied migration trustworthy as a record of what actually happened. The correction
-- therefore lands as a new migration, and the two historical files are allowlisted in
-- the IP lint by exact line content, so any new occurrence in them still fails.
--
-- Only the two RAISE EXCEPTION strings change. The reservation logic, the
-- unique_violation error code and the trigger bindings are byte-for-byte equivalent,
-- so callers see the same behaviour with compliant wording.

CREATE OR REPLACE FUNCTION coa_key_registry_exclusive() RETURNS trigger AS $$
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
      RAISE EXCEPTION 'Chart of Accounts key % is reserved as a Group CoA in this tenant', reserved_key
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
      RAISE EXCEPTION 'Group CoA key % is reserved as an operational Chart of Accounts in this tenant', reserved_key
        USING ERRCODE = 'unique_violation';
    END IF;
  END IF;
  RETURN new;
END;
$$ LANGUAGE plpgsql;

-- CREATE OR REPLACE preserves privileges, and the least-privilege shape from 0034 is
-- restated so this file reads as the complete current intent for the function.
REVOKE ALL PRIVILEGES ON FUNCTION public.coa_key_registry_exclusive() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'cairn_app') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.coa_key_registry_exclusive() TO cairn_app';
  END IF;
END $$;
