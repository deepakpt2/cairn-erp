-- 9246: the screen that maintains the dock, and the activity that points at it.
--
-- 9245 built the determination and left it unconfigured on purpose: a plant nobody has configured
-- has no shipping point, and a delivery raised against it is refused rather than raised with no
-- dock to load from. A refusal that names a screen is only as good as the screen it names, so this
-- migration is what makes that remedy real — the capability that guards the screen, and the
-- configuration activity that places it in the sequence a tenant walks.
--
-- It stands after the partner functions (997), because the dock is determined from the shipping
-- condition of the customer the goods are going to: who they are going to is settled first, and
-- then where they leave from.

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.SHIPPING_POINT.DEFINE', 'SALES', 'CONFIGURE', false,
  'Define shipping points and the determination that names one at /config/shipping-points: which dock inside a delivering plant a delivery loads from, keyed on the delivering plant, the shipping condition of the customer the goods are going to and the loading group of the material being sent. The most specific row that fits answers, blank is matched as a value, and where the condition and the group disagree with no row naming both the material stands. It creates no document and posts nothing.'
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
  'CFG.SALES.SHIPPING_POINT.DEFINE',
  'SALES_AND_DISTRIBUTION',
  null,
  'Assign shipping points',
  'DEFINE',
  'CFG.SALES.PARTNER.DEFINE',
  'Which dock inside a plant a delivery loads from: the shipping condition a customer asks under, the loading group a material takes to lift, and the row that names the dock for both.',
  998,
  'STANDARD',
  '/config/shipping-points',
  true,
  'MIGRATION_9246'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9246',
  changed_at = now();
