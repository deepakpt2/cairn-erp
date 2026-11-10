-- 9267_authority_model.sql
--
-- The authority model: what a person may do, where, and until when.
--
-- Three things were true before this file and are not after it:
--
--   1. A capability could only reach a person through a role. The reporting
--      line existed (org_hierarchy/position_assignment), but a position carried
--      no authority at all, so "what may this job do" had no answer.
--      `position_capability` is that answer, and it is the join the
--      chain-of-command work was building towards.
--
--   2. A grant could not be scoped, dated, or traced. `auth_org_restriction`
--      narrows a user within a capability, but it is a filter on the person,
--      not a property of the grant, and it carries no dates and no provenance.
--      Delegation needs all three: who gave it, until when, and over what.
--
--   3. "May I?" had no single answer. `hasCapability` answers "do you hold the
--      pattern"; `hasOrgAccess` answers "may you touch this value". Nothing
--      answered both together, which is why only a handful of modules ever
--      asked the second question. `can()` answers it once, in
--      src/platform/auth/authority.ts.
--
-- ## What is deliberately NOT copied
--
-- An earlier plan called for seeding every user's existing capabilities into
-- `user_capability` as unrestricted grants. This file does not, because a copy
-- is a second source of truth that drifts the moment a role changes: revoke a
-- role and the copied grant would outlive it, silently.
--
-- Instead, effective authority is computed as the union of three sources, and
-- `user_capability` holds only what cannot be derived:
--
--   role     -> role_capability      (derived, unrestricted unless narrowed)
--   position -> position_capability  (derived, scoped by the assignment)
--   direct   -> user_capability      (stored: dated, scoped, and traceable)
--
-- Nothing regresses, because the role path is still read live. Scope on the
-- assignment is the standing decision: the same position in two plants is two
-- assignments, so the place belongs with the assignment and not with the
-- capability.
--
-- ## The nine organisational levels
--
-- Confirmed: plant, company code, purchasing org, purchasing group, sales org,
-- distribution channel, division, credit control area, controlling area.
-- `controlling_area` already stood on `position_assignment`; the remaining
-- eight are added here. Every one is nullable, and null means "not restricted
-- at this level" rather than "restricted to nothing".

-- ── 1. What a position may do ───────────────────────────────────────────────

create table public.position_capability (
  client          varchar(4)  not null,
  position_code   varchar(10) not null,
  capability_code varchar(64) not null,
  is_active       boolean     not null default true,
  created_by      varchar(60) not null default 'SYSTEM',
  created_at      timestamptz not null default now(),
  changed_by      varchar(60),
  changed_at      timestamptz,
  primary key (client, position_code, capability_code),
  foreign key (client) references public.client(client) on delete cascade,
  foreign key (client, position_code) references public."position"(client, code) on delete cascade
);

comment on table public.position_capability is
  'What a position may do. A pattern, not a bare code, so a position gains a new capability in its area without reconfiguration. Where it may do it is a property of the assignment, never of this row.';

create index position_capability_position_idx on public.position_capability (client, position_code);

-- ── 2. A grant that cannot be derived from a role or a position ─────────────

create table public.user_capability (
  id              varchar(36) primary key,
  client          varchar(4)  not null,
  user_id         varchar(36) not null,
  capability_code varchar(64) not null,
  valid_from      date        not null,
  valid_to        date,
  /** DIRECT | DELEGATION | TEMPORARY — never ROLE or POSITION, which are derived and must not be copied. */
  reason          varchar(24) not null,
  /** Who gave it. A delegation names the delegator, so the grant reads back to a person. */
  granter         varchar(60) not null,
  created_by      varchar(60) not null default 'SYSTEM',
  created_at      timestamptz not null default now(),
  changed_by      varchar(60),
  changed_at      timestamptz,
  foreign key (client) references public.client(client) on delete cascade,
  foreign key (user_id) references public.app_user(id) on delete cascade,
  check (valid_to is null or valid_to >= valid_from),
  check (reason in ('DIRECT', 'DELEGATION', 'TEMPORARY'))
);

comment on table public.user_capability is
  'A grant of authority that cannot be derived from a role or a position: dated, traceable to the person who gave it, and scoped by user_capability_scope. An expired grant matches nothing and needs no job to clean it up.';

create index user_capability_user_idx on public.user_capability (client, user_id);
create index user_capability_span_idx on public.user_capability (client, user_id, valid_from, valid_to);

-- ── 3. Where a grant applies ────────────────────────────────────────────────
--
-- A separate table rather than columns, because authority over one plant and
-- authority over four are the same question and should not change the shape of
-- the grant. No rows means unrestricted, which is the common case and must stay
-- cheap to answer.

create table public.user_capability_scope (
  client      varchar(4)  not null,
  grant_id    varchar(36) not null,
  scope_type  varchar(32) not null,
  scope_value varchar(40) not null,
  primary key (client, grant_id, scope_type, scope_value),
  foreign key (client) references public.client(client) on delete cascade,
  foreign key (grant_id) references public.user_capability(id) on delete cascade,
  check (scope_type in (
    'PLANT', 'COMPANY_CODE', 'PURCHASING_ORG', 'PURCHASING_GROUP', 'SALES_ORG',
    'DISTRIBUTION_CHANNEL', 'DIVISION', 'CREDIT_CONTROL_AREA', 'CONTROLLING_AREA'
  ))
);

comment on table public.user_capability_scope is
  'Where a grant applies. Empty means unrestricted. A grant scoped to plant 1000 is refused on a plant 2000 document, whatever the user holds elsewhere.';

create index user_capability_scope_grant_idx on public.user_capability_scope (client, grant_id);

-- ── 4. The place an assignment is made in ───────────────────────────────────

alter table public.position_assignment
  add column plant                varchar(4),
  add column company_code         varchar(4),
  add column purchasing_org       varchar(4),
  add column purchasing_group     varchar(3),
  add column sales_org            varchar(4),
  add column distribution_channel varchar(2),
  add column division             varchar(2),
  add column credit_control_area  varchar(4);

alter table public.position_assignment
  add constraint position_assignment_plant_fk
    foreign key (client, plant) references public.plant(client, plant),
  add constraint position_assignment_company_code_fk
    foreign key (client, company_code) references public.company_code(client, company_code),
  add constraint position_assignment_purchasing_org_fk
    foreign key (client, purchasing_org) references public.purchasing_org(client, purchasing_org),
  add constraint position_assignment_purchasing_group_fk
    foreign key (client, purchasing_group) references public.purchasing_group(client, purchasing_group),
  add constraint position_assignment_sales_org_fk
    foreign key (client, sales_org) references public.sales_org(client, sales_org),
  add constraint position_assignment_distribution_channel_fk
    foreign key (client, distribution_channel) references public.distribution_channel(client, distribution_channel),
  add constraint position_assignment_division_fk
    foreign key (client, division) references public.division(client, division),
  add constraint position_assignment_credit_control_area_fk
    foreign key (client, credit_control_area) references public.credit_control_area(client, credit_control_area);

comment on column public.position_assignment.plant is
  'The plant this assignment is made in. Null means the position is not restricted to a plant here; it does not mean the holder may see no plant.';

-- ── 5. Row level security and the runtime grants ────────────────────────────

alter table public.position_capability enable row level security;
alter table public.position_capability force row level security;
create policy tenant_isolation on public.position_capability
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.position_capability from public;
grant select, insert, update, delete on table public.position_capability to cairn_app;

alter table public.user_capability enable row level security;
alter table public.user_capability force row level security;
create policy tenant_isolation on public.user_capability
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.user_capability from public;
grant select, insert, update, delete on table public.user_capability to cairn_app;

alter table public.user_capability_scope enable row level security;
alter table public.user_capability_scope force row level security;
create policy tenant_isolation on public.user_capability_scope
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.user_capability_scope from public;
grant select, insert, update, delete on table public.user_capability_scope to cairn_app;
