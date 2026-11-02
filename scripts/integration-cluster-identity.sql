-- Install as the cluster bootstrap administrator in each integration database.
-- This narrowly exposes cluster identity to the migration role without granting
-- pg_read_all_settings (or any server-file privilege) to the runtime application.
BEGIN;

CREATE SCHEMA IF NOT EXISTS cairn_integration_guard AUTHORIZATION cairn;
ALTER SCHEMA cairn_integration_guard OWNER TO cairn;
REVOKE ALL ON SCHEMA cairn_integration_guard FROM PUBLIC;
REVOKE ALL ON SCHEMA cairn_integration_guard FROM cairn_app;
GRANT USAGE ON SCHEMA cairn_integration_guard TO cairn_integration_migrator;

CREATE OR REPLACE FUNCTION cairn_integration_guard.cluster_identity()
RETURNS TABLE (data_directory text, system_identifier text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
  SELECT pg_catalog.current_setting('data_directory')::text,
         (pg_catalog.pg_control_system()).system_identifier::text
$function$;

ALTER FUNCTION cairn_integration_guard.cluster_identity() OWNER TO cairn;
REVOKE ALL ON FUNCTION cairn_integration_guard.cluster_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION cairn_integration_guard.cluster_identity() FROM cairn_app;
GRANT EXECUTE ON FUNCTION cairn_integration_guard.cluster_identity() TO cairn_integration_migrator;

COMMIT;
