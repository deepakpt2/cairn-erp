-- Automatic goods movements on a production order confirmation (CO11N).
--
-- A confirmation of a released order is the event that proves the work was done,
-- so it is the event that can move stock: the components a backflush marks are
-- withdrawn against the order (261), and a final confirmation of a material whose
-- plant record asks for it receives the finished good (101). Both postings run
-- through the goods-movement services that MIGO already uses; this migration adds
-- no ledger, no counter, and no second movement table.
--
-- The two marks below are the only new state. They sit on the plant view of the
-- material because that is where the decision belongs: backflush is a property of
-- the component in the plant that consumes it, and the automatic receipt is a
-- property of the finished good in the plant that produces it. Reference field
-- names are recorded in the comments and are not presented as a table copy.
--
-- Both default to false, so a material extended before this migration behaves
-- exactly as it did: a confirmation posts a confirmation and no movement.
--
-- The runtime role needs nothing new. material_plant is a mutable master the
-- material views already update, so the two columns inherit its existing SELECT
-- and INSERT and UPDATE grants, and production_confirmation stays append-only for
-- cairn_app: a confirmation is never rewritten to describe its movements. The
-- material documents a confirmation caused are read back from the document
-- request keys this screen derives from the confirmation's own request key.

alter table public.material_plant
  add column if not exists backflush boolean not null default false;

alter table public.material_plant
  add column if not exists automatic_goods_receipt boolean not null default false;

comment on column public.material_plant.backflush is
  'Withdraw this component against the order when a confirmation is posted. Reference field MARC-SBDKZ. False means the issue stays a manual MIGO posting.';

comment on column public.material_plant.automatic_goods_receipt is
  'Receive the finished good when a final confirmation is posted. Reference field MARC-DOLFB. A partial confirmation never receives.';

-- The capability and term descriptions said no goods movement is posted from a
-- confirmation, and that cancellation touches no movement. Both statements were
-- written while the marks above did not exist. They now name what is configured.

update capability
   set description = 'Enter a time ticket for one operation of a released production order. CO11N is a search alias. A posted confirmation is not edited here. The order status stays created or released. A component marked for backflush is withdrawn, and a final confirmation of a material marked for automatic goods receipt receives the finished good; both post through the goods-movement services. An unmarked material posts no movement and no journal.'
 where code = 'PROD.CONFIRM.ENTER';

update capability
   set description = 'Cancel one posted production-order confirmation. CO13 is a search alias. The original confirmation is not edited. A material document a confirmation posted is not reversed here; it is reversed on the goods-movement screen, and a cancellation is refused while a caused document still stands. No journal, reservation, or order status is changed.'
 where code = 'PROD.CONFIRM.CANCEL';

update term_registry
   set description = 'Enter a time ticket for one operation of a released production order. CO11N is a search alias. The operation is read from the production version. It is not stored on the order. Partial leaves the operation open. Final blocks another confirmation of that operation and does not change the order status. A component whose material is marked for backflush is withdrawn against the order in the same transaction, and a final confirmation receives the finished good when the material is marked for automatic goods receipt. An unmarked material posts no movement. Personnel, a shift, activity cost, a suboperation, a confirmation profile, a reservation, ATP, capacity, and settlement are not stored here.',
       changed_by = 'MIGRATION_9188',
       changed_at = now()
 where our_code = 'PROD.CONFIRM.ENTER';

update term_registry
   set description = 'Cancel one posted confirmation. CO13 is a search alias. Operation and header confirmations are both in scope. The original confirmation and its activities stay as posted. A cancellation record is linked to that confirmation and can be written once. A cancelled final no longer blocks a new confirmation. A material document the confirmation caused is not reversed here; while such a document stands, the cancellation is refused, and the goods-movement screen is named as the way to reverse it.',
       changed_by = 'MIGRATION_9188',
       changed_at = now()
 where our_code = 'PROD.CONFIRM.CANCEL';
