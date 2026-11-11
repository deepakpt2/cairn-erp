-- Notifications — Phase 7
--
-- A notification is a message to a user. It is stored. When they open it, it is
-- marked seen. Nothing else is tracked — not whether they acted on it, not
-- whether they dismissed it, not what they did next.
--
-- This is deliberately a different mechanism from the attention panel. Attention
-- is a live query about what is waiting; a notification is a stored message
-- about what happened. Different tables, different screens, different lifetimes.
-- They are not merged.

create table if not exists notification (
  client          varchar(4)    not null references client (client) on delete cascade,
  notification_id varchar(36)   not null,
  recipient       varchar(60)   not null,
  kind            varchar(40)   not null,
  object_class    varchar(60)   not null,
  object_key      varchar(80)   not null,
  -- Resolved at render, never stored as text. A message that outlives the
  -- locale it was written in is a message that cannot be read, and
  -- `message_catalog` already works this way: an i18n key plus parameters.
  message_key     varchar(120)  not null,
  message_params  jsonb         not null default '{}'::jsonb,
  created_at      timestamptz   not null default now(),
  seen_at         timestamptz,
  primary key (client, notification_id),
  constraint notification_kind_ck check (kind ~ '^[A-Z][A-Z0-9_.]{2,39}$')
);

comment on table notification is
  'A message to one user about one thing that happened. Marked seen when opened; nothing else is tracked.';
comment on column notification.recipient is
  'The app_user.id of the person being told. Notified users are resolved by capability and scope, never passed in by a caller.';
comment on column notification.object_class is
  'What the message is about: purchase_requisition, sales_order, job_run, user_session, user_capability. Not a foreign key — a notification outlives nothing, and points at things that may be gone.';
comment on column notification.object_key is
  'The document number, run id, or session id the message points at.';
comment on column notification.seen_at is
  'When the recipient opened it. Null means unseen, which is the only state the inbox distinguishes.';
comment on column notification.message_key is
  'i18n key resolved at render. No user-visible text is ever stored (R-19, D-008).';
comment on column notification.message_params is
  'Named placeholders for the message key: the document number, the actor, the count.';

-- The inbox read: this user's rows, newest first, unseen surfaced.
create index if not exists notification_inbox_idx
  on notification (client, recipient, seen_at, created_at desc);

-- One unseen row per person per kind per document.
--
-- A sweep that runs daily would otherwise tell somebody their grant expires in
-- seven days, and then tell them again tomorrow, and the next day. This is the
-- whole deduplication mechanism: no delivery log, no sent-at bookkeeping, no
-- state. Once a row is seen the event may happen again and be worth saying
-- again, so the index is partial on unseen.
create unique index if not exists notification_unseen_uq
  on notification (client, recipient, kind, object_class, object_key)
  where seen_at is null;

-- ## Why writing a notification needs a definer function
--
-- The recipient term in the policy below is what stops one user reading
-- another's inbox. It is also what stops anybody writing to another person's
-- inbox — including the worker, which resolves a pool of recipients and writes
-- a row for each, and including the ordinary case of a screen telling the
-- document's creator that it was released.
--
-- The definer right is therefore needed for *every* insert, not just the
-- worker's. It is the narrowest form of it: the function writes one row, and
-- the tenant term is still enforced explicitly, because the caller is only
-- being trusted to name a person within its own tenant. A cross-tenant write
-- stays impossible, which is the one thing the elevated right could otherwise
-- have allowed.
create or replace function notification_deliver(
  p_client       varchar,
  p_recipient    varchar,
  p_kind         varchar,
  p_object_class varchar,
  p_object_key   varchar,
  p_message_key  varchar,
  p_params       jsonb
) returns varchar
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id varchar(36);
begin
  -- The tenant term, asserted rather than inherited. SECURITY DEFINER escapes
  -- row level security entirely, so the function has to make the check the
  -- policy would have made and cannot.
  if p_client is distinct from current_setting('cairn.client', true) then
    raise exception 'notification_deliver: tenant % is not the session tenant', p_client;
  end if;

  if p_recipient is null or p_recipient = '' then
    raise exception 'notification_deliver: a notification names one recipient';
  end if;

  insert into notification (
    client, notification_id, recipient, kind, object_class, object_key,
    message_key, message_params
  )
  values (
    p_client, gen_random_uuid()::text, p_recipient, p_kind, p_object_class, p_object_key,
    p_message_key, coalesce(p_params, '{}'::jsonb)
  )
  -- The duplicate is not an error: the same event reaching the same person
  -- twice, while the first copy is still unread, is the sweep running again.
  on conflict do nothing
  returning notification_id into v_id;

  return v_id;
end;
$$;

comment on function notification_deliver(varchar, varchar, varchar, varchar, varchar, varchar, jsonb) is
  'Write one notification, for one recipient, inside the session tenant. SECURITY DEFINER owned by the migrator role, because the recipient term of the notification policy otherwise prevents writing a row for anybody but yourself. The tenant term is asserted in the body, so the elevated right cannot cross tenants.';

alter function notification_deliver(varchar, varchar, varchar, varchar, varchar, varchar, jsonb)
  owner to cairn_integration_migrator;
grant execute on function notification_deliver(varchar, varchar, varchar, varchar, varchar, varchar, jsonb)
  to cairn_app;

-- Row level security on both client and recipient.
--
-- Without the recipient term every user in the tenant sees everyone's inbox.
-- The term reads `cairn.user`, which `withTenantAs` sets; an unset value makes
-- the comparison null and returns no rows, so the table fails closed rather
-- than open.
alter table notification enable row level security;
alter table notification force row level security;

-- One policy, not two.
--
-- Postgres combines multiple permissive policies with OR, so a
-- `tenant_isolation` policy alongside an `own_inbox` policy would let any user
-- in the tenant read every other user's inbox — the row passes the first
-- policy even though it fails the second. The two terms have to be ANDed
-- inside a single policy, which is what makes the recipient term bite.
create policy notification_isolation on notification
  using (
    client::text = current_setting('cairn.client', true)
    and recipient = current_setting('cairn.user', true)
  )
  with check (
    client::text = current_setting('cairn.client', true)
    and recipient = current_setting('cairn.user', true)
  );

revoke all on table notification from public;
grant select, update, delete on notification to cairn_app;
-- Insert goes through notification_deliver only. The definer function owns the
-- write path so that naming another recipient is an explicit, auditable act.
