-- 9329_payroll_payment_reissue_intent_line.sql
--
-- One row per employee an unresolved submission intent covers, so the server can enforce — atomically, against
-- ALL records rather than a page of the newest 20 — that two logical requests never overlap on the same payroll
-- obligation.
--
-- `unresolved` is true while the intent may still produce a draft (REGISTERED/RUNNING). The partial unique index is
-- the enforcement point: a second registration for the same (run, employee) fails in PostgreSQL itself, so two
-- simultaneous registrations cannot both pass and no application-level check has to be trusted.
--
-- The row is set unresolved = false when the header reaches a state that PROVES no further draft can appear:
-- COMPLETED (the draft exists and blocks on its own), REFUSED (a final content refusal) or ABANDONED (the
-- transition holds the intent row lock, so no execution is mid-transaction). A stale intent released this way
-- leaves an immutable audit row behind.

create table if not exists public.payroll_payment_reissue_intent_line (
  client            varchar(4)  not null references public.client(client) on delete cascade,
  intent_id         uuid        not null,
  run_id            varchar(36) not null,
  personnel_number  varchar(20) not null,
  unresolved        boolean     not null default true,
  created_by        varchar(60) not null default 'SYSTEM',
  created_at        timestamp with time zone not null default now(),
  changed_by        varchar(60),
  changed_at        timestamp with time zone,
  constraint payroll_payment_reissue_intent_line_pk primary key (client, intent_id, personnel_number),
  constraint payroll_payment_reissue_intent_line_intent_fk
    foreign key (client, intent_id)
    references public.payroll_payment_reissue_intent (client, intent_id) on delete cascade,
  constraint payroll_payment_reissue_intent_line_run_fk
    foreign key (client, run_id)
    references public.payroll_run (client, run_id) on delete restrict,
  constraint payroll_payment_reissue_intent_line_employee_fk
    foreign key (client, personnel_number)
    references public.employee (client, personnel_number) on delete restrict
);

create index if not exists payroll_payment_reissue_intent_line_intent_idx
  on public.payroll_payment_reissue_intent_line (client, intent_id);

-- The overlap guard. Only an unresolved attempt blocks; a resolved one is history.
create unique index if not exists payroll_payment_reissue_intent_line_unresolved_uq
  on public.payroll_payment_reissue_intent_line (client, run_id, personnel_number)
  where unresolved;

alter table public.payroll_payment_reissue_intent_line enable row level security;
alter table public.payroll_payment_reissue_intent_line force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_reissue_intent_line;
create policy tenant_isolation on public.payroll_payment_reissue_intent_line
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

-- The runtime role resolves a line in place; it never deletes one.
grant select, insert, update on table public.payroll_payment_reissue_intent_line to cairn_app;
revoke delete, truncate on table public.payroll_payment_reissue_intent_line from cairn_app;

comment on table public.payroll_payment_reissue_intent_line is
  'Per-employee coverage of an unresolved submission intent. The partial unique index on unresolved (run, employee) is the server-side overlap guard.';
