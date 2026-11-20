-- 9316_activity_costing_wip.sql
--
-- Production activity costing and financial work-in-process (WIP).
--
--  work_center_costing            gains the three facts that value an ACTUAL confirmed quantity: which confirmation
--                                 parameter the line values (`parameter`), on which basis (`rate_basis`, today only
--                                 PLAN_RATE = "actual quantity valued at a configured plan rate" — NOT an actual-rate
--                                 calculation) and which plan version supplies the rate (`plan_version`). A line with
--                                 none of the three is exactly what it was: a cost centre/activity type for the
--                                 cost estimate. Several lines on one work centre are told apart by `parameter`,
--                                 never combined or guessed.
--  production_confirmation_cost   one row per (confirmation, parameter): the costing intent AND its outcome. The
--                                 evidence of the valuation (quantity, unit, rate basis, plan version, fixed and
--                                 variable price, price unit, sender, amount) and the posting reference (journal
--                                 document, and the reversal document once cancelled). FAILED / NOT_CONFIGURED rows
--                                 are the recoverable exceptions; a confirmation is never refused for them.
--  production_order_wip_posting   append-only ledger of financial WIP postings per order. Each row is one journal
--                                 document, signed delta, cumulative balance after, and the evidence it was
--                                 calculated from. It is what prior WIP is read from (WIP lines carry no
--                                 production_order, so they cannot be mistaken for order actuals).
--
-- New tables: SELECT and INSERT by default (migration-grant policy); the cost table also needs UPDATE because its
-- row moves PENDING-free states (FAILED -> POSTED -> REVERSED). The WIP ledger is never updated.

alter table public.work_center_costing
  add column if not exists parameter    varchar(6),
  add column if not exists rate_basis   varchar(16),
  add column if not exists plan_version varchar(3);

alter table public.work_center_costing drop constraint if exists work_center_costing_valuation_ck;
alter table public.work_center_costing add constraint work_center_costing_valuation_ck check (
  (rate_basis is null and parameter is null and plan_version is null)
  or (rate_basis = 'PLAN_RATE'
      and parameter ~ '^[A-Z0-9]{1,6}$'
      and plan_version ~ '^[A-Z0-9]{1,3}$'
      and activity_type is not null)
);
comment on column public.work_center_costing.rate_basis is
  'PLAN_RATE: an actual confirmed quantity is valued at the plan activity rate of plan_version. Not an actual-rate calculation.';

create table if not exists public.production_confirmation_cost (
  client              varchar(4)    not null references public.client(client) on delete cascade,
  confirmation_number varchar(12)   not null,
  parameter           varchar(6)    not null,
  order_number        varchar(12)   not null,
  status              varchar(14)   not null,
  quantity            numeric(23,3) not null,
  unit                varchar(6)    not null,
  plant               varchar(10),
  work_center         varchar(8),
  controlling_area    varchar(4),
  cost_center         varchar(10),
  activity_type       varchar(6),
  company_code        varchar(10),
  activity_unit       varchar(6),
  activity_quantity   numeric(23,6),
  rate_basis          varchar(40),
  plan_version        varchar(3),
  rate_year           integer,
  rate_period         smallint,
  fixed_price         numeric(23,6),
  variable_price      numeric(23,6),
  price_unit          integer,
  amount              numeric(23,4),
  currency            char(3),
  posting_date        date,
  journal_document    varchar(40),
  journal_year        integer,
  reversal_document   varchar(40),
  reversal_year       integer,
  message             varchar(400),
  remedy              varchar(400),
  attempts            integer       not null default 0,
  created_by          varchar(60)   not null default 'SYSTEM',
  created_at          timestamp with time zone not null default now(),
  changed_by          varchar(60),
  changed_at          timestamp with time zone,
  constraint production_confirmation_cost_pk primary key (client, confirmation_number, parameter),
  constraint production_confirmation_cost_confirmation_fk foreign key (client, confirmation_number)
    references public.production_confirmation (client, confirmation_number) on delete restrict,
  constraint production_confirmation_cost_status_ck
    check (status in ('POSTED', 'FAILED', 'NOT_CONFIGURED', 'REVERSED', 'CANCELLED')),
  constraint production_confirmation_cost_journal_ck
    check ((status in ('POSTED', 'REVERSED')) = (journal_document is not null and amount is not null and currency is not null)),
  constraint production_confirmation_cost_reversal_ck
    check ((status = 'REVERSED') = (reversal_document is not null)),
  constraint production_confirmation_cost_quantity_ck check (quantity > 0),
  constraint production_confirmation_cost_amount_ck check (amount is null or amount >= 0)
);
create index if not exists production_confirmation_cost_order_idx
  on public.production_confirmation_cost (client, order_number, status);
comment on table public.production_confirmation_cost is
  'Costing intent and outcome of one confirmed activity quantity: actual quantity valued at a configured plan rate, posted to the order against the sender cost centre. FAILED and NOT_CONFIGURED rows are recoverable exceptions.';

create table if not exists public.production_order_wip_posting (
  client               varchar(4)    not null references public.client(client) on delete cascade,
  posting_id           varchar(36)   not null,
  order_number         varchar(12)   not null,
  seq                  integer       not null,
  company_code         varchar(10)   not null,
  fiscal_year          integer       not null,
  period               smallint      not null,
  posting_date         date          not null,
  kind                 varchar(10)   not null,
  currency             char(3)       not null,
  cost_total           numeric(23,4) not null,
  output_total         numeric(23,4) not null,
  eligible_wip         numeric(23,4) not null,
  previous_cumulative  numeric(23,4) not null,
  delta                numeric(23,4) not null,
  cumulative_after     numeric(23,4) not null,
  wip_account          varchar(10)   not null,
  change_account       varchar(10)   not null,
  journal_document     varchar(40)   not null,
  journal_year         integer       not null,
  previous_posting_id  varchar(36),
  evidence             jsonb         not null,
  request_key          varchar(64),
  created_by           varchar(60)   not null,
  created_at           timestamp with time zone not null default now(),
  constraint production_order_wip_posting_pk primary key (client, posting_id),
  constraint production_order_wip_posting_order_fk foreign key (client, order_number)
    references public.production_order (client, order_number) on delete restrict,
  constraint production_order_wip_posting_seq_uq unique (client, order_number, seq),
  constraint production_order_wip_posting_kind_ck check (kind in ('PERIOD', 'UNWIND')),
  constraint production_order_wip_posting_delta_ck check (delta <> 0),
  constraint production_order_wip_posting_balance_ck check (cumulative_after = previous_cumulative + delta and cumulative_after >= 0),
  constraint production_order_wip_posting_period_ck check (period between 1 and 16 and seq > 0)
);
create unique index if not exists production_order_wip_posting_request_uq
  on public.production_order_wip_posting (client, request_key) where request_key is not null;
create index if not exists production_order_wip_posting_journal_idx
  on public.production_order_wip_posting (client, journal_document, journal_year);
comment on table public.production_order_wip_posting is
  'Append-only ledger of actual-cost WIP postings (balance sheet WIP against change in WIP). The cumulative balance after the last row is the WIP the order stands at.';

do $$
declare
  t text;
begin
  foreach t in array array['production_confirmation_cost', 'production_order_wip_posting'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists tenant_isolation on public.%I', t);
    execute format($p$create policy tenant_isolation on public.%I
      using (client::text = current_setting('cairn.client', true))
      with check (client::text = current_setting('cairn.client', true))$p$, t);
    execute format('revoke all on table public.%I from public', t);
  end loop;
end $$;
grant select, insert, update on table public.production_confirmation_cost to cairn_app;
grant select, insert on table public.production_order_wip_posting to cairn_app;
