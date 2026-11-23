-- 9327_payroll_payment_artifact_state_backfill.sql
--
-- Durable "artifact required" invariant for owners whose artifact metadata was created by 9325, before the
-- 9326 marker table existed. Without this, such an owner has no marker, so if its metadata row were later lost
-- the reader would classify it as genuine legacy evidence and could rebuild a payment-ready CSV substitute.
--
-- This marks DATABASE METADATA ONLY. It does not read, move, copy or create any host file, and it does not touch
-- any legacy body/snapshot evidence. There are no production deployments to migrate; this keeps already-created
-- development metadata consistent with the invariant. A fresh database simply inserts nothing.
--
-- Idempotent: INSERT ... ON CONFLICT DO NOTHING, so re-running (or applying over an already-marked owner) is a
-- no-op. changed_by/changed_at record the migration as the actor.

insert into public.payroll_payment_artifact_state (client, owner_kind, owner_id, format, changed_by, changed_at)
select a.client, a.owner_kind, a.owner_id, a.storage_format, 'MIGRATION-9327', now()
  from public.payroll_payment_artifact a
 where a.storage_format = 'cad1'
on conflict (client, owner_kind, owner_id) do nothing;

comment on table public.payroll_payment_artifact_state is
  'Marks an owner as new-format (must have a retained cad1 artifact). Absence of a row means genuinely legacy. Backfilled for 9325 metadata by 9327.';
