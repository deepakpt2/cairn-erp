-- Phase 5 — delegation.
--
-- A delegation is an agreement, not a grant. It records who is giving what to
-- whom, who authorised it, who accepted it, and when it stops. The authority
-- itself is never copied: it is derived from the delegator at the moment of
-- every check (see src/platform/auth/authority.ts), so a delegation can never
-- outlive the authority it came from, and revoking takes effect with no sweep.
--
-- Three facts are kept apart on purpose, because collapsing them is what makes
-- delegation systems unanswerable later:
--
--   * created_by        — who put it in the system
--   * approvals         — the chain of command authorised it
--   * acceptances       — the two parties agreed to it
--
-- A delegation is ACTIVE only when both acceptances and every required approval
-- are present.

create table if not exists public.delegation (
  client                varchar(4)  not null references public.client(client) on delete cascade,
  delegation_id         varchar(36) not null,
  delegator_user_id     varchar(36) not null references public.app_user(id) on delete cascade,
  delegate_user_id      varchar(36) not null references public.app_user(id) on delete cascade,

  -- Null means every position the delegator holds. A named position narrows it,
  -- so a superior can hand over one hat and not the whole person.
  position_code         varchar(10),

  valid_from            date not null,
  -- Null means open-ended. Allowed, because some cover has no known end date —
  -- but it must stay closable, which is why CLOSED exists and nothing here is
  -- irrevocable.
  valid_to              date,

  status                varchar(20) not null default 'DRAFT',
  -- SUPERIOR — a superior created it directly. SELF — the delegator proposed it
  -- and the chain approved. The distinction matters: it says who initiated, not
  -- who authorised, and those are different people in two of the three flows.
  initiator_kind        varchar(10) not null default 'SELF',

  reason                text not null,

  delegator_accepted_at timestamp with time zone,
  delegate_accepted_at  timestamp with time zone,

  refused_at            timestamp with time zone,
  refused_by            varchar(36),
  refusal_reason        text,

  closed_at             timestamp with time zone,
  closed_by             varchar(36),
  closure_reason        text,

  revoked_at            timestamp with time zone,
  revoked_by            varchar(36),
  revocation_reason     text,

  created_by            varchar(60) not null default 'SYSTEM',
  created_at            timestamp with time zone not null default now(),
  changed_by            varchar(60),
  changed_at            timestamp with time zone,

  primary key (client, delegation_id),

  constraint delegation_status_ck check (
    status in ('DRAFT', 'PENDING_ACCEPTANCE', 'ACTIVE', 'REFUSED', 'EXPIRED', 'CLOSED', 'REVOKED')
  ),
  constraint delegation_initiator_ck check (initiator_kind in ('SUPERIOR', 'SELF')),
  constraint delegation_span_ck check (valid_to is null or valid_to >= valid_from),
  -- Delegating to yourself is not a delegation; it is a no-op that would
  -- otherwise sit in the table looking like authority.
  constraint delegation_distinct_ck check (delegator_user_id <> delegate_user_id),
  constraint delegation_position_fk
    foreign key (client, position_code) references public.position(client, code)
);

create index if not exists delegation_delegator_idx
  on public.delegation (client, delegator_user_id, status);
create index if not exists delegation_delegate_idx
  on public.delegation (client, delegate_user_id, status);
create index if not exists delegation_span_idx
  on public.delegation (client, valid_from, valid_to);

comment on table public.delegation is
  'An agreement to act in someone else''s place. The authority is derived from the delegator at check time; this row is the authorisation, the acceptance and the audit, not a copy of the capability.';

comment on column public.delegation.status is
  'The recorded status. EXPIRED is derivable from valid_to rather than written by a job, so a row past its end date simply stops matching — see effectiveStatus() in src/modules/people/delegation.ts.';


-- ── Where the delegation applies ────────────────────────────────────────────
--
-- Rows, not columns, for the same reason as user_capability_scope: authority
-- over one plant and authority over four are the same question and must not
-- change the shape of the row. No rows means the delegator's own scope, which
-- is the common case. A level the delegation does not name is one it does not
-- restrict.

create table if not exists public.delegation_scope (
  client        varchar(4)  not null references public.client(client) on delete cascade,
  delegation_id varchar(36) not null,
  scope_type    varchar(32) not null,
  scope_value   varchar(40) not null,

  primary key (client, delegation_id, scope_type, scope_value),

  constraint delegation_scope_type_ck check (
    scope_type in ('PLANT', 'COMPANY_CODE', 'PURCHASING_ORG', 'PURCHASING_GROUP',
      'SALES_ORG', 'DISTRIBUTION_CHANNEL', 'DIVISION', 'CREDIT_CONTROL_AREA', 'CONTROLLING_AREA')
  ),
  constraint delegation_scope_delegation_fk
    foreign key (client, delegation_id) references public.delegation(client, delegation_id) on delete cascade
);

create index if not exists delegation_scope_delegation_idx
  on public.delegation_scope (client, delegation_id);

comment on table public.delegation_scope is
  'Where a delegation applies, narrowed from the delegator''s own scope. Empty means the delegator''s scope is inherited unchanged.';


-- ── Who must authorise it ───────────────────────────────────────────────────
--
-- One row per candidate approver, grouped by which side of the agreement they
-- are asked about. The rule from the design:
--
--   superiorOf(delegator) === superiorOf(delegatee)  ->  one approval
--   otherwise                                        ->  both sides
--
-- Within a side, a person holding two positions has two superiors and any one
-- of them will do — so a side is satisfied when any of its rows is approved,
-- not when all of them are. The whole delegation is approved when both sides
-- are. A superior who appears on both sides approves both at once.
--
-- A side with no rows is a side that needs nothing: the reporting line ended in
-- an org unit, which has no holder. That is the apex, and the apex is
-- self-approving.

create table if not exists public.delegation_approval (
  client              varchar(4)  not null references public.client(client) on delete cascade,
  approval_id         varchar(36) not null,
  delegation_id       varchar(36) not null,
  -- Which party's chain of command this approval answers for.
  side                varchar(10) not null,

  -- Who may approve. Exactly one of the two is set: a person holding the
  -- superior position, or the org unit the line ends in.
  approver_user_id    varchar(36) references public.app_user(id),
  approver_org_unit   varchar(10),

  status              varchar(10) not null default 'PENDING',
  decided_at          timestamp with time zone,
  decision_note       text,

  created_by          varchar(60) not null default 'SYSTEM',
  created_at          timestamp with time zone not null default now(),
  changed_by          varchar(60),
  changed_at          timestamp with time zone,

  primary key (client, approval_id),

  constraint delegation_approval_side_ck check (side in ('DELEGATOR', 'DELEGATEE')),
  constraint delegation_approval_status_ck check (status in ('PENDING', 'APPROVED', 'REFUSED')),
  -- An approval names either a person or an org unit, never both and never
  -- neither. Without this an approval row could require nobody to act.
  constraint delegation_approval_target_ck check (
    (approver_user_id is not null and approver_org_unit is null)
    or (approver_user_id is null and approver_org_unit is not null)
  ),
  constraint delegation_approval_delegation_fk
    foreign key (client, delegation_id) references public.delegation(client, delegation_id) on delete cascade,
  constraint delegation_approval_org_unit_fk
    foreign key (client, approver_org_unit) references public.org_unit(client, code)
);

create index if not exists delegation_approval_delegation_idx
  on public.delegation_approval (client, delegation_id, side);
create index if not exists delegation_approval_approver_idx
  on public.delegation_approval (client, approver_user_id, status);

comment on table public.delegation_approval is
  'Who in the chain of command must authorise a delegation, grouped by side. A side is satisfied by any one of its approvers; both sides must be satisfied.';


-- ── The delegation id on the audit trail ────────────────────────────────────
--
-- "Who did this, under what authority" is the question asked after something
-- goes wrong, and the answer has to exist. Adding the column here is what makes
-- it answerable; it records null for the ordinary case, which is the common case
-- and costs nothing.

alter table public.audit_access_log
  add column if not exists delegation_id varchar(36);

create index if not exists audit_access_log_delegation_idx
  on public.audit_access_log (client, delegation_id)
  where delegation_id is not null;

comment on column public.audit_access_log.delegation_id is
  'The delegation this action was performed under, when it was performed under one. Null for the ordinary case.';


-- ── Row level security and the runtime grants ───────────────────────────────

alter table public.delegation enable row level security;
alter table public.delegation force row level security;
create policy tenant_isolation on public.delegation
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.delegation from public;
grant select, insert, update, delete on table public.delegation to cairn_app;

alter table public.delegation_scope enable row level security;
alter table public.delegation_scope force row level security;
create policy tenant_isolation on public.delegation_scope
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.delegation_scope from public;
grant select, insert, update, delete on table public.delegation_scope to cairn_app;

alter table public.delegation_approval enable row level security;
alter table public.delegation_approval force row level security;
create policy tenant_isolation on public.delegation_approval
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));
revoke all on table public.delegation_approval from public;
grant select, insert, update, delete on table public.delegation_approval to cairn_app;
