-- SCR-133 (B-861/§26.873): the package states RSNUM as CHAR(10), but canon's
-- numbering engine renders prefix + digits (RSV-00000001 is twelve), exactly as it
-- renders material documents into their twenty-character column. The number columns
-- follow the engine that issues them; the FK pair widens together.

alter table public.reservation_item drop constraint if exists reservation_item_header_fk;
alter table public.reservation_header alter column reservation_number type varchar(20);
alter table public.reservation_item alter column reservation_number type varchar(20);
alter table public.reservation_item
  add constraint reservation_item_header_fk foreign key (client, reservation_number)
  references public.reservation_header (client, reservation_number) on delete cascade;
