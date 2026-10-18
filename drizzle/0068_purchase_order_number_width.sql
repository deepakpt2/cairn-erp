-- SCR-056 / R-104 (stage 5 correction): the readable PURCHORD display
-- (POF-0000001) is eleven characters; the order number columns widen
-- from ten to twenty so the drawn display stands unaltered.
alter table public.purchase_order alter column order_number type varchar(20);
--> statement-breakpoint
alter table public.purchase_order_item alter column order_number type varchar(20);
--> statement-breakpoint
alter table public.purchase_order_schedule_line alter column order_number type varchar(20);
--> statement-breakpoint
alter table public.purchase_order_assignment alter column order_number type varchar(20);
