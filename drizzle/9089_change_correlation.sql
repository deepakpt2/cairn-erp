-- SCR-147 — a change record can name the request that caused it.
--
-- The MI04 package (§9) asks the count history to carry a request/correlation identifier, so a
-- retried submission can be told from a fresh one by the trail alone. The change log was the only
-- audit in canon without one; the column is nullable and every existing caller is unaffected.
alter table public.change_document
  add column if not exists correlation_id varchar(64);
