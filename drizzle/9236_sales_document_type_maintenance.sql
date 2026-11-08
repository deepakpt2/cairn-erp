-- 9236: the sales document type becomes maintainable.
--
-- Since 9226 the document type is a row: the code a document carries, the number range its number is
-- drawn from, the name a screen shows, what it cancels into, and whether it may still be used. Every one
-- of those facts is read, and until now not one of them could be written except by a migration. A
-- consultant who needed a new commercial process needed a deployment, which is the thing 9226 set out to
-- end — it moved the facts into a table and left the table unwritable.
--
-- The refusals have been honest about the gap. `DOCUMENT_TYPE_REMEDY`, which every document service
-- offers when its type does not stand, says "restored for this tenant in the sales document type
-- configuration" — a configuration with no screen behind it. It names a route from here.
--
-- Three things are granted, and one is not: INSERT and UPDATE, because a type is created and redefined,
-- and never DELETE. A type with documents standing under it is deactivated rather than removed, exactly
-- as 9226's own comment says, because the history keeps reading the type a document was created with. A
-- deletion the application role cannot perform is a promise the system cannot break.
--
-- The capability is a configuration code, so the configurator reaches it through the `CFG.*` pattern it
-- already holds, and the sales clerk does not: maintaining what a document *is* is not the same act as
-- creating one. It is not posting-relevant — it writes no financial record and no document.
--
-- The activity is registered in the workbench tree, in a SALES_AND_DISTRIBUTION area that no activity
-- has used yet: what a document is, is the first thing a sales configuration has to say.

grant select, insert, update on table public.sales_document_type to cairn_app;

insert into capability (code, module, action, is_posting_relevant, description)
values (
  'CFG.SALES.DOCTYPE.DEFINE', 'SALES', 'CONFIGURE', false,
  'Define sales document types at /config/sales-document-types: the code a document carries, the name a screen shows, the number range its number is drawn from, what the type cancels into, and whether documents of that type may still be created. A type with documents standing under it is deactivated rather than deleted, so the history keeps reading. It creates no document and posts nothing.'
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
  'CFG.SALES.DOCTYPE.DEFINE',
  'SALES_AND_DISTRIBUTION',
  null,
  'Define sales document types',
  'DEFINE',
  '',
  'Which documents the chain can create at all: an order, a delivery, a billing document, and the types the returns and credit chain uses. A type whose number range does not stand is refused, because a document that cannot be numbered cannot be created.',
  990,
  'STANDARD',
  '/config/sales-document-types',
  true,
  'MIGRATION_9236'
)
on conflict (code) do update set
  title = excluded.title,
  area = excluded.area,
  enables = excluded.enables,
  route_path = excluded.route_path,
  sequence = excluded.sequence,
  activity_kind = excluded.activity_kind,
  is_config_only = excluded.is_config_only,
  changed_by = 'MIGRATION_9236',
  changed_at = now();
