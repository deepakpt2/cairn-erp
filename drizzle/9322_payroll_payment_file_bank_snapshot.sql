-- 9322_payroll_payment_file_bank_snapshot.sql
--
-- The generic salary payment CSV now carries each employee's effective main bank account (9321). For a file
-- that includes bank data, the account identifier is snapshotted as an AES-256-GCM envelope bound to tenant +
-- employee + file id + field, in `bank_snapshot`; no account number or IBAN is stored in a plaintext column.
-- The frozen non-identifier fields (personnel number, beneficiary name, bank name/code, amount, currency,
-- date) are kept beside it so the CSV is rebuilt deterministically at download — never from live master data.
--
-- A file with bank data stores `body` NULL (its CSV is rebuilt from the snapshot on download; an unavailable
-- keyring fails closed). A legacy file prepared before 9322 keeps its plaintext `body`, `bank_data_included`
-- false and an empty snapshot: it downloads byte-for-byte as before and is never silently changed.

alter table public.payroll_payment_file alter column body drop not null;
alter table public.payroll_payment_file
  add column if not exists bank_snapshot jsonb not null default '[]'::jsonb;
alter table public.payroll_payment_file
  add column if not exists bank_data_included boolean not null default false;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'payroll_payment_file_body_or_snapshot_ck'
  ) then
    alter table public.payroll_payment_file
      add constraint payroll_payment_file_body_or_snapshot_ck check (
        (bank_data_included and jsonb_array_length(bank_snapshot) > 0 and body is null)
        or (not bank_data_included and body is not null)
      );
  end if;
end $$;

comment on column public.payroll_payment_file.bank_snapshot is
  'Per-employee frozen payment rows: non-identifier fields in the clear, the account identifier as an AES-256-GCM envelope bound to tenant + employee + file id. No plaintext account data.';
comment on column public.payroll_payment_file.bank_data_included is
  'True when the frozen file carries employee bank details; its CSV is rebuilt from the encrypted snapshot on download.';
