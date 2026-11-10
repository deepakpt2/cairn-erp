-- A tolerance on the material in its plant is an opinion, not a default.
--
-- The chain is the purchase order item, then the material in its plant, then the
-- purchasing info record. An opinion the material does not hold has to fall through to the
-- record. While the column answered "0" for every material that never maintained one, the
-- record could never be reached at all, and the third tier of the chain was decoration.
--
-- This is not a legacy NULL. Zero is an answer - this material tolerates nothing - and it
-- stays distinguishable from holding no answer, which is what a blank field now stores.

alter table material_plant
  alter column overdelivery_tolerance drop default,
  alter column overdelivery_tolerance drop not null,
  alter column underdelivery_tolerance drop default,
  alter column underdelivery_tolerance drop not null;

comment on column material_plant.overdelivery_tolerance is
  'How far a receipt may run past the ordered quantity, as a percentage. Unmaintained here, the purchasing info record decides.';
comment on column material_plant.underdelivery_tolerance is
  'How short of the ordered quantity a receipt may fall, as a percentage. Unmaintained here, the purchasing info record decides.';
