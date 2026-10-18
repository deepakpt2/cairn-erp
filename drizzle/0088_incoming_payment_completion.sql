-- SCR-079 / R-127 (stage 2): the incoming payment completion totals.
--
-- A completed receipt records the cash discount it took and the
-- on-account remainder it left standing, beside the received amount.
-- Outcomes themselves stand on the payment's journal lines (their
-- line text names each: Settles / Residual / Partial / On account),
-- so no allocation table lands.
alter table public.incoming_payment
  add column discount_amount numeric(23,4) not null default 0;
--> statement-breakpoint
alter table public.incoming_payment
  add column on_account_amount numeric(23,4) not null default 0;
