-- SCR-121 / R-168 (stage 2): retained earnings indicator (OB53).
-- The P&L statement account's one-character key whose standing
-- RETAINED_EARNINGS account determination (indicator held in the
-- general-modifier slot) names the retained earnings account the
-- account closes to at balance carryforward. Stored only on
-- P/L statement accounts.

alter table public.gl_account
  add column if not exists retained_earnings_indicator varchar(1);

alter table public.gl_account
  drop constraint if exists gl_account_retained_indicator_ck;
alter table public.gl_account
  add constraint gl_account_retained_indicator_ck check (
    retained_earnings_indicator is null
    or (gl_account_type = 'PL_STATEMENT' and retained_earnings_indicator ~ '^[A-Z0-9]$')
  );
