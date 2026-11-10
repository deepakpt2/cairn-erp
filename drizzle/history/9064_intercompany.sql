-- SCR-122 (B-822/§26.836): intercompany posting and OBYA clearing
-- configuration. The OBYA clearing account already stands per company
-- code; this adds the optional per-pair override, the pairing record
-- that links the two posted documents, and the trading-partner stamp
-- on the canonical journal line (VBUND/RCOMP parity).

create table public.intercompany_clearing_config (
  client varchar(4) not null references public.client(client) on delete cascade,
  sending_company_code varchar(10) not null,
  receiving_company_code varchar(10) not null,
  sending_clearing_gl varchar(10),
  receiving_clearing_gl varchar(10),
  default_currency char(3),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, sending_company_code, receiving_company_code),
  constraint intercompany_clearing_config_distinct check (sending_company_code <> receiving_company_code)
);
--> statement-breakpoint
create table public.intercompany_document_header (
  client varchar(4) not null references public.client(client) on delete cascade,
  sending_company_code varchar(10) not null,
  document_number varchar(40) not null,
  fiscal_year integer not null,
  receiving_company_code varchar(10) not null,
  partner_document_number varchar(40) not null,
  partner_fiscal_year integer not null,
  posting_date date not null,
  document_date date not null,
  currency char(3) not null,
  reference varchar(16),
  status varchar(12) not null default 'POSTED',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, sending_company_code, document_number, fiscal_year),
  constraint intercompany_document_header_distinct check (sending_company_code <> receiving_company_code)
);
--> statement-breakpoint
create index intercompany_document_header_partner_idx
  on public.intercompany_document_header (client, receiving_company_code, partner_document_number);
--> statement-breakpoint
alter table public.journal_entry_line add column trading_partner_company varchar(10);
--> statement-breakpoint
comment on column public.journal_entry_line.trading_partner_company is
  'Trading partner company of an intercompany line (SCR-122, VBUND/RCOMP parity): the other company of the pair, stamped on both documents so a consolidation elimination can read the pair from the ledger.';
--> statement-breakpoint
alter table public.intercompany_clearing_config enable row level security;
--> statement-breakpoint
alter table public.intercompany_clearing_config force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.intercompany_clearing_config
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.intercompany_clearing_config from public;
--> statement-breakpoint
grant select, insert, update, delete on public.intercompany_clearing_config to cairn_app;
--> statement-breakpoint
alter table public.intercompany_document_header enable row level security;
--> statement-breakpoint
alter table public.intercompany_document_header force row level security;
--> statement-breakpoint
create policy tenant_isolation on public.intercompany_document_header
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
--> statement-breakpoint
revoke all on public.intercompany_document_header from public;
--> statement-breakpoint
grant select, insert, update, delete on public.intercompany_document_header to cairn_app;
