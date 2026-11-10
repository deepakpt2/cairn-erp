-- 9243: what the plant can promise.
--
-- An order asked for a quantity and got it: nothing between the customer's request and the delivery
-- ever asked whether the goods were there. The order line carried one quantity, and the delivery
-- offered whatever was left of it. A plant that could supply six of the ten a customer ordered had no
-- way to say so, and no way to say it differently a week later when the rest arrived.
--
-- So the order line gains a second quantity. A schedule line (SAP VBEP) says what was asked for and
-- when, and what the check confirmed against it, and the delivery is created from what was confirmed
-- and not from what was ordered. Confirmation is not a decision somebody makes on a screen: it is the
-- answer the availability check returns, written down at the moment it was asked, so a document read
-- in a month still says what the plant promised on the day.
--
-- The check reads the masters that already stand. The checking group comes from the material's sales
-- view (§2.2), which is where SAP reads it; the checking rule and the scope of check are the
-- production module's OVZ2/OPJL/OVZ9 masters, maintained at /config/availability-check, because a
-- plant's promise is one question whether it is asked by an order or by a production release. Nothing
-- new is configured here, and nothing is transferred into MRP: decision (6) drew that line.
--
-- The material's checking group is narrowed to the two characters the group master carries. A four
-- character group could never be found in it, which would have made the field a promise the check
-- could not keep.

alter table material_sales alter column availability_check_group type varchar(2);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'material_sales_check_group') then
    alter table material_sales add constraint material_sales_check_group
      check (availability_check_group is null or availability_check_group = ''
             or availability_check_group ~ '^[A-Z0-9]{2}$');
  end if;
end $$;

create table if not exists sales_order_schedule (
  client varchar(4) not null references client (client) on delete cascade,
  order_number varchar(20) not null,
  order_line_number integer not null,
  schedule_number integer not null,
  -- What the customer asked for, and by when.
  requested_date date not null,
  requested_quantity numeric(13, 3) not null,
  -- What the check confirmed: the promise. Zero is not a missing confirmation, it is a refusal made
  -- in arithmetic — the plant had nothing to promise that day.
  confirmed_quantity numeric(13, 3) not null default 0,
  confirmed_date date,
  created_by varchar(60) not null default 'SYSTEM',
  created_at timestamp with time zone not null default now(),
  changed_by varchar(60),
  changed_at timestamp with time zone,
  primary key (client, order_number, order_line_number, schedule_number),
  foreign key (client, order_number, order_line_number)
    references sales_order_line (client, order_number, line_number) on delete cascade,
  constraint sales_order_schedule_number_ck check (schedule_number > 0),
  constraint sales_order_schedule_quantity_ck check (requested_quantity > 0),
  constraint sales_order_schedule_confirmed_ck
    check (confirmed_quantity >= 0 and confirmed_quantity <= requested_quantity)
);

comment on table sales_order_schedule is
  'What an order line asked for and what the availability check confirmed (SAP VBEP). The delivery is '
  'created from the confirmed quantity and not from the ordered one, so a plant that can supply six of '
  'ten ships six and owes four, and the delivery due list says so.';

-- The confirmed quantity on the line itself: the sum of its schedule lines, held where the delivery
-- reads it. Null is not zero — it is a line that was never checked, which is every line raised before
-- this migration, and those deliver as they always did.
alter table sales_order_line add column if not exists confirmed_quantity numeric(13, 3);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'sales_order_line_confirmed_ck') then
    alter table sales_order_line add constraint sales_order_line_confirmed_ck
      check (confirmed_quantity is null
             or (confirmed_quantity >= 0 and confirmed_quantity <= order_quantity));
  end if;
end $$;

-- The tenant policy and the grants, as every table of this kind carries them: SELECT, INSERT and
-- UPDATE and no DELETE. A promise the plant made is evidence of what the customer was told.
alter table sales_order_schedule enable row level security;

do $$
declare
  table_name text;
begin
  foreach table_name in array array['sales_order_schedule']
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
