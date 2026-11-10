-- 9237: the returns chain is configured rather than carried as constants.
--
-- The returns chain works. It arrived carrying `RE`, `LR`, `CR` and `G2` as constants in the services
-- that create those documents, and `RETURNS_RECEIPT` as the movement its receipt posts — the way the
-- order type was a constant before 9226, and wrong in the same way. 9226 made the *types* configuration;
-- which of them the returns chain uses was left in the code. A tenant whose returns process wants its own
-- document types, or whose complaint desk works a different document, still had to ask for a deployment.
--
-- One row per tenant, and only one: the chain is one thing, and a second row would let half a chain be
-- configured against the other half. Every column carries a foreign key, so the configuration cannot name
-- a document that cannot be created or a movement that does not stand — the same principle as the
-- cancellation type on `sales_document_type`, which names a row rather than a hope.
--
-- The row is seeded for every tenant that stands, with the delivered standard, and is seeded again for
-- every tenant created after this migration. It is not Optional: the services read it, and a tenant with
-- no row is a tenant whose returns chain has never been configured — which the screen says, and which is
-- not the same as a tenant that has chosen the standard.
--
-- The grants are SELECT, INSERT and UPDATE. No DELETE, as on the document type: the row is configuration
-- the services read, and a chain with no configuration is a refusal the screen can explain, which a
-- deleted row is not.
--
-- One consequence has to be carried here, because it is the same mistake stated as a database rule.
--
-- 9232 restated the order reference as: the two complaint documents name what they were raised against,
-- every other order names nothing. Correct as far as it went — but "the two complaint documents" is
-- `RE` and `CR` written into a check constraint, and which types the complaint documents are is exactly
-- what becomes configuration in this migration. A tenant that names its complaint type `ZC` would be
-- refused by the database for want of a rule it cannot read.
--
-- So the constant goes. The database keeps the half of the rule that was never about the type: a
-- reference is a pair, and a document that names one half of one names neither. Which documents have to
-- carry a reference is now the services' business — the two that raise a complaint document set both
-- halves from the invoice they were raised against, and no other order sets either.

alter table public.sales_order
  drop constraint if exists sales_order_reference_ck;
alter table public.sales_order
  add constraint sales_order_reference_ck
  check (
    (reference_document_type is not null and reference_document_number is not null)
    or (reference_document_type is null and reference_document_number is null)
  );

comment on constraint sales_order_reference_ck on public.sales_order is
  'An order raised against another document names both halves of the reference, and one that was not raised against anything names neither. Which document types must carry one is configuration (the returns chain), so it is not written here.';

-- The activity sits beside the document type in the SALES_AND_DISTRIBUTION area, one sequence after it:
-- which types the chain uses comes after what the types are.

create table if not exists sales_returns_configuration (
  client varchar(4) not null references client (client) on delete cascade,
  returns_order_type varchar(4) not null,
  returns_delivery_type varchar(4) not null,
  complaint_type varchar(4) not null,
  credit_memo_type varchar(4) not null,
  receipt_movement_type varchar(20) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamptz not null default now(),
  changed_by varchar(60),
  changed_at timestamptz,
  primary key (client),
  foreign key (client, returns_order_type) references sales_document_type (client, document_type) on delete restrict,
  foreign key (client, returns_delivery_type) references sales_document_type (client, document_type) on delete restrict,
  foreign key (client, complaint_type) references sales_document_type (client, document_type) on delete restrict,
  foreign key (client, credit_memo_type) references sales_document_type (client, document_type) on delete restrict,
  foreign key (client, receipt_movement_type) references movement_type (client, movement_type) on delete restrict
);

alter table sales_returns_configuration enable row level security;
alter table sales_returns_configuration force row level security;

create policy sales_returns_configuration_tenant on sales_returns_configuration
  for all
  using (client = current_setting('cairn.client', true))
  with check (client = current_setting('cairn.client', true));

revoke all on table sales_returns_configuration from public;
grant select, insert, update on table sales_returns_configuration to cairn_app;

comment on table sales_returns_configuration is
  'Which sales document types the returns chain uses — the returns order, the returns delivery, the complaint a credit is requested on and the credit memo itself — and which movement the returns receipt posts. One row per tenant; seeded with the delivered standard and maintained at /config/sales-returns.';

-- The delivered standard, for every tenant that stands. The four types come from 9226 and the movement
-- from 9228; a tenant missing either is left without a row rather than given one that cannot stand, and
-- the screen tells it so.
insert into sales_returns_configuration (
  client, returns_order_type, returns_delivery_type, complaint_type, credit_memo_type,
  receipt_movement_type, created_by
)
select c.client, 'RE', 'LR', 'CR', 'G2', 'RETURNS_RECEIPT', 'MIGRATION_9237'
  from client c
 where exists (select 1 from sales_document_type t
                where t.client = c.client and t.document_type in ('RE', 'LR', 'CR', 'G2')
                group by t.client having count(distinct t.document_type) = 4)
   and exists (select 1 from movement_type m
                where m.client = c.client and m.movement_type = 'RETURNS_RECEIPT')
on conflict (client) do nothing;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.RETURNS.DEFINE', 'SALES', 'CONFIGURE', false,
  'Configure the returns chain at /config/sales-returns: which sales document types the returns order, the returns delivery, the complaint a credit is requested on and the credit memo carry, and which movement the returns receipt posts. One configuration per tenant, read by the services that create those documents. It creates no document and posts nothing.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
values (
  'CFG.SALES.RETURNS.DEFINE',
  'SALES_AND_DISTRIBUTION',
  null,
  'Configure the returns chain',
  'DEFINE',
  'CFG.SALES.DOCTYPE.DEFINE',
  'A returns process that numbers apart, and a complaint desk that works its own document: the returns order, the returns delivery, the complaint and the credit memo each carry a type this tenant names, and the receipt posts the movement this tenant names for it.',
  991,
  'STANDARD',
  '/config/sales-returns',
  true,
  'MIGRATION_9237'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9237',
  changed_at = now();
