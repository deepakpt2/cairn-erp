-- SCR-079 / R-127 (stage 5): a completed receipt may clear nothing.
--
-- The original record check required every payment to clear at
-- least one item; a partial-only or on-account receipt clears none
-- by design, so the clearing-count half of the check goes. The
-- amount still stands above zero at the database.
alter table public.incoming_payment drop constraint incoming_payment_amount_ck;
--> statement-breakpoint
alter table public.incoming_payment
  add constraint incoming_payment_amount_ck check (amount > 0);
