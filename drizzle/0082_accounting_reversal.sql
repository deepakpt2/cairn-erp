-- SCR-072 / R-120 (stage 3): accounting document reversal.
--
-- The reversal link keeps the original↔reversal relationship with
-- identity unique both ways: one successful reversal ever per
-- original, and a reversal identity may reversal exactly one
-- original. The reversal-reason register is tenant-configured
-- (2-char code at STGRD parity), validated active at execution.
-- The journal header already carries reversal_of / reversed_by /
-- reversal_reason (verified at schema stage), so no journal
-- columns land here. Neither record is edited or deleted after.
create table public.reversal_reason (
  client varchar(4) not null references public.client(client) on delete cascade,
  reason_code varchar(2) not null,
  reason_description varchar(80) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, reason_code),
  constraint reversal_reason_code_ck check (length(reason_code) = 2)
);
--> statement-breakpoint
create table public.accounting_reversal_link (
  client varchar(4) not null references public.client(client) on delete cascade,
  original_company_code varchar(10) not null,
  original_document_number varchar(40) not null,
  original_fiscal_year integer not null,
  reversal_company_code varchar(10) not null,
  reversal_document_number varchar(40) not null,
  reversal_fiscal_year integer not null,
  reversal_reason varchar(2) not null,
  reversal_document_date date not null,
  reversal_posting_period integer not null,
  reversal_posting_date date not null,
  reversal_currency char(3),
  reversed_by varchar(60) not null,
  reversal_amount_local numeric(23, 4) not null default 0,
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, original_company_code, original_document_number, original_fiscal_year),
  constraint accounting_reversal_link_reason_ck check (length(reversal_reason) = 2)
);
--> statement-breakpoint
create unique index accounting_reversal_link_reversal_uq
  on public.accounting_reversal_link (client, reversal_company_code, reversal_document_number, reversal_fiscal_year);
--> statement-breakpoint
create index accounting_reversal_link_reason_idx
  on public.accounting_reversal_link (client, reversal_reason);
--> statement-breakpoint
create index accounting_reversal_link_reversal_idx
  on public.accounting_reversal_link (client, reversal_document_number);
--> statement-breakpoint
create unique index accounting_reversal_link_request_key_uq
  on public.accounting_reversal_link (client, request_key) where request_key is not null;
