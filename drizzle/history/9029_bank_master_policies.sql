-- SCR-036 stage 2: the bank master is global reference data, like the country
-- and currency masters it stands beside — no client column exists, so there is
-- no tenant predicate to write. Unlike those seed-only masters it is maintained
-- through the application (R-86), so cairn_app takes DML on it; PUBLIC takes
-- nothing. Who may write is decided in the application, by the
-- CFG.FIN.BANK.DEFINE capability: the database's part is that the table is
-- world-readable to the application role and alterable by nobody else.
REVOKE ALL ON TABLE bank_master FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE bank_master TO cairn_app;
