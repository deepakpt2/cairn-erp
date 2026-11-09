-- 9244: what the delivery was created against.
--
-- A delivery line says what was ordered, what had gone out before it, and what it carries. With the
-- availability check standing, that is no longer enough to read one: a delivery of six against an
-- order of ten is either a plant that promised six and kept its promise, or a plant that shorted a
-- customer by four, and the line as it stood could not tell those apart.
--
-- So the line carries what the plant had confirmed at the moment the delivery was made, the same way
-- an order line does. Null is not zero: it is a delivery raised before a check stood, and those read
-- as they always did.
--
-- The remaining quantity is deliberately left alone. It is, and stays, what the order line still has
-- open against what was asked for — ten ordered, six shipped, four open — which the database checks
-- as arithmetic. It is not what may still be shipped: that question is answered by the confirmed
-- quantity and by the check, and it changes when the plant's stock does.

alter table delivery_line add column if not exists confirmed_quantity numeric(13, 3);

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'delivery_line_confirmed_ck') then
    alter table delivery_line add constraint delivery_line_confirmed_ck
      check (confirmed_quantity is null
             or (confirmed_quantity >= 0 and confirmed_quantity <= ordered_quantity));
  end if;
end $$;

comment on column delivery_line.confirmed_quantity is
  'What the availability check had confirmed on the order line when this delivery was created (SAP: '
  'the confirmed quantity of the schedule line it was made from). Null on a delivery raised before a '
  'check stood. It is not re-derived: it says what the plant had promised on the day.';
