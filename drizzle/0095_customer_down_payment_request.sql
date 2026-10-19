-- SCR-085 / R-133 (stage 2): the customer down-payment request.
--
-- A noted item: the request record is itself the document, so no
-- journal table is touched and no account moves. Special G/L rows
-- gain the target indicator that marks a request (noted) indicator
-- and names the actual indicator expected at fulfillment. The
-- fulfillment rows link a request to the actual F-29 receipt line;
-- fulfilled amounts derive from the ACTIVE links.
alter table public.special_gl_config
  add column target_special_gl_indicator varchar(1);
--> statement-breakpoint
create table public.customer_down_payment_request (
  client varchar(4) not null references public.client(client) on delete cascade,
  request_number varchar(20) not null,
  fiscal_year integer not null,
  customer_number varchar(20) not null,
  company_code varchar(10) not null,
  special_gl_indicator varchar(1) not null,
  target_special_gl_indicator varchar(1) not null,
  document_date date not null,
  posting_date date not null,
  due_date date not null,
  document_type varchar(12) not null,
  currency char(3) not null,
  reference varchar(16),
  requested_amount numeric(23, 4) not null,
  status varchar(12) not null default 'OPEN',
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, request_number),
  constraint customer_dp_request_amount_ck check (requested_amount > 0),
  constraint customer_dp_request_status_ck
    check (status in ('OPEN', 'PARTIAL', 'FULFILLED', 'CLOSED', 'REVERSED'))
);
--> statement-breakpoint
create index cdpr_customer_idx
  on public.customer_down_payment_request (client, company_code, customer_number, due_date);
--> statement-breakpoint
create table public.down_payment_request_fulfillment (
  client varchar(4) not null references public.client(client) on delete cascade,
  request_number varchar(20) not null,
  request_fiscal_year integer not null,
  fulfillment_number integer not null,
  actual_document_number varchar(40) not null,
  actual_fiscal_year integer not null,
  actual_line_number integer not null,
  fulfillment_currency char(3) not null,
  fulfilled_amount numeric(23, 4) not null,
  status varchar(12) not null default 'ACTIVE',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, request_number, request_fiscal_year, fulfillment_number),
  constraint dp_request_fulfillment_request_fk
    foreign key (client, request_number)
    references public.customer_down_payment_request (client, request_number),
  constraint dp_request_fulfillment_actual_fk
    foreign key (client, actual_document_number, actual_fiscal_year, actual_line_number)
    references public.journal_entry_line (client, document_number, fiscal_year, line_number),
  constraint dp_request_fulfillment_amount_ck check (fulfilled_amount > 0),
  constraint dp_request_fulfillment_status_ck check (status in ('ACTIVE', 'REVERSED'))
);
--> statement-breakpoint
create index dprf_actual_idx
  on public.down_payment_request_fulfillment (client, actual_document_number, actual_fiscal_year);
