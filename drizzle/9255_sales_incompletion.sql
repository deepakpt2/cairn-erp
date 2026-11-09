-- §5.1 (audit gap E1): the incompletion procedure and the log of incomplete items.
--
-- SAP's `OVA2` defines an incompletion procedure inside an incompletion group — `A` sales header,
-- `B` sales item, `C` sales schedule line, `D` partner, `G` delivery header, `H` delivery item — and
-- a procedure is a list of fields: a table, a field name, a sequence, a warning-or-error flag and a
-- status group. `OVA0` defines the status groups, and the status group is what says *what a missing
-- field blocks*: delivery, goods issue, billing, output. Assignment to a document is a separate act
-- and a separate transaction — `VUA2` to the sales document type, `VUA4` to the delivery type.
--
-- `VBUV` is the log. It is keyed by document, item, schedule line, partner function, table and field,
-- and it carries the procedure and the status group that were standing when it was written.
--
-- Three departures, each for a reason.
--
-- First, **there is no item category** in this model, so there is no `VUP2`, `VUE2` or `VUPA` to
-- build. A procedure is assigned to a document type, and its group says which level it checks. One
-- assignment table replaces five.
--
-- Second, **no status columns beside the document**. SAP carries `VBUK-UVALL` and `VBUP` because
-- `VBUV` was expensive to ask. Here the log *is* the state: an indexed existence query answers
-- "is this order blocked for delivery" inside the transaction that would have read the column, and
-- a second copy of the answer is a second thing to keep true.
--
-- Third, **a field the code cannot check cannot be maintained**. SAP's `TVUVF` holds a free
-- table-and-field pair because SAP reads any field of any table at runtime. A typed service layer
-- cannot, and a field nothing evaluates would leave a document silently never complete. The set of
-- checkable fields is code, held in the service as a registry; configuration stays data.
--
-- And the rule this package keeps everywhere: **nothing is seeded but the groups.** No procedure,
-- no field, no status group and no assignment is delivered, so a document written the day this is
-- applied is written exactly as it was the day before.

-- ── The groups ─────────────────────────────────────────────────────────────
-- Delivered with the package and not extended by a tenant, for the same reason the partner
-- functions are: what a group means is what the code does with it. A group the evaluator never
-- asks about is a row that answers nothing.
create table incompletion_group (
  client varchar(4) not null references client (client) on delete cascade,
  group_code varchar(1) not null,
  name varchar(40) not null,
  meaning varchar(240) not null default '',
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, group_code),
  constraint incompletion_group_code_ck check (group_code in ('A', 'B', 'C', 'D', 'G', 'H'))
);

comment on table incompletion_group is
  'The six places a sales or delivery document can be incomplete (SAP OVA2, table TVUG): A sales header, B sales item, C sales schedule line, D partner, G delivery header, H delivery item. Delivered with the package and not extended by a tenant, because what a group means is what the evaluator does with it.';

-- ── What a missing field blocks ────────────────────────────────────────────
-- SAP's OVA0, and the table behind it TVUVS. The status group is the whole of the consequence:
-- a field is not "important", it *stops a named function*. A group that blocks nothing is how a
-- tenant says "record this, stop nothing", which is what a plain warning used to be.
create table incompletion_status_group (
  client varchar(4) not null references client (client) on delete cascade,
  status_group varchar(2) not null,
  name varchar(40) not null,
  blocks_delivery boolean not null default false,
  blocks_goods_issue boolean not null default false,
  blocks_billing boolean not null default false,
  blocks_output boolean not null default false,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, status_group),
  constraint incompletion_status_group_code_ck check (status_group ~ '^[A-Z0-9]{1,2}$')
);

comment on table incompletion_status_group is
  'What a missing field stops (SAP OVA0, table TVUVS). A status group is the whole of the consequence: it is not that a field is important, it is that delivery, goods issue, billing or output will not run for a document that is missing it. A group that blocks nothing is the way to say record this and stop nothing.';

-- ── The procedure ──────────────────────────────────────────────────────────
-- SAP's TVUV. A procedure belongs to one group, because a header check and an item check are not
-- the same question and are not answered from the same row.
create table incompletion_procedure (
  client varchar(4) not null references client (client) on delete cascade,
  procedure_code varchar(4) not null,
  group_code varchar(1) not null,
  name varchar(40) not null,
  is_active boolean not null default true,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, procedure_code),
  constraint incompletion_procedure_code_ck check (procedure_code ~ '^[A-Z0-9]{1,4}$'),
  constraint incompletion_procedure_group_fk
    foreign key (client, group_code) references incompletion_group (client, group_code)
    on delete restrict
);

comment on table incompletion_procedure is
  'A named list of the fields a document of one group must carry before it counts as complete (SAP OVA2, table TVUV). It belongs to exactly one group, because a header check and an item check are not the same question. It means nothing until it is assigned to a document type.';

-- ── The fields ─────────────────────────────────────────────────────────────
-- SAP's TVUVF. Table and field name are what SAP stores; here they are validated against the
-- registry the service holds, so a tenant can only maintain a field the evaluator knows how to
-- look at. The sequence is the order the fields are reported in, which is the order a clerk
-- fills them in.
create table incompletion_procedure_field (
  client varchar(4) not null references client (client) on delete cascade,
  procedure_code varchar(4) not null,
  table_name varchar(30) not null,
  field_name varchar(30) not null,
  sequence integer not null,
  status_group varchar(2) not null,
  is_warning boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, procedure_code, table_name, field_name),
  constraint incompletion_procedure_field_procedure_fk
    foreign key (client, procedure_code) references incompletion_procedure (client, procedure_code)
    on delete cascade,
  constraint incompletion_procedure_field_status_fk
    foreign key (client, status_group) references incompletion_status_group (client, status_group)
    on delete restrict,
  constraint incompletion_procedure_field_sequence_ck check (sequence > 0)
);

comment on table incompletion_procedure_field is
  'One field a document must carry (SAP OVA2, table TVUVF): the table and the field name, in the sequence they are reported in, with the status group that says what its absence stops. Table and field are checked against the set the service knows how to evaluate, because a field nothing evaluates would leave a document silently never complete.';

create index incompletion_procedure_field_procedure_idx
    on incompletion_procedure_field (client, procedure_code, sequence);

-- ── Which document types are checked ───────────────────────────────────────
-- SAP's VUA2 and VUA4, held in one table because there is no item category in this model. A
-- document type with no row here is not checked at all: every type that stands today is
-- unaffected until a tenant says otherwise.
create table incompletion_assignment (
  client varchar(4) not null references client (client) on delete cascade,
  document_category varchar(16) not null,
  document_type varchar(4) not null,
  procedure_code varchar(4) not null,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, document_category, document_type, procedure_code),
  constraint incompletion_assignment_category_ck
    check (document_category in ('ORDER', 'DELIVERY')),
  constraint incompletion_assignment_procedure_fk
    foreign key (client, procedure_code) references incompletion_procedure (client, procedure_code)
    on delete restrict,
  constraint incompletion_assignment_type_fk
    foreign key (client, document_type) references sales_document_type (client, document_type)
    on delete restrict
);

comment on table incompletion_assignment is
  'Which incompletion procedure answers for a document type (SAP VUA2 for the sales order, VUA4 for the delivery). One table where SAP has five, because there is no item category or schedule-line category in this model: a procedure is assigned to a type, and the procedure''s own group says whether it checks the header, the items, the schedule lines or the partners. A type with no row here is not checked at all.';

create index incompletion_assignment_type_idx
    on incompletion_assignment (client, document_category, document_type);

-- ── The log ────────────────────────────────────────────────────────────────
-- SAP's VBUV. One row per missing field, rewritten whole every time the document is evaluated:
-- the rows that stand now, not the rows that stood last time. It carries no foreign key to the
-- procedure or the status group, because what it records is what stood when the document was
-- written, and a configuration row deleted next year cannot take a document's history with it.
--
-- The key is the whole of the address of a missing thing: which document, which line, which
-- schedule line, which partner function, and which field. Line and schedule number and partner
-- function are zero and blank for a header entry, which is how SAP's VBUV works too.
create table sales_incompletion_log (
  client varchar(4) not null references client (client) on delete cascade,
  document_category varchar(16) not null,
  document_number varchar(20) not null,
  line_number integer not null default 0,
  schedule_number integer not null default 0,
  partner_function varchar(4) not null default '',
  table_name varchar(30) not null,
  field_name varchar(30) not null,
  procedure_code varchar(4) not null,
  status_group varchar(2) not null,
  is_warning boolean not null default false,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, document_category, document_number, line_number, schedule_number,
               partner_function, table_name, field_name),
  constraint sales_incompletion_log_category_ck
    check (document_category in ('ORDER', 'DELIVERY')),
  constraint sales_incompletion_log_line_ck check (line_number >= 0),
  constraint sales_incompletion_log_schedule_ck check (schedule_number >= 0)
);

comment on table sales_incompletion_log is
  'One field a document is missing, written when the document was created or changed and rewritten whole each time (SAP VBUV). This is the only record of a document''s completeness: there is no status column beside the document, because a second copy of the answer is a second thing to keep true. A warning row is recorded and stops nothing.';

-- The question every follow-on function asks: is this document blocked, and for what. It is an
-- existence query over this index, inside the transaction that would otherwise have read a status.
create index sales_incompletion_log_document_idx
    on sales_incompletion_log (client, document_category, document_number);
create index sales_incompletion_log_blocking_idx
    on sales_incompletion_log (client, document_category, document_number, is_warning, status_group);

alter table incompletion_group enable row level security;
alter table incompletion_status_group enable row level security;
alter table incompletion_procedure enable row level security;
alter table incompletion_procedure_field enable row level security;
alter table incompletion_assignment enable row level security;
alter table sales_incompletion_log enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array[
    'incompletion_group', 'incompletion_status_group', 'incompletion_procedure',
    'incompletion_procedure_field', 'incompletion_assignment', 'sales_incompletion_log'
  ]
  loop
    execute format('drop policy if exists %I on %I', table_name || '_tenant', table_name);
    execute format(
      'create policy %I on %I for all using (client = current_setting(''cairn.client'', true)) with check (client = current_setting(''cairn.client'', true))',
      table_name || '_tenant', table_name
    );
    execute format('revoke all on table %I from public', table_name);
    execute format('grant select, insert, update, delete on table %I to cairn_app', table_name);
  end loop;
end $$;

-- The groups, for every tenant that stands. New tenants get them from the standard package.
insert into incompletion_group (client, group_code, name, meaning, created_by)
select c.client, v.code, v.name, v.meaning, 'MIGRATION'
  from client c
  cross join (values
    ('A', 'Sales header', 'What the order itself must carry: the customer''s purchase order reference, the date the goods were asked for.'),
    ('B', 'Sales item', 'What each line must carry: when it is wanted, how it is taxed, and where the profit belongs.'),
    ('C', 'Sales schedule line', 'What each schedule line must carry: the date and the quantity of the instalment.'),
    ('D', 'Partner', 'Which partner functions the document must name. The field is the function code.'),
    ('G', 'Delivery header', 'What the delivery itself must carry: where it loads from, when it goes, and where it is going.'),
    ('H', 'Delivery item', 'What each delivery line must carry: the plant, the unit, and the storage location the goods were picked from.')
  ) as v(code, name, meaning)
on conflict (client, group_code) do nothing;

-- ── The capabilities ───────────────────────────────────────────────────────
-- Two, and they are not the same act: one decides what completeness *means* for a tenant, the
-- other reads what is missing and goes and fills it in. Whoever may redefine the rule should not
-- also be the only one who can satisfy it.
insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.INCOMPLETION.DEFINE', 'CFG', 'SALES_INCOMPLETION', false,
  'Define what a complete document is, at /config/incompletion (SAP OVA2, OVA0, VUA2 and VUA4): status groups, which name the function a missing field stops; incompletion procedures, each belonging to a group; the fields a procedure checks, in the sequence they are reported in, checked against the fields the evaluator knows how to look at; and the assignment of a procedure to a sales or delivery document type. Nothing is delivered but the groups, so no document is checked until a tenant assigns a procedure to its type.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'SALES.INCOMPLETION.PROCESS', 'SALES', 'INCOMPLETION', false,
  'The worklist of incomplete documents, at /sales/incomplete (SAP V.02): every order and delivery that is standing and is missing something its procedure says it must carry, with the field, the line and the screen the field is entered on, so an entry is a link to the thing that is missing. A document is incomplete when it has log rows, and blocked for a function when a row that is not a warning names a status group that blocks it. Defining what completeness means is CFG.SALES.INCOMPLETION.DEFINE.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;
