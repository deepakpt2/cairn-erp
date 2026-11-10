-- §4.4 (audit gap C7): output — the document the customer receives.
--
-- Two things happen here, and they are one change.
--
-- First, the output queue stops belonging to Inventory. `output_message` no longer
-- names a material document: it names a document category and a number, and it
-- gains an issue number, because an output is issued once and issuing it again is a
-- second act rather than a rewrite of the first. `output_type` gains an application
-- — IN and SD, SAP's KAPPL — so a sales invoice cannot be determined a goods
-- receipt slip. The rows that stand are carried over; nothing is re-created.
--
-- Second, the access sequence arrives. Output determination is the condition
-- technique applied to documents, and it is the half the package never had: a
-- condition record says when a type is sent, by which medium and to which partner
-- function. The three sales output types are delivered — BA00 order confirmation,
-- LD00 delivery note, RD00 invoice — and no records are, because who receives what
-- and by which channel is a tenant's decision, not a package's. No record, no
-- output, which is the point of it.

-- ── The application on the output type ────────────────────────────────────────
-- Everything that stands is Inventory's, which is what the default says.
alter table public.output_type add column application varchar(2) not null default 'IN';
alter table public.output_type add constraint output_type_application_ck
  check (application in ('IN', 'SD'));

-- ── The queue, generalised ────────────────────────────────────────────────────
-- The foreign key to material_document goes first: the queue is about to hold
-- documents that are not material documents, and a key that says otherwise would
-- be a lie the schema tells about a delivery note. No foreign key replaces it — a
-- row here is the record that something was sent, and it outlives the document's
-- own referential convenience.
alter table public.output_message drop constraint output_message_document_fk;
alter table public.output_message drop constraint output_message_pk;

alter table public.output_message add column document_category varchar(20);
alter table public.output_message add column document_number varchar(20);
alter table public.output_message add column issue_number integer not null default 1;
alter table public.output_message add column rendered_document text;
alter table public.output_message add column reissue_reason varchar(200);

update public.output_message
   set document_category = 'MATERIAL_DOCUMENT',
       document_number = material_document_number;

alter table public.output_message alter column document_category set not null;
alter table public.output_message alter column document_number set not null;
alter table public.output_message drop column material_document_number;

alter table public.output_message add constraint output_message_pk
  primary key (client, document_category, document_number, output_type, transmission_medium, issue_number);
alter table public.output_message add constraint output_message_category_ck
  check (document_category in ('MATERIAL_DOCUMENT', 'SALES_ORDER', 'DELIVERY', 'BILLING'));
alter table public.output_message add constraint output_message_issue_ck
  check (issue_number > 0);
-- A re-issue has to say why. A second copy of an invoice with no reason beside it
-- answers nothing when somebody asks what happened.
alter table public.output_message add constraint output_message_reissue_ck
  check (issue_number = 1 or reissue_reason is not null);

create index if not exists output_message_document_idx
  on public.output_message (client, document_category, document_number);

-- ── The output condition record: the access sequence ──────────────────────────
-- The most specific record that stands for the sales area, the document type and
-- the customer of the document answers. Blank means *any*, and it is a value that
-- is matched, never an absence — which is why every position defaults to the empty
-- string and not to null: null in a unique key would let two "any customer"
-- records stand side by side and give two answers to one question.
create table public.output_condition_record (
  client varchar(4) not null references public.client (client) on delete cascade,
  condition_number varchar(18) not null,
  application varchar(2) not null default 'SD',
  output_type varchar(4) not null,
  document_category varchar(20) not null default '',
  document_type varchar(2) not null default '',
  sales_org varchar(4) not null default '',
  distribution_channel varchar(2) not null default '',
  division varchar(2) not null default '',
  customer_number varchar(40) not null default '',
  transmission_medium varchar(8) not null default 'PRINT',
  dispatch_time varchar(10) not null default 'IMMEDIATE',
  partner_function varchar(10) not null default 'BP',
  printer_queue varchar(30),
  validity_from date not null,
  validity_to date not null,
  is_active boolean not null default true,
  created_by varchar(40) not null,
  created_at timestamp with time zone not null default now(),
  changed_by varchar(40),
  changed_at timestamp with time zone,
  constraint output_condition_record_pk primary key (client, condition_number),
  constraint output_condition_record_type_fk foreign key (client, output_type)
    references public.output_type (client, output_type) on delete restrict,
  constraint output_condition_record_application_ck check (application in ('IN', 'SD')),
  constraint output_condition_record_medium_ck check (transmission_medium in ('PRINT', 'EMAIL')),
  constraint output_condition_record_dispatch_ck check (dispatch_time in ('IMMEDIATE', 'PERIODIC')),
  constraint output_condition_record_partner_ck
    check (partner_function in ('SP', 'SH', 'BP', 'PY')),
  constraint output_condition_record_validity_ck check (validity_to >= validity_from),
  constraint output_condition_record_key_uq unique (
    client, application, output_type, document_category, document_type,
    sales_org, distribution_channel, division, customer_number, validity_from
  )
);

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. A record says what a customer receives, and it is never quietly thrown
-- away — it is withdrawn, which is a change of state and not a disappearance.
alter table public.output_condition_record enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['output_condition_record']
  loop
    execute format('drop policy if exists %I on %I', table_name || '_tenant', table_name);
    execute format(
      'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      table_name || '_tenant', table_name
    );
    execute format('revoke all on table %I from public', table_name);
    execute format('grant select, insert, update on table %I to cairn_app', table_name);
  end loop;
end $$;

-- ── The sales output types ────────────────────────────────────────────────────
-- Delivered to every client, because a type is what a tenant's records point at:
-- a record naming an output type that does not exist would be a decision
-- referencing nothing. Direction is ANY — the line-direction test is Inventory's
-- own, and no sales document moves stock in the sense a material document does.
insert into public.output_type (
  client, output_type, description, application, direction,
  transmission_medium, dispatch_time, is_active, created_by
)
select c.client, t.output_type, t.description, 'SD', 'ANY', 'PRINT', 'IMMEDIATE', true, 'MIGRATION'
  from public.client c
  cross join (
    values ('BA00', 'Order confirmation'),
           ('LD00', 'Delivery note'),
           ('RD00', 'Invoice')
  ) as t(output_type, description)
on conflict (client, output_type) do nothing;

-- ── The capabilities ──────────────────────────────────────────────────────────
-- Two, because deciding *what* a customer receives and *sending* it are not the
-- same act: one is configuration a company commits to, the other hands a document
-- to somebody outside it.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.OUTPUT.PROCESS', 'SALES', 'OUTPUT', false,
  'Determine and dispatch sales output at /sales/output: the order confirmation, the delivery note and the invoice a customer receives, each standing as an output message with the status it reached. Determination reads the access sequence — no condition record, no output — and dispatch renders the document and stores the rendering on the message, so a copy asked for later is the document as it went out and not a fresh reading of masters that have moved since. Dispatching posts nothing: it hands a document to a channel. Maintaining the records that say who receives what is SALES.OUTPUT.ADMIN.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.OUTPUT.ADMIN', 'SALES', 'MAINTAIN', false,
  'Maintain output condition records at /sales/output: which output type a document earns, for which sales area, document type and customer, by which medium, when and to which partner function. A record is the decision that a customer receives something at all — without one the document earns no output, which is the rule rather than an omission. Maintaining one posts nothing and sends nothing; dispatching what it names is SALES.OUTPUT.PROCESS.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
