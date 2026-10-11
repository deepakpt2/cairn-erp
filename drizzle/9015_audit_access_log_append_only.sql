-- The application may read and append access-log evidence, but it must not
-- rewrite, delete, or truncate it. Whole-tenant deletion remains governed by the
-- existing client -> audit_access_log ON DELETE CASCADE lifecycle exception.
REVOKE UPDATE, DELETE, TRUNCATE ON TABLE audit_access_log FROM cairn_app;
