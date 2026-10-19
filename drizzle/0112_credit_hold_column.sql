-- SCR-103 stage 5 fix: the credit hold flag takes the domain name
-- is_on_hold; is_blocked remains reserved to the FS00 account
-- master vocabulary guarded by the schema-contract test.
alter table public.customer_credit rename column is_blocked to is_on_hold;
