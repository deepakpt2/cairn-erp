-- 9189: the settlement masters get their own capability and their own screen.
--
-- The allocation structure, its assignments, the settlement profile and the order type assignment are
-- shared rows: one profile decides what every order of a type settles against. Until now they were
-- written by /controlling/settlement-rules as a side effect of one order's rule, and no capability named
-- them — so a save for one order repointed the configuration of a whole order type, and no screen
-- existed to maintain the rows on their own terms.
--
-- This registers CFG.COST.SETTLEMENT.DEFINE and /config/settlement-configuration, which is the only
-- path allowed to maintain those four rows, and narrows CO.SETTLE.RULE's own description to the rule of
-- one order: the profile choice, the receiver lines and the share, which is all that screen stores from
-- here on.
--
-- Nothing is seeded. A settlement profile, an allocation structure and a default account mapping are the
-- customer's decision, and a guessed default would be posted to a general ledger. No table, column or
-- grant changes either: the four masters already carry their constraints (9157) and cairn_app already
-- holds the select, insert, update and delete it needs to maintain them.

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.COST.SETTLEMENT.DEFINE', 'COST', 'CONFIGURE', false,
  'Maintain the settlement masters every order of a type reads: the allocation structure and its account assignments, the settlement profile with its document type and allowed distribution methods, and the order type assignment. Nothing is posted.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

update capability
   set description = 'Store the settlement rule of one order: the profile it settles under, its receiver lines and its share. The shared masters it reads are maintained at /config/settlement-configuration. Saving does not post.'
 where code = 'CO.SETTLE.RULE';

insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
values (
  'CFG.COST.SETTLEMENT.DEFINE',
  'CONTROLLING',
  null,
  'Define settlement configuration',
  'DEFINE',
  'CFG.COST.CONTROLLINGAREA.DEFINE',
  'The settlement masters an order settlement rule reads, without touching a single order',
  525,
  'STANDARD',
  '/config/settlement-configuration',
  true,
  'MIGRATION_9189'
)
on conflict (code) do update set
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9189',
  changed_at = now();

insert into config_activity_status (client, activity_code, status, created_by)
select c.client, 'CFG.COST.SETTLEMENT.DEFINE', 'NOT_STARTED', 'MIGRATION_9189'
from client c
on conflict (client, activity_code) do nothing;

-- Whoever maintains the controlling area, a cost center, or an order's settlement rule may maintain
-- these masters. Nothing is granted wider than that, and no posting capability is touched.
insert into role_capability (client, role_code, capability_code, created_by)
select rc.client, rc.role_code, 'CFG.COST.SETTLEMENT.DEFINE', 'MIGRATION_9189'
from role_capability rc
where rc.capability_code in ('CFG.COST.CONTROLLINGAREA.DEFINE', 'CFG.COST.COSTCENTER.DEFINE', 'CO.SETTLE.RULE')
on conflict (client, role_code, capability_code) do nothing;

insert into term_registry (
  id, our_code, our_table, title, term_type, module, description, coverage_tier,
  route_path, conformance_tier, created_by
)
values (
  gen_random_uuid()::text,
  'CFG.COST.SETTLEMENT.DEFINE',
  'settlement_profile',
  'Settlement configuration',
  'CONFIG_ACTIVITY',
  'CO',
  $scm9$Shared settlement configuration: the allocation structure with its account assignments, the settlement profile, and the settlement profile of an internal order type. This screen has no SAP transaction code. SAKF and OKKP are not this screen; KO88 and KO8G settle against what is stored here, and the rule of one order is stored at /controlling/settlement-rules.$scm9$,
  'TIER_2_CONFIGURED',
  '/config/settlement-configuration',
  'B',
  'MIGRATION_9189'
)
on conflict (our_code) do update set
  title = excluded.title,
  term_type = excluded.term_type,
  description = excluded.description,
  route_path = excluded.route_path,
  our_table = excluded.our_table,
  changed_by = 'MIGRATION_9189',
  changed_at = now();

-- The owner of each shared master, stated where a reader of the schema looks.
comment on table public.allocation_structure is
  'Shared master: the header of an account mapping set. Maintained at /config/settlement-configuration under CFG.COST.SETTLEMENT.DEFINE. Never deleted; a structure a settled document read stays for the history of that document.';
comment on table public.allocation_structure_assignment is
  'Shared master: one source account of an allocation structure, with the receiver category it settles to. Maintained at /config/settlement-configuration under CFG.COST.SETTLEMENT.DEFINE; an order rule never writes it.';
comment on table public.settlement_profile is
  'Shared master: the document type and the allowed distribution methods of a settlement, with the allocation structure it uses. Maintained at /config/settlement-configuration under CFG.COST.SETTLEMENT.DEFINE. Every field is stated by whoever maintains it; none is inferred from an order rule.';
comment on table public.internal_order_type_settlement_profile is
  'Shared master: the settlement profile an internal order type reads. One row per order type, maintained at /config/settlement-configuration under CFG.COST.SETTLEMENT.DEFINE.';
comment on table public.settlement_distribution_rule is
  'An order''s own settlement rule: its profile choice, receiver lines and share. Written only by /controlling/settlement-rules under CO.SETTLE.RULE.';
