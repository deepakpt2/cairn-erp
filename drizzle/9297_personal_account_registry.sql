-- AUTH-02: the personal account screen (/account, SU3).
-- Data only. No table, view or grant is added: the screen reads app_user, user_session and writes
-- app_user.password_hash / must_change_password / preferences through existing tenant RLS.
-- No capability and no role_capability row: the screen claims no authority (catalogue code "").
-- our_code is null for the same reason the launchpad's registry row would be: there is no code to name it by.

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9297a000-0000-4000-8000-000000000001', null, null,
       'My account', 'TRANSACTION', 'PLT',
       'The signed-in user''s own account: change password (required after an administrator reset), '
       || 'close own sessions, and personal preferences. Needs a session, not a capability.',
       'TIER_1_BUILT', '/account', 'B', null, true, 'MIGRATION_9297', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9297a000-0000-4000-8000-000000000001' or r.route_path = '/account');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select '9297b000-0000-4000-8000-000000000001', '9297a000-0000-4000-8000-000000000001',
       'REFERENCE_ERP', 'SU3', 'SEARCH_ONLY', 'MIGRATION_9297', now()
 where exists (select 1 from public.term_registry r where r.id = '9297a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = '9297b000-0000-4000-8000-000000000001');
