-- 9219: the delivery-completion rule gets a screen of its own.
--
-- 9218 gave the rule two tables and a reader, and nothing to maintain it with: the only way
-- to say that a plant closes its items on receipt was to write the row by hand. A rule that
-- cannot be seen or changed by the people it belongs to is not a rule, it is a default, so
-- this registers the screen that maintains both tables and the capability that names it.
--
-- The workbench lists configuration activities from this row, so the screen appears in the
-- materials-management area beside the other purchasing settings rather than being reachable
-- only by its path.
--
-- Nothing is seeded. Whether a plant closes an item on receipt is the plant's decision, and
-- guessing one would change what thousands of receipts do.

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'PROC.DELIVERYCOMPLETION.CONFIGURE', 'PROC', 'CONFIGURE', false,
  'Maintain whether a goods receipt closes a purchase order item by itself: a company-code default and a plant override. Nothing is posted.'
)
on conflict (code) do update set
  module = excluded.module,
  action = excluded.action,
  is_posting_relevant = excluded.is_posting_relevant,
  description = excluded.description;

insert into config_activity (
  code, area, sub_area, title, activity_kind, prerequisites, enables,
  sequence, wizard_stage, route_path, is_config_only, created_by
)
values (
  'PROC.DELIVERYCOMPLETION.CONFIGURE',
  'MATERIALS_MANAGEMENT',
  null,
  'Define delivery completion',
  'DEFINE',
  'CFG.PROC.PURORG.DEFINE',
  'Whether a goods receipt closes a purchase order item, per company code and per plant',
  985,
  'STANDARD',
  '/config/delivery-completion',
  true,
  'MIGRATION_9219'
)
on conflict (code) do update set
  title = excluded.title,
  prerequisites = excluded.prerequisites,
  enables = excluded.enables,
  sequence = excluded.sequence,
  wizard_stage = excluded.wizard_stage,
  route_path = excluded.route_path,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9219',
  changed_at = now();
