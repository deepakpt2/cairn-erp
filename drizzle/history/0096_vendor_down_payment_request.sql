-- SCR-086 / R-134 (stage 2): the vendor down-payment request.
--
-- The vendor twin of the customer noted item (0095): the request
-- record is itself the document, no journal is touched and no
-- account moves. Fulfillment rows link a request to the actual
-- F-48 payment line; fulfilled amounts derive from ACTIVE links.
create table public.vendor_down_payment_request (
  client varchar(4) not null references public.client(client) on delete cascade,
  request_number varchar(20) not null,
  fiscal_year integer not null,
  vendor_number varchar(20) not null,
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
  constraint vendor_dp_request_amount_ck check (requested_amount > 0),
  constraint vendor_dp_request_status_ck
    check (status in ('OPEN', 'PARTIAL', 'FULFILLED', 'CLOSED', 'REVERSED'))
);
--> statement-breakpoint
create index vdpr_vendor_idx
  on public.vendor_down_payment_request (client, company_code, vendor_number, due_date);
--> statement-breakpoint
create table public.vendor_dp_request_fulfillment (
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
  constraint vendor_dp_fulfillment_request_fk
    foreign key (client, request_number)
    references public.vendor_down_payment_request (client, request_number),
  constraint vendor_dp_fulfillment_actual_fk
    foreign key (client, actual_document_number, actual_fiscal_year, actual_line_number)
    references public.journal_entry_line (client, document_number, fiscal_year, line_number),
  constraint vendor_dp_fulfillment_amount_ck check (fulfilled_amount > 0),
  constraint vendor_dp_fulfillment_status_ck check (status in ('ACTIVE', 'REVERSED'))
);
--> statement-breakpoint
create index vdprf_actual_idx
  on public.vendor_dp_request_fulfillment (client, actual_document_number, actual_fiscal_year);
