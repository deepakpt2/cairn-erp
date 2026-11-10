-- SCR-165 — vendor evaluation.
--
-- A criterion is configuration. A manual assessment is the score a person
-- entered. An automatic score is not stored here: it is calculated from
-- posted purchasing history. The overall score is not a column.

create table if not exists public.vendor_evaluation_criterion (
  client varchar(4) not null references public.client (client) on delete cascade,
  criterion_code varchar(16) not null,
  description varchar(40) not null,
  method varchar(12) not null,
  evidence varchar(16) not null,
  score_min numeric(5, 2) not null,
  score_max numeric(5, 2) not null,
  weight numeric(5, 2) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint vendor_evaluation_criterion_pk primary key (client, criterion_code),
  constraint vendor_evaluation_criterion_method_ck check (method in ('MANUAL', 'AUTOMATIC')),
  constraint vendor_evaluation_criterion_evidence_ck check (evidence in ('NONE', 'PRICE', 'DELIVERY')),
  constraint vendor_evaluation_criterion_pair_ck check ((method = 'MANUAL') = (evidence = 'NONE')),
  constraint vendor_evaluation_criterion_scale_ck check (score_min >= 0 and score_max <= 100 and score_min < score_max),
  constraint vendor_evaluation_criterion_weight_ck check (weight > 0 and weight <= 100),
  constraint vendor_evaluation_criterion_code_ck check (criterion_code ~ '^[A-Z][A-Z0-9_]{0,15}$')
);

create table if not exists public.vendor_evaluation_assessment (
  client varchar(4) not null references public.client (client) on delete cascade,
  supplier_number varchar(40) not null,
  purchasing_org varchar(10) not null,
  period_from date not null,
  period_to date not null,
  criterion_code varchar(16) not null,
  score numeric(5, 2) not null,
  reason varchar(100) not null,
  request_key varchar(64) not null,
  version integer not null default 1,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  constraint vendor_evaluation_assessment_pk primary key (client, supplier_number, purchasing_org, period_from, period_to, criterion_code),
  constraint vendor_evaluation_assessment_request_uq unique (client, request_key),
  constraint vendor_evaluation_assessment_criterion_fk
    foreign key (client, criterion_code)
    references public.vendor_evaluation_criterion (client, criterion_code)
    on delete restrict,
  constraint vendor_evaluation_assessment_supplier_fk
    foreign key (client, supplier_number, purchasing_org)
    references public.supplier_purchasing_org (client, partner_number, purchasing_org)
    on delete restrict,
  constraint vendor_evaluation_assessment_score_ck check (score >= 0 and score <= 100),
  constraint vendor_evaluation_assessment_period_ck check (period_from <= period_to),
  constraint vendor_evaluation_assessment_reason_ck check (char_length(btrim(reason)) between 1 and 100),
  constraint vendor_evaluation_assessment_version_ck check (version > 0)
);

create index if not exists vendor_evaluation_assessment_supplier_idx
  on public.vendor_evaluation_assessment (client, supplier_number, purchasing_org, period_from);

alter table public.vendor_evaluation_criterion enable row level security;
alter table public.vendor_evaluation_criterion force row level security;
create policy tenant_isolation on public.vendor_evaluation_criterion
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.vendor_evaluation_criterion from public;
grant select, insert, update on public.vendor_evaluation_criterion to cairn_app;

alter table public.vendor_evaluation_assessment enable row level security;
alter table public.vendor_evaluation_assessment force row level security;
create policy tenant_isolation on public.vendor_evaluation_assessment
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));
revoke all on public.vendor_evaluation_assessment from public;
grant select, insert, update on public.vendor_evaluation_assessment to cairn_app;
