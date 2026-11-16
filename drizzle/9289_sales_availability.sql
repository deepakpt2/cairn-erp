-- 9289_sales_availability.sql
--
-- The sales availability check (ATP) counts supply over time and can be asked for on demand.
-- Two additions to what already stands:
--  1. availability_check_scope.sales_requirements: whether the promises other open sales orders already
--     hold are subtracted. The check has always subtracted them (the only way not to promise the same
--     stock twice), so the default is 'X' and no scope behaves differently until someone clears it.
--  2. sales_document_type.availability_check_rule: the checking rule an order of this type is checked
--     under. Blank means the order rule OR, exactly as before: blank is NOT "no check".
-- Also two corrections to 9288 (which is immutable once applied): its item_text was too narrow for the
-- operation and roll-up texts the estimate writes, and the registry row for PROD.COST.ESTIMATE.CREATE must
-- carry no our_table (that column is unique and belongs to a table term).
-- Also: capability SALES.ORDER.AVAILABILITY.CHECK (reached by SALES.* as SALES.ORDER.CREATE is),
-- its registry entry on the existing /sales/orders screen, and the aliases VA03 and ATP.

alter table public.material_cost_estimate_item alter column item_text type varchar(160);
update public.term_registry set our_table = null
 where our_code = 'PROD.COST.ESTIMATE.CREATE' and our_table is not null;

alter table public.availability_check_scope add column if not exists sales_requirements char(1) not null default 'X';
alter table public.availability_check_scope drop constraint if exists availability_check_scope_sales_ck;
alter table public.availability_check_scope add constraint availability_check_scope_sales_ck
  check (sales_requirements in ('X', ' '));

alter table public.sales_document_type add column if not exists availability_check_rule varchar(2);
alter table public.sales_document_type drop constraint if exists sales_document_type_availability_rule_fk;
alter table public.sales_document_type add constraint sales_document_type_availability_rule_fk
  foreign key (client, availability_check_rule)
  references public.availability_checking_rule (client, checking_rule) on delete restrict;

insert into public.capability (code, module, action, is_posting_relevant, description) values
  ('SALES.ORDER.AVAILABILITY.CHECK', 'SALES', 'MAINTAIN', false,
   'Check the availability of a sales order on demand and write the confirmation it returns (VA02 / ATP). Posts nothing')
on conflict (code) do nothing;

insert into public.term_registry
  (id, our_code, our_table, title, term_type, module, description, coverage_tier, route_path,
   conformance_tier, deferral_note, is_searchable, created_by, created_at, changed_by, changed_at)
select '9289a000-0000-4000-8000-000000000001', 'SALES.ORDER.AVAILABILITY.CHECK', null, 'Check sales order availability',
       'TRANSACTION', 'SALES',
       'Check the availability of a sales order on demand: stock and the supply the scope of check counts, less what other orders '
       || 'are promised, at the requested date. Shows the standing confirmation beside the proposed one; writes only when confirmed.',
       'TIER_1_BUILT', '/sales/orders', 'B', null, true, 'MIGRATION_9289', now(), null, null
 where not exists (select 1 from public.term_registry r
                    where r.id = '9289a000-0000-4000-8000-000000000001' or r.our_code = 'SALES.ORDER.AVAILABILITY.CHECK');

insert into public.term_alias (id, term_id, external_system, alias, usage, created_by, created_at)
select v.id, '9289a000-0000-4000-8000-000000000001', 'REFERENCE_ERP', v.alias, 'SEARCH_ONLY', 'MIGRATION_9289', now()
  from (values
    ('9289b000-0000-4000-8000-000000000001', 'VA03'),
    ('9289b000-0000-4000-8000-000000000002', 'ATP')
  ) as v(id, alias)
 where exists (select 1 from public.term_registry r where r.id = '9289a000-0000-4000-8000-000000000001')
   and not exists (select 1 from public.term_alias a where a.id = v.id);
