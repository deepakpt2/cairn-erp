-- SCR-100 / R-148 (stage 2): accrual/deferral metadata keyed by
-- the canonical document identity. No accrual header or line
-- tables duplicate the ledger — this is the reversal metadata the
-- canonical structures do not carry, with a tenant-safe composite
-- reference to the journal document.
create table public.accrual_document (
  client varchar(4) not null references public.client(client) on delete cascade,
  company_code varchar(10) not null,
  document_number varchar(40) not null,
  fiscal_year integer not null,
  reversal_date date not null,
  reversal_reason varchar(2) not null,
  reversal_status varchar(12) not null default 'PENDING',
  reversal_document_number varchar(40),
  reversal_fiscal_year integer,
  reversed_at timestamp with time zone,
  reversed_by varchar(60),
  created_by varchar(60) not null,
  created_at timestamp with time zone not null default now(),
  primary key (client, company_code, document_number, fiscal_year),
  foreign key (client, document_number, fiscal_year)
    references public.journal_entry (client, document_number, fiscal_year) on delete cascade,
  check (reversal_status in ('PENDING', 'REVERSED')),
  check ((reversal_status = 'REVERSED') = (reversal_document_number is not null and reversed_at is not null and reversed_by is not null))
);
--> statement-breakpoint
create index accrual_document_due_idx
  on public.accrual_document (client, company_code, reversal_status, reversal_date);
