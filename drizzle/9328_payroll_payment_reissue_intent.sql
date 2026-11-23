-- 9328_payroll_payment_reissue_intent.sql
--
-- Durable, requester-scoped SUBMISSION INTENT for a controlled salary-file replacement.
--
-- Two-step protocol: the screen first REGISTERS the exact normalized request (this row) and only then EXECUTES it.
-- Registration never creates a draft; execution is idempotent by request_key. A lost registration or execution
-- response is therefore recoverable by the authenticated requester from this table (scoped to the source file),
-- with no reliance on browser storage. The row is the durable state machine:
--
--   REGISTERED -> RUNNING -> COMPLETED        (the draft was committed; reissue_id is set in the same transaction)
--                         \-> REFUSED         (the application proved a pre-commit refusal for this exact request)
--   REGISTERED|RUNNING -> ABANDONED           (the requester explicitly discarded the attempt; may still have committed)
--
-- The payload holds the normalized request fields (including attestation free text) so an exact retry needs no
-- editable preview. It is sensitive: RLS-isolated, select/insert/update to cairn_app only, never logged, never
-- returned by the list endpoint and never placed in browser storage.

create table if not exists public.payroll_payment_reissue_intent (
  client                 varchar(4)  not null references public.client(client) on delete cascade,
  intent_id              uuid        not null,
  source_preparation_id  uuid        not null,
  -- The stable idempotency key. Tenant-wide unique: a key can never mean two different requests.
  request_key            varchar(64) not null,
  -- Canonical hash of the normalized request; a reused key with a different fingerprint is a controlled conflict.
  request_fingerprint    varchar(64) not null,
  requested_by           varchar(60) not null,
  status                 varchar(12) not null default 'REGISTERED',
  -- Normalized request fields needed for an exact retry. Never returned by the recovery list.
  payload                jsonb       not null default '{}'::jsonb,
  -- The committed draft, when status = COMPLETED.
  reissue_id             uuid,
  refusal_code           varchar(40),
  created_by             varchar(60) not null default 'SYSTEM',
  created_at             timestamp with time zone not null default now(),
  changed_by             varchar(60),
  changed_at             timestamp with time zone,
  constraint payroll_payment_reissue_intent_pk primary key (client, intent_id),
  constraint payroll_payment_reissue_intent_key_uq unique (client, request_key),
  constraint payroll_payment_reissue_intent_status_ck
    check (status in ('REGISTERED', 'RUNNING', 'COMPLETED', 'REFUSED', 'ABANDONED')),
  constraint payroll_payment_reissue_intent_uuidv4 check (
    substring(intent_id::text from 15 for 1) = '4'
    and substring(intent_id::text from 20 for 1) in ('8', '9', 'a', 'b')
  ),
  constraint payroll_payment_reissue_intent_source_fk
    foreign key (client, source_preparation_id)
    references public.payroll_payment_file (client, preparation_id) on delete restrict,
  constraint payroll_payment_reissue_intent_reissue_fk
    foreign key (client, reissue_id)
    references public.payroll_payment_reissue (client, reissue_id) on delete restrict
);

create index if not exists payroll_payment_reissue_intent_recovery_idx
  on public.payroll_payment_reissue_intent (client, source_preparation_id, requested_by, status);

alter table public.payroll_payment_reissue_intent enable row level security;
alter table public.payroll_payment_reissue_intent force row level security;
drop policy if exists tenant_isolation on public.payroll_payment_reissue_intent;
create policy tenant_isolation on public.payroll_payment_reissue_intent
  using (client::text = current_setting('cairn.client', true))
  with check (client::text = current_setting('cairn.client', true));

-- The runtime role advances the state machine in place; it never deletes an intent.
grant select, insert, update on table public.payroll_payment_reissue_intent to cairn_app;
revoke delete, truncate on table public.payroll_payment_reissue_intent from cairn_app;

comment on table public.payroll_payment_reissue_intent is
  'Durable two-step submission intent for a controlled payment-file replacement. Registration never creates a draft; execution is idempotent by request_key and completes atomically with the draft.';
