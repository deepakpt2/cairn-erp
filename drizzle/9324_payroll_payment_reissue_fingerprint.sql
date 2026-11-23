-- 9324_payroll_payment_reissue_fingerprint.sql
--
-- Idempotency for controlled salary-file reissue: a request key may replay ONLY an identical normalized
-- request (source, all/selected employee set, intended date, reason and every attestation field). The
-- fingerprint is the canonical hash of that payload, compared inside the per-run lock. Existing drafts keep
-- a NULL fingerprint and are never guessed; a replay against one is refused rather than returning the wrong
-- draft.
alter table public.payroll_payment_reissue
  add column if not exists request_fingerprint varchar(64);

comment on column public.payroll_payment_reissue.request_fingerprint is
  'Canonical hash of the normalized request payload; a repeated request key replays only an identical request. NULL for drafts created before this column existed.';
