-- Production-order operation snapshots are historical.
--
-- 9000 grants the application role SELECT, INSERT, UPDATE, and DELETE on every
-- new table. 9183 then granted SELECT and INSERT, but that did not remove the
-- default UPDATE and DELETE. The application inserts a snapshot in the same
-- transaction as CO01 or conversion and never updates it. A confirmation or a
-- cancellation writes its own table. It does not rewrite this copy.
--
-- The application role is cairn_app, created by 9000 and used by the runtime
-- connection. It has no inherited membership. TRUNCATE was not in the default
-- grant; it is revoked here so a later broad grant does not reopen that path.
-- The table owner remains the migration role and keeps administration.
-- Existing rows, foreign keys, and indexes are not changed.

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE production_order_operation FROM cairn_app;
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE production_order_operation_value FROM cairn_app;
