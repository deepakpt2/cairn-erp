-- 9279_payroll_posting.sql
--
-- Payroll phase 3: the link from a run to the accounting document it produced,
-- and the account determination for net pay.
--
-- The document itself lives in journal_entry (document type PR); nothing here
-- duplicates it. A run carries its document number exactly when it is POSTED.

alter table public.payroll_run
  add column if not exists document_number      varchar(40),
  add column if not exists document_fiscal_year integer,
  add column if not exists posted_by            varchar(60),
  add column if not exists posted_at            timestamp with time zone,
  add column if not exists posting_request_key  varchar(64);

alter table public.payroll_run drop constraint if exists payroll_run_document_pair_ck;
alter table public.payroll_run
  add constraint payroll_run_document_pair_ck
  check ((document_number is null and document_fiscal_year is null)
      or (document_number is not null and document_fiscal_year is not null));

-- A posted run carries its document; nothing else does.
alter table public.payroll_run drop constraint if exists payroll_run_posted_document_ck;
alter table public.payroll_run
  add constraint payroll_run_posted_document_ck
  check ((status = 'POSTED') = (document_number is not null));

-- ── PAYROLL_NET_PAY determination for tenants that already stand ─────────────
-- applyStandardPackage seeds it for new tenants. A tenant activated before this
-- migration gets the same row wherever its chart holds the delivered net pay
-- payable account and nothing has been maintained for the event yet.
insert into public.account_determination
  (client, chart_of_accounts, event, valuation_class, general_modifier, gl_account, created_by)
select g.client, g.chart_of_accounts, 'PAYROLL_NET_PAY', '', '', g.account_number, 'MIGRATION_9279'
  from public.gl_account g
 where g.account_number = '251000'
   and not exists (
     select 1 from public.account_determination d
      where d.client = g.client and d.chart_of_accounts = g.chart_of_accounts
        and d.event = 'PAYROLL_NET_PAY')
on conflict do nothing;
