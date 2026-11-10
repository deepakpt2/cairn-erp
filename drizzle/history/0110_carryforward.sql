-- SCR-102 / R-150 (stage 2): balance carryforward run protocol.
-- No balance-summary table is created: openings derive from the
-- posted journal at read time; these two tables are the run
-- history and its per-account result protocol only. Runs are
-- repeatable by construction (no key prevents a repeat).
create table public.carryforward_run (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  ledger varchar(2) not null,
  source_fiscal_year integer not null,
  target_fiscal_year integer not null,
  company_codes varchar(240) not null,
  is_test_run boolean not null default true,
  status varchar(12) not null default 'RUNNING',
  accounts_processed integer not null default 0,
  carried_amount numeric(23, 4) not null default 0,
  pl_transfer_amount numeric(23, 4) not null default 0,
  error_count integer not null default 0,
  transfer_documents varchar(480),
  executed_by varchar(60) not null,
  started_at timestamp with time zone not null default now(),
  ended_at timestamp with time zone,
  primary key (client, run_id),
  check (status in ('RUNNING', 'COMPLETED', 'FAILED')),
  check (target_fiscal_year = source_fiscal_year + 1)
);
--> statement-breakpoint
create index carryforward_run_scope_idx
  on public.carryforward_run (client, ledger, target_fiscal_year, status, started_at);
--> statement-breakpoint
create table public.carryforward_result (
  client varchar(4) not null references public.client(client) on delete cascade,
  run_id varchar(24) not null,
  company_code varchar(10) not null,
  account_number varchar(10) not null,
  account_category varchar(16) not null,
  profit_center varchar(20) not null default '',
  currency char(3) not null,
  source_closing_balance numeric(23, 4) not null,
  target_opening_balance numeric(23, 4) not null,
  retained_earnings_account varchar(10),
  transfer_document_number varchar(40),
  status varchar(12) not null,
  detail varchar(240),
  primary key (client, run_id, company_code, account_number, profit_center, currency),
  foreign key (client, run_id)
    references public.carryforward_run (client, run_id) on delete cascade,
  check (account_category in ('BALANCE_SHEET', 'PL_STATEMENT')),
  check (status in ('CARRIED', 'TRANSFERRED', 'EXCEPTION'))
);
