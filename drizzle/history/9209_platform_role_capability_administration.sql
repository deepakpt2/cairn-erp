-- Platform role administration.
--
-- Roles previously had no lifecycle flag, so there was no supported way to
-- deactivate a role without deleting assignments/history. Preserve all existing
-- roles as active and make deactivation revoke their effective authority.
alter table public.role
  add column is_active boolean not null default true;

-- Register the two narrow authorities used by the separately bootstrapped,
-- tenant-local PLATFORM_ADMIN role. The wildcard ADMINISTRATOR role is not a
-- bootstrap or central-authority substitute.
insert into public.capability (code, module, action, is_posting_relevant, description)
values
  ('CFG.PLT.ROLE.MAINTAIN', 'PLT', 'CONFIGURE', false, 'Create and maintain tenant roles and assign registered capabilities; protected roles and central authorities remain immutable.'),
  ('CFG.PLT.USER.ROLE.MAINTAIN', 'PLT', 'CONFIGURE', false, 'Assign or revoke ordinary tenant roles for other users; protected platform authority is excluded.'),
  ('FIN.AR.CREDITMEMO.POST', 'FIN', 'POST', true, 'Post a customer credit memo and its balanced receivables journal.')
on conflict (code) do nothing;
