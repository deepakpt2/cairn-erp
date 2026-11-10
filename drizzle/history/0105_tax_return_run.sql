-- SCR-097 / R-145 (stage 2): tax return execution log and the
-- reported stamp on canonical journal lines.
--
-- House naming throughout (client, never tenant_id; no BSET or
-- T001 names). The run log is the audit record of every execution,
-- test and update alike. The stamp on the journal line is what an
-- update run sets so a tax line is not reported twice; a corrected
-- return re-includes stamped lines. The extraction index serves
-- the report's tax-code aggregation; the header date index the
-- package sketched already stands as journal_entry_company_date_idx.
create table public.tax_return_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  company_code varchar(10) not null,
  tax_group varchar(10),
  posting_date_from date not null,
  posting_date_to date not null,
  tax_return_country char(2) not null,
  is_test_run boolean not null default true,
  do_not_update_documents boolean not null default false,
  is_corrected_return boolean not null default false,
  electronic_return boolean not null default false,
  clearing_account varchar(10),
  total_tax_base numeric(23, 4) not null default 0,
  total_input_tax numeric(23, 4) not null default 0,
  total_output_tax numeric(23, 4) not null default 0,
  net_tax numeric(23, 4) not null default 0,
  currency char(3) not null,
  transfer_document_number varchar(40),
  lines_reported integer not null default 0,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, run_id)
);
--> statement-breakpoint
alter table public.journal_entry_line
  add column tax_return_run_id varchar(24);
--> statement-breakpoint
create index journal_entry_line_tax_report_idx
  on public.journal_entry_line (client, tax_code, tax_return_run_id);
