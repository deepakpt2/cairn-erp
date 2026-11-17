-- 9303_mail_queue_delete.sql
--
-- The mail screen can now delete a queued message or clear the unsent ones. The queue table was
-- created with select/insert/update only; row level security (tenant_isolation) still scopes deletes.

grant delete on table public.mail_message to cairn_app;
