-- 9321_employee_bank_details.sql
--
-- Employee salary bank details (SAP infotype 0009), maintained on the existing employee screen. They feed the
-- generic salary payment CSV. Account identifiers are stored ONLY as AES-256-GCM envelopes (cbd1…), bound to
-- tenant + employee + record id + field, exactly as partner bank data is. No plaintext account column exists.
--
-- One MAIN account per employee at any one time: an exclusion constraint forbids two ACTIVE records whose
-- inclusive validity ranges overlap, atomically, including concurrent writes. A change is a new effective-dated
-- record (end the old one, add a new one) — history is never overwritten.
--
-- Three least-privilege capabilities, granted to no role by default:
--   PEOPLE.BANK.VIEW     mask (last four only)
--   PEOPLE.BANK.MAINTAIN create/end bank records
--   PEOPLE.BANK.REVEAL   full value, audited

create extension if not exists btree_gist;

create table if not exists public.employee_bank_detail (
  client                     varchar(4)    not null references public.client(client) on delete cascade,
  -- Canonical server-generated UUIDv4; also the crypto AAD record identity.
  bank_record_id             uuid          not null,
  personnel_number           varchar(20)   not null,
  beneficiary_name           varchar(160)  not null,
  bank_name                  varchar(160)  not null,
  bank_code                  varchar(40),
  -- Identifier kind ('IBAN' | 'ACCOUNT') and its AES-256-GCM envelope. Never plaintext.
  account_kind               varchar(8)    not null,
  account_ciphertext         varchar(5600) not null,
  country                    char(2),
  valid_from                 date          not null,
  valid_to                   date,
  is_main                    boolean       not null default true,
  is_active                  boolean       not null default true,
  request_key                varchar(64),
  created_by                 varchar(60)   not null default 'SYSTEM',
  created_at                 timestamp with time zone not null default now(),
  changed_by                 varchar(60),
  changed_at                 timestamp with time zone,
  constraint employee_bank_detail_pk primary key (client, bank_record_id),
  constraint employee_bank_detail_employee_fk foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict,
  constraint employee_bank_detail_uuidv4 check (
    substring(bank_record_id::text from 15 for 1) = '4'
    and substring(bank_record_id::text from 20 for 1) in ('8', '9', 'a', 'b')
  ),
  constraint employee_bank_detail_name_ck check (length(trim(beneficiary_name)) > 0),
  constraint employee_bank_detail_bank_ck check (length(trim(bank_name)) > 0),
  constraint employee_bank_detail_kind_ck check (account_kind in ('IBAN', 'ACCOUNT')),
  constraint employee_bank_detail_envelope_ck check (
    account_ciphertext ~ '^cbd1[.][A-Za-z0-9_-]{1,32}[.][A-Za-z0-9_-]{16}[.][A-Za-z0-9_-]+[.][A-Za-z0-9_-]{22}$'
    and char_length(account_ciphertext) <= 5540
  ),
  constraint employee_bank_detail_period_ck check (valid_to is null or valid_to >= valid_from),
  -- One MAIN account at a time: no two ACTIVE main records may cover the same day. Atomic, concurrency-safe.
  constraint employee_bank_detail_main_overlap_ex exclude using gist (
    client with =, personnel_number with =,
    daterange(valid_from, coalesce(valid_to, 'infinity'::date), '[]') with &&
  ) where (is_active and is_main)
);
create index if not exists employee_bank_detail_employee_idx
  on public.employee_bank_detail (client, personnel_number, valid_from);
create unique index if not exists employee_bank_detail_request_uq
  on public.employee_bank_detail (client, request_key) where request_key is not null;

alter table public.employee_bank_detail enable row level security;
alter table public.employee_bank_detail force row level security;
drop policy if exists tenant_isolation on public.employee_bank_detail;
create policy tenant_isolation on public.employee_bank_detail
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

-- The app may add a record and end one (update valid_to/is_active). It never deletes: history is evidence.
grant select, insert, update on table public.employee_bank_detail to cairn_app;

comment on table public.employee_bank_detail is
  'Employee salary bank details (infotype 0009). Account identifiers are AES-256-GCM envelopes bound to tenant, employee and record id; one active main account per employee.';

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.BANK.VIEW',     'PEOPLE', 'DISPLAY',  false, 'View an employee salary bank record masked (last four characters only)'),
  ('PEOPLE.BANK.MAINTAIN', 'PEOPLE', 'MAINTAIN', false, 'Create and end effective-dated employee salary bank records (encrypted account identifiers)'),
  ('PEOPLE.BANK.REVEAL',   'PEOPLE', 'DISPLAY',  false, 'Reveal the full account number or IBAN of an employee bank record, audited')
on conflict (code) do nothing;
