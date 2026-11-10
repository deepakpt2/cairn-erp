-- SCR-087 / R-135 (stage 2): parked journal staging.
--
-- A parked document lives outside the journal until posting
-- converts it through the posting engine; the parked record is
-- then retained naming the canonical document. No foreign key
-- points at the journal from the header: before posting there is
-- nothing to point at. Deletion is a logical status, never a row
-- delete, and the posted reference is consistent by check.
create table public.parked_journal_header (
  client varchar(4) not null references public.client(client) on delete cascade,
  parked_number varchar(20) not null,
  fiscal_year integer not null,
  company_code varchar(10) not null,
  document_type varchar(12) not null,
  document_date date not null,
  posting_date date not null,
  currency char(3) not null,
  reference varchar(16),
  header_text varchar(100),
  status varchar(16) not null default 'PARKED',
  version integer not null default 1,
  status_reason text,
  posted_document_number varchar(40),
  posted_fiscal_year integer,
  posted_at timestamp with time zone,
  posted_by_user varchar(60),
  request_key varchar(64),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, parked_number),
  constraint parked_journal_status_ck
    check (status in ('PARKED', 'COMPLETED', 'POSTED', 'DELETED', 'REJECTED')),
  constraint parked_journal_version_ck check (version > 0),
  constraint parked_journal_posted_ref_ck check (
    status <> 'POSTED' or (
      posted_document_number is not null and posted_fiscal_year is not null
      and posted_at is not null and posted_by_user is not null
    )
  )
);
--> statement-breakpoint
create index parked_journal_status_idx
  on public.parked_journal_header (client, company_code, status, posting_date);
--> statement-breakpoint
create table public.parked_journal_line (
  client varchar(4) not null references public.client(client) on delete cascade,
  parked_number varchar(20) not null,
  fiscal_year integer not null,
  line_number integer not null,
  gl_account varchar(10) not null,
  debit_credit char(1) not null,
  amount numeric(23, 4) not null,
  cost_center varchar(20),
  profit_center varchar(20),
  tax_code varchar(4),
  assignment varchar(18),
  line_text varchar(100),
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, parked_number, fiscal_year, line_number),
  constraint parked_journal_line_header_fk
    foreign key (client, parked_number)
    references public.parked_journal_header (client, parked_number),
  constraint parked_journal_line_dc_ck check (debit_credit in ('S', 'H')),
  constraint parked_journal_line_amount_ck check (amount > 0)
);
--> statement-breakpoint
create index parked_journal_line_gl_idx
  on public.parked_journal_line (client, gl_account);
