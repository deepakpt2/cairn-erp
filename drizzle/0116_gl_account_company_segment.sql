-- SCR-110 / R-158 (stage 2): company-code segment of the G/L
-- master (SAP-parity FS15 scope) plus the transfer run audit.
-- The segment carries account currency, tax category, open-item
-- management, sort key and posting block per company. Backfill
-- inherits the chart-level values for every company standing on
-- each chart, so standing behavior is preserved the day the
-- table lands; where a segment row stands it governs.
create table public.gl_account_company (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  chart_of_accounts varchar(4) not null,
  gl_account varchar(10) not null,
  account_currency char(3) not null,
  tax_category varchar(2),
  is_open_item_managed boolean not null default false,
  sort_key varchar(3) not null default '000',
  is_blocked_posting boolean not null default false,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  updated_by varchar(60),
  updated_at timestamp with time zone,
  primary key (client, company_code, gl_account),
  foreign key (client, chart_of_accounts, gl_account)
    references public.gl_account (client, chart_of_accounts, account_number) on delete cascade,
  foreign key (client, company_code)
    references public.company_code (client, company_code) on delete cascade
);
--> statement-breakpoint
insert into public.gl_account_company
  (client, company_code, chart_of_accounts, gl_account, account_currency,
   tax_category, is_open_item_managed, sort_key, is_blocked_posting, created_by)
select cc.client, cc.company_code, cc.chart_of_accounts, ga.account_number, cc.currency,
       null, ga.is_open_item_managed, ga.sort_key, ga.is_blocked_posting, 'MIGRATION-0116'
from public.company_code cc
join public.gl_account ga
  on ga.client = cc.client and ga.chart_of_accounts = cc.chart_of_accounts
where cc.chart_of_accounts is not null
on conflict do nothing;
--> statement-breakpoint
create table public.gl_account_transfer_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  source_company_code varchar(10) not null,
  target_company_code varchar(10) not null,
  chart_of_accounts varchar(4) not null,
  account_from varchar(10),
  account_to varchar(10),
  test_run boolean not null,
  with_company_data boolean not null,
  overwrite_existing boolean not null,
  status varchar(20) not null,
  executed_by varchar(60) not null,
  executed_at timestamp with time zone not null default now(),
  primary key (client, run_id),
  check (status in ('COMPLETED', 'PARTIALLY_FAILED', 'FAILED')),
  check (source_company_code <> target_company_code)
);
--> statement-breakpoint
create table public.gl_account_transfer_result (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  gl_account varchar(10) not null,
  action varchar(10) not null,
  reason varchar(400) not null,
  primary key (client, run_id, gl_account),
  foreign key (client, run_id)
    references public.gl_account_transfer_run (client, run_id) on delete cascade,
  check (action in ('CREATED', 'UPDATED', 'SKIPPED', 'ERROR'))
);
