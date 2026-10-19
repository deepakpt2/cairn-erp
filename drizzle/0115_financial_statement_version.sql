-- SCR-106 / R-154 (stage 2): financial statement version canon.
-- The version binds to a chart; nodes form its hierarchy;
-- assignments place account ranges on nodes with a presentation
-- sign. Configuration only — the statement derives balances from
-- the posted journal and persists nothing. The journal index
-- serves the (company, year, period) aggregation.
create table public.financial_statement_version (
  client varchar(4) not null references public.client(client) on delete cascade,
  version varchar(10) not null,
  name varchar(80) not null,
  chart_of_accounts varchar(4) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, version),
  foreign key (client, chart_of_accounts)
    references public.chart_of_accounts (client, chart_of_accounts) on delete cascade
);
--> statement-breakpoint
create table public.financial_statement_node (
  client varchar(4) not null references public.client(client) on delete cascade,
  version varchar(10) not null,
  node varchar(20) not null,
  description varchar(120) not null,
  parent_node varchar(20),
  sequence integer not null default 0,
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, version, node),
  foreign key (client, version)
    references public.financial_statement_version (client, version) on delete cascade,
  foreign key (client, version, parent_node)
    references public.financial_statement_node (client, version, node) on delete cascade,
  check (parent_node is null or parent_node <> node)
);
--> statement-breakpoint
create table public.financial_statement_assignment (
  client varchar(4) not null references public.client(client) on delete cascade,
  version varchar(10) not null,
  node varchar(20) not null,
  account_from varchar(10) not null,
  account_to varchar(10) not null,
  presentation_sign varchar(8) not null default 'NORMAL',
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, version, node, account_from, account_to),
  foreign key (client, version, node)
    references public.financial_statement_node (client, version, node) on delete cascade,
  check (presentation_sign in ('NORMAL', 'INVERTED')),
  check (account_from <= account_to)
);
--> statement-breakpoint
create index journal_entry_company_year_period_idx
  on public.journal_entry (client, company_code, fiscal_year, posting_period);
