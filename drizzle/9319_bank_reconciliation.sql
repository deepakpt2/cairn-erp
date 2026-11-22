-- 9319_bank_reconciliation.sql
--
-- Manual bank statement reconciliation (finance). A statement is a reconciliation document, never a
-- journal: finalising it posts nothing and matching a statement line to a posted bank G/L line creates
-- no second posting and clears no AR/AP item. The tables below store the statement, its manually
-- entered lines, the confirmed allocations to posted bank G/L lines, and the immutable finalized
-- evidence snapshot. A reopen keeps the statement row; every finalization appends a snapshot.

create table if not exists public.bank_statement (
  client                 varchar(4)    not null references public.client(client) on delete cascade,
  statement_id           uuid          not null,
  company_code           varchar(10)   not null,
  house_bank_key         varchar(5)    not null,
  account_id             varchar(5)    not null,
  statement_reference    varchar(40)   not null,
  from_date              date          not null,
  to_date                date          not null,
  currency               char(3)       not null,
  opening_balance        numeric(23,4) not null,
  closing_balance        numeric(23,4) not null,
  status                 varchar(12)   not null default 'DRAFT',
  baseline               boolean       not null default false,
  baseline_amount        numeric(23,4) not null default 0,
  baseline_reason        text,
  request_key            varchar(80),
  finalized_snapshot_id  uuid,
  finalized_by           varchar(60),
  finalized_at           timestamp with time zone,
  reopened_by            varchar(60),
  reopened_at            timestamp with time zone,
  reopen_reason          text,
  created_by             varchar(60)   not null default 'SYSTEM',
  created_at             timestamp with time zone not null default now(),
  changed_by             varchar(60),
  changed_at             timestamp with time zone,
  constraint bank_statement_pk primary key (client, statement_id),
  constraint bank_statement_bank_account_fk
    foreign key (client, company_code, house_bank_key, account_id)
    references public.bank_account (client, company_code, house_bank_key, account_id) on delete restrict,
  constraint bank_statement_status_ck
    check (status in ('DRAFT', 'FINALIZED', 'REOPENED', 'SUPERSEDED')),
  constraint bank_statement_period_ck check (from_date <= to_date),
  constraint bank_statement_reference_ck check (length(btrim(statement_reference)) between 1 and 40)
);
-- Duplicate submission for the same account/reference is refused while the identity stands. A
-- correction is a reopen of the same statement, not a second statement under the same reference.
create unique index if not exists bank_statement_identity_uq
  on public.bank_statement (client, company_code, house_bank_key, account_id, statement_reference)
  where status <> 'SUPERSEDED';
create unique index if not exists bank_statement_request_uq
  on public.bank_statement (client, request_key) where request_key is not null;
create index if not exists bank_statement_account_idx
  on public.bank_statement (client, company_code, house_bank_key, account_id, to_date);

create table if not exists public.bank_statement_line (
  client            varchar(4)    not null references public.client(client) on delete cascade,
  statement_id      uuid          not null,
  line_id           uuid          not null,
  line_number       integer       not null,
  value_date        date          not null,
  transaction_date  date          not null,
  amount            numeric(23,4) not null,
  bank_reference    varchar(60),
  description       varchar(200),
  created_by        varchar(60)   not null default 'SYSTEM',
  created_at        timestamp with time zone not null default now(),
  changed_by        varchar(60),
  changed_at        timestamp with time zone,
  constraint bank_statement_line_pk primary key (client, line_id),
  constraint bank_statement_line_statement_fk
    foreign key (client, statement_id)
    references public.bank_statement (client, statement_id) on delete cascade,
  constraint bank_statement_line_sequence_uq unique (client, statement_id, line_number),
  constraint bank_statement_line_amount_ck check (amount <> 0),
  constraint bank_statement_line_number_ck check (line_number > 0)
);
create index if not exists bank_statement_line_statement_idx
  on public.bank_statement_line (client, statement_id);

create table if not exists public.bank_reconciliation_match (
  client                   varchar(4)    not null references public.client(client) on delete cascade,
  match_id                 uuid          not null,
  company_code             varchar(10)   not null,
  house_bank_key           varchar(5)    not null,
  account_id               varchar(5)    not null,
  statement_id             uuid          not null,
  statement_line_id        uuid          not null,
  gl_account               varchar(10)   not null,
  ledger_document_number   varchar(40)   not null,
  ledger_fiscal_year       integer       not null,
  ledger_line_number       integer       not null,
  allocated_amount         numeric(23,4) not null,
  currency                 char(3)       not null,
  is_active                boolean       not null default true,
  matched_by               varchar(60)   not null,
  matched_at               timestamp with time zone not null default now(),
  unmatched_by             varchar(60),
  unmatched_at             timestamp with time zone,
  unmatch_reason           text,
  request_key              varchar(80),
  created_by               varchar(60)   not null default 'SYSTEM',
  created_at               timestamp with time zone not null default now(),
  changed_by               varchar(60),
  changed_at               timestamp with time zone,
  constraint bank_reconciliation_match_pk primary key (client, match_id),
  constraint bank_reconciliation_match_statement_fk
    foreign key (client, statement_id)
    references public.bank_statement (client, statement_id) on delete cascade,
  constraint bank_reconciliation_match_line_fk
    foreign key (client, statement_line_id)
    references public.bank_statement_line (client, line_id) on delete restrict,
  constraint bank_reconciliation_match_ledger_fk
    foreign key (client, ledger_document_number, ledger_fiscal_year, ledger_line_number)
    references public.journal_entry_line (client, document_number, fiscal_year, line_number) on delete restrict,
  constraint bank_reconciliation_match_amount_ck check (allocated_amount > 0)
);
create unique index if not exists bank_reconciliation_match_replay_uq
  on public.bank_reconciliation_match
     (client, request_key, statement_line_id, ledger_document_number, ledger_fiscal_year, ledger_line_number)
  where request_key is not null;
create index if not exists bank_reconciliation_match_statement_idx
  on public.bank_reconciliation_match (client, statement_id, statement_line_id);
create index if not exists bank_reconciliation_match_ledger_idx
  on public.bank_reconciliation_match (client, ledger_document_number, ledger_fiscal_year, ledger_line_number);

create table if not exists public.bank_reconciliation_snapshot (
  client                     varchar(4)    not null references public.client(client) on delete cascade,
  snapshot_id                uuid          not null,
  statement_id               uuid          not null,
  sequence                   integer       not null,
  statement_reference        varchar(40)   not null,
  company_code               varchar(10)   not null,
  house_bank_key             varchar(5)    not null,
  account_id                 varchar(5)    not null,
  from_date                  date          not null,
  to_date                    date          not null,
  currency                   char(3)       not null,
  opening_balance            numeric(23,4) not null,
  closing_balance            numeric(23,4) not null,
  ledger_opening_balance     numeric(23,4) not null,
  ledger_closing_balance     numeric(23,4) not null,
  matched_statement_amount   numeric(23,4) not null,
  matched_ledger_amount      numeric(23,4) not null,
  unmatched_statement_amount numeric(23,4) not null,
  unmatched_ledger_amount    numeric(23,4) not null,
  baseline_amount            numeric(23,4) not null default 0,
  unexplained_difference     numeric(23,4) not null,
  ledger_line_count          integer       not null,
  match_count                integer       not null,
  outstanding_count          integer       not null,
  evidence                   jsonb         not null,
  finalized_by               varchar(60)   not null,
  finalized_at               timestamp with time zone not null default now(),
  created_by                 varchar(60)   not null default 'SYSTEM',
  created_at                 timestamp with time zone not null default now(),
  changed_by                 varchar(60),
  changed_at                 timestamp with time zone,
  constraint bank_reconciliation_snapshot_pk primary key (client, snapshot_id),
  constraint bank_reconciliation_snapshot_statement_fk
    foreign key (client, statement_id)
    references public.bank_statement (client, statement_id) on delete restrict,
  constraint bank_reconciliation_snapshot_sequence_uq unique (client, statement_id, sequence),
  constraint bank_reconciliation_snapshot_sequence_ck check (sequence > 0)
);
create index if not exists bank_reconciliation_snapshot_statement_idx
  on public.bank_reconciliation_snapshot (client, statement_id, sequence);

do $$
declare
  t text;
begin
  foreach t in array array[
    'bank_statement', 'bank_statement_line', 'bank_reconciliation_match', 'bank_reconciliation_snapshot'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;

-- The runtime role edits a draft, matches/unmatches (deactivates), and appends evidence. It never
-- deletes a match or a snapshot; statement lines may be removed only while the statement is a draft.
grant select, insert, update on table public.bank_statement to cairn_app;
grant select, insert, update, delete on table public.bank_statement_line to cairn_app;
grant select, insert, update on table public.bank_reconciliation_match to cairn_app;
grant select, insert on table public.bank_reconciliation_snapshot to cairn_app;

comment on table public.bank_statement is
  'Manual bank statement document per house-bank account. Never posts a journal; finalisation stores reconciliation evidence.';
comment on table public.bank_statement_line is
  'Manually entered statement line: signed amount in the account currency, debit-to-bank positive means money in.';
comment on table public.bank_reconciliation_match is
  'Confirmed allocation of a statement line to a posted bank G/L line. Evidence only; unmatching deactivates and keeps history.';
comment on table public.bank_reconciliation_snapshot is
  'Immutable finalized reconciliation evidence. A reopen appends a new snapshot; rows are never updated or deleted.';

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('FIN.BANK.STATEMENT.DISPLAY', 'FIN', 'DISPLAY', false, 'Display bank statements, matching and finalized reconciliation evidence'),
  ('FIN.BANK.STATEMENT.ENTER',   'FIN', 'MAINTAIN', false, 'Create and edit a manual bank statement and its lines'),
  ('FIN.BANK.STATEMENT.MATCH',   'FIN', 'POST', false, 'Match and unmatch statement lines against posted bank G/L lines'),
  ('FIN.BANK.STATEMENT.FINALIZE','FIN', 'APPROVE', false, 'Finalize a bank reconciliation and reopen or correct a finalized one')
on conflict (code) do nothing;
