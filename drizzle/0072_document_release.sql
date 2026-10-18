-- SCR-060 / R-108 (stage 2): document release state.
--
-- One row per judged purchasing document: the strategy that claimed
-- it, the step it stands on, and its status. No strategy matching
-- means no row and nothing to release. Release events themselves
-- live in the documents' change history.
create table public.document_release (
  client varchar(4) not null references public.client(client) on delete cascade,
  document_category varchar(20) not null,
  document_number varchar(20) not null,
  group_code varchar(12) not null,
  strategy_code varchar(12) not null,
  current_step smallint not null default 0,
  status varchar(10) not null default 'PENDING',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client, document_category, document_number),
  foreign key (client, group_code, strategy_code)
    references public.release_strategy (client, group_code, strategy_code) on delete cascade,
  constraint document_release_category_ck check (document_category in ('PURCHASE_REQUISITION', 'PURCHASE_ORDER')),
  constraint document_release_status_ck check (status in ('PENDING', 'RELEASED')),
  constraint document_release_step_ck check (current_step >= 0)
);
