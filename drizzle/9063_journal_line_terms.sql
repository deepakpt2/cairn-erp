-- SCR-114 F-03 family follow-up (B-816/§26.830): a line may carry its
-- own payment terms and baseline date. A residual item re-stood by a
-- clearing inherits them from its source invoice, and the ageing
-- derivation reads them ahead of origin resolution — the deferral
-- named at the advanced-clearing closure, now closed.
alter table public.journal_entry_line
  add column payment_terms varchar(12),
  add column baseline_date date;
--> statement-breakpoint
comment on column public.journal_entry_line.payment_terms is
  'Line-level payment terms (SCR-114 follow-up). Wins over origin-invoice resolution in the ageing derivation; stamped by residual clearing when the source invoice carries terms.';
--> statement-breakpoint
comment on column public.journal_entry_line.baseline_date is
  'Line-level baseline date (SCR-114 follow-up), read with payment_terms to compute the line''s own due date.';
