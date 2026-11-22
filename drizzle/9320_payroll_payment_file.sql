-- 9320_payroll_payment_file.sql
--
-- Generic salary payment file (people/payroll). A prepared, frozen CSV working file an authorised user
-- downloads and converts to their bank's own format before uploading it manually. It is NOT a bank
-- format, it is NOT sent to a bank, and preparing it posts nothing, clears nothing and marks no salary
-- paid: the salary accounting payment (PY document) is a separate, existing process.
--
-- One prepared file per run (unique (client, run_id)) is the duplicate-instruction guard: retries and
-- concurrent creation return the same frozen snapshot, and a later master-data change never silently
-- rewrites what a re-download contains. The CSV body is stored so a re-download is byte-identical.
--
-- No employee bank details are stored here: the ERP holds no authorised employee-account master, so the
-- beneficiary bank/account columns are exported blank for the user to complete in their bank's file.

create table if not exists public.payroll_payment_file (
  client                 varchar(4)    not null references public.client(client) on delete cascade,
  preparation_id         uuid          not null,
  run_id                 varchar(36)   not null,
  company_code           varchar(4)    not null,
  fiscal_year            integer       not null,
  period                 integer       not null,
  currency               char(3)       not null,
  -- The instruction date the user named (or the salary-payment date). Not proof of payment.
  intended_payment_date  date          not null,
  file_reference         varchar(60)   not null,
  filename               varchar(120)  not null,
  row_count              integer       not null,
  total_amount           numeric(23,4) not null,
  -- The frozen CSV, byte for byte. A re-download returns this and nothing rebuilt from master data.
  body                   bytea         not null,
  checksum               varchar(64)   not null,
  -- Personnel numbers only, used to re-judge employee reach on every download. Never bank details.
  beneficiaries          jsonb         not null,
  download_count         integer       not null default 0,
  prepared_by            varchar(60)   not null,
  prepared_at            timestamp with time zone not null default now(),
  last_downloaded_by     varchar(60),
  last_downloaded_at     timestamp with time zone,
  created_by             varchar(60)   not null default 'SYSTEM',
  created_at             timestamp with time zone not null default now(),
  changed_by             varchar(60),
  changed_at             timestamp with time zone,
  constraint payroll_payment_file_pk primary key (client, preparation_id),
  constraint payroll_payment_file_run_fk
    foreign key (client, run_id) references public.payroll_run (client, run_id) on delete restrict,
  -- One prepared batch per run: a retry cannot mint a second instruction identity.
  constraint payroll_payment_file_run_uq unique (client, run_id),
  constraint payroll_payment_file_reference_uq unique (client, file_reference),
  constraint payroll_payment_file_period_ck check (period between 1 and 16),
  constraint payroll_payment_file_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint payroll_payment_file_count_ck check (row_count > 0),
  constraint payroll_payment_file_amount_ck check (total_amount > 0),
  constraint payroll_payment_file_downloads_ck check (download_count >= 0)
);
create index if not exists payroll_payment_file_run_idx
  on public.payroll_payment_file (client, run_id);

alter table public.payroll_payment_file enable row level security;
alter table public.payroll_payment_file force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_file;
create policy tenant_isolation on public.payroll_payment_file
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

-- The runtime role prepares once and updates only the download counters. It never deletes a batch: a
-- superseded instruction is resolved by an administrator, not by erasing history.
grant select, insert, update on table public.payroll_payment_file to cairn_app;

comment on table public.payroll_payment_file is
  'Frozen generic salary payment CSV per posted payroll run. A working file for manual bank conversion; never sent to a bank and never proof of payment.';

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.PAYROLL.FILE.EXPORT', 'PEOPLE', 'EXPORT', false,
   'Prepare and download the generic salary payment CSV for a posted payroll run (a working file for manual bank upload; grants no posting or payment)')
on conflict (code) do nothing;
