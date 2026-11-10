-- Second wave of the least-privilege audit: confirmed immutable tables.
--
-- 9186 revoked UPDATE and DELETE on four append-only tables and changed the
-- default privileges for future tables. These tables were found by the same
-- live inspection and carry the same kind of proof: the schema or service
-- contract states that the row is a record rather than a mutable field, and
-- a search of src, tests, and scripts found no UPDATE or DELETE against
-- any of them, in raw SQL or through the Drizzle query builder.
--
-- Each table below is insert-and-read only for the runtime role:
--
--   * clearing_reset — "Retained evidence of a reset: never edited or
--     deleted" (SCR-071 / R-119).
--   * credit_determination — "the single authoritative credit status per
--     sales document, superseding rather than editing" (SCR-105 / R-153).
--     A release and a reblock each insert a fresh determination that names
--     the one it supersedes.
--   * internal_order_original_budget and
--     internal_order_original_budget_year — "Original budget document. A
--     later document does not rewrite an earlier one." KO22 draws a new
--     document number for every change and inserts a new row.
--   * closing_task_event — the event trail of the period-end close cockpit,
--     whose contract names "an append-only execution log and event trail".
--     The execution log beside it carries a live status and stays mutable.
--   * document_status_history — "Every status transition on a document, with
--     who and why."
--   * document_flow_link — the document graph, whose module states that
--     nothing posted is ever deleted.
--
-- Owner rights stay with cairn, so the foreign-key cascade that removes a
-- tenant's rows still runs. SELECT and INSERT stay, so every existing writer
-- keeps working. Tables with a live status, a lifecycle, or an ordinary
-- editable master record are deliberately left alone, including
-- closing_execution_log, consolidation_execution, journal_entry,
-- material_document, customer_credit, and every configuration table.
--
-- change_document and change_document_item are not listed here: the test
-- suite deletes them as the runtime role, so that is an exercised path and
-- not a gap. document_index is likewise deleted by the browser smoke script
-- as the runtime role.

revoke update, delete, truncate on table public.clearing_reset from cairn_app;
revoke update, delete, truncate on table public.credit_determination from cairn_app;
revoke update, delete, truncate on table public.internal_order_original_budget from cairn_app;
revoke update, delete, truncate on table public.internal_order_original_budget_year from cairn_app;
revoke update, delete, truncate on table public.closing_task_event from cairn_app;
revoke update, delete, truncate on table public.document_status_history from cairn_app;
revoke update, delete, truncate on table public.document_flow_link from cairn_app;
