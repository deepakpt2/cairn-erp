-- 9323_payroll_payment_reissue.sql
--
-- Controlled replacement of a generic salary payment file for ALL or SELECTED employees (SAP-inspired, but
-- generic manual-file processing — not a particular SAP localization). A reissue is an INSTRUCTION only: it
-- creates a new CSV, never a payroll recalculation, never an accounting payment and never evidence the bank
-- paid anyone. Original files and their snapshots are never changed.
--
-- Flow: a requester records a user ATTESTATION of each selected employee's original instruction outcome
-- (not uploaded / bank rejected / cancelled before execution / returned) and creates a DRAFT with a frozen,
-- encrypted replacement snapshot. A DIFFERENT authorized approver releases it. Only then can it be downloaded.
-- One DRAFT per employee obligation at a time (partial unique index); approved versions are immutable.

create table if not exists public.payroll_payment_reissue (
  client                 varchar(4)    not null references public.client(client) on delete cascade,
  reissue_id             uuid          not null,
  source_preparation_id  uuid          not null,
  run_id                 varchar(36)   not null,
  company_code           varchar(4)    not null,
  fiscal_year            integer       not null,
  period                 integer       not null,
  currency               char(3)       not null,
  version                integer       not null,
  reissue_reference      varchar(60)   not null,
  filename               varchar(120)  not null,
  intended_payment_date  date          not null,
  selection              varchar(8)    not null,
  employee_count         integer       not null,
  total_amount           numeric(23,4) not null,
  status                 varchar(10)   not null default 'DRAFT',
  reason                 varchar(200)  not null,
  -- The frozen replacement rows: clear metadata + each account identifier as an AES-256-GCM envelope bound to
  -- tenant + employee + reissue_id. No plaintext account data.
  bank_snapshot          jsonb         not null default '[]'::jsonb,
  checksum               varchar(64)   not null,
  request_key            varchar(64),
  requested_by           varchar(60)   not null,
  requested_at           timestamp with time zone not null default now(),
  approved_by            varchar(60),
  approved_at            timestamp with time zone,
  cancelled_by           varchar(60),
  cancelled_at           timestamp with time zone,
  cancel_reason          varchar(200),
  created_by             varchar(60)   not null default 'SYSTEM',
  created_at             timestamp with time zone not null default now(),
  changed_by             varchar(60),
  changed_at             timestamp with time zone,
  constraint payroll_payment_reissue_pk primary key (client, reissue_id),
  constraint payroll_payment_reissue_source_fk foreign key (client, source_preparation_id)
    references public.payroll_payment_file (client, preparation_id) on delete restrict,
  constraint payroll_payment_reissue_run_fk foreign key (client, run_id)
    references public.payroll_run (client, run_id) on delete restrict,
  constraint payroll_payment_reissue_uuidv4 check (
    substring(reissue_id::text from 15 for 1) = '4'
    and substring(reissue_id::text from 20 for 1) in ('8', '9', 'a', 'b')
  ),
  constraint payroll_payment_reissue_status_ck check (status in ('DRAFT', 'APPROVED', 'CANCELLED')),
  constraint payroll_payment_reissue_selection_ck check (selection in ('ALL', 'SELECTED')),
  constraint payroll_payment_reissue_period_ck check (period between 1 and 16),
  constraint payroll_payment_reissue_currency_ck check (currency ~ '^[A-Z]{3}$'),
  constraint payroll_payment_reissue_count_ck check (employee_count > 0),
  constraint payroll_payment_reissue_amount_ck check (total_amount > 0),
  constraint payroll_payment_reissue_version_ck check (version > 0),
  constraint payroll_payment_reissue_reason_ck check (length(trim(reason)) > 0),
  constraint payroll_payment_reissue_approver_ck check (approved_by is null or lower(approved_by) <> lower(requested_by)),
  constraint payroll_payment_reissue_cancel_ck check ((status = 'CANCELLED') = (cancelled_at is not null))
);
create unique index if not exists payroll_payment_reissue_reference_uq
  on public.payroll_payment_reissue (client, reissue_reference);
create unique index if not exists payroll_payment_reissue_request_uq
  on public.payroll_payment_reissue (client, request_key) where request_key is not null;
create unique index if not exists payroll_payment_reissue_version_uq
  on public.payroll_payment_reissue (client, run_id, version);
create index if not exists payroll_payment_reissue_run_idx
  on public.payroll_payment_reissue (client, run_id, status);

create table if not exists public.payroll_payment_reissue_line (
  client                varchar(4)    not null references public.client(client) on delete cascade,
  reissue_id            uuid          not null,
  line_no               integer       not null,
  run_id                varchar(36)   not null,
  personnel_number      varchar(20)   not null,
  amount                numeric(23,4) not null,
  currency              char(3)       not null,
  -- The attempt this replacement replaces: the original file, or a prior approved reissue for this employee.
  predecessor_kind      varchar(8)    not null,
  predecessor_id        varchar(36)   not null,
  -- User-attested original instruction outcome. NOT an ERP-verified bank status.
  attestation_outcome   varchar(32)   not null,
  attestation_reason    varchar(200)  not null,
  verification_date     date          not null,
  evidence_reference    varchar(200)  not null,
  confirmed_no_submission boolean     not null default false,
  state                 varchar(10)   not null default 'DRAFT',
  created_by            varchar(60)   not null default 'SYSTEM',
  created_at            timestamp with time zone not null default now(),
  changed_by            varchar(60),
  changed_at            timestamp with time zone,
  constraint payroll_payment_reissue_line_pk primary key (client, reissue_id, line_no),
  constraint payroll_payment_reissue_line_reissue_fk foreign key (client, reissue_id)
    references public.payroll_payment_reissue (client, reissue_id) on delete cascade,
  constraint payroll_payment_reissue_line_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint payroll_payment_reissue_line_kind_ck check (predecessor_kind in ('FILE', 'REISSUE')),
  constraint payroll_payment_reissue_line_outcome_ck check (attestation_outcome in
    ('NOT_UPLOADED', 'BANK_REJECTED', 'CANCELLED_BEFORE_EXECUTION', 'RETURNED')),
  constraint payroll_payment_reissue_line_state_ck check (state in ('DRAFT', 'APPROVED', 'CANCELLED')),
  constraint payroll_payment_reissue_line_amount_ck check (amount > 0),
  constraint payroll_payment_reissue_line_reason_ck check (length(trim(attestation_reason)) > 0),
  constraint payroll_payment_reissue_line_evidence_ck check (length(trim(evidence_reference)) > 0),
  -- "Not uploaded" is only a valid attestation with an explicit confirmation that no copy was submitted.
  constraint payroll_payment_reissue_line_no_submission_ck check (
    attestation_outcome <> 'NOT_UPLOADED' or confirmed_no_submission
  )
);
-- One DRAFT replacement per employee and payroll obligation: concurrent/retried requests cannot form two.
create unique index if not exists payroll_payment_reissue_line_active_uq
  on public.payroll_payment_reissue_line (client, run_id, personnel_number) where state = 'DRAFT';
create index if not exists payroll_payment_reissue_line_reissue_idx
  on public.payroll_payment_reissue_line (client, reissue_id);

alter table public.payroll_payment_reissue enable row level security;
alter table public.payroll_payment_reissue force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_reissue;
create policy tenant_isolation on public.payroll_payment_reissue
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
alter table public.payroll_payment_reissue_line enable row level security;
alter table public.payroll_payment_reissue_line force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_reissue_line;
create policy tenant_isolation on public.payroll_payment_reissue_line
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

grant select, insert, update on table public.payroll_payment_reissue to cairn_app;
grant select, insert, update on table public.payroll_payment_reissue_line to cairn_app;

comment on table public.payroll_payment_reissue is
  'Controlled replacement salary payment file (all or selected employees). An instruction only: never a recalculation, accounting payment or proof the bank paid.';
comment on table public.payroll_payment_reissue_line is
  'One selected employee in a replacement: frozen amount, user-attested original outcome and predecessor attempt. No bank identifier in the clear.';

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.PAYROLL.REISSUE.REQUEST',  'PEOPLE', 'CREATE',  false, 'Request a controlled replacement of a salary payment file (all or selected employees) with a user-attested original outcome'),
  ('PEOPLE.PAYROLL.REISSUE.APPROVE',  'PEOPLE', 'APPROVE', false, 'Approve a requested salary payment-file replacement; must be a different person from the requester'),
  ('PEOPLE.PAYROLL.REISSUE.DOWNLOAD', 'PEOPLE', 'EXPORT',  false, 'Download an approved replacement salary payment CSV (an instruction for manual bank upload, not proof of payment)'),
  ('PEOPLE.PAYROLL.FILE.HISTORICAL',   'PEOPLE', 'EXPORT',  false, 'Download a superseded salary payment file as protected historical evidence, clearly marked do-not-upload')
on conflict (code) do nothing;
