-- 9280_salary_payment.sql
--
-- Payroll phase 4: paying the net pay a posted payroll run created.
-- The document lives in journal_entry (document type PY); this row is the run's
-- proof that it was paid. One payment per run: a run is calculated once, posted
-- once, and paid once. There is no status — the payment posts or it does not.

create table if not exists public.salary_payment (
  client              varchar(4)  not null references public.client(client) on delete cascade,
  payment_id          varchar(36) not null,
  run_id              varchar(36) not null,
  company_code        varchar(4)  not null,
  fiscal_year         integer not null,
  period              integer not null,
  payment_date        date not null,
  currency            varchar(3)  not null,
  house_bank_key      varchar(5)  not null,
  bank_account_id     varchar(5)  not null,
  bank_gl_account     varchar(10) not null,
  net_pay_account     varchar(10) not null,
  employee_count      integer not null,
  total_amount        numeric(23,4) not null,
  document_number     varchar(40) not null,
  document_fiscal_year integer not null,
  request_key         varchar(64) not null,
  paid_by             varchar(60) not null,
  paid_at             timestamp with time zone not null,
  created_by          varchar(60) not null default 'SYSTEM',
  created_at          timestamp with time zone not null default now(),
  changed_by          varchar(60),
  changed_at          timestamp with time zone,
  primary key (client, payment_id),
  constraint salary_payment_run_fk foreign key (client, run_id)
    references public.payroll_run (client, run_id) on delete restrict,
  constraint salary_payment_period_ck check (period between 1 and 16),
  constraint salary_payment_currency_format_ck check (currency ~ '^[A-Z]{3}$'),
  constraint salary_payment_amount_ck check (total_amount > 0),
  constraint salary_payment_count_ck check (employee_count > 0),
  constraint salary_payment_bank_key_format_ck check (house_bank_key ~ '^[A-Z0-9]{1,5}$'),
  constraint salary_payment_bank_id_format_ck check (bank_account_id ~ '^[A-Z0-9]{1,5}$')
);
create unique index if not exists salary_payment_run_uq
  on public.salary_payment (client, run_id);
create index if not exists salary_payment_document_idx
  on public.salary_payment (client, document_number, document_fiscal_year);
comment on table public.salary_payment is
  'One payment of one posted payroll run (SAP PCP0 payment step). Snapshots the bank and net pay accounts; the PY document clears the PR document''s net pay credit.';

alter table public.salary_payment enable row level security;
alter table public.salary_payment force row level security;
drop policy if exists tenant_isolation on public.salary_payment;
create policy tenant_isolation on public.salary_payment
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.salary_payment from public;
-- Written once, never changed or deleted by the application.
grant select, insert on table public.salary_payment to cairn_app;

-- ── Document type PY for tenants that already stand ─────────────────────────
-- applyStandardPackage seeds it for new tenants; a tenant that already carries
-- the payroll posting type PR gets the payroll payment type beside it.
insert into public.document_type
  (client, document_type, name, number_range_object, number_range_sub_object, allowed_account_types, created_by)
select d.client, 'PY', 'Payroll payment', d.number_range_object, d.number_range_sub_object, 'S', 'MIGRATION_9280'
  from public.document_type d
 where d.document_type = 'PR'
on conflict do nothing;

-- ── Capability ──────────────────────────────────────────────────────────────
-- Granted to no role: payroll authority is withheld deliberately (history/9199).
insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('PEOPLE.PAYROLL.PAYMENT', 'PEOPLE', 'POST', false,
   'Pay the net pay of a posted payroll run from a house bank account')
on conflict (code) do nothing;

-- ── Registry: the payment is made from the run screen ───────────────────────
insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9280a000-0000-4000-8000-000000000001', 'PEOPLE.PAYROLL.PAYMENT', null, 'Pay salaries', 'TRANSACTION', 'PEOPLE',
       'Pay the net pay of a posted payroll run from a house bank account: one debit per employee on the net pay '
       || 'payable, one bank credit, and the payroll document''s payable cleared.',
       'TIER_1_BUILT', '/people/payroll-runs', 'B', null, true, 'MIGRATION_9280', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9280a000-0000-4000-8000-000000000001' or r.our_code = 'PEOPLE.PAYROLL.PAYMENT');
insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9280b000-0000-4000-8000-000000000001', '9280a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', 'PCP0', 'SEARCH_ONLY', 'MIGRATION_9280', now()
 where exists (select 1 from public.term_registry r where r.id = '9280a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9280b000-0000-4000-8000-000000000001');
