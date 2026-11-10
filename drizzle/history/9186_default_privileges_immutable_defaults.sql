-- Least-privilege default for future tables, plus confirmed append-only grants.
--
-- Inspected on the live database, not inferred from migration files:
--   * pg_default_acl has one row: grantor cairn, schema public, tables,
--     {cairn_app=arwd/cairn}. Sequences, functions, and types have no
--     default ACL.
--   * cairn owns every public table and is the migration role. cairn_app
--     is the runtime role. It is not a superuser, bypasses no RLS, inherits
--     no roles, and has no memberships. Its table rights are direct grants.
--   * cairn_app has USAGE, not CREATE, on public. PUBLIC has schema USAGE
--     and no table grants. TRUNCATE is not granted on any public table.
--   * 9000 grants future tables SELECT, INSERT, UPDATE, and DELETE. 9183
--     created the operation snapshots under that default, so UPDATE and
--     DELETE arrived even though the application only inserts. 9185 revoked
--     those two tables and is not modified here.
--
-- A blanket revoke of UPDATE and DELETE on every existing table is not safe.
-- Services update ordinary documents and masters, including production_order,
-- routing_operation, material, journal_entry, material_document,
-- consolidation_execution, and closing_execution_log. This migration does
-- not change those grants and does not grant anything new.
--
-- Future tables created by cairn in public keep SELECT and INSERT only.
-- A later mutable table must GRANT UPDATE, DELETE explicitly. An immutable
-- snapshot or append-only table must not. Defaults for other roles, schemas,
-- sequences, and functions are unchanged, so this does not broaden runtime
-- access. Existing table ACLs are not rewritten by ALTER DEFAULT PRIVILEGES.

alter default privileges in schema public
  revoke update, delete on tables from cairn_app;

-- Confirmed append-only tables whose live ACL still allowed cairn_app to
-- update or delete, and whose application writes are insert and select only:
--   * supplier_invoice_payment_block_event — schema contract: a release does
--     not update or delete an event.
--   * credit_change_audit — field audit described as append-only; inserts only.
--   * credit_release_event — append-only release event trail; inserts only.
--   * consolidation_execution_log — append-only detail lines; inserts only.
-- Owner rights stay with cairn. Tenant deletion still uses owner-side
-- foreign-key cascade. SELECT and INSERT remain so the existing writers work.
-- Tables with a lifecycle update (closing_execution_log, consolidation_execution,
-- journal_entry, material_document, and ordinary masters) are deliberately omitted.

revoke update, delete, truncate on table public.supplier_invoice_payment_block_event from cairn_app;
revoke update, delete, truncate on table public.credit_change_audit from cairn_app;
revoke update, delete, truncate on table public.credit_release_event from cairn_app;
revoke update, delete, truncate on table public.consolidation_execution_log from cairn_app;
